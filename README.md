# Twilight Echo

<p align="center">
  <img src="./assets/logo.png" width="520" alt="Twilight Echo" />
</p>

<p align="center">
  一款为本地收藏、流媒体探索与 HiFi 播放打造的现代桌面音乐播放器。
</p>

<p align="center">
  <a href="https://github.com/asenyarzc-cpu/Twilight_Echo/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/asenyarzc-cpu/Twilight_Echo?display_name=tag&style=flat-square" /></a>
  <img alt="Windows" src="https://img.shields.io/badge/Windows-10%20%2F%2011-2563eb?style=flat-square&logo=windows11&logoColor=white" />
  <img alt="Version" src="https://img.shields.io/badge/version-1.1.4-0f766e?style=flat-square" />
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-64748b?style=flat-square" /></a>
</p>

<p align="center">
  <a href="https://github.com/asenyarzc-cpu/Twilight_Echo/releases/latest"><strong>下载最新版</strong></a>
  ·
  <a href="#功能一览">功能一览</a>
  ·
  <a href="#界面预览">界面预览</a>
  ·
  <a href="#支持的音频格式">格式支持</a>
  ·
  <a href="https://github.com/asenyarzc-cpu/Twilight_Echo/issues">问题反馈</a>
</p>

![Twilight Echo 本地音乐主页](./assets/screenshots/local-dashboard.png)

## 认识 Twilight Echo

Twilight Echo 希望把散落在硬盘、歌单和不同音乐服务里的收藏，放回同一套清晰、流畅的聆听体验中。它既能管理大型本地音乐库，也能通过内置网易云音乐服务和可选扩展探索在线内容；播放端则由独立的 C++20 原生音频引擎负责，为 Windows 用户提供从日常共享模式到 WASAPI 独占、DSP 调音和 DSD 播放的一体化路径。

你可以把它当作一个开箱即用的桌面播放器，也可以进一步配置歌词、均衡器、主题、迷你播放器、播客、电台和扩展中心，搭建属于自己的音乐工作台。

> [!NOTE]
> Windows 10/11 是当前主要且验证最完整的平台。macOS 与 Linux 后端已有实现，但尚未达到正式发布验证标准。

## 界面预览

### 在线音乐与歌单发现

从每日推荐、私人 FM、私人雷达到分类歌单、搜索和个人收藏，在统一的播放器中继续聆听。

<table>
  <tr>
    <td width="50%"><img src="./assets/screenshots/streaming-home.png" alt="在线音乐主页与每日推荐" /></td>
    <td width="50%"><img src="./assets/screenshots/playlist-discovery.png" alt="分类歌单发现" /></td>
  </tr>
  <tr>
    <td align="center">每日推荐与个性化入口</td>
    <td align="center">多维分类、语种、风格与场景筛选</td>
  </tr>
</table>

![流媒体歌单与播放队列](./assets/screenshots/streaming-playlist.png)

### 沉浸式歌词

逐行同步歌词、翻译歌词、封面取色与深浅主题共同组成专注的正在播放页面；也可以切换桌面歌词或迷你播放器，在其他应用上方继续查看进度。

![沉浸式双语歌词界面](./assets/screenshots/immersive-lyrics.png)

### 本地音乐库

音乐会按歌曲、艺术家、专辑、流派、歌单和文件夹组织。大型列表采用虚拟化呈现，增量扫描避免每次启动都重新解析整座音乐库。

![本地音乐库歌曲视图](./assets/screenshots/local-library.png)

### HiFi、DSP 与耳机校正

信号链状态、输入/输出格式与处理模块清晰可见。图形均衡器、参数均衡器和 OPRA/AutoEQ 耳机校正既可以直接使用，也能作为 DSP Rack 的一部分组合。

<table>
  <tr>
    <td width="50%"><img src="./assets/screenshots/dsp-processor.png" alt="DSP 处理器与信号链" /></td>
    <td width="50%"><img src="./assets/screenshots/equalizer-autoeq.png" alt="图形均衡器与 OPRA AutoEQ 耳机校正" /></td>
  </tr>
  <tr>
    <td align="center">处理状态、旁路与输出诊断</td>
    <td align="center">图形/参数均衡器与耳机补偿</td>
  </tr>
</table>

![音频频谱、波形与响度可视化](./assets/screenshots/audio-visualizer.png)

### 扩展中心

通过 <code>.tep</code> 包安装、启用、更新或移除扩展。除内置网易云音乐源外，其他在线音乐源和 UI 能力可由独立扩展提供。

![Twilight Echo 扩展中心](./assets/screenshots/extension-center.png)

> 截图中的 Bilibili 与 YouTube Music 音源是可选第三方扩展示例，并非应用内置服务；可用性取决于扩展版本、所在地区、登录状态及对应平台服务条款。

## 功能一览

### 本地音乐库与收藏管理

