#include "../core/AudioTypes.h"
#include "../output/wasapi/WasapiCommon.h"
#include "../output/wasapi/WasapiFormatNegotiator.h"

#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <limits>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <audioclient.h>
#include <ksmedia.h>
#include <mmreg.h>
#endif

using namespace twilight::audio;

namespace {

AudioFormat dsdSource(int sampleRate) {
  AudioFormat format;
  format.sampleRate = sampleRate;
  format.channelCount = 2;
  format.bitDepth = 1;
  format.sampleFormat = AudioSampleFormat::Int16Interleaved;
  return format;
}

#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)

std::string readTextFile(const std::filesystem::path& path) {
  std::ifstream in(path, std::ios::binary);
  std::ostringstream buffer;
  buffer << in.rdbuf();
  return buffer.str();
}

std::string extractFunctionBody(const std::string& source, const std::string& signature) {
  const size_t signaturePos = source.find(signature);
  if (signaturePos == std::string::npos) {
    std::fprintf(
        stderr,
        "Missing source signature: %s (source bytes=%zu)\n",
        signature.c_str(),
        source.size());
    std::abort();
  }
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

void testWasapiExclusiveRenderPacketDoesNotResizeScratch() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "wasapi" / "WasapiExclusiveBackend.cpp";
  const std::string renderPacketBody = extractFunctionBody(readTextFile(sourcePath), "HRESULT renderPacket(UINT32 frameCount)");

  assert(renderPacketBody.find("renderScratch.resize") == std::string::npos);
}

void testWasapiExclusiveDopDiagnosticsStayAllocationFreeInRenderPacket() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "wasapi" / "WasapiExclusiveBackend.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderPacketBody = extractFunctionBody(source, "HRESULT renderPacket(UINT32 frameCount)");
  const std::string outputInfoBody = extractFunctionBody(source, "OutputInfo WasapiExclusiveBackend::outputInfo() const");

  assert(renderPacketBody.find("inspectDopBuffer") != std::string::npos);
  assert(renderPacketBody.find("dopBufferSummary") == std::string::npos);
  assert(renderPacketBody.find("std::ostringstream") == std::string::npos);
  assert(renderPacketBody.find("firstBufferSummary") == std::string::npos);
  assert(renderPacketBody.find("outputInfo.diagnostics = diagnostics") == std::string::npos);
  assert(outputInfoBody.find("dopBufferSummary") != std::string::npos);
}

void testWasapiExclusiveDopBoundariesSubmitTypedCarrierWithoutSilentFlag() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "wasapi" / "WasapiExclusiveBackend.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string startBody = extractFunctionBody(source, "bool startWithCallbacks(");
  const std::string stopBody = extractFunctionBody(source, "void stop()");

  const std::string dopBranchSignature = "if (isDopCarrierFormat(outputFormat) && typedCallback)";
  const std::string prefillDopBody = extractFunctionBody(startBody, dopBranchSignature);
  assert(prefillDopBody.find("(void)typedCallback(block)") != std::string::npos);
  assert(prefillDopBody.find("prefillFlags = 0") != std::string::npos);
  assert(prefillDopBody.find("std::memset(data, 0, byteCount)") == std::string::npos);
  assert(startBody.find("ReleaseBuffer(prefillFrames, prefillFlags)") != std::string::npos);

  const std::string stopDopBody = extractFunctionBody(stopBody, dopBranchSignature);
  assert(stopDopBody.find("(void)typedCallback(block)") != std::string::npos);
  assert(stopDopBody.find("releaseFlags = 0") != std::string::npos);
  assert(stopDopBody.find("std::memset(data, 0, byteCount)") == std::string::npos);
  assert(stopBody.find("ReleaseBuffer(framesAvailable, releaseFlags)") != std::string::npos);
}

