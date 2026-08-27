# Twilight Echo 审查文档：安全漏洞 / UI 阴影与错位 / 交互逻辑

> 审查日期：2026-08-01
> 基线：`main@75814db`（工作树干净）
> 方式：静态代码审查（未运行 GUI 实测；阴影/错位结论以 CSS 结构证据为主，最终需以截图复核）
> 目的：先产出问题清单与修复建议，**供你审阅后再执行**。

---

## 0. 摘要（TL;DR）

- **安全面**：整体基线很扎实（IPC 发送方校验、路径授权、CSP、沙箱窗口、插件包校验、更新包 SHA-256 校验等已具备）。应用层静态审查未发现可直接利用的**高危**漏洞；发现 1 个值得修的**中低危**问题（NCM 登录 Cookie 落盘残留）和若干低危/加固项。**外部工具提示的“严重 CVE”已核实为 Electron 的 CVE-2026-5858（Chromium WebML 堆缓冲区溢出，Chromium 定级 Critical）**：项目锁定的 `electron@39.8.9` 落在受影响区间 39.0.0–39.8.9，官方修复版本 39.8.10，且 39.x 已 EOL，**建议升级 Electron（见 S7）**。npm audit 仅 2 条 low（body-parser CVE-2026-12590，见 S8）。
- **UI 面**：最明显的问题是**歌单行（正在播放 / hover）被永久/临时位移 + 放大 + 大范围阴影**，造成行与网格错位、阴影溢出到相邻行；另有封面列写死 `translateX(32px)`、HiFi 侧栏小卡片阴影过载、`!important` 覆盖链过深、阴影色系不统一等问题。
- **交互面**：**音量图标点击打开抽屉而非静音**（静音功能在 store 中存在但没有 UI 入口）、滚轮悬停即改音量、关闭窗口可能被“保存失败”对话框循环卡住等。

---

## 1. 审查范围与方法

| 面   | 覆盖内容                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------- |
| 安全 | 主进程窗口配置、IPC 校验、路径授权、远程控制 HTTP 服务、NCM 登录/API、插件系统、更新流程、CSP、密钥存储、zip 包校验 |
| UI   | 全部 `.vue`/`.css` 中 `box-shadow`、`transform`、`position`、`z-index`、`!important` 使用                           |
| 交互 | 导航/快捷键逻辑、播放栏抽屉、音量、歌单选择、关闭窗口持久化、引导流程                                               |

---

## 2. 安全性审查

### 2.1 已确认的安全基线（无需改动，记录备查）

- 窗口全部 `sandbox + contextIsolation + nodeIntegration:false`（`src/main/app/window.ts:138`、desktopLyrics/miniPlayer/trayPlayer/NCM 登录窗均一致）。
- 所有 IPC 入口有 `assertTrustedIpcSender`（`src/main/security/electronSecurity.ts`）+ 参数规范化（`ipcValidation.ts`）。
- 文件类操作走 `CanonicalPathGrantSet`（`src/main/security/pathGrants.ts`，realpath 规范化 + 授权根目录白名单）。
- 远程媒体代理拒绝私有/环回地址（`remoteMediaGrants.ts`、`ncmCache.ts` 的 `isSafeRemoteMediaUrl`），防 SSRF。
- 远程控制 PIN 6 位 + 8 次/5 分钟限速 + 192-bit 随机 token（`src/shared/remoteControl.ts:7-13`）。
- 插件 zip 包有大小/数量/路径越界/符号链接校验（`src/main/plugins/packageSecurity.ts`），主题包同样有 zip 校验（`src/main/themes/themeArchiveValidation.ts`）。
- 敏感项（NCM cookie 等）经 Electron safeStorage / AES-256-GCM 机器绑定加密（`src/main/security/secureStorage.ts`）。
- 更新包下载后 SHA-256 校验，不匹配即删除（`src/main/app/appUpdateService.ts`）。
- CSP 严格（`default-src 'none'`、`script-src 'self'`），并对 `http(s)` 外部跳转做了协议白名单。

### 2.2 发现的问题

#### S1【中低】NCM 官方登录 Cookie 持久化落盘残留

- **位置**：`src/main/ncm/api.ts:99-101, 128-146`
- **现象**：登录窗口使用 `session.fromPartition('persist:twilight-ncm-login-' + Date.now())`，启动时 `clearStorageData()` 只调用一次；成功收集到 `MUSIC_U/__csrf` 等 Cookie（`finish()`）或失败/超时（`fail()`）后**不再清理**。该 partition 是 `persist:` 持久分区，Cookie 会以明文 Chromium 存储留在 `userData` 下；每次登录还会留下一个孤儿分区目录。
- **影响**：网易云账号 Cookie（可代表用户访问账号 API）在磁盘上残留明文副本；本地有读权限的进程可窃取；多次登录积累垃圾目录。
- **建议**：去掉 `persist:` 前缀改用内存分区（同一登录窗口会话内 Cookie 仍然可用），或在 `finish()`/`fail()`/窗口关闭时 `await ses.clearStorageData()` 并删除分区目录。

