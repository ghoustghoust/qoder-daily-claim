// 官方活动 API 的窄封装：全部请求带超时、响应体流式限长、结构白名单校验、campaignId 严格过滤。
// 服务器返回值一律视为不可信输入。唯一出站点 = cfg.apiBase（config 层已锁官方域）。
import { sanitizeText, isAllowedHost } from './config.mjs';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function buildClaimUrl(apiBase, campaignId) {
  if (!ID_RE.test(campaignId)) throw new Error('非法 campaignId（已拒绝，防路径注入）');
  return `${apiBase.replace(/\/$/, '')}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`;
}

export function validateCampaignsResponse(j) {
  if (!j || typeof j !== 'object') throw new Error('campaigns 响应不是对象');
  if (typeof j.showCampaign !== 'boolean') throw new Error('campaigns.showCampaign 类型异常');
  const raw = Array.isArray(j.campaigns) ? j.campaigns.slice(0, 100) : [];
  const campaigns = raw.map((c) => {
    if (!c || typeof c !== 'object') throw new Error('campaign 条目非对象');
    const amt = c?.benefit?.amount;
    return {
      campaignId: typeof c.campaignId === 'string' && ID_RE.test(c.campaignId) ? c.campaignId : '',
      campaignKey: sanitizeText(String(c.campaignKey ?? ''), 64),
      actionType: sanitizeText(String(c.actionType ?? ''), 32),
      claimStatus: sanitizeText(String(c.claimStatus ?? ''), 32),
      amount: Number.isFinite(amt) && amt > 0 && amt <= 1_000_000 ? amt : null,
    };
  }).filter((c) => c.campaignId);
  const url = typeof j.campaignUrl === 'string' ? j.campaignUrl.slice(0, 512) : '';
  return { showCampaign: j.showCampaign, claimable: j.claimable === true, campaignUrl: url, campaigns };
}

function authHeaders(cfg, token) {
  if (typeof token !== 'string' || token.length < 8 || /[\u0000-\u001f\s]/.test(token)) throw new Error('token 形态异常，拒绝发请求');
  return { Authorization: `Bearer ${token}`, 'Cosy-ClientType': '10', 'User-Agent': 'qoder-daily-claim' };
}

async function readLimitedText(res, cfg) {
  const max = cfg.maxResponseBytes;
  if (!res.body) {
    const t = await res.text();
    if (t.length > max) throw new Error('响应体超限，已丢弃');
    return t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let len = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    len += value.length;
    if (len > max) { await reader.cancel().catch(() => {}); throw new Error('响应体超限，已丢弃'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function getJson(cfg, token, pathname) {
  const u = new URL(pathname, cfg.apiBase);
  if (!isAllowedHost(u.hostname)) throw new Error('apiBase 主机不合法');
  const res = await fetch(u, { headers: { ...authHeaders(cfg, token), Accept: 'application/json' }, signal: AbortSignal.timeout(cfg.apiTimeoutMs) });
  return res;
}

export async function getCampaigns(cfg, token) {
  const res = await getJson(cfg, token, '/sash/api/v1/me/campaigns');
  if (res.status === 404 || res.status === 410) return { gone: true, status: res.status };
  if (!res.ok) throw Object.assign(new Error(`campaigns HTTP ${res.status}`), { httpStatus: res.status });
  let data;
  try { data = JSON.parse(await readLimitedText(res, cfg)); }
  catch { throw Object.assign(new Error(`campaigns 响应解析失败 (HTTP ${res.status})`), { httpStatus: res.status }); }
  return { status: res.status, data: validateCampaignsResponse(data) };
}

export async function claimCampaign(cfg, token, campaignId) {
  const res = await getJson(cfg, token, new URL(buildClaimUrl(cfg.apiBase, campaignId)).pathname);
  let j = null;
  try { j = JSON.parse(await readLimitedText(res, cfg)); } catch { /* 非 JSON 视作失败 */ }
  const claimed = res.ok && (j?.status === 'CLAIMED' || j?.data?.status === 'CLAIMED' || j?.claimStatus === 'CLAIMED');
  return { claimed, httpStatus: res.status, detail: j ? sanitizeText(JSON.stringify(j), 160) : '' };
}

export const freeRank = (c) => (/free|qwen|qwq|tongyi|免费/i.test(`${c.campaignKey} ${c.actionType}`) ? 0 : 1);

export function pickTargets(data, max = 20) {
  return data.campaigns
    .filter((c) => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE' && c.campaignId)
    .sort((a, b) => freeRank(a) - freeRank(b))
    .slice(0, Math.max(1, Math.min(max, 50)));
}