void testWasapiExclusiveFloat32RenderPacketBypassesScratchPackCopy() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "wasapi" / "WasapiExclusiveBackend.cpp";
  const std::string renderPacketBody = extractFunctionBody(readTextFile(sourcePath), "HRESULT renderPacket(UINT32 frameCount)");

  const size_t directBranch = renderPacketBody.find("outputFormat.sampleFormat == AudioSampleFormat::Float32Interleaved");
  const size_t scratchRender = renderPacketBody.find("renderScratch.data()");
  const size_t packCall = renderPacketBody.find("wasapi::packFloatToPcm");
  assert(directBranch != std::string::npos);
  assert(renderPacketBody.find("reinterpret_cast<float*>(data)", directBranch) != std::string::npos);
  assert(scratchRender == std::string::npos || directBranch < scratchRender);
  assert(packCall == std::string::npos || directBranch < packCall);
}

void testWasapiSharedRenderLoopUsesMmcss() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "wasapi" / "WasapiSharedBackend.cpp";
  const std::string renderLoopBody = extractFunctionBody(readTextFile(sourcePath), "void renderLoop()");

  assert(renderLoopBody.find("AvSetMmThreadCharacteristicsW") != std::string::npos);
  assert(renderLoopBody.find("AvRevertMmThreadCharacteristics") != std::string::npos);
}

void testWasapiSharedRenderLoopUsesNonBlockingFailureTelemetry() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "wasapi" / "WasapiSharedBackend.cpp";
  const std::string renderLoopBody = extractFunctionBody(readTextFile(sourcePath), "void renderLoop()");
  const std::string renderFailureBody = extractFunctionBody(
      readTextFile(sourcePath),
      "void recordRenderFailureFromRenderThread(HRESULT hr, const char* message) noexcept");

  assert(renderLoopBody.find("recordRenderFailureFromRenderThread") != std::string::npos);
  assert(renderLoopBody.find("recordRenderFailure(hr") == std::string::npos);
  assert(renderFailureBody.find("std::try_to_lock") != std::string::npos);
  assert(renderFailureBody.find("std::lock_guard lock(infoMutex)") == std::string::npos);
  assert(renderFailureBody.find("hresultMessage") == std::string::npos);
  assert(renderFailureBody.find("std::string") == std::string::npos);
  assert(renderFailureBody.find("outputInfo.") == std::string::npos);
  assert(renderFailureBody.find("outputInfo.diagnostics = diagnostics") == std::string::npos);
}

void testWasapiExclusiveRenderFailurePublishingStaysOffMmcssPath() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "wasapi" / "WasapiExclusiveBackend.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderFailureBody =
      extractFunctionBody(source, "void recordRenderFailureFromRenderThread(HRESULT hr) noexcept");
  const std::string renderLoopBody = extractFunctionBody(source, "void renderLoop()");
  const size_t revertPos = renderLoopBody.find("AvRevertMmThreadCharacteristics");
  const size_t publishPos = renderLoopBody.find("publishQueuedRenderFailure");

  assert(renderFailureBody.find("std::try_to_lock") != std::string::npos);
  assert(renderFailureBody.find("std::string") == std::string::npos);
  assert(renderFailureBody.find("diagnostics.lastError") == std::string::npos);
  assert(renderFailureBody.find("outputInfo.") == std::string::npos);
  assert(revertPos != std::string::npos);
  assert(publishPos != std::string::npos);
  assert(revertPos < publishPos);
}

void testWasapiSharedRenderLoopDefersDeviceInvalidatedCallbackUntilAfterMmcss() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "wasapi" / "WasapiSharedBackend.cpp";
  const std::string renderLoopBody = extractFunctionBody(readTextFile(sourcePath), "void renderLoop()");
  const size_t revertPos = renderLoopBody.find("AvRevertMmThreadCharacteristics");
  const size_t callbackPos = renderLoopBody.find("eventCallback(");

  assert(revertPos != std::string::npos);
  assert(callbackPos != std::string::npos);
  assert(revertPos < callbackPos);
  assert(renderLoopBody.find("deviceInvalidatedEventQueued.store(true)") != std::string::npos);
}

void testWasapiSharedStopDoesNotJoinCurrentRenderThread() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "wasapi" / "WasapiSharedBackend.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string joinSignature = "void joinRenderThread()";
  assert(source.find(joinSignature) != std::string::npos);
  const std::string stopBody = extractFunctionBody(source, "void stop()");
  const std::string joinBody = extractFunctionBody(source, joinSignature);
  const std::string startBody = extractFunctionBody(
      source,
      "bool WasapiSharedBackend::start(RenderCallback callback, OutputEventCallback eventCallback, std::string* error)");

  assert(source.find("std::mutex threadMutex") != std::string::npos);
  assert(startBody.find("launchRenderThread()") != std::string::npos);
  assert(stopBody.find("joinRenderThread()") != std::string::npos);
  assert(joinBody.find("renderThread.get_id() != std::this_thread::get_id()") != std::string::npos);
}