#### S2【低】远程控制 HTTP 服务：CORS `*` + `0.0.0.0` 绑定

- **位置**：`src/main/remote/httpServer.ts:123, 592-598`
- **现象**：服务监听 `0.0.0.0`，`corsHeaders()` 返回 `access-control-allow-origin: *`；`/media/{token}` 与 `/api/*` 均带该头。
- **影响**：局域网内任意网页/设备可发起跨源请求。配对有 PIN+限速、命令有 Bearer token，`/media/{token}` 为 144-bit 随机 token 且 2h 过期，实际被利用难度高；但 CORS 放开使得浏览器侧探测成本为零。
- **建议**：`/media/{token}` 去掉 `Access-Control-Allow-Origin`（DLNA/Chromecast 为原生请求，不需要 CORS）；配对/命令接口改为仅响应远程 UI 同源（或无 Origin 请求）。

#### S3【低】SSE 连接无上限（局域网资源耗尽面）

- **位置**：`src/main/remote/httpServer.ts:375-384`
- **现象**：`attachSse` 无限向 `this.sseClients` 集合添加连接，无 per-IP/全局上限；已配对客户端可开大量 `/api/events` 长连接。
- **建议**：设置上限（如 ≤8 条），超出直接 429 关闭；广播失败时及时剔除（已有）。

#### S4【低】`shell:openExternal` 允许任意 `http://` 协议

- **位置**：`src/main/ipc/shellIpc.ts:46-49`、`src/main/app/window.ts:173-186`、`src/main/ncm/api.ts:243-247`
- **现象**：外部跳转白名单同时放行 `http:` 与 `https:`。当前 renderer 均为第一方代码，风险低；但属纵深防御缺口（任何未来的渲染层注入/插件缺陷都可能把用户带到任意站点）。
- **建议**：默认仅放行 `https:`；`http:` 仅用于明确的本地/开发场景，并做域名白名单。

#### S5【低】更新包完整性校验仅依赖同一 GitHub 来源的哈希

- **位置**：`src/main/app/appUpdateService.ts`（`resolveChecksum` / 安装前校验）
- **现象**：SHA-256 校验和来自同一个 GitHub Release（asset digest / release body / 校验和文件），与安装包同源同信任链。
- **影响**：MITM 无法绕过（均为 HTTPS）；风险仅存在于 GitHub 账号被攻破/发布被篡改的场景。
- **建议**：下载后可选校验 Windows Authenticode 签名与发布者（NSIS 安装包若签名）；不做硬性阻断。

#### S6【信息】依赖与运行时

- `electron: ^39.2.6`、`electron-builder: ^26.0.12`（`package.json:151-153`），lockfile 已固定；仓库已有 `pnpm audit --prod` 门禁与 `verify-production-dependency-audit` 测试。
- **建议**：保持 CI/发布门禁持续运行；无需本次改动。

#### S7【高】Electron 39.8.9 受 CVE-2026-5858 影响（Chromium WebML 堆缓冲区溢出）

- **来源核实（2026-08-01）**：GPT-5.6 提示的“严重 CVE”经查证即 **CVE-2026-5858**（Chromium WebML heap buffer overflow，Chrome 修复于 147.0.7727.55，Chromium 官方定级 **Critical**）。
  - 参考：<https://avd.aquasec.com/nvd/2026/cve-2026-5858/>、<https://security-tracker.debian.org/tracker/CVE-2026-5858>
- **影响面**：项目锁定 `electron@39.8.9`（`pnpm-lock.yaml:4775`，`package.json:151` 为 `^39.2.6`），落在受影响区间 **39.0.0 – 39.8.9**；第三方情报 AIKIDO-2026-10763 标记 **High**，官方修复版本 **39.8.10**。
  - 参考：<https://intel.aikido.dev/cve/AIKIDO-2026-10763>
  - Electron 官方 39.8.10 release notes（backported security fixes #51257，含 493319454 等上游 Chromium 安全修复；39.x 已 EOL 警告）：<https://releases.electronjs.org/release/v39.8.10>
