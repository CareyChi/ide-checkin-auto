<div align="center">

# ide-checkin-auto

**一键领取 WorkBuddy、Trae、Qoder 三款 IDE 的每日签到积分**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6?style=flat-square)](#环境要求)
[![Node](https://img.shields.io/badge/node-%E2%89%A516-339933?style=flat-square&logo=node.js&logoColor=white)](#环境要求)

</div>

`ide-checkin.js` 是一个 Windows 本地小工具：直接读取三款 IDE 客户端在本机已登录的登录态，替你调用官方接口完成每日签到

## 特性

- **一键三签**：一条命令依次完成 Trae CN、Qoder CN、WorkBuddy 的当日签到
- **三合一看板**：`status` 一屏展示账号、今日状态、连签天数、积分余额与 token 剩余有效期
- **单文件零依赖**：全部逻辑都在 `ide-checkin.js` 里，只用 Node.js 内置模块，无需 `npm install`
- **克制安全**：只在本机读取登录态代发请求；不打印 token、不落盘任何解密产物

## 环境要求

| 依赖 | 要求 |
|---|---|
| 系统 | Windows 10 / 11（依赖 %APPDATA% 与命名管道） |
| 运行时 | Node.js ≥ 16 |
| Trae CN | 已安装并登录过（无需保持运行） |
| Qoder CN | 已安装并登录过（无需保持运行） |
| WorkBuddy | **保持运行**且已登录 |

## 快速开始

`checkin` 输出示例（数值为示例）：

```
┌───────────┬──────────────┬──────────┬──────────┬───────────────────────────┐
│    IDE    │     结果     │ 增加积分 │ 当前余额 │           提示            │
├───────────┼──────────────┼──────────┼──────────┼───────────────────────────┤
│   Trae    │   签到成功   │  80.00   │ 1024.00  │            ---            │
│┄┄┄┄┄┄┄┄┄┄┄│┄┄┄┄┄┄┄┄┄┄┄┄┄┄│┄┄┄┄┄┄┄┄┄┄│┄┄┄┄┄┄┄┄┄┄│┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄│
│   Qoder   │ 今天已经领过 │   ---    │  512.50  │ 明天 10:00 (UTC+8) 再来吧 │
│┄┄┄┄┄┄┄┄┄┄┄│┄┄┄┄┄┄┄┄┄┄┄┄┄┄│┄┄┄┄┄┄┄┄┄┄│┄┄┄┄┄┄┄┄┄┄│┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄│
│ WorkBuddy │ 今天已经领过 │   ---    │  88.80   │        明天再来吧         │
└───────────┴──────────────┴──────────┴──────────┴───────────────────────────┘
```

## 命令一览

| 命令 | 别名 | 说明 |
|---|---|---|
| `node ide-checkin.js checkin` | `all` | 一键三签：Trae → Qoder → WorkBuddy，汇总为一张表 |
| `node ide-checkin.js status` | — | 三合一看板（只查询，不签到） |
| `node ide-checkin.js trae` | `tr` | 仅签到 Trae CN |
| `node ide-checkin.js qoder` | `qd` | 仅签到 Qoder CN |
| `node ide-checkin.js workbuddy` | `wb` | 仅签到 WorkBuddy |

不带参数时显示用法。

## 输出与退出码

`checkin` / `all` 表格各列含义：

| 列 | 含义 |
|---|---|
| IDE | 平台 |
| 结果 | `签到成功`、`今天已经领过`，或带错误码的失败信息 |
| 增加积分 | 本次签到增加的积分；已领或未知显示 `---` |
| 当前余额 | 签到后查询到的实时账户余额 |
| 提示 | 已领时的下一次签到时间提示（如「明天 10:00 (UTC+8) 再来吧」） |

退出码（`checkin` / `all` 取各平台中的最高者，`status` 同理）：

| 退出码 | 含义 |
|:--:|---|
| 0 | 正常（签到成功或今日已领） |
| 1 | 接口返回业务错误 |
| 2 | 脚本级错误（找不到登录态、解密失败、WorkBuddy 未运行等） |

单平台命令（`trae` / `qoder` / `workbuddy`）输出一行结果，退出码含义同上。

## 工作原理

<details>
<summary>展开查看</summary>

| 平台 | 登录态来源 | 签到通道 |
|---|---|---|
| Trae CN | 客户端数据目录中的 `storage.json`（含设备标识，签到请求必须携带） | `api.trae.cn` |
| Qoder CN | 客户端数据目录中的 `auth.v1.dat`（用当前 Windows 用户密钥解密） | `openapi.qoder.com.cn` |
| WorkBuddy | `~/.workbuddy/wbipc/endpoint.json` + 本地命名管道握手 | 客户端本地通道 |

脚本只在本机发起与官方客户端一致的请求，不修改任何客户端文件；签到前会先查询状态，今天已领会如实提示「明天再来吧」，不会重复领取。

</details>

## 常见问题

**Q：会上传或打印我的 token 吗？**
不会。登录态只在本机内存中解密用于发起请求，token 不会被打印，也不落盘。`status` 看板会显示账号昵称，截图分享前请留意。

**Q：提示「找不到登录态」或「解密失败」怎么办？**
打开对应客户端确认已登录后重试。Trae / Qoder 读取的是本地存储文件，不必保持运行；WorkBuddy 的登录态经本地命名管道实时代理，必须保持运行。

**Q：token 会过期吗？**
会。`status` 看板会显示剩余有效期与到期时间；过期后打开对应客户端登录一次即可自动刷新，脚本自身无需额外授权。

**Q：支持多账号 / macOS / Linux 吗？**
不支持，也暂无计划。本项目定位是 Windows 本机单账号自用自动化。

## 声明

- 本项目仅供个人学习与自动化研究使用，请遵守各平台的服务条款与活动规则。
- 签到与积分发放结果以官方客户端展示为准。

## License

[Apache-2.0](LICENSE)
