# 日活与使用统计（Telemetry）契约

客户端内置最小化使用统计，用于统计**应用启动（今日用户/DAU）**与**累计听歌时长**。采集与上报全部在主进程完成（`src/main/analytics/`），renderer 不参与，也不新增任何 IPC 通道。

## 采集范围（仅以下数据，别无其他）

| 数据                   | 说明                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `installId`            | 首次启动生成的随机 UUID，持久化在 `userData/telemetry/install-id.json`。不采集机器名、用户名、硬件指纹、曲目信息、文件路径 |
| `sessionId`            | 每次应用启动生成的随机 UUID，用于关联同一会话的事件                                                                        |
| `app_start` 事件       | 应用启动时记录一次，用于统计今日用户（按 `installId` + 日期去重）                                                          |
| `session_summary` 事件 | 应用退出时记录本次会话的累计听歌秒数（仅播放状态计入）与会话时长；未听歌的会话不发送                                       |
| 应用版本、平台、架构   | `appVersion` / `platform` / `arch`                                                                                         |

听歌时长以主进程原生引擎的 `playback-info` 状态为准：进入 `playing` 开始计时，离开 `playing` 停止。单段计时上限 8 小时，防御休眠/时钟跳变。

## 上报契约

批量投递，`POST` JSON 到上报端点，服务端返回 2xx 即视为成功：

```json
{
  "schemaVersion": 1,
  "events": [
    {
      "schemaVersion": 1,
      "type": "app_start",
      "installId": "4f0d9c2a-1b3e-4d5f-9a6b-7c8d9e0f1a2b",
      "sessionId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      "timestamp": 1756224000000,
      "appVersion": "1.1.0",
      "platform": "win32",
      "arch": "x64"
    },
    {
      "schemaVersion": 1,
      "type": "session_summary",
      "installId": "4f0d9c2a-1b3e-4d5f-9a6b-7c8d9e0f1a2b",
      "sessionId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      "timestamp": 1756227600000,
      "appVersion": "1.1.0",
      "platform": "win32",
      "arch": "x64",
      "listeningSeconds": 1800,
      "sessionSeconds": 3600
    }
  ]
}
```

类型定义与校验见 `src/shared/telemetry.ts`。

### session_summary 的检查点语义

`session_summary.listeningSeconds` 是**本会话截至当前累计**的听歌秒数，不是增量。客户端除退出时的最终汇总外，运行期每 5 分钟发送一次检查点快照；服务端按 `(installId, sessionId)` 只保留最大值，因此重放、乱序、补投、多次检查点都不会重复计数，进程被硬杀时最多损失最近一个检查点间隔内的时长。

## 投递与可靠性

- 事件先写入本地磁盘队列（`userData/telemetry/event-queue.json`，原子写 + 备份），再异步投递。
- 投递失败、离线或进程被杀都不会丢事件：下次启动载入队列重试；队列上限 120 条，超出丢弃最旧。
- 退出时的投递是尽力而为；落盘是同步的，保证事件不丢。
- 运行期每 30 分钟尝试一次补投；听歌进行中每 5 分钟一次检查点投递。
- 端点策略：仅允许 `https:` 或本机 `http:`（localhost / 127.0.0.1）；请求超时 10 秒。

## 端点配置

正式上报端点：`https://telemetry.aaapi.fun/v1/events`，由 `DEFAULT_TELEMETRY_ENDPOINT_URL`（`src/main/analytics/index.ts`）提供，服务端实现见 `server/telemetry/`。服务端尚未上线时，事件会先进本地队列，上线后自动补投，不会丢失。

联调可用本地 mock 服务（零依赖，校验契约并打印收到的事件）：

```powershell
pnpm run mock:telemetry -- --port 8787
$env:TWILIGHT_TELEMETRY_ENDPOINT_URL = "http://127.0.0.1:8787/v1/events"
pnpm run dev
```

环境变量 `TWILIGHT_TELEMETRY_ENDPOINT_URL` 覆盖默认端点，仅用于联调。

## 服务端实现要求（供后端参考）

官方参考实现：`server/telemetry/`（零 npm 依赖，Node 内置 `node:sqlite`，含部署脚本与自测，见 `server/telemetry/README.md`）。自建服务需满足：

- 接受 `POST /v1/events`，请求体为上文的批量结构；用 `isTelemetryBatchRequest` 同等规则校验，非法返回 400。
- DAU = 按天对 `installId` 去重的 `app_start` 计数；累计听歌时长 = 按 `(installId, sessionId)` 对 `session_summary.listeningSeconds` 取最大值后求和（检查点是累计快照，不是增量，直接求和会重复计数）。
- 事件天然幂等：同会话检查点取最大值，重放/乱序/补投不产生额外计数。
- 建议保留原始事件表 + 按天聚合表；单条事件小于 300 字节，批量上限 120 条。

## 测试

- 契约校验：`src/shared/telemetry.test.ts`
- 客户端行为（安装标识、听歌累计、离线队列、端到端投递、端点策略）：`src/main/analytics/telemetryClient.test.ts`
- 运行：`pnpm run test:analytics`（已纳入 `test:no-real-device` 全量门禁）