void testWasapiStartEntrypointsRejectAlreadyRunningBackend() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path wasapiDir = testFilePath.parent_path().parent_path() / "output" / "wasapi";
  const std::string sharedSource = readTextFile(wasapiDir / "WasapiSharedBackend.cpp");
  const std::string exclusiveSource = readTextFile(wasapiDir / "WasapiExclusiveBackend.cpp");
  const std::string sharedStartBody = extractFunctionBody(
      sharedSource,
      "bool WasapiSharedBackend::start(RenderCallback callback, OutputEventCallback eventCallback, std::string* error)");
  const std::string exclusiveStartBody = extractFunctionBody(
      exclusiveSource,
      "bool WasapiExclusiveBackend::start(RenderCallback callback, OutputEventCallback eventCallback, std::string* error)");
  const std::string exclusiveStartTypedBody = extractFunctionBody(exclusiveSource, "bool WasapiExclusiveBackend::startTyped");
  const std::string exclusiveStartHelperBody = extractFunctionBody(exclusiveSource, "bool startWithCallbacks(");

  for (const std::string& body : {sharedStartBody, exclusiveStartHelperBody}) {
    const size_t runningCheck = body.find("impl_->running.load()");
    const size_t directRunningCheck = body.find("running.load()");
    const size_t callbackInstall = body.find("impl_->callback");
    const size_t directCallbackInstall = body.find("callback = std::move");
    const size_t launchThread = body.find("impl_->launchRenderThread()");
    const size_t directLaunchThread = body.find("launchRenderThread()");
    const size_t check = runningCheck != std::string::npos ? runningCheck : directRunningCheck;
    const size_t install = callbackInstall != std::string::npos ? callbackInstall : directCallbackInstall;
    const size_t launch = launchThread != std::string::npos ? launchThread : directLaunchThread;
    assert(check != std::string::npos);
    assert(install != std::string::npos);
    assert(launch != std::string::npos);
    assert(check < install);
    assert(check < launch);
  }
  assert(exclusiveStartBody.find("impl_->startWithCallbacks(std::move(callback), nullptr") != std::string::npos);
  assert(exclusiveStartTypedBody.find("impl_->startWithCallbacks(std::move(fallbackCallback), std::move(callback)") !=
         std::string::npos);
}

void testWasapiOpenFailurePathsClosePartiallyOpenedResources() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path wasapiDir = testFilePath.parent_path().parent_path() / "output" / "wasapi";
  const std::string sharedSource = readTextFile(wasapiDir / "WasapiSharedBackend.cpp");
  const std::string exclusiveSource = readTextFile(wasapiDir / "WasapiExclusiveBackend.cpp");
  const std::string sharedFailAfterComBody = extractFunctionBody(sharedSource, "auto failAfterCom = [&]()");
  const std::string exclusiveFailAfterComBody = extractFunctionBody(exclusiveSource, "auto failAfterCom = [&]()");

  assert(sharedFailAfterComBody.find("impl_->close()") != std::string::npos);
  assert(exclusiveFailAfterComBody.find("impl_->close()") != std::string::npos);
  assert(sharedFailAfterComBody.find("CoUninitialize()") == std::string::npos);
  assert(exclusiveFailAfterComBody.find("CoUninitialize()") == std::string::npos);
}

