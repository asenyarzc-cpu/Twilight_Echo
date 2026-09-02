#include "../core/TwilightAudioEngine.h"
#include "../core/AudioPipeline.h"
#include "../core/AudioPipelineRenderUtils.h"
#include "../core/FixedSpscQueue.h"
#include "../decoder/DsdReader.h"
#include "../decoder/FFmpegDecoder.h"
#include "../dsp/Vst3BridgeProcessor.h"
#include "../output/IOutputBackend.h"

#include <algorithm>
#include <atomic>
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <regex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef PSAPI_VERSION
#define PSAPI_VERSION 1
#endif
#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>
#endif

using namespace twilight::audio;

namespace {

constexpr int kDsd64Rate = 2822400;
constexpr int kDsd128Rate = 5644800;
constexpr int kDsd256Rate = 11289600;
constexpr int kDsd512Rate = 22579200;

#ifdef _WIN32
constexpr size_t kMaxDspGraphStressWorkingSetGrowthBytes = 96u * 1024u * 1024u;

size_t currentProcessWorkingSetBytes() {
  PROCESS_MEMORY_COUNTERS_EX counters{};
  counters.cb = sizeof(counters);
  assert(GetProcessMemoryInfo(
      GetCurrentProcess(),
      reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&counters),
      sizeof(counters)) != 0);
  return counters.WorkingSetSize;
}

size_t countProcessesNamed(const wchar_t* executableName) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  assert(snapshot != INVALID_HANDLE_VALUE);
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  size_t count = 0;
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (lstrcmpiW(entry.szExeFile, executableName) == 0) ++count;
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return count;
}

bool waitForProcessCountAtMost(const wchar_t* executableName, size_t maximum) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  do {
    if (countProcessesNamed(executableName) <= maximum) return true;
    Sleep(10);
  } while (std::chrono::steady_clock::now() < deadline);
  return countProcessesNamed(executableName) <= maximum;
}
#endif

void testFixedSpscQueuePreservesFifoAndReportsFull() {
  FixedSpscQueue<uint32_t, 3> queue;
  uint32_t value = 0;

  assert(queue.push(10));
  assert(queue.push(20));
  assert(queue.push(30));
  assert(!queue.push(40));
  assert(queue.pop(value) && value == 10);
  assert(queue.pop(value) && value == 20);
  assert(queue.push(40));
  assert(queue.pop(value) && value == 30);
  assert(queue.pop(value) && value == 40);
  assert(!queue.pop(value));
}

void testFloatScratchResizeForOverwritePreservesSameSizedScratch() {
  std::vector<float> scratch = {0.25f, -0.5f, 0.75f};
  const float* before = scratch.data();

  render::resizeFloatScratchForOverwrite(scratch, scratch.size());

  assert(scratch.data() == before);
  assert(scratch[0] == 0.25f);
  assert(scratch[1] == -0.5f);
  assert(scratch[2] == 0.75f);
}

void testVisualizationFftResolutionMatchesWebAudioReference() {
  assert(visualizationFftResolutionForConfig(0) == 8192);
  assert(visualizationFftResolutionForConfig(2048) == 8192);
  assert(visualizationFftResolutionForConfig(4096) == 8192);
  assert(visualizationFftResolutionForConfig(8192) == 8192);
}

std::string readTextFile(const std::filesystem::path& path) {
  std::ifstream in(path, std::ios::binary);
  std::ostringstream buffer;
  buffer << in.rdbuf();
  std::string text = buffer.str();
  text = std::regex_replace(text, std::regex("\r\n"), "\n");
  text = std::regex_replace(text, std::regex("\r"), "\n");
  return text;
}

std::string extractFunctionBody(const std::string& source, const std::string& signature) {
  const size_t signaturePos = source.find(signature);
  assert(signaturePos != std::string::npos);
  const size_t bodyStart = source.find('{', signaturePos);
  assert(bodyStart != std::string::npos);
  int depth = 0;
  for (size_t i = bodyStart; i < source.size(); ++i) {
    if (source[i] == '{') {
      ++depth;
    } else if (source[i] == '}') {
      --depth;
      if (depth == 0) return source.substr(bodyStart, i - bodyStart + 1);
    }
  }
  assert(false);
  return {};
}

void testRenderCallbacksDoNotResizePipelineScratchBuffers() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderBody = extractFunctionBody(source, "size_t AudioPipeline::render(float* output, size_t frameCount)");
  const std::string renderTypedBody = extractFunctionBody(source, "size_t AudioPipeline::renderTyped(PcmBlock& output)");
  const std::string realtimeBodies = renderBody + renderTypedBody;

  assert(!std::regex_search(realtimeBodies, std::regex(R"((routingScratch_|preloadRoutingScratch_|preloadMixScratch_|typedVisualizationScratch_)\.resize\s*\()")));
  assert(!std::regex_search(realtimeBodies, std::regex(R"(resizeFloatScratchForOverwrite\s*\((preloadMixScratch_|routingScratch_|preloadRoutingScratch_|typedVisualizationScratch_))")));
}

void testDecodeStreamReadFloatDoesNotResizeTypedScratch() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string readFloatBody = extractFunctionBody(source, "size_t readFloat(float* output, size_t frameCount)");

  assert(readFloatBody.find("floatReadScratch") != std::string::npos);
  assert(!std::regex_search(readFloatBody, std::regex(R"(floatReadScratch\.resize\s*\()")));
}

void testRenderCallbacksDoNotReconfigureDspChains() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderBody = extractFunctionBody(source, "size_t AudioPipeline::render(float* output, size_t frameCount)");
  const std::string renderTypedBody = extractFunctionBody(source, "size_t AudioPipeline::renderTyped(PcmBlock& output)");
  const std::string realtimeBodies = renderBody + renderTypedBody;

  assert(!std::regex_search(realtimeBodies, std::regex(R"(\.configure\s*\()")));
  assert(!std::regex_search(realtimeBodies, std::regex(R"(\.prepare\s*\()")));
  assert(!std::regex_search(realtimeBodies, std::regex(R"(\.setTrackContext\s*\()")));
}

void testRenderCallbackDoesNotCopyDspConfig() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderBody = extractFunctionBody(source, "size_t AudioPipeline::render(float* output, size_t frameCount)");

  assert(renderBody.find("DspConfig dspConfig") == std::string::npos);
  assert(renderBody.find("dspConfig = dspConfig_") == std::string::npos);
}

void testRenderCallbacksDoNotBlockOnPipelineMutex() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderBody = extractFunctionBody(source, "size_t AudioPipeline::render(float* output, size_t frameCount)");
  const std::string renderTypedBody = extractFunctionBody(source, "size_t AudioPipeline::renderTyped(PcmBlock& output)");
  const std::string realtimeBodies = renderBody + renderTypedBody;

  assert(!std::regex_search(realtimeBodies, std::regex(R"(std::lock_guard\s+lock\s*\(\s*mutex_\s*\))")));
  assert(realtimeBodies.find("mutex_") == std::string::npos);
  assert(realtimeBodies.find("std::try_to_lock") == std::string::npos);
}

void testRenderCallbacksDoNotWaitForDecoderBuffers() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderBody = extractFunctionBody(source, "size_t AudioPipeline::render(float* output, size_t frameCount)");
  const std::string renderTypedBody = extractFunctionBody(source, "size_t AudioPipeline::renderTyped(PcmBlock& output)");
  const std::string realtimeBodies = renderBody + renderTypedBody;

  assert(realtimeBodies.find("waitForRenderFrames") == std::string::npos);
  assert(realtimeBodies.find("waitForAvailableFrames") == std::string::npos);
}

void testNativeDsdRenderPositionAccountsForBitsPerByte() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderTypedBody = extractFunctionBody(source, "size_t AudioPipeline::renderTyped(PcmBlock& output)");

  assert(renderTypedBody.find("renderedFrames_ += read;") == std::string::npos);
  assert(renderTypedBody.find("dsdRenderedFrameUnits") != std::string::npos);
}

// A plain hi-rate 24-bit PCM stream is wire-identical to a DoP carrier, so
// `isDopCarrierFormat(output.format)` alone cannot authorize marker writes.
// Every marker/idle write in the typed render path must be gated on the
// pipeline's own DSD-transport flags: a 24/192 (or 176.4/352.8/384k) PCM track
// would otherwise lose its top byte to alternating 0x05/0xFA markers.
void testRenderTypedGatesDopMarkerWritesOnDsdTransport() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderTypedBody = extractFunctionBody(source, "size_t AudioPipeline::renderTyped(PcmBlock& output)");

  assert(renderTypedBody.find("dsdTransportActive = dopPathActive || nativeDsdPathActive || pcmToDsdPathActive") !=
         std::string::npos);
  // The stopped/idle and post-read finalize sites must be transport-gated, not
  // bare carrier-format checks.
  assert(renderTypedBody.find("if (isDopCarrierFormat(output.format)) {\n        if (dsdTransportActive) {") !=
         std::string::npos);
  assert(renderTypedBody.find("if (isDopCarrierFormat(output.format)) {\n    if (dsdTransportActive) {") !=
         std::string::npos);
  // The mismatch fallback stays transport-gated too.
  const size_t mismatchGate = renderTypedBody.find("typedPassthroughActive && dsdTransportActive &&");
  assert(mismatchGate != std::string::npos);
}

void testTypedDsdFormatMismatchEmitsTransportIdleInsteadOfPcmFallback() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderTypedBody =
      extractFunctionBody(source, "size_t AudioPipeline::renderTyped(PcmBlock& output)");
  const std::string mismatchBody = extractFunctionBody(
      renderTypedBody,
      "if (!typedPassthroughActive || !outputMatches || !bufferMatches)");

  assert(mismatchBody.find("fillDsdTransportIdle(output, &renderDopMarkerIndex_)") != std::string::npos);
  assert(mismatchBody.find("return output.frames") != std::string::npos);
  const size_t idlePos = mismatchBody.find("fillDsdTransportIdle");
  const size_t zeroPos = mismatchBody.find("std::memset");
  assert(idlePos != std::string::npos);
  assert(zeroPos == std::string::npos || idlePos < zeroPos);
}

void testChannelRouterStateIsOwnedByRenderCallback() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::filesystem::path headerPath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.h";
  const std::string source = readTextFile(sourcePath);
  const std::string header = readTextFile(headerPath);
  const std::string renderBody = extractFunctionBody(source, "size_t AudioPipeline::render(float* output, size_t frameCount)");
  const std::string setOutputConfigBody =
      extractFunctionBody(source, "bool AudioPipeline::setOutputConfig(const OutputConfig& config, std::string* error)");

  assert(header.find("channelRouterMutex_") == std::string::npos);
  assert(header.find("LatestRoutingCommandSlot") != std::string::npos);
  assert(setOutputConfigBody.find("enqueueControlCommand(routingCommand)") != std::string::npos);
  assert(source.find("channelRouter_.prepareForRealtime") != std::string::npos);
  assert(renderBody.find("mutex_") == std::string::npos);
  assert(renderBody.find("std::try_to_lock") == std::string::npos);
  assert(renderBody.find("channelRouter_.route") != std::string::npos);
}

void testRenderCallbacksUseNonBlockingSpectrumReset() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderBody = extractFunctionBody(source, "size_t AudioPipeline::render(float* output, size_t frameCount)");
  const std::string renderTypedBody = extractFunctionBody(source, "size_t AudioPipeline::renderTyped(PcmBlock& output)");
  const std::string realtimeBodies = renderBody + renderTypedBody;

  assert(realtimeBodies.find("spectrum_.resetCapture()") == std::string::npos);
}


void testSetDspConfigParsesJsonOutsidePipelineMutex() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string body = extractFunctionBody(source, "void AudioPipeline::setDspConfig(const std::string& dspConfigJson)");
  const size_t parsePos = body.find("const DspConfig nextConfig = DspChain::parseConfigJson(dspConfigJson);");
  const size_t lockPos = body.find("std::lock_guard lock(mutex_);");
  assert(parsePos != std::string::npos);
  assert(lockPos != std::string::npos);
  assert(parsePos < lockPos);
}

void testSetVolumeAvoidsBlockingOnPipelineMutex() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string body = extractFunctionBody(source, "void AudioPipeline::setVolume(double volume)");
  assert(body.find("enqueueControlCommand") != std::string::npos);
  assert(body.find("mutex_") == std::string::npos);
  assert(body.find("std::unique_lock") == std::string::npos);
  assert(body.find("std::lock_guard lock(mutex_)") == std::string::npos);
}

void testFallbackStatusPreservesStableTransportState() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string body = extractFunctionBody(source, "PipelineStatus AudioPipeline::fallbackStatus() const");
  assert(body.find("PipelineStatus status = lastStatus_;") != std::string::npos);
  assert(body.find("status.state = renderState_.load") == std::string::npos);
}

void testVolumeCommandApplicationIsRealtimeSafe() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string applyBody = extractFunctionBody(source, "void AudioPipeline::applyPendingControlCommands()");
  const std::string renderBody = extractFunctionBody(source, "size_t AudioPipeline::render(float* output, size_t frameCount)");
  const std::string renderTypedBody = extractFunctionBody(source, "size_t AudioPipeline::renderTyped(PcmBlock& output)");

  assert(applyBody.find("mutex_") == std::string::npos);
  assert(applyBody.find("std::lock") == std::string::npos);
  assert(applyBody.find("wait") == std::string::npos);
  assert(applyBody.find("new ") == std::string::npos);
  assert(applyBody.find("make_shared") == std::string::npos);
  assert(applyBody.find("make_unique") == std::string::npos);

  const size_t floatApply = renderBody.find("applyPendingControlCommands();");
  assert(floatApply != std::string::npos);
  assert(renderBody.find("mutex_") == std::string::npos);
  assert(renderBody.find("std::try_to_lock") == std::string::npos);

  const size_t typedApply = renderTypedBody.find("applyPendingControlCommands();");
  assert(typedApply != std::string::npos);
  assert(renderTypedBody.find("mutex_") == std::string::npos);
  assert(renderTypedBody.find("std::try_to_lock") == std::string::npos);
}

void testVolumeCommandCallbackWorkIsBoundedAndUsesPortableAtomics() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path corePath = testFilePath.parent_path().parent_path() / "core";
  const std::string source = readTextFile(corePath / "AudioPipeline.cpp");
  const std::string header = readTextFile(corePath / "AudioPipeline.h");
  const std::string queueHeader = readTextFile(corePath / "FixedSpscQueue.h");
  const std::string applyBody = extractFunctionBody(source, "void AudioPipeline::applyPendingControlCommands()");

  assert(applyBody.find("processed < kControlCommandCapacity") != std::string::npos);
  assert(applyBody.find("while (controlCommands_.pop(command))") == std::string::npos);
  assert(applyBody.find("latestOverflowCommand_.read(&command)") != std::string::npos);
  assert(header.find("std::atomic<double>") == std::string::npos);
  assert(header.find("std::atomic<uint64_t> requestedVolumeBits_") != std::string::npos);
  assert(header.find("std::atomic<uint64_t> appliedVolumeBits_") != std::string::npos);
  assert(header.find("std::atomic<uint64_t>::is_always_lock_free") != std::string::npos);
  assert(queueHeader.find("std::atomic<uint64_t>::is_always_lock_free") != std::string::npos);
}

void testDecodeStreamReaperRetiresOutsideAudioCallback() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  assert(source.find("struct AudioPipeline::DecodeStreamReaper") != std::string::npos);
  assert(source.find("decodeStreamReaper().retire") != std::string::npos);
  const std::string renderBody = extractFunctionBody(source, "size_t AudioPipeline::render(float* output, size_t frameCount)");
  assert(!std::regex_search(renderBody, std::regex(R"(->\s*stop\s*\()")));
  assert(renderBody.find("decodeThread.join") == std::string::npos);
}

void testRenderCallbackDoesNotStopDecodeStreams() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderBody = extractFunctionBody(source, "size_t AudioPipeline::render(float* output, size_t frameCount)");

  assert(!std::regex_search(renderBody, std::regex(R"(->\s*stop\s*\()")));
}

void testCrossfadePromotionClearsStaleLocalPreloadState() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderBody = extractFunctionBody(source, "size_t AudioPipeline::render(float* output, size_t frameCount)");
  const size_t promotion = renderBody.find("renderActiveStream_.store(active");
  assert(promotion != std::string::npos);
  const std::string promotionTail = renderBody.substr(promotion);

  assert(promotionTail.find("renderPreloadStream_.store(nullptr") != std::string::npos);
  assert(promotionTail.find("renderPromotionPending_.store(true") != std::string::npos);
  assert(promotionTail.find("crossfadeMixActive = false") != std::string::npos);
  assert(promotionTail.find("crossfadeFramesProcessed = 0") != std::string::npos);
  assert(promotionTail.find("crossfadeTotalFrames = 0") != std::string::npos);
}

void testRenderSideDecodeStreamRetirementDoesNotAllocateOrDestroy() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderBody = extractFunctionBody(source, "size_t AudioPipeline::render(float* output, size_t frameCount)");
  assert(renderBody.find("retireDecodeStreamLocked") == std::string::npos);
  assert(!std::regex_search(renderBody, std::regex(R"(\.(push_back|emplace_back|resize|reserve)\s*\()")));
}

void testSetDspConfigPreparesActiveChainForPreRoutingDecodeFormat() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string body = extractFunctionBody(source, "void AudioPipeline::setDspConfig(const std::string& dspConfigJson)");

  assert(body.find("activeDspChain.prepare(decodeFormat_)") != std::string::npos);
  assert(body.find("activeDspChain.prepare(outputFormat_)") == std::string::npos);
  assert(body.find("spareDspChain.prepare(decodeFormat_)") != std::string::npos);
  assert(body.find("spareDspChain.prepare(outputFormat_)") == std::string::npos);
}

void testDsdProcessingPcmDecisionUsesSharedHelper() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string helperBody = extractFunctionBody(source, "bool dspConfigProcessingRequiresPcm(");
  const std::string dopBody = extractFunctionBody(source, "bool AudioPipeline::shouldAttemptDopForCurrentConfig(");
  const std::string nativeBody = extractFunctionBody(source, "bool AudioPipeline::shouldAttemptNativeDsdForCurrentConfig(");
  const std::string reasonBody = extractFunctionBody(source, "std::string AudioPipeline::determineDsdPcmFallbackReason(");

  assert(helperBody.find("dspConfig.replayGainMode") != std::string::npos);
  assert(helperBody.find("dspConfig.eqEnabled") != std::string::npos);
  assert(helperBody.find("dspConfig.convolverEnabled") != std::string::npos);
  assert(helperBody.find("dspConfig.crossfeedEnabled") != std::string::npos);
  assert(helperBody.find("dspConfig.crossfadeSeconds") != std::string::npos);
  assert(helperBody.find("outputConfig.routingMode") != std::string::npos);
  assert(helperBody.find("std::abs(volume - 1.0)") != std::string::npos);

  assert(dopBody.find("dspConfigProcessingRequiresPcm") != std::string::npos);
  assert(nativeBody.find("dspConfigProcessingRequiresPcm") != std::string::npos);
  assert(reasonBody.find("dspConfigProcessingRequiresPcm") != std::string::npos);
  assert(dopBody.find("dspConfig.replayGainMode") == std::string::npos);
  assert(nativeBody.find("dspConfig.replayGainMode") == std::string::npos);
  assert(reasonBody.find("dspConfig.replayGainMode") == std::string::npos);
}

void testTwilightAudioEngineReusesParsedDspConfigSnapshot() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "core" / "TwilightAudioEngine.cpp";
  const std::filesystem::path headerPath =
      testFilePath.parent_path().parent_path() / "core" / "TwilightAudioEngine.h";
  const std::string source = readTextFile(sourcePath);
  const std::string header = readTextFile(headerPath);
  const std::string playBody =
      extractFunctionBody(source, "TAE_Result TwilightAudioEngine::play(const std::string& source, double startTimeSeconds)");
  const std::string playQueueBody =
      extractFunctionBody(source, "TAE_Result TwilightAudioEngine::playQueueItem(const QueueItem& item, double startTimeSeconds)");
  const std::string perfectBody = extractFunctionBody(source, "void TwilightAudioEngine::updatePerfectLocked()");
  const std::string rerouteBody = extractFunctionBody(source, "bool TwilightAudioEngine::shouldReroutePipelineLocked(");
  const std::string setDspBody = extractFunctionBody(source, "TAE_Result TwilightAudioEngine::setDspConfig(");

  assert(header.find("DspConfig dspConfig_") != std::string::npos);
  assert(source.find("bool gaplessEnabledFromConfig(const DspConfig& config)") != std::string::npos);
  assert(source.find("dspConfigRequiresProcessing") == std::string::npos);
  assert(setDspBody.find("dspConfig_ = nextConfig") != std::string::npos);
  assert(playBody.find("gaplessEnabledFromConfig(dspConfig_)") != std::string::npos);
  assert(playQueueBody.find("gaplessEnabledFromConfig(dspConfig_)") != std::string::npos);
  assert(perfectBody.find("DspChain::parseConfigJson(dspConfigJson_)") == std::string::npos);
  assert(rerouteBody.find("DspChain::parseConfigJson(dspConfigJson_)") == std::string::npos);
  assert(rerouteBody.find("const DspConfig& config = dspConfig_") != std::string::npos);
}

