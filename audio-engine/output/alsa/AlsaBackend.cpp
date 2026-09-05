#include "AlsaBackend.h"

#include "AlsaRenderUtils.h"
#include "RealAlsaHost.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace twilight::audio {
namespace {

bool exactFormatMatch(const AudioFormat& requested, const AudioFormat& actual) {
  if (isDsdSampleFormat(requested.sampleFormat) || isDsdSampleFormat(actual.sampleFormat)) {
    return dsdFormatsExactMatch(requested, actual);
  }
  return requested.sampleRate == actual.sampleRate && requested.channelCount == actual.channelCount &&
         effectivePcmBitDepth(requested) == effectivePcmBitDepth(actual) &&
         requested.sampleFormat == actual.sampleFormat;
}

bool startsWith(const std::string& value, const char* prefix) {
  return value.rfind(prefix, 0) == 0;
}

std::string formatDescription(const AudioFormat& format) {
  return sampleFormatToString(format.sampleFormat) + " " + std::to_string(effectivePcmBitDepth(format)) + "bit " +
         std::to_string(format.sampleRate) + "Hz " + std::to_string(format.channelCount) + "ch";
}

AudioFormat dopCandidateForRequestedFormat(const AudioFormat& requestedFormat) {
  if (isDopCarrierFormat(requestedFormat)) return requestedFormat;

  AudioFormat candidate;
  candidate.channelCount = requestedFormat.channelCount;
  candidate.bitDepth = 24;
  candidate.sampleFormat = AudioSampleFormat::Int24Interleaved;
  switch (requestedFormat.sampleRate) {
    case 2822400:
      candidate.sampleRate = 176400;
      return candidate;
    case 5644800:
      candidate.sampleRate = 352800;
      return candidate;
    default:
      return {};
  }
}

DopRuntimeFacts unprovenDopRuntimeFacts(
    const AudioFormat& requestedFormat,
    const AudioFormat& actualFormat,
    const std::string& reason) {
  DopRuntimeFacts facts;
  const AudioFormat candidateFormat = dopCandidateForRequestedFormat(requestedFormat);
  const bool dopLikeRequest = requestedFormat.sampleRate >= 2500000 || isDopCarrierFormat(requestedFormat);
  if (!dopLikeRequest && !isDopCarrierFormat(actualFormat)) return facts;

  facts.state = DopRuntimeFactState::Unproven;
  facts.candidateFormat = candidateFormat;
  facts.actualFormat = isDopCarrierFormat(actualFormat) ? actualFormat : AudioFormat{};
  facts.reason = reason;
  return facts;
}

bool isDsdAlsaFormat(AlsaPcmFormat fmt) {
  return fmt == AlsaPcmFormat::DsdU8 || fmt == AlsaPcmFormat::DsdU16Le || fmt == AlsaPcmFormat::DsdU32Le;
}

// ALSA DSD phys_width is in bits per sample (8/16/32). The ALSA sample rate is
// the DSD bit-clock divided by phys_width; actualDsdRate = negotiatedRate * phys_width.
// (kernel sound/soc/codecs/ak4458.c: dsd_bclk = rate * phys_width.)
int dsdPhysWidthBits(AlsaPcmFormat fmt) {
  switch (fmt) {
    case AlsaPcmFormat::DsdU8:
      return 8;
    case AlsaPcmFormat::DsdU16Le:
      return 16;
    case AlsaPcmFormat::DsdU32Le:
      return 32;
    default:
      return 0;
  }
}

size_t alsaBytesPerSample(AlsaPcmFormat fmt) {
  switch (fmt) {
    case AlsaPcmFormat::DsdU8:
      return 1;
    case AlsaPcmFormat::DsdU16Le:
      return 2;
    case AlsaPcmFormat::DsdU32Le:
      return 4;
    case AlsaPcmFormat::S16Le:
      return 2;
    case AlsaPcmFormat::S24_3Le:
      return 3;
    case AlsaPcmFormat::S24Le:
    case AlsaPcmFormat::S32Le:
    case AlsaPcmFormat::FloatLe:
    default:
      return 4;
  }
}

bool isNativeDsdRequest(const AudioFormat& requested) {
  return isDsdSampleFormat(requested.sampleFormat) && effectivePcmBitDepth(requested) == 1 &&
         requested.sampleRate >= 2822400;
}

// Advertised Native DSD rates for a direct hw: device (DSD64/128/256/512, 44.1k family).
const std::vector<int>& nativeDsdAdvertisedRates() {
  static const std::vector<int> rates = {2822400, 5644800, 11289600, 22579200};
  return rates;
}

std::string nativeDsdRuntimeStateName(NativeDsdRuntimeFactState state) {
  switch (state) {
    case NativeDsdRuntimeFactState::Candidate:
      return "candidate";
    case NativeDsdRuntimeFactState::Unproven:
      return "unproven";
    case NativeDsdRuntimeFactState::Mismatch:
      return "mismatch";
    case NativeDsdRuntimeFactState::Proven:
      return "proven";
    case NativeDsdRuntimeFactState::Unsupported:
    default:
      return "unsupported";
  }
}

void applyNativeDsdFactsToOutputInfo(OutputInfo* info, const NativeDsdRuntimeFacts& facts) {
  if (!info) return;
  info->nativeDsdRuntimeState = nativeDsdRuntimeStateName(facts.state);
  info->nativeDsdRequestedRate = facts.requestedDsdRate;
  info->nativeDsdActualRate = facts.actualDsdRate;
  info->nativeDsdChannels = facts.channelCount;
  info->nativeDsdExplicitlyCapable = facts.explicitlyCapable;
  info->nativeDsdAdvertisedSampleRates = facts.advertisedSampleRates;
  info->nativeDsdRuntimeReason = facts.reason;
}

constexpr uint64_t kDefaultAlsaPeriodFrames = 512;
constexpr uint64_t kTargetAlsaBufferPeriods = 8;

}  // namespace

