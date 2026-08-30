# Twilight Echo 插件系统 — 规范与标准

> 版本：v0.1 草案（2026-06-10）
> 状态：Phase 0 定稿目标，定稿前所有字段与契约均可调整
> 分阶段实施边界见 [`twilight-echo-plugin-plan.md`](./twilight-echo-plugin-plan.md)。

## 1. Manifest 标准（`plugin.json`）

每个插件包根目录必须包含 `plugin.json`。

### 1.1 必填字段

| 字段                   | 类型     | 说明                                                                                                 |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `id`                   | string   | 反域名风格全局唯一 ID，如 `com.example.bili-source`                                                  |
| `name`                 | string   | 显示名称                                                                                             |
| `version`              | string   | 插件自身版本，遵循 semver                                                                            |
| `description`          | string   | 简短描述                                                                                             |
| `author`               | string   | 作者名或组织                                                                                         |
| `license`              | string   | SPDX 标识符                                                                                          |
| `type`                 | string[] | `provider` \| `tool` \| `ui` \| `theme` \| `dsp`，可组合                                             |
| `main`                 | string   | JS 轨入口文件（相对包根路径）；DSP 轨改用 `binary`；纯 theme 插件可省略                              |
| `binary`               | object   | DSP 轨：按平台声明动态库路径，如 `{ "win32-x64": "...", "darwin-arm64": "...", "linux-x64": "..." }` |
| `engines.twilightEcho` | string   | 兼容的宿主版本范围（semver range）                                                                   |
| `apiVersion`           | number   | 使用的插件 API 主版本                                                                                |
| `permissions`          | string[] | 权限声明（见 1.3）。**信任式安装下声明仍为必填**，安装时展示给用户                                   |

> JS 插件声明 `main`；DSP 插件声明 `binary`；纯 theme 插件可用 `contributes.themes`
> 声明 CSS 变量/样式表并省略 `main` 与 `binary`。`type` 含 `dsp` 时 `binary` 必填。
> `main`、`icon` 与 `binary.*` 统一规范化为 POSIX `/` 分隔的插件内相对路径；Windows
> drive/UNC/rooted path、POSIX absolute path 与任何逃逸根目录的 `..` 均拒绝。该结果同时
> 是索引签名 payload 的跨平台 canonical path，不能使用宿主平台的 `path.normalize`。

### 1.2 可选字段

| 字段                      | 说明                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `contributes`             | 声明扩展点贡献：页面、设置项、命令、主题资源                                            |
| `dependencies`            | 可选插件依赖表，形态为 `{ "<pluginId>": "<semver range>" }`，用于启用校验与按依赖序加载 |
| `homepage` / `repository` | 主页与源码仓库                                                                          |
| `icon`                    | 图标路径                                                                                |
| `signature`               | 预留签名字段（未来收紧安全策略时启用，不破坏格式）                                      |

`signature` 属于包内 manifest 的预留字段。索引发布者签名使用索引 entry 专有的
`publisherSignature`，不得把两者混用；后者不写入 `.tep` 内的 `plugin.json`。

### 1.3 权限声明枚举（首批）

`network`、`filesystem:read`、`filesystem:write`、`player:control`、`player:observe`、`library:read`、`library:write`、`settings`、`clipboard`、`ui:inject`、`dsp:native`

## 2. 插件包格式

- 一个插件 = 一个目录或一个 zip 包（扩展名 **`.tep`**），根目录含 `plugin.json`。
- 安装位置：用户数据目录下 `plugins/<id>/<version>/`。
- 插件私有数据：`plugin-data/<id>/`，卸载时可选清除。
- 插件日志：`logs/plugins/<id>.log`，每插件独立通道。
- **禁止**插件写入自身目录与私有数据目录以外的应用文件。

