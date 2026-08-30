# Twilight Echo UI、歌词与播放时钟重构审计

> 状态：部分实施完成；播放与歌词的自动化回归已通过，深色模式仍需真实 Electron 视觉验收。
>
> 原始问题基线：2026-08-08；当前复核：2026-08-08
>
> 阅读说明：第 2-8 节保留问题出现时的代码证据、根因和设计裁决，属于历史基线。当前代码已经替换了其中的部分实现（尤其是 `playbackPositionAuthority`）；以第 9 节的实施状态和验证证据作为当前结论。

## 1. 目标与问题边界

本次重构要同时解决以下用户可见问题：

1. 深色模式下页面、控件、下拉框、歌词和播放器侧栏出现白色/浅色残留，文字和背景对比度不稳定。
2. 歌词页自动滚动不稳定：切歌、歌词异步加载、YRC/普通 LRC、窗口尺寸变化或手动滚动后，活动行可能不在视口中心，滚动会停住、跳动或重复。
3. 进度条停止更新时，歌词活动行和逐字高亮也停止更新；或者进度条、歌词行、逐字高亮显示的时间互相不一致。
4. 播放器事件存在多来源竞争：原生音频引擎 `time-pos`、HTMLAudio `timeupdate`、播放信息、定时预测时钟和组件级 `requestAnimationFrame` 同时写入或推导播放位置。
5. 当前修复已经分散在多个模块，且工作区现状不能通过完整的类型检查和部分回归测试。

非目标：本文件不直接重写播放器、主题或歌词实现；后续 goal 模式应把本文作为迁移顺序和验收依据。

## 2. 修复前基线证据（历史记录）

### 2.1 当前必须先处理的阻塞项

| 检查                              | 当前结果                        | 证据                                                                                                                |
| --------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `pnpm run typecheck:web`          | 失败                            | `src/renderer/src/providers/mediaProvider.ts:647-648` 有字面量 `\\(`、`\\)`，不是合法 TypeScript。                  |
| `pnpm run test:lyrics-management` | 104 项中 102 通过、2 项构建失败 | `PlayingMusic.lyrics.behavior.test.ts` 与 `lyricsPlayerStore.behavior.test.ts` 都因为上面的 provider 解析错误失败。 |
| `pnpm run test:themes`            | 64 项中 63 通过、1 项失败       | `themeColorAudit.test.ts` 报告四个业务样式文件超过硬编码颜色基线。                                                  |
| `pnpm run test:playback-routing`  | 失败                            | 运行集合包含 `usePlayerStore.test.ts`，同样被 `mediaProvider.ts` 解析错误阻断。                                     |
| `git diff --check`                | 失败                            | provider 文件末尾存在额外空行；这不是主要功能错误，但说明当前补丁未完成格式收尾。                                   |

### 2.2 编译错误的具体位置

`mediaProvider.ts` 已经在类的 `resolveLyricsAcrossProviders`（约 306 行）之外，又出现一段顶层同名解析逻辑（约 615-654 行）。其中 647-648 行写成了 `.map\\(` 和 `.filter\\(`。这段代码还返回 `{ lyrics, failure }`，与上方公开方法承诺的 `MediaProviderLyrics` 形状不同。

处理原则：先确认这段代码是误粘贴的辅助实现还是应保留的公共函数；不要只把反斜杠删掉后继续叠加逻辑。最终只能保留一个拥有明确返回类型和取消语义的 provider 解析入口。

## 3. 修复前实现地图（历史记录）

### 3.1 主题和深色模式

- `src/renderer/src/stores/useThemeStore.ts`：读取设置、主题库和插件主题，把变量和 `data-*` 属性写入运行时样式。
- `src/renderer/src/assets/base.css`：同时包含早期 `:root` token、后续 `:root[data-theme='pureWhite']` token、`[data-theme='dark']` token，以及大量页面级覆盖。
- `src/renderer/src/components/PlayingMusic.vue`：now-playing 页面有一套 `--te-playback-*` 变量和白色 fallback。
- `src/renderer/src/components/player-bar/HiFiSidebar.vue`：Signal Deck 自己定义 `--d-*` 变量，再用 `html[data-theme='dark'] .deck` 覆盖一部分。
- `src/renderer/src/components/settings-page/SettingsPage.css`、`SettingsPage.vue`、网络来源页面：仍包含很多硬编码颜色。
- `src/renderer/src/components/PlayerBar.vue`、`player-bar/PlayerBar.css`：播放器控件、音量抽屉和进度条又有局部 light/glass 颜色。

### 3.2 播放位置与进度条

- `src/renderer/src/stores/usePlayerStore.ts`：保存 `currentTime`、`duration`、`isPlaying`，接收音频引擎事件和 HTMLAudio 事件。
- `src/renderer/src/utils/playbackPositionAuthority.ts`：当前新增的采样接受、seek/切歌保护和 renderer 预测时钟。
- `src/renderer/src/utils/playbackPositionAuthority.test.ts`：覆盖重复 native sample、切歌和预测时钟的部分行为。
- `src/renderer/src/components/PlayerBar.vue`：由 `currentTime / effectiveDuration` 得到进度；视觉填充另外通过 `useSmoothedValue` 平滑。
- `src/renderer/src/utils/useSmoothedValue.ts`：组件级 `requestAnimationFrame` 插值。

### 3.3 歌词索引、逐字高亮和滚动

- `src/renderer/src/components/PlayingMusic.vue`：解析歌词、计算活动行、维护 `predictedLyricTime` 和下一行 timer，控制 focus window、行切换动画以及手动浏览状态。
- `src/renderer/src/components/PlayingLyricWords.vue`：监听共享 `currentTime`，另建 `clockAnchorPosition/clockAnchorTime`，用 rAF 和 50ms interval 推进逐字高亮。
- `src/renderer/src/utils/lyricViewportController.ts`：维护行 DOM ref、track-scoped scroll position、自动跟随、手动锁定和 resize 重定位。
- `src/renderer/src/utils/animationFrameFallback.ts`：为 rAF 提供一次性 timer fallback，但 `PlayingLyricWords.vue` 的主动画并未使用此 helper。
- `src/renderer/src/stores/usePlayerStore.ts` 的歌词加载流程：provider/local/online 多个异步来源、AbortController、generation、retry timer 同时存在。

## 4. 问题清单与根因

### 4.1 深色模式没有真正形成单一 token 契约（高优先级）

#### 现象

- 深色模式仍出现浅色卡片、白色渐变、白色滑块、浅色原生选项或暗背景上的低对比文字。
- 同一控件在普通页面、now-playing、玻璃播放器和 HiFi 侧栏的颜色来源不同，切换主题后不一定同步。
- 某些页面的组件样式使用 `var(--token, #ffffff)`，当 token 暂时未注入或名称不一致时直接回退到白色。

#### 证据和具体位置

1. `base.css:1-210` 先定义一份 root token，`base.css:369-496` 又定义一份主题 token。两套变量有重复和不同默认值，后续维护无法判断哪一份是权威来源。
2. 深色 token 在 `base.css:479-487` 仍把 `--te-library-bg`、`--te-library-table-bg`、`--te-library-table-border`、`--te-library-table-shadow` 保留为明显的 light 值；这会直接影响曲库和表格。
3. `base.css:508-510` 的 `html` 默认背景是 `#fbfbff`，没有对应的 dark root 背景契约。
4. `PlayingMusic.vue:764-770`、`1141-1167`、`1239-1281`、`1414-1447`、`1462-1474` 有大量白色/半透明白色 fallback。now-playing 的背景即使是可配置主题，也会退回到一套固定的“深色播放器”视觉。
5. `HiFiSidebar.vue:1677-1695` 先写死 light `--d-*` 值，再在 1716-1736 只覆盖部分 dark 值；`2742-2750` 还需要额外覆盖原生 `option`。这说明侧栏没有共享 host token。
6. `settings-page/SettingsPage.css` 仍有 `#fff`、`#1f2937`、白色渐变和 `rgba(255,255,255,...)` 等大量业务颜色。`themeColorAudit.test.ts` 当前明确报告：`NetworkCoverThumb.vue`、`NetworkSourcesPage.vue`、`SettingsPage.css`、`SettingsPage.vue` 超过硬编码基线。
7. `PlayerBar.css:76-123` 的音量抽屉在 `drawer-glass` 状态直接写 `#151a24`、`#303848`；普通抽屉则写 `#e2e8f0`。这与 `--te-card-bg/--te-card-border` 没有统一关系。

#### 根因

