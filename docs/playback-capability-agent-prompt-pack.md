# Twilight Echo 播放能力分阶段 Agent 提示词包

- **Status**: READY TO COPY
- **Baseline commit**: `15f9567c`
- **Execution checklist**: [`plans/022-playback-capability-gap-execution-checklist.md`](../plans/022-playback-capability-gap-execution-checklist.md)
- **Gap audit**: [`playback-feature-gap-roadmap.md`](./playback-feature-gap-roadmap.md)
- **Purpose**: 为 GPT-5.6 Sol / Terra / Luna 提供可直接复制的单工作包、阶段总控、复核、返工和续作提示词

## 1. 先选运行方式

优先采用“一个 `AP-*` 工作包一个任务”的方式。它的上下文最干净，回滚和复核也最容易。

| 任务类型                               | 推荐模型      | 思考强度                      | 适用工作包                                                        |
| -------------------------------------- | ------------- | ----------------------------- | ----------------------------------------------------------------- |
| 常规实现、跨层接线、测试与文档         | GPT-5.6 Terra | `high`                        | AP-001/002/003、102、201/202/204/205、301/302、304～307、404～408 |
| 高风险架构、原生音频、复杂状态机       | GPT-5.6 Sol   | `xhigh`                       | AP-103/104、303、401、501                                         |
| 最难的原生/协议/算法任务               | GPT-5.6 Sol   | `max`                         | AP-101、105、203、402、403、409、502、503                         |
| 机械性测试、fixture、文案或小型局部 UI | GPT-5.6 Luna  | `medium`；需要判断时用 `high` | 已由 Sol/Terra 定义清楚边界后的子任务                             |

不要默认使用 `ultra`。本计划存在 `AudioPipeline.cpp`、native output、queue/controller 等冲突组；只有阶段确实能拆成互不重叠的独立工作流时才考虑多 Agent。

## 2. 复制前只替换这些变量

以下提示词中的花括号是变量：

- `{AP_ID}`：例如 `AP-204`。
- `{AP_BODY}`：022 清单里从该 AP 标题开始，到下一个 AP 标题前的完整内容。
- `{TASK_NAME}`：当前任务或 Agent 名称，用于 Evidence。
- `{KNOWN_CONTEXT}`：用户额外指定的已知事实；没有就写“无”。
- `{REVIEW_FINDINGS}`：复核结果原文。

如果任务直接运行在当前仓库目录，Agent 可以读取 `plans/022-...md`，无需粘贴 `{AP_BODY}`。

如果使用新 Git worktree，注意仓库当前 `.gitignore` 忽略 `/plans/`：新 worktree 可能看不到 022 清单。此时使用 §4 的 worktree 安全模板，把 `{AP_BODY}` 完整粘进去；不要只给一个 AP 编号。

## 3. 推荐模板：单 AP 完整实现

推荐模型：按 §1 的矩阵选择。每次只替换 `{AP_ID}`、`{TASK_NAME}` 和 `{KNOWN_CONTEXT}`。