- **利用前提**：需渲染远程/不可信页面（WebML）内容；本项目渲染层为本地包内容 + 远程媒体（封面/图片）与 NCM 网页登录，直接利用难度较高，但 Electron 39.x 已 EOL、不再收安全补丁，**长期不升级将累积不可修复的 Chromium 漏洞**。
- **修复建议**：
  1. `package.json` `"electron": "^39.2.6"` → `"^39.8.10"`（保守方案：锁文件解析到 39.8.10，含 CVE-2026-5858 与 #51272 修复；但 39.x 已 EOL，后续不再收安全补丁）；或
  2. **推荐直接升级到受支持的稳定线 41/42/43**（截至 2026-08-01 稳定版：43.2.0 / 42.8.0 / 41.10.3，39/40 均已 EOL；需回归 window/托盘/迷你窗/自定义协议等 API 变更）。
  3. 升级后注意 **#51272**：自 39.8.10 起，`supportFetchAPI: true` 但未设 `corsEnabled: true` 的自定义协议将拦截跨源 fetch/XHR。本项目 `twilight-audio` 协议当前**未设** `corsEnabled`（`src/main/app/lifecycle.ts:84-90`），但渲染层对 twilight-audio 仅以 `<audio>` media-src 使用、未发现跨源 fetch 调用；`cover:`/`twilight-media:`/`background:`/`theme-asset:` 均已设 `corsEnabled: true`，预期不破坏现有功能，仍建议升级后跑 `test:app` 回归。

#### S8【低】body-parser DoS（CVE-2026-12590，npm audit 2 条 low）

- `pnpm audit --prod`（2026-08-01，证据 `/tmp/pnpm-audit.json`）：仅 **2 条 low**，同源 **CVE-2026-12590**（body-parser `limit` 值不可解析时静默禁用请求体大小校验 → 超大请求体 DoS，CVSS 3.7）。
- 引入路径：`@neteasecloudmusicapienhanced/api@4.35.1` → `express` → `body-parser@2.2.2`；另一条经 `unblockmusic-utils → express → body-parser`（1.20.5）。
- 修复：body-parser ≥ 2.3.0（或 1.20.6）。做法二选一：`pnpm.overrides` 覆盖 body-parser，或升级 `@neteasecloudmusicapienhanced/api`。
- **注意**：该包有本地 patch `patches/@neteasecloudmusicapienhanced__api@4.35.1.patch`（`pnpm-workspace.yaml:18-19` patchedDependencies），升级大版本需重验/重打 patch。
- 实际影响低：本地 Express 仅用于远程控制/HTTP 服务，未见程序化传入不可解析 `limit`；属加固项。

#### S9【信息】已核实不受影响 / 已修复的 CVE

- **CVE-2026-34776**（Electron 第二实例 IPC 越界读写）：fixed 39.8.1；项目 39.8.9 已包含，不受影响。
- **CVE-2026-34767**（Electron HTTP 响应头注入）：fixed 39.8.3；39.8.9 已包含，不受影响。
- **CVE-2026-32256**（music-metadata ASF 无限循环）：fixed 11.12.3；锁文件实际引用 **11.13.0** 已修复（11.12.3 残留在 lockfile 但未被直接引用）。

---

## 3. UI 视觉审查：无意义边缘阴影与错位

> 整体观察：全库 `box-shadow` 出现约 **751 处**。其中弹层/封面等大元素阴影合理，但**密集列表行、小尺寸卡片**上的大范围软阴影 + 位移变换属于典型的“为好看而好看”噪音，并直接造成错位。

### U1【高】正在播放行常驻位移 + 放大 + 大阴影（歌单网格错位）

- **位置**：`src/renderer/src/components/song-list/SongList.css:1146-1147`（`.track-playing`），以及 `1907/1928`（选中+播放组合态）
- **现象**：
  ```css
  .track-playing {
    transform: translateX(2px) scale(1.026);
    box-shadow: 0 20px 48px rgba(124, 77, 255, 0.12);
    z-index: 4;
  }
  ```
  当前播放行**永久**右移 2px 并放大 2.6%，悬浮在其它行之上，并带 20px/48px 紫色大阴影。行本身还有 `transition: transform .24s`（`SongList.css:999-1005`），切歌时行会明显“跳动”。
- **影响**：表格行网格视觉错位（文字被放大、列线不再对齐），阴影盖住上下行文字；在数百行的歌单里是持续存在的视觉噪音。
- **建议**：播放行改为纯背景/左侧指示条/文字高亮，去掉 `transform` 与大阴影（或仅保留 `box-shadow` 收敛为 0-4px 微投影）。选中态同理。

### U2【中】行 hover 位移 + 大范围阴影（密集列表噪音）

- **位置**：`src/renderer/src/components/song-list/SongList.css:1078-1096`
- **现象**：
  ```css
  .track-row:hover {
    transform: translateX(2px) scale(1.012);
    box-shadow: 0 16px 38px rgba(86, 70, 160, 0.08);
    /* 外加两套动画渐变描边 ::before / ::after（hover-gradient-flow、pointer-border-pulse） */
  }
  ```