void writeLe16(std::ofstream& out, uint16_t value) {
  out.put(static_cast<char>(value & 0xff));
  out.put(static_cast<char>((value >> 8) & 0xff));
}

void writeLe32(std::ofstream& out, uint32_t value) {
  writeLe16(out, static_cast<uint16_t>(value & 0xffff));
  writeLe16(out, static_cast<uint16_t>((value >> 16) & 0xffff));
}

void writeLe64(std::ofstream& out, uint64_t value) {
  writeLe32(out, static_cast<uint32_t>(value & 0xffffffffULL));
  writeLe32(out, static_cast<uint32_t>((value >> 32) & 0xffffffffULL));
}

void writeLe32To(uint8_t* data, uint32_t value) {
  data[0] = static_cast<uint8_t>(value & 0xff);
  data[1] = static_cast<uint8_t>((value >> 8) & 0xff);
  data[2] = static_cast<uint8_t>((value >> 16) & 0xff);
  data[3] = static_cast<uint8_t>((value >> 24) & 0xff);
}

void writeBe32To(uint8_t* data, uint32_t value) {
  data[0] = static_cast<uint8_t>((value >> 24) & 0xff);
  data[1] = static_cast<uint8_t>((value >> 16) & 0xff);
  data[2] = static_cast<uint8_t>((value >> 8) & 0xff);
  data[3] = static_cast<uint8_t>(value & 0xff);
}

void writeDirectoryRecord(
    std::vector<uint8_t>& directory,
    size_t offset,
    uint32_t extent,
    uint32_t size,
    bool isDirectory,
    const std::string& name) {
  const size_t nameLength = name.size();
  const size_t recordLength = 33 + nameLength + ((nameLength % 2) == 0 ? 1 : 0);
  assert(offset + recordLength <= directory.size());
  directory[offset] = static_cast<uint8_t>(recordLength);
  writeLe32To(directory.data() + offset + 2, extent);
  writeBe32To(directory.data() + offset + 6, extent);
  writeLe32To(directory.data() + offset + 10, size);
  writeBe32To(directory.data() + offset + 14, size);
  directory[offset + 25] = isDirectory ? 0x02 : 0x00;
  directory[offset + 28] = 1;
  directory[offset + 31] = 1;
  directory[offset + 32] = static_cast<uint8_t>(nameLength);
  std::copy(name.begin(), name.end(), directory.begin() + static_cast<std::ptrdiff_t>(offset + 33));
}

void writeSpecialDirectoryRecord(
    std::vector<uint8_t>& directory,
    size_t offset,
    uint32_t extent,
    uint32_t size,
    uint8_t name) {
  directory[offset] = 34;
  writeLe32To(directory.data() + offset + 2, extent);
  writeBe32To(directory.data() + offset + 6, extent);
  writeLe32To(directory.data() + offset + 10, size);
  writeBe32To(directory.data() + offset + 14, size);
  directory[offset + 25] = 0x02;
  directory[offset + 28] = 1;
  directory[offset + 31] = 1;
  directory[offset + 32] = 1;
  directory[offset + 33] = name;
}

void writeTwilightTrack(
    std::vector<uint8_t>& toc,
    size_t offset,
    int trackNumber,
    uint32_t startSector,
    uint32_t sectorCount,
    uint32_t channelCount,
    uint32_t sampleRate,
    bool dst,
    const std::string& fileName) {
  std::memcpy(toc.data() + offset, "TWTE1", 5);
  writeLe32To(toc.data() + offset + 8, static_cast<uint32_t>(trackNumber));
  writeLe32To(toc.data() + offset + 12, startSector);
  writeLe32To(toc.data() + offset + 16, sectorCount);
  writeLe32To(toc.data() + offset + 20, channelCount);
  writeLe32To(toc.data() + offset + 24, sampleRate);
  writeLe32To(toc.data() + offset + 28, dst ? 1U : 0U);
  std::copy(fileName.begin(), fileName.end(), toc.begin() + static_cast<std::ptrdiff_t>(offset + 32));
}

std::filesystem::path writeSacdIsoFixture(const std::string& name) {
  const auto path = std::filesystem::temp_directory_path() / name;
  constexpr uint32_t kRootSector = 20;
  constexpr uint32_t kSacdSector = 21;
  constexpr uint32_t kSectorSize = 2048;
  std::vector<uint8_t> image(27 * kSectorSize, 0);
  uint8_t* pvd = image.data() + 16 * kSectorSize;
  pvd[0] = 1;
  std::memcpy(pvd + 1, "CD001", 5);
  pvd[6] = 1;
  writeLe32To(pvd + 156 + 2, kRootSector);
  writeBe32To(pvd + 156 + 6, kRootSector);
  writeLe32To(pvd + 156 + 10, kSectorSize);
  writeBe32To(pvd + 156 + 14, kSectorSize);
  pvd[156] = 34;
  pvd[156 + 25] = 0x02;
  pvd[156 + 28] = 1;
  pvd[156 + 31] = 1;
  pvd[156 + 32] = 1;
  uint8_t* terminator = image.data() + 17 * kSectorSize;
  terminator[0] = 255;
  std::memcpy(terminator + 1, "CD001", 5);
  terminator[6] = 1;

  std::vector<uint8_t> root(kSectorSize, 0);
  writeSpecialDirectoryRecord(root, 0, kRootSector, kSectorSize, 0);
  writeSpecialDirectoryRecord(root, 34, kRootSector, kSectorSize, 1);
  writeDirectoryRecord(root, 68, kSacdSector, kSectorSize, true, "SACD");
  std::copy(root.begin(), root.end(), image.begin() + kRootSector * kSectorSize);

  std::vector<uint8_t> sacd(kSectorSize, 0);
  writeSpecialDirectoryRecord(sacd, 0, kSacdSector, kSectorSize, 0);
  writeSpecialDirectoryRecord(sacd, 34, kRootSector, kSectorSize, 1);
  writeDirectoryRecord(sacd, 68, 22, 128, false, "MASTER.TOC");
  writeDirectoryRecord(sacd, 112, 23, 2048, false, "TWOCH_AREA.TOC");
  writeDirectoryRecord(sacd, 160, 25, 256, false, "TRACK01.DSD");
  std::copy(sacd.begin(), sacd.end(), image.begin() + kSacdSector * kSectorSize);

  std::vector<uint8_t> twoch(kSectorSize, 0);
  std::memcpy(twoch.data(), "TWTEAREA", 8);
  writeLe32To(twoch.data() + 8, 1);
  writeTwilightTrack(twoch, 16, 1, 25, 1, 2, kDsd64Rate, false, "TRACK01.DSD");
  std::copy(twoch.begin(), twoch.end(), image.begin() + 23 * kSectorSize);
  for (int i = 0; i < 256; ++i) image[25 * kSectorSize + i] = static_cast<uint8_t>(0x80 + (i & 0x3f));
  std::ofstream out(path, std::ios::binary);
  out.write(reinterpret_cast<const char*>(image.data()), static_cast<std::streamsize>(image.size()));
  return path;
}

std::filesystem::path writeDsfFixture(const std::string& name, int sampleRate = kDsd64Rate) {
  const auto path = std::filesystem::temp_directory_path() / name;
  constexpr uint32_t kChannels = 2;
  constexpr uint32_t kBlockSizePerChannel = 8;
  constexpr uint64_t kDataBytes = static_cast<uint64_t>(kChannels) * kBlockSizePerChannel;
  constexpr uint64_t kFileSize = 28 + 52 + 12 + kDataBytes;

  std::ofstream out(path, std::ios::binary);
  out.write("DSD ", 4);
  writeLe64(out, 28);
  writeLe64(out, kFileSize);
  writeLe64(out, 0);
  out.write("fmt ", 4);
  writeLe64(out, 52);
  writeLe32(out, 1);
  writeLe32(out, 0);
  writeLe32(out, 2);
  writeLe32(out, kChannels);
  writeLe32(out, static_cast<uint32_t>(sampleRate));
  writeLe32(out, 1);
  writeLe64(out, kBlockSizePerChannel * 8);
  writeLe32(out, kBlockSizePerChannel);
  writeLe32(out, 0);
  out.write("data", 4);
  writeLe64(out, 12 + kDataBytes);
  for (uint8_t byte : {0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88}) out.put(static_cast<char>(byte));
  for (uint8_t byte : {0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xf0, 0x0f}) out.put(static_cast<char>(byte));
  return path;
}

AudioFormat makePcmFormat(
    int sampleRate = 44100,
    int channels = 2,
    int bitDepth = 24,
    AudioSampleFormat sampleFormat = AudioSampleFormat::Int24Interleaved) {
  AudioFormat format;
  format.sampleRate = sampleRate;
  format.channelCount = channels;
  format.bitDepth = bitDepth;
  format.sampleFormat = sampleFormat;
  return format;
}

struct BackendSnapshot {
  int serial = 0;
  std::string backendId;
  AudioFormat requestedFormat;
  AudioFormat openedFormat;
  OutputInfo info;
  bool started = false;
  bool typedStarted = false;
  bool stopped = false;
  bool closed = false;
  int openCalls = 0;
  int setOutputConfigCalls = 0;
  int startCalls = 0;
  int stopCalls = 0;
  int closeCalls = 0;
  OutputConfig outputConfig;
  int typedRenderCalls = 0;
  int floatRenderCalls = 0;
};

struct BackendState {
  int serial = 0;
  std::string backendId;
  AudioFormat requestedFormat;
  AudioFormat openedFormat;
  OutputInfo info;
  RenderCallback render;
  TypedRenderCallback typedRender;
  OutputEventCallback event;
  bool started = false;
  bool typedStarted = false;
  bool stopped = false;
  bool closed = false;
  int openCalls = 0;
  int setOutputConfigCalls = 0;
  int startCalls = 0;
  int stopCalls = 0;
  int closeCalls = 0;
  OutputConfig outputConfig;
  int typedRenderCalls = 0;
  int floatRenderCalls = 0;
};

struct BackendRegistry {
  mutable std::mutex mutex;
  int nextSerial = 1;
  std::vector<std::shared_ptr<BackendState>> states;

  void reset() {
    std::lock_guard lock(mutex);
    nextSerial = 1;
    states.clear();
  }

  int registerState(const std::shared_ptr<BackendState>& state) {
    std::lock_guard lock(mutex);
    state->serial = nextSerial++;
    states.push_back(state);
    return state->serial;
  }

  std::vector<BackendSnapshot> snapshots() const {
    std::lock_guard lock(mutex);
    std::vector<BackendSnapshot> result;
    result.reserve(states.size());
    for (const auto& state : states) {
      BackendSnapshot snapshot;
      snapshot.serial = state->serial;
      snapshot.backendId = state->backendId;
      snapshot.requestedFormat = state->requestedFormat;
      snapshot.openedFormat = state->openedFormat;
      snapshot.info = state->info;
      snapshot.started = state->started;
      snapshot.typedStarted = state->typedStarted;
      snapshot.stopped = state->stopped;
      snapshot.closed = state->closed;
      snapshot.openCalls = state->openCalls;
      snapshot.setOutputConfigCalls = state->setOutputConfigCalls;
      snapshot.startCalls = state->startCalls;
      snapshot.stopCalls = state->stopCalls;
      snapshot.closeCalls = state->closeCalls;
      snapshot.outputConfig = state->outputConfig;
      snapshot.typedRenderCalls = state->typedRenderCalls;
      snapshot.floatRenderCalls = state->floatRenderCalls;
      result.push_back(snapshot);
    }
    return result;
  }

  std::shared_ptr<BackendState> latestStarted() const {
    std::lock_guard lock(mutex);
    for (auto it = states.rbegin(); it != states.rend(); ++it) {
      if ((*it)->started && !(*it)->closed) return *it;
    }
    return nullptr;
  }
};

BackendRegistry g_backendRegistry;

enum class FakeDopBehavior {
  Proven,
  CandidateUntilStart,
  CandidateAfterStart,
  Mismatch,
  Unproven
};

enum class FakeNativeDsdBehavior {
  Proven,
  CandidateAfterStart,
  AlsaTransportRate,
  Unsupported,
  Mismatch
};

FakeDopBehavior g_fakeDopBehavior = FakeDopBehavior::Proven;
FakeNativeDsdBehavior g_fakeNativeDsdBehavior = FakeNativeDsdBehavior::Proven;
std::atomic<int> g_fakeTopologyOpenFailures{0};
std::atomic<int> g_fakeTopologyStartFailures{0};
std::atomic<bool> g_fakeTopologyDeviceInvalidated{false};
std::atomic<int> g_maxNativeDsdSampleRate{0};
std::atomic<int> g_maxDopCarrierSampleRate{0};
// Simulates a compatibility-route device that is configured but not present
// (proxy driver uninstalled, or the device is busy). Any open() for this id fails.
constexpr const char* kMissingDsdProxyDeviceId = "missing-dsd-proxy";
std::atomic<int> g_decodeFirstReadDelayMs{0};
std::atomic<int> g_decodeEveryReadDelayMs{0};
std::mutex g_decoderSeekMutex;
std::vector<double> g_decoderSeekSeconds;

void resetDecoderSeekProbe() {
  std::lock_guard lock(g_decoderSeekMutex);
  g_decoderSeekSeconds.clear();
}

bool decoderSeekObserved(double expected, double tolerance = 0.000001) {
  std::lock_guard lock(g_decoderSeekMutex);
  return std::any_of(g_decoderSeekSeconds.begin(), g_decoderSeekSeconds.end(), [&](double value) {
    return std::abs(value - expected) <= tolerance;
  });
}

bool formatLooksDopCarrier(const AudioFormat& format) {
  return (format.sampleRate == 176400 || format.sampleRate == 192000 ||
          format.sampleRate == 352800 || format.sampleRate == 384000 ||
          format.sampleRate == 705600 || format.sampleRate == 768000 ||
          format.sampleRate == 1411200 || format.sampleRate == 1536000) &&
         format.channelCount == 2 &&
         format.bitDepth == 24 &&
         (format.sampleFormat == AudioSampleFormat::Int24Interleaved ||
          format.sampleFormat == AudioSampleFormat::Int24In32Interleaved);
}

bool formatLooksDsdSourceRequest(const AudioFormat& format) {
  return (format.sampleRate == kDsd64Rate || format.sampleRate == kDsd128Rate ||
          format.sampleRate == kDsd256Rate || format.sampleRate == kDsd512Rate) &&
         format.channelCount == 2 && format.bitDepth == 1 && isDsdSampleFormat(format.sampleFormat);
}

bool formatLooksPcmTrackRequest(const AudioFormat& format) {
  return format.sampleRate == 44100 && format.channelCount == 2 && format.bitDepth == 24;
}

bool formatLooksPcm192kTrackRequest(const AudioFormat& format) {
  return format.sampleRate == 192000 && format.channelCount == 2 && format.bitDepth == 24 &&
         format.sampleFormat == AudioSampleFormat::Int24Interleaved;
}

bool formatLooksDsdPcmFallbackRequest(const AudioFormat& format, int sampleRate = 176400) {
  return format.sampleRate == sampleRate && format.channelCount == 2 && format.bitDepth == 32 &&
         format.sampleFormat == AudioSampleFormat::Float32Interleaved;
}

void assertFormatLooksDsdPcmFallbackRequest(const AudioFormat& format, int sampleRate = 176400) {
  assert(formatLooksDsdPcmFallbackRequest(format, sampleRate));
}

bool jsonContains(const std::string& json, const std::string& needle) {
  return json.find(needle) != std::string::npos;
}

int32_t floatToSignedInt(double sample, int bits) {
  const double clamped = std::clamp(sample, -1.0, 1.0);
  if (bits == 16) {
    return static_cast<int32_t>(std::clamp(std::llround(clamped * 32768.0), -32768LL, 32767LL));
  }
  if (bits == 24) {
    return static_cast<int32_t>(std::clamp(std::llround(clamped * 8388608.0), -8388608LL, 8388607LL));
  }
  return static_cast<int32_t>(std::clamp(std::llround(clamped * 2147483648.0), -2147483648LL, 2147483647LL));
}

void writeSample(double sample, AudioSampleFormat format, uint8_t* output) {
  switch (format) {
    case AudioSampleFormat::Int16Interleaved: {
      const int16_t value = static_cast<int16_t>(floatToSignedInt(sample, 16));
      std::memcpy(output, &value, sizeof(value));
      break;
    }
    case AudioSampleFormat::Int24Interleaved: {
      const auto value = static_cast<uint32_t>(floatToSignedInt(sample, 24));
      output[0] = static_cast<uint8_t>(value & 0xff);
      output[1] = static_cast<uint8_t>((value >> 8) & 0xff);
      output[2] = static_cast<uint8_t>((value >> 16) & 0xff);
      break;
    }
    case AudioSampleFormat::Int24In32Interleaved: {
      const int32_t value = static_cast<int32_t>(static_cast<uint32_t>(floatToSignedInt(sample, 24)) << 8);
      std::memcpy(output, &value, sizeof(value));
      break;
    }
    case AudioSampleFormat::Int32Interleaved: {
      const int32_t value = floatToSignedInt(sample, 32);
      std::memcpy(output, &value, sizeof(value));
      break;
    }
    case AudioSampleFormat::Float32Interleaved:
    default: {
      const float value = static_cast<float>(sample);
      std::memcpy(output, &value, sizeof(value));
      break;
    }
  }
}

int32_t signed24FromBytes(uint8_t low, uint8_t mid, uint8_t high) {
  int32_t value = static_cast<int32_t>(low) | (static_cast<int32_t>(mid) << 8) |
                  (static_cast<int32_t>(high) << 16);
  if ((value & 0x800000) != 0) value |= ~0x00ffffff;
  return value;
}

float signedSampleToFloat(int32_t value, double scale) {
  return static_cast<float>(std::clamp(static_cast<double>(value) / scale, -1.0, 1.0));
}

void typedPcmToFloat(const PcmBlock& block, std::vector<float>* output) {
  if (!block.data || !output || block.frames == 0 || block.format.channelCount <= 0) return;
  const size_t channels = static_cast<size_t>(std::max(1, block.format.channelCount));
  const size_t samples = block.frames * channels;
  if (output->size() < samples) output->resize(samples, 0.0f);

  switch (block.format.sampleFormat) {
    case AudioSampleFormat::Int16Interleaved: {
      const auto* input = reinterpret_cast<const int16_t*>(block.data);
      for (size_t i = 0; i < samples; ++i) (*output)[i] = signedSampleToFloat(input[i], 32768.0);
      break;
    }
    case AudioSampleFormat::Int24Interleaved: {
      for (size_t i = 0; i < samples; ++i) {
        const size_t offset = i * 3;
        (*output)[i] =
            signedSampleToFloat(signed24FromBytes(block.data[offset], block.data[offset + 1], block.data[offset + 2]), 8388608.0);
      }
      break;
    }
    case AudioSampleFormat::Int24In32Interleaved: {
      const auto* input = reinterpret_cast<const int32_t*>(block.data);
      for (size_t i = 0; i < samples; ++i) (*output)[i] = signedSampleToFloat(input[i] >> 8, 8388608.0);
      break;
    }
    case AudioSampleFormat::Int32Interleaved: {
      const auto* input = reinterpret_cast<const int32_t*>(block.data);
      for (size_t i = 0; i < samples; ++i) (*output)[i] = signedSampleToFloat(input[i], 2147483648.0);
      break;
    }
    case AudioSampleFormat::Float32Interleaved:
    default: {
      const auto* input = reinterpret_cast<const float*>(block.data);
      std::copy(input, input + samples, output->begin());
      break;
    }
  }
}

bool waitUntil(const std::function<bool()>& predicate, int timeoutMs = 1500) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  while (std::chrono::steady_clock::now() < deadline) {
    if (predicate()) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return predicate();
}

bool waitForStartedBackendCount(size_t count, int timeoutMs = 1500) {
  return waitUntil(
      [count] {
        const auto snapshots = g_backendRegistry.snapshots();
        return snapshots.size() >= count && snapshots[count - 1].started && !snapshots[count - 1].closed;
      },
      timeoutMs);
}

std::shared_ptr<BackendState> waitForLatestStartedBackendState(int timeoutMs = 1500) {
  std::shared_ptr<BackendState> started;
  const bool ready = waitUntil(
      [&started] {
        started = g_backendRegistry.latestStarted();
        return static_cast<bool>(started);
      },
      timeoutMs);
  return ready ? started : nullptr;
}

