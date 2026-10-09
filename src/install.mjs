// 计划任务 + 登录自启的安装/卸载。子进程一律参数数组调用；taskName 已在 config 白名单；
// 写入计划任务命令前对路径做引号/长度校验；VBS 内容为纯 ASCII（防码页破坏、防 UTF-8 BOM 报错）。
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { PKG_ROOT, resolveDataDir } from './paths.mjs';

const CLI = path.join(PKG_ROOT, 'bin', 'cli.mjs');
const startupDir = () => path.join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const vbsName = (cfg) => `${cfg.taskName}.vbs`;

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, ...opts });
}

function assertPlainCmdPath(p, what) {
  if (p.includes('"') || p.includes('\n') || /^\\\\/.test(p)) throw new Error(`${what} 含不安全字符，拒绝写入计划任务`);
}

export function installTask(cfg, { hour = 10, minute = 10 } = {}) {
  assertPlainCmdPath(cfg.taskName, 'taskName');
  assertPlainCmdPath(process.execPath, 'node 路径');
  assertPlainCmdPath(CLI, 'CLI 路径');
  const logs = resolveDataDir().logs;
  const tr = `cmd /c ""${process.execPath}" "${CLI}" claim >> "${path.join(logs, 'task.log')}" 2>&1"`;
  if (tr.length > 255) throw new Error('计划任务命令超过 255 字符，请更换安装位置');
  try { run('schtasks.exe', ['/Delete', '/TN', cfg.taskName, '/F'], { stdio: 'ignore' }); } catch { /* 旧任务不存在 */ }
  run('schtasks.exe', ['/Create', '/F', '/TN', cfg.taskName, '/SC', 'DAILY', '/ST', `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, '/TR', tr]);
  const st = 'New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew';
  try { run('powershell.exe', ['-NoProfile', '-Command', `$s=${st}; Set-ScheduledTask -TaskName '${cfg.taskName}' -Settings $s | Out-Null`]); } catch { /* 权限不足则保留基础任务 */ }
  return true;
}

export function installAutostart(cfg, { delaySeconds = 180 } = {}) {
  assertPlainCmdPath(process.execPath, 'node 路径');
  assertPlainCmdPath(CLI, 'CLI 路径');
  const file = path.join(startupDir(), vbsName(cfg));
  const esc = (s) => s.replace(/'/g, "''"); // VBS 字符串内 PowerShell 单引号字面量转义
  const lines = [
    `' qoder-daily-claim: run "${cfg.taskName}" claim after logon`,
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "powershell -NoProfile -WindowStyle Hidden -Command ""Start-Sleep ${Math.max(0, Math.min(3600, Number(delaySeconds) || 180))}; & '${esc(process.execPath)}' '${esc(CLI)}' claim""", 0, False`,
  ];
  // 纯 ASCII + CRLF + 无 BOM（cscript 对带 BOM 的 UTF-8 会报“无效字符”）
  writeFileSync(file, lines.join('\r\n'), { encoding: 'latin1' });
  return file;
}

export function uninstall(cfg) {
  const done = [];
  try { run('schtasks.exe', ['/Delete', '/TN', cfg.taskName, '/F']); done.push('scheduled-task'); } catch { /* 不存在 */ }
  const vbs = path.join(startupDir(), vbsName(cfg));
  for (const f of [vbs, vbs + '.disabled']) if (existsSync(f)) { unlinkSync(f); done.push(path.basename(f)); }
  return done;
}

export function disableAll(cfg) {
  try { run('schtasks.exe', ['/Change', '/TN', cfg.taskName, '/DISABLE']); } catch { /* ignore */ }
  try {
    const vbs = path.join(startupDir(), vbsName(cfg));
    if (existsSync(vbs)) renameSync(vbs, vbs + '.disabled');
  } catch { /* ignore */ }
}

export function enableAll(cfg) {
  try { run('schtasks.exe', ['/Change', '/TN', cfg.taskName, '/ENABLE']); } catch { /* ignore */ }
  try {
    const off = path.join(startupDir(), vbsName(cfg)) + '.disabled';
    if (existsSync(off)) renameSync(off, off.replace(/\.disabled$/, ''));
  } catch { /* ignore */ }
}

export function taskStatus(cfg) {
  try { return run('schtasks.exe', ['/Query', '/TN', cfg.taskName, '/FO', 'LIST', '/V']); } catch { return null; }
}