void testWasapiExclusiveRenderFailuresUseNonBlockingTelemetry() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "wasapi" / "WasapiExclusiveBackend.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string handleFailureBody =
      extractFunctionBody(source, "bool handleRenderFailure(HRESULT hr, const char* message)");
  const std::string renderFailureBody =
      extractFunctionBody(source, "void recordRenderFailureFromRenderThread(HRESULT hr) noexcept");

  assert(handleFailureBody.find("recordRenderFailureFromRenderThread(hr)") != std::string::npos);
  assert(handleFailureBody.find("queuedRenderFailureMessage = message") != std::string::npos);
  assert(handleFailureBody.find("notifyFailure(hr, message)") == std::string::npos);
  assert(renderFailureBody.find("std::try_to_lock") != std::string::npos);
  assert(renderFailureBody.find("recordFailure(") == std::string::npos);
  assert(renderFailureBody.find("std::lock_guard lock(infoMutex)") == std::string::npos);
  assert(renderFailureBody.find("diagnostics.lastError") == std::string::npos);
  assert(renderFailureBody.find("outputInfo.") == std::string::npos);
}

void testWasapiExclusiveRenderLoopDoesNotWriteSharedTelemetryDirectly() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "wasapi" / "WasapiExclusiveBackend.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderLoopBody = extractFunctionBody(source, "void renderLoop()");
  const std::string underrunBody = extractFunctionBody(source, "void recordRenderUnderrun() noexcept");

  assert(renderLoopBody.find("recordRenderUnderrun()") != std::string::npos);
  assert(renderLoopBody.find("refreshLatencyTelemetry()") != std::string::npos);
  assert(renderLoopBody.find("++diagnostics.sessionUnderrunCount") == std::string::npos);
  assert(renderLoopBody.find("++diagnostics.lifetimeUnderrunCount") == std::string::npos);
  assert(renderLoopBody.find("outputInfo.latencyInfo.") == std::string::npos);
  assert(renderLoopBody.find("outputInfo.latencyMs") == std::string::npos);
  assert(underrunBody.find("std::try_to_lock") != std::string::npos);
  assert(underrunBody.find("outputInfo.diagnostics = diagnostics") == std::string::npos);
  assert(underrunBody.find("std::string") == std::string::npos);
}

void testWasapiExclusiveRecoveryDoesNotWriteSharedTelemetryDirectly() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "wasapi" / "WasapiExclusiveBackend.cpp";
  const std::string recoveryBody = extractFunctionBody(readTextFile(sourcePath), "bool attemptRecovery(const std::string& reason)");

  assert(recoveryBody.find("recordRecoverySuccess()") != std::string::npos);
  assert(recoveryBody.find("++diagnostics.sessionRecoveryCount") == std::string::npos);
  assert(recoveryBody.find("++diagnostics.lifetimeRecoveryCount") == std::string::npos);
  assert(recoveryBody.find("outputInfo.deviceRecovered") == std::string::npos);
  assert(recoveryBody.find("outputInfo.recoveryCount") == std::string::npos);
  assert(recoveryBody.find("outputInfo.diagnostics") == std::string::npos);
}

void testWasapiExclusiveRenderFailureQueuesRecoveryOffRenderThread() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "wasapi" / "WasapiExclusiveBackend.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string handleFailureBody = extractFunctionBody(source, "bool handleRenderFailure(HRESULT hr, const char* message)");
  const std::string queueRecoveryBody = extractFunctionBody(source, "bool queueRecoveryFromRenderThread(const char* reason)");

  assert(handleFailureBody.find("queueRecoveryFromRenderThread") != std::string::npos);
  assert(handleFailureBody.find("attemptRecovery(") == std::string::npos);
  assert(handleFailureBody.find("std::this_thread::sleep_for") == std::string::npos);
  assert(handleFailureBody.find("reopenDevice(") == std::string::npos);
  assert(handleFailureBody.find("CoCreateInstance") == std::string::npos);
  assert(handleFailureBody.find("GetDevice") == std::string::npos);
  assert(handleFailureBody.find("Activate") == std::string::npos);
  assert(handleFailureBody.find("Start(") == std::string::npos);
  assert(handleFailureBody.find("eventCallback(") == std::string::npos);
  assert(queueRecoveryBody.find("joinRecoveryThread()") == std::string::npos);
  assert(queueRecoveryBody.find("std::lock_guard lock(threadMutex)") == std::string::npos);
  assert(queueRecoveryBody.find("std::thread(") == std::string::npos);
  assert(queueRecoveryBody.find("eventCallback(") == std::string::npos);
}