主题系统目前是“全局 token + 页面局部 token + 组件 fallback + 选择器补丁”的叠加，而不是一个有完整覆盖率的语义 token 契约。`useThemeStore` 能注入变量并不等于所有组件都消费了变量；`!important` 运行时样式还会掩盖局部样式的优先级问题。

#### 解决方案

1. 只保留一份 host token schema，按 `surface / text / border / control / overlay / status / playback / lyric` 分组。light 和 dark 必须为每个 token 提供值，不允许“dark 未定义就使用 light 默认”的隐式行为。
2. 组件只能消费语义 token；删除业务样式中的颜色 fallback，或把 fallback 放进 schema 的明确默认层。颜色提取出来的 accent 只能覆盖 accent token，不能直接改变文字和表面的明度。
3. 为 now-playing 明确定义两种模式：跟随应用主题的 `themed` 和始终以封面可读性为优先的 `immersive`。不要用一套固定白字 fallback 同时假装支持两者。
4. HiFi 侧栏、PlayerBar、Settings、Network 页面改成 host token 的 adapter；组件内部只保留几何、排版和状态，不再各自创建第二套颜色体系。
5. 删除重复 root token 块，统一 `html[data-theme]`/`:root[data-theme]` 选择器策略，给 `html`、`body`、`#app` 和原生控件设置明确的 `color-scheme` 与背景。
6. 把 `themeColorAudit` 从“数量基线”升级为“允许清单 + token 使用率 + dark/light 对比度”检查。任何新增硬编码颜色必须有审计豁免及原因。

### 4.2 播放位置存在多写入者和多个时钟（最高优先级）

#### 现象

- 原生引擎重复上报同一个位置时，`currentTime` 可能被判定为 stalled；renderer 预测时钟只能暂时补上，超过最大未观察窗口后又停止。
- 切歌、seek、start-file、暂停确认的先后顺序不同，会出现进度条回跳、停在起点、时间 chip 不动或歌词活动行不变。
- 视觉进度条可能在平滑值上继续移动，但 range 控件和歌词仍使用另一份 `currentTime`。

#### 证据和具体位置

1. `usePlayerStore.ts:572-586` 的 HTMLAudio `timeupdate` 和 `setupAudioEngineListeners` 中的 native `time-pos` 都可能调用 `applyPlaybackPositionSample`。
2. `usePlayerStore.ts:1918-2022` 同时维护 `latestPlaybackTime`、`currentTime`、`lastTimePublishAt`、pending publish timer，以及 `playbackPositionAuthority` 的 anchor/estimate。
3. `playbackPositionAuthority.ts:130-167` 会拒绝 engine stalled/rewound sample；`178-207` 的预测时钟只在最后一次采样后的有限窗口内估算，超过 `rendererClockMaxUnobservedGapMs` 会重置 anchor 并返回 null。重复 sample 持续超过该窗口时，进度仍会再次冻结。
4. `PlayerBar.vue:245-263` 使用 `progressPercent`，再用 `useSmoothedValue` 生成另一份 `smoothedProgressPercent`；但 range 的 `:value` 在 `1295-1306` 仍绑定原始 `currentTime`。视觉填充和可交互滑块不是同一个显示值。
5. `PlayingMusic.vue:274-428` 自己维护 `lastObservedLyricTime`、`predictedLyricTime` 和下一行 timer；`PlayingLyricWords.vue` 又维护另一套 anchor 和 rAF。歌词并不是单纯消费一个“当前播放时刻”。

#### 根因

播放位置既是 transport 状态，又被当作 UI 动画值和歌词预测值。当前代码通过更多 guard、grace、watchdog 和 fallback 互相补洞，但没有明确“谁是权威、何时允许预测、何时必须向引擎重新确认”的状态机。

#### 解决方案

建立单一 `PlaybackSessionClock`，只允许 `usePlayerStore` 写入：

```ts
type TransportState = 'idle' | 'loading' | 'playing' | 'paused' | 'stalled' | 'ended'

interface ClockSnapshot {
  trackId: string
  epoch: number
  position: number
  duration: number
  rate: number
  state: TransportState
  revision: number
  sampledAt: number
}
```

规则固定如下：

1. 原生 `time-pos`、HTMLAudio `timeupdate` 和播放信息先转换成带 `source / epoch / sampledAt` 的 sample，再进入唯一 reducer；组件不能直接写 `currentTime`。
2. track/seek/load 先递增 epoch，立即发布目标位置；旧 epoch 的任何 sample 丢弃。不要用多个相互独立的 `intent` 和 timer 表示同一件事。
3. `playing` 状态下短暂无 sample 可以预测，但预测由 clock 自己产生，并持续到 `duration` 或明确 pause/stop；超过超时应进入 `stalled` 并主动请求一次 `getPlaybackInfo`，不能静默返回 null 后永久冻结。
4. `paused` 只有在明确的 pause 事务确认后才成立；延迟的旧 pause snapshot 不能覆盖新 epoch。
5. seek 使用 `seekTransactionId`，目标位置立即显示；收到目标附近的第一条 sample 后完成事务。旧位置 sample 不得改变时钟。
6. `currentTime`、时间 chip、range、进度填充、歌词索引和桌面歌词都只读取同一个 snapshot。UI 平滑只能是 snapshot 的派生动画，不能产生第二个业务时间。
7. 每个 snapshot 记录 source、accepted/rejected reason 和 revision，便于诊断“冻结是没有 sample、被 guard 丢弃，还是组件没有消费”。

### 4.3 歌词活动行和逐字高亮重复推导时间（高优先级）

#### 现象

- 进度条更新频率、歌词边界 timer、逐字 rAF 的采样点不同，短行或 seek 后可能跳过活动行。
- rAF 被 Electron 暂停、窗口隐藏或 track hand-off 时，`PlayingLyricWords.vue` 只能依赖自己的 50ms interval；它没有使用已经存在的 `requestAnimationFrameWithFallback`。
- `predictedLyricTime` 在组件中被独立推进，可能与 store 的恢复、暂停、播放速率变化不同步。

#### 具体位置

- `PlayingMusic.vue:340-370`：下一行边界由 `setTimeout` 推进。
- `PlayingMusic.vue:372-428`：watch `currentTime` 后又修改预测时间和活动索引。
- `PlayingLyricWords.vue:84-135`：独立 anchor、rAF 和 interval 三套推进路径。
- `PlayingLyricWords.vue:138-186`：播放状态/速率变化重新 anchor，但没有统一的 seek transaction 或 clock revision。

#### 解决方案

1. 将歌词解析为不可变 `LyricTimeline`，活动行是 `findActiveIndex(timeline, clock.position + offset)` 的纯函数。
2. 组件只订阅 clock snapshot；不要在 `PlayingMusic.vue` 再维护可推进的 `predictedLyricTime`。如需高频逐字动画，使用 clock 提供的 `estimate(now)`，但 estimate 只能存在于 clock 层。
3. clock revision、track epoch 或 seek transaction 改变时，歌词立即同步到目标行并取消旧动画；不要等待正常行切换延迟。
4. 逐字高亮使用统一 scheduler：优先 rAF，rAF 没有回调时使用一次性 fallback；暂停、隐藏、卸载或新 revision 必须取消旧 callback。禁止组件各自创建永久 interval。
5. 对短行、同一时间戳、YRC word end 缺失、播放速率变化和跨段 seek 写单元测试，测试活动行序列而非只测最终 DOM。

### 4.4 歌词滚动控制器过于复杂且与渲染窗口耦合（高优先级）

#### 现象

- focus window 会挂载/卸载行；活动行刚改变时，目标 DOM 可能还不存在，controller 只能等待最多三轮 layout。
- 自动滚动、行进入/退出动画、手动 browse、track position restore、resize recenter 各自有 timer/request，互相取消关系难以证明。
- `@wheel`、`@pointerdown`、`@touchstart` 均直接进入 manual browse；一次点击或触摸可能先锁住自动滚动，再由行点击逻辑解锁。
- `manualLyricScrollPositions` 在组件模块级长期存在，未定义清理策略，也没有上限。

#### 具体位置

- `PlayingMusic.vue:250-268` 创建 controller；`452-456` 注册 DOM ref；`498-509` 处理手动滚动。
- `PlayingMusic.vue:435-450` 通过 focus window 决定实际渲染行。
- `lyricViewportController.ts:105-153` 的 `targetTop` 依赖 `offsetParent` 链，遇到 positioned ancestor 时才退回 bounding rect。
- `lyricViewportController.ts:156-207` 的 `focusWhenReady` 只有有限尝试和 `await afterLayout`。
- `lyricViewportController.ts:210-267` 同时处理 track activation、restore、manual timer 和 row registration。