std::vector<float> renderBackendFrames(const std::shared_ptr<BackendState>& state, size_t frames = 256) {
  assert(state);
  assert(state->openedFormat.channelCount > 0);
  const size_t channels = static_cast<size_t>(std::max(1, state->openedFormat.channelCount));
  std::vector<float> buffer(frames * channels, 0.0f);
  std::vector<uint8_t> typedBuffer(frames * audioFormatBytesPerFrame(state->openedFormat));

  RenderCallback render;
  TypedRenderCallback typedRender;
  {
    std::lock_guard lock(g_backendRegistry.mutex);
    render = state->render;
    typedRender = state->typedRender;
  }

  bool renderedTyped = false;
  if (typedRender && !typedBuffer.empty()) {
    PcmBlock block;
    block.format = state->openedFormat;
    block.data = typedBuffer.data();
    block.frames = frames;
    block.byteSize = typedBuffer.size();
    renderedTyped = typedRender(block) > 0;
    if (renderedTyped) {
      typedPcmToFloat(block, &buffer);
      std::lock_guard lock(g_backendRegistry.mutex);
      ++state->typedRenderCalls;
    }
  }
  if (!renderedTyped) {
    assert(render);
    render(buffer.data(), frames);
    std::lock_guard lock(g_backendRegistry.mutex);
    ++state->floatRenderCalls;
  }

  return buffer;
}

std::vector<uint8_t> renderBackendTypedBytes(
    const std::shared_ptr<BackendState>& state,
    size_t frames) {
  assert(state);
  const size_t bytesPerFrame = audioFormatBytesPerFrame(state->openedFormat);
  assert(bytesPerFrame > 0);
  std::vector<uint8_t> bytes(frames * bytesPerFrame, 0);
  TypedRenderCallback typedRender;
  {
    std::lock_guard lock(g_backendRegistry.mutex);
    typedRender = state->typedRender;
  }
  assert(typedRender);
  PcmBlock block;
  block.format = state->openedFormat;
  block.data = bytes.data();
  block.frames = frames;
  block.byteSize = bytes.size();
  assert(typedRender(block) > 0);
  return bytes;
}

void pumpBackend(const std::shared_ptr<BackendState>& state, size_t iterations, size_t frames = 256) {
  assert(state);
  for (size_t i = 0; i < iterations; ++i) {
    renderBackendFrames(state, frames);
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
}

class FakeOutputBackend final : public IOutputBackend {
 public:
  explicit FakeOutputBackend(std::string backendId)
      : state_(std::make_shared<BackendState>()) {
    state_->backendId = std::move(backendId);
    g_backendRegistry.registerState(state_);
  }

  const char* id() const override {
    return state_->backendId.c_str();
  }

  bool open(const std::string& deviceId, const AudioFormat& requestedFormat, std::string* error) override {
    std::lock_guard lock(g_backendRegistry.mutex);
    ++state_->openCalls;
    state_->started = false;
    state_->stopped = false;
    state_->closed = false;
    state_->requestedFormat = requestedFormat;
    if (state_->backendId == "wasapi-exclusive" && g_fakeTopologyOpenFailures.load() > 0) {
      g_fakeTopologyOpenFailures.fetch_sub(1);
      if (error) *error = "fake WASAPI topology open failure";
      return false;
    }
    if (deviceId == kMissingDsdProxyDeviceId) {
      state_->info.deviceName = deviceId;
      state_->info.actualDeviceName = deviceId;
      if (error) *error = "Fake DSD proxy device is not installed";
      return false;
    }
    AudioFormat opened = requestedFormat;
    if (formatLooksDopCarrier(requestedFormat) && g_maxDopCarrierSampleRate.load() > 0 &&
        requestedFormat.sampleRate > g_maxDopCarrierSampleRate.load()) {
      if (error) *error = "fake DoP rate unsupported";
      return false;
    }
    if (formatLooksDsdSourceRequest(requestedFormat) && g_maxNativeDsdSampleRate.load() > 0 &&
        requestedFormat.sampleRate > g_maxNativeDsdSampleRate.load()) {
      if (error) *error = "fake Native DSD rate unsupported";
      return false;
    }
    if (formatLooksDopCarrier(requestedFormat)) {
      opened = requestedFormat;
      if (g_fakeDopBehavior == FakeDopBehavior::Mismatch) {
        opened.sampleFormat = AudioSampleFormat::Int24In32Interleaved;
      }
    } else if (formatLooksDsdSourceRequest(requestedFormat)) {
      if (g_fakeNativeDsdBehavior == FakeNativeDsdBehavior::Proven ||
          g_fakeNativeDsdBehavior == FakeNativeDsdBehavior::CandidateAfterStart) {
        opened = requestedFormat;
      } else if (g_fakeNativeDsdBehavior == FakeNativeDsdBehavior::AlsaTransportRate) {
        opened = requestedFormat;
        opened.sampleRate = requestedFormat.sampleRate / 8;
      } else if (g_fakeNativeDsdBehavior == FakeNativeDsdBehavior::Mismatch) {
        opened = requestedFormat;
        opened.sampleFormat = AudioSampleFormat::Float32Interleaved;
        opened.bitDepth = 32;
      } else {
        opened = makePcmFormat(requestedFormat.sampleRate / 16, 2, 32, AudioSampleFormat::Float32Interleaved);
      }
    } else {
      opened = requestedFormat;
    }
    state_->openedFormat = opened;

    OutputInfo info;
    info.exclusive = state_->backendId == "wasapi-exclusive";
    info.supportsOutputPerfect =
        state_->backendId == "wasapi-exclusive" || state_->backendId == "asio" || state_->backendId == "alsa";
    info.backend = state_->backendId;
    info.actualBackend = state_->backendId;
    info.deviceName = deviceId.empty() ? "Test Device" : deviceId;
    info.actualDeviceName = info.deviceName;
    info.driverName = "Test Driver";
    info.actualDriverName = info.driverName;
    info.outputSampleRate = opened.sampleRate;
    info.outputBitDepth = opened.bitDepth;
    info.actualSampleRate = opened.sampleRate;
    info.actualBitDepth = opened.bitDepth;
    info.actualChannels = opened.channelCount;
    info.actualOutputFormat = sampleFormatToString(opened.sampleFormat);
    info.bufferSizeFrames = state_->outputConfig.preferredBufferSize == 0
                                ? 256
                                : static_cast<int>(state_->outputConfig.preferredBufferSize);
    info.latencyFrames = info.bufferSizeFrames;
    info.driverDopCapable = formatLooksDopCarrier(requestedFormat);
    info.driverDopCarrierSampleRates = {176400, 192000, 352800, 384000, 705600, 768000, 1411200, 1536000};
    info.driverDopCarrierFormats = {"int24", "int24-in32"};
    info.driverNativeDsdCapable = state_->backendId == "asio" || state_->backendId == "alsa";
    info.driverNativeDsdSampleRates = {kDsd64Rate, kDsd128Rate, kDsd256Rate, kDsd512Rate};
    info.channelRoutingMode = "auto";
    state_->info = info;
    return true;
  }

  bool setOutputConfig(const OutputConfig& config, std::string* error) override {
    (void)error;
    std::lock_guard lock(g_backendRegistry.mutex);
    ++state_->setOutputConfigCalls;
    state_->outputConfig = config;
    state_->info.channelRoutingMode = channelRoutingModeToString(config.routingMode);
    return true;
  }

  bool start(RenderCallback callback, OutputEventCallback eventCallback, std::string* error) override {
    std::lock_guard lock(g_backendRegistry.mutex);
    ++state_->startCalls;
    if (state_->backendId == "wasapi-exclusive" && g_fakeTopologyStartFailures.load() > 0) {
      g_fakeTopologyStartFailures.fetch_sub(1);
      if (error) *error = "fake WASAPI topology start failure";
      return false;
    }
    state_->render = std::move(callback);
    state_->typedRender = nullptr;
    state_->event = std::move(eventCallback);
    state_->started = true;
    state_->typedStarted = false;
    if (state_->backendId == "wasapi-exclusive" && g_fakeTopologyDeviceInvalidated.exchange(false)) {
      state_->event(OutputBackendEvent::DeviceInvalidated, "fake WASAPI device invalidated");
      if (error) *error = "fake WASAPI device invalidated";
      return false;
    }
    return true;
  }

  bool startTyped(
      TypedRenderCallback callback,
      RenderCallback fallbackCallback,
      OutputEventCallback eventCallback,
      std::string* error) override {
    std::lock_guard lock(g_backendRegistry.mutex);
    ++state_->startCalls;
    if (state_->backendId == "wasapi-exclusive" && g_fakeTopologyStartFailures.load() > 0) {
      g_fakeTopologyStartFailures.fetch_sub(1);
      if (error) *error = "fake WASAPI topology start failure";
      return false;
    }
    state_->typedRender = std::move(callback);
    state_->render = std::move(fallbackCallback);
    state_->event = std::move(eventCallback);
    state_->started = true;
    state_->typedStarted = true;
    if (state_->backendId == "wasapi-exclusive" && g_fakeTopologyDeviceInvalidated.exchange(false)) {
      state_->event(OutputBackendEvent::DeviceInvalidated, "fake WASAPI device invalidated");
      if (error) *error = "fake WASAPI device invalidated";
      return false;
    }
    return true;
  }

  void stop() override {
    std::lock_guard lock(g_backendRegistry.mutex);
    ++state_->stopCalls;
    state_->stopped = true;
  }

  void close() override {
    std::lock_guard lock(g_backendRegistry.mutex);
    ++state_->closeCalls;
    state_->closed = true;
  }

  AudioFormat outputFormat() const override {
    std::lock_guard lock(g_backendRegistry.mutex);
    return state_->openedFormat;
  }

  OutputInfo outputInfo() const override {
    std::lock_guard lock(g_backendRegistry.mutex);
    return state_->info;
  }

  DopRuntimeFacts dopRuntimeFacts() const override {
    std::lock_guard lock(g_backendRegistry.mutex);
    DopRuntimeFacts facts;
    if (!formatLooksDopCarrier(state_->requestedFormat)) return facts;

    facts.candidateFormat = state_->requestedFormat;
    facts.explicitlyCapable = true;
    if ((g_fakeDopBehavior == FakeDopBehavior::CandidateUntilStart && !state_->started) ||
        g_fakeDopBehavior == FakeDopBehavior::CandidateAfterStart) {
      facts.state = DopRuntimeFactState::Candidate;
      facts.reason = "DoP carrier candidate selected; waiting for runtime confirmation";
      return facts;
    }
    if (g_fakeDopBehavior == FakeDopBehavior::Unproven) {
      facts.actualFormat = state_->openedFormat;
      facts.state = DopRuntimeFactState::Unproven;
      facts.reason = "DoP backend could not prove passthrough";
      return facts;
    }
    if (!formatLooksDopCarrier(state_->openedFormat)) {
      facts.state = DopRuntimeFactState::Unproven;
      facts.reason = "DoP backend could not prove passthrough";
      return facts;
    }

    facts.actualFormat = state_->openedFormat;
    if (!pcmFormatsExactMatch(facts.candidateFormat, facts.actualFormat)) {
      facts.state = DopRuntimeFactState::Mismatch;
      facts.reason = "DoP carrier mismatch";
      return facts;
    }

    facts.state = DopRuntimeFactState::Proven;
    facts.reason = "Fake backend accepted an exact DoP carrier";
    return facts;
  }

  NativeDsdRuntimeFacts nativeDsdRuntimeFacts() const override {
    std::lock_guard lock(g_backendRegistry.mutex);
    NativeDsdRuntimeFacts facts;
    if (!formatLooksDsdSourceRequest(state_->requestedFormat)) {
      return unsupportedNativeDsdRuntimeFacts("No Native DSD stream was requested");
    }
    facts.requestedDsdRate = state_->requestedFormat.sampleRate;
    facts.channelCount = state_->requestedFormat.channelCount;
    facts.explicitlyCapable = state_->backendId == "asio" || state_->backendId == "alsa";
    facts.advertisedSampleRates = {kDsd64Rate, kDsd128Rate, kDsd256Rate, kDsd512Rate};
    if (!facts.explicitlyCapable || g_fakeNativeDsdBehavior == FakeNativeDsdBehavior::Unsupported) {
      facts.state = NativeDsdRuntimeFactState::Unsupported;
      facts.reason = "Fake ASIO backend does not advertise Native DSD support";
      return facts;
    }
    if (!isDsdSampleFormat(state_->openedFormat.sampleFormat)) {
      facts.state = NativeDsdRuntimeFactState::Mismatch;
      facts.actualDsdRate = state_->openedFormat.sampleRate >= kDsd64Rate ? state_->openedFormat.sampleRate : 0;
      facts.reason = "Fake ASIO runtime sample type is not Native DSD";
      return facts;
    }
    if (g_fakeNativeDsdBehavior == FakeNativeDsdBehavior::AlsaTransportRate) {
      facts.state = NativeDsdRuntimeFactState::Proven;
      facts.actualDsdRate = facts.requestedDsdRate;
      facts.reason = "Fake ALSA Native DSD stream started with a matching runtime bit-clock";
      return facts;
    }
    if (!dsdFormatsExactMatch(state_->requestedFormat, state_->openedFormat)) {
      facts.state = NativeDsdRuntimeFactState::Mismatch;
      facts.actualDsdRate = state_->openedFormat.sampleRate;
      facts.reason = "Fake ASIO actual Native DSD format does not exactly match the negotiated format";
      return facts;
    }
    if (g_fakeNativeDsdBehavior == FakeNativeDsdBehavior::CandidateAfterStart) {
      facts.state = NativeDsdRuntimeFactState::Candidate;
      facts.actualDsdRate = facts.requestedDsdRate;
      facts.reason = "Fake Native DSD stream is waiting for runtime lock confirmation";
      return facts;
    }
    facts.state = NativeDsdRuntimeFactState::Proven;
    facts.actualDsdRate = facts.requestedDsdRate;
    facts.reason = "Fake ASIO Native DSD stream started with a matching runtime rate";
    return facts;
  }

  std::string deviceName() const override {
    std::lock_guard lock(g_backendRegistry.mutex);
    return state_->info.deviceName;
  }

 private:
  std::shared_ptr<BackendState> state_;
};

struct TrackProfile {
  AudioStreamInfo stream;
  AudioFormat defaultOutput;
  size_t totalFrames = 8192;
  float sampleValue = 0.25f;
};

TrackProfile buildTrackProfile(const std::string& source) {
  TrackProfile profile;
  profile.stream.source = source;
  profile.stream.durationSeconds = 30.0;
  profile.stream.sourceLossless = true;
  if ((source.size() >= 4 && source.substr(source.size() - 4) == ".dsf") || source.find(".iso") != std::string::npos) {
    const bool isDsd512 = source.find("dsd512") != std::string::npos;
    const bool isDsd256 = source.find("dsd256") != std::string::npos;
    const bool isDsd128 = source.find("dsd128") != std::string::npos;
    const int dsdSampleRate = isDsd512 ? kDsd512Rate : (isDsd256 ? kDsd256Rate : (isDsd128 ? kDsd128Rate : kDsd64Rate));
    const int dsdRate = isDsd512 ? 512 : (isDsd256 ? 256 : (isDsd128 ? 128 : 64));
    profile.stream.codec = "dsd";
    profile.stream.sourceFormat.sampleRate = dsdSampleRate;
    profile.stream.sourceFormat.channelCount = 2;
    profile.stream.sourceFormat.bitDepth = 1;
    profile.stream.sourceFormat.sampleFormat = AudioSampleFormat::Float32Interleaved;
    profile.stream.decodedFormat = makePcmFormat(dsdSampleRate / 16, 2, 32, AudioSampleFormat::Float32Interleaved);
    profile.stream.isDsd = true;
    profile.stream.dsdMode = DsdMode::Pcm;
    profile.stream.dsdRate = dsdRate;
    profile.defaultOutput = profile.stream.decodedFormat;
    profile.sampleValue = 0.5f;
    return profile;
  }

  profile.stream.codec = "flac";
  profile.stream.sourceFormat =
      source.find("pcm-192k") != std::string::npos
          ? makePcmFormat(192000, 2, 24, AudioSampleFormat::Int24Interleaved)
          : makePcmFormat(44100, 2, 24, AudioSampleFormat::Int24Interleaved);
  profile.stream.decodedFormat = profile.stream.sourceFormat;
  profile.defaultOutput = profile.stream.decodedFormat;
  profile.totalFrames = 65536;
  profile.sampleValue = 0.25f;
  if (source.find("empty-track") != std::string::npos) {
    profile.totalFrames = 0;
    profile.stream.durationSeconds = 0.0;
  } else if (source.find("crossfade-current") != std::string::npos ||
             source.find("auto-promote-current") != std::string::npos) {
    profile.totalFrames = 4096;
    profile.sampleValue = 0.25f;
  } else if (source.find("crossfade-next") != std::string::npos ||
             source.find("auto-promote-next") != std::string::npos) {
    profile.totalFrames = 8192;
    profile.sampleValue = 0.75f;
  }
  return profile;
}

class EngineHarness {
 public:
  EngineHarness(
      std::string fixtureName = "twilight-phase6d-runtime-reroute-dsd64.dsf",
      int sampleRate = kDsd64Rate)
      : dsdPath_(writeDsfFixture(fixtureName, sampleRate)) {
    dsdPathString_ = dsdPath_.string();
    g_backendRegistry.reset();
    g_fakeDopBehavior = FakeDopBehavior::Proven;
    g_fakeNativeDsdBehavior = FakeNativeDsdBehavior::Proven;
    g_fakeTopologyOpenFailures = 0;
    g_fakeTopologyStartFailures = 0;
    g_fakeTopologyDeviceInvalidated = false;
    g_maxNativeDsdSampleRate = 0;
    g_maxDopCarrierSampleRate = 0;
    engine_.setOutputBackend("wasapi-exclusive");
  }

  ~EngineHarness() {
    engine_.stop();
    g_fakeDopBehavior = FakeDopBehavior::Proven;
    g_fakeNativeDsdBehavior = FakeNativeDsdBehavior::Proven;
    g_fakeTopologyOpenFailures = 0;
    g_fakeTopologyStartFailures = 0;
    g_fakeTopologyDeviceInvalidated = false;
    g_maxNativeDsdSampleRate = 0;
    g_maxDopCarrierSampleRate = 0;
    g_decodeFirstReadDelayMs = 0;
    g_decodeEveryReadDelayMs = 0;
    std::error_code ignored;
    std::filesystem::remove(dsdPath_, ignored);
  }

  TwilightAudioEngine& engine() { return engine_; }
  const std::string& dsdPath() const { return dsdPathString_; }

 private:
  TwilightAudioEngine engine_;
  std::filesystem::path dsdPath_;
  std::string dsdPathString_;
};

void assertLatestPlaybackContains(TwilightAudioEngine& engine, const std::string& needle) {
  const std::string json = engine.getPlaybackInfoJson();
  if (!jsonContains(json, needle)) {
    std::fprintf(stderr, "Missing playback JSON fragment: %s\nPlayback JSON: %s\n", needle.c_str(), json.c_str());
  }
  assert(jsonContains(json, needle));
}

double playbackJsonNumber(const std::string& json, const std::string& key) {
  const std::string marker = "\"" + key + "\":";
  const size_t start = json.find(marker);
  assert(start != std::string::npos);
  const size_t valueStart = start + marker.size();
  const size_t valueEnd = json.find_first_of(",}", valueStart);
  assert(valueEnd != std::string::npos);
  return std::stod(json.substr(valueStart, valueEnd - valueStart));
}

float dopCarrierFloat(uint8_t first, uint8_t second, uint8_t marker) {
  int32_t value = static_cast<int32_t>(first) |
                  (static_cast<int32_t>(second) << 8) |
                  (static_cast<int32_t>(marker) << 16);
  if ((value & 0x800000) != 0) value |= ~0x00ffffff;
  return static_cast<float>(static_cast<double>(value) / 8388608.0);
}

bool bufferHasSampleAbove(const std::vector<float>& samples, float threshold);

// A DSP configuration that keeps the Float32 path engaged without touching the
// signal level. The passthrough gate judges each module by what it would do, so
// an enabled-but-flat equalizer is transparent and would leave these tests on
// the typed passthrough path, where software volume is not applied at all. A
// ReplayGain stage with no tags and no offsets resolves to exactly 0 dB, so the
// amplitude assertions below still measure software volume alone.
constexpr const char* kUnityGainProcessingConfigJson =
    "{\"dspEnabled\":true,\"volumeNormalization\":\"track\","
    "\"replayGainPreamp\":0,\"replayGainFallback\":0}";

void testVolumeCommandAppliesAtRenderBoundary() {
  g_backendRegistry.reset();
  AudioPipeline pipeline;
  std::string error;
  assert(
      pipeline.play(
          "volume-boundary.flac",
          0.0,
          "wasapi-exclusive",
          "auto",
          1.0,
          kUnityGainProcessingConfigJson,
          &error) == TAE_RESULT_OK);
  const auto backend = waitForLatestStartedBackendState();
  assert(backend);

  const PipelineStatus before = pipeline.status();
  pipeline.setVolume(0.4);
  const PipelineStatus accepted = pipeline.status();
  assert(accepted.requestedConfigRevision > before.requestedConfigRevision);
  assert(accepted.appliedConfigRevision == before.appliedConfigRevision);
  assert(accepted.requestedConfigRevision > accepted.appliedConfigRevision);

  renderBackendFrames(backend, 128);
  const PipelineStatus applied = pipeline.status();
  assert(applied.appliedConfigRevision == accepted.requestedConfigRevision);
  pipeline.stop();
}

void testVolumeCommandStormCoalescesToNewestValue() {
  g_backendRegistry.reset();
  AudioPipeline pipeline;
  std::string error;
  assert(
      pipeline.play(
          "volume-command-storm.flac",
          0.0,
          "wasapi-exclusive",
          "auto",
          1.0,
          kUnityGainProcessingConfigJson,
          &error) == TAE_RESULT_OK);
  const auto backend = waitForLatestStartedBackendState();
  assert(backend);

  for (int i = 0; i < 128; ++i) {
    pipeline.setVolume(static_cast<double>(i) / 200.0);
  }
  pipeline.setVolume(0.37);
  const PipelineStatus accepted = pipeline.status();
  assert(accepted.requestedConfigRevision > accepted.appliedConfigRevision);

  std::vector<float> rendered;
  const bool renderedAudio = waitUntil([&] {
    rendered = renderBackendFrames(backend, 128);
    return bufferHasSampleAbove(rendered, 0.08f);
  });
  const PipelineStatus applied = pipeline.status();
  assert(applied.appliedConfigRevision == accepted.requestedConfigRevision);
  assert(renderedAudio);
  assert(!bufferHasSampleAbove(rendered, 0.10f));
  pipeline.stop();
}

void testDspGraphCommandAppliesAtRenderBoundary() {
  g_backendRegistry.reset();
  AudioPipeline pipeline;
  std::string error;
  assert(
      pipeline.play(
          "dsp-graph-boundary.flac",
          0.0,
          "wasapi-exclusive",
          "auto",
          1.0,
          "{\"dspEnabled\":true}",
          &error) == TAE_RESULT_OK);
  const auto backend = waitForLatestStartedBackendState();
  assert(backend);

  const PipelineStatus before = pipeline.status();
  pipeline.setDspConfig("{\"dspEnabled\":true,\"crossfeedEnabled\":true,\"crossfeedStrength\":0.6}");
  const PipelineStatus accepted = pipeline.status();
  assert(accepted.requestedConfigRevision > before.requestedConfigRevision);
  assert(accepted.requestedConfigRevision > accepted.appliedConfigRevision);

  renderBackendFrames(backend, 128);
  const PipelineStatus applied = pipeline.status();
  assert(applied.appliedConfigRevision == accepted.requestedConfigRevision);
  pipeline.stop();
}

void testDspGraphEpochRetirementStaysBoundedAcrossOneThousandUpdates() {
  g_backendRegistry.reset();
  AudioPipeline pipeline;
  std::string error;
  assert(
      pipeline.play(
          "dsp-graph-retirement.flac",
          0.0,
          "wasapi-exclusive",
          "auto",
          1.0,
          "{\"dspEnabled\":true,\"fftEnabled\":false}",
          &error) == TAE_RESULT_OK);
  const auto backend = waitForLatestStartedBackendState();
  assert(backend);

  const size_t vst3Before = Vst3BridgeProcessor::liveInstanceCountForTests();
#ifdef _WIN32
  // `twilight-vst3-host.exe` is a test-only controlled helper copied next to
  // this binary by CMake. It runs the production bridge protocol but does not
  // load a third-party module; real module coverage remains `smoke:vst3-msvc`.
  constexpr const wchar_t* kVst3HostExecutableName = L"twilight-vst3-host.exe";
  const size_t hostProcessBefore = countProcessesNamed(kVst3HostExecutableName);
  const size_t workingSetBefore = currentProcessWorkingSetBytes();
  size_t maxWorkingSet = workingSetBefore;
  size_t maxHostProcessCount = hostProcessBefore;
  bool observedFixtureHost = false;
#endif
  uint64_t previousEpoch = pipeline.appliedRenderDspEpochForTests();
  for (uint64_t revision = 1; revision <= 1000; ++revision) {
    const bool includeVst3 = revision % 100 == 0;
    const std::string nodes = includeVst3
                                  ? "[{\"id\":\"stress-vst3\",\"type\":\"vst3Plugin\",\"enabled\":true,"
                                    "\"params\":{\"vst3ModulePath\":\"Z:/missing/stress.vst3\","
                                    "\"vst3ClassId\":\"0123456789ABCDEF0123456789ABCDEF\"}}]"
                                  : "[{\"id\":\"balance\",\"type\":\"stereoField\",\"enabled\":true,"
                                    "\"params\":{\"balance\":0.25,\"width\":1.1}}]";
    const std::string state =
        "{\"revision\":" + std::to_string(revision) +
        ",\"processing\":{\"dspEnabled\":true,\"fftEnabled\":false,\"gapless\":true},"
        "\"sceneId\":\"retirement-stress\",\"graph\":{\"version\":2,\"nodes\":" + nodes + "}}";

    error.clear();
    assert(pipeline.applyDspState(revision, state, &error));
    assert(playbackJsonNumber(pipeline.dspGraphStatusJson(), "revision") <
           static_cast<double>(revision));

    renderBackendFrames(backend, 64);
    assert(playbackJsonNumber(pipeline.dspGraphStatusJson(), "revision") ==
           static_cast<double>(revision));
    assert(pipeline.appliedRenderDspEpochForTests() > previousEpoch);
    previousEpoch = pipeline.appliedRenderDspEpochForTests();
    assert(
        pipeline.renderDspGraphGenerationCountForTests() <=
        pipeline.maxRenderDspGraphGenerationCountForTests());
    assert(
        Vst3BridgeProcessor::liveInstanceCountForTests() <=
        vst3Before + pipeline.maxRenderDspGraphGenerationCountForTests() * 2 + 2);
#ifdef _WIN32
    const size_t hostProcessCount = countProcessesNamed(kVst3HostExecutableName);
    if (includeVst3) observedFixtureHost = observedFixtureHost || hostProcessCount > hostProcessBefore;
    assert(hostProcessCount <=
           hostProcessBefore + pipeline.maxRenderDspGraphGenerationCountForTests() + 1);
    maxHostProcessCount = std::max(maxHostProcessCount, hostProcessCount);
    maxWorkingSet = std::max(maxWorkingSet, currentProcessWorkingSetBytes());
#endif
  }

  error.clear();
  assert(pipeline.applyDspState(
      1001,
      "{\"revision\":1001,\"processing\":{\"dspEnabled\":true,\"fftEnabled\":false},"
      "\"sceneId\":\"retirement-stress\",\"graph\":{\"version\":2,\"nodes\":[]}}",
      &error));
  renderBackendFrames(backend, 64);
  (void)pipeline.dspGraphStatusJson();
  assert(Vst3BridgeProcessor::liveInstanceCountForTests() == vst3Before);
  pipeline.stop();
  assert(pipeline.renderDspGraphGenerationCountForTests() == 0);
#ifdef _WIN32
  assert(observedFixtureHost);
  assert(waitForProcessCountAtMost(kVst3HostExecutableName, hostProcessBefore));
  assert(maxWorkingSet <= workingSetBefore + kMaxDspGraphStressWorkingSetGrowthBytes);
  std::cout << "dsp-graph-stress workingSetBaselineBytes=" << workingSetBefore
            << " maxWorkingSetBytes=" << maxWorkingSet << " hostProcessesBaseline="
            << hostProcessBefore << " maxHostProcesses=" << maxHostProcessCount << '\n';
#endif
}

void testApplyDspStateGraphPreparationFailureIsTransactional() {
  TwilightAudioEngine engine;
  const std::string acceptedState =
      "{\"revision\":41,\"processing\":{\"dspEnabled\":true,\"fftEnabled\":false,"
      "\"crossfeedEnabled\":true,\"crossfeedStrength\":0.25},"
      "\"sceneId\":\"transaction-baseline\",\"graph\":{\"version\":2,\"nodes\":["
      "{\"id\":\"crossfeed\",\"type\":\"crossfeed\",\"enabled\":true,"
      "\"params\":{\"strength\":0.25}}]}}";
  assert(engine.applyDspState(41, acceptedState) == TAE_RESULT_OK);

  const std::string configBefore = engine.getDspConfig();
  const std::string graphBefore = engine.getDspGraphStatusJson();
  const std::string playbackBefore = engine.getPlaybackInfoJson();
  assert(playbackJsonNumber(graphBefore, "revision") == 41.0);
  assert(playbackJsonNumber(playbackBefore, "appliedConfigRevision") == 41.0);

  const std::string rejectedState =
      "{\"revision\":42,\"processing\":{\"dspEnabled\":true,\"fftEnabled\":false,"
      "\"crossfeedEnabled\":true,\"crossfeedStrength\":0.9},"
      "\"sceneId\":\"transaction-rejected\",\"graph\":{\"version\":2,\"nodes\":["
      "{\"id\":\"missing-ir\",\"type\":\"convolver\",\"enabled\":true,"
      "\"params\":{\"impulseResponsePath\":"
      "\"Z:/twilight-definitely-missing/transaction-failure.wav\"}}]}}";
  assert(engine.applyDspState(42, rejectedState) == TAE_RESULT_INVALID_ARGUMENT);
  assert(engine.getDspConfig() == configBefore);
  assert(engine.getDspGraphStatusJson() == graphBefore);
  const std::string playbackAfter = engine.getPlaybackInfoJson();
  assert(
      playbackJsonNumber(playbackAfter, "requestedConfigRevision") ==
      playbackJsonNumber(playbackBefore, "requestedConfigRevision"));
  assert(
      playbackJsonNumber(playbackAfter, "appliedConfigRevision") ==
      playbackJsonNumber(playbackBefore, "appliedConfigRevision"));
}

void testApplyDspStateCapacityFailureKeepsLastAcceptedState() {
  g_backendRegistry.reset();
  AudioPipeline pipeline;
  std::string error;
  assert(
      pipeline.play(
          "dsp-transaction-capacity.flac",
          0.0,
          "wasapi-exclusive",
          "auto",
          1.0,
          "{\"dspEnabled\":true,\"fftEnabled\":false}",
          &error) == TAE_RESULT_OK);
  const auto backend = waitForLatestStartedBackendState();
  assert(backend);

  uint64_t lastAcceptedRevision = 0;
  double lastAcceptedStrength = 0.0;
  while (
      pipeline.renderDspGraphGenerationCountForTests() <
      pipeline.maxRenderDspGraphGenerationCountForTests()) {
    ++lastAcceptedRevision;
    lastAcceptedStrength = static_cast<double>(lastAcceptedRevision) / 20.0;
    const std::string state =
        "{\"revision\":" + std::to_string(lastAcceptedRevision) +
        ",\"processing\":{\"dspEnabled\":true,\"fftEnabled\":false},"
        "\"sceneId\":\"capacity-baseline\",\"graph\":{\"version\":2,\"nodes\":["
        "{\"id\":\"crossfeed\",\"type\":\"crossfeed\",\"enabled\":true,"
        "\"params\":{\"strength\":" + std::to_string(lastAcceptedStrength) + "}}]}}";
    error.clear();
    assert(pipeline.applyDspState(lastAcceptedRevision, state, &error));
  }

  const PipelineStatus beforeFailure = pipeline.status();
  const std::string graphBeforeFailure = pipeline.dspGraphStatusJson();
  const uint64_t rejectedRevision = lastAcceptedRevision + 1;
  const std::string rejectedState =
      "{\"revision\":" + std::to_string(rejectedRevision) +
      ",\"processing\":{\"dspEnabled\":true,\"fftEnabled\":false},"
      "\"sceneId\":\"capacity-rejected\",\"graph\":{\"version\":2,\"nodes\":["
      "{\"id\":\"crossfeed\",\"type\":\"crossfeed\",\"enabled\":true,"
      "\"params\":{\"strength\":0.99}}]}}";
  error.clear();
  assert(!pipeline.applyDspState(rejectedRevision, rejectedState, &error));
  assert(error.find("waiting for render-thread ACK") != std::string::npos);

  const PipelineStatus afterFailure = pipeline.status();
  assert(afterFailure.requestedConfigRevision == beforeFailure.requestedConfigRevision);
  assert(afterFailure.appliedConfigRevision == beforeFailure.appliedConfigRevision);
  assert(std::abs(afterFailure.crossfeedStrength - lastAcceptedStrength) < 0.0001);
  assert(pipeline.dspGraphStatusJson() == graphBeforeFailure);

  renderBackendFrames(backend, 64);
  assert(
      playbackJsonNumber(pipeline.dspGraphStatusJson(), "revision") ==
      static_cast<double>(lastAcceptedRevision));
  assert(pipeline.status().appliedConfigRevision == lastAcceptedRevision);
  pipeline.stop();
}

void testStoppedVolumeAcceptanceIsVisibleBeforePlayback() {
  TwilightAudioEngine engine;
  const std::string beforeJson = engine.getPlaybackInfoJson();
  const double requestedBefore = playbackJsonNumber(beforeJson, "requestedConfigRevision");
  const double appliedBefore = playbackJsonNumber(beforeJson, "appliedConfigRevision");

  assert(engine.setVolume(0.42) == TAE_RESULT_OK);
  const std::string acceptedJson = engine.getPlaybackInfoJson();
  const double requestedAfter = playbackJsonNumber(acceptedJson, "requestedConfigRevision");
  const double appliedAfter = playbackJsonNumber(acceptedJson, "appliedConfigRevision");

  assert(requestedAfter > requestedBefore);
  assert(appliedAfter == appliedBefore);
  assert(requestedAfter > appliedAfter);
}

struct ConfigEventCapture {
  std::mutex mutex;
  std::vector<std::pair<std::string, std::string>> events;
};

void captureConfigEvent(const char* eventType, const char* payloadJson, void* userData) {
  auto* capture = static_cast<ConfigEventCapture*>(userData);
  if (!capture || !eventType) return;
  std::lock_guard lock(capture->mutex);
  capture->events.emplace_back(eventType, payloadJson ? payloadJson : "{}");
}

size_t capturedEventCount(ConfigEventCapture& capture, const std::string& eventType) {
  std::lock_guard lock(capture.mutex);
  return static_cast<size_t>(std::count_if(
      capture.events.begin(),
      capture.events.end(),
      [&eventType](const auto& event) { return event.first == eventType; }));
}

std::string capturedEventPayload(ConfigEventCapture& capture, const std::string& eventType) {
  std::lock_guard lock(capture.mutex);
  for (auto it = capture.events.rbegin(); it != capture.events.rend(); ++it) {
    if (it->first == eventType) return it->second;
  }
  return {};
}

void testConfigAppliedEventFollowsRenderApplication() {
  EngineHarness harness;
  auto& engine = harness.engine();
  ConfigEventCapture capture;
  engine.setEventCallback(captureConfigEvent, &capture);
  assert(engine.setDspConfig(kUnityGainProcessingConfigJson) == TAE_RESULT_OK);
  assert(engine.play("config-applied-event.flac", 0.0) == TAE_RESULT_OK);
  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  // The stopped setDspConfig above is already applied when playback starts,
  // so let the clock publish that independent baseline ACK before measuring
  // the render-boundary volume revision below.
  assert(waitUntil([&capture] { return capturedEventCount(capture, "config-applied") >= 1; }));
  const size_t baselineAppliedEvents = capturedEventCount(capture, "config-applied");

  assert(engine.setVolume(0.5) == TAE_RESULT_OK);
  const std::string acceptedJson = engine.getPlaybackInfoJson();
  const double requested = playbackJsonNumber(acceptedJson, "requestedConfigRevision");
  const double appliedBeforeRender = playbackJsonNumber(acceptedJson, "appliedConfigRevision");
  assert(requested > appliedBeforeRender);
  std::this_thread::sleep_for(std::chrono::milliseconds(150));
  assert(capturedEventCount(capture, "config-applied") == baselineAppliedEvents);

  renderBackendFrames(backend, 128);
  assert(waitUntil([&capture, baselineAppliedEvents] {
    return capturedEventCount(capture, "config-applied") == baselineAppliedEvents + 1;
  }));
  const std::string payload = capturedEventPayload(capture, "config-applied");
  assert(playbackJsonNumber(payload, "requestedConfigRevision") >= requested);
  assert(playbackJsonNumber(payload, "appliedConfigRevision") == requested);
  // capture is declared after the harness and is therefore destroyed first;
  // detach it before the engine's clock thread is stopped by harness teardown.
  engine.setEventCallback(nullptr, nullptr);
}

bool bufferHasSampleAbove(const std::vector<float>& samples, float threshold) {
  return std::any_of(samples.begin(), samples.end(), [threshold](float sample) { return sample > threshold; });
}

void testDsd64StartsOnDop() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(formatLooksDopCarrier(snapshots.front().requestedFormat));
  assertLatestPlaybackContains(engine, "\"isDsd\":true");
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"dop\"");
  assertLatestPlaybackContains(engine, "\"outputPerfect\":true");
}

