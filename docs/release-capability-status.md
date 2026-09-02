# 发布能力状态

此表是 Windows 发布门禁的受控产品声明。门禁只接受 `resources/audio-engine` 中已暂存 DLL、Node addon、VST3 helpers 的存在、SHA-256 与 PE 导入表，以及 `audio-capabilities.json` 的运行观察；运行观察必须声明 `audio-engine-runtime-observation` 来源，并逐一匹配暂存 artifact hash。不从开发机 PATH、设置项或设备名称推断能力。`available` 只说明该受控维度已有事实，不能替代真实设备证据。

`available`、`experimental`、`unverified`、`not-built` 和 `unsupported` 是唯一允许的状态。没有真实设备时必须保持 `unverified`，不会使普通软件构建失败。

| Capability          | Product status | Build presence | Runtime observation | Real-device verification |
| ------------------- | -------------- | -------------- | ------------------- | ------------------------ |
| ASIO                | `experimental` | `available`    | `available`         | `unverified`             |
| VST3                | `not-built`    | `not-built`    | `not-built`         | `unverified`             |
| SoXR                | `unverified`   | `unverified`   | `unverified`        | `unverified`             |
| ebur128             | `available`    | `available`    | `available`         | `unverified`             |
| CUDA                | `not-built`    | `not-built`    | `not-built`         | `unverified`             |
| Native DSD provider | `available`    | `available`    | `available`         | `unverified`             |

每个完整发布流程会生成并校验 `release-capability-status.json`。它与 `audio-capabilities.json` 同处于暂存/打包的 `resources/audio-engine`，是实际发布包的机器可读声明；每项输出都带 build/runtime/device 的 state、reason 与 provenance。二者不一致、必需 DLL/node 缺失、VST3 helper 只暂存一半，或非系统导入未随包携带都会使门禁失败。