#### 解决方案

1. 先确定产品策略：歌词行数量通常远低于曲库列表，默认渲染完整时间轴；只有确有性能证据时才启用 focus window。不要让滚动正确性依赖虚拟化窗口。
2. controller 只拥有三个职责：`attach/detach`、`follow(index, epoch)`、`setManualMode`。行动画和歌词数据不放在 controller。
3. 每次 track/clock revision 变更生成 follow token。目标行未挂载时等待 `nextTick + one frame`，由 row registration 触发重试，不使用固定三次猜测；token 失效立即取消。
4. 自动跟随使用测量后的 `row.offsetTop`/`viewport.clientHeight`，一次计算目标位置；动画期间只允许最新 token 写 `scrollTop`。
5. 只有 wheel/touch 产生真实位移后才进入 manual mode；pointerdown 本身不锁定。点击歌词行应先退出 manual，再提交 seek transaction。
6. 手动位置按 `trackId` 保存，track 切换时只保存当前 track，限制 Map 大小并在卸载时清理。自动滚动写入不得被记录为手动位置。
7. resize 使用 `ResizeObserver` 合并到一个 microtask/frame，读取布局一次后 recenter；不要让每个 row 或每个 watch 都触发滚动。

### 4.5 歌词异步加载和播放生命周期交叉（中高优先级）

#### 现象

- provider/local/online fallback、AbortController、generation、retry timer 和 source selection 同时参与一次加载。
- 切回同一首歌、切换来源或 renderer HMR 时，旧 promise 可能仍完成；即使最终有 generation guard，也会让 `loading/failed/empty` 状态难以解释。
- 当前 provider 补丁本身未编译，说明取消协议尚未形成稳定接口。

#### 解决方案

1. 把一次加载建模成 `LyricsRequest { trackId, epoch, sourceSelection, signal }`，只允许 request owner 提交结果。
2. provider 接口统一接收 `{ signal }`，每个 provider 必须保证 abort 后 promise 在有限时间内 settle；超时由 resolver 统一控制。
3. 将 source resolution（选来源）和 fetch（取内容）分开；缓存只缓存已解析内容，不缓存失败状态。
4. UI 状态只保留 `idle/loading/ready/empty/failed`，每种状态定义可重试条件。retry 不得由多个 watch 隐式触发。
5. track epoch 变化时 abort 旧请求；HMR/卸载时释放 listener、timer 和 request。

### 4.6 HMR 保护解决了症状，但没有替代运行时边界（中优先级）

`playerRuntimeOwnership.ts` 和 `playerStoreHmr.ts` 试图保证模块替换后只有一套 listener/ref graph。这能降低开发环境重复监听，但 `usePlayerStore.ts` 仍是一个包含音频事件、歌词加载、主题副作用、可视化、持久化和队列同步的超大模块。

后续应把 HMR 处理保留为开发辅助，同时按边界拆分：

- `playback-session`：transport、clock、seek transaction；
- `audio-engine-adapter`：native/HTMLAudio 事件转换；
- `lyrics-session`：source resolution、timeline、load state；
- `playback-presentation`：对组件暴露只读 refs/selectors；
- `player-persistence`：音量、resume、podcast progress。

每个边界必须有 dispose；不要再通过全局 symbol 解决生产架构耦合。

## 5. 目标数据流

```text
native time-pos / playback-info ─┐
HTMLAudio timeupdate ────────────┼─> AudioEngineAdapter -> PlaybackSessionClock
seek/load/pause intent ──────────┘                                  |
                                                                     v
                         read-only ClockSnapshot (track epoch/revision/position)
                              |                 |                 |
                              v                 v                 v
                         PlayerBar          LyricTimeline      desktop lyrics
                         progress           active index       / media session
                              |
                     optional visual interpolation
                     (never writes business time)
```

关键不变量：

1. 只有 clock reducer 能提交业务播放位置。
2. 任意旧 track epoch 的事件都不能改变当前 snapshot。
3. 组件动画值永远由最新 snapshot 派生，不能反向写回 store。
4. 进度条和歌词读取同一 snapshot，因此“进度条动但歌词不动”只能是明确的渲染 bug，而不是两个时钟自然漂移。

## 6. 分阶段实施顺序

### Phase 0：恢复可验证基线

1. 处理 `mediaProvider.ts:615-654` 的重复/误粘贴代码，修复类型和 abort 返回契约。
2. 运行 `pnpm run typecheck:web`、`pnpm run test:lyrics-management`、`pnpm run test:playback-routing`，记录真正的功能失败。
3. 清理格式问题，确保 `git diff --check` 通过。
4. 不在此阶段继续增加播放 guard 或主题覆盖。

### Phase 1：收敛播放时钟

1. 先为 `PlaybackSessionClock` 写 reducer/property tests：重复 sample、旧 epoch、seek、暂停确认、短暂断流、长时间无 sample、速率变化、duration 变化。
2. 让 native adapter 和 HTMLAudio adapter 只产生 sample，不直接改 UI refs。
3. 将 `latestPlaybackTime`、pending publish timer 和 `useSmoothedValue` 的业务职责收回 clock；保留 UI 插值时必须标注为 presentation-only。
4. PlayerBar 的 range、fill、time label 全部读取同一个百分比 selector；seek 使用 transaction。
5. 加入诊断面板或 debug log：sample source、accepted/rejected reason、epoch、revision、last sample age、transport state。

### Phase 2：重建歌词 timeline 和滚动

1. 把 LRC/YRC/translation pairing 输出为不可变 timeline。
2. 活动行和 word progress 都由 clock snapshot + timeline 纯函数得到。
3. 重写 viewport controller 的 token/cancel 生命周期；先关闭 focus window，确认完整渲染的滚动正确后再评估性能。
4. 将手动 browse 识别从 pointerdown 改为真实滚动意图；统一 track restore 和 resize 行为。
5. 为切歌、异步加载、seek、短行、YRC、隐藏窗口、resize、手动滚动写 Electron/DOM 行为测试。

### Phase 3：主题 token 化

1. 从 `base.css` 删除重复 token 定义，完善 dark/light 全量 token 表。
2. 为 PlayingMusic、PlayerBar、HiFiSidebar、Settings、Network 页面建立 token adapter，消除硬编码颜色和白色 fallback。
3. 原生 `select/option/checkbox/range` 按 `color-scheme` 和 token 统一处理；避免组件再写主题专用覆盖。
4. 将 `themeColorAudit` 改为阻止新增硬编码，并加入截图对比和对比度检查。

### Phase 4：回归与发布门禁

至少验证以下组合：

- light / dark / system 三种主题切换；
- local、NCM、podcast、radio 四种来源；
- HTMLAudio fallback 和 native queue；
- 普通 LRC、Enhanced LRC、YRC、无时间戳文本、双语/罗马音；
- 播放、暂停、seek 前后、下一首/上一首、gapless start-file、重复 native sample；
- 窗口隐藏/恢复、HMR、resize、手动滚动后自动返回；
- 低动态模式和慢速/快速播放。

## 7. 验收标准

### 主题

- 深色模式所有页面没有未解释的白色表面、浅色文字或浅色原生选项。
- `themeColorAudit` 通过，业务样式新增颜色必须为零或有审计豁免。
- light/dark 切换不需要刷新窗口，且不会重建曲库或播放队列。
- 关键文本、歌词 active/inactive、控件、边框和 focus ring 均达到项目约定的对比度阈值。

### 播放与进度条

- 正常播放时 250ms 内至少一次业务时钟更新，UI 插值不改变业务位置。
- 1.5 秒以上重复 native sample 不会让进度条永久冻结；若真的失去引擎事件，状态变为 `stalled` 并可恢复或明确提示。
- seek/切歌后旧位置不会回写；目标行、进度条、时间 chip 在同一 revision 内完成跳转。
- 暂停后 position 不继续预测；恢复播放后从确认位置继续。

### 歌词

- 活动行由共享 clock 决定，不依赖组件自己的永久 timer。
- 自动滚动始终把活动行放在约定 anchor；手动滚动不会被程序化滚动立即抢回。
- track 切换、歌词异步完成、resize、YRC word timing 和窗口隐藏恢复都能取消旧动画并收敛到最新目标。
- 所有 timer/rAF/observer/listener 在 track epoch、组件卸载和 HMR 时释放。

## 8. 持续维护提示