void testPcmTypedPassthroughIsOutputPerfect() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.play("typed-passthrough.flac", 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  pumpBackend(backend, 2, 128);

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(formatLooksPcmTrackRequest(snapshots.front().requestedFormat));
  assert(snapshots.front().typedStarted);
  assert(snapshots.front().typedRenderCalls > 0);
  assert(snapshots.front().floatRenderCalls == 0);
  assertLatestPlaybackContains(engine, "\"isDsd\":false");
  assertLatestPlaybackContains(engine, "\"decodedBitDepth\":24");
  assertLatestPlaybackContains(engine, "\"decodedSampleFormat\":\"int24\"");
  assertLatestPlaybackContains(engine, "\"pcmPassthrough\":true");
  assertLatestPlaybackContains(engine, "\"outputPerfect\":true");
  assertLatestPlaybackContains(engine, "\"perfectReasonCode\":\"\"");
}

void testPcm192kTypedPassthroughIsOutputPerfect() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.play("pcm-192k-typed-passthrough.flac", 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  pumpBackend(backend, 2, 128);

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(formatLooksPcm192kTrackRequest(snapshots.front().requestedFormat));
  assert(formatLooksPcm192kTrackRequest(snapshots.front().openedFormat));
  assert(snapshots.front().typedStarted);
  assert(snapshots.front().typedRenderCalls > 0);
  assert(snapshots.front().floatRenderCalls == 0);
  assertLatestPlaybackContains(engine, "\"sourceSampleRate\":192000");
  assertLatestPlaybackContains(engine, "\"decodedSampleRate\":192000");
  assertLatestPlaybackContains(engine, "\"outputSampleRate\":192000");
  assertLatestPlaybackContains(engine, "\"decodedBitDepth\":24");
  assertLatestPlaybackContains(engine, "\"decodedChannels\":2");
  assertLatestPlaybackContains(engine, "\"decodedSampleFormat\":\"int24\"");
  assertLatestPlaybackContains(engine, "\"sourceExact\":true");
  assertLatestPlaybackContains(engine, "\"pcmPassthrough\":true");
  assertLatestPlaybackContains(engine, "\"outputPerfect\":true");
  assertLatestPlaybackContains(engine, "\"resampled\":false");
}