```text
你负责完成 Twilight Echo 的 {AP_ID}，目标是把该工作包推进到 REVIEW；只有 Definition of Done 全部满足时才标 DONE。

工作区：D:\Twilight_Echo-Pxasen
基线：15f9567c
任务标识：{TASK_NAME}
额外上下文：{KNOWN_CONTEXT}

开始前必须完整阅读：
1. 仓库根 AGENTS.md；它是最高优先级硬约束。
2. plans/022-playback-capability-gap-execution-checklist.md 的 §0～§3、{AP_ID} 全文、§10 冲突矩阵、§11 并行批次和 §12 追踪表。
3. {AP_ID} 的 Read first、依赖项、验收项和相关权威文档。
4. docs/playback-feature-gap-roadmap.md 中对应 PG 项。

先做只读基线审查：
- 检查 git status、当前 HEAD、相关文件和现有测试；工作树可能已有用户改动，必须保留，不能 reset、checkout 或覆盖。
- 确认 {AP_ID} 的依赖和阶段门禁已满足。未满足时，继续完成所有安全的只读分析和不依赖阻塞项的工作，然后给出可验证的 BLOCKED 证据；不得假装依赖已满足。
- 判断清单描述是否仍与当前代码一致。若代码已部分实现，复用并补齐，不要重写；若清单与代码冲突，以证据说明并更新计划。
- 列出预计改动文件及与其他 AP 的冲突；严格限制在 {AP_ID}，不要顺手实现相邻功能。

执行授权与边界：
- 你已获授权读取文件、编辑 {AP_ID} 范围内的本地代码/测试/文档，并运行非破坏性验证，无需逐步询问。
- 未获授权执行外部写入、发布、购买、真实账号操作、破坏性命令、删除用户数据、提交 commit、推送或扩大工作包范围。
- 只使用 pnpm@11.7.0 和 pnpm-lock.yaml；不得用 npm/yarn，不得直接改 node_modules，不得无依据增加依赖。
- renderer → preload → main → native engine 边界、IPC 七步流程、audioEngineManager 唯一编排者、输出与 DSP 恢复顺序必须保持。
- 离线分析不得进入实时播放 RPC；启用 DSP/SRC/倍速/PCM↔SDM/SDM↔SDM 后不得报告 bit-perfect/source exact。
- 新测试使用 node --test，与被测文件 co-locate，并登记到 test:*；src 下不得新增 TODO/FIXME/HACK。
- 若相关 .vue 超过约 150KB 或 .ts 超过约 100KB，先按 AGENTS.md 做最小必要拆分；不要把新主体逻辑继续塞入 usePlayerStore.ts。

实现要求：
- 按 {AP_ID} 的验收清单逐项完成代码、失败/回退路径、结构化可观察状态、测试、迁移和权威文档同步。
- 先复用仓库现有 controller/service/shared types/测试助手；不要创建重复契约或旁路编排。
- 原生音频热路径不得分配、阻塞、加锁或执行网络/磁盘 I/O；设备拒绝和 helper 崩溃必须可诊断并安全回退。
- 真实设备能力不得用 mock、设备名称猜测或手写 JSON 冒充。无设备时把逻辑验证完成，真实设备命令记为 NOT RUN 并说明缺什么。
- 发现必须新增依赖、改变公开协议、变更数据库/持久化兼容策略或跨越另一个 AP 才能完成时，先停止扩张并报告具体决策点。

验证：
- 先跑 {AP_ID} 指定的最小测试和 AGENTS.md 对应 gate。
- 然后跑 pnpm run lint、pnpm run typecheck、pnpm run format。
- 修改 audio-engine/output/ 或其他原生音频代码时，按 docs/windows-release-gate.md 跑适用的 MinGW configure/build/test；VST3/SMTC/ASIO 的 MSVC 分路径按文档执行。
- 不要只报告“应该通过”；记录实际命令、退出结果。与本工作包无关的既有失败要给出证据并隔离说明。

收尾：
- 回填 022 中 {AP_ID} 的 Status 和 Evidence；同步 §12 追踪表状态。
- Evidence 必须包含 Agent、Commit/working-tree、Changed、Validation、Artifacts、Residual risk。
- 不要仅因为代码写完就标 DONE；有独立复核或真机证据缺口时标 REVIEW，硬件缺失可写“逻辑 DONE / 硬件 BLOCKED”。

最终回复严格包含：
1. Outcome：REVIEW / DONE / BLOCKED。
2. 实现了什么，以及明确未实现什么。
3. 关键变更文件。
4. 实际验证命令与 PASS/FAIL/NOT RUN。
5. 真实设备、许可证、性能和回退残余风险。
6. 022 Evidence 回填位置。

持续工作直到 {AP_ID} 真正达到可交付状态，或出现需要用户权限/外部设备/范围决策的明确阻塞。不要只给计划，不要在安全的本地实现步骤前反复请求确认。
```

## 4. 新 worktree 安全模板