1. 不要直接在当前 `usePlayerStore.ts` 再添加一个 guard、watch 或 interval；先画出事件状态机并明确唯一写入点。
2. 不要把“视觉上继续移动”当成修复进度冻结；必须能说明业务 clock 的 sample、预测和恢复策略。
3. 不要用更多 `html[data-theme='dark']` 选择器覆盖局部白色；先补齐 token schema，再删除局部颜色。
4. 每个阶段保持可运行：先通过 typecheck，再跑针对性测试，再做下一阶段。不要一次性重写主题、歌词和播放 store。
5. 任何改动完成后都要更新本文的基线命令和验收证据，避免“测试名存在”被误认为功能已经验证。

## 9. 当前实施状态与验证证据

### 9.1 结论概览

| 原始问题                                           | 当前结论                                           | 当前代码证据                                                                                                                                          | 自动化证据                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 编译和回归基线被 provider 解析错误阻断             | 已恢复                                             | 旧的错误粘贴段已不再作为播放/歌词路径的阻塞点                                                                                                         | `pnpm run typecheck:web`、`pnpm run typecheck:node` 均通过                                                                                       |
| 重复或冻结的引擎 `time-pos` 让进度和歌词永久停止   | 已实施并有直接回归                                 | `playbackSessionClock.ts` 是唯一的播放时钟 reducer；冻结重复 sample 不会重置最后一个推进锚点，超出预测窗口进入 `stalled` 并请求重同步                 | `playbackSessionClock.test.ts` 和 `PlayingMusic.lyrics.behavior.test.ts` 覆盖重复冻结 sample、进度/时间 chip/活动歌词行继续推进、seek 后再次冻结 |
| 歌词页面有第二套预测时钟和多套行切换 timer         | 已实施并有直接回归                                 | `PlayingMusic.vue` 与 `PlayingLyricWords.vue` 消费 `playbackClockSnapshot` / `positionAt()`；逐字高亮不再拥有独立业务时钟                             | `PlayingLyricWords advances YRC fill with the shared playback clock` 及歌词管理套件通过                                                          |
| focus window、手动浏览和异步布局导致滚动停住或抢回 | 已实施并有直接回归                                 | 视口默认渲染完整歌词时间轴；`lyricViewportController.ts` 用 token 取消旧 follow，只有真实 wheel/touch 位移进入手动浏览，resize 合并后重居中           | `lyricViewportController.test.ts` 与 `PlayingMusic.test.ts` 覆盖切歌、过期布局、复用 ref、定位祖先、完整时间轴和点击歌词 seek                    |
| 深色模式残留浅色/硬编码颜色                        | 代码已部分清理，尚未达到可证明的“全部页面适配”结论 | `base.css`、now-playing、设置、网络来源与 HiFi 侧栏均有迁移改动，但 `PlayingMusic.vue`、`HiFiSidebar.vue` 和设置样式仍保留主题专用覆盖和颜色 fallback | `pnpm run test:themes` 通过（64/64），但其中的颜色审计只限制硬编码颜色数量，不能证明实际渲染没有浅色残留                                         |

### 9.2 当前播放与歌词架构

现在的播放位置入口集中在 `usePlayerStore.ts`：native `time-pos`、HTMLAudio 和播放信息先成为 sample，再由 `PlaybackSessionClock` 接受或拒绝。组件仅消费 `playbackClockSnapshot` 与 `estimatePlaybackClockPosition()`；它们不能再写入另一份业务播放时间。

该时钟对 track/epoch 和 seek 有围栏，对重复且未推进的 `time-pos` 保留上一个推进锚点；它会持续插值而不是重新锚定。若长期没有可信推进，则显式转为 `stalled` 并触发原生播放信息重同步。这个行为由小而确定的时钟单元测试和组件级回归测试共同覆盖。

歌词页面不再依赖 focus window 挂载活动行。它渲染完整时间轴，视口控制器只负责跟随、手动浏览和尺寸变化后的重居中。旧 track 或旧布局产生的 follow token 无法在新目标之后写入滚动位置；点击带时间的歌词会先释放手动浏览锁再提交 seek。

### 9.3 深色模式的剩余验收缺口

`themeColorAudit.test.ts` 的断言是“业务样式文件中的颜色字面量数量不得超过允许清单”。它是防回退约束，不是像素或对比度验证。当前 `test:themes` 中的视觉脚本测试也只验证截图矩阵和 CDP 参数生成逻辑；它不会在没有已启动 Electron/CDP 会话时抓取真实页面。

因此，不应因 `test:themes` 通过就宣称深色模式已经完全适配。下一阶段必须针对下列仍有局部 dark selector 或颜色 fallback 的高风险区域做真实渲染检查：

1. `PlayingMusic.vue` 的封面背景、歌词、控制按钮和沉浸式模式 fallback。
2. `player-bar/HiFiSidebar.vue` 的 Signal Deck 与原生 `select/option`。
3. `settings-page/SettingsPage.css`、`SettingsPage.vue` 与网络来源页的卡片、弹窗、输入控件和滚动条。
4. `PlayerBar` 的进度、音量抽屉和 range 控件。

每个区域需要在 light、dark 和 system 三种模式下审查：背景/表面、正文和次级文本、hover/focus、禁用态、原生表单控件，以及歌词 active/inactive 的可读性。发现的浅色残留应回归到 host semantic token，不应继续新增 `html[data-theme='dark']` 的局部补丁。

### 9.4 已执行的验证

以下命令在本次复核中返回零退出码：

```text
pnpm run typecheck:web
pnpm run typecheck:node
pnpm run test:lyrics-management
pnpm run test:playback-routing
pnpm run test:themes
git diff --check
```

歌词管理、播放路由和主题套件分别为 104、289 和 64 项通过。Node 的模块类型警告与 Electron 环境警告存在，但没有导致失败。

### 9.5 深色模式的下一步证据流程

在隔离用户数据目录中启动带 `--remote-debugging-port=9223` 的 Electron 后，执行项目已有的证据脚本：

```text
pnpm run evidence:themes -- --seed-user-data C:\twilight-p7-userData
pnpm run evidence:themes -- --port 9223 --output output/theme-golden-p7
```

第二条命令需要先以该用户数据目录启动应用。它会生成 97 组主题截图和 manifest；把经过人工像素/可读性审查的 PNG 与 manifest 放入 `docs/audit-evidence/`。这是关闭第 4.1 节“深色模式完全适配”验收项所缺少的证据。

2026-08-08 已实际执行：97 组矩阵在 dev 下完整跑通（见 9.8）。

若要同时运行 10k 压力基准：`--seed-real-files 10000` 会在种子用户数据里生成真实迷你 WAV 媒体库（约 2MB、1 万个小体积合法 WAV；应用启动扫描约需数分钟完成入库），随后矩阵与 10k 基准都会真实执行。

### 9.6 深色模式视觉证据（2026-08-08 实拍）

证据目录：`docs/audit-evidence/theme-golden-2026-08-08/`（7 张 PNG + `manifest.json`）。

取证方式：在隔离用户数据目录中启动 dev 实例，通过 CDP 将应用模式切到 `dark`（默认/zen-minimal 预设），用真实 WAV 媒体库驱动歌曲列表与播放，逐页截图；再用 `pureWhite` 模式截浅色对照。截图来自真实 Electron 渲染，不是 mock。

像素分析结果（平均亮度、近白占比、近黑占比）：

| 页面                    | 平均亮度 | 近白像素占比      | 近黑/深色像素占比 |
| ----------------------- | -------- | ----------------- | ----------------- |
| dark-dashboard          | 37       | 2.7%（文字/图标） | 90.9%             |
| dark-song-list          | 30       | 0.1%              | 97.7%             |
| dark-player-bar         | 31       | 0.1%              | 92.4%             |
| dark-playing-page       | 30       | 0.0%              | 88.6%             |
| dark-settings           | 34       | 0.1%              | 94.5%             |
| dark-network-sources    | 25       | 0.1%              | 98.9%             |
| light-song-list（对照） | 253      | 97.5%             | 0.1%              |

结论：深色模式下六个高风险页面没有出现大面积白色/浅色面板（近白像素占比 ≤ 2.7%，且 4x4 分块平均色全部为深色）。这为第 4.1 节的“深色模式完全适配”提供了第一版真实渲染证据。

已知限制：