void testPcmExactFormatWithoutTypedRuntimeIsNotPassthrough() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.setOutputBackend("wasapi") == TAE_RESULT_OK);
  assert(engine.play("pcm-192k-shared-output.flac", 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  pumpBackend(backend, 2, 128);

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(formatLooksPcm192kTrackRequest(snapshots.front().requestedFormat));
  assert(formatLooksPcm192kTrackRequest(snapshots.front().openedFormat));
  assert(snapshots.front().typedStarted);
  assert(snapshots.front().typedRenderCalls == 0);
  assert(snapshots.front().floatRenderCalls > 0);
  assertLatestPlaybackContains(engine, "\"sourceSampleRate\":192000");
  assertLatestPlaybackContains(engine, "\"outputSampleRate\":192000");
  assertLatestPlaybackContains(engine, "\"pcmPassthrough\":false");
  assertLatestPlaybackContains(engine, "\"outputPerfect\":false");
}

void testPcmTypedPassthroughKeepsTypedPathDuringTransientDecoderLag() {
  EngineHarness harness;
  auto& engine = harness.engine();

  g_decodeEveryReadDelayMs = 50;
  assert(engine.play("typed-transient-decoder-lag.flac", 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  renderBackendFrames(backend, 2048);
  renderBackendFrames(backend, 2048);

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(snapshots.front().typedStarted);
  assert(snapshots.front().typedRenderCalls == 2);
  assert(snapshots.front().floatRenderCalls == 0);
}

void testOutputStartWaitsForFirstDecodedFrames() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.setVolume(0.5) == TAE_RESULT_OK);
  g_decodeFirstReadDelayMs = 150;
  std::atomic<int> result{TAE_RESULT_INTERNAL_ERROR};
  std::thread playThread([&] {
    result = engine.play("typed-preroll.flac", 0.0);
  });

  std::this_thread::sleep_for(std::chrono::milliseconds(40));
  const auto earlySnapshots = g_backendRegistry.snapshots();
  assert(earlySnapshots.size() == 1);
  assert(!earlySnapshots.front().started);

  playThread.join();
  assert(result == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  const auto rendered = renderBackendFrames(backend, 128);
  assert(bufferHasSampleAbove(rendered, 0.10f));
}

void testOutputStartDoesNotWaitForPrerollTimeoutAtEof() {
  EngineHarness harness;
  auto& engine = harness.engine();

  const auto start = std::chrono::steady_clock::now();
  assert(engine.play("empty-track.flac", 0.0) == TAE_RESULT_OK);
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - start);

  assert(elapsed < std::chrono::milliseconds(250));
  assert(waitForStartedBackendCount(1));
}

void testBackendRenderErrorIsReportedThroughLastError() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.play("backend-render-error.flac", 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  {
    std::lock_guard lock(g_backendRegistry.mutex);
    assert(static_cast<bool>(backend->event));
    backend->event(OutputBackendEvent::RenderError, "fake backend render failed");
  }

  assert(waitUntil([&] {
    const std::string errorJson = engine.getLastErrorJson();
    return jsonContains(errorJson, "\"hasError\":true") &&
           jsonContains(errorJson, "fake backend render failed") &&
           jsonContains(errorJson, "\"context\":\"render\"");
  }));
}

void testStoppedSetOutputDeviceKeepsOutputInfoDeviceNamesConsistent() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.setOutputDevice("device-a") == TAE_RESULT_OK);
  assert(engine.play("device-consistency.flac", 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));
  assertLatestPlaybackContains(engine, "\"outputDevice\":\"device-a\"");
  assertLatestPlaybackContains(engine, "\"deviceName\":\"device-a\"");
  assert(engine.stop() == TAE_RESULT_OK);

  assert(engine.setOutputDevice("device-b") == TAE_RESULT_OK);
  const std::string json = engine.getPlaybackInfoJson();
  assert(jsonContains(json, "\"outputDevice\":\"device-b\""));
  assert(jsonContains(json, "\"deviceName\":\"device-b\""));
  assert(jsonContains(json, "\"actualDeviceName\":\"device-b\""));
}

void testOutputRouteTransactionCommitsOnceAfterBackendDeviceConfig() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.setOutputDevice("device-a") == TAE_RESULT_OK);
  assert(engine.play("route-transaction.flac", 12.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  assert(engine.setOutputDevice("device-b") == TAE_RESULT_OK);
  assert(g_backendRegistry.snapshots().size() == 1);

  assert(engine.setOutputConfig("{}") == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(2));
  assert(waitUntil([] { return g_backendRegistry.snapshots().size() == 2; }));
  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots[0].closed);
  assert(snapshots[1].backendId == "asio");
  assert(snapshots[1].info.actualDeviceName == "device-b");
  assertLatestPlaybackContains(engine, "\"state\":\"playing\"");
  assertLatestPlaybackContains(engine, "\"outputBackend\":\"asio\"");
  assertLatestPlaybackContains(engine, "\"outputDevice\":\"device-b\"");
}

void testRenderWaitsForTransientDecoderLag() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.setVolume(0.5) == TAE_RESULT_OK);
  g_decodeEveryReadDelayMs = 3;
  assert(engine.play("transient-decoder-lag.flac", 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  const auto first = renderBackendFrames(backend, 2048);
  assert(bufferHasSampleAbove(first, 0.10f));
  bool recovered = false;
  for (int attempt = 0; attempt < 8 && !recovered; ++attempt) {
    const auto next = renderBackendFrames(backend, 2048);
    recovered = bufferHasSampleAbove(next, 0.10f);
    if (!recovered) std::this_thread::sleep_for(std::chrono::milliseconds(4));
  }
  assert(recovered);
}

void testRoutedRenderHandlesCallbacksLargerThanPreparedScratch() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.setOutputConfig("{\"routingMode\":\"stereo-to-5.1\"}") == TAE_RESULT_OK);
  assert(engine.play("large-routed-render.flac", 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  assert(backend->openedFormat.channelCount == 6);

  assert(waitUntil([&] {
    const auto rendered = renderBackendFrames(backend, 2048);
    return bufferHasSampleAbove(rendered, 0.10f);
  }));
  assertLatestPlaybackContains(engine, "\"channelRoutingMode\":\"stereo-to-5.1\"");
}

void testPcmVolumeFallsBackToFloatProcessing() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.setVolume(0.5) == TAE_RESULT_OK);
  assert(engine.play("typed-volume-fallback.flac", 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  pumpBackend(backend, 2, 128);

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(formatLooksPcmTrackRequest(snapshots.front().requestedFormat));
  assert(snapshots.front().typedStarted);
  assert(snapshots.front().typedRenderCalls == 0);
  assert(snapshots.front().floatRenderCalls > 0);
  assertLatestPlaybackContains(engine, "\"decodedBitDepth\":32");
  assertLatestPlaybackContains(engine, "\"decodedSampleFormat\":\"float32\"");
  assertLatestPlaybackContains(engine, "\"pcmPassthrough\":false");
  assertLatestPlaybackContains(engine, "\"outputPerfect\":false");
  assertLatestPlaybackContains(engine, "\"perfectReasonCode\":\"volume_not_unity\"");
}

void testDsd128StartsOnDop() {
  EngineHarness harness("twilight-phase6d-runtime-reroute-dsd128.dsf", kDsd128Rate);
  auto& engine = harness.engine();

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(formatLooksDopCarrier(snapshots.front().requestedFormat));
  assert(snapshots.front().requestedFormat.sampleRate == 352800);
  assertLatestPlaybackContains(engine, "\"isDsd\":true");
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"dop\"");
  assertLatestPlaybackContains(engine, "\"dsdRate\":128");
  assertLatestPlaybackContains(engine, "\"outputPerfect\":true");
}

void testAsioAutoPrefersNativeDsd() {
  EngineHarness harness;
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(formatLooksDsdSourceRequest(snapshots.front().requestedFormat));
  assert(snapshots.front().requestedFormat.sampleRate == kDsd64Rate);
  assert(snapshots.front().typedStarted);
  assertLatestPlaybackContains(engine, "\"isDsd\":true");
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"native\"");
  assertLatestPlaybackContains(engine, "\"nativeDsdRuntimeState\":\"proven\"");
  assertLatestPlaybackContains(engine, "\"sourceExact\":true");
  assertLatestPlaybackContains(engine, "\"outputPerfect\":true");
}

// ---- DSD compatibility route -----------------------------------------------
// The user's main output cannot carry Native DSD (harness default is
// wasapi-exclusive, which the fake backend reports as non-DSD-capable), so DSD
// would normally degrade to DoP. An override sends only the DSD stream to a
// separate ASIO backend/device, which is exactly the foo_dsd_asio proxy case.

void testDsdRouteOverrideCarriesNativeDsdOffMainBackend() {
  EngineHarness harness;
  auto& engine = harness.engine();
  // Main output stays on wasapi-exclusive; only DSD is rerouted to asio.
  assert(
      engine.setDspConfig(
          "{\"dsdRoute\":{\"enabled\":true,\"backend\":\"asio\",\"device\":\"dsd-proxy\"}}") ==
      TAE_RESULT_OK);

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  // The DSD request went out over the override backend and device, not the main one.
  assert(snapshots.front().backendId == "asio");
  assert(snapshots.front().info.deviceName == "dsd-proxy");
  assert(formatLooksDsdSourceRequest(snapshots.front().requestedFormat));
  assert(snapshots.front().typedStarted);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"native\"");
  assertLatestPlaybackContains(engine, "\"dsdRouteOverrideActive\":true");
  assertLatestPlaybackContains(engine, "\"dsdRouteBackend\":\"asio\"");
  assertLatestPlaybackContains(engine, "\"dsdRouteDevice\":\"dsd-proxy\"");
}

void testDsdRouteOverrideFallsBackToMainRouteWhenProxyMissing() {
  EngineHarness harness;
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  // Points at a device the fake backend always refuses to open.
  const std::string config = std::string("{\"dsdRoute\":{\"enabled\":true,\"device\":\"") +
                             kMissingDsdProxyDeviceId + "\"}}";
  assert(engine.setDspConfig(config) == TAE_RESULT_OK);

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(2));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 2);
  // First attempt targets the missing proxy and fails to open.
  assert(snapshots[0].info.deviceName == kMissingDsdProxyDeviceId);
  assert(!snapshots[0].started && !snapshots[0].typedStarted);
  // Non-strict mode retries the main route rather than degrading straight to DoP.
  assert(snapshots[1].info.deviceName != kMissingDsdProxyDeviceId);
  assert(formatLooksDsdSourceRequest(snapshots[1].requestedFormat));
  assert(snapshots[1].typedStarted);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"native\"");
  // The stream did NOT leave over the override, so status must not claim it did.
  assertLatestPlaybackContains(engine, "\"dsdRouteOverrideActive\":false");
}

void testDsdRouteStrictPassthroughFailsInsteadOfDegradingToPcm() {
  EngineHarness harness;
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  // Native DSD cannot be proven and DoP is unproven, so the only remaining
  // option would be a silent PCM downgrade -- which strict mode forbids.
  g_fakeNativeDsdBehavior = FakeNativeDsdBehavior::Mismatch;
  g_fakeDopBehavior = FakeDopBehavior::Unproven;
  assert(
      engine.setDspConfig(
          "{\"dsdRoute\":{\"enabled\":true,\"device\":\"dsd-proxy\",\"strictPassthrough\":true}}") ==
      TAE_RESULT_OK);

  // Playback fails outright instead of opening a PCM stream behind the user's back.
  assert(engine.play(harness.dsdPath(), 0.0) != TAE_RESULT_OK);

  const auto snapshots = g_backendRegistry.snapshots();
  // Whatever was attempted, nothing was ever started and no PCM fallback ran.
  for (const auto& snapshot : snapshots) {
    assert(!snapshot.started);
    assert(!snapshot.typedStarted);
    assert(!formatLooksPcmTrackRequest(snapshot.requestedFormat));
  }
}

void testDsdRouteOverrideIsNotUsedForPlainPcmSources() {
  EngineHarness harness("twilight-dsd-route-pcm-source.dsf", kDsd64Rate);
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  // Force PCM output mode: the source is DSD but the user asked for PCM, so the
  // compatibility route must not be involved at all.
  assert(
      engine.setDspConfig(
          "{\"dsdOutputMode\":\"pcm\",\"dsdRoute\":{\"enabled\":true,\"backend\":\"asio\","
          "\"device\":\"dsd-proxy\"}}") == TAE_RESULT_OK);

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assertFormatLooksDsdPcmFallbackRequest(snapshots.front().requestedFormat);
  // PCM never rides the proxy device.
  assert(snapshots.front().info.deviceName != "dsd-proxy");
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
  assertLatestPlaybackContains(engine, "\"dsdRouteOverrideActive\":false");
}

// ---- Auto-discovered DSD compatibility route --------------------------------
// The removed foo_dsd_asio path used to route DSD to a proxy automatically. Its
// replacement must do the same without matching on vendor names: discovery is
// driven purely by which drivers a capability probe proved can accept raw DSD.

/** Scoped DSD-capable device discovery override. */
struct ScopedNativeDsdDiscovery {
  explicit ScopedNativeDsdDiscovery(std::vector<std::string> deviceIds) {
    AudioPipeline::setNativeDsdDeviceDiscoveryForTests(
        [ids = std::move(deviceIds)]() { return ids; });
  }
  ~ScopedNativeDsdDiscovery() {
    AudioPipeline::setNativeDsdDeviceDiscoveryForTests(nullptr);
  }
};

void testDsdRouteAutoDiscoveryUsesProbeVerifiedProxy() {
  EngineHarness harness;
  auto& engine = harness.engine();
  // Main output is wasapi-exclusive, which cannot carry Native DSD. No dsdRoute
  // is configured at all -- discovery alone must find the capable driver.
  ScopedNativeDsdDiscovery discovery({"auto-proxy"});

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(snapshots.front().backendId == "asio");
  assert(snapshots.front().info.deviceName == "auto-proxy");
  assert(formatLooksDsdSourceRequest(snapshots.front().requestedFormat));
  assert(snapshots.front().typedStarted);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"native\"");
  assertLatestPlaybackContains(engine, "\"dsdRouteOverrideActive\":true");
  assertLatestPlaybackContains(engine, "\"dsdRouteDevice\":\"auto-proxy\"");
}

void testDsdRouteAutoDiscoveryIsInertWithoutCapableDevice() {
  EngineHarness harness;
  auto& engine = harness.engine();
  // Nothing on the system can take raw DSD, so behavior must be unchanged from
  // before auto-discovery existed: degrade over the main route.
  ScopedNativeDsdDiscovery discovery({});

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(!snapshots.empty());
  assert(snapshots.front().info.deviceName != "auto-proxy");
  assertLatestPlaybackContains(engine, "\"dsdRouteOverrideActive\":false");
}

void testExplicitDsdRouteWinsOverAutoDiscovery() {
  EngineHarness harness;
  auto& engine = harness.engine();
  // Discovery would pick auto-proxy, but the user pinned dsd-proxy. The explicit
  // choice must win: auto-discovery never overrides a deliberate setting.
  ScopedNativeDsdDiscovery discovery({"auto-proxy"});
  assert(
      engine.setDspConfig(
          "{\"dsdRoute\":{\"enabled\":true,\"backend\":\"asio\",\"device\":\"dsd-proxy\"}}") ==
      TAE_RESULT_OK);

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(snapshots.front().info.deviceName == "dsd-proxy");
  assertLatestPlaybackContains(engine, "\"dsdRouteDevice\":\"dsd-proxy\"");
}

void testDsdRouteAutoDiscoveryFallsBackToMainRouteWhenProxyRefuses() {
  EngineHarness harness;
  auto& engine = harness.engine();
  // Discovery points at a device the fake backend always refuses. An
  // auto-discovered route is a guess, so it must always retry the main route
  // rather than failing playback.
  ScopedNativeDsdDiscovery discovery({kMissingDsdProxyDeviceId});
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);

  const auto snapshots = g_backendRegistry.snapshots();
  assert(!snapshots.empty());
  bool anyStarted = false;
  for (const auto& snapshot : snapshots) {
    if (snapshot.started || snapshot.typedStarted) anyStarted = true;
  }
  assert(anyStarted);
}

void testAlsaNativeDsdAcceptsTransportFrameRate() {
  EngineHarness harness;
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("alsa") == TAE_RESULT_OK);
  g_fakeNativeDsdBehavior = FakeNativeDsdBehavior::AlsaTransportRate;

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(formatLooksDsdSourceRequest(snapshots.front().requestedFormat));
  assert(snapshots.front().openedFormat.sampleRate == kDsd64Rate / 8);
  assert(isDsdSampleFormat(snapshots.front().openedFormat.sampleFormat));
  assert(snapshots.front().typedStarted);
  assertLatestPlaybackContains(engine, "\"isDsd\":true");
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"native\"");
  assertLatestPlaybackContains(engine, "\"nativeDsdActualRate\":2822400");
  assertLatestPlaybackContains(engine, "\"nativeDsdRuntimeState\":\"proven\"");
  assertLatestPlaybackContains(engine, "\"outputPerfect\":true");
}

void testAsioDopModeDoesNotTryNativeDsd() {
  EngineHarness harness;
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  assert(engine.setDspConfig("{\"dsdOutputMode\":\"dop\"}") == TAE_RESULT_OK);

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(formatLooksDopCarrier(snapshots.front().requestedFormat));
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"dop\"");
}

void testAsioDopCandidateIsProvenAfterStart() {
  EngineHarness harness;
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  assert(engine.setDspConfig("{\"dsdOutputMode\":\"dop\"}") == TAE_RESULT_OK);
  g_fakeDopBehavior = FakeDopBehavior::CandidateUntilStart;

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(formatLooksDopCarrier(snapshots.front().requestedFormat));
  assert(snapshots.front().started);
  assert(snapshots.front().typedStarted);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"dop\"");
}

void testAsioDopCandidateAfterStartFallsBackToPcm() {
  EngineHarness harness;
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  assert(engine.setDspConfig("{\"dsdOutputMode\":\"dop\"}") == TAE_RESULT_OK);
  g_fakeDopBehavior = FakeDopBehavior::CandidateAfterStart;

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(2));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 2);
  assert(formatLooksDopCarrier(snapshots.front().requestedFormat));
  assert(snapshots.front().started);
  assert(snapshots.front().typedStarted);
  assert(snapshots.front().stopped);
  assertFormatLooksDsdPcmFallbackRequest(snapshots.back().requestedFormat);
  assert(snapshots.back().started);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
  assertLatestPlaybackContains(engine, "\"perfectReasonCode\":\"dop_passthrough_unproven\"");
}

void testNativeDsdMuteTimeoutStopsWithoutAdvancingPosition() {
  EngineHarness harness;
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  assert(engine.setOutputConfig(
             "{\"dsdMutePreRollFrames\":0,\"dsdMutePostRollFrames\":0,\"dsdMuteTimeoutFrames\":3}") ==
         TAE_RESULT_OK);
  g_fakeNativeDsdBehavior = FakeNativeDsdBehavior::CandidateAfterStart;

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  assert(backend->typedStarted);
  renderBackendTypedBytes(backend, 4);

  std::this_thread::sleep_for(std::chrono::milliseconds(150));
  assertLatestPlaybackContains(engine, "\"perfectReasonCode\":\"dsd_mute_lock_timeout\"");
  assertLatestPlaybackContains(engine, "\"outputPerfect\":false");
  assertLatestPlaybackContains(engine, "\"sourceExact\":false");
  assertLatestPlaybackContains(engine, "\"position\":0");

  const auto snapshots = g_backendRegistry.snapshots();
  assert(!snapshots.empty());
  assert(snapshots.back().stopCalls > 0);
  assert(snapshots.back().closeCalls > 0);
}

void assertDsdToPcmTransitionMutesFloat(DsdMode sourceMode, const char* expectedTransition) {
  EngineHarness harness;
  AudioPipeline pipeline;

  QueueItem dsd;
  dsd.id = sourceMode == DsdMode::Native ? "native-to-pcm" : "dop-to-pcm";
  dsd.source = harness.dsdPath();

  std::string error;
  const char* dsdConfig = sourceMode == DsdMode::Native
                              ? "{\"dsdOutputMode\":\"native\"}"
                              : "{\"dsdOutputMode\":\"dop\"}";
  assert(
      pipeline.play(dsd, std::nullopt, 0.0, "asio", "auto", 1.0, dsdConfig, true, &error) ==
      TAE_RESULT_OK);
  pipeline.stop();

  QueueItem pcm;
  pcm.id = "pcm-after-dsd";
  pcm.source = "pcm-after-dsd.flac";
  assert(
      pipeline.play(pcm, std::nullopt, 0.0, "asio", "auto", 0.5, "{}", true, &error) ==
      TAE_RESULT_OK);
  const auto backend = waitForLatestStartedBackendState();
  assert(backend);

  const PipelineStatus opened = pipeline.status();
  assert(opened.outputInfo.diagnostics.dsdMuteTransition == expectedTransition);
  const auto preRoll = renderBackendFrames(backend, 256);
  const auto postRoll = renderBackendFrames(backend, 256);
  assert(std::all_of(preRoll.begin(), preRoll.end(), [](float sample) { return sample == 0.0f; }));
  assert(std::all_of(postRoll.begin(), postRoll.end(), [](float sample) { return sample == 0.0f; }));
  assert(std::abs(pipeline.status().positionSeconds) < 0.0000001);

  const auto media = renderBackendFrames(backend, 1);
  assert(bufferHasSampleAbove(media, 0.01f));
  assert(pipeline.status().positionSeconds > 0.0);
  pipeline.stop();
}

void testDsdToPcmTransitionsMuteFloatWithoutAdvancingPosition() {
  assertDsdToPcmTransitionMutesFloat(DsdMode::Native, "native-to-pcm");
  assertDsdToPcmTransitionMutesFloat(DsdMode::Dop, "dop-to-pcm");
}

void testAsioPcmModeDoesNotTryNativeDsd() {
  EngineHarness harness;
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  assert(engine.setDspConfig("{\"dsdOutputMode\":\"pcm\"}") == TAE_RESULT_OK);

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assertFormatLooksDsdPcmFallbackRequest(snapshots.front().requestedFormat);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
  assertLatestPlaybackContains(engine, "\"perfectReason\":\"DSD output mode forced PCM\"");
}