struct AlsaBackend::Impl {
  mutable std::mutex mutex;
  RenderCallback callback;
  OutputEventCallback eventCallback;
  OutputConfig outputConfig;
  AudioFormat outputFormat;
  OutputInfo outputInfo;
  DopRuntimeFacts dopRuntimeFacts;
  OutputInfo::Diagnostics diagnostics;
  std::string deviceId = "default";
  std::string deviceName = "ALSA default";
  std::atomic<bool> running{false};
  std::atomic<bool> stopRequested{false};
  std::atomic<bool> recoveryQueued{false};
  std::atomic<int> queuedRecoveryCode{0};
  std::atomic<int> queuedRecoveryKind{0};
  std::atomic<const char*> queuedRecoveryMessage{nullptr};
  std::mutex threadMutex;
  std::mutex recoveryMutex;
  std::condition_variable recoveryCv;
  std::thread renderThread;
  std::thread recoveryThread;
  std::vector<float> renderScratch;
  std::vector<uint8_t> packedScratch;
  bool packedScratchDsdSilence = false;
  std::unique_ptr<IAlsaHost> host;
  AlsaPcmFormat pcmFormat = AlsaPcmFormat::FloatLe;
  uint64_t periodSize = 512;
  uint64_t bufferSize = 2048;
  size_t bytesPerFrame = 0;

  // Native DSD state. dsdMode is true when a DSD ALSA format (DsdU8/U16Le/U32Le) was
  // negotiated. dsdPhysWidthBits is 8/16/32. dsdWriteProven flips to true after the first
  // successful host_->writei of DSD data, promoting nativeDsdFacts to Proven.
  TypedRenderCallback typedCallback;
  bool dsdMode = false;
  int dsdPhysWidthBits = 0;
  int dsdRequestedBitClock = 0;
  std::atomic<bool> dsdWriteProven{false};
  NativeDsdRuntimeFacts nativeDsdFacts;
  std::vector<uint8_t> typedScratch;
  std::vector<uint8_t> dsdRepack;

  struct FormatCandidate {
    AlsaPcmFormat alsaFormat;
    AudioSampleFormat sampleFormat;
    int bitDepth;
    const char* label;
  };

  enum class RenderLoopKind {
    Float,
    Typed
  };

  std::string alsaError(const char* context, int code) const {
    return std::string(context) + ": " + (host ? host->strError(code) : std::string("ALSA host unavailable"));
  }

  static std::string normalizeDeviceId(const std::string& requested) {
    if (requested.empty() || requested == "auto") return "default";
    if (requested.rfind("alsa:", 0) == 0) return requested.substr(5);
    return requested;
  }

  static bool isDirectHwDevice(const std::string& id) {
    return startsWith(id, "hw:");
  }

  static bool isPlugHwDevice(const std::string& id) {
    return startsWith(id, "plughw:");
  }

  static std::string pluginPathReason(const std::string& id) {
    if (id == "default") {
      return "ALSA default 可能经过 dmix/plug 插件链，无法证明硬件直通";
    }
    if (isPlugHwDevice(id)) {
      return "ALSA plughw: 可能自动转换采样率、位深或声道，无法证明硬件直通";
    }
    if (id == "null") {
      return "ALSA null 是测试输出设备，不是硬件直通路径";
    }
    return "ALSA 输出未使用 hw: 直连设备，可能经过插件链或格式转换";
  }

  static std::string formatMismatchReason(const AudioFormat& requested, const AudioFormat& actual) {
    return "ALSA hw: 实际输出格式与请求格式不完全匹配: requested " + formatDescription(requested) +
           ", actual " + formatDescription(actual);
  }