void testWasapiExclusiveRecoveryStopsBeforeReopenOrNotifyAfterClose() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "wasapi" / "WasapiExclusiveBackend.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string recoveryBody = extractFunctionBody(source, "bool attemptRecovery(const std::string& reason)");
  const std::string queuedRecoveryBody = extractFunctionBody(source, "void runQueuedRecovery(std::string reason)");

  // The backoff is an interruptible wait on stopRequested (stop()/close() must
  // never be parked for the full backoff ladder), and every driver-touching
  // step stays gated by a stop check.
  const size_t backoffPos = recoveryBody.find("threadCv.wait_for");
  const size_t reopenPos = recoveryBody.find("reopenDevice()");
  const size_t startPos = recoveryBody.find("audioClient->Start()");
  assert(backoffPos != std::string::npos);
  assert(reopenPos != std::string::npos);
  assert(startPos != std::string::npos);
  assert(recoveryBody.find("std::this_thread::sleep_for") == std::string::npos);
  assert(recoveryBody.find("stopRequested.load()", backoffPos) < reopenPos);
  assert(recoveryBody.find("stopRequested.load()", reopenPos) < startPos);
  assert(queuedRecoveryBody.find("!stopRequested.load()") != std::string::npos);
  assert(queuedRecoveryBody.find("eventCallback") != std::string::npos);
}

void testWasapiExclusiveOpenClearsDeferredRenderFailureState() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "wasapi" / "WasapiExclusiveBackend.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string openBody = extractFunctionBody(
      source,
      "bool WasapiExclusiveBackend::open(const std::string& deviceId, const AudioFormat& requestedFormat, std::string* error)");

  assert(openBody.find("impl_->queuedRecoveryReason = nullptr") != std::string::npos);
  assert(openBody.find("impl_->queuedRenderFailureMessage = nullptr") != std::string::npos);
  assert(openBody.find("impl_->queuedRenderFailureHr.store(S_OK)") != std::string::npos);
  assert(openBody.find("impl_->renderErrorEventQueued.store(false)") != std::string::npos);
  assert(openBody.find("impl_->deviceInvalidatedEventQueued.store(false)") != std::string::npos);
}

struct SupportedFormat {
  int sampleRate = 0;
  int validBits = 0;
  int containerBits = 0;
};

struct ProbedFormat {
  int sampleRate = 0;
  int validBits = 0;
  int containerBits = 0;
};

class FakeAudioClient final : public IAudioClient {
 public:
  explicit FakeAudioClient(std::vector<SupportedFormat> supported) : supported_(std::move(supported)) {}

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void**) override {
    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override {
    return 1;
  }

  ULONG STDMETHODCALLTYPE Release() override {
    return 1;
  }

  HRESULT STDMETHODCALLTYPE Initialize(
      AUDCLNT_SHAREMODE,
      DWORD,
      REFERENCE_TIME,
      REFERENCE_TIME,
      const WAVEFORMATEX*,
      LPCGUID) override {
    return E_NOTIMPL;
  }

  HRESULT STDMETHODCALLTYPE GetBufferSize(UINT32*) override {
    return E_NOTIMPL;
  }

  HRESULT STDMETHODCALLTYPE GetStreamLatency(REFERENCE_TIME*) override {
    return E_NOTIMPL;
  }

  HRESULT STDMETHODCALLTYPE GetCurrentPadding(UINT32*) override {
    return E_NOTIMPL;
  }

  HRESULT STDMETHODCALLTYPE IsFormatSupported(
      AUDCLNT_SHAREMODE shareMode,
      const WAVEFORMATEX* format,
      WAVEFORMATEX**) override {
    assert(shareMode == AUDCLNT_SHAREMODE_EXCLUSIVE);
    assert(format != nullptr);
    assert(format->wFormatTag == WAVE_FORMAT_EXTENSIBLE);

    const auto* extensible = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format);
    probes.push_back({
        static_cast<int>(format->nSamplesPerSec),
        static_cast<int>(extensible->Samples.wValidBitsPerSample),
        static_cast<int>(format->wBitsPerSample),
    });

    for (const SupportedFormat& supported : supported_) {
      if (supported.sampleRate == static_cast<int>(format->nSamplesPerSec) &&
          supported.validBits == static_cast<int>(extensible->Samples.wValidBitsPerSample) &&
          supported.containerBits == static_cast<int>(format->wBitsPerSample)) {
        return S_OK;
      }
    }
    return AUDCLNT_E_UNSUPPORTED_FORMAT;
  }

  HRESULT STDMETHODCALLTYPE GetMixFormat(WAVEFORMATEX**) override {
    return E_NOTIMPL;
  }

  HRESULT STDMETHODCALLTYPE GetDevicePeriod(REFERENCE_TIME*, REFERENCE_TIME*) override {
    return E_NOTIMPL;
  }

  HRESULT STDMETHODCALLTYPE Start() override {
    return E_NOTIMPL;
  }

  HRESULT STDMETHODCALLTYPE Stop() override {
    return E_NOTIMPL;
  }

  HRESULT STDMETHODCALLTYPE Reset() override {
    return E_NOTIMPL;
  }

  HRESULT STDMETHODCALLTYPE SetEventHandle(HANDLE) override {
    return E_NOTIMPL;
  }

  HRESULT STDMETHODCALLTYPE GetService(REFIID, void**) override {
    return E_NOTIMPL;
  }

  std::vector<ProbedFormat> probes;

 private:
  std::vector<SupportedFormat> supported_;
};