- **影响**：鼠标扫过密集行时每行都横向位移 2px + 阴影扩散 38px + 渐变描边动画，行与行互相“穿帮”，视觉抖动感强。这是“无意义边缘阴影”最集中的区域。
- **建议**：密集表格行 hover 只保留背景色 + 细描边（≤1px inset），去掉位移/缩放/大阴影/动画。

### U3【中】播放页封面列写死 `translateX(32px)`

- **位置**：`src/renderer/src/components/PlayingMusic.vue:833`
- **现象**：
  ```css
  .cover-column { ... transform: translateX(32px); }
  ```
  多列布局下封面整体右移 32px（`layout--single` 时虽 `transform: none`，但仅单列场景）。
- **影响**：当右侧歌词列宽度、`reserveLyricsColumn`、歌词对齐模式或窗口宽度变化时，封面列与整体视觉中心失配——写死的 32px 不具备响应式能力，容易出现“封面偏右/与左侧留白不对称”。
- **建议**：用对称 grid（左右 gap 一致）或 `padding-inline` 达成光学居中，移除魔法数字位移。

### U4【中】HiFi 侧栏小卡片阴影过载

- **位置**：`src/renderer/src/components/player-bar/PlayerBar.css:2298-2401`（`.hifi-meta` / `.hifi-quality-card` / `.hifi-toggle-card` 等）
- **现象**：大量 12px 内边距的小卡片**各自**带 `box-shadow: 0 10px 24px rgba(15,23,42,.04)`（玻璃态下变 `rgba(0,0,0,.16)`），且多数已有 `border: 1px solid var(--hifi-line)`。
- **影响**：并排的小卡片彼此叠影，形成“每个像素都在浮”的噪点；边框+阴影双重描边意义重复。
- **建议**：保留边框，小卡片阴影统一收敛为 `0 1px 2px` 或去掉；只有弹层/抽屉保留大阴影。

### U5【中】`!important` 覆盖链过深

- **位置**：`src/renderer/src/assets/base.css`（**118 处 `!important`**），另有 `SongList.css` 多处
- **现象**：大量 `box-shadow: none !important`、`background: transparent !important`、`border-bottom-color: transparent !important` 用于推翻前一条规则（多为主题差异/多布局特判）。
- **影响**：规则来源难以追踪，改动一个 token 会被 `!important` 静默压住，是阴影/边框“关不掉、改不动”类问题的温床（例如纯白主题需要写 10+ 条覆盖才能清掉默认玻璃感）。
- **建议**：将“主题变体”改为显式主题类/数据属性作用域，逐步替换 `!important`；新样式禁用 `!important`（eslint 可加 `declaration-property-value-disallowed-list`）。

### U6【低】阴影色系不统一（遗留色值 vs 令牌）

- **位置**：`base.css`（`rgba(15,23,42,…)`）、`SongList.css`（`rgba(86,70,160,…)`、`rgba(124,77,255,…)`）、`EqualizerPage.vue`（`rgba(99,102,241,…)`）、`StreamingDetailStage.css`（`rgba(28,25,23,…)`）、`PlayerBar.css`（`var(--hifi-glow)`、`var(--te-glass-shadow)`）混用
- **现象**：同一界面不同组件阴影使用不同色相/透明度来源，亮暗主题下观感不统一；令牌系统（`--te-*`、`--home-shadow`、`--hifi-glow`）已存在但未全覆盖。
- **建议**：以主题令牌为唯一阴影来源（`--te-shadow-*` / `--te-glass-shadow` 等），删除直接写死的 rgba 阴影。

---

## 4. 交互逻辑审查：反人类设计

### I1【高】音量图标点击打开抽屉，而不是静音/取消静音

- **位置**：`src/renderer/src/components/PlayerBar.vue:1415`（`@click="toggleVolume"` 打开抽屉）；静音能力存在但无 UI 入口——`src/renderer/src/stores/usePlayerStore.ts:691`（`toggleMute` 已实现并导出，但没有任何组件调用），迷你播放器/托盘播放器也无静音按钮。
- **现象**：用户点喇叭图标期望“静音/恢复”，实际弹出音量抽屉；想静音只能拖到 0。
- **影响**：违背音乐播放器最基础的肌肉记忆，也是 a11y 问题（键盘用户无静音入口）。
- **建议**：抽屉关闭时点击 = 切换静音；音量调整走抽屉内滑块 / 滚轮 / 右键菜单；或点击弹出抽屉 + 双击/长按静音并保证有可发现的静音入口。

### I2【中】滚轮悬停即改音量 + 弹抽屉

- **位置**：`src/renderer/src/components/PlayerBar.vue:442-449`（`onVolumeWheel`）
- **现象**：鼠标在音量按钮上滚轮，会**同时**弹出抽屉并修改音量（`event.deltaY` 每格 4%）。触控板滚动经过该区域时极易误触。
- **建议**：悬停展开抽屉（带延迟），滚轮只调音量、不弹抽屉；或滚轮调音量但抽屉保持关闭，点击才打开。