当 Agent 看不到 `/plans/` 时使用。必须把 `{AP_BODY}` 替换为工作包全文。

```text
在当前 Twilight Echo worktree 中完成 {AP_ID}。先完整阅读仓库根 AGENTS.md，并以它为最高约束。基线参考 commit 为 15f9567c；保留所有已有改动，不得 reset、checkout 或覆盖用户工作。

这是从总控计划复制出的完整工作包：

----- {AP_ID} BEGIN -----
{AP_BODY}
----- {AP_ID} END -----

总体验收约束：
- 公共契约只有一个权威类型源；跨进程类型放 src/shared/。
- renderer → preload → main → native engine；新增 IPC 完成注册、共享类型、preload、两份声明、renderer、输入校验、main+preload 测试。
- audioEngineManager 是播放唯一编排者；输出恢复 backend→device→config，DSP 恢复 SetDspPluginChain→ApplyDspState→LoadQueue。
- 失败、回退和当前能力必须结构化可观察；不能静默改变后端、设备或格式。
- 离线分析不得进入实时播放 RPC；真实设备事实不能由 mock 替代。
- 测试用 node --test 且登记到 test:*；只用 pnpm@11.7.0；不改 node_modules；src 下不新增 TODO/FIXME/HACK。
- 完成最小 gate、pnpm run lint、pnpm run typecheck、pnpm run format；原生输出改动按 docs/windows-release-gate.md 验证。

先只读检查依赖、阶段门禁、git status、当前实现和测试。依赖满足后，严格在 {AP_ID} 范围内完成实现、测试、失败路径和权威文档。你已获授权进行范围内本地编辑和非破坏性验证；没有外部写入、提交、推送、破坏性操作或扩大范围的授权。

若缺少真实设备，完成所有软件侧工作并将硬件项记为 NOT RUN；若依赖或许可证门禁失败，给出证据并标 BLOCKED/REJECTED，不得虚构实现。

最终输出 Outcome、实现/未实现、变更文件、实际验证、残余风险，以及可复制回总控计划的以下 Evidence：

- Status: REVIEW/DONE/BLOCKED/REJECTED
- Agent: {TASK_NAME}
- Commit: <sha or working-tree>
- Changed: <paths>
- Validation: <command — result>
- Artifacts: <paths>
- Residual risk: <list or none>
```

## 5. S0 阶段总控提示词：事实与发布基线

推荐：Sol `xhigh` 作为总控；AP-001、AP-002 用 Terra `high`，AP-003 用 Sol/Terra `high`。本阶段允许 AP-001 与 AP-002 并行，AP-003 必须后置。

```text
你是 Twilight Echo 播放能力计划 S0 的阶段总控，负责把 AP-001、AP-002、AP-003 推进到可独立复核状态。工作区是 D:\Twilight_Echo-Pxasen，基线为 15f9567c。

完整阅读 AGENTS.md、plans/022-playback-capability-gap-execution-checklist.md 的 §0～§4、§10～§12，以及 docs/playback-feature-gap-roadmap.md。你被明确授权在支持子 Agent 时进行委派；每个 AP 只能有一个唯一执行 Agent。若环境不支持委派，则按同一顺序串行执行。

调度顺序：
1. 并行执行 AP-001 和 AP-002；两者不得互相覆盖 Evidence 或产品文案。
2. 独立复核 AP-001/002 的事实、构建配置和设备证据，mock 不算真机证据。
3. 只有 AP-001/002 达到 REVIEW/DONE 后执行 AP-003。
4. AP-003 建立 staged capability、runtime capability、README/设置文案的一致性门禁。
5. G0 只有 AP-001～003 全部 DONE 才通过；在此之前不得升级 CUDA、完整 SDM 或未验证设备能力声明。

每个执行 Agent 使用单 AP 模板，只改自己工作包。总控负责处理重叠、复核 Evidence、更新 §12 追踪表，不代替真机结果。允许本地范围内编辑和非破坏性验证；禁止提交、推送、外部写入、破坏性操作和越过 S0 实现后续功能。

阶段最终输出：
- AP-001/002/003 各自状态、执行者和 Evidence。
- G0 PASS/FAIL；FAIL 时列出精确缺口。
- 产品允许声明、禁止声明、未验证声明三张清单。
- 实际运行的测试与文档一致性检查。
- 下一阶段 S1 可启动的 AP；不得自动开始 S1。
```