- 递归扫描多个音乐文件夹，并在启动时根据路径、大小和修改时间进行增量更新。
- 按歌曲、艺术家、专辑、流派、文件夹、歌单和最近播放浏览音乐。
- 读取歌曲信息、内嵌封面和歌词；支持手动完整重扫、暂停、继续与取消。
- 大型歌曲列表虚拟滚动，适合上万首规模的本地曲库。
- 收藏、最近播放、播放统计和上次播放会话持久保存。
- 创建、编辑、导入与导出播放列表，并对并发修改进行保护。
- 支持本地标签编辑、重复歌曲检测与整理。
- 支持 CUE 分轨：可将整轨音频按曲目区间加入音乐库并正确跳转播放。
- 监听已授权音乐目录的文件变化，减少手动刷新操作。

### 在线音乐、广播与播客

- 内置网易云音乐提供者：二维码登录、每日推荐、私人 FM、私人雷达、搜索、歌单、艺人、收藏与双语歌词。
- 本地内容与不同提供者的搜索结果可以统一展示，收藏和最近播放会按歌曲身份合并。
- 发现歌单支持语种、风格、场景、情感与主题等多维筛选。
- 网络电台搜索、收藏和播放；RSS 播客订阅、节目浏览与收听。
- 通过扩展中心接入更多 provider、主题、工具或受宿主约束的界面入口。

### 播放、队列与歌词

- 播放/暂停、上一首/下一首、进度跳转、音量、静音和播放队列管理。
- 顺序播放、列表循环、单曲循环与随机播放。
- 恢复播放会话；音频服务异常重启后由用户确认继续，避免意外自动出声。
- 同步歌词、翻译歌词和逐字歌词展示，并支持本地歌词导入、保存与来源管理。
- 沉浸式正在播放页面、桌面歌词、托盘播放器和可定制迷你播放器。
- 全局快捷键、系统媒体键、托盘控制以及 Discord Rich Presence。
- 睡眠定时器支持结束前渐弱，并正确处理静音和音量恢复。

### 原生音频与输出设备

- 自研 C++20 原生音频引擎，使用独立服务进程隔离播放与离线分析任务。
- Windows 支持 WASAPI Shared 与 WASAPI Exclusive；共享模式经过系统混音，独占模式可在设备允许时进行格式直通。
- Windows x64 包含独立的 ASIO 兼容层；当前属于实验性能力，需要兼容设备和显式启用，不作为默认可用承诺。
- 输出后端、设备、采样格式、缓冲设置与设备能力诊断均可在应用内查看和切换。
- 支持 DoP，以及 SACD ISO、DSF、DFF 等 DSD 内容；具体可用模式由音频设备、驱动和当前后端决定。
- WASAPI 与 CoreAudio 没有平台级 native DSD 通道，会使用 DoP 或 PCM 回退；Linux 仅在兼容的 ALSA <code>hw:</code> 设备上尝试 native DSD。
- 音频服务崩溃可重启并恢复输出配置、DSP 状态和队列，但不会擅自自动续播。

### DSP、均衡器与音频分析

- 图形均衡器与参数均衡器，支持预设、频响曲线和高级滤波参数。
- OPRA/AutoEQ 耳机校正资料，可搜索设备型号并叠加校正曲线。
- 可编排 DSP Rack：包括 ReplayGain/Loudnorm、均衡器、动态均衡器、卷积、交叉馈送、声道矩阵、压缩器、多段压缩、立体声场、响度轮廓、True Peak Limiter 等模块。
- 导入 REW、Equalizer APO、AutoEq 配置和卷积脉冲响应。
- 防破音、预增益、缺失 ReplayGain 标签时的回退增益、耳机保护与 DSP 一键旁路。
- 本地曲目 BPM 与响度后台分析和缓存，不阻塞实时播放链路。
- 独立音频可视化页面显示频谱、波形、播放位置、BPM、动态范围、响度与文件参数。
- DSD 与 passthrough 路径会自动绕过不安全的 PCM DSP，避免错误处理原始数据流。
- VST3 宿主仅在完整的 Windows x64 构建中可用，实际兼容性取决于第三方插件。

### 外观、主题与桌面体验

- 浅色、深色与跟随系统主题，并支持从当前封面提取强调色。
- 主题工作室可调整颜色、字体、背景、材质、圆角、导航、歌曲列表、播放器、歌词和独立窗口外观。
- 主题配置支持预览、撤销/重做、导入、导出与恢复默认值。
- 主窗口、迷你播放器、托盘播放器和桌面歌词可共享主题，也可以分别覆盖部分样式。
- 尊重系统减少动态效果设置，并保留键盘焦点和可访问性提示。

### 扩展、安全与更新

- 扩展在隔离的宿主进程中运行，只能通过版本化的 Twilight API 访问被授权能力。
- 支持本地 <code>.tep</code> 安装、静态扩展索引、启用/禁用、更新、卸载、依赖检查、权限展示和日志查看。
- provider 扩展负责在线音乐来源；主题扩展只提供受限样式，不执行任意主题脚本。
- 应用可检查 GitHub Releases 更新，下载完整安装程序并在安装前核对可用的 SHA-256。
- 设置提供缓存策略、设置备份/还原、快捷键状态和输出诊断。

## 支持的音频格式