### I3【中】关闭窗口可能被“保存失败”对话框循环卡住

- **位置**：`src/main/app/window.ts:93`（按钮只有 `Retry close` / `Keep window open`）+ `src/main/app/closePersistence.ts:28-34`（`retry` 会无限循环重试）
- **现象**：若渲染层持久化持续失败（如磁盘满、渲染进程卡死），用户每次点 X 都会弹“无法保存”对话框，且没有“放弃更改并退出”选项。
- **影响**：数据安全考虑是好的，但用户被困住时没有逃生门；部分用户可能只能任务管理器强杀。
- **建议**：增加第三个按钮“仍然退出（放弃未保存更改）”（确认后置 `forceQuit` 直接退出）；或对连续失败次数（如 3 次）自动降级为“放弃保存并退出”。

### I4【低】菜单/设置快捷键在部分页面“死键”

- **位置**：`src/renderer/src/app/useAppNavigation.ts:302-316`
- **现象**：`createToggleMenuHandler` 在插件页直接 `return`（按键无任何反馈）；在设置页按下菜单键会**关闭设置**而不是打开菜单。
- **影响**：同一按键在不同页面行为不一致或无效，违背“按键有预期反馈”的直觉。
- **建议**：菜单键全局语义统一为“打开/收起侧边菜单”（设置页等全屏页可先退出再开菜单）；插件页按下时给出可见反馈。

---

## 5. 修复优先级与执行计划（待你审阅）

> 以下为建议执行顺序。**确认哪些做、哪些不做（或调整）后，我再逐项实施并附验证。**

| 编号 | 级别   | 建议动作                                                               | 涉及文件                                 | 验证方式                                                   |
| ---- | ------ | ---------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| S7   | **P1** | **升级 Electron 至 39.8.10（或直接升 40+/41+/42+）修复 CVE-2026-5858** | `package.json` → `pnpm install`          | `pnpm audit --prod` 确认无 high/critical + `test:app` 回归 |
| S1   | P1     | NCM 登录分区改内存 / 登录后清理 Cookie 落盘                            | `src/main/ncm/api.ts`                    | 单测 + 检查 userData 无残留目录                            |
| S8   | P2     | body-parser 升 ≥2.3.0（override 或升级 API 包，需重验 patch）          | `package.json` / `pnpm-workspace.yaml`   | `pnpm audit --prod` 归零                                   |
| S2   | P2     | `/media/*` 去 CORS；配对接口收紧 Origin                                | `src/main/remote/httpServer.ts`          | 现有 httpServer 测试补 CORS 断言                           |
| S3   | P2     | SSE 连接数上限                                                         | `src/main/remote/httpServer.ts`          | 单测                                                       |
| S4   | P3     | `shell:openExternal` 默认仅 `https:`                                   | `shellIpc.ts`、`window.ts`、`ncm/api.ts` | 单测                                                       |
| U1   | P1     | 去掉播放行位移/缩放/大阴影，改背景+指示条高亮                          | `SongList.css`                           | 截图对比 + 现有渲染测试                                    |
| U2   | P1     | 密集行 hover 只留背景/细描边                                           | `SongList.css`                           | 截图对比                                                   |
| U3   | P2     | 封面列移除写死 `translateX(32px)`                                      | `PlayingMusic.vue`                       | 多窗口宽度截图                                             |
| U4   | P2     | HiFi 小卡片阴影收敛/去除                                               | `PlayerBar.css`                          | 截图对比                                                   |
| U5   | P3     | 逐步清理 `!important`，新样式禁用                                      | `base.css` 等                            | lint 规则                                                  |
| U6   | P3     | 阴影统一走令牌                                                         | 各 css                                   | 主题回归测试                                               |
| I1   | P1     | 音量图标点击 = 静音；抽屉保留为显式入口                                | `PlayerBar.vue` + `useFloatingPanels.ts` | 交互测试/手动                                              |
| I2   | P2     | 滚轮不弹抽屉/悬停延迟展开                                              | `PlayerBar.vue`                          | 手动                                                       |
| I3   | P2     | 增加“仍然退出”逃生选项                                                 | `window.ts`、`closePersistence.ts`       | 单测                                                       |
| I4   | P3     | 统一菜单键语义                                                         | `useAppNavigation.ts`                    | 单测                                                       |

**说明**：安全面本次建议处理两项——**S7（Electron 升级，含 CVE-2026-5858）** 与 S1（Cookie 落盘）；U1/U2/I1 为视觉与交互最优先的三项。S7 的 Electron 升级范围（保守 39.8.10 vs 直接上 41/42/43）需要你拍板。