void testAsioNativeDsdMismatchFallsBackToDop() {
  EngineHarness harness;
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  g_fakeNativeDsdBehavior = FakeNativeDsdBehavior::Mismatch;

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(2));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 2);
  assert(formatLooksDsdSourceRequest(snapshots.front().requestedFormat));
  assert(!snapshots.front().started);
  assert(!snapshots.front().typedStarted);
  assert(formatLooksDopCarrier(snapshots.back().requestedFormat));
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"dop\"");
  assertLatestPlaybackContains(engine, "\"nativeDsdRuntimeState\":\"mismatch\"");
  assertLatestPlaybackContains(engine, "\"nativeDsdRequestedRate\":2822400");
  assertLatestPlaybackContains(engine, "Fake ASIO runtime sample type is not Native DSD");
}

void testAsioNativeDsdAndDopFailureFallsBackToPcm() {
  EngineHarness harness;
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  g_fakeNativeDsdBehavior = FakeNativeDsdBehavior::Mismatch;
  g_fakeDopBehavior = FakeDopBehavior::Unproven;

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(3));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 3);
  assert(formatLooksDsdSourceRequest(snapshots[0].requestedFormat));
  assert(!snapshots[0].started);
  assert(!snapshots[0].typedStarted);
  assert(formatLooksDopCarrier(snapshots[1].requestedFormat));
  assert(!snapshots[1].started);
  assert(!snapshots[1].typedStarted);
  assertFormatLooksDsdPcmFallbackRequest(snapshots[2].requestedFormat);
  assert(snapshots[2].started);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
  assertLatestPlaybackContains(engine, "\"nativeDsdRuntimeState\":\"mismatch\"");
  assertLatestPlaybackContains(engine, "\"nativeDsdRequestedRate\":2822400");
  assertLatestPlaybackContains(engine, "Fake ASIO runtime sample type is not Native DSD");
  assertLatestPlaybackContains(engine, "\"perfectReasonCode\":\"dop_passthrough_unproven\"");
}

void testAsioNativeDsdUnsupportedAndDopFailureFallsBackToPcm() {
  EngineHarness harness;
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  g_fakeNativeDsdBehavior = FakeNativeDsdBehavior::Unsupported;
  g_fakeDopBehavior = FakeDopBehavior::Unproven;

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(3));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 3);
  assert(formatLooksDsdSourceRequest(snapshots[0].requestedFormat));
  assert(!snapshots[0].started);
  assert(!snapshots[0].typedStarted);
  assert(formatLooksDopCarrier(snapshots[1].requestedFormat));
  assert(!snapshots[1].started);
  assert(!snapshots[1].typedStarted);
  assertFormatLooksDsdPcmFallbackRequest(snapshots[2].requestedFormat);
  assert(snapshots[2].started);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
  assertLatestPlaybackContains(engine, "\"nativeDsdRuntimeState\":\"unsupported\"");
  assertLatestPlaybackContains(engine, "\"nativeDsdRequestedRate\":2822400");
  assertLatestPlaybackContains(engine, "Fake ASIO backend does not advertise Native DSD support");
  assertLatestPlaybackContains(engine, "\"perfectReasonCode\":\"dop_passthrough_unproven\"");
}

void testDsd256StartsOnWasapiExclusiveDop() {
  // After G2 (DoP DSD256/512 support), DSD256 on wasapi-exclusive now enters
  // DoP with a 705600 carrier instead of falling back to PCM. The fake
  // wasapi-exclusive backend proves DoP passthrough when the carrier is
  // accepted, so dsdMode resolves to "dop".
  EngineHarness harness("twilight-phase6d-runtime-reroute-dsd256.dsf", kDsd256Rate);
  auto& engine = harness.engine();

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(formatLooksDopCarrier(snapshots.front().requestedFormat));
  assert(snapshots.front().requestedFormat.sampleRate == 705600);
  assertLatestPlaybackContains(engine, "\"isDsd\":true");
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"dop\"");
  assertLatestPlaybackContains(engine, "\"dsdRate\":256");
}

void testDsd512StartsOnWasapiExclusiveDop() {
  EngineHarness harness("twilight-phase6d-runtime-reroute-dsd512-dop.dsf", kDsd512Rate);
  auto& engine = harness.engine();

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(formatLooksDopCarrier(snapshots.front().requestedFormat));
  assert(snapshots.front().requestedFormat.sampleRate == 1411200);
  assert(snapshots.front().requestedFormat.bitDepth == 24);
  assert(snapshots.front().requestedFormat.sampleFormat == AudioSampleFormat::Int24Interleaved);
  assertLatestPlaybackContains(engine, "\"isDsd\":true");
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"dop\"");
  assertLatestPlaybackContains(engine, "\"dsdRate\":512");
  assertLatestPlaybackContains(engine, "\"outputPerfect\":true");
}

void testDsd256StartsOnAsioNativeDsd() {
  EngineHarness harness("twilight-phase6d-runtime-reroute-dsd256.dsf", kDsd256Rate);
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(formatLooksDsdSourceRequest(snapshots.front().requestedFormat));
  assert(snapshots.front().requestedFormat.sampleRate == kDsd256Rate);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"native\"");
  assertLatestPlaybackContains(engine, "\"dsdRate\":256");
  assertLatestPlaybackContains(engine, "\"nativeDsdRuntimeState\":\"proven\"");
  assertLatestPlaybackContains(engine, "\"outputPerfect\":true");
}

void testNativeDsdPositionUsesBitSampleFrames() {
  EngineHarness harness("twilight-phase6d-runtime-reroute-dsd64-position.dsf", kDsd64Rate);
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));
  auto state = waitForLatestStartedBackendState();
  assert(state);
  assert(waitUntil([&] {
    renderBackendFrames(state, 8);
    return playbackJsonNumber(engine.getPlaybackInfoJson(), "position") > 0.0;
  }));

  const std::string json = engine.getPlaybackInfoJson();
  const double position = playbackJsonNumber(json, "position");
  const double expected = (8.0 * 8.0) / static_cast<double>(kDsd64Rate);
  if (std::abs(position - expected) > 0.000001) {
    std::fprintf(stderr, "Native DSD position mismatch: expected %.12f got %.12f\nPlayback JSON: %s\n", expected, position, json.c_str());
    std::abort();
  }
}

void testDsd512StartsOnAsioNativeDsd() {
  EngineHarness harness("twilight-phase6d-runtime-reroute-dsd512.dsf", kDsd512Rate);
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(formatLooksDsdSourceRequest(snapshots.front().requestedFormat));
  assert(snapshots.front().requestedFormat.sampleRate == kDsd512Rate);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"native\"");
  assertLatestPlaybackContains(engine, "\"dsdRate\":512");
  assertLatestPlaybackContains(engine, "\"nativeDsdRuntimeState\":\"proven\"");
  assertLatestPlaybackContains(engine, "\"outputPerfect\":true");
}

void testDsd512ForcedPcmUsesExplicitFallbackRate() {
  EngineHarness harness("twilight-phase6d-runtime-reroute-dsd512-pcm.dsf", kDsd512Rate);
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  assert(engine.setDspConfig("{\"dsdOutputMode\":\"pcm\"}") == TAE_RESULT_OK);

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assertFormatLooksDsdPcmFallbackRequest(snapshots.front().requestedFormat, 1411200);
  assert(snapshots.front().requestedFormat.sampleFormat == AudioSampleFormat::Float32Interleaved);
  assertLatestPlaybackContains(engine, "\"isDsd\":true");
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
  assertLatestPlaybackContains(engine, "\"dsdRate\":512");
  assertLatestPlaybackContains(engine, "\"outputPerfect\":false");
  assertLatestPlaybackContains(engine, "\"perfectReasonCode\":\"dsd_output_mode_pcm\"");
  assertLatestPlaybackContains(engine, "\"perfectReason\":\"DSD output mode forced PCM\"");
}

void testSacdIsoTrackUsesAsioNativeDsd() {
  EngineHarness harness;
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  const auto iso = writeSacdIsoFixture("twilight-sacd-runtime-native.iso");
  const std::string source = iso.string() + "?area=stereo&track=1";

  assert(engine.play(source, 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assert(formatLooksDsdSourceRequest(snapshots.front().requestedFormat));
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"native\"");
  assertLatestPlaybackContains(engine, "\"nativeDsdRuntimeState\":\"proven\"");
  assertLatestPlaybackContains(engine, "\"outputPerfect\":true");
  std::error_code ignored;
  std::filesystem::remove(iso, ignored);
}

void testSacdIsoTrackFallsBackToPcmWhenProcessingActive() {
  EngineHarness harness;
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  assert(engine.setVolume(0.5) == TAE_RESULT_OK);
  const auto iso = writeSacdIsoFixture("twilight-sacd-runtime-pcm.iso");
  const std::string source = iso.string() + "?area=stereo&track=1";

  assert(engine.play(source, 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assertFormatLooksDsdPcmFallbackRequest(snapshots.front().requestedFormat);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
  // Volume is a transport control, not the DSP chain, so it reports its own code.
  assertLatestPlaybackContains(engine, "\"perfectReasonCode\":\"dsd_volume_pcm_fallback\"");
  std::error_code ignored;
  std::filesystem::remove(iso, ignored);
}

void testDsdDownratePolicyNegotiatesRateFirstAndReportsActualRate() {
  EngineHarness harness("twilight-ap105-downrate-dsd256.dsf", kDsd256Rate);
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  assert(engine.setDspConfig("{\"dsdOutputMode\":\"auto\",\"dsdRatePolicy\":\"downrate\"}") ==
         TAE_RESULT_OK);
  g_maxNativeDsdSampleRate = kDsd128Rate;
  g_maxDopCarrierSampleRate = kDsd128Rate / 16;

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(3));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() >= 3);
  assert(snapshots[0].requestedFormat.sampleRate == kDsd256Rate);
  assert(formatLooksDsdSourceRequest(snapshots[0].requestedFormat));
  assert(snapshots[1].requestedFormat.sampleRate == kDsd256Rate / 16);
  assert(formatLooksDopCarrier(snapshots[1].requestedFormat));
  assert(snapshots[2].requestedFormat.sampleRate == kDsd128Rate);
  assert(formatLooksDsdSourceRequest(snapshots[2].requestedFormat));
  assertLatestPlaybackContains(engine, "\"dsdRate\":256");
  assertLatestPlaybackContains(engine, "\"actualDsdRate\":128");
  assertLatestPlaybackContains(engine, "\"dsdRatePolicy\":\"downrate\"");
  assertLatestPlaybackContains(engine, "\"dsdConversion\":\"downrate\"");
  assertLatestPlaybackContains(engine, "\"dsdConversionReason\":\"dsd_downrated\"");
  assertLatestPlaybackContains(engine, "\"sourceExact\":false");
  assertLatestPlaybackContains(engine, "\"resampled\":true");
  assertLatestPlaybackContains(engine, "\"perfectReasonCode\":\"dsd_downrated\"");
}

void testDsdDownratePolicyFallsBackToPcmAfterAllDsdRatesAreRejected() {
  EngineHarness harness("twilight-ap105-downrate-pcm-dsd256.dsf", kDsd256Rate);
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  assert(engine.setDspConfig("{\"dsdOutputMode\":\"auto\",\"dsdRatePolicy\":\"downrate\"}") ==
         TAE_RESULT_OK);
  g_maxNativeDsdSampleRate = kDsd64Rate - 1;
  g_maxDopCarrierSampleRate = (kDsd64Rate / 16) - 1;

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(7));
  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() >= 7);
  assertFormatLooksDsdPcmFallbackRequest(snapshots.back().requestedFormat, kDsd256Rate / 16);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
  assertLatestPlaybackContains(engine, "\"dsdRatePolicy\":\"downrate\"");
  assertLatestPlaybackContains(engine, "\"dsdConversion\":\"pcm-fallback\"");
  assertLatestPlaybackContains(engine, "\"dsdConversionReason\":\"dsd_converted_to_pcm\"");
}

void testDsdExactPolicyRejectsUnavailableSourceRateWithoutPcmFallback() {
  EngineHarness harness("twilight-ap105-exact-dsd256.dsf", kDsd256Rate);
  auto& engine = harness.engine();
  assert(engine.setOutputBackend("asio") == TAE_RESULT_OK);
  assert(engine.setDspConfig("{\"dsdOutputMode\":\"auto\",\"dsdRatePolicy\":\"exact\"}") ==
         TAE_RESULT_OK);
  g_maxNativeDsdSampleRate = kDsd128Rate;
  g_maxDopCarrierSampleRate = kDsd128Rate / 16;

  assert(engine.play(harness.dsdPath(), 0.0) != TAE_RESULT_OK);
  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 2);
  assert(formatLooksDsdSourceRequest(snapshots[0].requestedFormat));
  assert(formatLooksDopCarrier(snapshots[1].requestedFormat));
  assert(!snapshots[0].started);
  assert(!snapshots[1].started);
}

void testDopMismatchFallsBackWithStableCode() {
  EngineHarness harness;
  auto& engine = harness.engine();
  g_fakeDopBehavior = FakeDopBehavior::Mismatch;

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(2));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 2);
  assert(formatLooksDopCarrier(snapshots.front().requestedFormat));
  assert(!snapshots.front().started);
  assert(!snapshots.front().typedStarted);
  assertFormatLooksDsdPcmFallbackRequest(snapshots.back().requestedFormat);
  assert(snapshots.back().started);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
  assertLatestPlaybackContains(engine, "\"perfectReasonCode\":\"dop_carrier_mismatch\"");
}

void testDopUnprovenFallsBackWithStableCode() {
  EngineHarness harness;
  auto& engine = harness.engine();
  g_fakeDopBehavior = FakeDopBehavior::Unproven;

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(2));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 2);
  assert(formatLooksDopCarrier(snapshots.front().requestedFormat));
  assert(!snapshots.front().started);
  assert(!snapshots.front().typedStarted);
  assertFormatLooksDsdPcmFallbackRequest(snapshots.back().requestedFormat);
  assert(snapshots.back().started);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
  assertLatestPlaybackContains(engine, "\"perfectReasonCode\":\"dop_passthrough_unproven\"");
}

void testInitialNonUnityVolumeUsesPcmFallback() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.setVolume(0.5) == TAE_RESULT_OK);
  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  assertFormatLooksDsdPcmFallbackRequest(snapshots.front().requestedFormat);
  assertLatestPlaybackContains(engine, "\"volume\":0.5");
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
  // Non-unity volume is the one blocker a listener hits by default (70%), and
  // the DSP-chain advice does not apply to it: direct mode leaves volume alone.
  assertLatestPlaybackContains(engine, "\"perfectReasonCode\":\"dsd_volume_pcm_fallback\"");
}

/**
 * A DSD track parked in PCM fallback by non-unity volume must not reopen the
 * device on every volume tick.
 *
 * The reroute decision asked "we want Native DSD and we are on PCM, so restart"
 * without checking whether the restart could possibly reach DSD. The open path
 * re-applied the volume check and landed back in PCM, so each tick of the volume
 * slider cost a full device close/open and an audible gap, forever.
 */
void testNonUnityVolumeTicksDoNotRestartDsdPlayback() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.setVolume(0.5) == TAE_RESULT_OK);
  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");

  const size_t backendCountBefore = g_backendRegistry.snapshots().size();
  for (int step = 0; step < 6; ++step) {
    assert(engine.setVolume(0.30 + 0.05 * static_cast<double>(step)) == TAE_RESULT_OK);
  }

  // Still non-unity, so still PCM — but not one extra device open.
  assert(g_backendRegistry.snapshots().size() == backendCountBefore);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
  assertLatestPlaybackContains(engine, "\"perfectReasonCode\":\"dsd_volume_pcm_fallback\"");

  // Reaching unity clears the blocker, so re-negotiation must still happen.
  assert(engine.setVolume(1.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(backendCountBefore + 1));
  assertLatestPlaybackContains(engine, "\"volume\":1");
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"dop\"");
}

void testEqEnableRequestsPcmReroute() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const char* eqJson =
      "{\"dspEnabled\":true,\"eqEnabled\":true,\"eqMode\":\"parametric\","
      "\"eqBands\":[{\"frequency\":1000,\"gain\":3,\"q\":1,\"filterType\":\"peak\"}]}";
  assert(engine.setDspConfig(eqJson) == TAE_RESULT_OK);

  assert(waitForStartedBackendCount(2));
  const auto snapshots = g_backendRegistry.snapshots();
  assertFormatLooksDsdPcmFallbackRequest(snapshots.back().requestedFormat);
  assertLatestPlaybackContains(engine, "\"eqActive\":true");
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
  assertLatestPlaybackContains(engine, "\"perfectReason\":\"DSD processing active; falling back to PCM\"");
}

/**
 * A scene whose nodes are all disabled must not cost a DSD source its
 * passthrough.
 *
 * ApplyDspState carries two descriptions of the DSP: the graph that runs, and
 * the renderer's legacy module toggles. A scene with the equalizer node off
 * still ships `eqEnabled: true`, and the passthrough gate used to read the
 * toggle - so anyone who had ever switched the EQ on lost DSD passthrough
 * permanently while the graph processed nothing at all.
 */
void testDisabledGraphKeepsDsdPassthroughDespiteLegacyEqFlag() {
  EngineHarness harness;
  auto& engine = harness.engine();

  const char* flatSceneState =
      "{\"revision\":1,\"processing\":{\"dspEnabled\":true,\"eqEnabled\":true,\"eqMode\":\"graphic\","
      "\"eqPreamp\":0,\"gapless\":true},\"sceneId\":\"flat\",\"graph\":{\"version\":2,\"nodes\":["
      "{\"id\":\"equalizer\",\"type\":\"equalizer\",\"enabled\":false,"
      "\"params\":{\"mode\":\"graphic\",\"preampDb\":0,\"bands\":[]}},"
      "{\"id\":\"meter\",\"type\":\"meter\",\"enabled\":true,\"params\":{}}],"
      "\"outputStage\":{\"targetSampleRate\":\"device\",\"resamplerQuality\":\"native\","
      "\"dither\":\"off\",\"safetyClamp\":true}}}";
  assert(engine.applyDspState(1, flatSceneState) == TAE_RESULT_OK);

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"dop\"");
}

/**
 * The same scene with one node switched back on must still force PCM: the graph
 * is the authority in both directions.
 */
void testEnabledGraphNodeStillForcesDsdPcmFallback() {
  EngineHarness harness;
  auto& engine = harness.engine();

  const char* activeSceneState =
      "{\"revision\":1,\"processing\":{\"dspEnabled\":true,\"eqEnabled\":false,\"gapless\":true},"
      "\"sceneId\":\"active\",\"graph\":{\"version\":2,\"nodes\":["
      "{\"id\":\"equalizer\",\"type\":\"equalizer\",\"enabled\":true,"
      "\"params\":{\"mode\":\"parametric\",\"preampDb\":0,"
      "\"bands\":[{\"frequency\":1000,\"gain\":3,\"q\":1,\"filterType\":\"peak\"}]}}]}}";
  assert(engine.applyDspState(1, activeSceneState) == TAE_RESULT_OK);

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
}

/**
 * A scene generated from the module toggles enables the equalizer node as soon as
 * the toggle is on. An untouched 10-band EQ is still bit-transparent, so it must
 * not cost the source its passthrough either.
 */
void testEnabledButFlatGraphEqKeepsDsdPassthrough() {
  EngineHarness harness;
  auto& engine = harness.engine();

  const char* flatBandsState =
      "{\"revision\":1,\"processing\":{\"dspEnabled\":true,\"eqEnabled\":true,\"gapless\":true},"
      "\"sceneId\":\"flat-bands\",\"graph\":{\"version\":2,\"nodes\":["
      "{\"id\":\"equalizer\",\"type\":\"equalizer\",\"enabled\":true,"
      "\"params\":{\"mode\":\"graphic\",\"preampDb\":0,\"bands\":["
      "{\"frequency\":31,\"gain\":0,\"q\":1,\"filterType\":\"peak\",\"enabled\":true},"
      "{\"frequency\":1000,\"gain\":0,\"q\":1,\"filterType\":\"peak\",\"enabled\":true}]}}]}}";
  assert(engine.applyDspState(1, flatBandsState) == TAE_RESULT_OK);

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"dop\"");
}

/**
 * A flat equalizer is bit-transparent, so the legacy config-only path must not
 * report it as processing either.
 */
void testFlatLegacyEqKeepsDsdPassthrough() {
  EngineHarness harness;
  auto& engine = harness.engine();

  const char* flatEqJson =
      "{\"dspEnabled\":true,\"eqEnabled\":true,\"eqMode\":\"graphic\",\"eqPreamp\":0,"
      "\"eqBands\":[{\"frequency\":1000,\"gain\":0,\"q\":1,\"filterType\":\"peak\"},"
      "{\"frequency\":4000,\"gain\":0,\"q\":1,\"filterType\":\"peak\"}]}";
  assert(engine.setDspConfig(flatEqJson) == TAE_RESULT_OK);

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"dop\"");
}