<code>.mp3</code> <code>.flac</code> <code>.wav</code> <code>.wave</code> <code>.aac</code> <code>.ogg</code> <code>.wma</code> <code>.m4a</code> <code>.mp4</code> <code>.aiff</code> <code>.aif</code> <code>.opus</code> <code>.webm</code> <code>.alac</code> <code>.ape</code> <code>.wv</code> <code>.dsf</code> <code>.dff</code> <code>.mqa</code>

实际解码与输出能力取决于操作系统、构建中包含的解码器、音频驱动和设备。Windows 是当前覆盖最完整的平台。

> <code>.mqa</code> 会按 FLAC 兼容容器进行扫描与解码；Twilight Echo 不提供或宣称 MQA unfold、认证或授权能力。

## 下载与安装

### Windows 10 / 11

1. 前往 [Releases](https://github.com/asenyarzc-cpu/Twilight_Echo/releases/latest)。
2. 下载名称以 <code>-setup.exe</code> 结尾的安装程序。
3. 如果 Release 同时提供 <code>.sha256</code> 文件，请在安装前核对校验值。
4. 运行安装程序并按向导完成安装。

当前 Windows 安装包由个人开发者发布，**没有商业代码签名证书**，因此 Windows SmartScreen 可能显示“未知发布者”。请只从本项目的 GitHub Releases 下载，并核对发布页提供的 SHA-256。可在 PowerShell 中运行：

<pre><code>Get-FileHash ./TwilightEcho-1.1.4-setup.exe -Algorithm SHA256</code></pre>

项目发布检查仍会验证安装包品牌信息、依赖闭包、原生二进制剥离、体积预算和 SHA-256 生成；代码签名不属于个人项目的发布门槛。

### macOS / Linux

CoreAudio 与 ALSA 后端已存在，但目前没有经过与 Windows 同等级别的发布和真实设备验证。现阶段建议普通用户使用 Windows 版本；macOS/Linux 构建仅供开发、测试和贡献使用。

## 使用提示与限制

- 在线音乐、歌词、电台和播客依赖网络、内容提供者及所在地区；接口或平台策略变化可能影响可用性。
- 网易云音乐能力由随应用提供的 provider 服务实现，账号登录与内容使用应遵守对应服务条款。
- 可选第三方扩展由各自作者维护。本项目不保证截图中所有第三方服务在每个地区长期可用。
- WASAPI Shared 会经过 Windows 系统混音，这是该模式的正常行为；追求设备直通时可在兼容设备上尝试 Exclusive。
- Native DSD、DoP、ASIO、WASAPI Exclusive、SACD ISO 与 VST3 都高度依赖真实硬件、驱动、曲目和插件，请以应用中的设备能力与输出诊断为准。
- 应用不会将 <code>.mqa</code> 文件描述为已完成 MQA 解码或认证。

## 扩展与开发

普通用户可在应用的“扩展中心”管理插件。插件作者和项目贡献者可以从以下文档开始：

- [开发者文档](./docs/DEVELOPER_README.md)
- [插件开发指南](./docs/PLUGIN_README.md)
- [插件规范](./docs/twilight-echo-plugin-spec.md)
- [Windows 发布检查](./docs/windows-release-gate.md)
- [第三方插件仓库](https://github.com/asenyarzc-cpu/Twilight-Echo-plugins)

从源码运行需要 Node.js 22 与项目锁定的 <code>pnpm@11.7.0</code>：

<pre><code>corepack enable
pnpm install --frozen-lockfile
pnpm run dev</code></pre>

原生音频引擎和各平台打包还需要额外工具链；请勿把上述三条命令视为完整发布构建说明。

## 反馈与贡献

- 遇到问题或希望提出建议：[提交 Issue](https://github.com/asenyarzc-cpu/Twilight_Echo/issues)
- 下载历史版本：[查看 Releases](https://github.com/asenyarzc-cpu/Twilight_Echo/releases)
- 提交代码前请先阅读开发者文档，并使用项目规定的 pnpm 工作流。

反馈问题时，建议附上 Twilight Echo 版本、Windows 版本、音频输出后端、设备/驱动名称、复现步骤和相关日志；音频问题如涉及 DSD、ASIO 或独占模式，也请注明文件格式与采样参数。

## 致谢

- 沉浸式歌词舞台基于 [AMLL / Apple Music-like Lyrics](https://github.com/amll-dev/applemusic-like-lyrics) 的歌词渲染能力实现。感谢 AMLL 项目维护者和贡献者提供出色的开源歌词动画与逐词渲染方案。
- AMLL 以 **AGPL-3.0-only** 许可证发布；本项目使用该依赖时应同时遵守其许可证要求。

## License

Twilight Echo 采用 [Apache License 2.0](./LICENSE) 开源。

第三方依赖、字体、图标、在线服务接口、插件和内容素材分别受各自许可证或服务条款约束。项目名称或界面中出现的第三方服务商标归其权利人所有；Twilight Echo 与这些服务不存在官方隶属或背书关系。
## 支持与赞助

如果你喜欢 Twilight Echo，欢迎通过 [爱发电](https://afdian.com/a/pxasen) 支持本项目。你的支持将帮助它持续改进，感谢每一位用户与贡献者。