  static std::vector<FormatCandidate> candidatesFor(const AudioFormat& requested) {
    const int bitDepth = effectivePcmBitDepth(requested);
    std::vector<FormatCandidate> candidates;
    auto add = [&](AlsaPcmFormat alsa, AudioSampleFormat format, int depth, const char* label) {
      const auto duplicate = std::find_if(candidates.begin(), candidates.end(), [&](const FormatCandidate& item) {
        return item.alsaFormat == alsa;
      });
      if (duplicate == candidates.end()) candidates.push_back(FormatCandidate{alsa, format, depth, label});
    };

    // Early DSD branch — MUST precede PCM branches. effectivePcmBitDepth returns 1 for DSD,
    // which would wrongly select S16_LE in the PCM branches below. MPD probe order: U8 → U32_LE → U16_LE.
    // SACD/ALSA DSD_U8 is MSB-first, so map to DsdInt8Msb1. U16_LE/U32_LE are ALSA transport packings
    // of the same 8-bit MSB-first DSD bitstream (no DsdInt16/Int32 exists in AudioSampleFormat).
    if (isNativeDsdRequest(requested)) {
      add(AlsaPcmFormat::DsdU8, AudioSampleFormat::DsdInt8Msb1, 1, "dsd_u8");
      add(AlsaPcmFormat::DsdU32Le, AudioSampleFormat::DsdInt8Msb1, 1, "dsd_u32_le");
      add(AlsaPcmFormat::DsdU16Le, AudioSampleFormat::DsdInt8Msb1, 1, "dsd_u16_le");
      return candidates;
    }

    if (requested.sampleFormat == AudioSampleFormat::Float32Interleaved || bitDepth >= 32) {
      add(AlsaPcmFormat::FloatLe, AudioSampleFormat::Float32Interleaved, 32, "float32");
      add(AlsaPcmFormat::S32Le, AudioSampleFormat::Int32Interleaved, 32, "s32");
    }
    if (bitDepth == 24) {
      add(AlsaPcmFormat::S24_3Le, AudioSampleFormat::Int24Interleaved, 24, "s24_3le");
      add(AlsaPcmFormat::S24Le, AudioSampleFormat::Int24In32Interleaved, 24, "s24_le");
    }
    if (bitDepth <= 16) {
      add(AlsaPcmFormat::S16Le, AudioSampleFormat::Int16Interleaved, 16, "s16");
    }

    add(AlsaPcmFormat::FloatLe, AudioSampleFormat::Float32Interleaved, 32, "float32");
    add(AlsaPcmFormat::S32Le, AudioSampleFormat::Int32Interleaved, 32, "s32");
    add(AlsaPcmFormat::S24_3Le, AudioSampleFormat::Int24Interleaved, 24, "s24_3le");
    add(AlsaPcmFormat::S24Le, AudioSampleFormat::Int24In32Interleaved, 24, "s24_le");
    add(AlsaPcmFormat::S16Le, AudioSampleFormat::Int16Interleaved, 16, "s16");
    return candidates;
  }

  static size_t bytesPerSample(AudioSampleFormat format) {
    return alsa::pcmBytesPerSample(format);
  }

  void pack(const float* input, size_t frames, int channels) {
    const size_t bytesPerSampleValue = bytesPerSample(outputFormat.sampleFormat);
    bytesPerFrame = bytesPerSampleValue * static_cast<size_t>(channels);

    // Defensive only: DSD cannot be synthesized from float. start() refuses this path for dsdMode.
    // Keep DSD silence fill so a miswired caller still outputs a valid DSD mute pattern instead of garbage.
    // Real DSD audio is delivered exclusively through startTyped()/typed render loop.
    if (isDsdSampleFormat(outputFormat.sampleFormat)) {
      alsa::prepareDsdSilenceScratchNoResize(packedScratch, frames * bytesPerFrame, packedScratchDsdSilence);
      (void)input;
      return;
    }

    bytesPerFrame =
        alsa::packFloatScratchToPcmScratchNoResize(input, frames, channels, outputFormat.sampleFormat, packedScratch);
    packedScratchDsdSilence = false;
  }

  void recordXrun(const std::string& message) {
    std::unique_lock lock(mutex, std::try_to_lock);
    if (!lock.owns_lock()) return;
    ++diagnostics.sessionUnderrunCount;
    ++diagnostics.lifetimeUnderrunCount;
    ++diagnostics.sessionRecoveryCount;
    ++diagnostics.lifetimeRecoveryCount;
    diagnostics.lastError = message;
    outputInfo.diagnostics = diagnostics;
    outputInfo.deviceRecovered = true;
    outputInfo.recoveryCount = static_cast<int>(diagnostics.sessionRecoveryCount);
  }

  bool recoverFromWriteError(int code) {
    if (!host || !host->isOpen()) return false;
    if (code == kAlsaErrEpipe) {
      recordXrun("ALSA xrun recovered with snd_pcm_prepare");
      return host->prepare() >= 0;
    }
    if (code == kAlsaErrEstrpipe) {
      recordXrun("ALSA suspend recovered with snd_pcm_prepare");
      while (!stopRequested.load()) {
        const int resume = host->resume();
        if (resume == 0) return host->prepare() >= 0;
        if (resume != kAlsaErrEagain) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
      }
      return host->prepare() >= 0;
    }
    {
      std::unique_lock lock(mutex, std::try_to_lock);
      if (lock.owns_lock()) {
        diagnostics.lastError = alsaError("ALSA write failed", code);
        outputInfo.diagnostics = diagnostics;
      }
    }
    return false;
  }

  void launchRenderThread(RenderLoopKind kind) {
    std::lock_guard lock(threadMutex);
    renderThread = std::thread([this, kind] {
      if (kind == RenderLoopKind::Typed) {
        typedRenderLoop();
      } else {
        renderLoop();
      }
    });
  }