## 6. S1 阶段总控提示词：输出安全与 DSD 稳定性

推荐：Sol `xhigh` 总控；AP-101、AP-105 用 Sol `max`，AP-103/104 用 Sol `xhigh`，AP-102 用 Terra `high`。native 核心严格串行。

```text
你是 Twilight Echo S1 输出安全阶段总控。目标是按 AP-101→AP-102、AP-103→AP-104→AP-105 的依赖完成 ASIO 隔离、quirk、DSD/DoP 静音过渡、可回滚设备切换和 DSD 域内自动降速率。

先完整阅读 AGENTS.md、022 清单的 §0～§3、§5、§10～§12、docs/windows-release-gate.md 和相关源文件。检查 G0，以及 AP-002 的真实设备证据。你被明确授权在支持子 Agent 时委派，但同一时间只能有一个 Agent 修改 native output 或 AudioPipeline 高冲突文件；每个 AP 一个唯一执行者。

强制顺序和门禁：
1. AP-101：先确定 helper process 崩溃隔离、IPC 契约、超时、清理和回退，再实现；这是 Sol max 任务。
2. AP-102：只在 AP-101 的 helper/driver identity 契约稳定后实现 quirk 注册表。
3. AP-103：基于 AP-002 证据定义 DSD/DoP mute guard 状态机；状态必须结构化可见。
4. AP-104：保持 backend→device→config 事务顺序，失败回滚到上一可用配置，DSD 转换调用 AP-103。
5. G1 通过后才能执行 AP-105；降速率必须在 DSD 域内逐档尝试，设备拒绝时继续下一档或 PCM，并调用 AP-103 保护切换。

不得把 helper mock 当成真实 ASIO 设备，不得静默 fallback，不得在实时回调中分配/锁/阻塞，不得绕过 audioEngineManager。每个 AP 完成指定最小测试、MinGW/MSVC 适用 gate、lint/typecheck/format，并回填 Evidence。无设备时完成逻辑验证，硬件项保留 NOT RUN。

阶段最终输出 AP-101～105 状态、依赖图实际结果、G1 PASS/FAIL、回退状态矩阵、真机证据路径、测试结果和 S2 启动条件。不要自动开始 S2。
```

## 7. S2 阶段总控提示词：设备档案与连续播放

推荐：Sol `xhigh` 总控；AP-203 用 Sol `max`，其余优先 Terra `high`。AP-201 与 AP-205 可并行，AudioPipeline 冲突链严格串行。

```text
你是 Twilight Echo S2 阶段总控，负责 AP-201～AP-205。先完整阅读 AGENTS.md、022 的 §0～§3、§6、§10～§12，以及相关设备、队列、AudioPipeline 和分析服务代码。

前置检查：AP-104 必须稳定；AP-203 还要求 AP-103、AP-105、AP-202 和 G1。你被明确授权按以下边界委派：AP-201 与 AP-205 可并行；AP-202→AP-203→AP-204 涉及连续播放/AudioPipeline 的部分必须按冲突矩阵串行。每个 AP 一个 Agent。

执行目标：
- AP-201 建立完整输出设备档案和原子应用/回滚，音量安全值先于解除静音；完成后判定 G2。
- AP-202 明确定义异格式相邻曲目的 source exact、continuous、transcoded/fallback 状态，不能把有重采样的连续播放称为 bit-perfect。
- AP-203 完成 DSD 专辑 gapless；切换速率、容器或设备能力不足时必须给出诚实状态与安全回退。
- AP-204 补齐 crossfade 曲线和内容规则；与 gapless、DSD、章节/长音频的互斥优先级必须有测试。
- AP-205 只通过 audioAnalysisService 做 ReplayGain/R128 批量分析与安全写回；禁止塞进实时 RPC。

每个 AP 使用单 AP 模板完成实现、测试、权威文档和 Evidence。总控负责检查跨 AP 契约是否只有一份、状态是否一致、AudioPipeline 是否被并发修改。完成最小 gate、test:dsp-graph/test:audio-manager 等适用测试及 lint/typecheck/format；原生改动跑对应工具链。

阶段最终输出 AP-201～205 状态、G2 PASS/FAIL、连续播放状态真值表、DSP/DSD/crossfade 互斥矩阵、实际验证和未完成真机证据。不要自动开始 S3。
```

