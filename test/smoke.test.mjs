import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, createCipheriv } from 'node:crypto';

import { loadConfig, DEFAULTS, sanitizeText, isAllowedHost } from '../src/config.mjs';
import { decryptV10, tokenValid } from '../src/auth.mjs';
import { buildClaimUrl, validateCampaignsResponse, pickTargets, freeRank } from '../src/api.mjs';
import { runClaim, maybeMonthReport } from '../src/checkin.mjs';

const writeCfg = (obj) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qdc'));
  const f = path.join(dir, 'config.json');
  writeFileSync(f, JSON.stringify(obj ?? {}));
  process.env.QDC_CONFIG = f;
  process.env.QDC_HOME = dir;
  process.env.QODER_CN_EXE = 'X:\\fake\\Qoder CN.exe';
  process.env.QODER_CN_DATA = 'X:\\fake-data';
  return dir;
};

test('config: env 覆盖生效', () => {
  writeCfg();
  const cfg = loadConfig();
  assert.equal(cfg.clientExe, 'X:\\fake\\Qoder CN.exe');
  assert.equal(cfg.apiBase, DEFAULTS.apiBase);
});

test('config: taskName 注入字符被拒绝', () => {
  writeCfg({ taskName: 'evil & calc.exe' });
  assert.throws(() => loadConfig(), /taskName/);
});

test('config: 非 HTTPS apiBase 被拒绝', () => {
  writeCfg({ apiBase: 'http://qoder.cn' });
  assert.throws(() => loadConfig(), /HTTPS/);
});

test('config: apiBase 指向非官方域被拒绝（白名单不可扩大）', () => {
  writeCfg({ apiBase: 'https://evil.example' });
  assert.throws(() => loadConfig(), /白名单/);
  writeCfg({ allowedCampaignHosts: ['evil.example'] }); // 该键现在被忽略
  const cfg = loadConfig();
  assert.ok(!cfg.allowedCampaignHosts.includes('evil.example'));
});

test('config: UNC 客户端路径被拒绝', () => {
  writeCfg();
  process.env.QODER_CN_EXE = '\\\\evil\\share\\Qoder CN.exe';
  assert.throws(() => loadConfig(), /UNC/);
  process.env.QODER_CN_EXE = 'X:\\fake\\NotQoder.exe';
  assert.throws(() => loadConfig(), /Qoder CN\.exe/);
  delete process.env.QODER_CN_EXE;
});

test('config: 非法 JSON 配置文件报可读错误且不带内容', () => {
  const dir = writeCfg();
  writeFileSync(path.join(dir, 'config.json'), '{"token":"SECRETXYZ","broken":');
  assert.throws(() => loadConfig(), (e) => /无效 JSON/.test(e.message) && !e.message.includes('SECRETXYZ'));
});

test('sanitizeText: 去控制符/双向格式符并限长', () => {
  assert.equal(sanitizeText('a\u0007b \u202ebid\u200cir\u0065\u0063\u0074'), 'a b bid irect');
  assert.equal(sanitizeText(null), '');
  assert.equal(sanitizeText('x'.repeat(500), 10).length, 10);
});

test('isAllowedHost: 精确/后缀匹配，拒绝伪后缀', () => {
  assert.ok(isAllowedHost('openapi.qoder.com.cn'));
  assert.ok(isAllowedHost('QODER.CN'));
  assert.ok(!isAllowedHost('xqoder.cn'));
  assert.ok(!isAllowedHost('qoder.com.cn.evil.net'));
  assert.ok(!isAllowedHost('qoder.cn.evil.net'));
});

test('auth: v10 AES-GCM roundtrip + 篡改拒绝 + 错误不带明文', () => {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const payload = JSON.stringify({ token: 'SECRET-TOKEN-VALUE', refreshToken: 'r', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(payload), c.final()]);
  const buf = Buffer.concat([Buffer.from('v10'), iv, ct, c.getAuthTag()]);
  assert.equal(decryptV10(buf, key).token, 'SECRET-TOKEN-VALUE');
  assert.ok(tokenValid(decryptV10(buf, key)));
  const bad = Buffer.from(buf); bad[20] ^= 0xff;
  assert.throws(() => decryptV10(bad, key), (e) => !String(e.message).includes('SECRET'));
  assert.throws(() => decryptV10(Buffer.concat([Buffer.from('v11'), buf.subarray(3)]), key), /v10/);
});