  void joinRenderThread() {
    std::thread threadToJoin;
    {
      std::lock_guard lock(threadMutex);
      if (renderThread.joinable() && renderThread.get_id() != std::this_thread::get_id()) {
        threadToJoin = std::move(renderThread);
      }
    }
    if (threadToJoin.joinable()) threadToJoin.join();
  }

  void joinRecoveryThread() {
    std::thread threadToJoin;
    {
      std::lock_guard lock(threadMutex);
      if (recoveryThread.joinable() && recoveryThread.get_id() != std::this_thread::get_id()) {
        threadToJoin = std::move(recoveryThread);
      }
    }
    if (threadToJoin.joinable()) threadToJoin.join();
  }

  void launchRecoveryThread() {
    std::lock_guard lock(threadMutex);
    if (recoveryThread.joinable()) return;
    recoveryThread = std::thread([this] { recoveryLoop(); });
  }

  void recoveryLoop() {
    while (!stopRequested.load()) {
      {
        std::unique_lock lock(recoveryMutex);
        recoveryCv.wait(lock, [this] { return stopRequested.load() || recoveryQueued.load(); });
      }
      if (stopRequested.load()) break;
      const int code = queuedRecoveryCode.load();
      const auto kind = static_cast<RenderLoopKind>(queuedRecoveryKind.load());
      const char* failureMessage = queuedRecoveryMessage.load();
      runQueuedWriteRecovery(code, kind, failureMessage ? failureMessage : "ALSA 输出写入失败");
    }
  }

  void runQueuedWriteRecovery(int code, RenderLoopKind kind, const char* failureMessage) {
    joinRenderThread();
    if (stopRequested.load()) {
      recoveryQueued = false;
      return;
    }

    const bool recovered = recoverFromWriteError(code);
    if (recovered && !stopRequested.load()) {
      recoveryQueued = false;
      running = true;
      launchRenderThread(kind);
    } else {
      OutputEventCallback failureCallback;
      {
        std::lock_guard lock(mutex);
        failureCallback = eventCallback;
      }
      running = false;
      if (failureCallback) failureCallback(OutputBackendEvent::RenderError, failureMessage);
      recoveryQueued = false;
    }
  }

  void queueWriteRecoveryFromRenderThread(int code, RenderLoopKind kind, const char* failureMessage) {
    queuedRecoveryCode.store(code);
    queuedRecoveryKind.store(static_cast<int>(kind));
    queuedRecoveryMessage.store(failureMessage);
    bool expected = false;
    if (!recoveryQueued.compare_exchange_strong(expected, true)) return;

    running = false;
    recoveryCv.notify_one();
  }

  void renderLoop() {
    RenderCallback renderCallback;
    int channels = 0;
    uint64_t frames = 0;
    {
      std::lock_guard snapshotLock(mutex);
      renderCallback = callback;
      channels = std::max(1, outputFormat.channelCount);
      frames = std::max<uint64_t>(1, periodSize);
    }

    const size_t frameCount = static_cast<size_t>(frames);
    while (running.load()) {
      alsa::renderFloatPeriodWithTailSilenceNoResize(renderScratch, frameCount, channels, renderCallback);
      pack(renderScratch.data(), frameCount, channels);

      int64_t offset = 0;
      while (running.load() && offset < static_cast<int64_t>(frames)) {
        const auto remaining = static_cast<uint64_t>(static_cast<int64_t>(frames) - offset);
        const auto byteOffset = static_cast<size_t>(offset) * bytesPerFrame;
        const int64_t written = host->writei(packedScratch.data() + byteOffset, remaining);
        if (written > 0) {
          offset += written;
          continue;
        }
        queueWriteRecoveryFromRenderThread(
            static_cast<int>(written),
            RenderLoopKind::Float,
            "ALSA 输出写入失败");
        break;
      }
    }
  }

  // DSD typed render loop — bypasses float entirely. The typed callback supplies raw DSD
  // bytes (1 byte/sample, MSB-first, interleaved by channel). For DsdU8 the bytes are
  // written directly. For DsdU16Le/U32Le the DSD bytes are repacked into ALSA's
  // phys_width-bytes-per-sample interleaved layout. After the first successful writei,
  // dsdWriteProven flips to true, promoting nativeDsdFacts to Proven.
  void typedRenderLoop() {
    TypedRenderCallback renderTyped;
    int channels = 0;
    uint64_t period = 0;
    size_t frameBytes = 0;
    int physWidthBytes = 0;
    AudioFormat blockFormat;
    {
      std::lock_guard snapshotLock(mutex);
      renderTyped = typedCallback;
      channels = std::max(1, outputFormat.channelCount);
      period = std::max<uint64_t>(1, periodSize);
      frameBytes = bytesPerFrame;
      physWidthBytes = dsdPhysWidthBits / 8;
      blockFormat = outputFormat;
    }
    if (physWidthBytes <= 0) physWidthBytes = 1;

    const size_t alsaFrames = static_cast<size_t>(period);
    while (running.load()) {
      const auto renderedPeriod = alsa::renderDsdPeriodWithTailSilenceAndRepackNoResize(
          typedScratch,
          dsdRepack,
          blockFormat,
          alsaFrames,
          channels,
          frameBytes,
          physWidthBytes,
          renderTyped);
      const uint8_t* writeData = renderedPeriod.writeData;
      if (!writeData) {
        continue;
      }

      int64_t offset = 0;
      while (running.load() && offset < static_cast<int64_t>(alsaFrames)) {
        const auto remaining = static_cast<uint64_t>(alsaFrames - static_cast<size_t>(offset));
        const auto byteOffset = static_cast<size_t>(offset) * frameBytes;
        const int64_t written = host->writei(writeData + byteOffset, remaining);
        if (written > 0) {
          offset += written;
          dsdWriteProven.store(true);
          continue;
        }
        queueWriteRecoveryFromRenderThread(
            static_cast<int>(written),
            RenderLoopKind::Typed,
            "ALSA DSD 输出写入失败");
        break;
      }
    }
  }

