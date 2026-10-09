# qoder-daily-claim

Windows 本地 CLI：用你**自己机器上已登录的 Qoder CN 客户端登录态**，通过官方活动接口自动领取每日免费积分/权益，并在领取结果时弹一条 Windows 系统通知。零运行时依赖、无 GUI 点击、无头浏览器默认不启用。

> ⚠️ **免责声明 / Disclaimer**
> - 本项目仅供学习研究与自己账号的自动化便利。自动化领取奖励**可能违反 Qoder 服务条款**，由此产生的账号风险（限权、封禁、权益回收等）由使用者自行承担，作者不提供任何保证。使用前请阅读 Qoder 的用户协议与活动规则。
> - This tool may violate the service terms of the target product. Use at your own risk; the author accepts no liability for account actions taken by the provider.
> - 本项目与 Qoder 官方无关，不获得任何赞助或背书。Not affiliated with or endorsed by Qoder.
> - 只应对**你本人拥有并登录**的账号使用。Do not use on accounts you do not own.

## 数据流向（什么数据、发到哪、为什么）

| 数据 | 去向 | 说明 |
|---|---|---|
| 本机 `auth.v1.dat` + `Local State`（登录态密文） | 仅本地读取解密，**不发送** | 用 Windows DPAPI（当前用户）解密，token 只在内存中存在；任何日志/通知/异常均不含 token |
| `Authorization: Bearer <token>` + 请求参数 | **仅** `https://openapi.qoder.com.cn`（Qoder 官方 API） | 查询活动列表与调用官方领取端点；域名白名单硬编码在默认配置，可自行核对 |
| 领取结果、活动 key | 本地 `logs/`、`state.json`、`stats.json` | 全部留在本机；`stats.json` 用于每月累计播报 |
| 通知内容 | Windows 本地 toast（PowerShell WinRT） | 不经过任何网络 |

**没有遥测、没有崩溃上报、没有第三方分析、不联网下载代码。** 全部出站请求可以在 `src/api.mjs` 一处审查完毕。

## 安装

要求：Windows 10/11、Node.js ≥ 20.11、本机装有 Qoder CN 客户端且**已登录过**。

```powershell
git clone https://github.com/<you>/qoder-daily-claim.git
cd qoder-daily-claim
npm link          # 或直接用 node bin/cli.mjs
qoder-daily-claim selfcheck    # 校验配置/登录态/通知链路
qoder-daily-claim install      # 计划任务(默认每天10:10) + 登录自启
qoder-daily-claim claim        # 立即执行一次领取流程
```

## 命令

| 命令 | 作用 |
|---|---|
| `claim` | 查询→领取所有 `CLAIM_BENEFIT` 可领权益（免费模型类优先）→验证→播报；失败按配置自动重试 |
| `status` / `selfcheck` | 只读诊断 |
| `install [--at 10:10]` / `uninstall` | 注册/移除计划任务与登录自启（当前用户级，无需管理员） |
| `disable` / `enable` | 停用/恢复（工具触发活动下线的自愈禁用后，用 `enable` 恢复） |
| `test-toast` | 验证通知链路 |

## 配置（可选）

`%APPDATA%\qoder-daily-claim\config.json`（或环境变量）：

| 键 / 环境变量 | 默认 | 说明 |
|---|---|---|
| `apiBase` / `QDC_API_BASE` | `https://openapi.qoder.com.cn` | 只允许 HTTPS 且主机必须在**硬编码官方域白名单**内（不可配置扩大） |
| `clientExe` / `QODER_CN_EXE` | 注册表自动探测 | 仅用于登录态临期时拉起客户端续期 |
| `clientDataDir` / `QODER_CN_DATA` | `%APPDATA%\com.qodercn.app.stable` | 登录态所在目录 |
| `taskName` | `QoderDailyClaim` | 仅限 `[A-Za-z0-9_-]`（防注入） |
| `refreshAt` | `10:00 +30s` | 官方每日资格刷新时间，早于它会自动挂起到点 |
| `retry` | 3 分钟 × 10 次 | 失败重试 |
| `offlineStreakDays` | 7 | 连续 N 天查无活动 → 自我禁用并播报 |
| `hardErrorStreak` | 3 | 接口连续 N 次 404/403 才自我禁用（防单次抖动或风控页误停） |
| `notify` | 长停留+声音 | toast 行为 |

## 自愈与安全设计

- **服务器响应视为不可信输入**：campaigns/claim 响应做结构校验与体积上限；`campaignId` 严格白名单正则后才拼 URL；进入通知/日志/子进程的字符串统一清洗（控制符、双向格式符、限长）。
- **活动页兜底**：即使未来启用对 `campaignUrl` 的分析，只允许配置中的 Qoder 官方域名（HTTPS、无凭据 URL）。
- **无 shell 拼接**：所有子进程调用使用参数数组；计划任务命令由运行时自定位路径生成。
- **最小权限**：只读当前用户目录、只写自身目录/启动夹/任务计划（均为用户级，无需管理员）；DPAPI 解密只针对当前用户自身数据。
- **自我禁用**：活动下线、接口 403、接口 404 等异常时停用定时任务与自启，等待人工 `enable`，不会反复冲击接口。

更多见 [docs/SECURITY.md](docs/SECURITY.md)。

## 测试

```bash
npm test   # node:test smoke 测试，无网络
```

## 已知边界

- 每日积分刷新时间由官方服务器控制，默认按 10:00 优化；如官方调整，改 `refreshAt` 即可。
- 仅支持 CN 版客户端体系（qoder.com.cn）；国际版账号体系不同，未适配。
- 活动机制若被官方重构（新协议/风控变化），工具会以「暂停+播报」方式提示，而不是静默乱试。

## License

MIT — 见 [LICENSE](LICENSE)。因使用本工具导致的任何账号处置，作者不承担责任。