1. 本次会话无法人工查看图片，采用像素统计作为客观代理；正式验收仍建议人工查看 PNG（尤其歌词 active/inactive 对比度与 hover/focus 态）。
2. 播放页歌词为空（无歌词文件），逐字高亮的视觉项仍需带歌词的真实曲目复核。
3. 预设音调实测结论（已复核）：内置预设是模式无关的调色板，音调跟随应用设置（`settings.theme`）。唯一例外是 `aurora-reference`，其 `modes.appearance.toneScheduling: 'timed'` 按时间切色调（白天为浅色属设计行为）。此前记录的“预设音调不一致”是测量等待不足造成的假象，不是产品缺陷；`obsidian-glass` 的 `pureWhite` 槽位中的深色值属于“始终深色外观”的预设设计。
4. 97 组矩阵脚本在 dev 模式下无法直接跑通：应用启动扫描会清掉种子媒体库中不存在的虚拟文件路径；`--seed-user-data` 生成的 `music-library.json` 无法在启动后保留。本次证据改用真实 WAV 文件 + 预授权 `settings.json`（UTF-8 无 BOM，含 `libraryFolders` 与 `onboardingCompleted: true`）实现。该流程已工具化：`--seed-user-data <dir> --seed-library-folder <dir>` 现在会直接生成可启动的配置（无 BOM、跳过引导、预授权真实媒体目录），并配有测试与端到端验证。

复现证据流的要点：`settings.json` 必须用 UTF-8 无 BOM 写入（PowerShell `Set-Content -Encoding UTF8` 会带 BOM，应用会判为损坏并从备份恢复），`libraryFolders` 必须在启动前写入并在 `localPaths` 初始化后自动获得授权。

### 9.7 预设切换后的深色模式回归（2026-08-08 修复）

真实运行环境实测发现：深色模式下切换到 `aurora-reference` 后，再切换到任意手动预设（obsidian-glass、paper-light、neon-gradient、studio-split、zen-minimal），界面停留在浅色，尽管 `settings.theme` 仍是 `dark`。

根因：`useThemeStore.ts` 的 `resolveRuntimeTone()` 对 `manual` 色调调度返回 `resolveTone()`（读取 `documentElement.dataset.theme`），而不是读取应用偏好 `themePreference`。`aurora-reference` 的 `timed` 调度在白天把 `dataset.theme` 改为 `pureWhite`；该 DOM 值随后被下一个手动预设继承，导致“切预设后深色翻白”。

修复：manual 分支改为 `return resolveThemeMode(themePreference)`（dark / pureWhite / system 均按应用设置解析）。timed 与 system 分支不变。

回归测试：`useSettingsStore.test.ts` 新增 `manual tone scheduling follows the app preference, not a stale DOM attribute`，锁定 manual 分支必须来自偏好而非 DOM 属性。

实测矩阵（修复后，应用模式 dark）：

| 预设                                                                      | data-theme | body 背景         |
| ------------------------------------------------------------------------- | ---------- | ----------------- |
| aurora-reference（timed，白天）                                           | pureWhite  | 浅色（设计行为）  |
| obsidian-glass / paper-light / neon-gradient / studio-split / zen-minimal | dark       | 深色（`#17181a`） |

验证：`test:themes` 69/69、`test:app` 227 项 0 失败（2 项跳过 gitignored CI 工作流）、`typecheck:web`、`typecheck:node` 均通过。

### 9.8 97 组主题矩阵完整运行（2026-08-08）

完整产物：`output/theme-golden-p7/`（97 张 PNG + `manifest.json`，`output/` 已被 gitignore）；精选 6 张代表案例与像素汇总：`docs/audit-evidence/theme-golden-p7-matrix-2026-08-08/`。

运行方式（dev 可用）：`--seed-user-data <dir> --seed-library-folder <真实媒体目录>` 生成可启动配置 → 启动带 `--remote-debugging-port=9223` 的实例 → 执行 `node scripts/theme-visual-regression.cjs --port 9223 --output output/theme-golden-p7`。

本轮为让矩阵可在 dev 运行所做的脚本改动：

1. `navigateToStressLibrary` 不再强制 10k 行（`tbody` 高度 ≥ 680000），改为等待真实 `.track-row` 出现；视觉矩阵因此可用任意真实媒体库运行。
2. `runElectronLibraryStress` 在行数不足时返回 `skipped: true`（保留 10k 门槛与基准逻辑，供具备真实 10k 文件的环境使用）；`main()` 仅在非跳过时执行 10k 断言。
3. `openNoCoverPlayer` 改为单击激活（与 singleClick 激活模式一致）。

像素统计（97 张全量）：

| 分组                                   | 数量 | 平均亮度 | 平均近白占比 | 近白 > 5% 的异常案例    |
| -------------------------------------- | ---- | -------- | ------------ | ----------------------- |
| dark 音调（matrix 45 + preset 4）      | 49   | 29.3     | 0.1%         | 无                      |
| pureWhite 音调（matrix 45 + preset 3） | 48   | 38.2     | 0.2%         | preset-paper-light 5.9% |

结论与边界：

- 深色音调的 49 张播放页截图均无浅色残留（近白占比 ≤ 0.1%），与 9.6 的 7 页面证据相互印证。
- 矩阵案例全部在“无封面播放页”上截图；播放页当前是沉浸式深色表面，因此 pureWhite 音调的播放页仍偏暗（`runtime.tone` 已正确记录为 pureWhite）。这印证 §4.1 方案 3 的判断：now-playing 需要显式拆分“跟随主题”与“沉浸式”两种模式，属于待产品确认的设计项，不是深色残留 bug。
- 10k 压力基准已用真实文件库运行（`--seed-real-files 10000`）：`stress.skipped=false`、trackHeight 680000、maxMountedRows 19、tbodyReplacements 0、7 预设切换样本 18.7–71.3ms；完整产物在 `output/theme-golden-p7-10k/`。
- 主题切换性能预算通过：preview p95 0.4ms（预算 32ms）、apply p95 0.7ms（预算 100ms）。

### 9.9 Phase 3 token 化收尾审计（2026-08-08）

针对审计第 4.1 节与 Phase 3 的逐项复核：

1. 重复 token：`base.css` 现有单一 `:root` 默认块 + `:root[data-theme='pureWhite']` / `:root[data-theme='dark']` 变体，`--te-app-bg` 等按音调各定义一次，未发现重复根 token 块（旧审计中的 1-210 / 369-496 两套定义已收敛）。
2. token 消费：`themeColorAudit.test.ts`（硬编码颜色基线）、`selectDarkThemeAudit.test.ts`（原生 select/option 深色）、`SettingsPage.theme.test.ts`（设置页深色表面）、`themeTokenization.test.ts`（播放/DSP token 接线）全部通过。
3. PlayingMusic 沉浸式样式：`--te-playback-*` 变量带白色/深色 fallback 是自洽的沉浸式深色表面，在 dark 与 pureWhite 两种音调下渲染一致（9.6/9.8 像素证据），未出现白色残留。
4. 结论：Phase 3 的 token 化实现已闭环；仅剩 §4.1 方案 3 的“themed / immersive 双模式拆分”属于产品设计决策，需用户确认后再实施。

## 11. 实施完成度对照（2026-08-08 复核）

| 文档项                       | 状态                           | 证据                                                                                                                                             |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 0 恢复可编译基线       | 完成                           | `typecheck:web` / `typecheck:node` 通过；provider 误粘贴段已清理                                                                                 |
| Phase 1 收敛播放时钟         | 完成                           | `playbackSessionClock.ts` + `usePlayerStore` 单一写入口；`test:playback-routing` 295/295                                                         |
| Phase 2 歌词 timeline 与滚动 | 完成                           | `PlayingMusic.vue` 全时间轴渲染；`lyricViewportController.ts` 三职责；`test:lyrics-management` 104/104                                           |
| 4.4 视口控制器复杂度         | 完成                           | controller 仅 attach/detach、follow(token)、manual；wheel/touch 才进入 manual；resize 合并；行 Map 随 track/dispose 清理                         |
| 4.5 歌词异步加载取消协议     | 完成                           | provider 接口统一 `{ signal }` + `withTimeout`；`usePlayerStore` 歌词请求带 generation/AbortController/owner 守卫；track epoch 变更 abort 旧请求 |
| 4.6 运行时边界拆分           | 未实施（文档定义为“后续”建议） | `usePlayerStore` 仍为超大模块；属架构演进项，需单独排期                                                                                          |
| Phase 3 主题 token 化        | 完成                           | 单 root token schema；themeColorAudit / selectDarkThemeAudit / SettingsPage.theme / themeTokenization 全通过；深色像素证据无残留                 |
| Phase 4 回归与发布门禁       | 完成                           | `test:app` 227 项 0 失败；网络源套件接入；97 组矩阵完整运行                                                                                      |
| §10 启动空白回归             | 完成                           | preload 沙箱修复 + 回归测试；CDP 冷启动验证                                                                                                      |
| §9.7 预设切换翻白            | 完成                           | `resolveRuntimeTone` manual 分支改为读偏好；回归测试 + 实测矩阵                                                                                  |
| §9.5/9.6/9.8 视觉证据        | 完成（自动化层）               | 7 页面截图 + 97 组矩阵 + 像素统计；人工终验待用户                                                                                                |