  void resetSessionState() {
    OutputInfo::Diagnostics lifetime = diagnostics;
    diagnostics = {};
    diagnostics.lifetimeUnderrunCount = lifetime.lifetimeUnderrunCount;
    diagnostics.lifetimeBufferDropCount = lifetime.lifetimeBufferDropCount;
    diagnostics.lifetimeRecoveryCount = lifetime.lifetimeRecoveryCount;
    diagnostics.driverRestartCount = lifetime.driverRestartCount;
    diagnostics.deviceLostCount = lifetime.deviceLostCount;
    outputFormat = {};
    outputInfo = {};
    dopRuntimeFacts = {};
    nativeDsdFacts = {};
    dsdMode = false;
    dsdPhysWidthBits = 0;
    dsdRequestedBitClock = 0;
    dsdWriteProven.store(false);
    typedCallback = nullptr;
    packedScratchDsdSilence = false;
    deviceId = "default";
    deviceName = "ALSA default";
  }
};

AlsaBackend::AlsaBackend() : AlsaBackend(createRealAlsaHost()) {}

AlsaBackend::AlsaBackend(std::unique_ptr<IAlsaHost> host) : impl_(std::make_unique<Impl>()) {
  impl_->host = std::move(host);
}

AlsaBackend::~AlsaBackend() {
  close();
}

const char* AlsaBackend::id() const {
  return "alsa";
}