void testVolumeChangeRequestsPcmReroute() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  assert(engine.setVolume(0.5) == TAE_RESULT_OK);

  assert(waitForStartedBackendCount(2));
  const auto snapshots = g_backendRegistry.snapshots();
  assertFormatLooksDsdPcmFallbackRequest(snapshots.back().requestedFormat);
  assertLatestPlaybackContains(engine, "\"volume\":0.5");
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
}

void testUnityVolumeReentersForcedDopFromPcm() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.setDspConfig("{\"dsdOutputMode\":\"dop\"}") == TAE_RESULT_OK);
  assert(engine.setVolume(0.5) == TAE_RESULT_OK);
  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));
  assertFormatLooksDsdPcmFallbackRequest(g_backendRegistry.snapshots().front().requestedFormat);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");

  assert(engine.setVolume(1.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(2));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(formatLooksDopCarrier(snapshots.back().requestedFormat));
  assert(snapshots.back().started);
  assert(snapshots.back().typedStarted);
  assertLatestPlaybackContains(engine, "\"volume\":1");
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"dop\"");
}

void testDsdOutputModePcmRequestsPcmReroute() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  assert(engine.setDspConfig("{\"dsdOutputMode\":\"pcm\"}") == TAE_RESULT_OK);

  assert(waitForStartedBackendCount(2));
  const auto snapshots = g_backendRegistry.snapshots();
  assertFormatLooksDsdPcmFallbackRequest(snapshots.back().requestedFormat);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
  assertLatestPlaybackContains(engine, "\"perfectReason\":\"DSD output mode forced PCM\"");
}

void testDsdOutputModeDopReentersDopPath() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.setDspConfig("{\"dsdOutputMode\":\"pcm\"}") == TAE_RESULT_OK);
  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));
  assertFormatLooksDsdPcmFallbackRequest(g_backendRegistry.snapshots().back().requestedFormat);
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");

  assert(engine.setDspConfig("{\"dsdOutputMode\":\"dop\"}") == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(2));
  const auto snapshots = g_backendRegistry.snapshots();
  assert(formatLooksDopCarrier(snapshots.back().requestedFormat));
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"dop\"");
}

void testSeekReevaluatesDsdPath() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  assert(engine.seek(5.0) == TAE_RESULT_OK);

  assert(waitForStartedBackendCount(2));
  const auto snapshots = g_backendRegistry.snapshots();
  assert(formatLooksDopCarrier(snapshots.back().requestedFormat));
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"dop\"");
}

void testPausedSettingsFallbackBeforeResume() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  assert(engine.pause() == TAE_RESULT_OK);
  assertLatestPlaybackContains(engine, "\"state\":\"paused\"");

  const char* eqJson =
      "{\"dspEnabled\":true,\"eqEnabled\":true,\"eqMode\":\"parametric\","
      "\"eqBands\":[{\"frequency\":1000,\"gain\":3,\"q\":1,\"filterType\":\"peak\"}]}";
  assert(engine.setDspConfig(eqJson) == TAE_RESULT_OK);

  assert(waitForStartedBackendCount(2));
  assertLatestPlaybackContains(engine, "\"state\":\"paused\"");
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");

  assert(engine.pause() == TAE_RESULT_OK);
  assertLatestPlaybackContains(engine, "\"state\":\"playing\"");
  assertLatestPlaybackContains(engine, "\"dsdMode\":\"pcm\"");
  assert(g_backendRegistry.snapshots().size() == 2);
}

void testWasapiExclusiveTopologyUpdateReopensAndResumesPlaying() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.play("wasapi-topology-playing.flac", 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  assert(engine.setOutputConfig("{\"preferredBufferSize\":512,\"wasapiExclusivePushMode\":true}") == TAE_RESULT_OK);

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  const auto& backend = snapshots.front();
  assert(backend.openCalls == 2);
  assert(backend.setOutputConfigCalls == 2);
  assert(backend.startCalls == 2);
  assert(backend.stopCalls >= 1);
  assert(backend.closeCalls >= 1);
  assert(backend.outputConfig.preferredBufferSize == 512);
  assert(backend.outputConfig.wasapiExclusivePushMode);
  assert(backend.info.bufferSizeFrames == 512);
  assertLatestPlaybackContains(engine, "\"state\":\"playing\"");
  assertLatestPlaybackContains(engine, "\"bufferSizeFrames\":512");
}

void testWasapiExclusiveTopologyStartFailureRollsBackAndPreservesPausedState() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.play("wasapi-topology-paused.flac", 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));
  assert(engine.pause() == TAE_RESULT_OK);
  g_fakeTopologyStartFailures = 1;

  assert(engine.setOutputConfig("{\"preferredBufferSize\":1024,\"wasapiExclusivePushMode\":true}") ==
         TAE_RESULT_INVALID_ARGUMENT);

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  const auto& backend = snapshots.front();
  assert(backend.openCalls == 3);
  assert(backend.startCalls == 3);
  assert(backend.outputConfig.preferredBufferSize == 0);
  assert(!backend.outputConfig.wasapiExclusivePushMode);
  assert(backend.info.bufferSizeFrames == 256);
  assertLatestPlaybackContains(engine, "\"state\":\"paused\"");
}

void testWasapiExclusiveTopologyDeviceInvalidationRollsBack() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.play("wasapi-topology-device-invalidated.flac", 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));
  g_fakeTopologyDeviceInvalidated = true;

  assert(engine.setOutputConfig("{\"preferredBufferSize\":128,\"wasapiExclusivePushMode\":true}") ==
         TAE_RESULT_INVALID_ARGUMENT);

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == 1);
  const auto& backend = snapshots.front();
  assert(backend.openCalls == 3);
  assert(backend.outputConfig.preferredBufferSize == 0);
  assert(!backend.outputConfig.wasapiExclusivePushMode);
  assertLatestPlaybackContains(engine, "\"state\":\"playing\"");
}

void testManualNextDoesNotInheritDsdPath() {
  EngineHarness harness;
  auto& engine = harness.engine();

  const std::string queueJson = "[{\"id\":\"dsd\",\"source\":\"" + harness.dsdPath() +
                                "\",\"duration\":30},{\"id\":\"pcm\",\"source\":\"next.flac\",\"duration\":30}]";
  assert(engine.loadQueue(queueJson, 0) == TAE_RESULT_OK);
  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  assert(engine.next() == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(2));
  const auto snapshots = g_backendRegistry.snapshots();
  assert(formatLooksPcmTrackRequest(snapshots.back().requestedFormat));
  assertLatestPlaybackContains(engine, "\"source\":\"next.flac\"");
  assertLatestPlaybackContains(engine, "\"isDsd\":false");
}

void testAutoNextDoesNotInheritDsdPath() {
  EngineHarness harness;
  auto& engine = harness.engine();

  const std::string queueJson = "[{\"id\":\"dsd\",\"source\":\"" + harness.dsdPath() +
                                "\",\"duration\":30},{\"id\":\"pcm\",\"source\":\"auto-next.flac\",\"duration\":30}]";
  assert(engine.loadQueue(queueJson, 0) == TAE_RESULT_OK);
  assert(engine.play(harness.dsdPath(), 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));
  const auto backend = waitForLatestStartedBackendState();
  assert(backend);

  pumpBackend(backend, 96);
  assert(waitUntil([&engine] {
    return jsonContains(engine.getPlaybackInfoJson(), "\"source\":\"auto-next.flac\"");
  }));

  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() >= 2);
  assert(formatLooksPcmTrackRequest(snapshots.back().requestedFormat));
  assertLatestPlaybackContains(engine, "\"isDsd\":false");
  assertLatestPlaybackContains(engine, "\"source\":\"auto-next.flac\"");
}