插件更新必须先进入与 `plugins/` 同卷的私有 transaction staging 目录。宿主在 staging
中完成 manifest、包树、兼容性与试激活校验，成功后才以 rename 原子切换目标版本和
`plugin-state.json` 的 `activeVersion`。上一版本在新版本正式激活前不得删除；正式激活
失败时必须恢复目录、active version 和上一运行实例。`plugin-state.json` 由单写队列持久化，
每个 snapshot 使用同目录 temp + file fsync + atomic rename，并在替换 primary 前写好 `.bak`。
primary 损坏时从 backup 恢复并向用户显示告警；两份都损坏时保留 `.corrupt` 证据并显示错误，
不得静默当作全新状态。

同一 `plugin id` 的 install/update、enable、disable、uninstall 与 DSP 参数状态变更必须进入同一条
有界生命周期队列；卸载不得通过再次入队的 disable 造成自等待。JS 或 DSP 候选无论旧版本当前是否
启用，均须在 staging 中完成 activate/deactivate（DSP 须实际装入并移出 trial chain）后才能提交。
纯 theme 候选只允许 manifest 与包内 stylesheet 的静态校验，绝不执行脚本。

### 2.1 插件源码仓库边界

- Twilight Echo 主项目仓库不保存第三方插件源码、测试或第三方插件专属 `.tep` 发布包。
- 主项目只保存宿主能力、插件 API / tooling、内置基础插件和应用内插件市场客户端。
- 第三方插件源码统一写入独立插件仓库：
  - GitHub：`https://github.com/asenyarzc-cpu/Twilight-Echo-plugins/`
  - 本地：`D:\Twilight-Echo-plugins`
