#!/usr/bin/env node
// qoder-daily-claim CLI
import { loadConfig } from '../src/config.mjs';
import { runClaim, makePaths, cleanupLogs } from '../src/checkin.mjs';
import { getCampaigns } from '../src/api.mjs';
import { loadAuth, tokenValid } from '../src/auth.mjs';
import { toast } from '../src/notify.mjs';
import { installTask, installAutostart, uninstall, disableAll, enableAll, taskStatus } from '../src/install.mjs';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

const [, , cmd, ...rest] = process.argv;
const flag = (name, def) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : def; };

const HELP = `qoder-daily-claim — 本机 Qoder CN 每日积分自动领取（官方 API，零依赖，无遥测）

  claim                          执行一次领取流程（登录自启与计划任务都调它）
  status                         只读查询今日领取状态
  selfcheck                      检查配置/登录态/通知链路
  install  [--at 10:10]          注册计划任务 + 登录自启（当前用户，无需管理员）
  uninstall                      删除计划任务与自启脚本
  enable / disable               恢复 / 停用（自愈禁用后用 enable 恢复）
  task-status                    查看计划任务详情
  test-toast                     发一条本机通知验证播报
`;

function setDisabledFlag(disabled) {
  try {
    const p = makePaths().state;
    const st = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    st.disabled = disabled;
    if (!disabled) delete st.disabledReason;
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
  } catch { /* ignore */ }
}

function parseAt(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) throw new Error('--at 需为 HH:MM');
  const h = Number(m[1]), mm = Number(m[2]);
  if (!(h >= 0 && h <= 23 && mm >= 0 && mm <= 59)) throw new Error('--at 越界');
  return { hour: h, minute: mm };
}

async function main() {
  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(HELP); return; }
  const cfg = loadConfig();
  switch (cmd) {
    case 'claim': {
      const paths = makePaths();
      const r = await runClaim(cfg, { paths });
      cleanupLogs(paths);
      process.exitCode = r.outcome === 'claimed' || r.outcome === 'skipped' || r.outcome === 'disabled' ? 0 : 1;
      break;
    }
    case 'status': {
      const auth = loadAuth(cfg);
      const r = await getCampaigns(cfg, auth.token);
      console.log(JSON.stringify({ tokenValid: tokenValid(auth), ...(r.gone ? { gone: true, status: r.status } : r.data) }, null, 2));
      break;
    }
    case 'selfcheck': {
      console.log(JSON.stringify({
        configOk: true,
        apiBase: cfg.apiBase,
        clientExe: cfg.clientExe || '(未探测到，仅影响临期自动拉起)',
        dataDirOk: (() => { try { return tokenValid(loadAuth(cfg)); } catch { return false; } })(),
        toastOk: toast(cfg, 'qoder-daily-claim selfcheck', '通知链路 OK'),
      }, null, 2));
      break;
    }
    case 'install': {
      const { hour, minute } = parseAt(flag('at', '10:10'));
      installTask(cfg, { hour, minute });
      const vbs = installAutostart(cfg);
      console.log(`已安装：计划任务 ${cfg.taskName} @ ${hour}:${String(minute).padStart(2, '0')} + 登录自启 ${vbs}`);
      break;
    }
    case 'uninstall': console.log('已移除:', uninstall(cfg).join(', ') || '（无残留）'); break;
    case 'disable': disableAll(cfg); setDisabledFlag(true); console.log('已停用'); break;
    case 'enable': enableAll(cfg); setDisabledFlag(false); console.log('已启用'); break;
    case 'test-toast': console.log(toast(cfg, 'qoder-daily-claim', '这是一条测试通知')); break;
    case 'task-status': console.log(taskStatus(cfg) || '任务不存在'); break;
    default: console.log(HELP); process.exitCode = 2;
  }
}

main().catch((e) => { console.error(`错误: ${String(e.message).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300)}`); process.exitCode = 1; });