void testNativeCrossfadeOverlapMixesPreloadAndPromotes() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.setDspConfig("{\"gapless\":true,\"crossfadeSeconds\":0.04}") == TAE_RESULT_OK);
  const std::string queueJson =
      "[{\"id\":\"current\",\"source\":\"crossfade-current.flac\",\"duration\":0.08},"
      "{\"id\":\"next\",\"source\":\"crossfade-next.flac\",\"duration\":0.20}]";
  assert(engine.loadQueue(queueJson, 0) == TAE_RESULT_OK);
  assert(engine.play("crossfade-current.flac", 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));

  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  assertLatestPlaybackContains(engine, "\"crossfadeActive\":true");
  assert(waitUntil([&engine] { return jsonContains(engine.getPlaybackInfoJson(), "\"preloadReady\":true"); }));
  assertLatestPlaybackContains(engine, "\"outputPerfect\":false");
  assertLatestPlaybackContains(engine, "\"perfectReasonCode\":\"crossfade_active\"");

  bool sawOverlapMix = false;
  for (int i = 0; i < 24; ++i) {
    const auto rendered = renderBackendFrames(backend, 256);
    if (bufferHasSampleAbove(rendered, 0.30f)) {
      sawOverlapMix = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  assert(sawOverlapMix);

  const auto afterMixSnapshots = g_backendRegistry.snapshots();
  assert(afterMixSnapshots.size() == 1);
  assert(afterMixSnapshots.front().typedStarted);
  assert(afterMixSnapshots.front().typedRenderCalls == 0);
  assert(afterMixSnapshots.front().floatRenderCalls > 0);

  bool promoted = false;
  for (int i = 0; i < 80; ++i) {
    renderBackendFrames(backend, 256);
    if (jsonContains(engine.getPlaybackInfoJson(), "\"source\":\"crossfade-next.flac\",\"codec\"")) {
      promoted = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  assert(promoted);
  assertLatestPlaybackContains(engine, "\"source\":\"crossfade-next.flac\",\"codec\"");
  assertLatestPlaybackContains(engine, "\"queueIndex\":1");
}

void testPreloadedPromotionKeepsRuntimeReplayGainSettings() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.setVolume(0.5) == TAE_RESULT_OK);
  assert(engine.setDspConfig("{\"enabled\":true,\"gapless\":true}") == TAE_RESULT_OK);
  const std::string queueJson =
      "[{\"id\":\"current\",\"source\":\"runtime-replaygain-current.flac\",\"duration\":30},"
      "{\"id\":\"next\",\"source\":\"runtime-replaygain-next.flac\",\"duration\":30}]";
  assert(engine.loadQueue(queueJson, 0) == TAE_RESULT_OK);
  assert(engine.play("runtime-replaygain-current.flac", 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));
  assert(waitUntil([&engine] { return jsonContains(engine.getPlaybackInfoJson(), "\"preloadReady\":true"); }));

  assert(engine.setReplayGainMode("track", 0.0, -6.0, true) == TAE_RESULT_OK);
  assertLatestPlaybackContains(engine, "\"replayGainActive\":true");

  assert(engine.next() == TAE_RESULT_OK);
  assertLatestPlaybackContains(engine, "\"source\":\"runtime-replaygain-next.flac\"");
  assertLatestPlaybackContains(engine, "\"replayGainActive\":true");
  assertLatestPlaybackContains(engine, "\"replayGainDb\":-6");
}

void testGaplessBlockedReasonReportsCrossfadeAndDisabled() {
  EngineHarness harness;
  auto& engine = harness.engine();

  assert(engine.setDspConfig("{\"gapless\":false,\"crossfadeSeconds\":0}") == TAE_RESULT_OK);
  const std::string queueJson =
      "[{\"id\":\"current\",\"source\":\"gapless-status-a.flac\",\"duration\":30},"
      "{\"id\":\"next\",\"source\":\"gapless-status-b.flac\",\"duration\":30}]";
  assert(engine.loadQueue(queueJson, 0) == TAE_RESULT_OK);
  assert(engine.play("gapless-status-a.flac", 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));
  assertLatestPlaybackContains(engine, "\"gaplessBlockedReason\":\"disabled\"");
  assertLatestPlaybackContains(engine, "\"gaplessActive\":false");
  assertLatestPlaybackContains(engine, "\"preloadReady\":false");

  // Crossfade always wins over other path gates for blocked reason.
  assert(engine.setDspConfig("{\"gapless\":true,\"crossfadeSeconds\":0.05}") == TAE_RESULT_OK);
  assertLatestPlaybackContains(engine, "\"gaplessBlockedReason\":\"crossfade\"");
  assertLatestPlaybackContains(engine, "\"crossfadeActive\":true");

  // Non-unity volume leaves typed passthrough so gapless preload can arm.
  assert(engine.setVolume(0.5) == TAE_RESULT_OK);
  assert(engine.setDspConfig("{\"enabled\":true,\"gapless\":true,\"crossfadeSeconds\":0}") == TAE_RESULT_OK);
  assert(waitUntil([&engine] {
    return jsonContains(engine.getPlaybackInfoJson(), "\"preloadReady\":true");
  }));
  assertLatestPlaybackContains(engine, "\"gaplessActive\":true");
  assertLatestPlaybackContains(engine, "\"gaplessBlockedReason\":\"\"");
}

void testAutoNextPrefersPreloadedPromoteWithoutReopen() {
  EngineHarness harness;
  auto& engine = harness.engine();

  // Non-unity / DSP path keeps preload eligible (typed passthrough disables gapless).
  assert(engine.setVolume(0.5) == TAE_RESULT_OK);
  assert(engine.setDspConfig("{\"enabled\":true,\"gapless\":true,\"crossfadeSeconds\":0}") == TAE_RESULT_OK);
  const std::string queueJson =
      "[{\"id\":\"current\",\"source\":\"auto-promote-current.flac\",\"duration\":0.08},"
      "{\"id\":\"next\",\"source\":\"auto-promote-next.flac\",\"duration\":0.20}]";
  assert(engine.loadQueue(queueJson, 0) == TAE_RESULT_OK);
  assert(engine.play("auto-promote-current.flac", 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));
  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  assert(waitUntil([&engine] {
    return jsonContains(engine.getPlaybackInfoJson(), "\"preloadReady\":true");
  }));
  assertLatestPlaybackContains(engine, "\"gaplessActive\":true");
  assertLatestPlaybackContains(engine, "\"gaplessBlockedReason\":\"\"");

  const size_t backendCountBefore = g_backendRegistry.snapshots().size();
  pumpBackend(backend, 96);
  assert(waitUntil([&engine] {
    return jsonContains(engine.getPlaybackInfoJson(), "\"source\":\"auto-promote-next.flac\"");
  }));

  // Promote must not reopen the output device (no second backend start).
  const auto snapshots = g_backendRegistry.snapshots();
  assert(snapshots.size() == backendCountBefore);
  assertLatestPlaybackContains(engine, "\"source\":\"auto-promote-next.flac\"");
  assertLatestPlaybackContains(engine, "\"queueIndex\":1");
}

void testSingleFileCueSegmentsSeekPromoteGaplesslyAndRetainReplayGain() {
  EngineHarness harness;
  auto& engine = harness.engine();
  resetDecoderSeekProbe();

  // Non-unity volume selects the float DSP path, where gapless preload is available.
  assert(engine.setVolume(0.5) == TAE_RESULT_OK);
  assert(engine.setDspConfig(
      "{\"enabled\":true,\"gapless\":true,\"crossfadeSeconds\":0,"
      "\"volumeNormalization\":\"track\"}") == TAE_RESULT_OK);
  const std::string source = "single-file-cue.flac";
  const std::string queueJson =
      "[{\"id\":\"cue-1\",\"source\":\"" + source +
      "\",\"duration\":0.04,\"replayGainTrackGainDb\":-3,"
      "\"cueRange\":{\"startSeconds\":0,\"endSeconds\":0.04,\"pregapSeconds\":0}},"
      "{\"id\":\"cue-2\",\"source\":\"" + source +
      "\",\"duration\":0.08,\"replayGainTrackGainDb\":-9,"
      "\"cueRange\":{\"startSeconds\":0.04,\"endSeconds\":0.11,\"pregapSeconds\":0.01,"
      "\"virtualPregapSeconds\":0.01,\"sourcePregapSeconds\":0}}]";
  assert(engine.loadQueue(queueJson, 0) == TAE_RESULT_OK);
  assert(engine.play(source, 0.0) == TAE_RESULT_OK);
  assert(waitForStartedBackendCount(1));
  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  assert(waitUntil([&engine] {
    return jsonContains(engine.getPlaybackInfoJson(), "\"preloadReady\":true");
  }));
  assertLatestPlaybackContains(engine, "\"gaplessActive\":true");
  assertLatestPlaybackContains(engine, "\"replayGainDb\":-3");
  assert(decoderSeekObserved(0.04));

  const size_t backendCountBefore = g_backendRegistry.snapshots().size();
  bool promoted = false;
  for (int i = 0; i < 80; ++i) {
    renderBackendFrames(backend, 256);
    if (jsonContains(engine.getPlaybackInfoJson(), "\"queueIndex\":1")) {
      promoted = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  assert(promoted);
  assert(g_backendRegistry.snapshots().size() == backendCountBefore);
  assertLatestPlaybackContains(engine, "\"source\":\"single-file-cue.flac\"");
  assertLatestPlaybackContains(engine, "\"queueIndex\":1");
  assertLatestPlaybackContains(engine, "\"duration\":0.08");
  assertLatestPlaybackContains(engine, "\"replayGainDb\":-9");

  // Public positions are segment-relative. The decoder probe proves that a relative seek is
  // translated to the second segment's absolute source offset before decoding.
  assert(engine.seek(0.02) == TAE_RESULT_OK);
  assertLatestPlaybackContains(engine, "\"position\":0.02");
  assert(decoderSeekObserved(0.05));
  assert(engine.seek(99.0) == TAE_RESULT_OK);
  const double clampedPosition = playbackJsonNumber(engine.getPlaybackInfoJson(), "position");
  // Playback JSON is rounded after the seconds-to-frame quantization, so allow
  // one frame plus its serialized decimal rounding error.
  assert(std::abs(clampedPosition - 0.08) <= (1.1 / 44100.0));
  assert(decoderSeekObserved(0.11));
}

void testCueVirtualPregapRendersExactPcmSilenceAndMapsSeek() {
  EngineHarness harness;
  AudioPipeline pipeline;
  resetDecoderSeekProbe();

  QueueItem segment;
  segment.id = "cue-pcm-pregap";
  segment.source = "cue-pregap-pcm.flac";
  segment.title = "CUE virtual pregap";
  segment.cueStartSeconds = 0.02;
  segment.cueEndSeconds = 0.05;
  segment.cuePregapSeconds = 0.01;
  segment.cueVirtualPregapSeconds = 0.01;
  segment.durationSeconds = 0.04;
  segment.replayGainTrackGainDb = -9.0;

  std::string error;
  assert(
      pipeline.play(
          segment,
          std::nullopt,
          0.0,
          "wasapi-exclusive",
          "auto",
          1.0,
          "{\"enabled\":true,\"volumeNormalization\":\"track\",\"dither\":\"tpdf\"}",
          true,
          &error) == TAE_RESULT_OK);
  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  assert(std::abs(pipeline.status().stream.durationSeconds - 0.04) < 0.000000001);

  const auto beforeBoundary = renderBackendFrames(backend, 440);
  assert(std::all_of(beforeBoundary.begin(), beforeBoundary.end(), [](float sample) {
    return sample == 0.0f;
  }));
  const auto boundary = renderBackendFrames(backend, 4);
  assert(boundary[0] == 0.0f && boundary[1] == 0.0f);
  assert(std::abs(boundary[2]) > 0.01f && std::abs(boundary[3]) > 0.01f);

  resetDecoderSeekProbe();
  assert(pipeline.seek(0.005, &error) == TAE_RESULT_OK);
  assert(decoderSeekObserved(0.02));
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
  const auto seekPregap = renderBackendFrames(backend, 221);
  assert(std::all_of(seekPregap.begin(), seekPregap.end(), [](float sample) {
    return sample == 0.0f;
  }));
  const auto seekBoundary = renderBackendFrames(backend, 2);
  assert(std::abs(seekBoundary[2]) > 0.01f && std::abs(seekBoundary[3]) > 0.01f);

  resetDecoderSeekProbe();
  assert(pipeline.seek(0.02, &error) == TAE_RESULT_OK);
  assert(decoderSeekObserved(0.03));
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
  const auto sourceSeek = renderBackendFrames(backend, 2);
  assert(bufferHasSampleAbove(sourceSeek, 0.01f));
  pipeline.stop();
}

void testCueSameSourcePreloadPreservesFullVirtualPregapWithCrossfadeEnabled() {
  EngineHarness harness;
  AudioPipeline pipeline;
  QueueItem first;
  first.id = "cue-gapless-first";
  first.source = "cue-gapless-pregap.flac";
  first.cueStartSeconds = 0.0;
  first.cueEndSeconds = 0.005;
  first.durationSeconds = 0.005;

  QueueItem second;
  second.id = "cue-gapless-second";
  second.source = first.source;
  second.cueStartSeconds = 0.005;
  second.cueEndSeconds = 0.015;
  second.cuePregapSeconds = 0.005;
  second.cueVirtualPregapSeconds = 0.005;
  second.durationSeconds = 0.015;

  std::string error;
  assert(
      pipeline.play(
          first,
          second,
          0.0,
          "wasapi-exclusive",
          "auto",
          0.5,
          "{\"enabled\":true,\"gapless\":true,\"crossfadeSeconds\":0.004}",
          true,
          &error) == TAE_RESULT_OK);
  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  assert(waitUntil([&] { return pipeline.status().preloadReady; }));
  const size_t backendCountBefore = g_backendRegistry.snapshots().size();

  const auto promotedBlock = renderBackendFrames(backend, 256);
  assert(bufferHasSampleAbove(
      std::vector<float>(promotedBlock.begin(), promotedBlock.begin() + 440),
      0.01f));
  assert(std::all_of(promotedBlock.begin() + 442, promotedBlock.end(), [](float sample) {
    return sample == 0.0f;
  }));
  assert(waitUntil([&] { return pipeline.status().currentItem.id == second.id; }));
  assert(g_backendRegistry.snapshots().size() == backendCountBefore);
  assert(std::abs(pipeline.status().stream.durationSeconds - 0.015) < 0.000000001);

  const auto remainingPregap = renderBackendFrames(backend, 186);
  assert(std::all_of(remainingPregap.begin(), remainingPregap.end(), [](float sample) {
    return sample == 0.0f;
  }));
  const auto nextBoundary = renderBackendFrames(backend, 2);
  assert(std::abs(nextBoundary[2]) > 0.01f && std::abs(nextBoundary[3]) > 0.01f);
  pipeline.stop();
}

void testCueNativeDsdSegmentUsesBitSampleFrameRate() {
  EngineHarness harness("twilight-cue-native-dsd-frame-rate.dsf", kDsd64Rate);
  AudioPipeline pipeline;
  QueueItem segment;
  segment.id = "cue-dsd-1";
  segment.source = harness.dsdPath();
  segment.title = "Native DSD CUE segment";
  segment.cueStartSeconds = 0.0;
  segment.cueEndSeconds = 16.0 / static_cast<double>(kDsd64Rate);
  segment.cuePregapSeconds = 8.0 / static_cast<double>(kDsd64Rate);
  segment.cueVirtualPregapSeconds = 8.0 / static_cast<double>(kDsd64Rate);
  segment.durationSeconds = 24.0 / static_cast<double>(kDsd64Rate);

  std::string error;
  assert(
      pipeline.play(
          segment,
          std::nullopt,
          0.0,
          "asio",
          "auto",
          1.0,
          "{\"dsdOutputMode\":\"native\"}",
          true,
          &error) == TAE_RESULT_OK);
  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  assert(backend->typedStarted);
  assert(isDsdSampleFormat(backend->openedFormat.sampleFormat));

  const double expectedDuration = 24.0 / static_cast<double>(kDsd64Rate);
  const double expectedSourceEnd = 16.0 / static_cast<double>(kDsd64Rate);
  const PipelineStatus opened = pipeline.status();
  assert(std::abs(opened.stream.durationSeconds - expectedDuration) < 0.000000001);
  assert(opened.currentItem.cueStartSeconds && *opened.currentItem.cueStartSeconds == 0.0);
  assert(opened.currentItem.cueEndSeconds &&
         std::abs(*opened.currentItem.cueEndSeconds - expectedSourceEnd) < 0.000000001);

  const auto silence = renderBackendTypedBytes(backend, 1);
  assert(silence.size() == 2);
  assert(silence[0] == 0x69 && silence[1] == 0x69);
  // The first callback is the guard's transition pre-roll. Continue pumping
  // callbacks so the bounded pre-roll/post-roll can complete before checking
  // media position; mute callbacks must not advance it.
  for (size_t i = 0; i < 8; ++i) renderBackendTypedBytes(backend, 64);
  renderBackendTypedBytes(backend, 1);
  assert(waitUntil([&] { return pipeline.status().positionSeconds > 0.0; }));
  const double expectedOneByteFrame = 8.0 / static_cast<double>(kDsd64Rate);
  const double position = pipeline.status().positionSeconds;
  if (std::abs(position - expectedOneByteFrame) > 0.000000001) {
    std::fprintf(
        stderr,
        "Native DSD CUE position mismatch: expected %.12f got %.12f\n",
        expectedOneByteFrame,
        position);
    std::abort();
  }
  pipeline.stop();
}

void testCueDopPregapOutputsCanonicalCarrierAndResetsMarkerAfterSeek() {
  EngineHarness harness("twilight-cue-dop-pregap.dsf", kDsd64Rate);
  AudioPipeline pipeline;
  constexpr int kCarrierRate = kDsd64Rate / 16;
  constexpr double kVirtualPregap = 2.0 / static_cast<double>(kCarrierRate);

  QueueItem segment;
  segment.id = "cue-dop-pregap";
  segment.source = harness.dsdPath();
  segment.title = "DoP CUE pregap";
  segment.cueStartSeconds = 0.0;
  segment.cueEndSeconds = 2.0 / static_cast<double>(kCarrierRate);
  segment.cuePregapSeconds = kVirtualPregap;
  segment.cueVirtualPregapSeconds = kVirtualPregap;
  segment.durationSeconds = 4.0 / static_cast<double>(kCarrierRate);

  std::string error;
  assert(
      pipeline.play(
          segment,
          std::nullopt,
          0.0,
          "wasapi-exclusive",
          "auto",
          1.0,
          "{\"dsdOutputMode\":\"dop\"}",
          true,
          &error) == TAE_RESULT_OK);
  const auto backend = waitForLatestStartedBackendState();
  assert(backend);
  assert(backend->typedStarted);
  assert(formatLooksDopCarrier(backend->openedFormat));

  const auto transition = renderBackendFrames(backend, 2);
  assert(transition.size() == 4);
  // DSD idle is the 0x69 alternating pattern, but a DoP payload carries it
  // MSB-first, so the byte on the wire is its bit reversal 0x96. The source
  // here is DSF (LSB-first), so the packer reverses the 0x69 pregap fill onto
  // 0x96 - unlike the native DSD path above, which passes 0x69 through raw.
  const float marker05Silence = dopCarrierFloat(0x96, 0x96, 0x05);
  const float markerFaSilence = dopCarrierFloat(0x96, 0x96, 0xfa);
  assert(std::abs(transition[0] - marker05Silence) < 0.0000001f);
  assert(std::abs(transition[1] - marker05Silence) < 0.0000001f);
  assert(std::abs(transition[2] - markerFaSilence) < 0.0000001f);
  assert(std::abs(transition[3] - markerFaSilence) < 0.0000001f);
  const auto renderedPath = g_backendRegistry.snapshots();
  assert(!renderedPath.empty());
  assert(renderedPath.back().typedRenderCalls == 1);
  assert(renderedPath.back().floatRenderCalls == 0);

  renderBackendFrames(backend, 254);
  renderBackendFrames(backend, 256);
  assert(std::abs(pipeline.status().positionSeconds) < 0.0000001);

  const auto pregap = renderBackendFrames(backend, 2);
  assert(pregap.size() == 4);
  assert(std::abs(pregap[0] - marker05Silence) < 0.0000001f);
  assert(std::abs(pregap[1] - marker05Silence) < 0.0000001f);
  assert(std::abs(pregap[2] - markerFaSilence) < 0.0000001f);
  assert(std::abs(pregap[3] - markerFaSilence) < 0.0000001f);

  const auto source = renderBackendFrames(backend, 1);
  // Compare at carrier-LSB resolution, not with a coarse absolute tolerance.
  // A 24-bit carrier word is exact in float32, and the source payload here
  // (0x8844 / 0x9955) sits only ~700 LSBs from the 0x9696 idle word, which a
  // 1e-4 epsilon cannot resolve even though the words plainly differ.
  assert(std::abs(source[0] - marker05Silence) > 0.0000001f);
  assert(std::abs(source[1] - marker05Silence) > 0.0000001f);

  // Seeking back into the virtual prefix must neither advance source time nor
  // inherit an arbitrary marker phase from decoder prefetch.
  assert(pipeline.seek(0.0, &error) == TAE_RESULT_OK);
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
  const auto afterSeek = renderBackendFrames(backend, 1);
  assert(std::abs(afterSeek[0] - marker05Silence) < 0.0000001f);
  assert(std::abs(afterSeek[1] - marker05Silence) < 0.0000001f);
  pipeline.stop();
}

}  // namespace

namespace twilight::audio {

std::string defaultBackendId() {
  return "wasapi-exclusive";
}

std::unique_ptr<IOutputBackend> createOutputBackend(const std::string& backendId) {
  return std::make_unique<FakeOutputBackend>(backendId);
}

std::string enumeratePlatformDevicesJson() {
  return "[]";
}

std::string readMetadataJson(const std::string& source) {
  return "{\"source\":\"" + source + "\"}";
}

struct FFmpegDecoder::Impl {
  TrackProfile profile;
  AudioFormat outputFormat;
  size_t positionFrames = 0;
};

FFmpegDecoder::FFmpegDecoder()
    : impl_(std::make_unique<Impl>()) {}

FFmpegDecoder::~FFmpegDecoder() = default;

bool FFmpegDecoder::open(const std::string& source, std::string* error) {
  (void)error;
  impl_->profile = buildTrackProfile(source);
  impl_->outputFormat = impl_->profile.defaultOutput;
  impl_->positionFrames = 0;
  impl_->profile.stream.decodedFormat = impl_->outputFormat;
  return true;
}

void FFmpegDecoder::close() {
  impl_->positionFrames = impl_->profile.totalFrames;
}

bool FFmpegDecoder::setOutputFormat(const AudioFormat& format, std::string* error) {
  (void)error;
  impl_->outputFormat = format;
  impl_->profile.stream.decodedFormat = format;
  return true;
}

void FFmpegDecoder::setResamplerQuality(ResamplerQuality quality) {
  (void)quality;
}

size_t FFmpegDecoder::readFrames(float* output, size_t frameCount, std::string* error) {
  (void)error;
  if (impl_->outputFormat.sampleFormat != AudioSampleFormat::Float32Interleaved) return 0;
  const int delayMs = g_decodeFirstReadDelayMs.exchange(0);
  if (delayMs > 0 && impl_->positionFrames == 0) {
    std::this_thread::sleep_for(std::chrono::milliseconds(delayMs));
  }
  const int everyReadDelayMs = g_decodeEveryReadDelayMs.load();
  if (everyReadDelayMs > 0) {
    std::this_thread::sleep_for(std::chrono::milliseconds(everyReadDelayMs));
  }
  const size_t channels = static_cast<size_t>(std::max(1, impl_->outputFormat.channelCount));
  const size_t remaining = impl_->profile.totalFrames > impl_->positionFrames
                               ? impl_->profile.totalFrames - impl_->positionFrames
                               : 0;
  const size_t read = std::min(frameCount, remaining);
  for (size_t frame = 0; frame < read; ++frame) {
    for (size_t channel = 0; channel < channels; ++channel) {
      output[frame * channels + channel] = impl_->profile.sampleValue;
    }
  }
  impl_->positionFrames += read;
  return read;
}

size_t FFmpegDecoder::readFrames(PcmBlock& output, std::string* error) {
  (void)error;
  if (!output.data || output.frames == 0) return 0;
  if (output.byteSize > 0) std::memset(output.data, 0, output.byteSize);
  if (!pcmFormatsExactMatch(output.format, impl_->outputFormat)) return 0;
  const int delayMs = g_decodeFirstReadDelayMs.exchange(0);
  if (delayMs > 0 && impl_->positionFrames == 0) {
    std::this_thread::sleep_for(std::chrono::milliseconds(delayMs));
  }
  const int everyReadDelayMs = g_decodeEveryReadDelayMs.load();
  if (everyReadDelayMs > 0) {
    std::this_thread::sleep_for(std::chrono::milliseconds(everyReadDelayMs));
  }

  const size_t channels = static_cast<size_t>(std::max(1, impl_->outputFormat.channelCount));
  const size_t bytesPerSample = audioSampleFormatBytes(impl_->outputFormat.sampleFormat);
  const size_t remaining = impl_->profile.totalFrames > impl_->positionFrames
                               ? impl_->profile.totalFrames - impl_->positionFrames
                               : 0;
  const size_t read = std::min(output.frames, remaining);
  for (size_t frame = 0; frame < read; ++frame) {
    for (size_t channel = 0; channel < channels; ++channel) {
      const size_t offset = (frame * channels + channel) * bytesPerSample;
      writeSample(impl_->profile.sampleValue, impl_->outputFormat.sampleFormat, output.data + offset);
    }
  }
  impl_->positionFrames += read;
  return read;
}

bool FFmpegDecoder::seek(double seconds, std::string* error) {
  (void)error;
  const double clamped = std::max(0.0, seconds);
  {
    std::lock_guard lock(g_decoderSeekMutex);
    g_decoderSeekSeconds.push_back(clamped);
  }
  const double sampleRate = static_cast<double>(std::max(1, impl_->outputFormat.sampleRate));
  const size_t nextFrame = static_cast<size_t>(clamped * sampleRate);
  impl_->positionFrames = std::min(nextFrame, impl_->profile.totalFrames);
  return true;
}

bool FFmpegDecoder::eof() const {
  return impl_->positionFrames >= impl_->profile.totalFrames;
}

const AudioStreamInfo& FFmpegDecoder::streamInfo() const {
  return impl_->profile.stream;
}

const AudioFormat& FFmpegDecoder::outputFormat() const {
  return impl_->outputFormat;
}

std::string FFmpegDecoder::streamTitle() const {
  return {};
}

void FFmpegDecoder::pollStreamMetadata() {}

}  // namespace twilight::audio

int main() {
  testFixedSpscQueuePreservesFifoAndReportsFull();
  testFloatScratchResizeForOverwritePreservesSameSizedScratch();
  testVisualizationFftResolutionMatchesWebAudioReference();
  testRenderCallbacksDoNotResizePipelineScratchBuffers();
  testDecodeStreamReadFloatDoesNotResizeTypedScratch();
  testRenderCallbacksDoNotReconfigureDspChains();
  testRenderCallbackDoesNotCopyDspConfig();
  testRenderCallbacksDoNotBlockOnPipelineMutex();
  testRenderCallbacksDoNotWaitForDecoderBuffers();
  testNativeDsdRenderPositionAccountsForBitsPerByte();
  testRenderTypedGatesDopMarkerWritesOnDsdTransport();
  testTypedDsdFormatMismatchEmitsTransportIdleInsteadOfPcmFallback();
  testChannelRouterStateIsOwnedByRenderCallback();
  testRenderCallbacksUseNonBlockingSpectrumReset();
  testRenderCallbackDoesNotStopDecodeStreams();
  testSetDspConfigParsesJsonOutsidePipelineMutex();
  testSetVolumeAvoidsBlockingOnPipelineMutex();
  testFallbackStatusPreservesStableTransportState();
  testVolumeCommandApplicationIsRealtimeSafe();
  testVolumeCommandCallbackWorkIsBoundedAndUsesPortableAtomics();
  testDecodeStreamReaperRetiresOutsideAudioCallback();
  testCrossfadePromotionClearsStaleLocalPreloadState();
  testRenderSideDecodeStreamRetirementDoesNotAllocateOrDestroy();
  testSetDspConfigPreparesActiveChainForPreRoutingDecodeFormat();
  testDsdProcessingPcmDecisionUsesSharedHelper();
  testTwilightAudioEngineReusesParsedDspConfigSnapshot();
  testVolumeCommandAppliesAtRenderBoundary();
  testVolumeCommandStormCoalescesToNewestValue();
  testDspGraphCommandAppliesAtRenderBoundary();
  testDspGraphEpochRetirementStaysBoundedAcrossOneThousandUpdates();
  testApplyDspStateGraphPreparationFailureIsTransactional();
  testApplyDspStateCapacityFailureKeepsLastAcceptedState();
  testStoppedVolumeAcceptanceIsVisibleBeforePlayback();
  testConfigAppliedEventFollowsRenderApplication();
  testDsd64StartsOnDop();
  testPcmTypedPassthroughKeepsTypedPathDuringTransientDecoderLag();
  testPcmTypedPassthroughIsOutputPerfect();
  testPcm192kTypedPassthroughIsOutputPerfect();
  testPcmExactFormatWithoutTypedRuntimeIsNotPassthrough();
  testOutputStartWaitsForFirstDecodedFrames();
  testOutputStartDoesNotWaitForPrerollTimeoutAtEof();
  testBackendRenderErrorIsReportedThroughLastError();
  testStoppedSetOutputDeviceKeepsOutputInfoDeviceNamesConsistent();
  testOutputRouteTransactionCommitsOnceAfterBackendDeviceConfig();
  testRenderWaitsForTransientDecoderLag();
  testRoutedRenderHandlesCallbacksLargerThanPreparedScratch();
  testPcmVolumeFallsBackToFloatProcessing();
  testDsd128StartsOnDop();
  testAsioAutoPrefersNativeDsd();
  testAlsaNativeDsdAcceptsTransportFrameRate();
  testAsioDopModeDoesNotTryNativeDsd();
  testAsioDopCandidateIsProvenAfterStart();
  testAsioDopCandidateAfterStartFallsBackToPcm();
  testNativeDsdMuteTimeoutStopsWithoutAdvancingPosition();
  testDsdToPcmTransitionsMuteFloatWithoutAdvancingPosition();
  testAsioPcmModeDoesNotTryNativeDsd();
  testAsioNativeDsdMismatchFallsBackToDop();
  testDsdRouteOverrideCarriesNativeDsdOffMainBackend();
  testDsdRouteOverrideFallsBackToMainRouteWhenProxyMissing();
  testDsdRouteStrictPassthroughFailsInsteadOfDegradingToPcm();
  testDsdRouteOverrideIsNotUsedForPlainPcmSources();
  testDsdRouteAutoDiscoveryUsesProbeVerifiedProxy();
  testDsdRouteAutoDiscoveryIsInertWithoutCapableDevice();
  testExplicitDsdRouteWinsOverAutoDiscovery();
  testDsdRouteAutoDiscoveryFallsBackToMainRouteWhenProxyRefuses();
  testAsioNativeDsdAndDopFailureFallsBackToPcm();
  testAsioNativeDsdUnsupportedAndDopFailureFallsBackToPcm();
  testDsd256StartsOnWasapiExclusiveDop();
  testDsd512StartsOnWasapiExclusiveDop();
  testDsd256StartsOnAsioNativeDsd();
  testNativeDsdPositionUsesBitSampleFrames();
  testDsd512StartsOnAsioNativeDsd();
  testDsd512ForcedPcmUsesExplicitFallbackRate();
  testSacdIsoTrackUsesAsioNativeDsd();
  testSacdIsoTrackFallsBackToPcmWhenProcessingActive();
  testDsdDownratePolicyNegotiatesRateFirstAndReportsActualRate();
  testDsdDownratePolicyFallsBackToPcmAfterAllDsdRatesAreRejected();
  testDsdExactPolicyRejectsUnavailableSourceRateWithoutPcmFallback();
  testDopMismatchFallsBackWithStableCode();
  testDopUnprovenFallsBackWithStableCode();
  testInitialNonUnityVolumeUsesPcmFallback();
  testNonUnityVolumeTicksDoNotRestartDsdPlayback();
  testEqEnableRequestsPcmReroute();
  testDisabledGraphKeepsDsdPassthroughDespiteLegacyEqFlag();
  testEnabledGraphNodeStillForcesDsdPcmFallback();
  testEnabledButFlatGraphEqKeepsDsdPassthrough();
  testFlatLegacyEqKeepsDsdPassthrough();
  testVolumeChangeRequestsPcmReroute();
  testUnityVolumeReentersForcedDopFromPcm();
  testDsdOutputModePcmRequestsPcmReroute();
  testDsdOutputModeDopReentersDopPath();
  testSeekReevaluatesDsdPath();
  testPausedSettingsFallbackBeforeResume();
  testWasapiExclusiveTopologyUpdateReopensAndResumesPlaying();
  testWasapiExclusiveTopologyStartFailureRollsBackAndPreservesPausedState();
  testWasapiExclusiveTopologyDeviceInvalidationRollsBack();
  testManualNextDoesNotInheritDsdPath();
  testAutoNextDoesNotInheritDsdPath();
  testNativeCrossfadeOverlapMixesPreloadAndPromotes();
  testPreloadedPromotionKeepsRuntimeReplayGainSettings();
  testGaplessBlockedReasonReportsCrossfadeAndDisabled();
  testAutoNextPrefersPreloadedPromoteWithoutReopen();
  testSingleFileCueSegmentsSeekPromoteGaplesslyAndRetainReplayGain();
  testCueVirtualPregapRendersExactPcmSilenceAndMapsSeek();
  testCueSameSourcePreloadPreservesFullVirtualPregapWithCrossfadeEnabled();
  testCueNativeDsdSegmentUsesBitSampleFrameRate();
  testCueDopPregapOutputsCanonicalCarrierAndResetsMarkerAfterSeek();
  return 0;
}
