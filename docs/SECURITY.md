# SECURITY.md — 威胁模型与安全设计

## 信任边界

1. **本机当前用户的登录态**（`auth.v1.dat`，DPAPI-CurrentUser 加密）。
   能运行本工具（同一 Windows 用户会话）的任何进程，本来就能通过 Qoder CN
   客户端本身获得同等能力——本工具**没有扩大**凭据的可达面。
2. **官方 API 的响应**（campaigns / claim）。视为**不可信输入**处理：
   - 结构白名单校验 + **流式**响应体上限（默认 512KB，超限即断流丢弃）；
   - `campaignId` 必须匹配 `^[A-Za-z0-9_-]{1,64}$` 才参与 URL 构造；
   - 任何进入 toast、日志、子进程参数的远端字符串先经 `sanitizeText`
     （剔除控制符与 Unicode 双向格式符、压缩空白、截断），
     防止终端转义攻击 / RTL 伪文本 / 计划任务参数注入；
   - `campaignUrl` 仅允许**硬编码**的 Qoder 官方域名白名单（配置文件不可扩大）；
     `apiBase` 主机同样被白名单锁死，防止配置改写把 Bearer token 发往任意主机。
3. **配置文件**。`taskName` 等会被写进计划任务命令的字段做字符白名单；
   所有子进程一律参数数组调用（不经 shell 拼接）。

## 数据流向承诺

- 出站网络仅一个目的地：`apiBase`（默认 `https://openapi.qoder.com.cn`）。
- 不含任何遥测、闪报、更新检查、第三方 SDK。
- token/refreshToken 只存在于内存与本机受 DPAPI 保护的文件中；
  代码中不存在把 token 写入日志、通知或网络请求体的路径（日志统一
  `sanitizeText` 且有先例约束：Bearer 头仅在构造请求对象时拼接）。
- `state.json` / `stats.json` / `logs/` 已在 `.gitignore`，不会携带个人数据入库。

## Prompt/指令注入防护（针对"被 agent 调用"场景）

本工具可能被编码 Agent 作为技能脚本执行。API 响应文案（活动标题等）
即使被投毒成"指令样式"文本，也只会进入：日志（清洗后）、toast 显示文本
（清洗后截断）、以及下一次本进程日志——**不会被 eval、不会拼进 shell 命令、
不会作为 agent 指令回传**。浏览器兜底（若手动启用）同样受域名白名单约束，
且只在页面上点击固定文案按钮，不执行页面脚本返回值。

## 最小权限清单

| 需要的能力 | 用途 | 是否必需 |
|---|---|---|
| 读 `%APPDATA%\com.qodercn.app.stable` | 解密自身登录态 | 必需 |
| DPAPI(CurrentUser) | 同上 | 必需 |
| HTTPS 到 apiBase | 查询/领取 | 必需 |
| 写自身目录 logs/state/stats | 运行记录 | 必需 |
| schtasks（当前用户级） | 每日定时 | 可选（不装任务直接手动 claim） |
| 启动夹写 vbs | 登录自启 | 可选 |
| PowerShell WinRT toast | 播报 | 可选（`notify.enabled=false` 关闭） |

## 失效模式

- 网络类失败 → 重试上限（默认 3 分钟 × 10 次）后本地播报，不停表。
- 接口持续 404/403（`hardErrorStreak` 阈值）或连续 N 天查无活动 → **自我禁用**
  （禁用计划任务与自启，需人工 `enable` 恢复），避免无意义冲击接口。
- DPAPI 明文 AES key 仅经内存/stdout 管道传递，全程不落盘；
  解密失败与结构异常的错误信息均为固定话术，不回显文件内容。
- state/stats 采用 temp+rename 原子写；计划任务设 IgnoreNew 防重叠执行。

## 最小权限之外的写操作（均为当前用户目录，无需管理员）

启动夹 `.vbs`、用户级计划任务、自身数据目录。卸载即删这两处文件。

## 漏洞披露

发现本仓库代码的安全问题请开 GitHub Issue（如涉及他方账户凭据利用方式，
请先开私有 issue）。请勿直接提交包含可复现攻击路径的公开 PR。