test('api: buildClaimUrl 拒绝非法 id / 编码合法 id', () => {
  assert.equal(buildClaimUrl('https://openapi.qoder.com.cn/', 'abc_123'), 'https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/abc_123/claim');
  for (const evil of ['../../admin', 'a b', 'a\nb', 'x'.repeat(65), '']) assert.throws(() => buildClaimUrl('https://openapi.qoder.com.cn', evil), /campaignId/);
});

test('api: 响应校验归一化、剔除畸形、限 100 条', () => {
  const ok = validateCampaignsResponse({
    showCampaign: true, claimable: true, campaignUrl: 'https://openapi.qoder.com.cn/g',
    campaigns: [
      { campaignId: 'a1', campaignKey: 'act', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } },
      { campaignId: '../bad', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE' },
    ],
  });
  assert.equal(ok.campaigns.length, 1);
  assert.equal(ok.campaigns[0].amount, 100);
  const many = validateCampaignsResponse({ showCampaign: true, campaigns: Array.from({ length: 500 }, (_, i) => ({ campaignId: 'c' + i, actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE' })) });
  assert.equal(many.campaigns.length, 100);
  assert.throws(() => validateCampaignsResponse({ claimable: true }), /showCampaign/);
  assert.throws(() => validateCampaignsResponse(null), /对象/);
});

test('api: pickTargets 过滤+免费优先+数量上限', () => {
  const list = { campaigns: [
    { campaignId: 'p', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', campaignKey: 'act-pro' },
    { campaignId: 'q', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', campaignKey: 'qwen-free-1' },
    { campaignId: 'r', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMABLE' },
  ] };
  const t = pickTargets(list, 20);
  assert.equal(t.length, 2);
  assert.equal(t[0].campaignId, 'q');
  assert.equal(pickTargets({ campaigns: Array.from({ length: 60 }, (_, i) => ({ campaignId: 'c' + i, actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE' })) }, 20).length, 20);
  assert.equal(freeRank({ campaignKey: 'free-x' }), 0);
});

const fakeAuth = () => ({ token: 'tok', refreshToken: 'r', expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() });
const fakeData = (claimable, extra = {}) => ({ status: 200, data: { showCampaign: true, claimable, campaignUrl: '', campaigns: [], ...extra } });
const oneTarget = { campaigns: [{ campaignId: 'c1', campaignKey: 'act-x', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', amount: 100 }] };

test('checkin: 领取成功 -> 播报 + stats/state 原子落盘', async () => {
  writeCfg();
  const cfg = loadConfig();
  const toasts = [];
  let seen = false;
  const r = await runClaim(cfg, {
    getToken: () => 'tok', loadAuthFn: fakeAuth, disable: () => { throw new Error('不应禁用'); },
    fetchCampaigns: async () => (seen ? fakeData(false) : fakeData(true, oneTarget)),
    fetchClaim: async () => { seen = true; return { claimed: true, httpStatus: 200, detail: '' }; },
    notify: (c, t, m) => toasts.push([t, m]),
    sleeper: async () => {},
  });
  assert.equal(r.outcome, 'claimed');
  assert.match(toasts[0][0], /成功/);
  const dir = process.env.QDC_HOME;
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'stats.json'), 'utf8'))[0].amount, 100);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')).disabled, false);
  assert.ok(!existsSync(path.join(dir, 'state.json.tmp')) && !existsSync(path.join(dir, 'state.json.' + process.pid + '.tmp')));
});

test('checkin: 单次 404 不禁用，连续 hardErrorStreak 次才停用', async () => {
  writeCfg({ hardErrorStreak: 2 });
  const cfg = loadConfig();
  const dir = process.env.QDC_HOME;
  const paths = { dir, logs: path.join(dir, 'logs'), state: path.join(dir, 'state.json'), stats: path.join(dir, 'stats.json') };
  let disabledCalls = 0;
  const deps = { paths, getToken: () => 'tok', loadAuthFn: fakeAuth, fetchClaim: async () => ({}), notify: () => {}, sleeper: async () => {}, disable: () => disabledCalls++, fetchCampaigns: async () => ({ gone: true, status: 404 }) };
  assert.equal((await runClaim(cfg, deps)).outcome, 'failed');
  assert.equal(disabledCalls, 0);
  assert.equal((await runClaim(cfg, deps)).outcome, 'offline');
  assert.equal(disabledCalls, 1);
  assert.equal(JSON.parse(readFileSync(paths.state, 'utf8')).disabled, true);
});

test('checkin: 403 连续才停用，401/普通错误不自停', async () => {
  writeCfg({ hardErrorStreak: 2, retry: { intervalMs: 1000, max: 1 } });
  const cfg = loadConfig();
  const dir = process.env.QDC_HOME;
  const paths = { dir, logs: path.join(dir, 'logs'), state: path.join(dir, 'state.json'), stats: path.join(dir, 'stats.json') };
  let disabledCalls = 0;
  const mk = () => ({ paths, getToken: () => 'tok', loadAuthFn: fakeAuth, notify: () => {}, sleeper: async () => {}, disable: () => disabledCalls++,
    fetchCampaigns: async () => fakeData(true, oneTarget),
    fetchClaim: async () => ({ claimed: false, httpStatus: 403, detail: '' }) });
  await runClaim(cfg, mk());
  await runClaim(cfg, mk());
  assert.equal(disabledCalls, 1);
});

test('checkin: 连续 N 天查无活动 -> 停用', async () => {
  writeCfg({ offlineStreakDays: 2 });
  const cfg = loadConfig();
  const dir = process.env.QDC_HOME;
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ noCampaignDays: ['2026-01-01'] }));
  let disabledCalls = 0;
  const r = await runClaim(cfg, {
    paths: { dir, logs: path.join(dir, 'logs'), state: path.join(dir, 'state.json'), stats: path.join(dir, 'stats.json') },
    getToken: () => 'tok', loadAuthFn: fakeAuth, disable: () => disabledCalls++,
    fetchCampaigns: async () => ({ status: 200, data: { showCampaign: false, claimable: false, campaignUrl: '', campaigns: [] } }),
    notify: () => {}, sleeper: async () => {},
  });
  assert.equal(r.outcome, 'offline');
  assert.equal(disabledCalls, 1);
});

test('checkin: 已禁用状态短路，不发网络请求', async () => {
  writeCfg();
  const dir = process.env.QDC_HOME;
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ disabled: true }));
  const r = await runClaim(loadConfig(), {
    paths: { dir, logs: path.join(dir, 'logs'), state: path.join(dir, 'state.json'), stats: path.join(dir, 'stats.json') },
    getToken: () => { throw new Error('should not call'); }, loadAuthFn: () => { throw new Error('x'); }, fetchCampaigns: async () => { throw new Error('should not call'); }, notify: () => {}, sleeper: async () => {},
  });
  assert.equal(r.outcome, 'disabled');
});

test('month report: 每月 1 号汇总上月且只报一次', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qdc'));
  const paths = { dir, logs: dir, state: path.join(dir, 'state.json'), stats: path.join(dir, 'stats.json') };
  writeFileSync(paths.stats, JSON.stringify([{ date: '2026-08-05', amount: 100 }, { date: '2026-08-22', amount: 100 }]));
  const state = {};
  const msgs = [];
  const fakeNow = () => new Date('2026-09-01T02:00:00Z').getTime();
  assert.ok(maybeMonthReport({}, state, paths, (c, t, m) => msgs.push(m), fakeNow));
  assert.equal(msgs[0], '2026-08 累计领取 200 credits');
  assert.ok(!maybeMonthReport({}, state, paths, () => {}, fakeNow));
});