剩余待决策项（需用户输入，未擅自实施）：

1. §4.1 方案 3：播放页 themed / immersive 双模式拆分（涉及浅色模式播放页观感的产品决策）。
2. 深色模式截图人工终验（本会话无法查看图片，仅能以像素统计代理）。
3. 已关闭：10k 压力基准可用 `--seed-real-files 10000` 在 dev 下运行（见 9.8）。

## 10. 启动空白回归（2026-08-08 修复记录）

### 10.1 症状

用户报告 dev 启动后整个窗口空白。CDP 抓取确认 `#app` 没有子节点、`body` 文本为空；控制台同时出现两条错误：

```text
Unable to load preload script: ...\out\preload\index.js
Error: module not found: node:crypto

TypeError: Cannot read properties of undefined (reading 'ncmCloud')
    at ensureCloudProgressListener (useNcmStore.ts:44)
    at setup (App.vue:221)
```

### 10.2 根因

本次重构为 `providers.call` 增加 AbortSignal 取消支持时，在 `src/preload/index.ts` 引入了 `import { randomUUID } from 'node:crypto'`。主窗口（`src/main/app/window.ts`）使用 `sandbox: true`，而 Electron 沙箱 preload 只能加载 `electron` 与少量 Node 内建模块（`events`、`timers`、`url`）；`node:crypto` 会直接令整个 preload 加载失败。

preload 失败后 `window.api` 没有被注入，渲染进程启动时 `App.vue` 的 `useNcmStore()` 读取 `window.api.ncmCloud` 抛 TypeError，Vue 无法挂载，因此窗口全空白。

### 10.3 修复

- `src/preload/index.ts`：删除 `node:crypto` 导入，改为使用沙箱 preload 可用的 Web Crypto `crypto.randomUUID()`。
- 新增 `src/preload/sandboxBoundary.test.ts`：扫描 preload 源码，禁止导入沙箱不支持的 Node 内建模块；已接入 `test:cross-cutting-regressions`。
- `src/renderer/src/stores/useSettingsStore.test.ts`：同步两处陈旧源码断言（透明窗口文案、设置搜索 computed 命名），使其匹配当前 SettingsPage 实现。

### 10.4 验证

用 `--remote-debugging-port=9223` 启动真实 Electron dev 实例并抓取 DOM/控制台：

| 阶段   | `#app`                                  | 控制台                                            |
| ------ | --------------------------------------- | ------------------------------------------------- |
| 修复前 | 0 子节点，body 文本为空                 | preload `node:crypto` 错误 + `ncmCloud` TypeError |
| 修复后 | 正常渲染（首页/侧栏文本、深色主题生效） | 仅 vite 连接日志，无异常                          |

通过检查：`typecheck:web`、`typecheck:node`、`test:cross-cutting-regressions`（17/17，含新沙箱测试）、`test:playback-routing`（295/295）、`test:themes`（69/69）、`useSettingsStore.test.ts`（18/18）、`git diff --check`。

### 10.5 已知遗留

已清零：原“15 个网络源测试文件未接线”已通过新增 `test:network-sources` 套件并接入 `test:no-real-device`、`run-final-integrated-gate.ps1`、`docs/windows-release-gate.md` 与 `scripts/feature-test-gates.test.cjs` 消除；`test:app` 现为 227 项 0 失败（2 项跳过 gitignored CI 工作流）。

仍待处理：

1. 预设音调问题已结案（见 9.6 第 3 点与 9.7）：无预设音调表不一致；实际缺陷（manual 分支读取 DOM 属性导致预设切换翻白）已修复并带回归测试。
2. 视觉矩阵已可在 dev 下完整运行（见 9.8）：97 张截图全量产出，深色案例零浅色残留；10k 压力基准已可用 `--seed-real-files 10000` 运行（dev 下真实执行）。
3. 深色模式正式人工验收（见 9.6 已知限制）：歌词逐字高亮、hover/focus 与禁用的对比度仍需人工查看截图。

## 12. 真实环境回归修复记录（2026-08-08 晚）

用户真实环境（Electron dev + NCM 已登录）复核后新增两处回归：歌词加载失败、切歌后进度条冻结。均已在真实实例上验证修复，并补充/恢复回归测试。

### 12.1 歌词加载失败：AbortSignal 不能跨 contextBridge

#### 症状

重构前歌词正常；重构后播放任意 NCM 歌曲，播放页直接显示“歌词加载失败”，NCM `getLyrics` 请求全部报错。

#### 根因

重构给 `providers.call` 增加了 `{ signal }` 透传。渲染进程的 `AbortSignal` 实例经 preload contextBridge 后变成普通对象，主进程/IPC 侧调用 `signal.addEventListener` 时抛错，导致所有带 signal 的 provider 调用（含歌词）全部失败，`resolveLyricsWithSources` 返回 `failure: 'provider'`，UI 呈现“歌词加载失败”。

#### 修复

- `src/preload/index.ts`：`providers.call` 不再接收 `AbortSignal`，只接收 `{ idempotencyKey?, requestId? }`；新增 `cancel(requestId)` 走 `providers:cancel`。
- `src/preload/index.d.ts`：同步 preload 类型。
- `src/renderer/src/providers/index.ts`：渲染进程持有真实 AbortSignal，生成 `requestId`，abort 时调用 `api.cancel(requestId)`，请求结束后移除监听。
- 回归测试：`src/renderer/src/providers/mediaProvider.test.ts` 断言渲染层拥有 signal、preload 只收普通字符串；`src/preload/sandboxBoundary.test.ts` 继续守护 preload 沙箱边界。

#### 真实环境验证

NCM 已登录（Bad0RANG3），播放“in the end i'll always be there for you”后 `lyricsLoadState=ready`、播放页 27 行歌词、DOM 渲染出真实歌词文本；切到“There For Me (Blue Palette Version)”后 18 行歌词、`ready`，全程无“歌词加载失败”。

### 12.2 切歌后进度条冻结：PlayerBar setup 崩溃污染 App vnode 树

#### 症状

冷启动后点击真实 NCM 歌曲：store 的 `currentTime` 持续推进（约 4 次/秒），引擎 `time-pos` 正常，但播放条不挂载/时间标签与进度条冻结；切歌后同样卡住。此前诊断一度认为“store ref → Vue 组件 effect 的响应式传递失效”，并按此思路加了展示层本地 ref 定时同步补丁。

#### 真实根因（本次复测定位）

CDP 干净重载 + 点击真实歌曲后，控制台抛出：

```text
ReferenceError: Cannot access 'displayTime' before initialization
    at ComputedRefImpl.fn (PlayerBar.vue:211)
    at get value ...
    at useSmoothedValue (useSmoothedValue.ts:4)
    at setup (PlayerBar.vue:215)
```

上一轮加的展示补丁把 `progressPercent` 改读 `displayTime`，但 `displayTime` 声明在 `progressPercent` 之后；`useSmoothedValue` 在 setup 阶段立即读取 computed，触发 TDZ `ReferenceError`。PlayerBar setup 崩溃 → App 的 `v-if="hasPlayerBar"` 分支产生“组件已创建但从未挂载（`el=null`）”的脏 vnode → 之后 App 每次 update 在 `shouldUpdateComponent` 读 `component.emitsOptions` 处抛 `TypeError: Cannot read properties of null` → 渲染调度链整体中断。这正是“播放条不出现 / 进度条冻结 / 切歌后不再渲染”的真正机制，也解释了之前观察到的“手动 update 后 DOM 才刷新”的假象（该手动调用其实同样抛错）。

#### 修复