void require(bool condition) {
  if (!condition) std::abort();
}

void testInt16PackerUsesSpecializedConversion() {
  const float input[] = {-1.5f, -1.0f, -0.5f, 0.5f, 1.0f, 1.5f};
  int16_t output[] = {123, 123, 123, 123, 123, 123};

  wasapi::packFloatToInt16(input, 6, output);

  require(output[0] == -32768);
  require(output[1] == -32768);
  require(output[2] == -16384);
  require(output[3] == 16384);
  require(output[4] == 32767);
  require(output[5] == 32767);
}

void testPackedInt24PackerUsesSpecializedConversion() {
  const float input[] = {-1.0f, -0.5f, 0.5f, 1.0f};
  std::vector<uint8_t> output(12, 0xee);

  wasapi::packFloatToPackedInt24(input, 4, output.data());

  const std::vector<uint8_t> expected = {
      0x00, 0x00, 0x80,
      0x00, 0x00, 0xc0,
      0x00, 0x00, 0x40,
      0xff, 0xff, 0x7f,
  };
  require(output == expected);
}

void testInt32PackerUsesSpecializedConversion() {
  const float input[] = {-1.0f, -0.5f, 0.5f, 1.0f};
  int32_t output[] = {123, 123, 123, 123};

  wasapi::packFloatToInt32(input, 4, output);

  require(output[0] == std::numeric_limits<int32_t>::min());
  require(output[1] == -1073741824);
  require(output[2] == 1073741824);
  require(output[3] == std::numeric_limits<int32_t>::max());
}

void testDsd64NegotiatesDopCarrier() {
  FakeAudioClient client({{176400, 24, 32}});
  WasapiFormatNegotiator negotiator(&client);
  std::string error;

  assert(negotiator.negotiate(dsdSource(2822400), &error));
  assert(error.empty());
  assert(client.probes.size() == 2);
  assert(client.probes[0].sampleRate == 176400);
  assert(client.probes[0].validBits == 24);
  assert(client.probes[0].containerBits == 24);
  assert(client.probes[1].sampleRate == 176400);
  assert(client.probes[1].validBits == 24);
  assert(client.probes[1].containerBits == 32);

  const AudioFormat output = negotiator.outputFormat();
  assert(output.sampleRate == 176400);
  assert(output.bitDepth == 24);
  assert(output.sampleFormat == AudioSampleFormat::Int24In32Interleaved);

  const OutputInfo info = negotiator.outputInfo();
  assert(info.exclusive);
  assert(info.supportsOutputPerfect);
  assert(!info.outputPerfect);
  assert(!info.pcmPassthrough);
  assert(info.actualOutputFormat == "int24-in32");
  assert(info.perfectReason.find("DoP carrier") != std::string::npos);

  const DopRuntimeFacts facts = negotiator.dopRuntimeFacts();
  assert(facts.state == DopRuntimeFactState::Proven);
  assert(facts.explicitlyCapable);
  assert(facts.candidateFormat.sampleRate == 176400);
  assert(facts.candidateFormat.sampleFormat == AudioSampleFormat::Int24In32Interleaved);
  assert(pcmFormatsExactMatch(facts.candidateFormat, facts.actualFormat));
}

