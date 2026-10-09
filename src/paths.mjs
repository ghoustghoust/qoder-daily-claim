// 运行数据目录（logs/state/stats）：程序、计划任务、CLI 三方共用同一解析逻辑，防目录漂移。
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function resolveDataDir() {
  const dir = process.env.QDC_HOME || PKG_ROOT;
  const logs = path.join(dir, 'logs');
  mkdirSync(logs, { recursive: true });
  return { dir, logs, state: path.join(dir, 'state.json'), stats: path.join(dir, 'stats.json') };
}