bool AlsaBackend::open(const std::string& deviceId, const AudioFormat& requestedFormat, std::string* error) {
  close();
  impl_->resetSessionState();

  if (requestedFormat.sampleRate <= 0 || requestedFormat.channelCount <= 0) {
    if (error) *error = "请求的 ALSA 输出格式无效";
    return false;
  }

  impl_->deviceId = Impl::normalizeDeviceId(deviceId);
  impl_->deviceName = "ALSA " + impl_->deviceId;

  int code = impl_->host ? impl_->host->pcmOpen(impl_->deviceId, true) : -1;
  // PipeWire 主机上 ALSA "default" 常被 dmix 配置破坏（snd_pcm_open 返回 ENOENT）。
  // 回退到常见命名 PCM（pipewire → pulse），保证原生引擎在桌面 Linux 可用。
  if (code < 0 && impl_->deviceId == "default") {
    for (const char* fallback : {"pipewire", "pulse"}) {
      if (impl_->host && impl_->host->pcmOpen(fallback, true) == 0) {
        impl_->deviceId = fallback;
        impl_->deviceName = "ALSA " + std::string(fallback);
        code = 0;
        break;
      }
    }
  }
  if (code < 0) {
    if (error) *error = impl_->alsaError("无法打开 ALSA PCM 输出", code);
    impl_->diagnostics.lastError = error ? *error : "无法打开 ALSA PCM 输出";
    return false;
  }

  code = impl_->host->hwParamsAny();
  if (code < 0) {
    if (error) *error = impl_->alsaError("无法读取 ALSA hw params", code);
    close();
    return false;
  }

  code = impl_->host->hwParamsSetAccess(AlsaPcmAccess::RwInterleaved);
  if (code < 0) {
    if (error) *error = impl_->alsaError("ALSA 设备不支持 interleaved PCM", code);
    close();
    return false;
  }

  const auto candidates = Impl::candidatesFor(requestedFormat);
  const Impl::FormatCandidate* selected = nullptr;
  for (const auto& candidate : candidates) {
    if (impl_->host->hwParamsTestFormat(candidate.alsaFormat) == 0) {
      selected = &candidate;
      break;
    }
  }
  if (!selected) {
    if (error) *error = "ALSA 设备没有可用的 PCM 输出格式";
    close();
    return false;
  }

  code = impl_->host->hwParamsSetFormat(selected->alsaFormat);
  if (code < 0) {
    if (error) *error = impl_->alsaError("无法设置 ALSA PCM 格式", code);
    close();
    return false;
  }

  // For DSD, the ALSA sample rate is the DSD bit-clock divided by phys_width (bits/sample).
  // e.g. DSD64 (2822400) with DsdU8 (phys_width=8) → ALSA rate 352800.
  const bool dsdSelected = isDsdAlsaFormat(selected->alsaFormat);
  const int physWidthBits = dsdPhysWidthBits(selected->alsaFormat);
  impl_->dsdMode = dsdSelected;
  impl_->dsdPhysWidthBits = physWidthBits;
  impl_->dsdRequestedBitClock = dsdSelected ? requestedFormat.sampleRate : 0;
  impl_->dsdWriteProven.store(false);

  unsigned rate = 0;
  if (dsdSelected && physWidthBits > 0) {
    rate = static_cast<unsigned>(requestedFormat.sampleRate / physWidthBits);
  } else {
    rate = static_cast<unsigned>(requestedFormat.sampleRate);
  }
  int dir = 0;
  code = impl_->host->hwParamsSetRateNear(&rate, &dir);
  if (code < 0 || rate == 0) {
    if (error) *error = impl_->alsaError("无法协商 ALSA 采样率", code);
    close();
    return false;
  }

  unsigned channels = static_cast<unsigned>(requestedFormat.channelCount);
  code = impl_->host->hwParamsSetChannelsNear(&channels);
  if (code < 0 || channels == 0) {
    if (error) *error = impl_->alsaError("无法协商 ALSA 声道数", code);
    close();
    return false;
  }

  uint64_t period =
      impl_->outputConfig.preferredBufferSize > 0 ? impl_->outputConfig.preferredBufferSize : kDefaultAlsaPeriodFrames;
  dir = 0;
  impl_->host->hwParamsSetPeriodSizeNear(&period, &dir);
  uint64_t buffer = std::max<uint64_t>(period * kTargetAlsaBufferPeriods, period + 1);
  impl_->host->hwParamsSetBufferSizeNear(&buffer);

  code = impl_->host->hwParamsApply();
  if (code < 0) {
    if (error) *error = impl_->alsaError("无法应用 ALSA hw params", code);
    close();
    return false;
  }

  impl_->host->hwParamsGetRate(&rate, &dir);
  impl_->host->hwParamsGetChannels(&channels);
  impl_->host->hwParamsGetPeriodSize(&period, &dir);
  impl_->host->hwParamsGetBufferSize(&buffer);
  impl_->periodSize = std::max<uint64_t>(1, period);
  impl_->bufferSize = std::max<uint64_t>(impl_->periodSize, buffer);
  impl_->pcmFormat = selected->alsaFormat;
  impl_->outputFormat.sampleRate = static_cast<int>(rate);
  impl_->outputFormat.channelCount = static_cast<int>(channels);
  impl_->outputFormat.bitDepth = selected->bitDepth;
  impl_->outputFormat.sampleFormat = selected->sampleFormat;
  impl_->bytesPerFrame =
      alsaBytesPerSample(impl_->pcmFormat) * static_cast<size_t>(impl_->outputFormat.channelCount);
  const size_t periodFrames = static_cast<size_t>(impl_->periodSize);
  const size_t outputChannels = static_cast<size_t>(std::max(1, impl_->outputFormat.channelCount));
  impl_->renderScratch.resize(periodFrames * outputChannels);
  impl_->packedScratch.resize(periodFrames * impl_->bytesPerFrame);
  impl_->packedScratchDsdSilence = false;
  if (impl_->dsdMode) {
    const size_t physWidthBytes = static_cast<size_t>(std::max(1, impl_->dsdPhysWidthBits / 8));
    impl_->typedScratch.resize(periodFrames * physWidthBytes * outputChannels);
    impl_->dsdRepack.resize(periodFrames * impl_->bytesPerFrame);
  }

  impl_->host->swParamsConfigure(impl_->periodSize, impl_->periodSize);

  const bool directHw = Impl::isDirectHwDevice(impl_->deviceId);
  const bool formatMatched = exactFormatMatch(requestedFormat, impl_->outputFormat);
  const bool supportsOutputPerfect = directHw && formatMatched;
  const double sampleRate = impl_->outputFormat.sampleRate > 0 ? static_cast<double>(impl_->outputFormat.sampleRate) : 0.0;

  impl_->outputInfo = {};
  impl_->outputInfo.exclusive = directHw;
  impl_->outputInfo.accessMode = directHw ? "direct" : "plugin";
  impl_->outputInfo.supportsOutputPerfect = supportsOutputPerfect;
  impl_->outputInfo.sourceExact = false;
  impl_->outputInfo.outputPerfect = false;
  impl_->outputInfo.pcmPassthrough = false;
  impl_->outputInfo.resampled = !formatMatched;
  impl_->outputInfo.outputSampleRate = impl_->outputFormat.sampleRate;
  impl_->outputInfo.outputBitDepth = impl_->outputFormat.bitDepth;
  impl_->outputInfo.outputChannels = impl_->outputFormat.channelCount;
  impl_->outputInfo.backend = "alsa";
  impl_->outputInfo.actualBackend = "alsa";
  impl_->outputInfo.devicePathKind =
      directHw ? "hw" : (impl_->deviceId.rfind("plughw:", 0) == 0 ? "plughw" : "default");
  impl_->outputInfo.deviceName = impl_->deviceName;
  impl_->outputInfo.actualDeviceName = impl_->deviceName;
  impl_->outputInfo.actualOutputFormat = sampleFormatToString(impl_->outputFormat.sampleFormat);
  impl_->outputInfo.actualSampleRate = impl_->outputFormat.sampleRate;
  impl_->outputInfo.actualBitDepth = impl_->outputFormat.bitDepth;
  impl_->outputInfo.actualChannels = impl_->outputFormat.channelCount;
  impl_->outputInfo.bufferSizeFrames = static_cast<int>(impl_->bufferSize);
  impl_->outputInfo.latencyFrames = static_cast<int>(impl_->bufferSize);
  impl_->outputInfo.latencyMs =
      sampleRate > 0.0 ? static_cast<double>(impl_->bufferSize) * 1000.0 / sampleRate : 0.0;
  impl_->outputInfo.latencyInfo.bufferLatencyMs =
      sampleRate > 0.0 ? static_cast<double>(impl_->periodSize) * 1000.0 / sampleRate : 0.0;
  impl_->outputInfo.latencyInfo.outputLatencyMs =
      sampleRate > 0.0
          ? static_cast<double>(impl_->bufferSize > impl_->periodSize ? impl_->bufferSize - impl_->periodSize : 0) *
                1000.0 / sampleRate
          : 0.0;
  impl_->outputInfo.latencyInfo.totalLatencyMs = impl_->outputInfo.latencyMs;
  impl_->outputInfo.channelRoutingMode = channelRoutingModeToString(impl_->outputConfig.routingMode);
  impl_->outputInfo.diagnostics = impl_->diagnostics;
  if (!supportsOutputPerfect) {
    impl_->outputInfo.perfectReasonCode = directHw ? "pcm_converted" : "plugin_path";
    impl_->outputInfo.perfectReason =
        directHw ? Impl::formatMismatchReason(requestedFormat, impl_->outputFormat) : Impl::pluginPathReason(impl_->deviceId);
    impl_->outputInfo.capabilityReason = impl_->outputInfo.perfectReason;
  }

  // Native DSD runtime facts: Candidate at open (hw_params_test_format is an explicit
  // probe), Proven only after the first successful writei of DSD data in typedRenderLoop.
  if (impl_->dsdMode && directHw) {
    impl_->nativeDsdFacts.state = NativeDsdRuntimeFactState::Candidate;
    impl_->nativeDsdFacts.requestedDsdRate = impl_->dsdRequestedBitClock;
    impl_->nativeDsdFacts.actualDsdRate = static_cast<int>(rate) * physWidthBits;
    impl_->nativeDsdFacts.channelCount = impl_->outputFormat.channelCount;
    impl_->nativeDsdFacts.explicitlyCapable = true;
    impl_->nativeDsdFacts.advertisedSampleRates = nativeDsdAdvertisedRates();
    impl_->nativeDsdFacts.reason =
        "ALSA hw: device accepted a DSD format via hw_params_test_format; awaiting first writei";
  } else if (impl_->dsdMode) {
    impl_->nativeDsdFacts = unsupportedNativeDsdRuntimeFacts(
        "ALSA Native DSD requires a direct hw: device; plugin paths cannot preserve the DSD bitstream");
  } else {
    impl_->nativeDsdFacts = unsupportedNativeDsdRuntimeFacts("No Native DSD stream was requested");
  }

  // DSD outputInfo override: bitstream preservation, not PCM sample-rate match.
  // supportsOutputPerfect stays false until nativeDsdRuntimeFacts reaches Proven.
  if (impl_->dsdMode) {
    impl_->outputInfo.resampled = !directHw;
    impl_->outputInfo.supportsOutputPerfect = false;
    impl_->outputInfo.outputPerfect = false;
    impl_->outputInfo.pcmPassthrough = false;
    impl_->outputInfo.sourceExact = false;
    if (directHw) {
      impl_->outputInfo.perfectReasonCode = "native_dsd_runtime_unproven";
      impl_->outputInfo.perfectReason = "ALSA Native DSD awaiting first successful writei to prove the path";
    } else {
      impl_->outputInfo.perfectReasonCode = "plugin_path";
      impl_->outputInfo.perfectReason = Impl::pluginPathReason(impl_->deviceId);
    }
    impl_->outputInfo.capabilityReason = impl_->outputInfo.perfectReason;
  }

  impl_->dopRuntimeFacts = unprovenDopRuntimeFacts(
      requestedFormat,
      impl_->outputFormat,
      directHw ? "ALSA direct path does not provide explicit DoP runtime proof" : Impl::pluginPathReason(impl_->deviceId));

  return true;
}