void testDsd128FailureReasonNamesDopCarrierFacts() {
  FakeAudioClient client({});
  WasapiFormatNegotiator negotiator(&client);
  std::string error;

  assert(!negotiator.negotiate(dsdSource(5644800), &error));
  assert(error.find("DoP carrier sample rate 352800Hz") != std::string::npos);
  assert(error.find("DoP carrier bit depth 24bit") != std::string::npos);
  assert(error.find("DoP carrier sample format int24/int24-in32") != std::string::npos);
  assert(error.find("未尝试 Native DSD") != std::string::npos);

  const OutputInfo info = negotiator.outputInfo();
  assert(info.exclusive);
  assert(!info.supportsOutputPerfect);
  assert(!info.outputPerfect);
  assert(info.perfectReason == error);

  const DopRuntimeFacts facts = negotiator.dopRuntimeFacts();
  assert(facts.state == DopRuntimeFactState::Unproven);
  assert(!facts.explicitlyCapable);
  assert(facts.candidateFormat.sampleRate == 352800);
  assert(facts.reason == error);
}

void testDsd256FailureReasonNamesDopCarrierFacts() {
  FakeAudioClient client({});
  WasapiFormatNegotiator negotiator(&client);
  std::string error;

  assert(!negotiator.negotiate(dsdSource(11289600), &error));
  assert(!client.probes.empty());
  assert(error.find("DoP carrier sample rate 705600Hz") != std::string::npos);
  assert(error.find("未尝试 Native DSD") != std::string::npos);

  const DopRuntimeFacts facts = negotiator.dopRuntimeFacts();
  assert(facts.state == DopRuntimeFactState::Unproven);
  assert(!facts.explicitlyCapable);
  assert(facts.candidateFormat.sampleRate == 705600);
}

void testExclusiveBufferPolicyAvoidsMinimumPeriodForAuto() {
  const REFERENCE_TIME minimumPeriod = wasapi::framesToReferenceTime(64, 48000);
  const REFERENCE_TIME defaultPeriod = wasapi::framesToReferenceTime(480, 48000);

  assert(wasapi::chooseExclusiveBufferDuration(0, 48000, defaultPeriod, minimumPeriod) == defaultPeriod);
  assert(wasapi::chooseExclusiveBufferDuration(128, 48000, defaultPeriod, minimumPeriod) ==
         wasapi::framesToReferenceTime(128, 48000));
  assert(wasapi::chooseExclusiveBufferDuration(0, 48000, 0, minimumPeriod) == minimumPeriod);
}

void testExclusiveInitialRenderLeavesWakeupHeadroom() {
  assert(wasapi::exclusiveInitialRenderFrames(0, true) == 0);
  assert(wasapi::exclusiveInitialRenderFrames(1, true) == 1);
  assert(wasapi::exclusiveInitialRenderFrames(64, true) == 32);
  assert(wasapi::exclusiveInitialRenderFrames(481, true) == 240);
  assert(wasapi::exclusiveInitialRenderFrames(64, false) == 64);
}

void testExclusiveRenderFramePolicySeparatesEventAndPushMode() {
  assert(wasapi::exclusiveRenderFrames(0, 0, false) == 0);
  assert(wasapi::exclusiveRenderFrames(512, 128, false) == 512);
  assert(wasapi::exclusiveRenderFrames(512, 128, true) == 384);
  assert(wasapi::exclusiveRenderFrames(512, 512, true) == 0);
}

void testExclusiveDeviceInUseIsRetryableStartupFailure() {
  assert(wasapi::isDeviceInUse(AUDCLNT_E_DEVICE_IN_USE));
  assert(!wasapi::isDeviceInUse(AUDCLNT_E_UNSUPPORTED_FORMAT));
}

