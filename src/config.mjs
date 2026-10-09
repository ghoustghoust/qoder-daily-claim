// 配置解析：默认值 < %APPDATA%\qoder-daily-claim\config.json < 环境变量。
// 安全边界：apiBase 主机必须落在硬编码官方域白名单内；白名单本身不可被配置扩大；
// 任务名/客户端路径做字符与形态校验，防进入计划任务命令时注入。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

export const ALLOWED_HOSTS = Object.freeze(['qoder.com.cn', 'qoder.cn', 'qoder.sh', 'qoder.com']);

export const DEFAULTS = Object.freeze({
  apiBase: 'https://openapi.qoder.com.cn',
  clientDataDir: null, // null => %APPDATA%\com.qodercn.app.stable
  clientExe: null,     // null => 注册表探测；找不到则跳过“拉起客户端”，仅走 API
  taskName: 'QoderDailyClaim',
  refreshAt: { hour: 10, minute: 0, bufferSeconds: 30 },
  retry: { intervalMs: 180000, max: 10 },
  offlineStreakDays: 7,
  hardErrorStreak: 3, // 连续 N 次 404/403 才自我禁用（防单次抖动/风控页永久停表）
  apiTimeoutMs: 15000,
  maxResponseBytes: 512_000,
  maxClaimTargets: 20,
  notify: { enabled: true, duration: 'long', sound: true },
});

export const appData = () => process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');

const deepMerge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a[k] ?? {}, v) : v;
  return out;
};

export function isAllowedHost(hostname) {
  const h = hostname.toLowerCase();
  return ALLOWED_HOSTS.some((d) => h === d || h.endsWith('.' + d));
}

function validate(cfg) {
  const u = new URL(cfg.apiBase);
  if (u.protocol !== 'https:' || u.pathname !== '/' || u.username || u.password) throw new Error('apiBase 必须是无凭据的 HTTPS 根地址');
  if (!isAllowedHost(u.hostname)) throw new Error('apiBase 主机不在官方域白名单内（不可配置扩大）');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cfg.taskName)) throw new Error('taskName 只允许字母数字/_/-（防命令注入）');
  if (!(cfg.retry.intervalMs >= 1000) || !(cfg.retry.max >= 1 && cfg.retry.max <= 100)) throw new Error('retry 配置越界');
  if (!(cfg.apiTimeoutMs >= 1000 && cfg.apiTimeoutMs <= 120_000)) throw new Error('apiTimeoutMs 越界');
  if (!(cfg.maxResponseBytes >= 4096 && cfg.maxResponseBytes <= 4_000_000)) throw new Error('maxResponseBytes 越界');
  const { hour, minute } = cfg.refreshAt;
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) throw new Error('refreshAt 越界');
  if (typeof cfg.clientExe === 'string') {
    if (cfg.clientExe.startsWith('\\\\')) throw new Error('clientExe 拒绝 UNC 路径（NTLM 泄露风险）');
    if (!/^Qoder CN\.exe$/i.test(path.basename(cfg.clientExe))) throw new Error('clientExe 必须是 Qoder CN.exe');
  }
  if (typeof cfg.clientDataDir === 'string' && cfg.clientDataDir.startsWith('\\\\')) throw new Error('clientDataDir 拒绝 UNC 路径');
  for (const p of [cfg.clientExe, cfg.clientDataDir]) if (typeof p === 'string' && p.includes('"')) throw new Error('路径含双引号，拒绝（计划任务命令安全）');
}

export function loadConfig() {
  const file = process.env.QDC_CONFIG || path.join(appData(), 'qoder-daily-claim', 'config.json');
  let fromFile = {};
  if (existsSync(file)) {
    try { fromFile = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Error(`配置文件无效 JSON (${file})`); } // 不透传解析细节，避免带入文件内容
  }
  const fromEnv = {};
  if (process.env.QDC_API_BASE) fromEnv.apiBase = process.env.QDC_API_BASE;
  if (process.env.QODER_CN_EXE) fromEnv.clientExe = process.env.QODER_CN_EXE;
  if (process.env.QODER_CN_DATA) fromEnv.clientDataDir = process.env.QODER_CN_DATA;
  const cfg = deepMerge(deepMerge(DEFAULTS, fromFile), fromEnv);
  cfg.allowedCampaignHosts = ALLOWED_HOSTS; // 永远使用硬编码白名单，config 不可扩
  validate(cfg);
  if (!cfg.clientDataDir) cfg.clientDataDir = path.join(appData(), 'com.qodercn.app.stable');
  if (!cfg.clientExe) cfg.clientExe = detectClientExe();
  return cfg;
}

// 只读查询当前用户卸载登记项定位 exe（读注册表，不写、不提权；失败非致命返回 null）
let detectedExe;
export function detectClientExe() {
  if (detectedExe !== undefined) return detectedExe;
  detectedExe = null;
  try {
    const ps = `
      Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue |
      ForEach-Object { $_.DisplayIcon; $_.InstallLocation } | Where-Object { $_ -is [string] -and $_ } |
      ForEach-Object {
        $p = $_ -replace '\\\\uninstallerIcon\\.ico$',''
        $p = $p.TrimEnd('\\')
        if (Test-Path -LiteralPath $p -PathType Container) { $candidate = Join-Path $p 'Qoder CN.exe'; if (Test-Path -LiteralPath $candidate) { $candidate } }
        elseif ($p -match 'Qoder CN.exe$' -and (Test-Path -LiteralPath $p)) { $p }
      }
    `;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      if (/qoder.?cn\.exe$/i.test(line) && existsSync(line) && !line.startsWith('\\\\')) { detectedExe = line; break; }
    }
  } catch { /* ignore */ }
  return detectedExe;
}

// 所有进入 toast/日志/子进程参数的远端字符串必须经过：剔控制符/双向格式符、压空白、限长
export function sanitizeText(s, max = 180) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