## 8. S3 阶段总控提示词：队列、长音频与远程体验

推荐：Terra `high` 总控；AP-303 可用 Sol `xhigh`。按 queue、longform、tempo/pitch 三个冲突域组织，最多三路并行。

```text
你是 Twilight Echo S3 阶段总控，负责 AP-301～AP-307。先完整阅读 AGENTS.md、022 的 §0～§3、§7、§10～§12，特别检查 usePlayerStore.ts 文件大小红线、logicalTrackModel 复用要求、remote 安全边界和 G3。

你被明确授权在支持子 Agent 时最多并行三个不重叠工作流，每个 AP 一个执行者：
- Queue 链：AP-301→AP-302→AP-307。
- Longform 链：AP-304→AP-305；AP-306 可在 AP-304 后与 AP-305 并行。
- Audio control：AP-303 独立执行，但若触碰 AudioPipeline，必须避开其他 native 高冲突任务。

实现纪律：
- AP-301 的撤销栈和实际播放历史要区分用户操作、自动推进和失败跳过。
- AP-302 必须复用统一逻辑曲目模型，避免全表 filter/map/slice 热路径。
- AP-303 分离 tempo 与 pitch，明确 DSP/DSD/source-exact 互斥和 CPU 降级。
- AP-304 统一章节契约；AP-305/306 复用，不复制 metadata 类型。
- AP-306 的下载、校验、清理、保留策略必须走路径授权并可恢复。
- AP-307 只有在 store/controller 拆分和 G3 满足后扩展命令面；鉴权、速率限制、输入校验和远程 URL 策略必须测试。

不要把主体逻辑继续塞入 usePlayerStore.ts；建立领域 controller/store 并保持 renderer 性能红线。每个 AP 完成相关 test:playback-routing、test:radio-remote、test:network-sources 或工作包指定 gate，以及 lint/typecheck/format，回填 Evidence。

阶段最终输出 AP-301～307 状态、G3 PASS/FAIL、三条冲突域的实际改动、性能证据、远程威胁模型结果和未完成事项。不要自动开始 S4。
```

## 9. S4 阶段总控提示词：生态与完整 SDM

推荐：Sol `xhigh` 总控；AP-402、AP-403、AP-409 用 Sol `max`。所有工作包先过可行性、许可证、平台和威胁模型门禁；门禁失败应标 REJECTED，而不是强行实现。