void testFloatRenderHelperZerosOnlyUnrenderedTail() {
  std::vector<float> buffer = {
      -1.0f, -1.0f,
      -1.0f, -1.0f,
      -1.0f, -1.0f,
  };

  const size_t rendered = wasapi::renderFloatCallbackWithTailSilence(
      buffer.data(),
      3,
      2,
      [](float* output, size_t frames) {
        assert(frames == 3);
        output[0] = 0.25f;
        output[1] = -0.25f;
        return static_cast<size_t>(1);
      });

  assert(rendered == 1);
  assert(buffer[0] == 0.25f);
  assert(buffer[1] == -0.25f);
  for (size_t index = 2; index < buffer.size(); ++index) {
    assert(buffer[index] == 0.0f);
  }
}

void testFloatRenderHelperDoesNotPreclearFullRender() {
  std::vector<float> buffer = {
      -1.0f, -1.0f,
      -1.0f, -1.0f,
  };

  const size_t rendered = wasapi::renderFloatCallbackWithTailSilence(
      buffer.data(),
      2,
      2,
      [](float* output, size_t frames) {
        assert(frames == 2);
        for (size_t sample = 0; sample < frames * 2; ++sample) {
          assert(output[sample] == -1.0f);
          output[sample] = static_cast<float>(sample + 1);
        }
        return frames;
      });

  assert(rendered == 2);
  assert(buffer[0] == 1.0f);
  assert(buffer[1] == 2.0f);
  assert(buffer[2] == 3.0f);
  assert(buffer[3] == 4.0f);
}

void testFloatRenderHelperZerosAllWithoutCallback() {
  std::vector<float> buffer = {
      -1.0f, -1.0f,
      -1.0f, -1.0f,
  };

  const size_t rendered = wasapi::renderFloatCallbackWithTailSilence(
      buffer.data(),
      2,
      2,
      RenderCallback{});

  assert(rendered == 0);
  for (float sample : buffer) {
    assert(sample == 0.0f);
  }
}

#endif

}  // namespace

int main() {
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  testWasapiExclusiveRenderPacketDoesNotResizeScratch();
  testWasapiExclusiveDopDiagnosticsStayAllocationFreeInRenderPacket();
  testWasapiExclusiveDopBoundariesSubmitTypedCarrierWithoutSilentFlag();
  testWasapiExclusiveFloat32RenderPacketBypassesScratchPackCopy();
  testWasapiExclusiveRenderFailurePublishingStaysOffMmcssPath();
  testWasapiSharedRenderLoopUsesMmcss();
  testWasapiSharedRenderLoopUsesNonBlockingFailureTelemetry();
  testWasapiSharedRenderLoopDefersDeviceInvalidatedCallbackUntilAfterMmcss();
  testWasapiSharedStopDoesNotJoinCurrentRenderThread();
  testWasapiStartEntrypointsRejectAlreadyRunningBackend();
  testWasapiOpenFailurePathsClosePartiallyOpenedResources();
  testWasapiExclusiveRenderFailuresUseNonBlockingTelemetry();
  testWasapiExclusiveRenderLoopDoesNotWriteSharedTelemetryDirectly();
  testWasapiExclusiveRecoveryDoesNotWriteSharedTelemetryDirectly();
  testWasapiExclusiveRenderFailureQueuesRecoveryOffRenderThread();
  testWasapiExclusiveRecoveryStopsBeforeReopenOrNotifyAfterClose();
  testWasapiExclusiveOpenClearsDeferredRenderFailureState();
  testInt16PackerUsesSpecializedConversion();
  testPackedInt24PackerUsesSpecializedConversion();
  testInt32PackerUsesSpecializedConversion();
  testDsd64NegotiatesDopCarrier();
  testDsd128FailureReasonNamesDopCarrierFacts();
  testDsd256FailureReasonNamesDopCarrierFacts();
  testExclusiveBufferPolicyAvoidsMinimumPeriodForAuto();
  testExclusiveInitialRenderLeavesWakeupHeadroom();
  testExclusiveRenderFramePolicySeparatesEventAndPushMode();
  testExclusiveDeviceInUseIsRetryableStartupFailure();
  testFloatRenderHelperZerosOnlyUnrenderedTail();
  testFloatRenderHelperDoesNotPreclearFullRender();
  testFloatRenderHelperZerosAllWithoutCallback();
#endif
  return 0;
}
