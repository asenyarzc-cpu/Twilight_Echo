# Twilight Echo 文档索引

本目录只保留当前项目仍在使用的规范、架构说明、功能契约、操作指南、法律依据，以及被测试或发布流程引用的机器可读证据。

## 开发与架构

- [开发者文档](./DEVELOPER_README.md)
- [Agent 架构与维护指南](./agent-architecture-guide.md)
- [高内聚低耦合维护执行方案](./architecture-maintainability-action-plan.md)
- [音频引擎架构](./twilight-audio-engine-architecture.md)
- [音频引擎 API](./audio-engine-api.md)
- [安全加固边界](./security-hardening.md)
- [UI、歌词与播放时钟重构审计](./ui-playback-refactor-audit.md)
- [项目结构审查与改进清单（2026-08-15）](./structure-review-2026-08-15.md)
- [安全 / UI 阴影与错位 / 交互逻辑审查（2026-08-01）](./audit-security-ui-ux-2026-08-01.md)
- [音量重启恢复问题交接（2026-08-09）](./volume-restore-handoff-2026-08-09.md)

## 音频、设备与发布

- [播放能力缺口与路线图](./playback-feature-gap-roadmap.md)
- [发布能力状态](./release-capability-status.md)
- [ASIO DSD 直通行业调研](./asio-dsd-passthrough-research.md)
- [ASIO helper process 隔离 ADR](./asio-helper-process-adr.md)
- [Windows 发布门禁](./windows-release-gate.md)
- [Windows HiFi 真实设备检查](./windows-phase-6c-smoke-checklist.md)
- [真实设备音频证据规则](./audio-smoke-evidence.md)
- [VST3 宿主工具链](./vst3-host-toolchain.md)

## 插件与主题

- [插件开发导读](./PLUGIN_README.md)
- [插件系统权威规范](./twilight-echo-plugin-spec.md)
- [插件系统实施边界](./twilight-echo-plugin-plan.md)
- [主题插件开发](./theme-plugin-authoring.md)

## 本地库与播放功能

- [播放能力分阶段 Agent 提示词包](./playback-capability-agent-prompt-pack.md)：可直接复制给 GPT-5.6 Sol / Terra / Luna 的单 AP、S0～S5 总控、复核与续作提示词。

- [本地库元数据补全](./local-library-metadata-enrichment.md)
- [本地库移除策略](./local-library-removal-policy.md)
- [本地库排序与筛选](./local-library-sorting-and-filters.md)
- [搜索与跨来源歌曲身份](./search-and-library-identity.md)
- [播放模式](./playback-modes.md)
- [播放队列虚拟化](./playback-queue-virtualization.md)
- [播放列表生命周期](./playlist-lifecycle.md)
- [歌词管理](./lyrics-management.md)
- [CUE 支持](./cue-support.md)
- [标签与重复歌曲检测](./duplicate-detection.md)
- [睡眠定时器与静音](./sleep-timer-and-mute.md)
- [持久化基准](./persistence-benchmark.md)
- [多协议网络音乐源施工文档](./network-music-sources.md)
- [网络音乐源真机验证清单](./network-music-sources-verification.md)

## 设计、Provider 与网络音源

- [Apple Music Inspired HiFi Player 设计系统](./apple-music-inspired-hifi-player-design-system.md)
- [Apple Music Provider 实施与安全计划](./apple-music-provider-plan.md)

## 统计与运营

- [日活与使用统计契约](./telemetry-dau.md)

## 法律与验证证据

- `legal/`：ASIO clean-room 兼容层的来源、决策与互操作规范。
- `audit-evidence/`：测试脚本或发布审查仍引用的机器可读基准证据。

## 文档维护规则

- 不在仓库中保存自动化工作会话的计划、任务拆分、聊天转录、临时检查点或协调状态表。
- 临时实施计划应放在 Issue 或 Pull Request 中，完成后由代码、测试和当前规范承担事实来源。
- 例外：根目录 `plans/` 是编号管理的结构化实施方案（含状态、基线 commit 与验证步骤），按 `plans/README.md` 的执行顺序推进，不属于临时协调状态。
- 同一主题只保留一个权威规范和必要的使用导读；被替代的草案、路线图和重复指南应删除。
- 真实设备或性能证据只有在脚本、发布门禁或当前说明仍引用时才保留。