```text
你是 Twilight Echo S4 生态与进阶音频阶段总控，负责 AP-401～AP-409。先完整阅读 AGENTS.md、022 的 §0～§3、§8、§10～§12、插件规范、Windows 发布门禁及每个 AP 的 Read first。

本阶段不是“一口气加入所有功能”。每个 AP 分成两个清晰步骤：
A. 只读可行性门禁：协议/格式许可证、再分发条件、平台 API、威胁模型、真实硬件、维护成本、依赖和产品声明。
B. 只有门禁 PASS 且依赖满足后，才创建唯一实现 Agent；门禁 FAIL 时写清证据并标 REJECTED/BLOCKED。

依赖和调度：
- AP-401 依赖 AP-307；AP-402 依赖 AP-201 与 AP-401 或现有 cast transport。
- AP-404/405 依赖 AP-201/G2；AP-408 遵守 AP-002 fixture 规则。
- AP-409 依赖 AP-001、AP-002、AP-103、AP-105，且与 AudioPipeline 冲突链串行。
- AP-403、AP-406、AP-408 不得仅因为 FFmpeg/系统可能支持就扩大产品声明。

AP-409 特别要求：
- 审计现有 PCM SRC、实验性 PCM→DSD64/128/256 和所谓 CUDA 路径的真实实现；先纠正文案，再设计完整 SDM。
- 分开定义 PCM→SDM 与 SDM→SDM；包含调制器、noise shaping、滤波、目标倍率、headroom、稳定性、CPU/GPU 能力探测、自动降级和 artifact。
- CUDA 未真实链接、运行并通过数值/性能验证前，不得声明 CUDA 加速；GPU 路径必须有确定性 CPU fallback。
- 任何转换启用时不得标 bit-perfect/source exact；与 DSP、音量、ReplayGain、tempo/pitch、DSD 输出能力的互斥必须结构化可见。
- 建立离线向量、频谱/噪声带、稳定性、溢出、性能和真机 DAC 验证；没有真机时硬件状态保持 NOT RUN。

允许阶段总控委派相互独立的可行性审查，但不要并发修改共享 native/output、AudioPipeline、shared capability 类型或 settings 音频页面。每个实现 AP 使用单 AP 模板，完成测试、工具链、文档和 Evidence。

阶段最终输出每个 AP 的 FEASIBILITY PASS/FAIL、实现状态、许可证与依赖结论、G4 结果、真实设备证据、允许/禁止产品声明。不要自动开始 S5。
```

## 10. S5 阶段总控提示词：总体验收与发布收口

推荐：Sol `max`。AP-501→AP-502→AP-503 严格串行；本阶段以发现问题和闭环证据为主，不允许为了“全绿”隐瞒 NOT RUN。

```text
你是 Twilight Echo 播放能力计划 S5 总体验收 Agent。先完整阅读 AGENTS.md、022 全文、playback-feature-gap-roadmap.md、windows-release-gate.md、DEVELOPER_README.md 和所有已回填 Evidence。

严格按 AP-501→AP-502→AP-503 串行：
1. AP-501 审查所有跨功能状态、诊断、fallback、source exact/bit-perfect 声明和契约漂移。以代码和测试为证据，不接受口头结论。
2. AP-502 运行按改动面积选择的最小 gate、全局 lint/typecheck/format、test:no-real-device 和适用原生构建/性能检查。既有失败与新增失败分开记录，不跳过失败。
3. AP-503 汇总真实设备 smoke、artifact、发布文档和能力声明；Windows 发布只走 gate:release:win。无硬件项标 NOT RUN/BLOCKED，不伪造证据。

你已获授权修复验收中发现的、本计划 AP 范围内且边界清晰的回归，并运行非破坏性验证；若修复会改变功能设计、引入依赖、触及未批准协议或扩展范围，则停止并形成独立 finding，不自行扩张。

最终交付：
- AP-001～AP-503 的状态总表和未闭环依赖。
- 按严重度排序的 findings；每项给文件/行、影响、复现、修复状态。
- 所有实际验证命令及 PASS/FAIL/NOT RUN，原始 artifact 路径。
- 真机覆盖矩阵和未覆盖设备。
- 文档/runtime/staged capability 一致性结果。
- 发布结论：READY / NOT READY，并列出唯一剩余条件。

只有全部必需 Definition of Done 和发布门禁满足时才能给 READY。不要把“代码已写”“mock 通过”或“当前没有设备”解释为真实设备通过。
```

## 11. 独立复核提示词

推荐：实现用 Terra 时由 Sol `xhigh` 复核；Sol max 的原生任务可再用另一条 Sol `xhigh/max` 任务复核。复核任务默认只读。

