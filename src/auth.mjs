// 读取“本机当前用户自己的” Qoder CN 登录态。
// auth.v1.dat = Electron safeStorage v10：'v10' + 12B IV + AES-256-GCM(ct+16B tag)。
// AES key 存于同目录 "Local State"（os_crypt.encrypted_key，DPAPI CurrentUser 包裹）。
// 安全：DPAPI 明文 key 只经 stdout 管道回传，绝不落盘；token 只在内存；错误信息固定话术不带文件内容。
import { readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';

const MAX_AUTH_FILE = 1 << 20; // 1MB
const MAX_LS_FILE = 4 << 20;

function unprotectViaDPAPI(encKeyWithoutPrefix) {
  const ps = `
    Add-Type -AssemblyName System.Security
    $b=[Convert]::FromBase64String($env:QDC_DPAPI_IN)
    $o=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')
    [Convert]::ToBase64String($o)
  `;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
    encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, QDC_DPAPI_IN: encKeyWithoutPrefix.toString('base64') },
  });
  const b64 = out.trim().split(/\r?\n/).pop().replace(/[^A-Za-z0-9+/=]/g, '');
  return Buffer.from(b64, 'base64');
}

// 纯函数便于测试注入 key
export function decryptV10(fileBuf, aesKey) {
  if (fileBuf.subarray(0, 3).toString('latin1') !== 'v10') throw new Error('auth.v1.dat 非 v10 格式（客户端加密方案已变化，需适配）');
  const iv = fileBuf.subarray(3, 15);
  const body = fileBuf.subarray(15);
  if (body.length < 17) throw new Error('auth.v1.dat 内容过短');
  const d = createDecipheriv('aes-256-gcm', aesKey, iv);
  d.setAuthTag(body.subarray(body.length - 16));
  let json;
  try { json = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString('utf8'); }
  catch { throw new Error('auth.v1.dat 解密校验失败（key 或文件损坏）'); } // GCM 失败不含明文
  let parsed;
  try { parsed = JSON.parse(json); } catch { throw new Error('登录态 JSON 结构异常'); } // 不透传解析器错误（可能含片段）
  return parsed;
}

export function loadAuth(cfg) {
  const lsPath = path.join(cfg.clientDataDir, 'Local State');
  const authPath = path.join(cfg.clientDataDir, 'auth.v1.dat');
  let aesKey;
  {
    const lsRaw = readFileSync(lsPath); // ENOENT 向上抛，由调用方按“未登录”处理
    if (lsRaw.length > MAX_LS_FILE) throw new Error('Local State 大小异常');
    let ls;
    try { ls = JSON.parse(lsRaw.toString('utf8')); } catch { throw new Error('Local State 非法 JSON'); }
    const b64 = ls?.os_crypt?.encrypted_key;
    if (typeof b64 !== 'string' || b64.length > 4096) throw new Error('缺少合法 encrypted_key（请确认已登录 Qoder CN）');
    const encKey = Buffer.from(b64, 'base64');
    if (encKey.subarray(0, 5).toString('latin1') !== 'DPAPI') throw new Error('encrypted_key 非 DPAPI 包裹（格式变化）');
    aesKey = unprotectViaDPAPI(encKey.subarray(5));
  }
  if (aesKey.length !== 32) throw new Error('DPAPI 解出的 AES key 长度异常');
  const fileBuf = readFileSync(authPath);
  if (fileBuf.length === 0 || fileBuf.length > MAX_AUTH_FILE) throw new Error('auth.v1.dat 大小异常');
  const auth = decryptV10(fileBuf, aesKey);
  aesKey.fill(0);
  for (const k of ['token', 'refreshToken', 'expiresAt']) if (typeof auth[k] !== 'string') throw new Error(`登录态字段缺失: ${k}`);
  if (!Number.isFinite(Date.parse(auth.expiresAt))) throw new Error('expiresAt 非法');
  return auth;
}

export function tokenValid(auth, skewMs = 60_000) {
  return new Date(auth.expiresAt).getTime() > Date.now() + skewMs;
}

export function getAccessToken(cfg) {
  const auth = loadAuth(cfg);
  if (!tokenValid(auth)) throw new Error('本机登录态已过期：打开一次 Qoder CN 客户端即自动续期');
  return auth.token;
}

export const defaultDataDir = () => path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'com.qodercn.app.stable');