bool AlsaBackend::setOutputConfig(const OutputConfig& config, std::string* error) {
  (void)error;
  std::lock_guard lock(impl_->mutex);
  impl_->outputConfig = config;
  impl_->outputInfo.channelRoutingMode = channelRoutingModeToString(impl_->outputConfig.routingMode);
  return true;
}

bool AlsaBackend::start(RenderCallback callback, OutputEventCallback eventCallback, std::string* error) {
  if (!impl_->host || !impl_->host->isOpen()) {
    if (error) *error = "ALSA 后端尚未打开";
    return false;
  }
  if (impl_->running.load()) {
    if (error) *error = "ALSA 后端已在运行";
    return false;
  }
  if (impl_->dsdMode) {
    if (error) *error = "Native DSD ALSA output requires the typed render path; refusing float fallback silence";
    return false;
  }
  {
    std::lock_guard lock(impl_->mutex);
    impl_->callback = std::move(callback);
    impl_->eventCallback = std::move(eventCallback);
  }
  const int code = impl_->host->prepare();
  if (code < 0) {
    if (error) *error = impl_->alsaError("无法 prepare ALSA PCM", code);
    return false;
  }
  impl_->stopRequested = false;
  impl_->recoveryQueued = false;
  impl_->running = true;
  impl_->launchRecoveryThread();
  impl_->launchRenderThread(AlsaBackend::Impl::RenderLoopKind::Float);
  return true;
}