```text
独立复核 Twilight Echo 的 {AP_ID}。你不是实现者，本轮默认只读：不得修改代码、计划状态或 Evidence，除非我之后明确要求修复。

工作区：D:\Twilight_Echo-Pxasen
基线：15f9567c

完整阅读 AGENTS.md、022 的 §0～§3、{AP_ID}、§10～§12、对应 PG 文档，以及当前 git diff 和 {AP_ID} Evidence。根据当前代码审查，不依赖实现者总结。

复核维度：
- 工作包验收项和依赖/阶段门禁是否真的满足。
- renderer/preload/main/native 边界、IPC 七步、共享类型单一来源。
- audioEngineManager 编排、输出/DSP 恢复顺序、实时线程安全。
- 失败、超时、取消、回滚、崩溃恢复和 capability 状态是否可观察。
- bit-perfect/source exact、DSD/DoP/SDM/CUDA 等产品声明是否与运行事实一致。
- 测试是否会真正失败于回归，而非只验证 mock 或实现细节；测试是否被 test:* 覆盖。
- 性能、路径/URL 授权、持久化迁移、许可证和真实设备证据。
- 是否误伤用户已有改动，是否越过 {AP_ID} 范围。

可以运行非破坏性只读检查和相关测试。不要用猜测填补证据。

最终只输出：
1. Findings，按 P0/P1/P2/P3 排序；每项包含准确文件与行号、触发条件、影响、证据和最小修复建议。
2. 无 finding 时明确写“未发现阻止 {AP_ID} 进入 DONE 的问题”，并列残余测试/真机限制。
3. 验证命令及结果。
4. 建议状态：REVIEW / DONE / BLOCKED / REJECTED，以及理由。

不要复述整份实现，不要把风格偏好当缺陷；只报告可操作、可证实的问题。
```

## 12. 按复核意见返工提示词

```text
继续完成 Twilight Echo 的 {AP_ID}，只处理下面的独立复核 findings，并保持原工作包范围。先重新阅读 AGENTS.md、{AP_ID}、当前 diff 和 Evidence；保留用户已有改动。

复核 findings：
----- FINDINGS BEGIN -----
{REVIEW_FINDINGS}
----- FINDINGS END -----

逐项验证 finding 是否仍成立：成立则做最小根因修复并补回归测试；不成立则用代码/测试证据说明，不要为了迎合复核而改动。不得顺手重构无关区域，不得降低断言、跳过 gate 或把真实设备失败改成 mock 通过。

你已获授权进行 {AP_ID} 范围内的本地编辑和非破坏性验证；没有外部写入、提交、推送、破坏性操作或范围扩张授权。

完成工作包指定测试、适用 gate、pnpm run lint、pnpm run typecheck、pnpm run format，并更新 {AP_ID} Evidence。最终按 finding 编号列出 FIXED / NOT REPRODUCIBLE / BLOCKED、变更文件、实际验证和建议状态。
```

## 13. 中断后续作提示词

```text
续作 Twilight Echo 的 {AP_ID}。不要从头重写，也不要假设上次总结准确。

先完整阅读 AGENTS.md、022 中 {AP_ID} 及其 Evidence，然后检查 git status、git diff、相关测试输出和当前源代码。识别已经完成、部分完成、未开始、失败或被外部条件阻塞的验收项。保留所有已有改动，不得 reset/checkout。

从第一个未满足的验收项继续，严格限制在 {AP_ID}。你已获授权进行范围内本地编辑和非破坏性验证；没有提交、推送、外部写入、破坏性操作或扩大范围授权。不要重复已经有有效证据的昂贵步骤，除非相关代码在之后发生了变化。

完成后运行受影响的最小测试与必要全局 gate，更新 Evidence。最终给出本轮新增完成项、仍未完成项、实际验证、残余风险和建议状态。
```

## 14. 可行性门禁专用提示词

适合 S4，也适合任何可能引入新协议、编解码器、驱动 SDK 或 GPU 依赖的工作包。默认只读，不实现。