1. 撤销展示层补丁（恢复 `PlayerBar.vue`、`PlayingMusicTimeChip.vue`、`App.vue` 直接订阅 store ref 的原始实现）：`progressPercent` 重新读取 `currentTime`，模板重新绑定 `currentTime`，删除本地 `displayTime`/`playerUiKick` 定时同步。恢复后真实实例验证：时间标签与进度条由 store 响应式直接驱动，无需轮询。
2. `src/renderer/src/stores/listeningStatsPersistence.ts`：`setTimeout`/`clearTimeout` 成员引用改为 `.bind(globalThis)`。Electron 渲染进程中以对象成员方式调用解引用的 `window.setTimeout` 会抛 `TypeError: Illegal invocation`，监听统计每次提交都失败并伴随数百条 `[Vue warn]: Unhandled error during execution of watcher callback`；`playlistPersistence.ts` 此前已用相同模式修复，本文件漏改。

#### 真实环境验证

CDP 冷启动 + 点击每日推荐第 1 首：播放条挂载、时间标签 0:00→0:11、进度条 fill 0%→8.3% 持续更新；点击第 2 首：进度重置并继续 0:00→0:13，歌词切到新曲 18 行 `ready`。全程 0 异常、0 console error（仅 3 条 MediaImage scheme 警告，独立已知项）。

### 12.3 回归结果

| 检查                             | 结果                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `test:playback-routing`          | 295/295 通过（含 `listeningStatsPersistence.test.ts`、`usePlayerStore.test.ts`、`playerRuntimeOwnership`、`playerStoreHmr`） |
| `test:lyrics-management`         | 105/105 通过                                                                                                                 |
| `test:themes`                    | 71/71 通过                                                                                                                   |
| `test:cross-cutting-regressions` | 17/17 通过（含 `sandboxBoundary.test.ts`）                                                                                   |
| `test:plugins`                   | 300 通过 / 1 跳过（含 `mediaProvider.test.ts`）                                                                              |
| `typecheck:web`                  | 通过                                                                                                                         |
| 真实环境（CDP 9223）             | 歌词加载 + 切歌 + 进度条连续更新，0 异常                                                                                     |

### 12.4 高亮歌词改为“播放条上方可视区”居中

#### 症状

修复进度条冻结后，播放页高亮歌词行按整个歌词视口的几何中心（`anchorRatio=0.58`）定位，但播放条悬浮在 now-playing 页面底部（实测高 72px、z-index 1002，`elementsFromPoint` 确认绘制在播放页之上），高亮行因此视觉上偏低约半个播放条高度。

#### 修复

- `src/renderer/src/utils/lyricViewportController.ts`：新增 `getBottomReservedPx` 选项，`targetTop` 用 `clientHeight - 底部预留` 计算锚点，底部被浮层覆盖的像素不再计入可视歌词区。
- `src/renderer/src/components/PlayingMusic.vue`：`LYRIC_ACTIVE_ANCHOR_RATIO` 改为 `0.5`（精确居中），并实时测量 `.player-bar-shell` 高度传入控制器；懒测量保证窗口/播放条尺寸变化在下次 follow 时自动生效。
- 回归测试：`lyricViewportController.test.ts` 新增“预留底部覆盖层后锚点上移”用例（如 viewport 180px、预留 48px、行高 72px：scrollTop 570 而非 546）。

#### 真实环境验证

CDP 实测（歌词视口 713px、播放条 72px）：高亮行中心 448px，目标相对中心 449px（偏差 ≤1px，取整误差）；原视口中心 485px（低 37px）。切歌后另一首歌曲的第 10 行高亮同样 448px，多行采样 delta 均为 0。

### 12.5 清理缓存后已缓存歌曲无法播放

#### 症状

在设置页清理缓存后，之前缓存过的 NCM 歌曲再播放直接失败（native 引擎报“打开音频失败”，错误码 -858797304），无法自动切回在线播放。

#### 根因

NCM 缓存命中时 provider 返回本地缓存文件路径（如 `music-cache\ncm-cache\<songId>.flac`），`resolvePlayTarget` 会把它写进 `track.streamUrl` 并持久化到当前曲目/队列/播放会话。清理缓存只删除磁盘文件，但已持久化的 `streamUrl` 仍是旧路径；`resolvePlayTarget` 的 NCM 本地路径复用分支**不校验文件是否存在**，直接返回死路径交给引擎打开，于是“放不了”。网络源缓存同理（`track.filePath` 直接复用不校验）。

#### 修复

`src/renderer/src/stores/usePlayerStore.ts`：

- 新增 `isUsableLocalPlaybackFile()`：复用本地路径前调用现成的 `window.api.fs.isAudioFileAuthorized`（内部按文件存在性解析授权，文件删除后返回 false）。
- NCM 本地缓存路径复用分支：文件仍存在才复用；否则清掉死路径，回退 provider 重新解析（在线重新拉流并按需再缓存）。
- 网络源 `track.filePath` 复用分支：本地文件路径同样先校验，文件缺失时清空并懒重解析（重新下载）；http(s)/twilight-media 等 URL 路径不受影响。

#### 真实环境验证

CDP 完整复现：播放“There For Me (Blue Palette Version)”后 `streamUrl` 为 `ncm-cache\3384452809.flac`（缓存路径）；删除该文件后队列条目仍携带死路径、`isAudioFileAuthorized=false`；用该条目 `playTrack` → 修复后未复用死路径，重新解析为新的 `twilight-media://` 授权并正常播放（进度连续走）。修复前该路径会直接交给引擎打开而失败。

回归：`test:playback-routing` 296/296（新增“缓存路径复用前校验”源码断言用例）、`typecheck:web` 通过。

### 12.6 深色模式音量条太暗

#### 症状

深色主题下播放条音量抽屉的滑杆轨道几乎不可见：glass 面板用 `#2a3242`，非 glass 用 accent 18% 透明叠加到近黑卡片，未填充段与抽屉底色难以区分。

#### 修复

- `src/renderer/src/components/player-bar/PlayerBar.css`：glass 音量轨道未填充段改为 `rgba(255, 255, 255, 0.22)`。
- `src/renderer/src/assets/base.css`：新增深色主题规则，非 glass 音量轨道未填充段同样使用 `rgba(255, 255, 255, 0.22)`，并同步 `::-moz-range-track`。填充段保持 accent 色。

#### 真实环境验证

CDP 深色主题 + 音量 40% 截图像素采样：抽屉底 `rgb(21,26,36)`，未填充轨道 `rgb(72,76,84)`（白透明 22% 叠加），填充段 `rgb(185,209,232)`（accent）。未填充段相对抽屉底清晰可辨；迷你播放器音量条本就使用 `rgba(255,255,255,0.16)` 的同类白透明轨道，不受影响。

回归：`test:themes` 71/71（含 `themeColorAudit.test.ts` 硬编码色基线，base.css 本身豁免、PlayerBar.css 色值数量不变）、`typecheck:web` 通过。

### 12.7 小窗模式：悬停显示歌名/歌手，移开显示歌词

#### 需求

迷你播放器（小窗）：鼠标不在窗口上时显示当前歌词行（外语带翻译）；鼠标在 UI 上时显示歌曲名和歌手；内容过长时自动滚动。

#### 实现

- `src/shared/miniPlayer.ts`：`MiniPlayerStateSnapshot` 新增 `currentLyric: { original, translation } | null`，并在 `normalizeMiniPlayerStateSnapshot` 中校验/清洗；主进程重新构建后该字段随状态同步到小窗。
- `src/renderer/src/app/useMiniPlayerSync.ts`：主窗口发布快照时用 `buildLyricLines` + `findActiveLyricIndex` 计算当前时间点活动的歌词行（仅计时歌词；未到首行/无歌词时返回 null，小窗回退显示歌名）。
- `src/preload/index.d.ts`：同步小窗状态类型（本地重复定义补上 `currentLyric`）。
- `src/renderer/src/mini-player/MiniPlayerApp.vue`：新增 `hovered` 状态（根节点 `mouseenter/mouseleave`）；未悬停且存在 `currentLyric` 时渲染歌词视图（原词 + 翻译），悬停时渲染歌名/歌手；对 `currentLyric: undefined` 做了 `?? null` 兼容（旧主进程快照缺失该字段时不再崩溃）。
- 新增 `src/renderer/src/mini-player/ScrollingText.vue`：溢出检测（ResizeObserver）+ 无缝跑马灯；动画时长按内容宽度缩放（7–24s），悬停暂停、`prefers-reduced-motion` 时禁用。
- `MiniPlayer.css`：标题/歌手去掉固定 ellipsis（交给滚动组件），新增歌词行样式。

#### 真实环境验证

重启 dev（主进程重建后字段才随快照下发）后 CDP 实测小窗：