bool AlsaBackend::startTyped(
    TypedRenderCallback callback,
    RenderCallback fallbackCallback,
    OutputEventCallback eventCallback,
    std::string* error) {
  if (!impl_->host || !impl_->host->isOpen()) {
    if (error) *error = "ALSA 后端尚未打开";
    return false;
  }
  if (impl_->running.load()) {
    if (error) *error = "ALSA 后端已在运行";
    return false;
  }
  {
    std::lock_guard lock(impl_->mutex);
    impl_->typedCallback = std::move(callback);
    impl_->callback = std::move(fallbackCallback);
    impl_->eventCallback = std::move(eventCallback);
  }
  const int code = impl_->host->prepare();
  if (code < 0) {
    if (error) *error = impl_->alsaError("无法 prepare ALSA PCM", code);
    return false;
  }
  impl_->stopRequested = false;
  impl_->recoveryQueued = false;
  impl_->running = true;
  impl_->launchRecoveryThread();
  // DSD bypasses float: use the typed render loop that writes raw DSD bytes via writei.
  // PCM falls back to the float render loop.
  if (impl_->dsdMode) {
    impl_->launchRenderThread(AlsaBackend::Impl::RenderLoopKind::Typed);
  } else {
    impl_->launchRenderThread(AlsaBackend::Impl::RenderLoopKind::Float);
  }
  return true;
}

void AlsaBackend::stop() {
  impl_->stopRequested = true;
  impl_->running = false;
  impl_->recoveryCv.notify_one();
  impl_->joinRenderThread();
  impl_->joinRecoveryThread();
  if (impl_->host && impl_->host->isOpen()) impl_->host->drop();
}

void AlsaBackend::close() {
  stop();
  if (impl_->host && impl_->host->isOpen()) impl_->host->close();
  {
    std::lock_guard lock(impl_->mutex);
    impl_->callback = nullptr;
    impl_->typedCallback = nullptr;
    impl_->eventCallback = nullptr;
    impl_->renderScratch.clear();
    impl_->packedScratch.clear();
    impl_->packedScratchDsdSilence = false;
    impl_->typedScratch.clear();
    impl_->dsdRepack.clear();
  }
}

AudioFormat AlsaBackend::outputFormat() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->outputFormat;
}

OutputInfo AlsaBackend::outputInfo() const {
  std::lock_guard lock(impl_->mutex);
  OutputInfo info = impl_->outputInfo;
  NativeDsdRuntimeFacts facts = impl_->nativeDsdFacts;
  if (impl_->dsdWriteProven.load() && facts.state == NativeDsdRuntimeFactState::Candidate) {
    facts.state = NativeDsdRuntimeFactState::Proven;
    facts.reason = "ALSA hw: device accepted and successfully wrote DSD bitstream via writei";
  }
  applyNativeDsdFactsToOutputInfo(&info, facts);
  if (impl_->dsdMode && Impl::isDirectHwDevice(impl_->deviceId) &&
      facts.state == NativeDsdRuntimeFactState::Proven) {
    info.supportsOutputPerfect = true;
    info.resampled = false;
    info.perfectReasonCode.clear();
    info.perfectReason.clear();
    info.capabilityReason.clear();
  }
  synchronizeOutputConversionInfo(info);
  return info;
}

DopRuntimeFacts AlsaBackend::dopRuntimeFacts() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->dopRuntimeFacts;
}

NativeDsdRuntimeFacts AlsaBackend::nativeDsdRuntimeFacts() const {
  std::lock_guard lock(impl_->mutex);
  NativeDsdRuntimeFacts facts = impl_->nativeDsdFacts;
  if (impl_->dsdWriteProven.load() && facts.state == NativeDsdRuntimeFactState::Candidate) {
    facts.state = NativeDsdRuntimeFactState::Proven;
    facts.reason = "ALSA hw: device accepted and successfully wrote DSD bitstream via writei";
  }
  return facts;
}

std::string AlsaBackend::deviceName() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->deviceName;
}

bool alsaBackendAvailable() {
#if defined(__linux__) && defined(TAE_ENABLE_ALSA)
  return true;
#else
  return false;
#endif
}

}  // namespace twilight::audio