```text
只做 Twilight Echo {AP_ID} 的可行性门禁，不实现功能、不安装依赖、不修改源代码。完整阅读 AGENTS.md、{AP_ID}、对应 PG 项、插件规范、发布门禁和当前相关实现。

必须查清并引用证据：
- 用户价值与现有功能是否重复。
- 可用平台 API/库、维护状态、许可证、再分发和专利风险。
- Windows/其他目标平台与 MinGW/MSVC 工具链可行性。
- renderer/preload/main/native 或 pluginHost 的正确归属。
- 实时线程、延迟、内存、CPU/GPU、崩溃隔离和安全威胁。
- 真实硬件/账号/服务依赖，以及可自动化的测试和必须人工执行的 smoke。
- 最小可交付范围、明确不做的范围、失败回退和产品声明。

需要最新外部事实时只使用官方或上游一手资料。不要把“理论可行”写成“已支持”。

最终给出 FEASIBILITY PASS / BLOCKED / REJECTED；附证据链接、推荐架构、依赖与许可证清单、风险、验收测试、预计冲突文件，以及可直接写回 {AP_ID} 的门禁结论。PASS 也不要开始实现。
```

## 15. Luna 子任务模板

Luna 只接边界已经由 Sol/Terra 定义清楚的机械任务。不要让 Luna 独立决定 DSP 算法、原生线程模型、协议/许可证或跨阶段架构。

```text
完成 Twilight Echo {AP_ID} 下的这个已限定子任务：
<在这里粘贴唯一、具体的子任务和允许修改文件>

完整阅读 AGENTS.md、{AP_ID} 和被测模块。只允许修改上面列出的文件；如果完成需要改变公共契约、增加 IPC、引入依赖、触碰 AudioPipeline/native output 或扩大到其他 AP，停止并报告给上级 Agent，不自行设计。

复用现有测试助手和类型；使用 node --test、pnpm@11.7.0；不得改 node_modules，不得降低断言，不得新增 TODO/FIXME/HACK。运行指定最小测试和格式化，最终报告变更、命令结果和需要上级 Agent 判断的问题。
```

## 16. 给阶段总控补充任务时的短提示词

```text
继续 S{阶段号}，只处理 {AP_ID}。先检查 022 当前状态、依赖门禁、冲突组和已有 Evidence；不要重复派发已有唯一执行者的 AP。使用本提示词包 §3 的单 AP 规则，完成后独立复核并更新阶段汇总。不要自动进入下一阶段。
```

## 17. 实际派发示例

### 示例 A：Terra high 执行 AP-204

复制 §3，把变量替换为：

```text
{AP_ID} = AP-204
{TASK_NAME} = ap204-crossfade-terra-high
{KNOWN_CONTEXT} = AP-202 已 DONE；不得并发修改 AudioPipeline.cpp。
```

### 示例 B：Sol max 执行完整 SDM AP-409

复制 §3，把变量替换为：

```text
{AP_ID} = AP-409
{TASK_NAME} = ap409-sdm-sol-max
{KNOWN_CONTEXT} = 先核验 AP-001/AP-002/AP-103/AP-105 与 G1；CUDA 只有真实链接、运行和数值/性能验证后才能声明。PCM→SDM 与 SDM→SDM 都必须覆盖。
```

### 示例 C：只审查 AP-409 可行性

复制 §14，把 `{AP_ID}` 替换为 `AP-409`。这一步适合在购买硬件、引入 CUDA 或选择调制器实现之前执行。

## 18. 使用纪律

- 不要把六个阶段一次性塞给一个普通执行任务；以阶段总控或单 AP 方式推进。
- 不要同时派两个 Agent 修改同一冲突组；022 §10 的顺序高于“并行更快”。
- 实现 Agent 和复核 Agent 尽量分开；复核结论回到原 Agent 用 §12 修复。
- 每次新任务都让 Agent 重新读取 `AGENTS.md`，不要复制一份过期规则到提示词里替代它。
- 提示词中写清可做的本地操作和必须停下的外部/破坏性动作，避免 Agent 对安全操作反复请求批准。
- 阶段结束先看门禁和 Evidence，再决定下一阶段；不要根据“回复看起来完成了”判断完成。