---

## 6. P1 实施草案（供审阅确认，尚未改动代码）

> 以下为针对 **S1 / U1 / U2 / I1** 的初步改法草案。审阅通过后再实施，实施后跑对应测试 + 截图复核。

### D1 · S1：NCM 登录分区改为内存分区

`src/main/ncm/api.ts:99`

```diff
- const partition = `persist:twilight-ncm-login-${Date.now()}`
+ // 去掉 persist: 前缀 → 内存分区，Cookie 只存活于登录窗口会话期间，不落盘
+ const partition = `twilight-ncm-login-${Date.now()}`
```

- 会话内 `music.163.com` 登录流程与 `collectNcmOfficialCookie`（`api.ts:89-95`）读取 Cookie 均走同一 session，行为不变。
- 验证：登录后检查 `userData/Partitions/` 下不再出现 `twilight-ncm-login-*` 目录；现有 NCM 登录相关测试保持通过。

### D2 · U1：正在播放行去掉位移/放大/大阴影

`src/renderer/src/components/song-list/SongList.css:1146-1147`（及 `1907/1928` 组合态）

```diff
 .track-playing {
-  background: transparent !important;
-  box-shadow: 0 20px 48px rgba(124, 77, 255, 0.12);
-  transform: translateX(2px) scale(1.026);
-  z-index: 4;
+  background: var(--te-playing-row-bg, rgba(124, 77, 255, 0.08)) !important;
+  box-shadow: inset 0 0 0 1px rgba(124, 77, 255, 0.28);
+  z-index: 1;
 }
```

- 选中+播放组合态同步收敛（`1907/1928`）。
- 验证：歌单网格行对齐、无阴影溢出；跑 `test:themes` / `theme-switch` 相关测试 + 截图。

### D3 · U2：密集行 hover 只保留背景 + 细描边

`src/renderer/src/components/song-list/SongList.css:1078-1096`

```diff
 .track-row:hover {
-  transform: translateX(2px) scale(1.012);
-  box-shadow: 0 16px 38px rgba(86, 70, 160, 0.08);
-  filter: saturate(1.02);
+  box-shadow: inset 0 0 0 1px var(--te-library-row-hover-border, rgba(124, 77, 255, 0.22));
   z-index: 3;
 }
```

- `::before`/`::after` 动画描边（`hover-gradient-flow` / `pointer-border-pulse`）建议一并关闭或仅保留静态细描边，避免密集列表动画噪音。
- 验证：hover 无位移、无阴影扩散；截图对比。

### D4 · I1：音量图标点击 = 静音；抽屉保留为显式/悬停入口

`src/renderer/src/components/PlayerBar.vue:1415` + `useFloatingPanels.ts`

```diff
  // useFloatingPanels.toggleVolume()：仅负责抽屉开关（保持现状）
  // PlayerBar.vue 音量按钮改为：
- @click="toggleVolume"
+ @click="onVolumeButtonClick"
```

```ts
function onVolumeButtonClick(): void {
  if (volumeOpen.value) {
    closeFloatingPanels()
    return
  }
  toggleMute() // 静音/恢复（usePlayerStore 已实现 toggleMute，当前无 UI 入口）
}
```

- 音量调整入口：抽屉仍可通过音量按钮旁的“下拉箭头”或 hover 展开；或补充右键菜单。
- 验证：点击喇叭=静音/恢复；抽屉仍可打开调整音量；跑 `volumeMute` 相关测试。

---

## 7. 实施记录（2026-08-01，用户确认后执行）

> 范围：升级 Electron 至 43 + 修复本章总结的安全/UI/交互问题，随后 `pnpm run dev` 验证音频服务。

