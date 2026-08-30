#include "TwilightAudioEngine.h"

#include "../analysis/BpmAnalyzer.h"
#include "../analysis/LoudnessAnalyzer.h"
#include "../decoder/SacdIsoProbe.h"
#include "../metadata/AudioMetadataService.h"
#include "../utils/JsonUtils.h"
#include "DiagnosticLog.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstring>
#include <memory>
#include <optional>
#include <sstream>

namespace twilight::audio {

std::string enumeratePlatformDevicesJson();
std::string enumerateAsioDevicesJson();
std::string pluginCapabilitiesJson();

namespace {

const char* stateToString(PlaybackState state) {
  switch (state) {
    case PlaybackState::Playing:
      return "playing";
    case PlaybackState::Paused:
      return "paused";
    case PlaybackState::Stopped:
    default:
      return "stopped";
  }
}

const char* resultToString(TAE_Result result) {
  switch (result) {
    case TAE_RESULT_OK:
      return "TAE_RESULT_OK";
    case TAE_RESULT_INVALID_ARGUMENT:
      return "TAE_RESULT_INVALID_ARGUMENT";
    case TAE_RESULT_NOT_INITIALIZED:
      return "TAE_RESULT_NOT_INITIALIZED";
    case TAE_RESULT_BACKEND_UNAVAILABLE:
      return "TAE_RESULT_BACKEND_UNAVAILABLE";
    case TAE_RESULT_INTERNAL_ERROR:
    default:
      return "TAE_RESULT_INTERNAL_ERROR";
  }
}

void writeLatencyInfoJson(std::ostringstream& json, const OutputInfo::LatencyInfo& latency) {
  json << "{"
       << "\"bufferLatencyMs\":" << latency.bufferLatencyMs << ","
       << "\"outputLatencyMs\":" << latency.outputLatencyMs << ","
       << "\"totalLatencyMs\":" << latency.totalLatencyMs
       << "}";
}

void writeDiagnosticsJson(std::ostringstream& json, const OutputInfo::Diagnostics& diagnostics) {
  json << "{"
       << "\"sessionUnderrunCount\":" << diagnostics.sessionUnderrunCount << ","
       << "\"sessionBufferDropCount\":" << diagnostics.sessionBufferDropCount << ","
       << "\"sessionRecoveryCount\":" << diagnostics.sessionRecoveryCount << ","
       << "\"lifetimeUnderrunCount\":" << diagnostics.lifetimeUnderrunCount << ","
       << "\"lifetimeBufferDropCount\":" << diagnostics.lifetimeBufferDropCount << ","
       << "\"lifetimeRecoveryCount\":" << diagnostics.lifetimeRecoveryCount << ","
       << "\"driverRestartCount\":" << diagnostics.driverRestartCount << ","
       << "\"deviceLostCount\":" << diagnostics.deviceLostCount << ","
       << "\"driverXrunCount\":" << diagnostics.driverXrunCount << ","
       << "\"dsdIdleFrameCount\":" << diagnostics.dsdIdleFrameCount << ","
       << "\"dsdShortReadCount\":" << diagnostics.dsdShortReadCount << ","
       << "\"dsdTransport\":\"" << json_utils::escape(diagnostics.dsdTransport) << "\","
       << "\"dsdSourceBitOrder\":\"" << json_utils::escape(diagnostics.dsdSourceBitOrder) << "\","
       << "\"dsdSourcePacking\":\"" << json_utils::escape(diagnostics.dsdSourcePacking) << "\","
       << "\"requestedWireFormat\":\"" << json_utils::escape(diagnostics.requestedWireFormat) << "\","
       << "\"actualWireFormat\":\"" << json_utils::escape(diagnostics.actualWireFormat) << "\","
       << "\"containerBits\":" << diagnostics.containerBits << ","
       << "\"validBits\":" << diagnostics.validBits << ","
       << "\"blockAlign\":" << diagnostics.blockAlign << ","
       << "\"semanticSampleRate\":" << diagnostics.semanticSampleRate << ","
       << "\"transportSampleRate\":" << diagnostics.transportSampleRate << ","
       << "\"typedRawPath\":" << (diagnostics.typedRawPath ? "true" : "false") << ","
       << "\"processingBypassed\":" << (diagnostics.processingBypassed ? "true" : "false") << ","
       << "\"nativeDsdNegotiation\":\"" << json_utils::escape(diagnostics.nativeDsdNegotiation) << "\","
       << "\"dopRuntimeEvidence\":\"" << json_utils::escape(diagnostics.dopRuntimeEvidence) << "\","
       << "\"firstBufferSummary\":\"" << json_utils::escape(diagnostics.firstBufferSummary) << "\","
       << "\"processArchitecture\":\"" << json_utils::escape(diagnostics.processArchitecture) << "\","
       << "\"asioBuildEnabled\":" << (diagnostics.asioBuildEnabled ? "true" : "false") << ","
       << "\"asioEnvironmentDisabled\":" << (diagnostics.asioEnvironmentDisabled ? "true" : "false") << ","
       << "\"asioRegisteredDriverCount32\":" << diagnostics.asioRegisteredDriverCount32 << ","
       << "\"asioRegisteredDriverCount64\":" << diagnostics.asioRegisteredDriverCount64 << ","
       << "\"asioLoadableDriverCount64\":" << diagnostics.asioLoadableDriverCount64 << ","
       << "\"dsdRouteOverrideActive\":" << (diagnostics.dsdRouteOverrideActive ? "true" : "false") << ","
       << "\"dsdRouteBackend\":\"" << json_utils::escape(diagnostics.dsdRouteBackend) << "\","
       << "\"dsdRouteDevice\":\"" << json_utils::escape(diagnostics.dsdRouteDevice) << "\","
       << "\"dsdRouteFallbackReason\":\"" << json_utils::escape(diagnostics.dsdRouteFallbackReason) << "\","
       << "\"lastError\":\"" << json_utils::escape(diagnostics.lastError) << "\""
       << "}";
}

void writeRenderPerformanceJson(
    std::ostringstream& json,
    const OutputInfo::RenderPerformanceSnapshot& performance) {
  const double meanCallbackNanoseconds = performance.callbackCount == 0
                                            ? 0.0
                                            : static_cast<double>(performance.totalCallbackNanoseconds) /
                                                  static_cast<double>(performance.callbackCount);
  const double callbackDeadlineLoadPercent = performance.totalDeadlineNanoseconds == 0
                                                 ? 0.0
                                                 : (static_cast<double>(performance.totalCallbackNanoseconds) * 100.0) /
                                                       static_cast<double>(performance.totalDeadlineNanoseconds);
  json << "{"
       << "\"callbackCount\":" << performance.callbackCount << ","
       << "\"totalCallbackNanoseconds\":" << performance.totalCallbackNanoseconds << ","
       << "\"meanCallbackNanoseconds\":" << meanCallbackNanoseconds << ","
       << "\"peakCallbackNanoseconds\":" << performance.peakCallbackNanoseconds << ","
       << "\"totalDeadlineNanoseconds\":" << performance.totalDeadlineNanoseconds << ","
       << "\"deadlineMissCount\":" << performance.deadlineMissCount << ","
       << "\"callbackDeadlineLoadPercent\":" << callbackDeadlineLoadPercent
       << "}";
}

std::string boolJson(bool value) {
  return value ? "true" : "false";
}

bool jsonArrayHasItems(const std::string& json) {
  return json.find('{') != std::string::npos;
}

void writeBackendCapabilityJson(
    std::ostringstream& json,
    const char* id,
    const char* label,
    bool compiled,
    bool runtimeAvailable,
    bool supportsExclusive,
    bool supportsOutputPerfect,
    const char* accessMode,
    const char* devicePathKind,
    const std::string& unavailableReason = {},
    bool optional = false) {
  json << "{\"id\":\"" << json_utils::escape(id) << "\",\"label\":\"" << json_utils::escape(label) << "\","
       << "\"compiled\":" << boolJson(compiled) << ","
       << "\"runtimeAvailable\":" << boolJson(runtimeAvailable) << ","
       << "\"supportsExclusive\":" << boolJson(supportsExclusive) << ","
       << "\"supportsOutputPerfect\":" << boolJson(supportsOutputPerfect) << ","
       << "\"accessMode\":\"" << json_utils::escape(accessMode) << "\","
       << "\"devicePathKind\":\"" << json_utils::escape(devicePathKind) << "\","
       << "\"unavailableReason\":\"" << json_utils::escape(runtimeAvailable ? std::string{} : unavailableReason) << "\"";
  if (optional) json << ",\"optional\":true";
  json << "}";
}

std::string backendCapabilitiesJson() {
  std::ostringstream json;
  json << "[";
  bool first = true;
  auto append = [&](const char* id,
                    const char* label,
                    bool compiled,
                    bool runtimeAvailable,
                    bool supportsExclusive,
                    bool supportsOutputPerfect,
                    const char* accessMode,
                    const char* devicePathKind,
                    const std::string& unavailableReason = {},
                    bool optional = false) {
    if (!first) json << ",";
    first = false;
    writeBackendCapabilityJson(
        json,
        id,
        label,
        compiled,
        runtimeAvailable,
        supportsExclusive,
        supportsOutputPerfect,
        accessMode,
        devicePathKind,
        unavailableReason,
        optional);
  };

#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  append("wasapi", "共享输出", true, true, false, false, "shared", "default");
  append("wasapi-exclusive", "独占输出", true, true, true, true, "exclusive", "default");
#else
  append(
      "wasapi",
      "共享输出",
      false,
      false,
      false,
      false,
      "shared",
      "default",
      "WASAPI is only available in Windows builds with TAE_ENABLE_WASAPI");
  append(
      "wasapi-exclusive",
      "独占输出",
      false,
      false,
      true,
      false,
      "exclusive",
      "default",
      "WASAPI Exclusive is only available in Windows builds with TAE_ENABLE_WASAPI");
#endif

#if defined(_WIN32) && defined(TAE_ENABLE_ASIO)
  const std::string asioDevices = enumerateAsioDevicesJson();
  append(
      "asio",
      "专业声卡输出",
      true,
      jsonArrayHasItems(asioDevices),
      true,
      true,
      "exclusive",
      "asio",
      "No ASIO drivers were enumerated",
      true);
#else
  append(
      "asio",
      "专业声卡输出",
      false,
      false,
      true,
      false,
      "exclusive",
      "asio",
      "ASIO compatibility backend is unavailable for this build",
      true);
#endif

#if defined(__APPLE__) && defined(TAE_ENABLE_COREAUDIO)
  append("coreaudio", "苹果系统音频", true, true, false, false, "shared", "hal");
  append("coreaudio-exclusive", "独占输出 (Hog Mode)", true, true, true, true, "exclusive", "hal");
#else
  append(
      "coreaudio",
      "苹果系统音频",
      false,
      false,
      false,
      false,
      "shared",
      "hal",
      "CoreAudio is only available in macOS builds with TAE_ENABLE_COREAUDIO");
  append(
      "coreaudio-exclusive",
      "独占输出 (Hog Mode)",
      false,
      false,
      true,
      false,
      "exclusive",
      "hal",
      "CoreAudio Hog Mode exclusive is only available in macOS builds with TAE_ENABLE_COREAUDIO");
#endif

#if defined(__linux__) && defined(TAE_ENABLE_ALSA)
  append("alsa", "Linux ALSA 输出", true, true, false, false, "plugin", "default");
#else
  append(
      "alsa",
      "Linux ALSA 输出",
      false,
      false,
      false,
      false,
      "plugin",
      "default",
      "ALSA is only available in Linux builds with TAE_ENABLE_ALSA and ALSA development libraries");
#endif

  json << "]";
  return json.str();
}

void normalizeOutputInfoMirror(PlaybackInfo& info) {
  OutputInfo& out = info.outputInfo;
  if (out.backend.empty()) out.backend = info.outputBackend;
  if (out.actualBackend.empty()) out.actualBackend = out.backend;
  if (out.accessMode.empty()) out.accessMode = out.exclusive ? "exclusive" : "shared";
  if (out.devicePathKind.empty()) out.devicePathKind = "default";
  if (out.deviceName.empty()) out.deviceName = info.outputDevice;
  if (out.actualDeviceName.empty()) out.actualDeviceName = out.deviceName;
  if (out.actualDriverName.empty()) out.actualDriverName = out.driverName;
  if (out.actualDriverVersion == 0) out.actualDriverVersion = out.driverVersion;
  if (out.outputSampleRate <= 0 && info.outputSampleRate > 0) out.outputSampleRate = info.outputSampleRate;
  if (out.outputBitDepth <= 0 && info.outputBitDepth > 0) out.outputBitDepth = info.outputBitDepth;
  if (out.actualSampleRate <= 0) out.actualSampleRate = out.outputSampleRate;
  if (out.actualBitDepth <= 0) out.actualBitDepth = out.outputBitDepth;

  info.actualBackend = out.actualBackend;
  info.driverName = out.driverName.empty() ? out.actualDriverName : out.driverName;
  info.driverVersion = out.driverVersion != 0 ? out.driverVersion : out.actualDriverVersion;
  info.actualOutputFormat = out.actualOutputFormat;
  info.actualSampleRate = out.actualSampleRate;
  info.actualBitDepth = out.actualBitDepth;
  info.actualChannels = out.actualChannels;
  info.bufferSizeFrames = out.bufferSizeFrames;
  info.latencyFrames = out.latencyFrames;
  info.latencyMs = out.latencyMs;
  info.deviceRecovered = out.deviceRecovered;
  info.recoveryCount = out.recoveryCount;
  info.outputSampleRate = out.outputSampleRate;
  info.outputBitDepth = out.outputBitDepth;
  info.supportsOutputPerfect = out.supportsOutputPerfect;
  info.sourceExact = out.sourceExact;
  info.outputPerfect = out.outputPerfect;
  info.pcmPassthrough = out.pcmPassthrough;
  info.perfectReasonCode = out.perfectReasonCode;
  info.perfectReason = out.perfectReason;
  info.isDsd = out.isDsd;
  info.dsdMode = out.dsdMode.empty() ? (out.isDsd ? dsdModeToString(DsdMode::Unsupported) : dsdModeToString(DsdMode::Pcm)) : out.dsdMode;
  info.dsdRate = out.isDsd ? out.dsdRate : 0;
}

std::string inferCodec(const std::string& source) {
  const auto dot = source.find_last_of('.');
  if (dot == std::string::npos) return "未知";
  std::string ext = source.substr(dot + 1);
  std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (ext == "m4a" || ext == "mp4") return "aac/alac";
  if (ext == "aif" || ext == "aiff") return "aiff";
  if (ext == "dsf" || ext == "dff") return "dsd";
  return ext;
}

bool codecLooksLossless(const std::string& codec) {
  return codec == "flac" || codec == "wav" || codec == "alac" || codec == "aiff" || codec == "aif" ||
         codec == "ape" || codec == "wv" || codec == "tta" || codec == "pcm";
}

AudioSampleFormat sampleFormatFromText(const std::string& format, int bitDepth) {
  if (format == "int16") return AudioSampleFormat::Int16Interleaved;
  if (format == "int24") return AudioSampleFormat::Int24Interleaved;
  if (format == "int24-in32") return AudioSampleFormat::Int24In32Interleaved;
  if (format == "int32") return AudioSampleFormat::Int32Interleaved;
  if (format == "float32") return AudioSampleFormat::Float32Interleaved;
  if (bitDepth <= 16) return AudioSampleFormat::Int16Interleaved;
  if (bitDepth <= 24) return AudioSampleFormat::Int24Interleaved;
  return AudioSampleFormat::Float32Interleaved;
}

DsdMode parseDsdMode(const std::string& mode) {
  if (mode == "dop") return DsdMode::Dop;
  if (mode == "native") return DsdMode::Native;
  if (mode == "unsupported") return DsdMode::Unsupported;
  return DsdMode::Pcm;
}

std::string playbackInfoToJson(const PlaybackInfo& info) {
  const OutputInfo& out = info.outputInfo;
  std::ostringstream json;
  json << "{"
       << "\"state\":\"" << stateToString(info.state) << "\","
       << "\"position\":" << info.positionSeconds << ","
       << "\"duration\":" << info.durationSeconds << ","
       << "\"volume\":" << info.volume << ","
       << "\"playbackRate\":" << info.playbackRate << ","
       << "\"requestedConfigRevision\":" << info.requestedConfigRevision << ","
       << "\"appliedConfigRevision\":" << info.appliedConfigRevision << ","
       << "\"queueIndex\":" << info.queueIndex << ","
       << "\"playMode\":\"" << json_utils::escape(info.playMode) << "\","
       << "\"source\":\"" << json_utils::escape(info.source) << "\","
       << "\"codec\":\"" << json_utils::escape(info.codec) << "\","
       << "\"bitrate\":" << info.bitrate << ","
       << "\"sourceSampleRate\":" << info.sourceSampleRate << ","
       << "\"sourceBitDepth\":" << info.sourceBitDepth << ","
       << "\"decodedSampleRate\":" << info.decodedSampleRate << ","
       << "\"decodedBitDepth\":" << info.decodedBitDepth << ","
       << "\"decodedChannels\":" << info.decodedChannels << ","
       << "\"decodedSampleFormat\":\"" << json_utils::escape(info.decodedSampleFormat) << "\","
       << "\"outputBackend\":\"" << json_utils::escape(info.outputBackend) << "\","
       << "\"outputDevice\":\"" << json_utils::escape(info.outputDevice) << "\","
       << "\"outputInfo\":{"
       << "\"exclusive\":" << (out.exclusive ? "true" : "false") << ","
       << "\"accessMode\":\"" << json_utils::escape(out.accessMode) << "\","
       << "\"supportsOutputPerfect\":" << (out.supportsOutputPerfect ? "true" : "false") << ","
       << "\"sourceExact\":" << (out.sourceExact ? "true" : "false") << ","
       << "\"outputPerfect\":" << (out.outputPerfect ? "true" : "false") << ","
       << "\"pcmPassthrough\":" << (out.pcmPassthrough ? "true" : "false") << ","
       << "\"resampled\":" << (out.resampled ? "true" : "false") << ","
       << "\"isDsd\":" << (out.isDsd ? "true" : "false") << ","
       << "\"dsdMode\":\"" << json_utils::escape(out.dsdMode) << "\","
       << "\"dsdRate\":" << out.dsdRate << ","
       << "\"outputSampleRate\":" << out.outputSampleRate << ","
       << "\"outputBitDepth\":" << out.outputBitDepth << ","
       << "\"backend\":\"" << json_utils::escape(out.backend) << "\","
       << "\"actualBackend\":\"" << json_utils::escape(out.actualBackend) << "\","
       << "\"devicePathKind\":\"" << json_utils::escape(out.devicePathKind) << "\","
       << "\"deviceName\":\"" << json_utils::escape(out.deviceName) << "\","
       << "\"actualDeviceName\":\"" << json_utils::escape(out.actualDeviceName) << "\","
       << "\"driverName\":\"" << json_utils::escape(out.driverName) << "\","
       << "\"actualDriverName\":\"" << json_utils::escape(out.actualDriverName) << "\","
       << "\"driverVersion\":" << out.driverVersion << ","
       << "\"actualDriverVersion\":" << out.actualDriverVersion << ","
       << "\"actualOutputFormat\":\"" << json_utils::escape(out.actualOutputFormat) << "\","
       << "\"actualSampleRate\":" << out.actualSampleRate << ","
       << "\"actualBitDepth\":" << out.actualBitDepth << ","
       << "\"actualChannels\":" << out.actualChannels << ","
       << "\"perfectReasonCode\":\"" << json_utils::escape(out.perfectReasonCode) << "\","
       << "\"capabilityReason\":\"" << json_utils::escape(out.capabilityReason) << "\","
       << "\"driverDopCapable\":" << (out.driverDopCapable ? "true" : "false") << ","
       << "\"driverNativeDsdCapable\":" << (out.driverNativeDsdCapable ? "true" : "false") << ","
       << "\"driverDopCarrierSampleRates\":[";
  for (size_t i = 0; i < out.driverDopCarrierSampleRates.size(); ++i) {
    if (i > 0) json << ",";
    json << out.driverDopCarrierSampleRates[i];
  }
  json << "],\"driverDopCarrierFormats\":[";
  for (size_t i = 0; i < out.driverDopCarrierFormats.size(); ++i) {
    if (i > 0) json << ",";
    json << "\"" << json_utils::escape(out.driverDopCarrierFormats[i]) << "\"";
  }
  json << "],\"driverNativeDsdSampleRates\":[";
  for (size_t i = 0; i < out.driverNativeDsdSampleRates.size(); ++i) {
    if (i > 0) json << ",";
    json << out.driverNativeDsdSampleRates[i];
  }
  json << "],"
       << "\"nativeDsdRuntimeState\":\"" << json_utils::escape(out.nativeDsdRuntimeState) << "\","
       << "\"nativeDsdRequestedRate\":" << out.nativeDsdRequestedRate << ","
       << "\"nativeDsdActualRate\":" << out.nativeDsdActualRate << ","
       << "\"nativeDsdChannels\":" << out.nativeDsdChannels << ","
       << "\"nativeDsdExplicitlyCapable\":" << (out.nativeDsdExplicitlyCapable ? "true" : "false") << ","
       << "\"nativeDsdAdvertisedSampleRates\":[";
  for (size_t i = 0; i < out.nativeDsdAdvertisedSampleRates.size(); ++i) {
    if (i > 0) json << ",";
    json << out.nativeDsdAdvertisedSampleRates[i];
  }
  json << "],"
       << "\"nativeDsdRuntimeReason\":\"" << json_utils::escape(out.nativeDsdRuntimeReason) << "\","
       << "\"bufferSizeFrames\":" << out.bufferSizeFrames << ","
       << "\"latencyFrames\":" << out.latencyFrames << ","
       << "\"latencyMs\":" << out.latencyMs << ","
       << "\"latencyInfo\":";
  writeLatencyInfoJson(json, out.latencyInfo);
  json << ","
       << "\"channelRoutingMode\":\"" << json_utils::escape(out.channelRoutingMode) << "\","
       << "\"perfectReason\":\"" << json_utils::escape(out.perfectReason) << "\","
       << "\"diagnostics\":";
  writeDiagnosticsJson(json, out.diagnostics);
  json << ",\"renderPerformance\":";
  writeRenderPerformanceJson(json, out.renderPerformance);
  json << ","
       << "\"deviceRecovered\":" << (out.deviceRecovered ? "true" : "false") << ","
       << "\"recoveryCount\":" << out.recoveryCount << ","
       << "\"nativeDsp\":" << (out.nativeDspJson.empty() ? "{\"plugins\":[]}" : out.nativeDspJson)
       << "},"
       << "\"actualBackend\":\"" << json_utils::escape(out.actualBackend) << "\","
       << "\"driverName\":\"" << json_utils::escape(out.driverName.empty() ? out.actualDriverName : out.driverName) << "\","
       << "\"driverVersion\":" << (out.driverVersion != 0 ? out.driverVersion : out.actualDriverVersion) << ","
       << "\"actualOutputFormat\":\"" << json_utils::escape(out.actualOutputFormat) << "\","
       << "\"actualSampleRate\":" << out.actualSampleRate << ","
       << "\"actualBitDepth\":" << out.actualBitDepth << ","
       << "\"actualChannels\":" << out.actualChannels << ","
       << "\"bufferSizeFrames\":" << out.bufferSizeFrames << ","
       << "\"latencyFrames\":" << out.latencyFrames << ","
       << "\"latencyMs\":" << out.latencyMs << ","
       << "\"latencyInfo\":";
  writeLatencyInfoJson(json, out.latencyInfo);
  json << ","
       << "\"channelRoutingMode\":\"" << json_utils::escape(out.channelRoutingMode) << "\","
       << "\"diagnostics\":";
  writeDiagnosticsJson(json, out.diagnostics);
  json << ",\"renderPerformance\":";
  writeRenderPerformanceJson(json, out.renderPerformance);
  json << ","
       << "\"deviceRecovered\":" << (out.deviceRecovered ? "true" : "false") << ","
       << "\"recoveryCount\":" << out.recoveryCount << ","
       << "\"outputSampleRate\":" << out.outputSampleRate << ","
       << "\"outputBitDepth\":" << out.outputBitDepth << ","
       << "\"channelCount\":" << info.channelCount << ","
       << "\"supportsOutputPerfect\":" << (out.supportsOutputPerfect ? "true" : "false") << ","
       << "\"sourceExact\":" << (out.sourceExact ? "true" : "false") << ","
       << "\"outputPerfect\":" << (out.outputPerfect ? "true" : "false") << ","
       << "\"pcmPassthrough\":" << (out.pcmPassthrough ? "true" : "false") << ","
       << "\"dspActive\":" << (info.dspActive ? "true" : "false") << ","
       << "\"replayGainActive\":" << (info.replayGainActive ? "true" : "false") << ","
       << "\"loudnormActive\":" << (info.loudnormActive ? "true" : "false") << ","
       << "\"eqActive\":" << (info.eqActive ? "true" : "false") << ","
       << "\"convolverActive\":" << (info.convolverActive ? "true" : "false") << ","
       << "\"crossfeedActive\":" << (info.crossfeedActive ? "true" : "false") << ","
       << "\"crossfadeActive\":" << (info.crossfadeActive ? "true" : "false") << ","
       << "\"fftActive\":" << (info.fftActive ? "true" : "false") << ","
       << "\"irResampled\":" << (info.irResampled ? "true" : "false") << ","
       << "\"replayGainDb\":" << info.replayGainDb << ","
       << "\"crossfeedStrength\":" << info.crossfeedStrength << ","
       << "\"crossfadeSeconds\":" << info.crossfadeSeconds << ","
       << "\"convolverLatencyFrames\":" << info.convolverLatencyFrames << ","
       << "\"partitionSize\":" << info.partitionSize << ","
       << "\"channelMappingMode\":\"" << json_utils::escape(info.channelMappingMode) << "\","
       << "\"perfectReasonCode\":\"" << json_utils::escape(info.perfectReasonCode) << "\","
       << "\"perfectReason\":\"" << json_utils::escape(info.perfectReason) << "\","
       << "\"isDsd\":" << (info.isDsd ? "true" : "false") << ","
       << "\"dsdMode\":\"" << json_utils::escape(info.dsdMode) << "\","
       << "\"dsdRate\":" << info.dsdRate << ","
       << "\"gaplessActive\":" << (info.gaplessActive ? "true" : "false") << ","
       << "\"preloadReady\":" << (info.preloadReady ? "true" : "false") << ","
       << "\"gaplessBlockedReason\":\"" << json_utils::escape(info.gaplessBlockedReason) << "\","
       << "\"streamTitle\":\"" << json_utils::escape(info.streamTitle) << "\","
       << "\"upcomingTrack\":"
       << QueueManager::itemToJson(info.hasUpcomingTrack ? std::optional<QueueItem>(info.upcomingTrack) : std::nullopt)
       << "}";
  return json.str();
}

DspStatus configuredDspStatusFromConfig(const DspConfig& config) {
  DspStatus status;
  status.crossfadeActive = config.crossfadeSeconds > 0.0001;
  status.crossfadeSeconds = status.crossfadeActive ? config.crossfadeSeconds : 0.0;
  if (config.enabled) {
    status.replayGainActive = config.replayGainMode != ReplayGainMode::Off;
    status.loudnormActive = config.replayGainMode == ReplayGainMode::Loudnorm;
    status.eqActive = config.eqEnabled;
    status.crossfeedActive = config.crossfeedEnabled && config.crossfeedStrength > 0.0001;
  }
  status.crossfeedStrength = status.crossfeedActive ? config.crossfeedStrength : 0.0;
  status.dspActive =
      status.replayGainActive || status.eqActive || status.convolverActive || status.crossfeedActive ||
      status.crossfadeActive;
  return status;
}

ReplayGainMode parseReplayGainModeId(const std::string& mode) {
  std::string normalized = mode;
  std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (normalized == "track") return ReplayGainMode::Track;
  if (normalized == "album") return ReplayGainMode::Album;
  if (normalized == "loudnorm") return ReplayGainMode::Loudnorm;
  return ReplayGainMode::Off;
}

std::string convolverInfoToJson(const ConvolverInfo& info) {
  std::ostringstream json;
  json << "{"
       << "\"loaded\":" << (info.loaded ? "true" : "false") << ","
       << "\"active\":" << (info.active ? "true" : "false") << ","
       << "\"bypassed\":" << (info.bypassed ? "true" : "false") << ","
       << "\"irResampled\":" << (info.irResampled ? "true" : "false") << ","
       << "\"path\":\"" << json_utils::escape(info.path) << "\","
       << "\"sampleRate\":" << info.sampleRate << ","
       << "\"channels\":" << info.channels << ","
       << "\"lengthFrames\":" << info.lengthFrames << ","
       << "\"lengthMs\":" << info.lengthMs << ","
        << "\"partitionSize\":" << info.partitionSize << ","
        << "\"latencyFrames\":" << info.latencyFrames << ","
        << "\"tailFrames\":" << info.tailFrames << ","
        << "\"memoryBytes\":" << info.memoryBytes << ","
        << "\"loading\":" << (info.loading ? "true" : "false") << ","
        << "\"overrunCount\":" << info.overrunCount << ","
        << "\"bypassCount\":" << info.bypassCount << ","
       << "\"lastProcessMs\":" << info.lastProcessMs << ","
       << "\"maxProcessMs\":" << info.maxProcessMs << ","
       << "\"channelMappingMode\":\"" << json_utils::escape(info.channelMappingMode) << "\","
       << "\"warning\":\"" << json_utils::escape(info.warning) << "\","
       << "\"lastError\":\"" << json_utils::escape(info.lastError) << "\""
       << "}";
  return json.str();
}

bool gaplessEnabledFromConfig(const DspConfig& config) {
  return config.gapless || config.crossfadeSeconds > 0.0001;
}

uint32_t parseUintField(const std::string& json, const std::string& key, uint32_t fallback) {
  const std::optional<double> value = json_utils::fieldNumber(json, key);
  if (!value.has_value() || *value < 0.0) return fallback;
  return static_cast<uint32_t>(*value);
}

std::string parseStringField(const std::string& json, const std::string& key, const std::string& fallback) {
  return json_utils::fieldString(json, key).value_or(fallback);
}

bool parseBoolField(const std::string& json, const std::string& key, bool fallback) {
  return json_utils::fieldBool(json, key).value_or(fallback);
}

float parseFloatField(const std::string& json, const std::string& key, float fallback) {
  const std::optional<double> value = json_utils::fieldNumber(json, key);
  return value.has_value() ? static_cast<float>(*value) : fallback;
}

OutputConfig parseOutputConfigJson(const std::string& json) {
  OutputConfig config;
  config.preferredBufferSize = parseUintField(json, "preferredBufferSize", 0);
  config.routingMode = parseChannelRoutingMode(parseStringField(json, "routingMode", "auto"));
  config.wasapiExclusivePushMode = parseBoolField(json, "wasapiExclusivePushMode", false);
  config.pcmToDsdMode = parsePcmToDsdMode(parseStringField(json, "pcmToDsdMode", "off"));
  // 上混参数（可选，缺省走 OutputConfig 默认值）
  config.upmixCenterGain = parseFloatField(json, "upmixCenterGain", config.upmixCenterGain);
  config.upmixLfeGain = parseFloatField(json, "upmixLfeGain", config.upmixLfeGain);
  config.upmixLfeLowpassHz = parseFloatField(json, "upmixLfeLowpassHz", config.upmixLfeLowpassHz);
  config.upmixSurroundGain = parseFloatField(json, "upmixSurroundGain", config.upmixSurroundGain);
  config.upmixSideGain = parseFloatField(json, "upmixSideGain", config.upmixSideGain);
  config.upmixSurroundDelayMs = parseFloatField(json, "upmixSurroundDelayMs", config.upmixSurroundDelayMs);
  return config;
}

struct VisualizationQuery {
  size_t spectrumPoints = 64;
  size_t waveformPoints = 128;
  size_t spectrogramFrames = 48;
  size_t oscilloscopePoints = 1024;
};

VisualizationQuery parseVisualizationQueryJson(const std::string& json) {
  VisualizationQuery query;
  query.spectrumPoints = std::clamp<uint32_t>(parseUintField(json, "spectrumPoints", 64), 8, 4096);
  query.waveformPoints = std::clamp<uint32_t>(parseUintField(json, "waveformPoints", 128), 16, 512);
  query.spectrogramFrames = std::clamp<uint32_t>(parseUintField(json, "spectrogramFrames", 48), 0, 96);
  query.oscilloscopePoints = std::clamp<uint32_t>(parseUintField(json, "oscilloscopePoints", 1024), 0, 4096);
  return query;
}

std::string inactiveVisualizationJson(const VisualizationQuery& query, int sampleRate) {
  std::ostringstream json;
  auto writeZeros = [](std::ostringstream& out, size_t count) {
    out << "[";
    for (size_t i = 0; i < count; ++i) {
      if (i > 0) out << ",";
      out << "0";
    }
    out << "]";
  };
  json << "{\"spectrum\":";
  writeZeros(json, query.spectrumPoints);
  json << ",\"waveform\":";
  writeZeros(json, query.waveformPoints);
  json << ",\"oscilloscope\":";
  writeZeros(json, query.oscilloscopePoints);
  json << ",\"peakDb\":-120,\"rmsDb\":-120,\"lufsMomentary\":null,\"spectrogram\":[],"
       << "\"sampleRate\":" << sampleRate
       << ",\"active\":false,\"tapStatus\":\"stopped\",\"reason\":\"Audio pipeline is stopped\"}";
  return json.str();
}

QueueItem makeManualQueueItem(const std::string& source) {
  QueueItem item;
  item.id = "manual";
  item.source = source;
  item.title = source;
  return item;
}

}  // namespace

TwilightAudioEngine::TwilightAudioEngine() {
  pipeline_ = std::make_unique<AudioPipeline>();
  info_.outputBackend = defaultBackendId();
  if (info_.outputBackend.empty()) info_.outputBackend = "none";
  info_.outputInfo.backend = info_.outputBackend;
  info_.outputInfo.actualBackend = info_.outputBackend;
  info_.outputInfo.exclusive = false;
  info_.outputInfo.accessMode = "shared";
  info_.outputInfo.supportsOutputPerfect = false;
  info_.outputInfo.devicePathKind = "default";
  updatePerfectLocked();
  lastTick_ = std::chrono::steady_clock::now();
  startClock();
}

TwilightAudioEngine::~TwilightAudioEngine() {
  if (pipeline_) pipeline_->stop();
  stopClock();
}

void TwilightAudioEngine::setEventCallback(TAE_EventCallback callback, void* userData) {
  std::lock_guard lock(mutex_);
  eventCallback_ = callback;
  eventUserData_ = userData;
}

TAE_Result TwilightAudioEngine::play(const std::string& source, double startTimeSeconds) {
  if (source.empty()) return TAE_RESULT_INVALID_ARGUMENT;

  std::string backend;
  std::string device;
  double volume = 1.0;
  std::string dspConfigJson;
  bool gaplessEnabled = true;
  QueueItem item;
  std::optional<QueueItem> upcoming;
  {
    std::lock_guard lock(mutex_);
    if (queue_.empty()) {
      item = makeManualQueueItem(source);
      info_.queueIndex = 0;
    } else {
      item = queue_.current().value_or(makeManualQueueItem(source));
      if (item.source.empty() || item.source != source) {
        // Prefer the queued item matching this source so host-injected loudnorm
        // measurements (measuredIntegratedLufs / measuredTruePeakDb) are kept.
        if (auto matched = queue_.findBySource(source)) {
          item = *matched;
        } else {
          item = makeManualQueueItem(source);
        }
      }
      info_.queueIndex = queue_.currentIndex();
    }
    upcoming = queue_.upcoming();
    info_.source = item.source;
    info_.positionSeconds = std::max(0.0, startTimeSeconds);
    info_.durationSeconds = item.durationSeconds;
    info_.codec = inferCodec(item.source);
    info_.state = PlaybackState::Playing;
    info_.isDsd = info_.codec == "dsd";
    info_.dsdMode = info_.isDsd ? dsdModeToString(DsdMode::Unsupported) : dsdModeToString(DsdMode::Pcm);
    info_.dsdRate = 0;
    info_.outputInfo.isDsd = info_.isDsd;
    info_.outputInfo.dsdMode = info_.dsdMode;
    info_.outputInfo.dsdRate = 0;
    info_.playMode = queue_.playModeId();
    info_.hasUpcomingTrack = upcoming.has_value();
    info_.upcomingTrack = upcoming.value_or(QueueItem{});
    backend = info_.outputBackend;
    device = info_.outputDevice;
    volume = info_.volume;
    dspConfigJson = dspConfigJson_;
    gaplessEnabled = gaplessEnabledFromConfig(dspConfig_);
  }

  std::string error;
  const TAE_Result result =
      pipeline_ ? pipeline_->play(item, upcoming, startTimeSeconds, backend, device, volume, dspConfigJson, gaplessEnabled, &error)
                : TAE_RESULT_NOT_INITIALIZED;
  if (result != TAE_RESULT_OK) {
    {
      std::lock_guard lock(mutex_);
      info_.state = PlaybackState::Stopped;
      info_.positionSeconds = 0.0;
    }
    emitError(error.empty() ? "无法启动原生音频播放" : error, result, "play");
    return result;
  }

  std::lock_guard lock(mutex_);
  // play()/playQueueItem pass volume into the pipeline; reassert rate so non-unity rates survive.
  if (pipeline_ && std::abs(info_.playbackRate - 1.0) > 0.0001) {
    pipeline_->setPlaybackRate(info_.playbackRate);
  }
  applyPipelineStatusLocked(pipeline_->status());
  lastTick_ = std::chrono::steady_clock::now();
  publishStateLocked();
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::playQueueItem(const QueueItem& item, double startTimeSeconds) {
  if (item.source.empty()) return TAE_RESULT_INVALID_ARGUMENT;

  std::string backend;
  std::string device;
  double volume = 1.0;
  std::string dspConfigJson;
  bool gaplessEnabled = true;
  std::optional<QueueItem> upcoming;
  {
    std::lock_guard lock(mutex_);
    upcoming = queue_.upcoming();
    info_.queueIndex = queue_.currentIndex();
    info_.source = item.source;
    info_.positionSeconds = std::max(0.0, startTimeSeconds);
    info_.durationSeconds = item.durationSeconds;
    info_.codec = inferCodec(item.source);
    info_.state = PlaybackState::Playing;
    info_.isDsd = info_.codec == "dsd";
    info_.dsdMode = info_.isDsd ? dsdModeToString(DsdMode::Unsupported) : dsdModeToString(DsdMode::Pcm);
    info_.dsdRate = 0;
    info_.outputInfo.isDsd = info_.isDsd;
    info_.outputInfo.dsdMode = info_.dsdMode;
    info_.outputInfo.dsdRate = 0;
    info_.playMode = queue_.playModeId();
    info_.hasUpcomingTrack = upcoming.has_value();
    info_.upcomingTrack = upcoming.value_or(QueueItem{});
    backend = info_.outputBackend;
    device = info_.outputDevice;
    volume = info_.volume;
    dspConfigJson = dspConfigJson_;
    gaplessEnabled = gaplessEnabledFromConfig(dspConfig_);
  }

  std::string error;
  const TAE_Result result =
      pipeline_ ? pipeline_->play(item, upcoming, startTimeSeconds, backend, device, volume, dspConfigJson, gaplessEnabled, &error)
                : TAE_RESULT_NOT_INITIALIZED;
  if (result != TAE_RESULT_OK) {
    {
      std::lock_guard lock(mutex_);
      info_.state = PlaybackState::Stopped;
      info_.positionSeconds = 0.0;
    }
    emitError(error.empty() ? "无法启动原生音频播放" : error, result, "play");
    return result;
  }

  std::lock_guard lock(mutex_);
  // play()/playQueueItem pass volume into the pipeline; reassert rate so non-unity rates survive.
  if (pipeline_ && std::abs(info_.playbackRate - 1.0) > 0.0001) {
    pipeline_->setPlaybackRate(info_.playbackRate);
  }
  applyPipelineStatusLocked(pipeline_->status());
  lastTick_ = std::chrono::steady_clock::now();
  publishStateLocked();
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::pause() {
  if (pipeline_) pipeline_->togglePause();
  std::lock_guard lock(mutex_);
  if (pipeline_) {
    applyPipelineStatusLocked(pipeline_->status());
  } else {
    info_.state = info_.state == PlaybackState::Paused ? PlaybackState::Playing : PlaybackState::Paused;
  }
  lastTick_ = std::chrono::steady_clock::now();
  publishStateLocked();
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::stop() {
  if (pipeline_) pipeline_->stop();
  std::lock_guard lock(mutex_);
  info_.state = PlaybackState::Stopped;
  info_.positionSeconds = 0.0;
  publishStateLocked();
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::seek(double positionSeconds) {
  if (!std::isfinite(positionSeconds)) return TAE_RESULT_INVALID_ARGUMENT;
  std::string error;
  PlaybackState currentState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    currentState = info_.state;
  }
  if (pipeline_ && currentState != PlaybackState::Stopped) {
    if (pipeline_->isDopPathActive() || pipeline_->isNativeDsdPathActive()) {
      return restartCurrentPlaybackForReroute(
          std::max(0.0, positionSeconds),
          currentState,
          {},
          "seek");
    }
    const TAE_Result result = pipeline_->seek(positionSeconds, &error);
    if (result != TAE_RESULT_OK) {
      emitError(error.empty() ? "无法跳转原生音频播放位置" : error, result, "seek");
      return result;
    }
  }
  std::lock_guard lock(mutex_);
  if (pipeline_) {
    applyPipelineStatusLocked(pipeline_->status());
  } else {
    info_.positionSeconds = std::max(0.0, positionSeconds);
  }
  lastTick_ = std::chrono::steady_clock::now();
  publishStateLocked();
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setVolume(double volume) {
  if (!std::isfinite(volume)) return TAE_RESULT_INVALID_ARGUMENT;
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    info_.volume = std::clamp(volume, 0.0, 1.0);
    if (pipeline_) {
      pipeline_->setVolume(info_.volume);
      applyPipelineStatusLocked(pipeline_->status());
    }
    if (pipeline_ && info_.state != PlaybackState::Stopped) {
      if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
        publishStateLocked();
      }
    } else {
      updatePerfectLocked();
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "volume");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setPlaybackRate(double rate) {
  if (!std::isfinite(rate)) return TAE_RESULT_INVALID_ARGUMENT;
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    info_.playbackRate = std::clamp(rate, 0.5, 2.0);
    if (pipeline_) {
      pipeline_->setPlaybackRate(info_.playbackRate);
      applyPipelineStatusLocked(pipeline_->status());
    }
    if (pipeline_ && info_.state != PlaybackState::Stopped) {
      if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
        publishStateLocked();
      }
    } else {
      updatePerfectLocked();
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "playbackRate");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setLoopRange(double startSeconds, double endSeconds) {
  if (pipeline_) {
    pipeline_->setLoopRange(startSeconds, endSeconds);
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setOutputDevice(const std::string& deviceId) {
  std::string source;
  double position = 0.0;
  PlaybackState state = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    const std::string nextDevice = deviceId.empty() ? "auto" : deviceId;
    info_.outputDevice = nextDevice;
    source = info_.source;
    position = info_.positionSeconds;
    state = info_.state;
    if (state == PlaybackState::Stopped) {
      info_.outputInfo.deviceName = nextDevice;
      info_.outputInfo.actualDeviceName = nextDevice;
    }
    publishStateLocked();
  }
  if (state != PlaybackState::Stopped && !source.empty()) {
    const TAE_Result result = play(source, position);
    if (result == TAE_RESULT_OK && state == PlaybackState::Paused) pause();
    return result;
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setOutputBackend(const std::string& backendId) {
  if (backendId.empty()) return TAE_RESULT_INVALID_ARGUMENT;
  std::string source;
  double position = 0.0;
  PlaybackState state = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    info_.outputBackend = backendId == "wasapi-shared" ? "wasapi" : backendId;
    info_.outputInfo = {};
    info_.outputInfo.backend = info_.outputBackend;
    info_.outputInfo.actualBackend = info_.outputBackend;
    info_.outputInfo.channelRoutingMode = channelRoutingModeToString(outputConfig_.routingMode);
    source = info_.source;
    position = info_.positionSeconds;
    state = info_.state;
    updatePerfectLocked();
    publishStateLocked();
  }
  if (state != PlaybackState::Stopped && !source.empty()) {
    const TAE_Result result = play(source, position);
    if (result == TAE_RESULT_OK && state == PlaybackState::Paused) pause();
    return result;
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::loadQueue(const std::string& queueJson, int startIndex) {
  std::string error;
  std::lock_guard lock(mutex_);
  if (!queue_.loadFromJson(queueJson, startIndex, &error)) {
    emitError(error.empty() ? "播放队列加载失败" : error, TAE_RESULT_INVALID_ARGUMENT, "queue");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  info_.queueIndex = queue_.currentIndex();
  info_.playMode = queue_.playModeId();
  const auto upcoming = queue_.upcoming();
  info_.hasUpcomingTrack = upcoming.has_value();
  info_.upcomingTrack = upcoming.value_or(QueueItem{});
  // Mid-play loudnorm / library RG injection: overlay measurements onto the
  // active (and matching preload) stream without reopening the device.
  if (pipeline_) {
    if (const auto current = queue_.current()) {
      pipeline_->refreshQueueReplayGainTags(*current);
    }
    if (upcoming) {
      pipeline_->refreshQueueReplayGainTags(*upcoming);
    }
  }
  emit("queue-change", queue_.queueJson());
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::addToQueue(const std::string& itemJson) {
  std::string error;
  std::lock_guard lock(mutex_);
  if (!queue_.addFromJson(itemJson, &error)) {
    emitError(error.empty() ? "无法加入播放队列" : error, TAE_RESULT_INVALID_ARGUMENT, "queue");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  emit("queue-change", queue_.queueJson());
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::removeFromQueue(int index) {
  std::lock_guard lock(mutex_);
  if (!queue_.removeAt(index)) return TAE_RESULT_INVALID_ARGUMENT;
  info_.queueIndex = queue_.currentIndex();
  emit("queue-change", queue_.queueJson());
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::next() {
  std::optional<QueueItem> item;
  std::optional<QueueItem> upcoming;
  PlaybackState state = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    item = queue_.next();
    if (!item) return TAE_RESULT_OK;
    upcoming = queue_.upcoming();
    state = info_.state;
    info_.queueIndex = queue_.currentIndex();
    info_.positionSeconds = 0.0;
    info_.source = item->source;
    info_.durationSeconds = item->durationSeconds;
    info_.codec = inferCodec(item->source);
    info_.hasUpcomingTrack = upcoming.has_value();
    info_.upcomingTrack = upcoming.value_or(QueueItem{});
    publishStateLocked();
  }

  if (state != PlaybackState::Stopped && item) {
    std::string error;
    bool usedPreload = pipeline_ && pipeline_->skipToPreloaded(*item, &error);
    if (usedPreload) {
      if (pipeline_) pipeline_->consumeTrackStarted(nullptr);
      if (pipeline_) pipeline_->preloadNext(upcoming, &error);
      std::lock_guard lock(mutex_);
      applyPipelineStatusLocked(pipeline_->status());
      publishStateLocked();
    } else {
      const TAE_Result result = playQueueItem(*item, 0.0);
      if (result != TAE_RESULT_OK) return result;
    }
  }
  emit("next", getPlaybackInfoJson());
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::previous() {
  std::optional<QueueItem> item;
  PlaybackState state = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    item = queue_.previous();
    if (!item) return TAE_RESULT_OK;
    state = info_.state;
    info_.queueIndex = queue_.currentIndex();
    info_.positionSeconds = 0.0;
    info_.source = item->source;
    info_.durationSeconds = item->durationSeconds;
    info_.codec = inferCodec(item->source);
    const auto upcoming = queue_.upcoming();
    info_.hasUpcomingTrack = upcoming.has_value();
    info_.upcomingTrack = upcoming.value_or(QueueItem{});
    publishStateLocked();
  }

  if (state != PlaybackState::Stopped && item) {
    const TAE_Result result = playQueueItem(*item, 0.0);
    if (result != TAE_RESULT_OK) return result;
  }
  emit("previous", getPlaybackInfoJson());
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setPlayMode(const std::string& mode) {
  std::optional<QueueItem> upcoming;
  {
    std::lock_guard lock(mutex_);
    queue_.setPlayMode(QueueManager::parsePlayMode(mode));
    info_.playMode = queue_.playModeId();
    info_.queueIndex = queue_.currentIndex();
    upcoming = queue_.upcoming();
    info_.hasUpcomingTrack = upcoming.has_value();
    info_.upcomingTrack = upcoming.value_or(QueueItem{});
    publishStateLocked();
  }
  std::string error;
  if (pipeline_) pipeline_->preloadNext(upcoming, &error);
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setDspConfig(const std::string& dspJson) {
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  DspConfig previousConfig;
  const DspConfig nextConfig = DspChain::parseConfigJson(dspJson.empty() ? "{}" : dspJson);
  {
    std::lock_guard lock(mutex_);
    previousConfig = dspConfig_;
    dspConfigJson_ = dspJson.empty() ? "{}" : dspJson;
    dspConfig_ = nextConfig;
    if (pipeline_) pipeline_->setDspConfig(dspConfigJson_);
    if (pipeline_ && info_.state != PlaybackState::Stopped) {
      applyPipelineStatusLocked(pipeline_->status());
      if (info_.isDsd) {
        const bool wantsPcm = nextConfig.dsdOutputMode == DsdOutputMode::Pcm;
        const bool wantsNative =
            nextConfig.dsdOutputMode == DsdOutputMode::Auto || nextConfig.dsdOutputMode == DsdOutputMode::Native;
        const bool wantsDop =
            nextConfig.dsdOutputMode == DsdOutputMode::Auto || nextConfig.dsdOutputMode == DsdOutputMode::Dop ||
            nextConfig.dsdOutputMode == DsdOutputMode::Native;
        // A compatibility-route edit moves the stream to a different device, so it
        // must re-negotiate even when the requested DSD mode itself is unchanged.
        const bool routeChanged = !dsdRouteOverrideEquals(previousConfig.dsdRoute, nextConfig.dsdRoute);
        const bool modeChanged = previousConfig.dsdOutputMode != nextConfig.dsdOutputMode || routeChanged;
        const bool dopActive = pipeline_->isDopPathActive();
        const bool nativeActive = pipeline_->isNativeDsdPathActive();
        // Entering a DSD transport is pointless while processing still forces
        // PCM: the open path applies the same check and lands back in PCM, so
        // the listener only hears the gap. Leaving a DSD transport is never
        // gated — a fallback must always be able to take effect.
        const bool processingForcesPcm = pipeline_->processingForcesDsdPcmFallback();
        if ((dopActive || nativeActive) && wantsPcm) {
          rerouteReason = "DSD output mode forced PCM";
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
        } else if (nativeActive && nextConfig.dsdOutputMode == DsdOutputMode::Dop) {
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
          rerouteReason = "Re-enter DoP output mode";
        } else if (routeChanged && !wantsPcm) {
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
          rerouteReason = "DSD compatibility route changed";
        } else if (modeChanged && wantsNative && !nativeActive && !processingForcesPcm) {
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
          rerouteReason = "Re-enter Native DSD output mode";
        } else if (modeChanged && wantsDop && !dopActive && !nativeActive && !processingForcesPcm) {
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
          rerouteReason = wantsNative ? "Re-enter Native DSD output mode" : "Re-enter DoP output mode";
        }
      }
      if (rerouteReason.empty() &&
          !shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
        publishStateLocked();
      }
    } else {
      const DspStatus configStatus = configuredDspStatusFromConfig(nextConfig);
      info_.replayGainActive = configStatus.replayGainActive;
      info_.loudnormActive = configStatus.loudnormActive;
      info_.eqActive = configStatus.eqActive;
      info_.crossfeedActive = configStatus.crossfeedActive;
      info_.crossfeedStrength = configStatus.crossfeedStrength;
      info_.crossfadeActive = configStatus.crossfadeActive;
      info_.crossfadeSeconds = configStatus.crossfadeSeconds;
      if (!nextConfig.enabled) info_.convolverActive = false;
      updatePerfectLocked();
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "dsp");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setDspGraph(const std::string& graphJson) {
  const std::string next = graphJson.empty() ? "{\"graph\":{\"nodes\":[]}}" : graphJson;
  std::string error;
  AudioPipeline* pipeline = nullptr;
  {
    std::lock_guard lock(mutex_);
    dspGraphJson_ = next;
    pipeline = pipeline_.get();
  }
  if (pipeline && !pipeline->setDspGraph(next, &error)) {
    emitError(error.empty() ? "DSP graph compilation failed" : error, TAE_RESULT_INVALID_ARGUMENT, "dsp-graph");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  {
    std::lock_guard lock(mutex_);
    if (pipeline_) applyPipelineStatusLocked(pipeline_->status());
    updatePerfectLocked();
    publishStateLocked();
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::applyDspState(
    uint64_t revision,
    const std::string& stateJson) {
  const auto payloadRevision = json_utils::fieldNumber(stateJson, "revision");
  const std::string processingJson = json_utils::fieldObject(stateJson, "processing");
  if (revision == 0 || !payloadRevision.has_value() || !std::isfinite(*payloadRevision) ||
      *payloadRevision != std::floor(*payloadRevision) ||
      *payloadRevision != static_cast<double>(revision) || processingJson.empty() ||
      json_utils::fieldObject(stateJson, "graph").empty()) {
    emitError("DSP state payload is invalid", TAE_RESULT_INVALID_ARGUMENT, "dsp-state");
    return TAE_RESULT_INVALID_ARGUMENT;
  }

  const DspConfig nextConfig = DspChain::parseConfigJson(processingJson);
  DspConfig previousConfig;
  {
    std::lock_guard lock(mutex_);
    previousConfig = dspConfig_;
  }

  std::string error;
  if (!pipeline_ || !pipeline_->applyDspState(revision, stateJson, &error)) {
    emitError(
        error.empty() ? "DSP state application failed" : error,
        TAE_RESULT_INVALID_ARGUMENT,
        "dsp-state");
    return TAE_RESULT_INVALID_ARGUMENT;
  }

  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    // The pipeline transaction has compiled and published the request. Only
    // now expose it as the engine's desired state; failed preparation or a
    // saturated RT retirement window leaves all three fields untouched.
    dspConfig_ = nextConfig;
    dspConfigJson_ = processingJson;
    dspGraphJson_ = stateJson;
    applyPipelineStatusLocked(pipeline_->status());
    if (pipeline_ && info_.state != PlaybackState::Stopped) {
      if (info_.isDsd) {
        const bool wantsPcm = nextConfig.dsdOutputMode == DsdOutputMode::Pcm;
        const bool wantsNative =
            nextConfig.dsdOutputMode == DsdOutputMode::Auto || nextConfig.dsdOutputMode == DsdOutputMode::Native;
        const bool wantsDop =
            nextConfig.dsdOutputMode == DsdOutputMode::Auto || nextConfig.dsdOutputMode == DsdOutputMode::Dop ||
            nextConfig.dsdOutputMode == DsdOutputMode::Native;
        // A compatibility-route edit moves the stream to a different device, so it
        // must re-negotiate even when the requested DSD mode itself is unchanged.
        const bool routeChanged = !dsdRouteOverrideEquals(previousConfig.dsdRoute, nextConfig.dsdRoute);
        const bool modeChanged = previousConfig.dsdOutputMode != nextConfig.dsdOutputMode || routeChanged;
        const bool dopActive = pipeline_->isDopPathActive();
        const bool nativeActive = pipeline_->isNativeDsdPathActive();
        // See setDspConfig: entering a DSD transport while processing still
        // forces PCM only costs the listener a restart and ends up in PCM again.
        const bool processingForcesPcm = pipeline_->processingForcesDsdPcmFallback();
        if ((dopActive || nativeActive) && wantsPcm) {
          rerouteReason = "DSD output mode forced PCM";
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
        } else if (nativeActive && nextConfig.dsdOutputMode == DsdOutputMode::Dop) {
          rerouteReason = "Re-enter DoP output mode";
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
        } else if (routeChanged && !wantsPcm) {
          rerouteReason = "DSD compatibility route changed";
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
        } else if (modeChanged && wantsNative && !nativeActive && !processingForcesPcm) {
          rerouteReason = "Re-enter Native DSD output mode";
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
        } else if (modeChanged && wantsDop && !dopActive && !nativeActive && !processingForcesPcm) {
          rerouteReason = wantsNative ? "Re-enter Native DSD output mode" :
                                        "Re-enter DoP output mode";
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
        }
      }
      if (rerouteReason.empty() &&
          !shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
        publishStateLocked();
      }
    } else {
      const DspStatus configStatus = configuredDspStatusFromConfig(nextConfig);
      info_.replayGainActive = configStatus.replayGainActive;
      info_.loudnormActive = configStatus.loudnormActive;
      info_.eqActive = configStatus.eqActive;
      info_.crossfeedActive = configStatus.crossfeedActive;
      info_.crossfeedStrength = configStatus.crossfeedStrength;
      info_.crossfadeActive = configStatus.crossfadeActive;
      info_.crossfadeSeconds = configStatus.crossfadeSeconds;
      if (!nextConfig.enabled) info_.convolverActive = false;
      updatePerfectLocked();
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(
        reroutePosition,
        rerouteState,
        rerouteReason,
        "dsp-state");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setOutputConfig(const std::string& outputConfigJson) {
  OutputConfig parsed = parseOutputConfigJson(outputConfigJson.empty() ? "{}" : outputConfigJson);
  std::string error;
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  if (pipeline_ && !pipeline_->setOutputConfig(parsed, &error)) {
    emitError(error.empty() ? "输出配置设置失败" : error, TAE_RESULT_INVALID_ARGUMENT, "output-config");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  {
    std::lock_guard lock(mutex_);
    // Persist only after AudioPipeline has completed its native topology
    // transaction and acknowledged the candidate output.
    outputConfig_ = parsed;
    info_.outputInfo.channelRoutingMode = channelRoutingModeToString(outputConfig_.routingMode);
    if (pipeline_ && info_.state != PlaybackState::Stopped) {
      applyPipelineStatusLocked(pipeline_->status());
      if (shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
        // Defer publish until the reroute completes.
      } else {
        publishStateLocked();
      }
    } else {
      updatePerfectLocked();
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "output-config");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::loadImpulseResponse(const std::string& path) {
  if (path.empty()) return TAE_RESULT_INVALID_ARGUMENT;
  std::string error;
  if (!pipeline_ || !pipeline_->loadImpulseResponse(path, &error)) {
    emitError(error.empty() ? "脉冲响应加载失败" : error, TAE_RESULT_INVALID_ARGUMENT, "dsp");
    return TAE_RESULT_INTERNAL_ERROR;
  }
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    applyPipelineStatusLocked(pipeline_->status());
    if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "dsp");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::unloadImpulseResponse() {
  if (!pipeline_) return TAE_RESULT_NOT_INITIALIZED;
  pipeline_->unloadImpulseResponse();
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    applyPipelineStatusLocked(pipeline_->status());
    if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "dsp");
  }
  return TAE_RESULT_OK;
}

std::string TwilightAudioEngine::getConvolverInfoJson() const {
  return convolverInfoToJson(pipeline_ ? pipeline_->convolverInfo() : ConvolverInfo{});
}

TAE_Result TwilightAudioEngine::setEqBands(const std::string& eqJson) {
  std::string error;
  if (!pipeline_ || !pipeline_->setEqBands(eqJson, &error)) {
    emitError(error.empty() ? "均衡器设置失败" : error, TAE_RESULT_INVALID_ARGUMENT, "dsp");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    applyPipelineStatusLocked(pipeline_->status());
    if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "dsp");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setEqPreset(const std::string& presetJson) {
  std::string error;
  if (!pipeline_ || !pipeline_->setEqPreset(presetJson, &error)) {
    emitError(error.empty() ? "均衡器预设应用失败" : error, TAE_RESULT_INVALID_ARGUMENT, "dsp");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    applyPipelineStatusLocked(pipeline_->status());
    if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "dsp");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setCrossfeedStrength(double strength) {
  if (!std::isfinite(strength)) return TAE_RESULT_INVALID_ARGUMENT;
  if (!pipeline_) return TAE_RESULT_NOT_INITIALIZED;
  pipeline_->setCrossfeedStrength(strength);
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    applyPipelineStatusLocked(pipeline_->status());
    if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "dsp");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setReplayGainMode(
    const std::string& mode,
    double preampDb,
    double fallbackDb,
    bool clip) {
  if (!std::isfinite(preampDb) || !std::isfinite(fallbackDb)) return TAE_RESULT_INVALID_ARGUMENT;
  if (!pipeline_) return TAE_RESULT_NOT_INITIALIZED;
  pipeline_->setReplayGainMode(parseReplayGainModeId(mode), preampDb, fallbackDb, clip);
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    applyPipelineStatusLocked(pipeline_->status());
    if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "dsp");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setNativeDspPluginChain(const std::string& chainJson) {
  std::string nextChain;
  {
    std::lock_guard lock(mutex_);
    nativeDspPluginChainJson_ = chainJson.empty() ? "{\"plugins\":[]}" : chainJson;
    nextChain = nativeDspPluginChainJson_;
  }
  if (pipeline_) {
    pipeline_->setNativeDspPluginChain(nextChain);
  }
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    if (pipeline_) applyPipelineStatusLocked(pipeline_->status());
    if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "dsp");
  }
  return TAE_RESULT_OK;
}

std::string TwilightAudioEngine::getNativeDspPluginStatusJson() const {
  std::lock_guard lock(mutex_);
  if (pipeline_) return pipeline_->nativeDspPluginStatusJson();
  return "{\"plugins\":[]}";
}

std::string TwilightAudioEngine::getDspConfig() const {
  std::lock_guard lock(mutex_);
  return dspConfigJson_;
}

std::string TwilightAudioEngine::getDspGraphStatusJson() const {
  std::lock_guard lock(mutex_);
  return pipeline_ ? pipeline_->dspGraphStatusJson()
                   : "{\"revision\":0,\"activeSceneId\":null,\"totalLatencyFrames\":0,\"totalTailFrames\":0,\"nodes\":[]}";
}

std::string TwilightAudioEngine::getMetadataJson(const std::string& source) const {
  return readMetadataJson(source);
}

std::string TwilightAudioEngine::getQueueJson() const {
  std::lock_guard lock(mutex_);
  return queue_.queueJson();
}

std::string TwilightAudioEngine::getUpcomingTrackJson() const {
  std::lock_guard lock(mutex_);
  return queue_.upcomingJson();
}

std::string TwilightAudioEngine::enumerateDevicesJson() const {
  return enumeratePlatformDevicesJson();
}

std::string TwilightAudioEngine::enumerateBackendsJson() const {
  std::ostringstream json;
  json << "[";
  bool first = true;
  auto append = [&](const char* id, const char* label, bool supportsExclusive, bool optional = false) {
    if (!first) json << ",";
    first = false;
    json << "{\"id\":\"" << id << "\",\"label\":\"" << label << "\",\"supportsExclusive\":"
         << (supportsExclusive ? "true" : "false");
    if (optional) json << ",\"optional\":true";
    json << "}";
  };
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  append("wasapi", "共享输出", false);
  append("wasapi-exclusive", "独占输出", true);
#endif
#if defined(_WIN32) && defined(TAE_ENABLE_ASIO)
  append("asio", "专业声卡输出", true, true);
#endif
#if defined(__APPLE__) && defined(TAE_ENABLE_COREAUDIO)
  append("coreaudio", "苹果系统音频", false);
  append("coreaudio-exclusive", "独占输出 (Hog Mode)", true);
#endif
#if defined(__linux__) && defined(TAE_ENABLE_ALSA)
  append("alsa", "Linux ALSA 输出", false);
#endif
  json << "]";
  return json.str();
}

std::string TwilightAudioEngine::engineCapabilitiesJson() const {
  const std::string backends = enumerateBackendsJson();
  const std::string backendCapabilities = backendCapabilitiesJson();
  bool nativeDsdCapable = false;
  bool dopCapable = false;
  {
    std::lock_guard lock(mutex_);
    nativeDsdCapable = info_.outputInfo.driverNativeDsdCapable;
    dopCapable = info_.outputInfo.driverDopCapable;
  }
  // The built-in DSD-preserving DST decoder (vendored dstdec) makes SACD ISO
  // DST-compressed tracks playable. Report the capability honestly: when the
  // provider is available, sacdIsoDst=true and DST tracks enter the same
  // Native DSD / DoP / PCM decision chain as uncompressed DSD.
  bool sacdDstAvailable = false;
  bool sacdDstProviderRegistered = false;
  std::string sacdDstReasonCode;
  std::string sacdDstReason;
  if (auto provider = createDefaultSacdDstDecoderProvider()) {
    sacdDstProviderRegistered = true;
    std::string reason;
    sacdDstAvailable = provider->available(&reason);
    if (!sacdDstAvailable) {
      sacdDstReasonCode = kSacdDstDsdProviderUnavailableReasonCode;
      sacdDstReason = reason.empty() ? kSacdDstDsdProviderUnavailableReason : reason;
    }
  } else {
    sacdDstReasonCode = kSacdDstDsdProviderUnavailableReasonCode;
    sacdDstReason = kSacdDstDsdProviderUnavailableReason;
  }
  std::ostringstream json;
  json << "{"
       << "\"version\":\"" << TAE_GetVersion() << "\","
       << "\"defaultBackend\":\"" << json_utils::escape(defaultBackendId()) << "\","
       << "\"pcmPassthrough\":true,"
       << "\"outputPerfectRequiresPcmPassthrough\":true,"
       << "\"htmlAudioFallbackDefault\":false,"
       << "\"dsdModes\":[\"pcm\",\"dop\",\"native\",\"unsupported\"],"
       << "\"sacdProgramModes\":[\"auto\",\"stereo\",\"multichannel\"],"
       << "\"devicePathKinds\":[\"default\",\"hw\",\"plughw\",\"hal\",\"asio\"],"
       << "\"dsd\":{\"native\":" << (nativeDsdCapable ? "true" : "false") << ",\"dop\":" << (dopCapable ? "true" : "false")
        << ",\"sacdIso\":true,\"sacdIsoDst\":" << (sacdDstAvailable ? "true" : "false")
        << ",\"sacdIsoDstMode\":\"" << (sacdDstAvailable ? "native" : "unavailable") << "\","
        << "\"sacdIsoDstReasonCode\":\"" << json_utils::escape(sacdDstReasonCode) << "\","
        << "\"sacdIsoDstReason\":\"" << json_utils::escape(sacdDstReason) << "\",\"mode\":\"pcm\"},"
       << "\"features\":{"
       << "\"ffmpeg\":"
#if defined(TAE_HAS_FFMPEG)
       << "true"
#else
       << "false"
#endif
       << ",\"wasapi\":"
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
       << "true"
#else
       << "false"
#endif
       << ",\"asio\":"
#if defined(_WIN32) && defined(TAE_ENABLE_ASIO)
       << "true"
#else
       << "false"
#endif
       << ",\"coreaudio\":"
#if defined(__APPLE__) && defined(TAE_ENABLE_COREAUDIO)
       << "true"
#else
       << "false"
#endif
       << ",\"alsa\":"
#if defined(__linux__) && defined(TAE_ENABLE_ALSA)
       << "true"
#else
       << "false"
#endif
       << ",\"nativeDsd\":" << (nativeDsdCapable ? "true" : "false") << ",\"dop\":" << (dopCapable ? "true" : "false")
        << ",\"sacdIso\":true,\"sacdIsoDst\":" << (sacdDstAvailable ? "true" : "false")
        << ",\"sacdIsoDstDsdProvider\":" << (sacdDstProviderRegistered ? "true" : "false") << ","
       << "\"audioPluginSystem\":true,\"nativeDsp\":true,\"ebur128\":"
#if defined(TAE_HAS_EBUR128)
       << "true"
#else
       << "false"
#endif
       << ",\"loudnessAnalysis\":"
#if defined(TAE_HAS_EBUR128) && defined(TAE_HAS_FFMPEG)
       << "true"
#else
       << "false"
#endif
       << "},\"backends\":" << backends
       << ",\"backendCapabilities\":" << backendCapabilities
       << ",\"plugins\":" << pluginCapabilitiesJson()
       << ",\"output\":{\"accessModes\":[\"shared\",\"exclusive\",\"hog\",\"direct\",\"plugin\"]}"
       << "}";
  return json.str();
}

std::string TwilightAudioEngine::getLastErrorJson() const {
  std::lock_guard lock(errorMutex_);
  const bool hasError = !lastError_.empty();
  std::ostringstream json;
  json << "{\"hasError\":" << (hasError ? "true" : "false") << ",\"code\":\""
       << resultToString(hasError ? lastErrorCode_ : TAE_RESULT_OK) << "\",\"message\":\""
       << json_utils::escape(lastError_) << "\",\"backend\":\"\",\"context\":\""
       << json_utils::escape(lastErrorContext_.empty() ? "native" : lastErrorContext_) << "\",\"recoverable\":"
       << (hasError && lastErrorCode_ != TAE_RESULT_INVALID_ARGUMENT ? "true" : "false") << "}";
  return json.str();
}

std::string TwilightAudioEngine::getPlaybackInfoJson() const {
  std::lock_guard lock(mutex_);
  return playbackInfoToJson(info_);
}

size_t TwilightAudioEngine::getSpectrumData(float* buffer, size_t pointCount) const {
  if (!buffer || pointCount == 0) return 0;
  if (pipeline_) {
    const size_t written = pipeline_->getSpectrumData(buffer, pointCount);
    if (written > 0) return written;
  }
  std::lock_guard lock(mutex_);
  const double phase = info_.positionSeconds;
  for (size_t i = 0; i < pointCount; ++i) {
    const double x = static_cast<double>(i) / static_cast<double>(pointCount);
    buffer[i] = static_cast<float>((std::sin((x * 18.0 + phase) * 3.14159) + 1.0) * 0.25);
  }
  return pointCount;
}

std::string TwilightAudioEngine::getVisualizationDataJson(const std::string& optionsJson) const {
  const VisualizationQuery query = parseVisualizationQueryJson(optionsJson.empty() ? "{}" : optionsJson);
  if (pipeline_) {
    return pipeline_->getVisualizationDataJson(
        query.spectrumPoints,
        query.waveformPoints,
        query.spectrogramFrames,
        query.oscilloscopePoints);
  }
  std::lock_guard lock(mutex_);
  return inactiveVisualizationJson(query, info_.actualSampleRate);
}

void TwilightAudioEngine::startClock() {
  clockThread_ = std::thread([this] { clockLoop(); });
}

void TwilightAudioEngine::stopClock() {
  running_ = false;
  if (clockThread_.joinable()) clockThread_.join();
}

void TwilightAudioEngine::clockLoop() {
  while (running_) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    std::string payload;
    bool emitTick = false;
    bool emitEnded = false;
    PipelineStatus pipelineStatus;
    const bool hasPipelineStatus = pipeline_ != nullptr;
    bool deviceInvalidated = false;
    bool renderError = false;
    bool trackStarted = false;
    QueueItem startedItem;
    std::string deviceInvalidatedMessage;
    std::string renderErrorMessage;
    if (hasPipelineStatus) {
      // A-B loop enforcement (seek is not RT-safe — runs on clock thread).
      std::string loopError;
      if (pipeline_->enforceLoopRange(&loopError)) {
        // Refresh status after an in-loop seek so UI sees the jump promptly.
        pipelineStatus = pipeline_->status();
      } else {
        pipelineStatus = pipeline_->status();
      }
      emitEnded = pipeline_->consumeEnded();
      deviceInvalidated = pipeline_->consumeDeviceInvalidated(&deviceInvalidatedMessage);
      renderError = pipeline_->consumeRenderError(&renderErrorMessage);
      trackStarted = pipeline_->consumeTrackStarted(&startedItem);
      // A render callback can promote the preload between the first status snapshot and the
      // track-start flag read. Refresh after observing that flag so the queue-index transition is
      // never published with the previous CUE segment's duration or ReplayGain state.
      if (trackStarted) pipelineStatus = pipeline_->status();
    }
    if (hasPipelineStatus &&
        pipelineStatus.appliedConfigRevision > lastEmittedAppliedConfigRevision_) {
      lastEmittedAppliedConfigRevision_ = pipelineStatus.appliedConfigRevision;
      std::ostringstream configPayload;
      configPayload << "{\"requestedConfigRevision\":" << pipelineStatus.requestedConfigRevision
                    << ",\"appliedConfigRevision\":" << pipelineStatus.appliedConfigRevision << "}";
      emit("config-applied", configPayload.str());
    }
    if (deviceInvalidated) {
      std::string source;
      double position = 0.0;
      PlaybackState previousState = PlaybackState::Stopped;
      bool recover = false;
      {
        std::lock_guard lock(mutex_);
        previousState = info_.state;
        if (hasPipelineStatus) {
          info_.positionSeconds = pipelineStatus.positionSeconds;
          info_.durationSeconds = pipelineStatus.stream.durationSeconds;
          info_.source = pipelineStatus.stream.source.empty() ? info_.source : pipelineStatus.stream.source;
        }
        source = info_.source;
        position = info_.positionSeconds;
        recover = info_.outputDevice == "auto" && !source.empty() && previousState != PlaybackState::Stopped;
        if (!recover) {
          info_.state = PlaybackState::Stopped;
          payload = playbackInfoToJson(info_);
          emitTick = true;
        }
      }
      if (recover) {
        const TAE_Result result = play(source, position);
        if (result == TAE_RESULT_OK && previousState == PlaybackState::Paused) {
          pause();
        } else if (result != TAE_RESULT_OK) {
          emitError(
              deviceInvalidatedMessage.empty() ? "输出设备已失效，自动恢复失败" : deviceInvalidatedMessage,
              TAE_RESULT_BACKEND_UNAVAILABLE,
              "device-recovery");
        }
      } else {
        if (pipeline_) pipeline_->stop();
        emitError(
            deviceInvalidatedMessage.empty() ? "输出设备已失效" : deviceInvalidatedMessage,
            TAE_RESULT_BACKEND_UNAVAILABLE,
            "device");
        if (emitTick) emit("property-change", payload);
      }
      continue;
    }
    if (renderError) {
      {
        std::lock_guard lock(mutex_);
        if (hasPipelineStatus) applyPipelineStatusLocked(pipelineStatus);
        info_.state = PlaybackState::Stopped;
        payload = playbackInfoToJson(info_);
        emitTick = true;
      }
      emitError(
          renderErrorMessage.empty() ? "音频渲染失败" : renderErrorMessage,
          TAE_RESULT_BACKEND_UNAVAILABLE,
          "render");
      if (emitTick) emit("property-change", payload);
      continue;
    }
    if (trackStarted) {
      std::optional<QueueItem> upcoming;
      {
        std::lock_guard lock(mutex_);
        // next() advances the queue itself and then swallows the
        // track-started flag. If this clock tick observes the flag inside that
        // window instead, the queue is already on the started item and
        // advancing again would skip a track. Compare by item id; fall back to
        // source + CUE identity when the host supplied no id.
        const auto current = queue_.current();
        const bool queueAlreadyOnStartedItem =
            current.has_value() && startedItem.source == current->source &&
            (!startedItem.id.empty()
                 ? startedItem.id == current->id
                 : startedItem.cueStartSeconds == current->cueStartSeconds &&
                       startedItem.cueEndSeconds == current->cueEndSeconds);
        if (!queueAlreadyOnStartedItem) {
          queue_.advanceAfterEnd();
        }
        applyPipelineStatusLocked(pipelineStatus);
        info_.queueIndex = queue_.currentIndex();
        info_.playMode = queue_.playModeId();
        upcoming = queue_.upcoming();
        info_.hasUpcomingTrack = upcoming.has_value();
        info_.upcomingTrack = upcoming.value_or(QueueItem{});
        payload = playbackInfoToJson(info_);
        emitTick = true;
      }
      std::string preloadError;
      if (pipeline_) pipeline_->preloadNext(upcoming, &preloadError);
      if (emitTick) emit("property-change", payload);
      emit("start-file", "{}");
      continue;
    }
    std::optional<QueueItem> autoNextItem;
    {
      std::lock_guard lock(mutex_);
      if (hasPipelineStatus && info_.state != PlaybackState::Stopped) {
        applyPipelineStatusLocked(pipelineStatus);
      }
      if (emitEnded) {
        autoNextItem = queue_.advanceAfterEnd();
        if (autoNextItem && !autoNextItem->source.empty()) {
          info_.queueIndex = queue_.currentIndex();
          info_.playMode = queue_.playModeId();
          info_.source = autoNextItem->source;
          info_.durationSeconds = autoNextItem->durationSeconds;
          info_.positionSeconds = 0.0;
          info_.codec = inferCodec(autoNextItem->source);
          info_.hasUpcomingTrack = queue_.upcoming().has_value();
          info_.upcomingTrack = queue_.upcoming().value_or(QueueItem{});
        } else {
          info_.state = PlaybackState::Stopped;
          if (info_.durationSeconds > 0.0) info_.positionSeconds = info_.durationSeconds;
        }
      }
      if (!autoNextItem &&
          (info_.state == PlaybackState::Playing || info_.state == PlaybackState::Paused || emitEnded)) {
        payload = playbackInfoToJson(info_);
        emitTick = true;
      }
    }
    if (autoNextItem && !autoNextItem->source.empty()) {
      // Prefer preloaded promote (no device stop/reopen), same as next().
      std::string promoteError;
      const bool usedPreload = pipeline_ && pipeline_->skipToPreloaded(*autoNextItem, &promoteError);
      if (usedPreload) {
        if (pipeline_) pipeline_->consumeTrackStarted(nullptr);
        std::optional<QueueItem> upcomingAfterPromote;
        {
          std::lock_guard lock(mutex_);
          upcomingAfterPromote = queue_.upcoming();
          info_.hasUpcomingTrack = upcomingAfterPromote.has_value();
          info_.upcomingTrack = upcomingAfterPromote.value_or(QueueItem{});
          applyPipelineStatusLocked(pipeline_->status());
          publishStateLocked();
        }
        std::string preloadError;
        if (pipeline_) pipeline_->preloadNext(upcomingAfterPromote, &preloadError);
        emit("start-file", "{}");
      } else {
        const TAE_Result result = playQueueItem(*autoNextItem, 0.0);
        if (result == TAE_RESULT_OK) {
          emit("start-file", "{}");
        } else {
          emit("end-file", "{\"reason\":\"error\"}");
        }
      }
      continue;
    }
    if (emitTick) emit("property-change", payload);
    if (emitEnded) emit("end-file", "{\"reason\":\"eof\"}");
  }
}

void TwilightAudioEngine::emit(const char* type, const std::string& payload) const {
  TAE_EventCallback callback = eventCallback_;
  void* userData = eventUserData_;
  if (callback) callback(type, payload.c_str(), userData);
}

void TwilightAudioEngine::emitError(const std::string& message, TAE_Result code, const std::string& context) const {
  {
    std::lock_guard lock(errorMutex_);
    lastError_ = message;
    lastErrorCode_ = code;
    lastErrorContext_ = context.empty() ? "native" : context;
  }
  emit("error", "{\"code\":\"" + std::string(resultToString(code)) + "\",\"message\":\"" + json_utils::escape(message) +
                    "\",\"context\":\"" + json_utils::escape(lastErrorContext_) + "\"}");
}

void TwilightAudioEngine::publishStateLocked() const {
  emit("playback-info", playbackInfoToJson(info_));
}

void TwilightAudioEngine::applyPipelineStatusLocked(const PipelineStatus& status) {
  switch (status.state) {
    case PipelineState::Playing:
      info_.state = PlaybackState::Playing;
      break;
    case PipelineState::Paused:
      info_.state = PlaybackState::Paused;
      break;
    case PipelineState::Stopped:
    default:
      info_.state = PlaybackState::Stopped;
      break;
  }

  info_.positionSeconds = status.positionSeconds;
  info_.requestedConfigRevision = status.requestedConfigRevision;
  info_.appliedConfigRevision = status.appliedConfigRevision;
  info_.durationSeconds = status.stream.durationSeconds;
  info_.source = status.stream.source.empty() ? info_.source : status.stream.source;
  info_.codec = status.stream.codec.empty() ? info_.codec : status.stream.codec;
  info_.bitrate = static_cast<int>(std::max<int64_t>(0, status.stream.bitrate));
  info_.sourceSampleRate = status.stream.sourceFormat.sampleRate;
  info_.sourceBitDepth = status.stream.sourceFormat.bitDepth;
  info_.decodedSampleRate = status.stream.decodedFormat.sampleRate;
  info_.decodedBitDepth = status.stream.decodedFormat.bitDepth;
  info_.decodedChannels = status.stream.decodedFormat.channelCount;
  info_.decodedSampleFormat = sampleFormatToString(status.stream.decodedFormat.sampleFormat);
  info_.queueIndex = queue_.currentIndex();
  info_.playMode = queue_.playModeId();
  info_.outputBackend = status.backendId.empty() ? info_.outputBackend : status.backendId;
  (void)status.deviceName;
  info_.outputSampleRate = status.outputFormat.sampleRate;
  info_.outputBitDepth = status.outputFormat.bitDepth;
  info_.outputInfo = status.outputInfo;
  if (info_.outputInfo.backend.empty()) info_.outputInfo.backend = info_.outputBackend;
  if (info_.outputInfo.actualBackend.empty()) info_.outputInfo.actualBackend = info_.outputInfo.backend;
  if (info_.outputInfo.deviceName.empty()) info_.outputInfo.deviceName = status.deviceName;
  if (info_.outputInfo.actualDeviceName.empty()) info_.outputInfo.actualDeviceName = info_.outputInfo.deviceName;
  if (info_.outputInfo.actualDriverName.empty()) info_.outputInfo.actualDriverName = info_.outputInfo.driverName;
  if (info_.outputInfo.actualDriverVersion == 0) info_.outputInfo.actualDriverVersion = info_.outputInfo.driverVersion;
  if (info_.outputInfo.outputSampleRate <= 0) info_.outputInfo.outputSampleRate = status.outputFormat.sampleRate;
  if (info_.outputInfo.outputBitDepth <= 0) info_.outputInfo.outputBitDepth = status.outputFormat.bitDepth;
  info_.outputInfo.sourceExact = status.sourceExact;
  info_.outputInfo.outputPerfect = status.outputPerfect;
  info_.outputInfo.pcmPassthrough = status.outputInfo.pcmPassthrough;
  const std::string nativePlugins = json_utils::fieldArray(status.nativeDspJson, "plugins");
  info_.outputInfo.nativeDspJson = "{\"plugins\":" +
                                    (nativePlugins.empty() ? "[]" : nativePlugins) +
                                    ",\"graph\":" +
                                    (status.dspGraphJson.empty()
                                         ? "{\"revision\":0,\"activeSceneId\":null,\"totalLatencyFrames\":0,\"totalTailFrames\":0,\"nodes\":[]}"
                                         : status.dspGraphJson) + "}";
  info_.outputInfo.isDsd = status.stream.isDsd;
  info_.outputInfo.dsdMode = status.stream.isDsd ? dsdModeToString(status.stream.dsdMode) : dsdModeToString(DsdMode::Pcm);
  info_.outputInfo.dsdRate = status.stream.isDsd ? status.stream.dsdRate : 0;
  if (info_.outputInfo.perfectReason.empty()) info_.outputInfo.perfectReason = status.perfectReason;
  info_.channelCount = status.outputFormat.channelCount;
  info_.dspActive = status.dspActive;
  info_.replayGainActive = status.replayGainActive;
  info_.loudnormActive = status.loudnormActive;
  info_.eqActive = status.eqActive;
  info_.convolverActive = status.convolverActive;
  info_.crossfeedActive = status.crossfeedActive;
  info_.crossfadeActive = status.crossfadeActive;
  info_.fftActive = status.fftActive;
  info_.irResampled = status.irResampled;
  info_.replayGainDb = status.replayGainDb;
  info_.crossfeedStrength = status.crossfeedStrength;
  info_.crossfadeSeconds = status.crossfadeSeconds;
  info_.convolverLatencyFrames = status.convolverLatencyFrames;
  info_.partitionSize = status.partitionSize;
  info_.channelMappingMode = status.channelMappingMode;
  info_.gaplessActive = status.gaplessActive;
  info_.preloadReady = status.preloadReady;
  info_.gaplessBlockedReason = status.gaplessBlockedReason;
  const auto upcoming = queue_.upcoming();
  info_.hasUpcomingTrack = upcoming.has_value();
  info_.upcomingTrack = upcoming.value_or(QueueItem{});
  info_.perfectReason = status.perfectReason;
  info_.streamTitle = status.stream.streamTitle;
  info_.isDsd = status.stream.isDsd;
  info_.dsdMode = status.stream.isDsd ? dsdModeToString(status.stream.dsdMode) : dsdModeToString(DsdMode::Pcm);
  info_.dsdRate = status.stream.isDsd ? status.stream.dsdRate : 0;
  normalizeOutputInfoMirror(info_);
}

void TwilightAudioEngine::updatePerfectLocked() {
  if (info_.outputInfo.backend.empty()) info_.outputInfo.backend = info_.outputBackend;
  if (info_.outputInfo.actualBackend.empty()) info_.outputInfo.actualBackend = info_.outputInfo.backend;
  info_.outputInfo.channelRoutingMode = channelRoutingModeToString(outputConfig_.routingMode);
  if (info_.outputInfo.outputSampleRate <= 0) info_.outputInfo.outputSampleRate = info_.outputSampleRate;
  if (info_.outputInfo.outputBitDepth <= 0) info_.outputInfo.outputBitDepth = info_.outputBitDepth;

  AudioFormat sourceFormat;
  sourceFormat.sampleRate = info_.sourceSampleRate;
  sourceFormat.channelCount = info_.channelCount > 0 ? info_.channelCount : info_.outputInfo.actualChannels;
  sourceFormat.bitDepth = info_.sourceBitDepth;
  sourceFormat.sampleFormat = sampleFormatFromText("", sourceFormat.bitDepth);

  AudioFormat decodedFormat;
  decodedFormat.sampleRate = info_.decodedSampleRate > 0 ? info_.decodedSampleRate : info_.outputSampleRate;
  decodedFormat.channelCount =
      info_.decodedChannels > 0 ? info_.decodedChannels : (info_.channelCount > 0 ? info_.channelCount : info_.outputInfo.actualChannels);
  decodedFormat.bitDepth = info_.decodedBitDepth > 0 ? info_.decodedBitDepth : info_.outputBitDepth;
  decodedFormat.sampleFormat = sampleFormatFromText(info_.decodedSampleFormat, decodedFormat.bitDepth);

  AudioFormat outputFormat;
  outputFormat.sampleRate = info_.outputInfo.outputSampleRate;
  outputFormat.channelCount = info_.outputInfo.actualChannels > 0 ? info_.outputInfo.actualChannels : info_.channelCount;
  outputFormat.bitDepth =
      info_.outputInfo.actualBitDepth > 0 ? info_.outputInfo.actualBitDepth : info_.outputInfo.outputBitDepth;
  outputFormat.sampleFormat = sampleFormatFromText(info_.outputInfo.actualOutputFormat, outputFormat.bitDepth);

  const bool backendResampled = info_.outputInfo.resampled;
  const std::string backendPerfectReason =
      (!info_.outputInfo.supportsOutputPerfect || backendResampled) ? info_.outputInfo.perfectReason : "";
  PerfectEvaluation evaluation;
  evaluation.sourceFormat = sourceFormat;
  evaluation.decodedFormat = decodedFormat;
  evaluation.outputFormat = outputFormat;
  evaluation.sourceLossless = codecLooksLossless(info_.codec);
  evaluation.sourceDsd = info_.isDsd || info_.codec == "dsd";
  if (evaluation.sourceDsd) {
    evaluation.dsdMode = parseDsdMode(info_.dsdMode);
    evaluation.dsdRate = info_.dsdRate;
  }
  evaluation.supportsOutputPerfect = info_.outputInfo.supportsOutputPerfect;
  evaluation.backendResampled = backendResampled;
  evaluation.backendPerfectReasonCode = info_.outputInfo.perfectReasonCode;
  evaluation.backendPerfectReason = backendPerfectReason;
  evaluation.volume = info_.volume;
  evaluation.playbackRate = info_.playbackRate;
  evaluation.replayGainActive = info_.replayGainActive;
  evaluation.loudnormActive = info_.loudnormActive;
  evaluation.eqActive = info_.eqActive;
  evaluation.convolverActive = info_.convolverActive;
  evaluation.crossfeedActive = info_.crossfeedActive;
  evaluation.crossfadeActive = info_.crossfadeActive || dspConfig_.crossfadeSeconds > 0.0001;
  evaluation.routingMode = outputConfig_.routingMode;
  evaluation.pcmPassthrough = pcmFormatsExactMatch(decodedFormat, outputFormat) && !backendResampled;
  const PerfectResult result = evaluatePerfect(evaluation);
  info_.dspActive = result.processingActive;
  info_.outputInfo.sourceExact = result.sourceExact;
  info_.outputInfo.resampled = result.resampled;
  info_.outputInfo.outputPerfect = result.outputPerfect;
  info_.outputInfo.pcmPassthrough = result.pcmPassthrough;
  info_.outputInfo.isDsd = evaluation.sourceDsd;
  info_.outputInfo.dsdMode = evaluation.sourceDsd ? dsdModeToString(evaluation.dsdMode) : dsdModeToString(DsdMode::Pcm);
  info_.outputInfo.dsdRate = evaluation.sourceDsd ? evaluation.dsdRate : 0;
  info_.outputInfo.perfectReason = result.perfectReason;
  info_.outputInfo.perfectReasonCode = result.perfectReasonCode;
  info_.perfectReasonCode = result.perfectReasonCode;
  info_.perfectReason = result.perfectReason;
  normalizeOutputInfoMirror(info_);
}

bool TwilightAudioEngine::shouldReroutePipelineLocked(
    std::string* reason,
    double* position,
    PlaybackState* state) const {
  if (!pipeline_ || info_.state == PlaybackState::Stopped) return false;
  const DspConfig& config = dspConfig_;
  if (info_.isDsd) {
    const bool wantsPcm = config.dsdOutputMode == DsdOutputMode::Pcm;
    const bool wantsNative = config.dsdOutputMode == DsdOutputMode::Auto ||
                             config.dsdOutputMode == DsdOutputMode::Native;
    const bool wantsDop = config.dsdOutputMode == DsdOutputMode::Auto || config.dsdOutputMode == DsdOutputMode::Dop ||
                          config.dsdOutputMode == DsdOutputMode::Native;
    const bool dopActive = pipeline_->isDopPathActive();
    const bool nativeActive = pipeline_->isNativeDsdPathActive();
    // Re-entering a DSD transport reopens the device. That only makes sense when
    // the current processing state would actually let the open path choose DSD;
    // the open path re-applies this very check, so restarting while it still
    // holds lands back in PCM. A DSD track parked in PCM fallback by the 70%
    // default software volume used to restart on every single volume tick.
    const bool processingForcesPcm = pipeline_->processingForcesDsdPcmFallback();
    if ((dopActive || nativeActive) && wantsPcm) {
      if (reason) {
        *reason = "DSD output mode forced PCM";
      }
      if (position) *position = info_.positionSeconds;
      if (state) *state = info_.state;
      return true;
    }
    if (nativeActive && config.dsdOutputMode == DsdOutputMode::Dop) {
      if (reason) *reason = "Re-enter DoP output mode";
      if (position) *position = info_.positionSeconds;
      if (state) *state = info_.state;
      return true;
    }
    if (!nativeActive && wantsNative && info_.dsdMode == "pcm" && !processingForcesPcm) {
      if (reason) *reason = "Re-enter Native DSD output mode";
      if (position) *position = info_.positionSeconds;
      if (state) *state = info_.state;
      return true;
    }
    if (!dopActive && !nativeActive && info_.dsdMode == "pcm" && wantsDop && !processingForcesPcm) {
      if (reason) *reason = "Re-enter DoP output mode";
      if (position) *position = info_.positionSeconds;
      if (state) *state = info_.state;
      return true;
    }
  }
  std::string fallbackReason;
  if (!pipeline_->needsPcmFallback(&fallbackReason)) return false;
  if (reason) *reason = std::move(fallbackReason);
  if (position) *position = info_.positionSeconds;
  if (state) *state = info_.state;
  return true;
}

TAE_Result TwilightAudioEngine::restartCurrentPlaybackForReroute(
    double positionSeconds,
    PlaybackState previousState,
    const std::string& reason,
    const std::string& context) {
  (void)context;
  std::string source;
  {
    std::lock_guard lock(mutex_);
    source = info_.source;
    if (pipeline_) pipeline_->setRerouteInProgress(true, reason);
  }
  if (source.empty()) return TAE_RESULT_OK;

  const TAE_Result result = play(source, std::max(0.0, positionSeconds));
  {
    std::lock_guard lock(mutex_);
    if (pipeline_) pipeline_->setRerouteInProgress(false);
  }
  if (result != TAE_RESULT_OK) return result;
  if (previousState == PlaybackState::Paused) {
    return pause();
  }
  return TAE_RESULT_OK;
}

QueueItem TwilightAudioEngine::currentItemLocked() const {
  return queue_.current().value_or(QueueItem{});
}

}  // namespace twilight::audio

using twilight::audio::TwilightAudioEngine;

namespace {

TwilightAudioEngine* fromHandle(TAE_EngineHandle handle) {
  return static_cast<TwilightAudioEngine*>(handle);
}

TAE_Result copyStringResult(const std::string& value, char* buffer, size_t bufferSize, size_t* requiredSize) {
  const size_t required = value.size() + 1;
  if (requiredSize) *requiredSize = required;
  if (!buffer || bufferSize == 0) return TAE_RESULT_OK;
  if (bufferSize < required) return TAE_RESULT_INVALID_ARGUMENT;
  std::memcpy(buffer, value.c_str(), required);
  return TAE_RESULT_OK;
}

struct AnalysisProbeResult {
  TAE_EngineHandle engine = nullptr;
  std::string source;
  std::string options;
  std::string value;
};

using AnalysisFunction = std::string (*)(const std::string&, const std::string&);

thread_local AnalysisProbeResult bpmProbeResult;
thread_local AnalysisProbeResult loudnessProbeResult;
std::atomic<uint64_t> bpmAnalysisExecutionCount{0};
std::atomic<uint64_t> loudnessAnalysisExecutionCount{0};

TAE_Result analyzeWithProbeResult(
    TAE_EngineHandle engine,
    const char* source,
    const char* optionsJson,
    char* buffer,
    size_t bufferSize,
    size_t* requiredSize,
    AnalysisProbeResult* probe,
    std::atomic<uint64_t>* executionCount,
    AnalysisFunction analyze) {
  if (!engine || !source || !probe || !executionCount || !analyze) return TAE_RESULT_INVALID_ARGUMENT;
  const std::string normalizedSource(source);
  const std::string normalizedOptions = optionsJson ? optionsJson : "{}";
  const bool sizeProbe = !buffer || bufferSize == 0;
  if (sizeProbe) {
    executionCount->fetch_add(1, std::memory_order_relaxed);
    probe->engine = engine;
    probe->source = normalizedSource;
    probe->options = normalizedOptions;
    probe->value = analyze(normalizedSource, normalizedOptions);
    return copyStringResult(probe->value, buffer, bufferSize, requiredSize);
  }

  if (probe->engine == engine && probe->source == normalizedSource && probe->options == normalizedOptions) {
    const TAE_Result result = copyStringResult(probe->value, buffer, bufferSize, requiredSize);
    if (result == TAE_RESULT_OK) *probe = AnalysisProbeResult{};
    return result;
  }

  executionCount->fetch_add(1, std::memory_order_relaxed);
  return copyStringResult(
      analyze(normalizedSource, normalizedOptions), buffer, bufferSize, requiredSize);
}

}  // namespace

extern "C" {

TAE_Result TAE_CreateEngine(TAE_EngineHandle* out_engine) {
  if (!out_engine) return TAE_RESULT_INVALID_ARGUMENT;
  try {
    *out_engine = new TwilightAudioEngine();
    return TAE_RESULT_OK;
  } catch (...) {
    *out_engine = nullptr;
    return TAE_RESULT_INTERNAL_ERROR;
  }
}

void TAE_DestroyEngine(TAE_EngineHandle engine) {
  if (bpmProbeResult.engine == engine) bpmProbeResult = AnalysisProbeResult{};
  if (loudnessProbeResult.engine == engine) loudnessProbeResult = AnalysisProbeResult{};
  delete fromHandle(engine);
}

TAE_Result TAE_SetEventCallback(TAE_EngineHandle engine, TAE_EventCallback callback, void* user_data) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  fromHandle(engine)->setEventCallback(callback, user_data);
  return TAE_RESULT_OK;
}

TAE_Result TAE_Play(TAE_EngineHandle engine, const char* source, double start_time_seconds) {
  if (!engine || !source) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->play(source, start_time_seconds);
}

TAE_Result TAE_Pause(TAE_EngineHandle engine) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->pause();
}

TAE_Result TAE_Stop(TAE_EngineHandle engine) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->stop();
}

TAE_Result TAE_Seek(TAE_EngineHandle engine, double position_seconds) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->seek(position_seconds);
}

TAE_Result TAE_SetVolume(TAE_EngineHandle engine, double volume) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setVolume(volume);
}

TAE_Result TAE_SetPlaybackRate(TAE_EngineHandle engine, double rate) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setPlaybackRate(rate);
}

TAE_Result TAE_SetLoopRange(TAE_EngineHandle engine, double start_seconds, double end_seconds) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setLoopRange(start_seconds, end_seconds);
}

TAE_Result TAE_SetOutputDevice(TAE_EngineHandle engine, const char* device_id) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setOutputDevice(device_id ? device_id : "auto");
}

TAE_Result TAE_SetOutputBackend(TAE_EngineHandle engine, const char* backend_id) {
  if (!engine || !backend_id) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->setOutputBackend(backend_id);
}

TAE_Result TAE_LoadQueue(TAE_EngineHandle engine, const char* queue_json, int start_index) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->loadQueue(queue_json ? queue_json : "[]", start_index);
}

TAE_Result TAE_AddToQueue(TAE_EngineHandle engine, const char* item_json) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->addToQueue(item_json ? item_json : "{}");
}

TAE_Result TAE_RemoveFromQueue(TAE_EngineHandle engine, int index) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->removeFromQueue(index);
}

TAE_Result TAE_Next(TAE_EngineHandle engine) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->next();
}

TAE_Result TAE_Previous(TAE_EngineHandle engine) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->previous();
}

TAE_Result TAE_SetPlayMode(TAE_EngineHandle engine, const char* mode) {
  if (!engine || !mode) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->setPlayMode(mode);
}

TAE_Result TAE_GetQueue(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyStringResult(fromHandle(engine)->getQueueJson(), buffer, buffer_size, required_size);
}

TAE_Result TAE_GetUpcomingTrack(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyStringResult(fromHandle(engine)->getUpcomingTrackJson(), buffer, buffer_size, required_size);
}

TAE_Result TAE_SetDspConfig(TAE_EngineHandle engine, const char* dsp_config_json) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setDspConfig(dsp_config_json ? dsp_config_json : "{}");
}

TAE_Result TAE_SetDspGraph(TAE_EngineHandle engine, const char* dsp_graph_json) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setDspGraph(dsp_graph_json ? dsp_graph_json : "{\"graph\":{\"nodes\":[]}}");
}

TAE_Result TAE_ApplyDspState(
    TAE_EngineHandle engine,
    uint64_t revision,
    const char* dsp_state_json) {
  if (!engine || !dsp_state_json || revision == 0) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->applyDspState(revision, dsp_state_json);
}

TAE_Result TAE_SetOutputConfig(TAE_EngineHandle engine, const char* output_config_json) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setOutputConfig(output_config_json ? output_config_json : "{}");
}

TAE_Result TAE_GetDspConfig(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyStringResult(fromHandle(engine)->getDspConfig(), buffer, buffer_size, required_size);
}

TAE_Result TAE_GetDspGraphStatus(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyStringResult(fromHandle(engine)->getDspGraphStatusJson(), buffer, buffer_size, required_size);
}

TAE_Result TAE_LoadImpulseResponse(TAE_EngineHandle engine, const char* path) {
  if (!engine || !path) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->loadImpulseResponse(path);
}

TAE_Result TAE_UnloadImpulseResponse(TAE_EngineHandle engine) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->unloadImpulseResponse();
}

TAE_Result TAE_GetConvolverInfo(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyStringResult(fromHandle(engine)->getConvolverInfoJson(), buffer, buffer_size, required_size);
}

TAE_Result TAE_SetEqBands(TAE_EngineHandle engine, const char* eq_json) {
  if (!engine || !eq_json) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->setEqBands(eq_json);
}

TAE_Result TAE_SetEqPreset(TAE_EngineHandle engine, const char* preset_json) {
  if (!engine || !preset_json) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->setEqPreset(preset_json);
}

TAE_Result TAE_SetCrossfeedStrength(TAE_EngineHandle engine, double strength) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setCrossfeedStrength(strength);
}

TAE_Result TAE_SetReplayGainMode(
    TAE_EngineHandle engine,
    const char* mode,
    double preamp_db,
    double fallback_db,
    int clip) {
  if (!engine || !mode) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->setReplayGainMode(mode, preamp_db, fallback_db, clip != 0);
}

TAE_Result TAE_SetDspPluginChain(TAE_EngineHandle engine, const char* chain_json) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setNativeDspPluginChain(chain_json ? chain_json : "{\"plugins\":[]}");
}

TAE_Result TAE_GetDspPluginStatus(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyStringResult(fromHandle(engine)->getNativeDspPluginStatusJson(), buffer, buffer_size, required_size);
}

TAE_Result TAE_GetMetadata(
    TAE_EngineHandle engine,
    const char* source,
    char* buffer,
    size_t buffer_size,
    size_t* required_size) {
  if (!engine || !source) return TAE_RESULT_INVALID_ARGUMENT;
  return copyStringResult(fromHandle(engine)->getMetadataJson(source), buffer, buffer_size, required_size);
}

TAE_Result TAE_EnumerateDevices(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyStringResult(fromHandle(engine)->enumerateDevicesJson(), buffer, buffer_size, required_size);
}

TAE_Result TAE_EnumerateBackends(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyStringResult(fromHandle(engine)->enumerateBackendsJson(), buffer, buffer_size, required_size);
}

TAE_Result TAE_GetEngineCapabilities(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyStringResult(fromHandle(engine)->engineCapabilitiesJson(), buffer, buffer_size, required_size);
}

TAE_Result TAE_GetLastError(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyStringResult(fromHandle(engine)->getLastErrorJson(), buffer, buffer_size, required_size);
}

TAE_Result TAE_GetPlaybackInfo(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyStringResult(fromHandle(engine)->getPlaybackInfoJson(), buffer, buffer_size, required_size);
}

TAE_Result TAE_GetDiagnosticLog(
    TAE_EngineHandle engine,
    uint64_t since_sequence,
    size_t max_entries,
    char* buffer,
    size_t buffer_size,
    size_t* required_size,
    uint64_t* next_sequence) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyStringResult(
      twilight::audio::DiagnosticLog::instance().toJson(since_sequence, max_entries, next_sequence),
      buffer,
      buffer_size,
      required_size);
}

TAE_Result TAE_GetSpectrumData(TAE_EngineHandle engine, float* buffer, size_t point_count, size_t* written_count) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  const size_t written = fromHandle(engine)->getSpectrumData(buffer, point_count);
  if (written_count) *written_count = written;
  return TAE_RESULT_OK;
}

TAE_Result TAE_GetVisualizationData(
    TAE_EngineHandle engine,
    const char* options_json,
    char* buffer,
    size_t buffer_size,
    size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyStringResult(
      fromHandle(engine)->getVisualizationDataJson(options_json ? options_json : "{}"),
      buffer,
      buffer_size,
      required_size);
}

TAE_Result TAE_AnalyzeBpm(
    TAE_EngineHandle engine,
    const char* source,
    const char* options_json,
    char* buffer,
    size_t buffer_size,
    size_t* required_size) {
  return analyzeWithProbeResult(
      engine,
      source,
      options_json,
      buffer,
      buffer_size,
      required_size,
      &bpmProbeResult,
      &bpmAnalysisExecutionCount,
      twilight::audio::analyzeBpmJson);
}

TAE_Result TAE_AnalyzeLoudness(
    TAE_EngineHandle engine,
    const char* source,
    const char* options_json,
    char* buffer,
    size_t buffer_size,
    size_t* required_size) {
  return analyzeWithProbeResult(
      engine,
      source,
      options_json,
      buffer,
      buffer_size,
      required_size,
      &loudnessProbeResult,
      &loudnessAnalysisExecutionCount,
      twilight::audio::analyzeLoudnessJson);
}

uint64_t TAE_GetAnalysisExecutionCount(const char* analysis_kind) {
  if (!analysis_kind) return 0;
  const std::string kind(analysis_kind);
  if (kind == "bpm") return bpmAnalysisExecutionCount.load(std::memory_order_relaxed);
  if (kind == "loudness") return loudnessAnalysisExecutionCount.load(std::memory_order_relaxed);
  return 0;
}

const char* TAE_GetVersion(void) {
  return "0.1.0";
}

}  // extern "C"