- 新增第三方插件时，源码放在 `D:\Twilight-Echo-plugins\plugins\<plugin-name>\`，
  打包产物放在 `D:\Twilight-Echo-plugins\packages\`，索引写入
  `D:\Twilight-Echo-plugins\plugins.json`。
- 主项目通过 `TWILIGHT_PLUGIN_INDEX_URL` 指向 GitHub raw `plugins.json` 或未来自托管
  HTTPS `plugins.json` 来消费第三方插件。

## 3. API 版本与兼容性承诺

- 插件 API 独立于应用版本，使用 `apiVersion` 主版本号（1, 2, …）。
- **主版本内只加不改不删**；废弃 API 须先标记 deprecated 并保留至少一个主版本。
- 宿主升级时按 `engines.twilightEcho` 做兼容检查；不兼容插件标记为禁用而非崩溃。
- DSP C ABI 使用独立版本号 `tae_plugin_abi_version`；ABI 结构体只允许尾部追加字段。
- 官方发布纯类型包 `@twilight-echo/plugin-api`（npm），作为 API 的唯一权威 typings。

## 4. JS 插件运行模型

### 4.1 进程模型

- 所有 JS 插件默认运行在独立的插件宿主进程（Electron `utilityProcess`）中，通过 IPC 与主进程 API 网关通信。
- 目的是**崩溃隔离与可观测性**（信任式安装下不承诺安全沙箱）：插件死循环、内存泄漏、崩溃不得拖垮主进程与音频链路。
- UI 插件的渲染部分在 renderer 注入，业务逻辑仍在宿主进程；渲染入口只能拿到受限桥接对象。

### 4.2 生命周期

- `activate(context)`：插件被启用或应用启动时调用。
- `deactivate()`：插件被禁用、卸载或应用退出时调用，须释放全部资源。
- `context` 注入内容：版本化 `twilight` API 句柄、插件私有存储目录路径、设置读写接口、日志器。
- `dependencies` 仅声明宿主内已安装插件之间的依赖关系；宿主不会自动安装或自动启用依赖。依赖缺失、版本不满足、未启用或循环依赖时，依赖方标记为失败并写入插件日志。

### 4.3 API 网关

- 插件**不得**直接 import 宿主内部模块、Electron API 或 Node 内置模块之外的宿主实现细节。
- 宿主能力一律经由 `twilight` API 对象访问；网关层是未来收紧权限的执法点。

Provider 方法和 UI command handler 的最后一个参数是宿主追加的 request context；这是 API v1
的向后兼容追加，旧 handler 可以忽略。context 的 `signal: AbortSignal` 会在超时、停用、卸载、
宿主 error/exit 或应用退出时 abort。Provider 的 `likeTrack`、`followArtist`、`followUser` 还会收到
`idempotencyKey`；插件必须把它传给上游幂等接口，或在本地按 key 去重，不能把它当作展示数据。

主进程与 plugin host 的 request/response 协议包含显式 `cancel`。取消或超时后，request id 进入
有界 quarantine，迟到结果不得再改变 caller 状态或健康统计。默认每个插件最多并发 4 个 RPC、
排队 32 个；连续 3 次远端失败/active timeout 后打开 circuit，退避从 1 秒指数增长到最多 30 秒，
半开时只允许一个 recovery probe。写操作的同一逻辑重试必须复用同一 idempotency key；renderer
bridge 会在失败后保留该 key，payload 改变或上一次调用成功后才生成新 key。

### 4.4 扩展点清单（首批）

| 扩展点          | 类型     | 能力                                                     |
| --------------- | -------- | -------------------------------------------------------- |
| `MediaProvider` | provider | 搜索、播放 URL/流、歌词、封面、歌单、登录态（可选实现）  |
| 事件总线        | tool     | 订阅曲目切换、播放/暂停、进度、队列变更、应用启停        |
| 侧边栏页面      | ui       | 插件提供自定义页面渲染入口                               |
| PlayerBar 按钮  | ui       | 附加操作按钮                                             |
| 设置页配置区    | ui       | 插件自有设置界面                                         |
| 主题            | theme    | CSS 变量、样式表与宿主托管布局；**仅声明式，不执行脚本** |
| DSP 节点        | dsp      | 挂入引擎 DSP 链（见第 5 节）                             |

Phase 3 的受控 UI 注入只渲染宿主批准的 DTO：`sidebarPage`、`playerBarButton`
和 `settingsPanel` 均通过 command 回到插件宿主进程执行业务逻辑，不向插件开放
任意 DOM 权限。主题插件由用户在外观设置中显式选择后生效；宿主一次只应用一个
插件主题，且 stylesheet 必须位于插件包目录内。

`contributes.themes[]` 在 API v1 内可选增加 `structured` 字段：`schemaVersion: 1`，
`variants.pureWhite/dark.tokens` 使用宿主登记的稳定主题令牌 ID，并可声明受控的
`windowDefaults`。原有 `variables + stylesheet` 字段不改名、不撤回；结构化字段只覆盖
登记令牌，stylesheet 仍是可使用自定义选择器的高级兼容路径，但不承诺跨版本布局兼容。

插件 API v2 允许 `structured.schemaVersion: 2` 在上述字段之外追加 `modes`。每个 mode ID、
值与可见性槽必须来自宿主注册表；未知 ID 或值独立忽略，写入所属插件日志，并作为 Theme
Studio 兼容提示返回。API v1 不接受 schemaVersion 2，不能通过回填字段改变已冻结的 v1
语义。API v2 仍接受 schemaVersion 1，`variables + stylesheet` 也继续兼容。完整机器可读目录
随 `@twilight-echo/plugin-api` 的 `theme-contract.json` 分发。

插件 API v3 允许 `structured.schemaVersion: 3` 追加 `layout`。`layout.desktop`（必填）及可选
`layout.compact` 使用宿主登记的 `titleBar`、`navigation`、`content`、`playerBar` 区域重排主窗口；
`titleBar` 和 `content` 必须存在，其他区域可用 `.` 省略。网格的每个区域必须为矩形，轨道仅可使用
`auto`、`content`、`narrow`、`standard`、`wide`、`fill`、`double`，从而由宿主生成 CSS Grid，不能注入
任意 CSS/DOM。`navigation` 仅支持 `toggle`、`persistent`、`hidden`。API v1/v2 不接受
schemaVersion 3；API v3 继续接受 schemaVersion 1/2 和 `variables + stylesheet`。布局只重排现有宿主
组件，不开放 Vue 组件注入、任意 DOM、Electron、Node、播放、DSP 或队列访问。

### 4.5 多音源数据模型

- 曲目 ID 必须带 provider 前缀（如 `ncm:12345`、`local:<hash>`）。
- 来源标识贯穿播放队列、音乐库与会话持久化。
- 流媒体主页与“发现歌单”是 provider 无关的共享界面。宿主从插件注册时实际提供的
  handler 派生 `supportedMethods`，只把实现了对应方法的音源放入页面切换器，不能仅凭
  `library` / `playlist` 这类宽泛 capability 推测实现情况。
- 主页只对显式声明 `ui.streamingSections[]` 且实际实现对应 method 的音源开放，
  按区块的 `id/title/icon/method/args` 加载推荐内容；仅为能力兼容而提供空实现的
  provider 不得进入主页音源列表。`fetchRecommendPlaylists` 作为已准入首页的可选歌单架。
  发现页以 `fetchDiscoveryPlaylists` 为准入条件，
  `fetchPlaylistCategories` 与 `fetchHighQualityPlaylists` 均为可选增强；缺失时对应分类或精品
  控件必须隐藏。用户切换音源后，旧 provider 的迟到响应不得覆盖新页面状态。
- 网易云音乐是 Twilight Echo 自带基础 `MediaProvider` 插件：插件 ID 为
  `com.twilightecho.provider.ncm`，provider 前缀固定为 `ncm`，随软件分发并默认启用；
  用户可停用以隔离故障或隐藏在线音源，但不可像第三方插件一样卸载。
- 第三方音源插件使用同一 Provider API。Bilibili 收藏夹音频插件作为外部插件仓库
  或私有插件索引分发，插件 ID 为 `com.twilightecho.provider.bilibili`，provider 前缀
  固定为 `bili`；仅在用户安装、启用并扫码登录后，流媒体 UI 才展示其视频收藏夹。
  该插件可通过 `getQrLogin()` 暴露 Web QR 登录，并可返回 `127.0.0.1` loopback 音频
  代理 URL 播放 DASH 音频，不下载或展示视频画面。

## 5. DSP 原生插件 C ABI 标准

### 5.1 接口形态

纯 C 接口，最小集合：

- `tae_plugin_get_info()` — 返回自描述信息（名称、版本、`tae_plugin_abi_version`、参数表）
- `create` / `destroy` — 实例生命周期
- `prepare(sampleRate, channels, format)` — 格式协商与资源准备
- `process(buffers, frames)` — 音频处理回调
- `set_param` / `reset` — 参数与状态控制

### 5.2 实时安全铁律（审核硬性项）

`process()` 内**禁止**：

1. 内存分配/释放
2. 加锁或任何可能阻塞的同步原语
3. 文件 / 网络 IO
4. 异常跨 ABI 边界传播（C++ 实现必须在边界内 catch 全部异常）

### 5.3 宿主侧防护

- 引擎对 `process()` 做耗时监控，连续超出预算自动 bypass 并经 `GetPlaybackInfo()` 诊断字段上报。
- 加载失败 / prepare 失败 / 运行异常一律自动 bypass，不中断播放。
- DSD / passthrough 路径下 DSP 插件自动 bypass（与 `outputPerfect` 语义一致）。
- Phase 4 的 ABI v1 仅支持 float32 interleaved PCM；宿主通过
  `TAE_SetDspPluginChain` 配置链路，通过 `TAE_GetDspPluginStatus` 和
  `PlaybackInfo.outputInfo.nativeDsp` 上报诊断。诊断字段包含加载状态、旁路原因、
  最近错误、处理耗时、超时次数与参数当前值。

### 5.4 参数体系

- 参数以 ID + 类型 + 范围 + 默认值在 `get_info` 中自描述；宿主据此自动生成设置 UI。

### 5.5 风险标注

- DSP 插件与 Twilight Audio Engine 同进程运行；生产宿主由可重启 Audio Engine
  Service 默认承载该引擎，避免原生 DSP 硬崩溃退出 Electron 主进程。`TWILIGHT_AUDIO_SERVICE=0`
  仅作为开发回退开关。管理 UI 必须单独分区并标注崩溃风险与服务重启行为。
- 纯 DSP 插件不启动 JS `utilityProcess`；混合插件的 JS 轨和 DSP 轨分别按各自规则运行。

## 6. 安全底线（信任式安装下的最低要求）

> 当前策略为信任式安装：插件即任意代码执行。签名和哈希只能证明来源与完整性，
> 不能证明代码安全。以下为不可省略的底线。

1. 安装时强制确认页：展示作者、权限、索引期望 SHA-256、最终 staged 包实际 SHA-256、索引实际来源与配置来源、远程/缓存/离线状态、获取与过期时间、签名状态、key ID、公钥 SHA-256 指纹，并明确警示插件可执行任意代码且拥有与应用相同的权限。宿主在确认页前必须重算最终 staged bytes；实际值与索引期望不一致时直接拒绝，不能沿用下载阶段的 `checksumVerified`。
2. **禁止插件运行时从远程加载并执行代码**——全部可执行代码必须随包分发。此条写入生态规范，并作为官方索引收录条件。
3. 官方索引收录需人工审核 + 开源仓库可溯源；`verified: true` 只是索引发布者声明，不能单独触发官方徽章。非索引来源安装时给出额外警告。
4. manifest 预留 `signature` 字段，未来可平滑切换到签名校验而不破坏包格式。
5. 架构预留收紧路径：utilityProcess 宿主 + API 网关 + 强制权限声明已就位，未来启用强制权限只需在网关层加闸。

## 7. 质量与生态标准

### 7.1 官方维护义务

- API typings 包（`@twilight-echo/plugin-api`）
- 插件模板仓库（`create-twilight-plugin`，含 lint / test / 打包脚本）
- 每类插件至少一个官方示例

### 7.2 文档标准

- 每个扩展点须具备三件套：**概念说明 + 完整示例 + API 参考**。

### 7.3 宿主 CI 标准

- 插件 API 网关有契约测试，保证版本承诺（第 3 节）不被无意破坏。
- 网易云内置插件作为 Provider API 的回归基准。

### 7.4 官方索引收录标准

1. 开源且仓库可溯源
2. 有 README
3. 权限声明与实际行为一致
4. 通过基本冒烟测试
5. 不含运行时远程代码加载
6. 音源类插件自行承担合规责任；明显侵权源不予收录
7. entry 由当前有效、未吊销的可信发布者 Ed25519 key 签名

### 7.5 Phase 5 本地可发布生态形态

- `@twilight-echo/plugin-api` 是开发者侧权威 typings 包，API v1 与 v2 类型从这里导出；宿主内部实现可复用自身类型，但不得改变 v1 语义。
- `create-twilight-plugin` 提供 `init` 与 `pack`：模板覆盖 `tool`、`provider`、`ui-tool`、`theme`；`pack` 产物为 `.tep` zip，根目录必须包含 `plugin.json`。
- 官方索引为远程 `plugins.json`，当前 schemaVersion 固定为 `1`。索引 entry 复用 manifest 字段，并增加 `sourceUrl`、`checksumSha256`、`tags`、`verified` 与 `publisherSignature`。为兼容 API v1 保留 `verified`，但它严格表示“索引发布者声明已审核”，自定义索引、缓存索引和离线索引中的 `verified: true` 最多显示为“索引声明”。
- `publisherSignature` 格式固定为 `{ schemaVersion: 1, algorithm: "ed25519", keyId, value }`，其中 `value` 是 canonical base64 编码的 64-byte Ed25519 签名。签名 payload 是 canonical JSON：`{ schemaVersion: 1, indexOrigin, entry }`；`entry` 包含规范化后的完整 manifest、`sourceUrl`、`checksumSha256`、`tags` 和 `verified`，只排除 `publisherSignature` 及宿主派生的 `verification` / `installState` / `installedVersion`。manifest 的 nested `main` / `icon` / `binary.*` 路径必须先按 POSIX `/` canonicalize，因此 Windows host 与 Linux signer 产生完全相同的 bytes。修改来源 URL、checksum、审核声明、路径或任一 manifest 字段都会使签名失效。
- “官方验证”徽章必须同时满足：索引来源精确等于固定 URL `https://raw.githubusercontent.com/asenyarzc-cpu/Twilight-Echo-plugins/main/plugins.json`；本次为 fresh、未发生 redirect 的远程直连加载；实际 origin 已绑定且与配置一致；记录未 stale、未过期；`verified: true`；签名由当前有效且未吊销的可信发布者 key 验证通过。`list`、`getIndexStatus` 与下载边界每次都按当前时间重新计算 `expiresAt` 与 key `notBefore` / `notAfter`，加载时的 official 结果不得永久缓存。任一条件缺失都降级为“发布者签名有效”“索引声明”或“未验证”。URL 前后缀、相似域名和任何 redirected response 均不等价。
- 可信发布者公钥注册表位于 `resources/plugin-index/trusted-publishers.json`，允许多个 active key、`notBefore` / `notAfter` 有效期、key 状态和集中 `revokedKeyIds`，用于无中断轮换与紧急吊销。未知状态、重复 key ID、无效 key 或损坏注册表必须 fail closed。生产私钥禁止进入应用仓库；签名在外部插件发布仓库的受保护 CI 或离线签名环境完成，应用仓库只发布公钥。当前注册表在正式 release key 配置前保持空，现有未签名条目不会获得官方徽章。
- 应用内市场默认读取上述固定 URL；`TWILIGHT_PLUGIN_INDEX_URL` 可覆盖为自托管 HTTPS `plugins.json` 或本机 HTTP 测试索引。远程成功后以 `cacheSchemaVersion: 1` envelope 缓存，强制持久化 `origin`、`fetchedAt`、`expiresAt` 与原始 `index`。远程失败时可回退缓存，但缓存一律标记 stale；过期状态按持久化时间计算，envelope 自带的任何“可信”布尔值均被忽略，`originVerified` 只由持久化 origin 与当前配置精确相等推导。旧版裸 `plugins.json` cache 作为 `legacy` 读取时同时标记 stale、expired、origin unverified，永不升级信任。
- `resources/plugin-index/plugins.json` 是随应用分发的离线发现快照，不是官方审核或签名信任根；远程与缓存都不可用时才用于发现，任何字段都不能触发官方徽章。安装前仍必须校验 sourceUrl、包大小、sha256 与包内 manifest；manager 对最终私有 staging 包再次计算 SHA-256 并与索引期望比较，防止下载校验后包被替换。
- 并发索引刷新使用单调 generation：只有最新请求可以写入 cache envelope 或提交内存中的 entry、origin、status 与 base URL，晚到的旧响应必须返回最新快照且不得回写磁盘。插件包下载开始时绑定索引 origin 与完整 entry（含 manifest、source URL、审核声明和发布者签名）的 canonical SHA-256 指纹；下载期间任一字段变化都必须拒绝，不能只比较包 checksum。
- 远程索引和 `.tep` 获取必须使用 `redirect: 'manual'`，最多跟随 5 跳；每一跳都重新校验 URL、协议、凭据和 HTTPS 不得降级为 HTTP。`Content-Length` 在读取 body 前预检，未知长度响应按 chunk 累计上限并在超限时 abort。`.tep` 必须逐块写入与插件安装目标同卷的 user-data staging 目录，同时增量计算 SHA-256；任何下载、写入、校验或重定向失败都清理部分临时文件。
- Phase 5 仍是信任式安装：索引只提高可发现性和完整性校验，不代表运行时权限 enforcement 或恶意代码沙箱。