| 编号  | 状态 | 改动                                                                                                                                                                                      |
| ----- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S7    | ✅   | `package.json` `electron: ^39.2.6` → `^43.0.0`，锁文件解析到 **43.2.0**；`pnpm-workspace.yaml` 增加 `node-abi: 4.33.0` override（否则 electron-builder 无法识别 Electron 43 ABI）         |
| S1    | ✅   | `src/main/ncm/api.ts:99` 登录分区去掉 `persist:` 前缀 → 内存分区，Cookie 不再落盘                                                                                                         |
| S8    | ✅   | `pnpm-workspace.yaml` overrides：`body-parser@1.20.5→1.20.6`、`body-parser@2.2.2→2.3.0`（CVE-2026-12590）                                                                                 |
| S2    | ✅   | `httpServer.ts` CORS 收紧：`access-control-allow-origin: '*'` 移除，仅回显同源/回环 Origin（新增 `resolveAllowedOrigin` 与 `externalUrl` 同款策略）                                       |
| S3    | ✅   | `httpServer.ts` SSE 上限 8 条，超出返回 429 `too_many_event_connections`                                                                                                                  |
| S4    | ✅   | 新建 `src/main/security/externalUrl.ts`：外部跳转默认仅 https:（http: 需显式域名白名单）；`shellIpc.ts` / `window.ts` / `ncm/api.ts` 统一改用                                             |
| U1    | ✅   | `SongList.css` `.track-playing` 去掉 `translateX(2px) scale(1.026)` 与大阴影 → 背景色 + inset 细描边；`track-selected.track-playing` 组合态同步收敛；base.css dark/pureWhite 主题覆盖同步 |
| U2    | ✅   | `SongList.css` `.track-row:hover` 去掉位移/大阴影/动画渐变描边 → 仅 inset 细描边；`::before/::after` hover 动画关闭；dark/pureWhite 同步                                                  |
| U3    | ✅   | `PlayingMusic.vue` `.cover-column` 移除写死 `translateX(32px)`                                                                                                                            |
| U4    | ✅   | `PlayerBar.css` HiFi 小卡片（`.hifi-meta` / `.hifi-quality-card` / `.hifi-toggle-card`）阴影收敛为 `0 1px 2px`；hover/on 态阴影收敛                                                       |
| I1    | ✅   | `PlayerBar.vue` 音量图标点击 = 静音/恢复（`onVolumeButtonClick`），抽屉打开时点击先收抽屉；`toggleMute` 接入                                                                              |
| I2    | ✅   | `PlayerBar.vue` `onVolumeWheel` 只调音量、不再自动弹抽屉                                                                                                                                  |
| I3    | ✅   | `closePersistence.ts` 支持 `'force'` 逃生出口；`window.ts` 对话框新增 “Quit without saving” 按钮；补单测                                                                                  |
| I4    | ✅   | `useAppNavigation.ts` 菜单键统一：设置/插件页先退出全屏页再打开侧边菜单                                                                                                                   |
| U5/U6 | ⏳   | P3 风格化重构（清理 118 处 `!important`、阴影全量走令牌），属“逐步清理”项，未在本次执行                                                                                                   |

**新增测试**：`src/main/security/externalUrl.test.ts`（S4）、`closePersistence.test.ts` 新增 force 用例（I3）、`httpServer.mediaOnly.test.ts` 新增 CORS/SSE 断言（S2/S3）。

**音频服务可用性（dev 验证）**：

- 首次 dev 启动发现原生音频模块缺失（`twilight_audio_node.node` 未构建）→ 用系统 cmake/g++/FFmpeg/ALSA 执行 `cmake -S audio-engine -B audio-engine/build/default -DTAE_BUILD_NAPI=ON -DTAE_BUILD_TESTS=OFF` + `cmake --build` 编译出 `.node`（ALSA runtimeAvailable、FFmpeg/ebur128/nativeDsp 全开，`GetEngineCapabilities` 验证通过）。
- 重新 `pnpm run dev`：无 `未加载 twilight_audio_node.node` / `音频服务不可用` 报错；NCM 音频服务 `http://127.0.0.1:3100` 正常响应（login/playlist/song 等请求持续 Success）；Electron 43.2.0 主/GPU/渲染/utility（音频引擎、插件宿主等）进程正常。
- 注意：dev 启动需先清理 `~/.config/TwilightEcho/Singleton*`（被强杀时残留会导致新实例秒退）。

**验证命令**：`pnpm audit --prod`、`pnpm run test:cross-cutting-regressions`、`pnpm run test:plugins`、`pnpm run test:radio-remote`、`pnpm run typecheck`、`pnpm run dev`。

---

## 8. 设置页外观区 UI 修复（2026-08-01，用户反馈后）

- **U7【中】歌词显示样式控件拥挤**：`字号` / `未播放暗度` 两个滑块组与对齐下拉框挤在一行（每个滑块 pill 仅 228/242px），标签与数值观感堆叠。
  - 修复：`SettingsPage.vue` 给该 setting-item 加 `lyric-style-item` 类；`SettingsPage.css` 中该项改为纵向布局（控件独占整行），滑块组 `flex: 1 1 240px` + `flex-wrap`，窄窗口自动换行。实测 1280px 下每个滑块组扩展至 ~325px、无溢出；700px 下自动单列。
- **U8【中】“卡片与背景自定义”触发按钮紧贴上方分割线**：实测按钮与 `<hr>` 间距为 0。
  - 修复：`.settings-accordion-trigger` 增加 `margin-top: 16px`。
- 验证：`vue-tsc` typecheck 通过；`test:app` 仅剩既有的 `.github` 缺失失败（与本次无关）；dev 热更新后实测间距 16px、控件无溢出。

---

## 9. 原生播放引擎修复（2026-08-01，用户反馈“还是没法用原生播放引擎”）

