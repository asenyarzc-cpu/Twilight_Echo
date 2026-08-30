# 多协议网络音乐源施工文档（Network Music Sources）

> 关联 issue：[#20](https://github.com/asenyarzc-cpu/Twilight_Echo/issues/20)
> 状态：已合并到 `1.1.3`。本文档保留协议边界、限制和后续验证要求。
> 实施进度：M1–M6 已全部落地（WebDAV/FTP/FTPS/SFTP/SCP/SMB/DLNA 浏览、虚拟媒体库、元数据/封面、书签/缓存管理、统一搜索并入网络媒体库）；
> NFS 已实现（Linux `mount -t nfs`，运行时需 root）；系统命令类和 DLNA 仍需按 `docs/network-music-sources-verification.md` 做真机验证。

## 1. 目标与范围

### 1.1 目标

让用户可以把 NAS、远程服务器、家庭媒体服务器上的音乐作为音乐源直接浏览、入库、播放，而不需要手动下载或挂载到本地。

协议覆盖目标（按阶段拆分，见 §6）：

| 阶段 | 协议                         | 定位                                           |
| ---- | ---------------------------- | ---------------------------------------------- |
| P1   | WebDAV、FTP、FTPS、SFTP、SCP | 最容易落地，纯 JS / 现有栈可覆盖               |
| P2   | SMB/CIFS、NFS                | 局域网主流，需要原生库或系统挂载               |
| P3   | DLNA / UPnP                  | 独立浏览模型（ContentDirectory），不做成文件源 |
| 待定 | AFP                          | 建议走系统挂载，不内置协议栈                   |

### 1.2 非目标（本期）

- 不做网盘自动同步 / 双向同步。
- 不做远程转码 / 服务端队列（DLNA 只做浏览与直投）。
- 不做多客户端共享媒体库状态（仍是单机应用）。
- 密码托管第三方 Keychain/SecretService 之外的云端同步。

## 2. 现状分析（代码事实）

### 2.1 播放链路

- 渲染层 `usePlayerStore` 的 `loadAndPlay(track)` 是统一播放入口；`track.filePath` / `track.streamUrl` 是音频源，`filePath` 已支持 `http(s)://` URL（`usePlayerStore.ts` 中有 `^https?:\/\//` 判定分支）。
- 主进程音频引擎 `audioEngineManager.play(source: string, startTime)` 直接吃一个源字符串；`loadQueue` 支持队列预载（原生无缝）。
- 结论：**网络源不需要改播放内核**。接入方式二选一：
  a. 直接以可寻址 URL 作为 `filePath`（WebDAV/HTTP(S) 可行）；
  b. 下载到本地缓存后按本地文件播放（FTP/SFTP/SMB 等无 URL 播放能力的协议，统一走此路径）。

### 2.2 缓存体系

- `src/main/cache/musicCacheLayout.ts` 管理 `musicCachePath` 下的受管目录：`renderer-cache`、`audio-engine-cache`、`ncm-cache`、`cover-cache`。
- 流媒体已有「下载到缓存再播放」的先例（NCM），`streamingAudioCachePolicy` 有 `'off' | 'provider'`。
- 计划新增受管目录 `network-cache`，纳入现有的 `getManagedMusicCacheSize` / `clearManagedMusicCache` 统计与清理。

### 2.3 安全基础设施（可直接复用）

- `src/main/security/secureStorage.ts`：基于 Electron `safeStorage` 的加密字符串存储，用于保存凭据密文。
- `src/main/security/externalUrl.ts`：`isSafeExternalUrl` 做外部 URL 白名单校验。
- `src/main/security/remoteMediaGrants.ts`、`pathGrants.ts`：媒体路径/远程媒体授权。
- `installElectronSecurity`：全局安全加固入口。
- 网络请求一律在主进程发起（渲染层不直连内网地址），与现有远程控制/NCM 的边界保持一致。

### 2.4 设置持久化

- 设置快照走 `runtime.appSettings` + `createSettingsSnapshot`；持久化走 `versionedDataStore` / `jsonFile`。
- 网络源配置（profile 列表）应作为新设置域加入，但**凭据密文不入设置快照**（快照会发往渲染层）。

### 2.5 UI 现状

- 本地库、流媒体页、远程控制、插件 provider 体系（`useMediaProviders`）都是独立模块。网络源建议做成新的「网络音乐源」页面/入口，而不是塞进现有本地库扫描体系。

## 3. 总体架构

### 3.1 分层

```text
渲染层
  NetworkSourcesPage.vue / NetworkSourceWizard.vue / NetworkSourceTree.vue
        │  window.api.networkSources.*（preload 白名单桥接）
        ▼
主进程
  src/main/network/
    sourcesManager.ts        // 生命周期：profile CRUD、连接池、并发限制、事件广播
    profileStore.ts          // 配置持久化（密文走 secureStorage）
    adapters/
      webdavAdapter.ts       // P1
      ftpAdapter.ts          // P1
      sftpAdapter.ts         // P1
      smbAdapter.ts          // P2（原生库）
      nfsAdapter.ts          // P2（原生库）
      dlnaAdapter.ts         // P3（UPnP ContentDirectory）
    cache.ts                 // 下载到 network-cache + 目录/元数据缓存
    security.ts              // URL/scheme/path 校验、日志脱敏
```

### 3.2 核心概念

- **Source Profile（连接配置）**：一个协议 + 地址 + 端口 + 凭据引用 + 根路径 + 显示名 + 书签。
- **Adapter（协议适配器）**：统一接口，屏蔽协议差异。
- **Entry（条目）**：目录或文件，具备稳定 id（协议 + profile + 规范化路径哈希）。
- **Playback Plan**：把 Entry 解析成「本地缓存文件」或「可播放 URL」。

### 3.3 数据流

```text
浏览：Profile → Adapter.list(remotePath) → Entry[] →（可选）目录缓存 → 渲染层树形展示
播放：Entry(文件) → Adapter.resolvePlayback(entry)
      → 若协议支持 URL 播放：返回 URL（WebDAV）
      → 否则：下载到 network-cache → 返回本地路径
      → 组 Track（filePath/streamUrl + 元数据）→ loadAndPlay / loadQueue
入库：Entry(目录) → 递归 list + 元数据探测 → 生成「网络源」曲目列表（虚拟库，不拷贝文件）
```

## 4. 核心接口设计（先行约定）

### 4.1 类型

```ts
export type NetworkProtocol = 'webdav' | 'ftp' | 'ftps' | 'sftp' | 'scp' | 'smb' | 'nfs' | 'dlna'

export interface NetworkCredentialRef {
  kind: 'anonymous' | 'password' | 'privateKey'
  // 真实凭据不落 settings 快照；只存密文 id，见 §7
  encryptedId: string
}

export interface NetworkSourceProfile {
  id: string
  protocol: NetworkProtocol
  name: string
  host: string
  port?: number
  rootPath: string
  credential: NetworkCredentialRef
  options: {
    readOnly: boolean
    connectTimeoutMs: number
    transferTimeoutMs: number
    maxConcurrentTransfers: number
  }
  bookmarks: string[] // 常用目录（规范化远程路径）
  createdAt: number
  lastConnectedAt: number | null
}

export interface NetworkEntry {
  id: string // sha256(protocol + profileId + normalizedPath)
  profileId: string
  name: string
  kind: 'directory' | 'file' | 'audio' | 'playlist'
  path: string // 协议内规范化路径，如 /music/album/
  sizeBytes?: number
  mtimeMs?: number
  mimeType?: string
}

export interface NetworkPlaybackPlan {
  kind: 'local-cache' | 'direct-url'
  url?: string // direct-url：webdav 等
  cacheFilePath?: string
  displayName: string
}
```

### 4.2 Adapter 接口

```ts
export interface NetworkSourceAdapter {
  protocol: NetworkProtocol
  connect(profile: NetworkSourceProfile): Promise<NetworkSourceSession>
  list(session, remotePath): Promise<NetworkEntry[]>
  stat(session, remotePath): Promise<NetworkEntry | null>
  readStream(session, entry): Promise<NodeJS.ReadableStream>
  resolvePlayback(session, entry): Promise<NetworkPlaybackPlan>
  close(session): Promise<void>
}
```

约定：

- 所有方法必须可取消（AbortSignal），渲染层销毁页面时终止在途请求。
- `list` 单次返回量限制（默认 1000 条）+ 分页/续列，防止大目录卡死 UI。
- 路径统一以 `/` 拼接，`normalizeRemotePath` 负责清洗（去 `..`、空段、URL 编码）。
- 失败以结构化错误返回（`{ code: 'auth' | 'timeout' | 'network' | 'notFound' | 'denied', message }`），渲染层只展示 code 对应的本地化文案，**message 不得回显凭据**。

### 4.3 IPC 契约（preload 白名单）

```ts
// window.api.networkSources
listProfiles(): Promise<NetworkSourceProfileSummary[]>
createProfile(input: NetworkSourceProfileInput): Promise<NetworkSourceProfileSummary>
updateProfile(id, patch): Promise<NetworkSourceProfileSummary>
deleteProfile(id): Promise<void>
testConnection(id): Promise<{ ok: boolean; latencyMs?: number; errorCode?: string }>
listDirectory(id, remotePath, signal?): Promise<NetworkEntry[]>
resolvePlayback(id, entryId): Promise<NetworkPlaybackPlan>
addToLibrary(id, dirPath): Promise<{ addedTracks: number }>
refreshCache(id, remotePath): Promise<void>
onSourceEvent(cb): Unsubscribe // profile 增删 / 连接状态 / 传输进度
```

新增 IPC 一律走 `src/preload/index.ts` 白名单桥接，并同步 `src/preload/index.d.ts` / `src/preload/types.ts`（与现有 `player:shortcut` 等模式一致）。

## 5. UI 设计

### 5.1 入口

- 主导航（流媒体页同级的）新增「网络源」页；或作为本地库页的 tab。
- 设置页新增「网络源」分区：profile 管理、连接测试、书签、缓存占用与清理。

### 5.2 关键界面

1. **连接向导**：协议选择 → 地址/端口/根路径/凭据 → 连接测试 → 命名保存。SMB/NFS 提供常见路径提示（`//host/share`、`/export/music`）。
2. **目录浏览树**：异步展开、面包屑、列排序（名称/大小/修改时间）、搜索过滤当前目录；文件行内「播放」「加入队列」「加入媒体库」。
3. **连接状态反馈**：顶部状态条（已连接/连接中/失败 + 重试），传输进度条（下载到缓存时）。
4. **书签**：常用目录收藏，侧栏快速切换。
5. **只读提示**：凭据仅用于读取时，UI 上禁用所有写操作（见 §8 安全）。

## 6. 分阶段实施计划

### P1：WebDAV + FTP(S) + SFTP/SCP

**目标**：跑通「浏览 → 播放 → 入库」完整链路，覆盖 issue 中最常见的远程场景。

| 任务                | 说明                                                                          | 依赖                                                                       |
| ------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1. 骨架与类型       | `sourcesManager` / `profileStore` / IPC / 设置域                              | 无                                                                         |
| 2. WebDAV adapter   | PROPFIND 列目录、HEAD/GET 播放、PUT 不做；纯 Node `http/https`，零新依赖      | 无                                                                         |
| 3. FTP/FTPS adapter | `basic-ftp`（纯 JS、被动模式、TLS）                                           | 新增依赖                                                                   |
| 4. SFTP/SCP adapter | 系统 OpenSSH `sftp` 命令（`ssh2` 因 cpu-features 原生编译问题不可用，见 §10） | ✅ 已实现（仅密钥认证；带口令私钥需 ssh-agent / 无口令密钥；真机验证待做） |
| 5. 下载缓存         | `network-cache` 目录 + 并发限制 + 断点续传（Range/REST）                      | ✅ 任务 2-4                                                                |
| 6. 虚拟媒体库       | 目录递归入库、元数据（标签）探测、封面复用现有 `cover-cache`                  | 任务 5                                                                     |
| 7. UI               | 向导 + 浏览树 + 播放/入库 + 状态条                                            | 任务 1                                                                     |
| 8. 测试             | 单元 + 本地测试服务器集成（见 §9）                                            | 全部                                                                       |

**验收标准（P1）**：

- 三种协议均可：连接测试、列目录、单曲播放、多曲加入队列、目录入库并可从本地库页播放。
- 断网/错误凭据/超时给出可理解的错误提示，UI 不卡死。
- 凭据在磁盘为密文；日志中不出现明文密码与 URL 凭据段。

### P2：SMB/CIFS + NFS

**方案选项**（实现前需决策，见 §10）：

- A. 原生库：`libsmbclient` / `libnfs`，通过 N-API 封装（仓库已有 `audio-engine` 原生构建管线，可复用 CI/打包基础设施）。
- B. 依赖系统挂载：调用 `mount`/`net use` 把共享挂到本地临时目录，然后走本地文件逻辑（实现最快，但需要挂载权限、卸载清理、跨平台差异大）。

**推荐**：先做 B（Linux `mount -t cifs/nfs` + Windows `net use`）作为 P2a 快速验证价值，再评估 A 的打包成本决定是否替换。DLNA 直投（P3）与 SMB 无冲突。

### P3：DLNA / UPnP

- 独立于文件源：`dlnaAdapter` 实现 SSDP 发现 + ContentDirectory 浏览（`libupnp` 或纯 JS `node-ssdp` + SOAP 调用）。
- 播放走「发现 → 选择 → 直投到播放器/投屏」而非下载：播放计划 `kind: 'direct-url'`，URL 由 DLNA 服务器提供。
- 与现有 DLNA 投送（`castBackend`）合并使用同一设备发现/展示链路。

### AFP

- 不做内置协议栈。文档与 UI 提示「AFP 共享请通过系统挂载后以本地目录方式添加」。

## 7. 数据与持久化

### 7.1 设置扩展

```ts
// src/main/core/types.ts（AppSettings 新增）
networkSources: {
  profiles: NetworkSourceProfile[]      // 不含凭据明文
  directoryCacheTtlMs: number           // 默认 5 * 60_000
  maxDownloadConcurrency: number        // 默认 2
}
```

### 7.2 凭据存储

- 复用 `secureStorage`：`encryptString` 得到密文，存 `profile.credential.encryptedId`。
- 密文与 profile 分开存储（如 `userData/network-credentials.json`，仅主进程可读），settings 快照与备份导出**必须剔除**凭据域。
- 系统安全存储不可用时（如某些 Linux 环境 `safeStorage.isEncryptionAvailable() === false`）：拒绝保存口令类凭据，只允许匿名/密钥文件路径，并在 UI 提示。

### 7.3 缓存

- 新增受管目录 `network-cache`（纳入 `MANAGED_MUSIC_CACHE_DIRECTORY_NAMES`）。
- 缓存键：`sha256(profileId + normalizedPath + mtimeMs)`，避免同名文件复用脏缓存。
- 目录列表缓存放内存（TTL 可配），不落盘；元数据缓存（标签）落 `network-cache/metadata`。

## 8. 安全设计

1. **凭据**：见 §7.2；渲染层永远拿不到明文；IPC 入参校验（`validateProfileInput`）。
2. **URL 与路径**：
   - 所有远程 URL 必须通过 `isSafeExternalUrl` 类白名单（scheme ∈ http/https/ftp/ftps/smb/nfs/ssh 按协议）。
   - 远程路径统一 `normalizeRemotePath`：拒绝 `..`、空段、控制字符、超长路径。
   - 下载目标文件名用缓存键（哈希）命名，绝不用远程文件名直接拼本地路径（防路径穿越）。
3. **SSRF 防护**：网络请求仅主进程发起；用户配置的 host 不做内网/公网限制（内网正是主要场景），但：
   - 拒绝常见元数据地址（169.254.169.254 等）与回环地址除非用户显式确认；
   - DNS 解析后校验目标 IP 是否命中保留段，命中则需二次确认。
4. **只读**：P1 全部只读（无上传/删除/重命名）。UI 与 adapter 双层强制。
5. **日志脱敏**：统一 `redactProfile(profile)`（隐藏 password/privateKey/URL 用户信息段）后再打日志。
6. **会话清理**：连接池空闲超时关闭；退出应用时主动 close 所有 session，内存中不残留明文口令。
7. **传输**：FTP 默认要求 `ftps`（显式 TLS）；`ftp` 明文仅在用户勾选「信任网络」时允许，默认拦截。

## 9. 测试与验收

### 9.1 单元测试

- `normalizeRemotePath`、缓存键、profile 校验/脱敏、URL 白名单、错误码映射。
- `profileStore` 增删改查 + 密文隔离（settings 快照不含凭据）。
- 下载缓存：并发限制、Range 续传、脏缓存驱逐。

### 9.2 集成测试（本地测试服务器，进 CI）

- WebDAV：Node 起一个只读 HTTP server（PROPFIND/GET），无需外部依赖。
- FTP/FTPS：`pyftpdlib` 或容器内 `vsftpd`；SFTP：进程内 `ssh2` 起临时服务。
- SMB/NFS（P2 起）：Linux CI runner 用本地 `samba`/`nfs-kernel-server` 容器；Windows runner 用共享目录 + `net use`。

### 9.3 手工验收清单

- [ ] 三种协议：连接测试 / 浏览 / 播放 / 队列 / 入库
- [ ] 错误路径：错误密码、超时、目录不存在、断网中重试
- [ ] 大目录（>1000 项）不卡 UI、可滚动加载
- [ ] 凭据密文：磁盘文件不可读明文；导出备份不含凭据
- [ ] 缓存清理：设置页「清空网络源缓存」生效且统计正确
- [ ] 播放期间断开连接：已缓存曲目可继续播；未缓存曲目给出明确错误

## 10. 风险与待决策

| 问题                   | 选项                                          | 影响                                                                                            |
| ---------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| SFTP/SCP 实现路线      | ✅ 已选：系统 OpenSSH `sftp` 命令（密钥认证） | `ssh2` 因 cpu-features 原生编译问题不可用（已实测）；系统 sftp 仅支持密钥认证，口令需 ssh-agent |
| SMB/NFS 实现路线       | A 原生库 / B 系统挂载                         | 打包体积、跨平台维护成本、权限                                                                  |
| 播放体验               | 全部「下载后播」 vs WebDAV「直连 URL 播」     | 首播延迟、seek 支持、缓存占用                                                                   |
| 网络源入库后的曲目身份 | 哈希路径是否稳定（重命名/重挂载）             | 收藏/队列/历史持久性                                                                            |
| 凭据不可用环境         | 拒绝保存 vs 弱加密降级                        | 安全边界 vs 可用性                                                                              |
| DLNA 是否入 P1         | 与投送合并做 vs 独立排期                      | 工作量                                                                                          |
| 代理                   | 网络源请求是否跟随现有代理设置                | 企业内网场景                                                                                    |

## 11. 里程碑建议

| 里程碑 | 内容                                   | 预估工作量（人日，粗估）                                                                                      |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| M1     | P1 骨架 + WebDAV 全链路                | 3–5                                                                                                           |
| M2     | FTP/FTPS + SFTP/SCP adapter + 下载缓存 | 3–5                                                                                                           |
| M3     | 虚拟媒体库（递归入库/元数据/封面）     | 3–4（✅ 已实现：标签/封面解析在媒体库视图手动触发）                                                           |
| M4     | UI 完善 + 书签 + 缓存管理 + 手工验收   | 2–3（✅ 已实现：书签/缓存统计与清理/媒体库时长与封面展示）                                                    |
| M5     | P2 SMB/NFS（先系统挂载方案）           | 3–6（✅ 已实现：SMB = Windows `net use` / Linux `gio mount` 匿名；NFS = Linux `mount -t nfs`，运行时需 root） |
| M6     | P3 DLNA 浏览/直投                      | 3–5（✅ 浏览已实现：ContentDirectory Browse + res 直连播放；投送到渲染器复用现有 castBackend）                |

每完成一个里程碑独立发 PR，沿用仓库现有 review 流程；M1 可作为 issue #20 的第一阶段回复。

## 附录：可参考的现有模块

- 播放入口：`src/renderer/src/stores/usePlayerStore.ts`（`loadAndPlay` / `loadQueue`）
- 缓存布局：`src/main/cache/musicCacheLayout.ts`、`src/main/cache/ncmCache.ts`
- 安全：`src/main/security/secureStorage.ts`、`externalUrl.ts`、`remoteMediaGrants.ts`、`pathGrants.ts`
- 设置：`src/main/core/settings.ts`、`src/main/core/types.ts`、`src/renderer/src/stores/useSettingsStore.ts`
- 投送/DLNA：`src/main/remote/castBackend.ts`
- Provider 体系（作为参考而非直接复用）：`src/renderer/src/providers/`