| 状态         | 显示                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------- |
| 鼠标移出窗口 | 当前歌词 + 翻译（如 “I can see it in your eyes / 我可以从你的眼中看出”），随播放实时换行 |
| 鼠标悬停 UI  | 歌曲名 + 歌手（in the end i'll always be there for you / kuudere / JustWarrenPeace）     |
| 过长内容     | `te-scroll-text.is-overflowing` 触发，时长按宽度缩放（16s/24s 等），无缝循环             |

回归：`test:playback-routing` 301/301（新增 `useMiniPlayerSync.test.ts` 4 例 + shared 歌词字段清洗用例）、`typecheck:web` / `typecheck:node` 通过。

#### 跟进修复（同天）

1. 歌名/歌词不滚动：`ScrollingText.vue` 的 `animation` 简写里含 CSS 变量，Vue scoped 样式重写 `@keyframes` 时把简写解析坏（所有动画长属性变成空值，`animation-name: none`）。改为动画长属性写法（`animation-name` + `animation-duration: var(...)`）后动画正常启动。
2. 另一处不滚动：组件自带的 `@media (prefers-reduced-motion: reduce)` 会把跑马灯整体禁用；本机系统动画效果关闭时该媒体查询命中，标题/歌词因此永远不滚。小窗的长文本可读性依赖滚动，删除该禁用规则。
3. 右侧空间未利用：`.mini-track-meta` 没有 `flex: 1`，标题/歌词还被写死 `max-width: 210px`（紧凑布局 92px），窗口更宽时右侧留白。改为 meta `flex: 1 1 auto` + 移除各处 `max-width`，文本铺满内容列可用宽度，滚动仅在真正溢出时触发（ScrollingText 按实际容器宽度检测）。

实测（默认 500×190 小窗，悬停显示歌名）：meta 宽度 184 = 内容列 337 − 操作按钮 145 − 间距；长歌名（Fire! (feat. YUQI …)）`is-overflowing` 且动画运行（transform 随时间变化），短歌手（Alan Walker / 宋雨琦 / JVKE）放得下不滚动。

### 12.8 收藏歌单（我喜欢的音乐）顺序错乱

#### 症状

打开网易云“我收藏的歌曲”（我喜欢的音乐）歌单，列表顺序与官方不一致（例如“あのね”排在最前），且与“播放全部”的队列顺序不同。

#### 根因

`resources/plugins/ncm-provider/index.mjs` 里喜欢状态定时刷新 `refreshLikedIdsIfStale()`（以及 `fetchLikedTracks` 的 /likelist 兜底）把 `/likelist` 返回的 id 列表直接写进 `likedSongIdListCache`。`/likelist` 的顺序是“喜欢历史顺序”，与喜欢歌单的真实顺序（`/playlist/detail` / `/playlist/track/all`，最近喜欢在前）不一致；流媒体音乐库的“我收藏的歌曲”分页列表读取该缓存，于是显示成 likelist 顺序。

#### 修复

- `/likelist` 只更新喜欢 ID **集合**（`likedSongIds`，用于喜欢状态判断），不再覆盖有序缓存 `likedSongIdListCache`。
- 有序缓存唯一由 `/playlist/detail` 的 trackIds 维护（与 `/playlist/track/all` 一致，即官方歌单顺序）。
- `fetchLikedTrackIds` 命中缓存时做一致性校验：若喜欢集合里出现了缓存缺失的新歌（或缓存里有已取消喜欢的歌），自动从歌单详情刷新，保证新收藏/取消收藏后列表完整且顺序正确。

#### 真实环境验证

重启 dev 后打开“我收藏的歌曲”：列表以 空奏列車 → Why's this dealer? → Jasmine Flower → … 开头（歌单详情顺序，与播放全部一致），不再以 likelist 顺序（あのね 开头）显示；随后触发 `isTrackLiked`（走 /likelist 刷新），列表顺序保持不变。

回归：`test:plugins` 301 通过 / 1 跳过（新增“likelist 刷新不得打乱喜欢歌单顺序”用例）、`node --check` 语法通过。

### 12.9 本地歌单默认按歌单顺序显示

#### 症状

本地音乐库打开任意歌单（含“我收藏的音乐”）时默认按“标题”升序排列，而不是歌单本身的顺序。

#### 修复

- `src/renderer/src/utils/libraryViewPreferences.ts`：新增 `playlist` 排序键（`compareTracks` 返回 0，稳定排序回落到输入顺序，即歌单存储顺序）；`createDefaultLibraryViewState('playlists')` 默认改为 `playlist`。
- `src/renderer/src/components/SongList.vue`：排序下拉新增“歌单顺序”选项（默认选中）。

回归：`test:cross-cutting-regressions` 18/18（`libraryViewPreferences.test.ts` 新增“playlists 默认歌单顺序且不重排”用例 + 排序键用例）、`typecheck:web` 通过。

### 12.10 深色模式下播放条按钮按下/激活后与背景融为一体

#### 症状

深色主题下播放条按钮点按（`:active`）或保持激活（`.active` 的开关按钮，如音量、HiFi、桌面歌词）时，背景是 7.5% 白色，与近黑播放条几乎同色，按钮像融进背景里看不见。

#### 修复

- `src/renderer/src/assets/base.css`：深色下 `.ctrl-btn:active` / `.icon-btn:active` / `.mode-btn-right:active` 背景提到 `rgba(255,255,255,0.18)`；`.icon-btn.active` 背景同样提到 0.18 并加亮文字。
- `src/renderer/src/components/player-bar/PlayerBar.css`：玻璃态（播放页打开）补上同款 `:active` 按下背景 `rgba(255,255,255,0.16)`。

#### 真实环境验证

深色非玻璃播放条：CDP 真实按下上一首按钮，计算背景 `rgba(255,255,255,0.18)`（之前接近透明）；打开音量抽屉后音量按钮 `.active` 背景 0.18，与播放条底色明显区分。

回归：`test:themes` 71/71（PlayerBar.css 硬编码色 315/319 额度内）、`typecheck:web` 通过。

### 12.11 音乐库用户ID深色模式不可读

#### 症状

流媒体音乐库头部资料卡在深色模式下背景已适配为深色（rgba(29,29,29,0.94)），但用户ID（`.profile-info h1`）仍是浅色主题的硬编码暖棕 `#2a2118`，几乎黑字黑底；签名（`#a08a72`）与统计徽标标签同色系，同样偏暗。

#### 修复

`src/renderer/src/components/StreamingLibrary.vue` 深色覆盖块补充：

- `.profile-info h1` → `var(--te-neutral-900)`（深色 token 为近白 #f7f7f2）。
- `.profile-info h3` / `.profile-info p` / `.stat-badge span` → `var(--te-neutral-500)`（深色 token 为可读的中灰）。

全部使用主题 token，未增加硬编码色值（StreamingLibrary.vue 150/150 额度内）。

#### 真实环境验证

深色音乐库实测：用户ID Bad0RANG3 计算色 `rgb(247,247,242)`，签名与统计标签 `rgb(155,155,155)`，卡片背景 `rgba(29,29,29,0.94)`，对比度正常。

回归：`test:themes` 71/71、`typecheck:web` 通过。

### 12.12 退出播放页再进入后歌词高亮不再更新

#### 症状

播放页退出后重新进入（有时）高亮行卡住不随播放推进：`activeLyricIndex` 正常递增，但 `highlightedLyricIndex` 停在 -1，歌词不再有高亮。

#### 根因

`PlayingMusic.vue` 的 setup 顺序：时钟 watcher（`watch([lyricLines, playbackClockSnapshot, ...], ..., { immediate: true })`）在**高亮 watcher 注册之前**就同步了 `activeLyricIndex`。首次进入时歌词尚未加载，`activeLyricIndex` 在歌词到达后才变化，高亮 watcher 能捕获；再次进入时歌词已缓存，`immediate` 同步直接完成 -1 → 当前行，高亮 watcher 错过这次变化，且无 `immediate` 不会再触发，于是高亮永久停在 -1。

#### 修复

`watch(activeLyricIndex, index => { highlightedLyricIndex.value = index })` 增加 `{ immediate: true }`，挂载时立即把高亮同步到当前活动行；后续行切换仍由 watcher 正常驱动。

#### 真实环境验证

CDP 播放 → 打开播放页（高亮 1 与 active 同步）→ seek 55s（8→9→10 推进）→ 关闭再进入（重进立即 highlighted=12=active，随后 12→13→14 持续推进）。修复前重进后 highlighted 卡在 -1。

回归：`test:lyrics-management` 105/105、`typecheck:web` 通过。