现象：点击播放后报 `打开音频失败，错误码：-1330794744`（av_strerror = **Protocol not found**），随后判定“原生音频引擎不可用”。

### 根因一：Electron 自带 Chromium libffmpeg 与引擎系统 libav\* 符号抢占（主因）

- 音频引擎服务跑在 Electron utility 进程；该进程同时加载 Electron 自带 `libffmpeg.so` 与引擎链接的系统 `libavformat/avcodec/avutil/swresample`。同名符号抢占全局符号表后，引擎内 FFmpeg 协议注册表损坏 —— 连本地文件 `avformat_open_input` 都返回 “Protocol not found”。
- 对照实验（utility 进程内直接调用引擎）：
  - 不带 LD_PRELOAD → `打开音频失败，错误码：-1330794744`（复现）
  - 带 LD_PRELOAD 预载系统 libav\* → `Play OK`
- 修复：`src/main/audioEngineServiceClient.ts` —— fork 音频服务时（仅 Linux）用 `ldd <addon>` 解析引擎实际链接的系统 FFmpeg 库，经 `env.LD_PRELOAD` 传给 utility 进程（静态链接构建无 libav\* 输出，自动跳过；Windows/macOS 不受影响）。

### 根因二：本机 ALSA `default` PCM 打不开，`pipewire` PCM 可用

- 该 PipeWire 主机的 ALSA `default` 走 dmix 但 slave 打不开（`snd_pcm_open("default")` → -2），`snd_pcm_open("pipewire")` → 0。
- 修复：`audio-engine/output/alsa/AlsaBackend.cpp` —— 打开 `default` 失败时回退 `pipewire` → `pulse`；已重建 `audio-engine/build/default/twilight_audio_node.node`。

### 验证

- dev（Electron 43）本地缓存曲目与流媒体曲目均原生播放：无 “Protocol not found”/“音频服务不可用”，进度推进；`actualDeviceName: ALSA pipewire`，44100/24bit 输出。
- `typecheck:node` 通过；`audioEngineServiceClient.test.ts` 28/28 通过。
- 日志仅剩 ALSA 首试 `default` 的 dmix stderr 警告（回退路径的正常噪音）。

### 备注

- 网易云 `/song/url/v1`（hires/lossless/exhigh）对未付费 VIP 曲目返回错误，仅 legacy `/song/url?id=..&br=999000`（128kbps）成功 —— 属 NCM VIP 权益问题，与原生引擎无关。

---

## 10. 原生播放逻辑修复：进度条卡住 / 切模式自动切歌 / 偶发自动切歌（2026-08-01）

现象：① 拖动进度条后进度条卡住不动；② 切换“随机播放/单曲循环”自动切到下一首；③ 播放中偶尔自动切歌。

### 根因（三者同源）

- NCM 播放列表的本地缓存文件导致队列以**单曲队列**加载（`prepareNativeQueue` 对未解析源的其他曲目回退 `asCurrentOnly`，`delegated=false`）。
- `resolvePlayTarget` 只把解析后的播放源写进**传入的 track 对象**，而 `currentTrack` 是激活时的拷贝，未同步 → 模式切换触发队列重同步时，`syncNativeQueueState` 用 `currentTrack` 取源得到**空 source** → `preparePlayerNativeQueue` 返回 `null`。
- `syncNativeQueueState` 在 prepare 为 null 时调用 `stopNativeAudio()` → 引擎停止 → 主进程 tick 看到 `state=stopped`，且单曲队列 `queueIndex(0) >= len-1(0)` 恒真 → **误发 `eof-reached`** → 渲染层 `handlePlaybackEnded` → 按当前模式切歌/重播 → 表现为“切模式自动切歌”“偶发自动切歌”，切歌后的短暂停止又让进度条冻结。

### 修复（`src/renderer/src/stores/usePlayerStore.ts`）

1. `loadAndPlay` 解析 `playTarget` 后，把 `streamUrl/filePath/streamQuality` **回写 active `currentTrack`**，消除后续队列重同步取空 source 的问题。
2. `syncNativeQueueState` 在 `preparePlayerNativeQueue` 返回 `null` 时**不再 `stopNativeAudio()`**——保持现有播放，避免“停止→误判 EOF→切歌”级联；真正的“不可用→回退”交给 `loadAndPlay` 正常路径处理。

### 验证

- 12 次快速切换播放模式（穿越 随机/顺序/列表循环/单曲循环）：曲目不再切换，进度正常推进。
- 拖动进度条到 60% 后 4 秒进度推进（227→231），不再卡住。
- `test:playback-routing` 263/263、`audioEngineServiceClient.test.ts` 28/28、`typecheck`（node+web）通过；`test:app` 仅剩既有的 `.github/workflows/audio-engine.yml` 缺失失败（与本次无关）。
