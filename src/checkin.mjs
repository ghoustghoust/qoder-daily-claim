// 编排：确保客户端可刷新登录态 -> 查询 -> 领取 -> 验证 -> 播报；含重试、自愈禁用、状态统计。
// 网络与副作用全部可注入（deps），smoke test 不触真机与系统。
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sanitizeText } from './config.mjs';
import { loadAuth, tokenValid } from './auth.mjs';
import { getCampaigns, claimCampaign, pickTargets } from './api.mjs';
import { toast } from './notify.mjs';
import { disableAll } from './install.mjs';
import { resolveDataDir } from './paths.mjs';

const todayISO = () => new Date().toLocaleDateString('sv-SE');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const makePaths = resolveDataDir;

const readJson = (f, def) => {
  try { const t = readFileSync(f, 'utf8'); if (t.length > (4 << 20)) return def; return JSON.parse(t); } catch { return def; }
};
// 原子写：temp+rename，防任务重叠期截断
function writeJson(f, o) {
  const tmp = `${f}.${process.pid}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(o, null, 2), { mode: 0o600 }); renameSync(tmp, f); }
  catch { try { unlinkSync(tmp); } catch { /* ignore */ } }
}

function log(lines, msg) {
  const line = `[${new Date().toISOString()}] ${sanitizeText(msg, 500)}`;
  lines.push(line);
  console.log(line);
}

function msUntilRefresh(cfg) {
  const d = new Date();
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), cfg.refreshAt.hour, cfg.refreshAt.minute, 0);
  const ms = t.getTime() + cfg.refreshAt.bufferSeconds * 1000 - d.getTime();
  return ms > 0 && ms < 12 * 3600_000 ? ms : 0;
}

function ensureClient(cfg, lines, load) {
  const auth = (() => { try { return load(cfg); } catch { return null; } })();
  if (auth && tokenValid(auth)) return null; // 登录态可用，不打扰客户端
  if (!cfg.clientExe) { log(lines, '未探测到客户端 exe，跳过拉起（token 临期需手动打开客户端）'); return null; }
  log(lines, '登录态缺失/临期，拉起客户端等待续期…');
  const child = spawn(cfg.clientExe, [], { detached: true, stdio: 'ignore' });
  child.on('error', (e) => log(lines, `拉起客户端失败（继续走 API）: ${sanitizeText(e.message, 120)}`));
  child.unref();
  return { launched: child.pid, deadline: Date.now() + 90_000 };
}

async function waitForToken(cfg, wait, lines, sleeper, load) {
  if (!wait) return true;
  while (Date.now() < wait.deadline) {
    await sleeper(5000);
    try { if (tokenValid(load(cfg))) { log(lines, '登录态已刷新'); return true; } } catch { /* 写入中 */ }
  }
  return false;
}

export async function runClaim(cfg, deps = {}) {
  const {
    paths = makePaths(), fetchCampaigns = getCampaigns, fetchClaim = claimCampaign, notify = toast,
    now = Date.now, sleeper = sleep, getToken = (c) => loadAuth(c).token, loadAuthFn = loadAuth,
    disable = disableAll,
  } = deps;
  const lines = [];
  const state = readJson(paths.state, { lastClaimDate: null, noCampaignDays: [], disabled: false, lastExpiryNotice: null, monthReported: null, hardErrorStreak: 0 });
  if (state.disabled) { log(lines, '处于自我禁用状态；执行 enable 恢复'); return { outcome: 'disabled', lines }; }

  const auth0 = (() => { try { return loadAuthFn(cfg); } catch { return null; } })();
  if (auth0) {
    const left = new Date(auth0.expiresAt).getTime() - now();
    if (left < 24 * 3600_000 && state.lastExpiryNotice !== todayISO()) {
      state.lastExpiryNotice = todayISO(); writeJson(paths.state, state);
      notify(cfg, '登录态即将到期 ⏰', '本机 token 24 小时内到期，请打开 Qoder CN 续期');
    }
  }

  const wait = ensureClient(cfg, lines, loadAuthFn);
  await waitForToken(cfg, wait, lines, sleeper, loadAuthFn);

  const selfDisable = (reason) => {
    state.disabled = true; state.disabledReason = reason; writeJson(paths.state, state);
    disable(cfg);
    notify(cfg, '自动签到已停用 ⏹️', `${reason}；已自我禁用，运行 enable 恢复`);
  };

  let waitedForRefresh = false;
  for (let attempt = 1; attempt <= cfg.retry.max; attempt++) {
    try {
      const res = await fetchCampaigns(cfg, getToken(cfg));
      if (res.gone) {
        state.hardErrorStreak = (state.hardErrorStreak || 0) + 1; writeJson(paths.state, state);
        if (state.hardErrorStreak >= cfg.hardErrorStreak) { selfDisable(`活动接口持续返回 ${res.status}`); return { outcome: 'offline', lines }; }
        log(lines, `活动接口 ${res.status}（${state.hardErrorStreak}/${cfg.hardErrorStreak}），暂不判定下线`);
        return { outcome: 'failed', lines };
      }
      const data = res.data;
      if (!data.claimable) {
        const waitMs = msUntilRefresh(cfg);
        if (!waitedForRefresh && waitMs > 0 && data.showCampaign) {
          waitedForRefresh = true; log(lines, `未到刷新时间，挂起 ${Math.round(waitMs / 60000)} 分钟`); await sleeper(waitMs); attempt--; continue;
        }
        if (!data.showCampaign && data.campaigns.length === 0) {
          const days = new Set(state.noCampaignDays || []);
          days.add(todayISO()); state.noCampaignDays = [...days].slice(-14); writeJson(paths.state, state);
          if (state.noCampaignDays.length >= cfg.offlineStreakDays) { selfDisable(`连续 ${state.noCampaignDays.length} 天查无活动`); return { outcome: 'offline', lines }; }
        } else { state.noCampaignDays = []; writeJson(paths.state, state); }
        log(lines, `无需领取：showCampaign=${data.showCampaign} claimable=${data.claimable}`);
        state.hardErrorStreak = 0; writeJson(paths.state, state);
        maybeMonthReport(cfg, state, paths, notify, now);
        return { outcome: 'skipped', lines };
      }
      const targets = pickTargets(data, cfg.maxClaimTargets);
      if (!targets.length) { log(lines, 'claimable=true 但无可识别 CLAIM_BENEFIT（活动形态变化），跳过'); notify(cfg, '签到形态变化 ⚠️', '接口可领但结构不认识，请人工确认活动'); return { outcome: 'skipped', lines }; }
      let got = 0, forbidden = false, lastHttp = 0;
      for (const t of targets) {
        const r = await fetchClaim(cfg, getToken(cfg), t.campaignId);
        lastHttp = r.httpStatus;
        if (r.httpStatus === 403) forbidden = true;
        if (r.claimed) {
          got++;
          const stats = readJson(paths.stats, []); stats.push({ date: todayISO(), key: t.campaignKey || t.campaignId, amount: t.amount });
          writeJson(paths.stats, stats);
        } else log(lines, `claim ${t.campaignKey || t.campaignId} -> ${r.httpStatus} ${r.detail}`);
      }
      if (forbidden && !got) {
        state.hardErrorStreak = (state.hardErrorStreak || 0) + 1; writeJson(paths.state, state);
        if (state.hardErrorStreak >= cfg.hardErrorStreak) { selfDisable('领取接口持续 403（疑似规则/资格变化）'); return { outcome: 'forbidden', lines }; }
        log(lines, `403（${state.hardErrorStreak}/${cfg.hardErrorStreak}），观察中`);
        return { outcome: 'failed', lines };
      }
      if (got) {
        const after = await fetchCampaigns(cfg, getToken(cfg)).catch(() => null);
        if (!(after && after.data && after.data.claimable)) {
          state.lastClaimDate = todayISO(); state.hardErrorStreak = 0; writeJson(paths.state, state);
          notify(cfg, '领取成功 ✅', `${got} 项权益已领取（明细见 stats.json）`);
          maybeMonthReport(cfg, state, paths, notify, now);
          return { outcome: 'claimed', lines };
        }
        log(lines, `已领 ${got} 项但 claimable 仍为 true，下轮复查`);
      }
    } catch (e) {
      log(lines, `第 ${attempt} 次失败：${sanitizeText(e.message, 200)}`);
    }
    if (attempt < cfg.retry.max) await sleeper(cfg.retry.intervalMs);
  }
  notify(cfg, '领取失败 ⚠️', `重试 ${cfg.retry.max} 次未成（最后 HTTP ${lastHttp || '?'}），详见日志`);
  return { outcome: 'failed', lines };
}

export function maybeMonthReport(cfg, state, paths, notify, now = Date.now) {
  const d = new Date(now());
  if (d.getDate() !== 1) return false;
  const month = d.toLocaleDateString('sv-SE').slice(0, 7);
  if (state.monthReported === month) return false;
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1).toLocaleDateString('sv-SE').slice(0, 7);
  const total = readJson(paths.stats, []).filter((e) => typeof e.date === 'string' && e.date.startsWith(prev) && Number.isFinite(e.amount)).reduce((s, e) => s + e.amount, 0);
  state.monthReported = month; writeJson(paths.state, state);
  notify(cfg, '月度小结 📊', `${prev} 累计领取 ${total} credits`);
  return true;
}

export function cleanupLogs(paths, keepDays = 30, maxLogBytes = 1 << 20) {
  let removed = 0;
  try {
    const cutoff = Date.now() - keepDays * 86_400_000;
    for (const f of readdirSync(paths.logs)) {
      const full = path.join(paths.logs, f);
      try {
        const st = statSync(full);
        if (st.mtimeMs < cutoff && /\.(png|html|json)$/.test(f)) { unlinkSync(full); removed++; }
        else if (/\.(log|txt)$/.test(f) && st.size > maxLogBytes) { renameSync(full, full + '.1'); } // 只留一代轮转
      } catch { /* ignore */ }
    }
  } catch { /* logs 目录被删：非致命 */ }
  return removed;
}
