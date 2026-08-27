#include "../output/asio/AsioBackend.h"
#include "../output/asio/MockAsioHost.h"
#include "../output/asio/AsioRenderUtils.h"
#include "../output/asio/abi/AsioAbi.h"

#include <algorithm>
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <chrono>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <regex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

using namespace twilight::audio;

namespace {

AudioFormat sourceFormat(
    int sampleRate = 88200,
    int bitDepth = 24,
    int channels = 2,
    AudioSampleFormat sampleFormat = AudioSampleFormat::Float32Interleaved) {
  AudioFormat format;
  format.sampleRate = sampleRate;
  format.channelCount = channels;
  format.bitDepth = bitDepth;
  format.sampleFormat = sampleFormat;
  return format;
}

std::unique_ptr<MockAsioHost> makeHost() {
  auto host = std::make_unique<MockAsioHost>();
  host->devices.push_back(makeMockAsioDevice("asio:mock", {44100, 48000, 96000}, 2));
  return host;
}

std::string readTextFile(const std::filesystem::path& path);

void testAsioBooleanSemantics() {
  assert(!asio_abi::asioBoolIsTrue(asio_abi::kAsioFalse));
  assert(asio_abi::asioBoolIsTrue(asio_abi::kAsioTrue));
  assert(asio_abi::asioBoolIsTrue(static_cast<asio_abi::AsioBool>(0x71C42890U)));
}

void testAsioErrorSuccessSemantics() {
  assert(asio_abi::asioErrorIsSuccess(asio_abi::kAsioOk));
  assert(asio_abi::asioErrorIsSuccess(asio_abi::kAsioSuccess));
  assert(!asio_abi::asioErrorIsSuccess(-995));
}

void testAsioDriverSessionUsesAsioErrorSuccessSemantics() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "asio" / "windows" / "AsioDriverSession.cpp";
  const std::string source = readTextFile(sourcePath);

  assert(source.find("asio_abi::asioErrorIsSuccess") != std::string::npos);
  assert(source.find("!= asio_abi::kAsioOk") == std::string::npos);
  assert(source.find("== asio_abi::kAsioOk") == std::string::npos);
}

void testAsioNativeDsdSampleRateSemantics() {
  const AudioFormat dsd64 = sourceFormat(2822400, 1, 2, AudioSampleFormat::DsdInt8Lsb1);
  assert(asio::driverSampleRate(dsd64) == 2822400);
  assert(asio::callbackFrameRate(dsd64) == 352800);

  const AudioFormat dsd512 = sourceFormat(22579200, 1, 2, AudioSampleFormat::DsdInt8Lsb1);
  assert(asio::driverSampleRate(dsd512) == 22579200);
  assert(asio::callbackFrameRate(dsd512) == 2822400);

  const AudioFormat pcm = sourceFormat(48000, 24, 2, AudioSampleFormat::Int24Interleaved);
  assert(asio::driverSampleRate(pcm) == 48000);
  assert(asio::callbackFrameRate(pcm) == 48000);
}

void testDsdCallbackUnitClassification() {
  using asio::DsdCallbackUnit;
  // Packed byte-frame cadence: the measured interval matches the prediction
  // this backend writes with (one frame = 8 DSD bits).
  assert(asio::classifyDsdCallbackUnit(10.0, 10.0) == DsdCallbackUnit::ByteFrames);
  assert(asio::classifyDsdCallbackUnit(10.0, 15.0) == DsdCallbackUnit::ByteFrames);
  assert(asio::classifyDsdCallbackUnit(10.0, 6.0) == DsdCallbackUnit::ByteFrames);
  // 1-bit sample cadence: a driver counting DSD buffers in 1-bit samples fires
  // callbacks ~8x faster than the byte-frame prediction.
  assert(asio::classifyDsdCallbackUnit(10.0, 1.25) == DsdCallbackUnit::BitSamples);
  assert(asio::classifyDsdCallbackUnit(10.0, 2.0) == DsdCallbackUnit::BitSamples);
  assert(asio::classifyDsdCallbackUnit(10.0, 0.8) == DsdCallbackUnit::BitSamples);
  // Intervals that fit neither interpretation stay Unknown instead of guessing.
  assert(asio::classifyDsdCallbackUnit(10.0, 3.0) == DsdCallbackUnit::Unknown);
  assert(asio::classifyDsdCallbackUnit(10.0, 40.0) == DsdCallbackUnit::Unknown);
  assert(asio::classifyDsdCallbackUnit(0.0, 10.0) == DsdCallbackUnit::Unknown);
  assert(asio::classifyDsdCallbackUnit(10.0, 0.0) == DsdCallbackUnit::Unknown);
}

int16_t readInt16(const std::vector<uint8_t>& bytes) {
  int16_t value = 0;
  std::memcpy(&value, bytes.data(), sizeof(value));
  return value;
}

int32_t readInt32(const std::vector<uint8_t>& bytes) {
  int32_t value = 0;
  std::memcpy(&value, bytes.data(), sizeof(value));
  return value;
}

int32_t readInt24In32(const std::vector<uint8_t>& bytes) {
  return readInt32(bytes) >> 8;
}

void writeInt16Bytes(uint8_t* output, int16_t value) {
  std::memcpy(output, &value, sizeof(value));
}

void writeInt32Bytes(uint8_t* output, int32_t value) {
  std::memcpy(output, &value, sizeof(value));
}

template <typename Predicate>
bool waitUntil(Predicate predicate, std::chrono::milliseconds timeout = std::chrono::milliseconds(8000)) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    if (predicate()) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return predicate();
}

std::string readTextFile(const std::filesystem::path& path) {
  std::ifstream in(path, std::ios::binary);
  std::ostringstream buffer;
  buffer << in.rdbuf();
  return buffer.str();
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

void testAsioDriverActivationRequestsDriverClsid() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "asio" / "windows" / "AsioDriverSession.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string activationBody = extractFunctionBody(source, "bool AsioDriverSession::open(");

  const std::regex activatesDriverClsid(
      R"(CoCreateInstance\s*\(\s*clsid\s*,\s*nullptr\s*,\s*CLSCTX_INPROC_SERVER\s*,\s*clsid\s*,)");
  const std::regex activatesUnknown(
      R"(CoCreateInstance\s*\(\s*clsid\s*,\s*nullptr\s*,\s*CLSCTX_INPROC_SERVER\s*,\s*IID_IUnknown\s*,)");

  assert(std::regex_search(activationBody, activatesDriverClsid));
  assert(!std::regex_search(activationBody, activatesUnknown));
}

void testAsioDriverSessionRequeriesBufferSizeAfterNativeDsdSwitch() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "asio" / "windows" / "AsioDriverSession.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string openBody = extractFunctionBody(source, "bool AsioDriverSession::open(");

  // A driver's valid buffer-size range can change once the DSD I/O format is
  // active, so the range must be re-read after the switch, on the Native DSD
  // path only, and the re-chosen size must become the session's buffer size.
  const size_t dsdRequestPos = openBody.find("nativeDsdRequested");
  const size_t dsdSwitchPos = openBody.find("configureNativeDsd");
  assert(dsdRequestPos != std::string::npos);
  assert(dsdSwitchPos != std::string::npos);
  assert(dsdRequestPos < dsdSwitchPos);
  const size_t requeryPos = openBody.find("getBufferSize", dsdSwitchPos);
  assert(requeryPos != std::string::npos);
  const size_t rechoosePos = openBody.find("chooseBufferSize", dsdSwitchPos);
  assert(rechoosePos != std::string::npos);
  assert(rechoosePos > requeryPos);
  const size_t applyPos = openBody.find("state->bufferSize = dsdBufferSize", dsdSwitchPos);
  assert(applyPos != std::string::npos);
  assert(applyPos > rechoosePos);
}

void testAsioDriverSessionHintsAtHeldDeviceWhenDsdSetIsRefused() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "asio" / "windows" / "AsioDriverSession.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string configureBody =
      extractFunctionBody(source, "bool configureNativeDsd(const AudioFormat& format, std::string* error)");

  // Can-do answering yes while both sets are refused is the field-verified
  // shape of a device held by another audio client, not of missing DSD
  // capability. The failure text must say so instead of implying the DAC
  // cannot do DSD.
  assert(configureBody.find("nativeDsdCanDoReported") != std::string::npos);
  assert(configureBody.find("another audio client") != std::string::npos);
}

void testAsioDriverSessionRetriesCreateBuffersAtPreferred() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "asio" / "windows" / "AsioDriverSession.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string createBody =
      extractFunctionBody(source, "bool AsioDriverSession::createBuffers(");

  // JUCE and PortAudio both retry createBuffers at the driver's preferred
  // size for drivers whose reported range is wrong (Hoontech DSP24 class).
  // The retry must re-read the range, only fire when preferred differs, and
  // stay a single bounded attempt.
  const size_t failPos = createBody.find("!asio_abi::asioErrorIsSuccess(createBuffersResult)");
  assert(failPos != std::string::npos);
  const size_t requeryPos = createBody.find("getBufferSize", failPos);
  assert(requeryPos != std::string::npos);
  const size_t preferredPos = createBody.find("chooseBufferSize(0", requeryPos);
  assert(preferredPos != std::string::npos);
  assert(createBody.find("preferredSize != state->bufferSize", preferredPos) != std::string::npos);
  assert(createBody.find("\"create-buffers-retry\"", preferredPos) != std::string::npos);
  // The retry must not bypass the callback router: still one uninstall path.
  size_t uninstallCount = 0;
  for (size_t pos = createBody.find("AsioCallbackRouter::uninstall"); pos != std::string::npos;
       pos = createBody.find("AsioCallbackRouter::uninstall", pos + 1)) {
    ++uninstallCount;
  }
  assert(uninstallCount == 1);
}

void testAsioDriverSessionRechecksChannelCountAfterRateSwitch() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "asio" / "windows" / "AsioDriverSession.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string openBody = extractFunctionBody(source, "bool AsioDriverSession::open(");

  // JUCE re-reads getChannels after the rate switch: a few drivers change the
  // count there, and createBuffers with a stale count fails obscurely. A
  // failed re-read must stay non-fatal (the original count stands).
  const size_t ratePos = openBody.find("after sample rate negotiation");
  assert(ratePos != std::string::npos);
  const size_t recheckPos = openBody.find("getChannels", ratePos);
  assert(recheckPos != std::string::npos);
  assert(openBody.find("postRateOutputs", recheckPos) != std::string::npos);
  const size_t guardPos = openBody.find("config.format.channelCount > postRateOutputs", recheckPos);
  assert(guardPos != std::string::npos);
  assert(openBody.find("changed after the rate switch", guardPos) != std::string::npos);
}

void testAsioDriverSessionProbesDoPCarriersInBothRateFamilies() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "asio" / "windows" / "AsioDriverSession.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string probeBody = extractFunctionBody(source, "bool AsioDriverSession::probe(");

  // dopCarrierFormatForDsd emits 48k-family carriers for 48k-family sources,
  // so the capability probe must intersect both families; probing only
  // 176400/352800/705600 understates devices that take 192k/384k/768k/1536k.
  for (int rate : {176400, 192000, 352800, 384000, 705600, 768000, 1411200, 1536000}) {
    assert(probeBody.find(std::to_string(rate)) != std::string::npos);
  }
}

void testAsioDriverSessionOnlySetsRateWhenDifferent() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "output" / "asio" / "windows" / "AsioDriverSession.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string openBody = extractFunctionBody(source, "bool AsioDriverSession::open(");

  // PortAudio/RtAudio guard the rate write behind a getSampleRate comparison:
  // a redundant setSampleRate disturbs some drivers and re-triggers
  // exclusive-format arbitration on multi-client devices.
  const size_t negotiatePos = openBody.find("before sample rate negotiation");
  assert(negotiatePos != std::string::npos);
  const size_t readPos = openBody.find("alreadyAtRate", negotiatePos);
  assert(readPos != std::string::npos);
  const size_t setPos = openBody.find("setSampleRate(requestedRate)", negotiatePos);
  assert(setPos != std::string::npos);
  assert(openBody.find("!alreadyAtRate", negotiatePos) != std::string::npos);
  assert(openBody.find("getSampleRate(&currentRate)", negotiatePos) != std::string::npos);
}

void testAsioRenderCallbackDoesNotResizeScratchBuffers() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "output" / "asio" / "AsioBackend.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderBody = extractFunctionBody(source, "void AsioBackend::renderBuffer(long bufferIndex)");

  assert(!renderBody.empty());
  assert(renderBody.find("renderScratch_") != std::string::npos);
  assert(renderBody.find("typedRenderScratch_") != std::string::npos);
  assert(renderBody.find("renderScratch_.resize") == std::string::npos);
  assert(renderBody.find("typedRenderScratch_.resize") == std::string::npos);
}

void testAsioRenderCallbackClassifiesDsdBufferUnit() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "output" / "asio" / "AsioBackend.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderBody = extractFunctionBody(source, "void AsioBackend::renderBuffer(long bufferIndex)");

  // The callback cadence is the only runtime evidence of whether the driver
  // counts DSD buffers in packed byte-frames or 1-bit samples; the render
  // callback must keep consulting the classifier and latching the mismatch.
  assert(!renderBody.empty());
  assert(renderBody.find("classifyDsdCallbackUnit") != std::string::npos);
  assert(renderBody.find("pendingDsdBufferUnitMismatch_") != std::string::npos);
}

void testAsioRenderCallbackDoesNotBlockOnBackendMutex() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "output" / "asio" / "AsioBackend.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderBody = extractFunctionBody(source, "void AsioBackend::renderBuffer(long bufferIndex)");

  assert(!renderBody.empty());
  assert(renderBody.find("mutex_") == std::string::npos);
  assert(renderBody.find("std::lock_guard") == std::string::npos);
  assert(renderBody.find("std::unique_lock") == std::string::npos);
  assert(renderBody.find("std::try_to_lock") == std::string::npos);
}

void testAsioRenderCallbackUsesImmutableSessionSnapshots() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "output" / "asio" / "AsioBackend.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderBody = extractFunctionBody(source, "void AsioBackend::renderBuffer(long bufferIndex)");

  assert(renderBody.find("renderCallbackSession_") != std::string::npos);
  assert(renderBody.find("typedCallbackSession_") != std::string::npos);
  assert(renderBody.find("renderOutputConfigSession_") != std::string::npos);
  assert(renderBody.find("renderOutputFormatSession_") != std::string::npos);
  assert(renderBody.find("renderChannelFormatsSession_") != std::string::npos);
  assert(renderBody.find("host_->outputChannelFormat") == std::string::npos);
  assert(renderBody.find("callback = callback_") == std::string::npos);
  assert(renderBody.find("typedCallback = typedCallback_") == std::string::npos);
}

void testAsioRenderCallbackDoesNotCopyStringDiagnostics() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "output" / "asio" / "AsioBackend.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string renderBody = extractFunctionBody(source, "void AsioBackend::renderBuffer(long bufferIndex)");

  assert(!renderBody.empty());
  assert(renderBody.find("lastError =") == std::string::npos);
  assert(renderBody.find("outputInfo_.diagnostics =") == std::string::npos);
}

void testAsioHostEventCallbackQueuesRecoveryOffDriverCallback() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "output" / "asio" / "AsioBackend.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string startHostBody = extractFunctionBody(source, "bool AsioBackend::createAndStartHost(std::string* error)");

  assert(startHostBody.find("queueRecoveryFromHostCallback") != std::string::npos);
  assert(startHostBody.find("{ recover(event, message); }") == std::string::npos);
  assert(startHostBody.find("std::this_thread::sleep_for") == std::string::npos);
}

void testAsioRecoveryQueueChecksStopRequestedWhileHoldingQueueLock() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "output" / "asio" / "AsioBackend.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string queueBody = extractFunctionBody(
      source,
      "void AsioBackend::queueRecoveryFromHostCallback(AsioHostEvent event, std::string message)");

  const size_t lockPos = queueBody.find("std::lock_guard lock(recoveryQueueMutex_)");
  const size_t stopCheckPos = queueBody.find("if (stopRequested_.load()) return;", lockPos);
  const size_t pushPos = queueBody.find("recoveryRequests_.push_back");

  assert(lockPos != std::string::npos);
  assert(stopCheckPos != std::string::npos);
  assert(pushPos != std::string::npos);
  assert(lockPos < stopCheckPos);
  assert(stopCheckPos < pushPos);
}

// Regression: a driver refusing the first ranked candidate must not become a
// hard "backend unavailable". Before candidate retry, open() asked the host
// exactly once and any refusal ended playback.
void testOpenRetriesRemainingCandidatesAfterDriverRefusal() {
  auto host = makeHost();
  auto* rawHost = host.get();
  // Refuse the first two candidates as format rejections; the third must still
  // be attempted.
  rawHost->openFailure = MockAsioHost::OpenFailure::FormatRefused;
  rawHost->failOpenCount = 2;
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:mock", sourceFormat(48000, 24), &error));
  assert(rawHost->openCalls == 3);
  assert(backend.outputInfo().actualBackend == "asio");
}

// Regression: when every candidate is refused the error must name the real
// driver refusal, not a generic engine failure.
void testOpenReportsDriverRefusalWhenAllCandidatesFail() {
  auto host = makeHost();
  auto* rawHost = host.get();
  rawHost->openFailure = MockAsioHost::OpenFailure::FormatRefused;
  rawHost->failOpenCount = 99;
  AsioBackend backend(std::move(host));
  std::string error;
  assert(!backend.open("asio:mock", sourceFormat(48000, 24), &error));
  assert(rawHost->openCalls > 1);
  assert(backend.outputInfo().perfectReasonCode == "backend_open_failure");
}

// A driver-wide fault rejects every format identically. Retrying would bury the
// real error behind the last candidate's message, so the sequence must stop at
// the first attempt.
void testOpenDoesNotRetryAfterDriverLevelFault() {
  auto host = makeHost();
  auto* rawHost = host.get();
  rawHost->failDriverInitCount = 1;
  AsioBackend backend(std::move(host));
  std::string error;
  assert(!backend.open("asio:mock", sourceFormat(48000, 24), &error));
  assert(rawHost->openCalls == 1);
  assert(error == "mock driver init failure");
}

// The ASIO registry reports identity only. A registry-only record must trigger
// a capability probe so format ranking sees what the driver really accepts.
void testOpenProbesRegistryOnlyDeviceRecord() {
  auto host = std::make_unique<MockAsioHost>();
  // Identity only, exactly what RealAsioHost::enumerateDevices can know.
  AsioDeviceInfo registryOnly;
  registryOnly.id = "asio:mock";
  registryOnly.name = "Mock ASIO";
  registryOnly.driverName = "Mock ASIO";
  host->devices.push_back(registryOnly);
  // What the probe contributes once it interrogates the driver.
  host->probeResults.push_back(makeMockAsioDevice("asio:mock", {44100, 48000, 96000}, 2));

  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:mock", sourceFormat(96000, 24), &error));
  assert(rawHost->probeCalls == 1);
  assert(rawHost->lastOpenConfig.format.sampleRate == 96000);
}

// A probe costs a driver open, so an already-populated capability record must
// not pay for one.
void testOpenSkipsProbeWhenCapabilitiesAlreadyKnown() {
  auto host = makeHost();
  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:mock", sourceFormat(48000, 24), &error));
  assert(rawHost->probeCalls == 0);
}

// A probe-hostile driver must still get an open attempt; the retry loop is what
// makes the legacy guess path survivable.
void testOpenStillAttemptsWhenProbeFails() {
  auto host = std::make_unique<MockAsioHost>();
  AsioDeviceInfo registryOnly;
  registryOnly.id = "asio:mock";
  registryOnly.name = "Mock ASIO";
  registryOnly.driverName = "Mock ASIO";
  host->devices.push_back(registryOnly);
  host->failProbeCount = 99;

  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:mock", sourceFormat(48000, 24), &error));
  assert(rawHost->probeCalls == 1);
  assert(rawHost->openCalls >= 1);
}

void testAsioEmptyCatalogReportsArchitectureMismatch() {
  class DiagnosticHost final : public IAsioHost {
   public:
    std::vector<AsioDeviceInfo> enumerateDevices() override { return {}; }
    AsioHostDiagnostics diagnostics() const override {
      AsioHostDiagnostics result;
      result.processArchitecture = "x64";
      result.buildEnabled = true;
      result.registeredDriverCount32 = 2;
      return result;
    }
    bool probeDevice(const std::string&, AsioDeviceInfo*, std::string* error) override {
      if (error) *error = "no ASIO driver to probe";
      return false;
    }
    bool open(const AsioOpenConfig&, AsioOpenResult*, std::string*) override { return false; }
    bool createBuffers(AsioBufferSwitchCallback, AsioEventCallback, std::string*) override { return false; }
    bool start(std::string*) override { return false; }
    void stop() override {}
    void close() override {}
    void* outputBuffer(long, long) override { return nullptr; }
    AudioSampleFormat outputSampleFormat(long) const override {
      return AudioSampleFormat::Float32Interleaved;
    }
    AsioChannelFormat outputChannelFormat(long) const override { return {}; }
    bool outputReady() override { return false; }
    long activeBufferSize() const override { return 0; }
  };

  AsioBackend backend(std::make_unique<DiagnosticHost>());
  std::string error;
  assert(!backend.open("auto", sourceFormat(48000, 32), &error));
  assert(error.find("32 位 ASIO 驱动") != std::string::npos);
  const OutputInfo info = backend.outputInfo();
  assert(info.diagnostics.processArchitecture == "x64");
  assert(info.diagnostics.asioBuildEnabled);
  assert(info.diagnostics.asioRegisteredDriverCount32 == 2);
  assert(info.diagnostics.asioRegisteredDriverCount64 == 0);
  assert(info.diagnostics.asioLoadableDriverCount64 == 0);
}

void testFormatNegotiation() {
  auto host = makeHost();
  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:mock", sourceFormat(), &error));
  assert(rawHost->lastOpenConfig.format.sampleRate == 96000);
  assert(rawHost->lastOpenConfig.format.bitDepth == 24);
  assert(backend.outputInfo().supportsOutputPerfect);
  assert(backend.outputInfo().actualBackend == "asio");
}

void testOpenFailureAndFallbackFormats() {
  {
    auto host = std::make_unique<MockAsioHost>();
    AsioBackend backend(std::move(host));
    std::string error;
    assert(!backend.open("auto", sourceFormat(48000, 24), &error));
    assert(!error.empty());
  }
  {
    auto host = makeHost();
    AsioBackend backend(std::move(host));
    std::string error;
    assert(!backend.open("asio:missing", sourceFormat(48000, 24), &error));
    assert(!error.empty());
  }
  {
    auto host = std::make_unique<MockAsioHost>();
    auto device = makeMockAsioDevice("asio:default-rate", {}, 2);
    device.supportedSampleRates.clear();
    device.defaultSampleRate = 192000;
    host->devices.push_back(device);
    auto* rawHost = host.get();
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:default-rate", sourceFormat(192000, 24), &error));
    assert(rawHost->lastOpenConfig.format.sampleRate == 192000);
  }
}

void testExtremeSampleRates() {
  const std::vector<int> rates = {8000, 44100, 48000, 96000, 192000, 384000, 768000};
  const auto probeRates = asioDefaultSampleRateProbeSet();
  for (int carrierRate : {705600, 768000, 1411200, 1536000}) {
    assert(std::find(probeRates.begin(), probeRates.end(), carrierRate) != probeRates.end());
  }
  auto host = std::make_unique<MockAsioHost>();
  host->devices.push_back(makeMockAsioDevice("asio:rates", rates, 2));
  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  std::string error;
  for (int rate : rates) {
    assert(backend.open("asio:rates", sourceFormat(rate, 24), &error));
    assert(rawHost->lastOpenConfig.format.sampleRate == rate);
  }
}

void testDopCarrierProfile() {
  MockAsioHost::DsdProfile profile;
  profile.dopCapable = true;
  profile.dopCarrierSampleRates = {176400, 352800};
  profile.dopCarrierSampleFormats = {
      AudioSampleFormat::Int24In32Interleaved,
      AudioSampleFormat::Int32Interleaved,
  };

  auto host = std::make_unique<MockAsioHost>();
  host->devices.push_back(makeMockAsioDevice("asio:dop", {44100, 48000}, 2, AudioSampleFormat::Float32Interleaved, profile));
  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:dop", sourceFormat(352800, 24, 2, AudioSampleFormat::Int24In32Interleaved), &error));
  assert(rawHost->lastOpenConfig.format.sampleRate == 352800);
  assert(rawHost->lastOpenConfig.format.sampleFormat == AudioSampleFormat::Int24In32Interleaved);

  const OutputInfo info = backend.outputInfo();
  assert(info.driverDopCapable);
  assert(!info.driverNativeDsdCapable);
  assert(info.driverDopCarrierSampleRates.size() == 2);
  assert(info.driverDopCarrierSampleRates[0] == 176400);
  assert(info.driverDopCarrierSampleRates[1] == 352800);
  assert(info.driverDopCarrierFormats.size() == 2);
  assert(info.driverDopCarrierFormats[0] == "int24-in32");
  assert(info.driverDopCarrierFormats[1] == "int32");
  assert(!info.outputPerfect);
  assert(!info.pcmPassthrough);

  const DopRuntimeFacts candidateFacts = backend.dopRuntimeFacts();
  assert(candidateFacts.state == DopRuntimeFactState::Candidate);
  assert(candidateFacts.explicitlyCapable);
  assert(candidateFacts.candidateFormat.sampleRate == 352800);
  assert(candidateFacts.candidateFormat.bitDepth == 24);
  assert(candidateFacts.candidateFormat.sampleFormat == AudioSampleFormat::Int24In32Interleaved);
  assert(!hasConcreteAudioFormat(candidateFacts.actualFormat));

  assert(backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
  const DopRuntimeFacts provenFacts = backend.dopRuntimeFacts();
  assert(provenFacts.state == DopRuntimeFactState::Proven);
  assert(provenFacts.explicitlyCapable);
  assert(pcmFormatsExactMatch(provenFacts.candidateFormat, provenFacts.actualFormat));
}

void testDopRuntimeFactsProvenWithoutExplicitCapability() {
  auto host = std::make_unique<MockAsioHost>();
  auto device = makeMockAsioDevice("asio:dop-unproven", {352800}, 2, AudioSampleFormat::Int24In32Interleaved);
  device.dopCapable = false;
  device.sampleFormats = {AudioSampleFormat::Int24In32Interleaved};
  device.bitDepths = {24};
  host->devices.push_back(device);
  auto* rawHost = host.get();
  rawHost->channelFormats = {
      AudioSampleFormat::Int24In32Interleaved,
      AudioSampleFormat::Int24In32Interleaved,
  };

  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:dop-unproven", sourceFormat(352800, 24, 2, AudioSampleFormat::Int24In32Interleaved), &error));
  assert(backend.dopRuntimeFacts().state == DopRuntimeFactState::Candidate);
  assert(!backend.dopRuntimeFacts().explicitlyCapable);

  assert(backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
  const DopRuntimeFacts facts = backend.dopRuntimeFacts();
  assert(facts.state == DopRuntimeFactState::Proven);
  assert(!facts.explicitlyCapable);
  assert(pcmFormatsExactMatch(facts.candidateFormat, facts.actualFormat));
}

void testDopCarrierUsesInt32AsioContainer() {
  auto host = std::make_unique<MockAsioHost>();
  auto device = makeMockAsioDevice("asio:dop-int32", {352800}, 2, AudioSampleFormat::Int32Interleaved);
  device.dopCapable = false;
  host->devices.push_back(device);
  auto* rawHost = host.get();
  rawHost->actualFormatOverride = sourceFormat(352800, 32, 2, AudioSampleFormat::Int32Interleaved);
  rawHost->channelFormats = {
      AudioSampleFormat::Int32Interleaved,
      AudioSampleFormat::Int32Interleaved,
  };

  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open(
      "asio:dop-int32",
      sourceFormat(352800, 24, 2, AudioSampleFormat::Int24Interleaved),
      &error));
  assert(backend.outputFormat().sampleFormat == AudioSampleFormat::Int24In32Interleaved);
  assert(backend.outputFormat().bitDepth == 24);
  assert(!backend.outputInfo().resampled);

  assert(backend.startTyped(
      [](PcmBlock& block) {
        assert(block.format.sampleFormat == AudioSampleFormat::Int24In32Interleaved);
        for (size_t frame = 0; frame < block.frames; ++frame) {
          const uint8_t marker = (frame & 1U) == 0U ? 0x05 : 0xfa;
          for (size_t channel = 0; channel < 2; ++channel) {
            const size_t offset = (frame * 2 + channel) * 4;
            block.data[offset + 0] = 0x00;
            block.data[offset + 1] = 0x11;
            block.data[offset + 2] = 0x22;
            block.data[offset + 3] = marker;
          }
        }
        return block.frames;
      },
      [](float*, size_t frames) { return frames; },
      nullptr,
      &error));

  const DopRuntimeFacts facts = backend.dopRuntimeFacts();
  assert(facts.state == DopRuntimeFactState::Proven);
  assert(!facts.explicitlyCapable);
  assert(facts.actualFormat.sampleFormat == AudioSampleFormat::Int24In32Interleaved);
  assert(!backend.outputInfo().resampled);

  rawHost->triggerBufferSwitch(0);
  const auto& firstChannel = rawHost->channelBuffers[0].buffers[0];
  assert(firstChannel.size() >= 4);
  assert(firstChannel[0] == 0x00);
  assert(firstChannel[1] == 0x11);
  assert(firstChannel[2] == 0x22);
  assert(firstChannel[3] == 0x05);
  assert(backend.outputInfo().diagnostics.dopRuntimeEvidence.find("confirmed") != std::string::npos);
}

void testDopRuntimeFactsMismatchWhenActualFormatDiffers() {
  MockAsioHost::DsdProfile profile;
  profile.dopCapable = true;
  profile.dopCarrierSampleRates = {176400};
  profile.dopCarrierSampleFormats = {AudioSampleFormat::Int24In32Interleaved};

  auto host = std::make_unique<MockAsioHost>();
  auto device = makeMockAsioDevice("asio:dop-mismatch", {176400}, 2, AudioSampleFormat::Int24In32Interleaved, profile);
  device.sampleFormats = {
      AudioSampleFormat::Int24In32Interleaved,
      AudioSampleFormat::Float32Interleaved,
  };
  host->devices.push_back(device);
  auto* rawHost = host.get();
  rawHost->channelFormats = {
      AudioSampleFormat::Float32Interleaved,
      AudioSampleFormat::Float32Interleaved,
  };

  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:dop-mismatch", sourceFormat(176400, 24, 2, AudioSampleFormat::Int24In32Interleaved), &error));
  assert(backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));

  const DopRuntimeFacts facts = backend.dopRuntimeFacts();
  assert(facts.state == DopRuntimeFactState::Mismatch);
  assert(facts.explicitlyCapable);
  assert(!hasConcreteAudioFormat(facts.actualFormat));
  assert(facts.reason.find("not a DoP carrier") != std::string::npos);
}

void testDopMarkerEvidence() {
  auto run = [](bool validMarkers) {
    auto host = std::make_unique<MockAsioHost>();
    auto device = makeMockAsioDevice("asio:dop-marker", {176400}, 2, AudioSampleFormat::Int24In32Interleaved);
    device.dopCapable = false;
    device.sampleFormats = {AudioSampleFormat::Int24In32Interleaved};
    device.bitDepths = {24};
    device.preferredBufferSize = 4;
    device.minBufferSize = 4;
    device.maxBufferSize = 4;
    host->devices.push_back(device);
    auto* rawHost = host.get();
    rawHost->channelFormats = {
        AudioSampleFormat::Int24In32Interleaved,
        AudioSampleFormat::Int24In32Interleaved};

    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:dop-marker", sourceFormat(176400, 24, 2, AudioSampleFormat::Int24In32Interleaved), &error));
    assert(backend.startTyped(
        [validMarkers](PcmBlock& block) {
          for (size_t frame = 0; frame < block.frames; ++frame) {
            const uint8_t marker = validMarkers ? ((frame & 1U) == 0U ? 0x05 : 0xfa) : 0x05;
            for (size_t channel = 0; channel < 2; ++channel) {
              block.data[(frame * 2 + channel) * 4 + 3] = marker;
            }
          }
          return block.frames;
        },
        [](float*, size_t frames) { return frames; },
        nullptr,
        &error));
    rawHost->triggerBufferSwitch(0);
    return backend.outputInfo();
  };

  const OutputInfo confirmed = run(true);
  assert(confirmed.diagnostics.dopRuntimeEvidence.find("confirmed") != std::string::npos);
  const OutputInfo rejected = run(false);
  assert(rejected.diagnostics.dopRuntimeEvidence.find("invalid") != std::string::npos);
  assert(!rejected.diagnostics.processingBypassed);
}

void testDopMarkerMismatchDemotesRuntimeFacts() {
  auto run = [](bool validMarkers) {
    auto host = std::make_unique<MockAsioHost>();
    auto device = makeMockAsioDevice("asio:dop-demote", {176400}, 2, AudioSampleFormat::Int24In32Interleaved);
    device.dopCapable = false;
    device.sampleFormats = {AudioSampleFormat::Int24In32Interleaved};
    device.bitDepths = {24};
    device.preferredBufferSize = 4;
    device.minBufferSize = 4;
    device.maxBufferSize = 4;
    host->devices.push_back(device);
    auto* rawHost = host.get();
    rawHost->channelFormats = {
        AudioSampleFormat::Int24In32Interleaved,
        AudioSampleFormat::Int24In32Interleaved};

    auto backend = std::make_unique<AsioBackend>(std::move(host));
    std::string error;
    assert(backend->open("asio:dop-demote", sourceFormat(176400, 24, 2, AudioSampleFormat::Int24In32Interleaved), &error));
    assert(backend->startTyped(
        [validMarkers](PcmBlock& block) {
          for (size_t frame = 0; frame < block.frames; ++frame) {
            const uint8_t marker = validMarkers ? ((frame & 1U) == 0U ? 0x05 : 0xfa) : 0x05;
            for (size_t channel = 0; channel < 2; ++channel) {
              block.data[(frame * 2 + channel) * 4 + 3] = marker;
            }
          }
          return block.frames;
        },
        [](float*, size_t frames) { return frames; },
        nullptr,
        &error));
    assert(backend->dopRuntimeFacts().state == DopRuntimeFactState::Proven);
    rawHost->triggerBufferSwitch(0);
    return backend;
  };

  const auto confirmed = run(true);
  assert(confirmed->dopRuntimeFacts().state == DopRuntimeFactState::Proven);
  const auto rejected = run(false);
  const DopRuntimeFacts rejectedFacts = rejected->dopRuntimeFacts();
  assert(rejectedFacts.state == DopRuntimeFactState::Mismatch);
  assert(rejectedFacts.reason.find("marker") != std::string::npos);
}

void testNativeDsdCapabilityProfile() {

  {
    auto host = makeHost();
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:mock", sourceFormat(96000, 32), &error));
    const OutputInfo info = backend.outputInfo();
    assert(!info.driverDopCapable);
    assert(!info.driverNativeDsdCapable);
    assert(info.driverDopCarrierSampleRates.empty());
    assert(info.driverDopCarrierFormats.empty());
    assert(info.driverNativeDsdSampleRates.empty());
  }
  {
    MockAsioHost::DsdProfile profile;
    profile.nativeDsdCapable = true;
    profile.nativeDsdSampleRates = {2822400, 5644800};
    auto host = std::make_unique<MockAsioHost>();
    host->devices.push_back(makeMockAsioDevice("asio:native-dsd", {48000}, 2, AudioSampleFormat::Float32Interleaved, profile));
    auto* rawHost = host.get();
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:native-dsd", sourceFormat(48000, 32), &error));
    assert(rawHost->lastOpenConfig.format.sampleRate == 48000);

    const OutputInfo info = backend.outputInfo();
    assert(!info.driverDopCapable);
    assert(info.driverNativeDsdCapable);
    assert(info.driverNativeDsdSampleRates.size() == 2);
    assert(info.driverNativeDsdSampleRates[0] == 2822400);
    assert(info.driverNativeDsdSampleRates[1] == 5644800);
    assert(!info.outputPerfect);
    assert(!info.pcmPassthrough);
  }
}

void testFiiODriverNameDoesNotRewriteStandardNativeDsdRequest() {
  MockAsioHost::DsdProfile profile;
  profile.nativeDsdCapable = true;
  profile.nativeDsdSampleRates = {11289600};
  profile.nativeDsdSampleFormats = {AudioSampleFormat::DsdInt8Lsb1};
  auto host = std::make_unique<MockAsioHost>();
  auto device = makeMockAsioDevice(
      "asio:fiio",
      {48000},
      2,
      AudioSampleFormat::Int32Interleaved,
      profile);
  device.name = "FiiO ASIO Driver";
  device.driverName = "FiiO ASIO Driver";
  host->devices.push_back(device);
  auto* rawHost = host.get();
  rawHost->channelFormats = {
      AudioSampleFormat::DsdInt8Lsb1,
      AudioSampleFormat::DsdInt8Lsb1,
  };

  AsioBackend backend(std::move(host));
  std::string error;
  const AudioFormat request = sourceFormat(11289600, 1, 2, AudioSampleFormat::DsdInt8Lsb1);
  assert(backend.open("asio:fiio", request, &error));
  assert(rawHost->lastOpenConfig.format.sampleRate == 11289600);
  assert(rawHost->lastOpenConfig.format.sampleFormat == AudioSampleFormat::DsdInt8Lsb1);
  assert(asio::driverSampleRate(rawHost->lastOpenConfig.format) == 11289600);
  assert(asio::callbackFrameRate(rawHost->lastOpenConfig.format) == 1411200);
  assert(backend.startTyped(
      [](PcmBlock& block) {
        assert(block.format.sampleFormat == AudioSampleFormat::DsdInt8Lsb1);
        std::memset(block.data, 0x69, block.byteSize);
        return block.frames;
      },
      [](float*, size_t frames) { return frames; },
      nullptr,
      &error));
  assert(backend.nativeDsdRuntimeFacts().state == NativeDsdRuntimeFactState::Proven);
}
void testNativeDsdRuntimeProven() {
  MockAsioHost::DsdProfile profile;
  profile.nativeDsdCapable = true;
  profile.nativeDsdSampleRates = {2822400, 5644800, 11289600, 22579200};
  profile.nativeDsdSampleFormats = {
      AudioSampleFormat::DsdInt8Lsb1,
      AudioSampleFormat::DsdInt8Msb1,
      AudioSampleFormat::DsdInt8Ner8,
  };
  auto host = std::make_unique<MockAsioHost>();
  host->devices.push_back(makeMockAsioDevice("asio:native-proven", {48000}, 2, AudioSampleFormat::Float32Interleaved, profile));
  auto* rawHost = host.get();
  rawHost->channelFormats = {AudioSampleFormat::DsdInt8Lsb1, AudioSampleFormat::DsdInt8Lsb1};

  AsioBackend backend(std::move(host));
  std::string error;
  const AudioFormat request = sourceFormat(2822400, 1, 2, AudioSampleFormat::DsdInt8Lsb1);
  assert(backend.open("asio:native-proven", request, &error));
  assert(rawHost->lastOpenConfig.format.sampleRate == 2822400);
  assert(rawHost->lastOpenConfig.format.bitDepth == 1);
  assert(rawHost->lastOpenConfig.format.sampleFormat == AudioSampleFormat::DsdInt8Lsb1);
  assert(backend.nativeDsdRuntimeFacts().state == NativeDsdRuntimeFactState::Candidate);

  bool typedCalled = false;
  bool fallbackCalled = false;
  assert(backend.startTyped(
      [&](PcmBlock& block) {
        typedCalled = true;
        assert(block.format.sampleFormat == AudioSampleFormat::DsdInt8Lsb1);
        assert(block.format.sampleRate == 2822400);
        for (size_t frame = 0; frame < block.frames; ++frame) {
          block.data[frame * 2] = 0xaa;
          block.data[frame * 2 + 1] = 0x55;
        }
        return block.frames;
      },
      [&](float*, size_t frames) {
        fallbackCalled = true;
        return frames;
      },
      nullptr,
      &error));
  rawHost->triggerBufferSwitch(0);
  assert(typedCalled);
  assert(!fallbackCalled);
  assert(rawHost->channelBuffers[0].buffers[0][0] == 0xaa);
  assert(rawHost->channelBuffers[1].buffers[0][0] == 0x55);

  const NativeDsdRuntimeFacts facts = backend.nativeDsdRuntimeFacts();
  assert(facts.state == NativeDsdRuntimeFactState::Proven);
  assert(facts.requestedDsdRate == 2822400);
  assert(facts.actualDsdRate == 2822400);
  assert(facts.channelCount == 2);
  assert(facts.explicitlyCapable);
  const OutputInfo info = backend.outputInfo();
  assert(info.nativeDsdRuntimeState == "proven");
  assert(info.nativeDsdActualRate == 2822400);
  assert(!info.resampled);
}

void testNativeDsdDriverSelectedWireTypeAndIdleTail() {
  struct Case {
    AudioSampleFormat wireFormat;
    uint8_t expectedIdle;
  };
  const Case cases[] = {
      {AudioSampleFormat::DsdInt8Lsb1, 0x69},
      {AudioSampleFormat::DsdInt8Msb1, 0x96},
      {AudioSampleFormat::DsdInt8Ner8, 0x69},
  };

  for (const auto& item : cases) {
    MockAsioHost::DsdProfile profile;
    profile.nativeDsdCapable = true;
    profile.nativeDsdSampleRates = {2822400};
    profile.nativeDsdSampleFormats = {
        AudioSampleFormat::DsdInt8Lsb1,
        AudioSampleFormat::DsdInt8Msb1,
        AudioSampleFormat::DsdInt8Ner8,
    };
    auto host = std::make_unique<MockAsioHost>();
    auto device = makeMockAsioDevice(
        "asio:native-wire-type",
        {48000},
        2,
        AudioSampleFormat::Float32Interleaved,
        profile);
    device.preferredBufferSize = 4;
    device.minBufferSize = 4;
    device.maxBufferSize = 4;
    host->devices.push_back(device);
    auto* rawHost = host.get();
    rawHost->channelFormats = {item.wireFormat, item.wireFormat};

    AsioBackend backend(std::move(host));
    std::string error;
    const AudioFormat request = sourceFormat(
        2822400,
        1,
        2,
        AudioSampleFormat::DsdInt8Lsb1);
    assert(backend.open("asio:native-wire-type", request, &error));
    assert(backend.startTyped(
        [&](PcmBlock& block) {
          assert(block.format.sampleFormat == item.wireFormat);
          assert(block.frames == 4);
          block.data[0] = 0xa1;
          block.data[1] = 0xb1;
          block.data[2] = 0xa2;
          block.data[3] = 0xb2;
          return 2;
        },
        [](float*, size_t frames) { return frames; },
        nullptr,
        &error));

    rawHost->triggerBufferSwitch(0);
    assert(rawHost->channelBuffers[0].buffers[0][0] == 0xa1);
    assert(rawHost->channelBuffers[1].buffers[0][0] == 0xb1);
    assert(rawHost->channelBuffers[0].buffers[0][1] == 0xa2);
    assert(rawHost->channelBuffers[1].buffers[0][1] == 0xb2);
    for (size_t frame = 2; frame < 4; ++frame) {
      assert(rawHost->channelBuffers[0].buffers[0][frame] == item.expectedIdle);
      assert(rawHost->channelBuffers[1].buffers[0][frame] == item.expectedIdle);
    }

    const NativeDsdRuntimeFacts facts = backend.nativeDsdRuntimeFacts();
    assert(facts.state == NativeDsdRuntimeFactState::Proven);
    assert(facts.actualDsdRate == 2822400);
    const OutputInfo info = backend.outputInfo();
    assert(!info.resampled);
    assert(info.diagnostics.dsdShortReadCount == 1);
    assert(info.diagnostics.dsdIdleFrameCount == 2);
    assert(info.diagnostics.actualWireFormat == sampleFormatToString(item.wireFormat));
    assert(info.diagnostics.firstBufferSummary.find("native-dsd bytes=4") != std::string::npos);
    assert(
        info.diagnostics.firstBufferSummary.find(
            item.expectedIdle == 0x96 ? "idle=0x96" : "idle=0x69") != std::string::npos);
  }
}

void testNativeDsdRuntimeDiscoveryWithoutCatalogCapability() {
  auto host = std::make_unique<MockAsioHost>();
  auto device = makeMockAsioDevice("asio:native-runtime-probe", {48000}, 2);
  device.outputChannels = 0;
  host->devices.push_back(device);
  auto* rawHost = host.get();
  rawHost->channelFormats = {AudioSampleFormat::DsdInt8Lsb1, AudioSampleFormat::DsdInt8Lsb1};

  AsioBackend backend(std::move(host));
  std::string error;
  const AudioFormat request = sourceFormat(2822400, 1, 2, AudioSampleFormat::DsdInt8Lsb1);
  assert(backend.open("asio:native-runtime-probe", request, &error));
  assert(rawHost->lastOpenConfig.format.sampleRate == request.sampleRate);
  assert(rawHost->lastOpenConfig.format.channelCount == request.channelCount);
  assert(rawHost->lastOpenConfig.format.bitDepth == request.bitDepth);
  assert(rawHost->lastOpenConfig.format.sampleFormat == request.sampleFormat);
  assert(backend.startTyped(
      [](PcmBlock& block) {
        std::memset(block.data, 0x69, block.byteSize);
        return block.frames;
      },
      [](float*, size_t frames) { return frames; },
      nullptr,
      &error));
  rawHost->triggerBufferSwitch(0);

  const NativeDsdRuntimeFacts facts = backend.nativeDsdRuntimeFacts();
  assert(facts.state == NativeDsdRuntimeFactState::Proven);
  assert(facts.explicitlyCapable);
  assert(facts.actualDsdRate == 2822400);
  const OutputInfo info = backend.outputInfo();
  assert(info.driverNativeDsdCapable);
  assert(info.actualChannels == 2);
}

void testNativeDsdUnderrunWarmupCallbacks() {
  MockAsioHost::DsdProfile profile;
  profile.nativeDsdCapable = true;
  profile.nativeDsdSampleRates = {2822400};
  profile.nativeDsdSampleFormats = {AudioSampleFormat::DsdInt8Lsb1};
  auto host = std::make_unique<MockAsioHost>();
  auto device = makeMockAsioDevice("asio:native-warmup", {48000}, 2, AudioSampleFormat::Float32Interleaved, profile);
  device.preferredBufferSize = 4;
  device.minBufferSize = 4;
  device.maxBufferSize = 4;
  host->devices.push_back(device);
  auto* rawHost = host.get();
  rawHost->channelFormats = {AudioSampleFormat::DsdInt8Lsb1, AudioSampleFormat::DsdInt8Lsb1};

  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:native-warmup", sourceFormat(2822400, 1, 2, AudioSampleFormat::DsdInt8Lsb1), &error));
  assert(backend.startTyped(
      [](PcmBlock& block) {
        std::memset(block.data, 0x69, block.byteSize);
        return block.frames;
      },
      [](float*, size_t frames) { return frames; },
      nullptr,
      &error));

  rawHost->triggerBufferSwitch(0);
  std::this_thread::sleep_for(std::chrono::milliseconds(3));
  rawHost->triggerBufferSwitch(1);
  assert(backend.outputInfo().diagnostics.sessionUnderrunCount == 0);

  std::this_thread::sleep_for(std::chrono::milliseconds(3));
  rawHost->triggerBufferSwitch(0);
  assert(backend.outputInfo().diagnostics.sessionUnderrunCount >= 1);
}

// A rate the driver genuinely refuses must still fail the open — but the
// refusal has to come from the driver, not from the backend pre-filtering on a
// cached capability list.
void testNativeDsdRejectsUnsupportedRate() {
  MockAsioHost::DsdProfile profile;
  profile.nativeDsdCapable = true;
  profile.nativeDsdSampleRates = {2822400};
  profile.nativeDsdSampleFormats = {AudioSampleFormat::DsdInt8Lsb1};
  auto host = std::make_unique<MockAsioHost>();
  host->devices.push_back(makeMockAsioDevice("asio:native-rate", {48000}, 2, AudioSampleFormat::Float32Interleaved, profile));
  auto* rawHost = host.get();

  AsioBackend backend(std::move(host));
  std::string error;
  assert(!backend.open("asio:native-rate", sourceFormat(5644800, 1, 2, AudioSampleFormat::DsdInt8Lsb1), &error));
  assert(!error.empty());
  // The attempt must reach the driver. Skipping it is what silently downgraded
  // DSD to PCM on drivers whose probe under-reported their DSD rates.
  assert(rawHost->openCalls > 0);
  assert(backend.outputInfo().perfectReasonCode == "backend_open_failure");
}

// Regression: DSD256 on a driver whose probed DSD rate list omits that rate.
//
// Real DSD drivers routinely answer CanSampleRate inconsistently outside an
// active DSD I/O format, so the probe can mark a device DSD-capable while
// listing only a subset of its rates. Pre-filtering on that list reported "no
// negotiable format", which the pipeline read as "cannot do DSD" and answered by
// resampling to PCM — the driver was never even asked.
void testNativeDsdAttemptsRateMissingFromProbedCapabilities() {
  MockAsioHost::DsdProfile profile;
  profile.nativeDsdCapable = true;
  // Probe saw DSD64 only; the hardware also does DSD256.
  profile.nativeDsdSampleRates = {2822400};
  profile.nativeDsdSampleFormats = {AudioSampleFormat::DsdInt8Lsb1};
  auto host = std::make_unique<MockAsioHost>();
  auto device = makeMockAsioDevice(
      "asio:dsd256",
      {44100, 48000, 96000, 192000, 384000},
      2,
      AudioSampleFormat::Int32Interleaved,
      profile);
  host->devices.push_back(device);
  auto* rawHost = host.get();
  // The driver really does accept DSD256, so it must not refuse the attempt.
  rawHost->enforceDeclaredNativeDsdRates = false;
  rawHost->channelFormats = {AudioSampleFormat::DsdInt8Lsb1, AudioSampleFormat::DsdInt8Lsb1};

  AsioBackend backend(std::move(host));
  std::string error;
  const AudioFormat request = sourceFormat(11289600, 1, 2, AudioSampleFormat::DsdInt8Lsb1);
  assert(backend.open("asio:dsd256", request, &error));
  // Verbatim DSD256, not a PCM rate from the device's PCM capability list.
  assert(rawHost->lastOpenConfig.format.sampleRate == 11289600);
  assert(rawHost->lastOpenConfig.format.sampleFormat == AudioSampleFormat::DsdInt8Lsb1);
  assert(isDsdSampleFormat(backend.outputFormat().sampleFormat));
  assert(backend.outputFormat().sampleRate == 11289600);
}

// The probed PCM container width must not gate DSD candidates. A probe records
// the one PCM type it saw on channel 0 (commonly Int32 => 32), while DSD
// normalizes to a 1-bit depth, so a shared whitelist discards every DSD
// candidate for a rate the device does advertise.
void testNativeDsdCandidateSurvivesProbedPcmBitDepth() {
  MockAsioHost::DsdProfile profile;
  profile.nativeDsdCapable = true;
  profile.nativeDsdSampleRates = {2822400, 5644800, 11289600};
  profile.nativeDsdSampleFormats = {AudioSampleFormat::DsdInt8Lsb1};
  auto host = std::make_unique<MockAsioHost>();
  auto device = makeMockAsioDevice(
      "asio:pcm-depth",
      {44100, 48000, 192000},
      2,
      AudioSampleFormat::Int32Interleaved,
      profile);
  // Exactly what a probe contributes: one observed PCM container width.
  device.bitDepths = {32};
  device.defaultBitDepth = 32;
  host->devices.push_back(device);
  auto* rawHost = host.get();
  rawHost->channelFormats = {AudioSampleFormat::DsdInt8Lsb1, AudioSampleFormat::DsdInt8Lsb1};

  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:pcm-depth", sourceFormat(11289600, 1, 2, AudioSampleFormat::DsdInt8Lsb1), &error));
  assert(rawHost->lastOpenConfig.format.sampleRate == 11289600);
  assert(isDsdSampleFormat(rawHost->lastOpenConfig.format.sampleFormat));
}

// The PCM probe set tops out in the low megahertz for DoP carriers, so it can
// never answer whether DSD64..DSD512 are available. DSD capability needs its own
// rate list, in both the 44.1k and 48k families.
void testDsdSemanticRateProbeSetCoversDsd64Through512() {
  const auto dsdRates = asioDsdSemanticRateProbeSet();
  for (int rate : {2822400, 5644800, 11289600, 22579200}) {
    assert(std::find(dsdRates.begin(), dsdRates.end(), rate) != dsdRates.end());
  }
  for (int rate : {3072000, 6144000, 12288000, 24576000}) {
    assert(std::find(dsdRates.begin(), dsdRates.end(), rate) != dsdRates.end());
  }
  assert(std::is_sorted(dsdRates.begin(), dsdRates.end()));

  // Keep the two sets disjoint: a PCM stream must never negotiate a DSD
  // semantic rate, and a DSD probe must not waste calls on PCM rates.
  const auto pcmRates = asioDefaultSampleRateProbeSet();
  for (int rate : dsdRates) {
    assert(std::find(pcmRates.begin(), pcmRates.end(), rate) == pcmRates.end());
  }
}

void testNativeDsdRuntimeSampleTypeMismatch() {
  MockAsioHost::DsdProfile profile;
  profile.nativeDsdCapable = true;
  profile.nativeDsdSampleRates = {2822400};
  profile.nativeDsdSampleFormats = {AudioSampleFormat::DsdInt8Lsb1};
  auto host = std::make_unique<MockAsioHost>();
  host->devices.push_back(makeMockAsioDevice("asio:native-mismatch", {48000}, 2, AudioSampleFormat::Float32Interleaved, profile));
  auto* rawHost = host.get();
  rawHost->channelFormats = {AudioSampleFormat::Float32Interleaved, AudioSampleFormat::Float32Interleaved};

  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:native-mismatch", sourceFormat(2822400, 1, 2, AudioSampleFormat::DsdInt8Lsb1), &error));
  assert(backend.startTyped(
      [](PcmBlock& block) { return block.frames; },
      [](float*, size_t frames) { return frames; },
      nullptr,
      &error));
  const NativeDsdRuntimeFacts facts = backend.nativeDsdRuntimeFacts();
  assert(facts.state == NativeDsdRuntimeFactState::Mismatch);
  assert(facts.reason.find("not Native DSD") != std::string::npos);
  assert(backend.outputInfo().perfectReasonCode == "native_dsd_runtime_unproven");
}

void testNativeDsdRuntimeChannelFormatMismatch() {
  MockAsioHost::DsdProfile profile;
  profile.nativeDsdCapable = true;
  profile.nativeDsdSampleRates = {2822400};
  profile.nativeDsdSampleFormats = {AudioSampleFormat::DsdInt8Lsb1, AudioSampleFormat::DsdInt8Msb1};
  auto host = std::make_unique<MockAsioHost>();
  host->devices.push_back(makeMockAsioDevice("asio:native-channel-mismatch", {48000}, 2, AudioSampleFormat::Float32Interleaved, profile));
  auto* rawHost = host.get();
  rawHost->channelFormats = {AudioSampleFormat::DsdInt8Lsb1, AudioSampleFormat::DsdInt8Msb1};

  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:native-channel-mismatch", sourceFormat(2822400, 1, 2, AudioSampleFormat::DsdInt8Lsb1), &error));
  assert(backend.startTyped(
      [](PcmBlock& block) { return block.frames; },
      [](float*, size_t frames) { return frames; },
      nullptr,
      &error));
  const NativeDsdRuntimeFacts facts = backend.nativeDsdRuntimeFacts();
  assert(facts.state == NativeDsdRuntimeFactState::Mismatch);
  assert(facts.reason.find("channel sample formats differ") != std::string::npos);
}

void testChannelCounts() {
  for (int channels : {1, 2, 6, 8}) {
    auto host = std::make_unique<MockAsioHost>();
    host->devices.push_back(makeMockAsioDevice("asio:channels", {48000}, 8));
    auto* rawHost = host.get();
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:channels", sourceFormat(48000, 32, channels), &error));
    assert(rawHost->lastOpenConfig.format.channelCount == channels);
    assert(backend.outputInfo().actualChannels == channels);
  }
  {
    auto host = std::make_unique<MockAsioHost>();
    host->devices.push_back(makeMockAsioDevice("asio:limited", {48000}, 2));
    auto* rawHost = host.get();
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:limited", sourceFormat(48000, 32, 8), &error));
    assert(rawHost->lastOpenConfig.format.channelCount == 2);
    assert(backend.outputInfo().actualChannels == 2);
  }
}

void testLifecycleAndPlaybackInfo() {
  auto host = makeHost();
  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:mock", sourceFormat(96000, 32), &error));
  assert(backend.start([](float* output, size_t frames) {
    for (size_t i = 0; i < frames * 2; ++i) output[i] = 0.25f;
    return frames;
  }, nullptr, &error));
  rawHost->triggerBufferSwitch(0);
  assert(rawHost->startCalls == 1);
  assert(rawHost->outputReadyCalls == 1);
  const OutputInfo info = backend.outputInfo();
  assert(info.driverName == "Mock ASIO");
  assert(info.driverVersion == 1);
  assert(info.bufferSizeFrames == 4);
  assert(info.latencyFrames == 8);
  assert(info.actualChannels == 2);
  backend.stop();
  assert(rawHost->stopCalls >= 1);
}

void testCloseOpenRestartUsesFreshSessionSnapshot() {
  auto host = makeHost();
  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  std::string error;

  assert(backend.open("asio:mock", sourceFormat(48000, 32), &error));
  assert(backend.start([](float* output, size_t frames) {
    std::fill(output, output + frames * 2, 0.25f);
    return frames;
  }, nullptr, &error));
  rawHost->triggerBufferSwitch(0);
  float first = 0.0f;
  std::memcpy(&first, rawHost->channelBuffers[0].buffers[0].data(), sizeof(first));
  assert(first == 0.25f);

  backend.close();
  assert(backend.open("asio:mock", sourceFormat(48000, 32), &error));
  assert(backend.start([](float* output, size_t frames) {
    std::fill(output, output + frames * 2, -0.5f);
    return frames;
  }, nullptr, &error));
  rawHost->triggerBufferSwitch(1);
  float second = 0.0f;
  std::memcpy(&second, rawHost->channelBuffers[0].buffers[1].data(), sizeof(second));
  assert(second == -0.5f);
  assert(rawHost->openCalls == 2);
  assert(rawHost->createBuffersCalls == 2);
  assert(rawHost->startCalls == 2);
}

void testActualOutputFormats() {
  struct Case {
    AudioSampleFormat sampleFormat;
    int bitDepth;
    const char* name;
  };
  const Case cases[] = {
      {AudioSampleFormat::Int16Interleaved, 16, "int16"},
      {AudioSampleFormat::Int24Interleaved, 24, "int24"},
      {AudioSampleFormat::Int24In32Interleaved, 24, "int24-in32"},
      {AudioSampleFormat::Int32Interleaved, 32, "int32"},
      {AudioSampleFormat::Float32Interleaved, 32, "float32"},
  };

  for (const auto& item : cases) {
    auto host = std::make_unique<MockAsioHost>();
    auto device = makeMockAsioDevice("asio:format", {48000}, 2, item.sampleFormat);
    device.sampleFormats = {item.sampleFormat};
    device.bitDepths = {item.bitDepth};
    host->devices.push_back(device);
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:format", sourceFormat(48000, item.bitDepth, 2, item.sampleFormat), &error));
    const OutputInfo info = backend.outputInfo();
    assert(info.actualOutputFormat == item.name);
    assert(info.actualBitDepth == item.bitDepth);
    assert(!info.outputPerfect);
    assert(!info.pcmPassthrough);
  }
}

void testRejectsUnsupportedChannelDescriptor() {
  auto host = makeHost();
  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:mock", sourceFormat(48000, 32), &error));

  AsioChannelFormat bigEndian;
  bigEndian.logicalFormat = AudioSampleFormat::Int32Interleaved;
  bigEndian.containerBits = 32;
  bigEndian.validBits = 32;
  bigEndian.littleEndian = false;
  rawHost->channelDescriptors = {bigEndian, bigEndian};

  assert(!backend.start([](float*, size_t) { return 0; }, nullptr, &error));
  assert(error == "unsupported_asio_sample_type");
  assert(backend.outputInfo().perfectReasonCode == "unsupported_asio_sample_type");
}

void testActualOutputFormatRefreshAfterBuffers() {
  auto host = makeHost();
  auto* rawHost = host.get();
  rawHost->channelFormats = {AudioSampleFormat::Int24In32Interleaved, AudioSampleFormat::Int24In32Interleaved};
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:mock", sourceFormat(96000, 32, 2, AudioSampleFormat::Float32Interleaved), &error));
  assert(backend.outputInfo().actualOutputFormat == "float32");
  assert(backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
  const auto info = backend.outputInfo();
  assert(info.actualOutputFormat == "int24-in32");
  assert(info.actualBitDepth == 24);
  assert(info.outputBitDepth == 24);
  assert(info.perfectReason.find("actual output format differs") != std::string::npos);
}

void testPcmShortReadIsCountedOncePerCallback() {
  auto host = makeHost();
  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:mock", sourceFormat(48000, 32), &error));
  assert(backend.start([](float* output, size_t frames) {
    std::fill(output, output + frames * 2, 0.25f);
    return frames / 2;
  }, nullptr, &error));

  rawHost->triggerBufferSwitch(0);
  const auto firstSession = backend.outputInfo();
  assert(firstSession.diagnostics.sessionUnderrunCount == 1);
  assert(firstSession.diagnostics.lifetimeUnderrunCount == 1);

  backend.close();
  assert(backend.open("asio:mock", sourceFormat(48000, 32), &error));
  const auto secondSession = backend.outputInfo();
  assert(secondSession.diagnostics.sessionUnderrunCount == 0);
  assert(secondSession.diagnostics.lifetimeUnderrunCount == 1);
}

void testOutputReadyFailureDisablesRepeatedDriverCalls() {
  auto host = makeHost();
  auto* rawHost = host.get();
  rawHost->failOutputReadyCount = 1;
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:mock", sourceFormat(48000, 32), &error));
  assert(backend.start([](float* output, size_t frames) {
    std::fill(output, output + frames * 2, 0.0f);
    return frames;
  }, nullptr, &error));

  rawHost->triggerBufferSwitch(0);
  rawHost->triggerBufferSwitch(1);
  rawHost->triggerBufferSwitch(0);
  assert(rawHost->outputReadyCalls == 1);
}

void testBufferSizeMatrix() {
  const uint32_t sizes[] = {0, 64, 128, 256, 512, 1024, 2048};
  for (const auto size : sizes) {
    auto host = makeHost();
    auto* rawHost = host.get();
    rawHost->devices[0].minBufferSize = 64;
    rawHost->devices[0].maxBufferSize = 2048;
    rawHost->devices[0].bufferGranularity = 64;
    rawHost->devices[0].preferredBufferSize = 256;
    AsioBackend backend(std::move(host));
    OutputConfig config;
    config.preferredBufferSize = size;
    std::string error;
    assert(backend.setOutputConfig(config, &error));
    assert(backend.open("asio:mock", sourceFormat(48000, 32), &error));
    const long expected = size == 0 ? 256 : static_cast<long>(size);
    assert(rawHost->lastOpenConfig.bufferSizeFrames == expected);
    assert(backend.outputInfo().bufferSizeFrames == expected);
    size_t callbacks = 0;
    assert(backend.start([&](float* output, size_t frames) {
      std::fill(output, output + frames * 2, 0.125f);
      ++callbacks;
      return frames;
    }, nullptr, &error));
    const int formatQueriesBeforePump = rawHost->outputChannelFormatCalls;
    for (size_t callbackIndex = 0; callbackIndex < 256; ++callbackIndex) {
      rawHost->triggerBufferSwitch(static_cast<long>(callbackIndex % 2));
    }
    assert(callbacks == 256);
    assert(rawHost->outputReadyCalls == 256);
    assert(rawHost->outputChannelFormatCalls == formatQueriesBeforePump);
    assert(backend.outputInfo().diagnostics.sessionBufferDropCount == 0);
    backend.stop();
  }
}

void testNativeDsdBufferSizeWithoutCatalogRange() {
  MockAsioHost::DsdProfile profile;
  profile.nativeDsdCapable = true;
  profile.nativeDsdSampleRates = {11289600};
  profile.nativeDsdSampleFormats = {AudioSampleFormat::DsdInt8Lsb1};

  const auto makeRangeUnknownHost = [&] {
    auto host = std::make_unique<MockAsioHost>();
    auto device = makeMockAsioDevice(
        "asio:native-dsd-range-unknown",
        {48000},
        2,
        AudioSampleFormat::Float32Interleaved,
        profile);
    device.minBufferSize = 0;
    device.maxBufferSize = 0;
    device.bufferGranularity = 0;
    device.preferredBufferSize = 512;
    host->devices.push_back(std::move(device));
    return host;
  };

  {
    auto host = makeRangeUnknownHost();
    auto* rawHost = host.get();
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open(
        "asio:native-dsd-range-unknown",
        sourceFormat(11289600, 1, 2, AudioSampleFormat::DsdInt8Lsb1),
        &error));
    assert(rawHost->lastOpenConfig.bufferSizeFrames == 2048);
  }

  {
    auto host = makeRangeUnknownHost();
    auto* rawHost = host.get();
    AsioBackend backend(std::move(host));
    OutputConfig config;
    config.preferredBufferSize = 2048;
    std::string error;
    assert(backend.setOutputConfig(config, &error));
    assert(backend.open(
        "asio:native-dsd-range-unknown",
        sourceFormat(11289600, 1, 2, AudioSampleFormat::DsdInt8Lsb1),
        &error));
    assert(rawHost->lastOpenConfig.bufferSizeFrames == 2048);
  }
}

void testPacking() {
  {
    auto host = makeHost();
    auto* rawHost = host.get();
    rawHost->channelFormats = {AudioSampleFormat::Int16Interleaved, AudioSampleFormat::Int16Interleaved};
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:mock", sourceFormat(96000, 16), &error));
    assert(backend.start([](float* output, size_t frames) {
      for (size_t frame = 0; frame < frames; ++frame) {
        output[frame * 2] = 1.0f;
        output[frame * 2 + 1] = -1.0f;
      }
      return frames;
    }, nullptr, &error));
    rawHost->triggerBufferSwitch(0);
    assert(readInt16(rawHost->channelBuffers[0].buffers[0]) == 32767);
    assert(readInt16(rawHost->channelBuffers[1].buffers[0]) == -32768);
  }
  {
    auto host = makeHost();
    auto* rawHost = host.get();
    rawHost->channelFormats = {AudioSampleFormat::Float32Interleaved, AudioSampleFormat::Int32Interleaved};
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:mock", sourceFormat(96000, 32), &error));
    assert(backend.start([](float* output, size_t frames) {
      for (size_t frame = 0; frame < frames; ++frame) {
        output[frame * 2] = 0.5f;
        output[frame * 2 + 1] = 0.5f;
      }
      return frames;
    }, nullptr, &error));
    rawHost->triggerBufferSwitch(0);
    float packedFloat = 0.0f;
    std::memcpy(&packedFloat, rawHost->channelBuffers[0].buffers[0].data(), sizeof(float));
    assert(packedFloat == 0.5f);
    assert(readInt32(rawHost->channelBuffers[1].buffers[0]) > 1000000000);
  }
  {
    auto host = makeHost();
    auto* rawHost = host.get();
    rawHost->channelFormats = {AudioSampleFormat::Int24Interleaved, AudioSampleFormat::Int24Interleaved};
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:mock", sourceFormat(96000, 24), &error));
    assert(backend.start([](float* output, size_t frames) {
      for (size_t frame = 0; frame < frames; ++frame) {
        output[frame * 2] = 1.0f;
        output[frame * 2 + 1] = 0.0f;
      }
      return frames;
    }, nullptr, &error));
    rawHost->triggerBufferSwitch(0);
    const auto& bytes = rawHost->channelBuffers[0].buffers[0];
    assert(bytes[0] == 0xff && bytes[1] == 0xff && bytes[2] == 0x7f);
  }
  {
    auto host = makeHost();
    auto* rawHost = host.get();
    rawHost->channelFormats = {AudioSampleFormat::Int24In32Interleaved, AudioSampleFormat::Int24In32Interleaved};
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:mock", sourceFormat(96000, 24), &error));
    assert(backend.start([](float* output, size_t frames) {
      for (size_t frame = 0; frame < frames; ++frame) {
        output[frame * 2] = 1.0f;
        output[frame * 2 + 1] = -1.0f;
      }
      return frames;
    }, nullptr, &error));
    rawHost->triggerBufferSwitch(0);
    assert(readInt24In32(rawHost->channelBuffers[0].buffers[0]) == 8388607);
    assert(readInt24In32(rawHost->channelBuffers[1].buffers[0]) == -8388608);
  }
}

void testTypedPassthroughPacking() {
  struct Case {
    AudioSampleFormat sampleFormat;
    int bitDepth;
    std::vector<uint8_t> left;
    std::vector<uint8_t> right;
  };
  const Case cases[] = {
      {AudioSampleFormat::Int16Interleaved, 16, {0x34, 0x12}, {0xcc, 0xed}},
      {AudioSampleFormat::Int24Interleaved, 24, {0x11, 0x22, 0x33}, {0xaa, 0xbb, 0xcc}},
      {AudioSampleFormat::Int24In32Interleaved, 24, {0x00, 0x11, 0x22, 0x33}, {0x00, 0xaa, 0xbb, 0xcc}},
      {AudioSampleFormat::Int32Interleaved, 32, {0x11, 0x22, 0x33, 0x44}, {0xaa, 0xbb, 0xcc, 0xdd}},
  };

  for (const auto& item : cases) {
    auto host = std::make_unique<MockAsioHost>();
    auto device = makeMockAsioDevice("asio:typed", {48000}, 2, item.sampleFormat);
    device.sampleFormats = {item.sampleFormat};
    device.bitDepths = {item.bitDepth};
    host->devices.push_back(device);
    auto* rawHost = host.get();
    rawHost->channelFormats = {item.sampleFormat, item.sampleFormat};

    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:typed", sourceFormat(48000, item.bitDepth, 2, item.sampleFormat), &error));
    bool typedCalled = false;
    bool fallbackCalled = false;
    assert(backend.startTyped(
        [&](PcmBlock& block) {
          typedCalled = true;
          assert(block.format.sampleFormat == item.sampleFormat);
          assert(block.format.channelCount == 2);
          const size_t bytesPerSample = audioSampleFormatBytes(item.sampleFormat);
          for (size_t frame = 0; frame < block.frames; ++frame) {
            std::memcpy(block.data + (frame * 2) * bytesPerSample, item.left.data(), bytesPerSample);
            std::memcpy(block.data + (frame * 2 + 1) * bytesPerSample, item.right.data(), bytesPerSample);
          }
          return block.frames;
        },
        [&](float*, size_t frames) {
          fallbackCalled = true;
          return frames;
        },
        nullptr,
        &error));

    rawHost->triggerBufferSwitch(0);
    assert(typedCalled);
    assert(!fallbackCalled);
    assert(std::equal(item.left.begin(), item.left.end(), rawHost->channelBuffers[0].buffers[0].begin()));
    assert(std::equal(item.right.begin(), item.right.end(), rawHost->channelBuffers[1].buffers[0].begin()));
  }
}

void testStartFailurePaths() {
  {
    auto host = makeHost();
    auto* rawHost = host.get();
    rawHost->failDriverInitCount = 1;
    AsioBackend backend(std::move(host));
    std::string error;
    assert(!backend.open("asio:mock", sourceFormat(96000, 32), &error));
    assert(error == "mock driver init failure");
    assert(backend.outputInfo().diagnostics.lastError == "mock driver init failure");
    assert(backend.outputInfo().perfectReason == "mock driver init failure");
    assert(rawHost->openCalls == 1);
    assert(rawHost->createBuffersCalls == 0);
    assert(rawHost->startCalls == 0);
  }
  {
    auto host = makeHost();
    auto* rawHost = host.get();
    rawHost->failDriverOpenCount = 1;
    AsioBackend backend(std::move(host));
    std::string error;
    assert(!backend.open("asio:mock", sourceFormat(96000, 32), &error));
    assert(error == "mock open failure");
    assert(backend.outputInfo().diagnostics.lastError == "mock open failure");
    assert(backend.outputInfo().perfectReason == "mock open failure");
    assert(rawHost->openCalls == 1);
    assert(rawHost->createBuffersCalls == 0);
    assert(rawHost->startCalls == 0);
  }
  {
    auto host = makeHost();
    auto* rawHost = host.get();
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:mock", sourceFormat(96000, 32), &error));
    rawHost->failCreateBuffersCount = 1;
    assert(!backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
    const auto info = backend.outputInfo();
    assert(info.diagnostics.sessionBufferDropCount == 1);
    assert(info.diagnostics.lifetimeBufferDropCount == 1);
    assert(info.diagnostics.lastError == "mock create buffers failure");
    assert(info.perfectReason.find("buffer creation failed") != std::string::npos);
    assert(info.actualBackend == "asio");
    assert(rawHost->openCalls == 1);
    assert(rawHost->createBuffersCalls == 1);
    assert(rawHost->startCalls == 0);
  }
  {
    auto host = makeHost();
    auto* rawHost = host.get();
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:mock", sourceFormat(96000, 32), &error));
    rawHost->failStartCount = 1;
    assert(!backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
    const auto info = backend.outputInfo();
    assert(info.diagnostics.lastError == "mock start failure");
    assert(info.perfectReason.find("start failed") != std::string::npos);
    assert(info.actualBackend == "asio");
    assert(rawHost->openCalls == 1);
    assert(rawHost->createBuffersCalls == 1);
    assert(rawHost->startCalls == 1);
  }
}

void testRecovery() {
  auto host = makeHost();
  auto* rawHost = host.get();
  rawHost->failOpenCount = 1;
  AsioBackend backend(std::move(host));
  std::string error;
  assert(!backend.open("asio:mock", sourceFormat(96000, 32), &error));

  auto recoveryHost = makeHost();
  auto* rawRecoveryHost = recoveryHost.get();
  AsioBackend recoveryBackend(std::move(recoveryHost));
  assert(recoveryBackend.open("asio:mock", sourceFormat(96000, 32), &error));
  assert(recoveryBackend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
  rawRecoveryHost->failOpenCount = 1;
  rawRecoveryHost->triggerEvent(AsioHostEvent::BufferFailure, "buffer failed");
  assert(waitUntil([&] { return recoveryBackend.outputInfo().recoveryCount == 1; }));
  auto recoveredInfo = recoveryBackend.outputInfo();
  assert(recoveredInfo.deviceRecovered);
  assert(recoveredInfo.recoveryCount == 1);
  assert(recoveredInfo.diagnostics.sessionRecoveryCount == 1);
  assert(recoveredInfo.diagnostics.lifetimeRecoveryCount == 1);
  assert(recoveredInfo.diagnostics.sessionUnderrunCount == 1);
  assert(recoveredInfo.diagnostics.lastError.find("ASIO buffer failure") != std::string::npos);

  auto failHost = makeHost();
  auto* rawFailHost = failHost.get();
  AsioBackend failBackend(std::move(failHost));
  assert(failBackend.open("asio:mock", sourceFormat(96000, 32), &error));
  bool gotError = false;
  assert(failBackend.start(
      [](float*, size_t frames) { return frames; },
      [&](OutputBackendEvent, const std::string&) { gotError = true; },
      &error));
  rawFailHost->failOpenCount = 3;
  rawFailHost->triggerEvent(AsioHostEvent::DeviceLost, "lost");
  assert(waitUntil([&] { return gotError; }));
  assert(gotError);
  const auto failedInfo = failBackend.outputInfo();
  assert(!failedInfo.deviceRecovered);
  assert(failedInfo.recoveryCount == 0);
  assert(failedInfo.diagnostics.deviceLostCount == 1);
  assert(failedInfo.diagnostics.lastError == "mock open failure");
}

void testRecoveryBackoffIsCancelledByStop() {
  auto host = makeHost();
  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:mock", sourceFormat(96000, 32), &error));
  assert(backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));

  rawHost->triggerEvent(AsioHostEvent::BufferFailure, "stop requested");
  assert(waitUntil([&] {
    return backend.outputInfo().diagnostics.lastError.find("ASIO buffer failure") != std::string::npos;
  }));
  const int openCalls = rawHost->openCalls;
  const int createBuffersCalls = rawHost->createBuffersCalls;
  const int startCalls = rawHost->startCalls;

  backend.stop();
  std::this_thread::sleep_for(std::chrono::milliseconds(650));

  assert(rawHost->openCalls == openCalls);
  assert(rawHost->createBuffersCalls == createBuffersCalls);
  assert(rawHost->startCalls == startCalls);
}

void testRecoveryEventDiagnostics() {
  {
    auto host = makeHost();
    auto* rawHost = host.get();
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:mock", sourceFormat(96000, 32), &error));
    assert(backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
    rawHost->triggerEvent(AsioHostEvent::DriverRestart, "restart requested");
    assert(waitUntil([&] { return backend.outputInfo().deviceRecovered; }));
    const auto info = backend.outputInfo();
    assert(info.diagnostics.driverRestartCount == 1);
    assert(info.diagnostics.lastError.find("ASIO driver restart") != std::string::npos);
    assert(info.deviceRecovered);
  }
  {
    auto host = makeHost();
    auto* rawHost = host.get();
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:mock", sourceFormat(96000, 32), &error));
    assert(backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
    rawHost->triggerEvent(AsioHostEvent::DeviceLost, "device disappeared");
    assert(waitUntil([&] { return backend.outputInfo().deviceRecovered; }));
    const auto info = backend.outputInfo();
    assert(info.diagnostics.deviceLostCount == 1);
    assert(info.diagnostics.lastError.find("ASIO device lost") != std::string::npos);
    assert(info.deviceRecovered);
  }
}

void testDriverXrunIsCountedWithoutRecovery() {
  auto host = makeHost();
  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:mock", sourceFormat(96000, 32), &error));
  assert(backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
  const int openCalls = rawHost->openCalls;
  const int createBuffersCalls = rawHost->createBuffersCalls;
  const int startCalls = rawHost->startCalls;

  // A burst larger than the 3-per-10s recovery budget. If Xrun shared the
  // recovery path these would rebuild the stream and then trip the cooldown.
  for (int i = 0; i < 5; ++i) rawHost->triggerEvent(AsioHostEvent::Xrun, "driver overload");
  assert(waitUntil([&] { return backend.outputInfo().diagnostics.driverXrunCount == 5; }));

  const auto afterXruns = backend.outputInfo();
  assert(afterXruns.diagnostics.driverXrunCount == 5);
  assert(afterXruns.recoveryCount == 0);
  assert(afterXruns.diagnostics.sessionRecoveryCount == 0);
  assert(afterXruns.diagnostics.lifetimeRecoveryCount == 0);
  assert(afterXruns.diagnostics.sessionUnderrunCount == 0);
  assert(afterXruns.diagnostics.driverRestartCount == 0);
  assert(afterXruns.diagnostics.deviceLostCount == 0);
  assert(!afterXruns.deviceRecovered);
  assert(afterXruns.diagnostics.lastError.find("ASIO driver load event") != std::string::npos);
  // The stream was never torn down, so the driver saw no new lifecycle calls.
  assert(rawHost->openCalls == openCalls);
  assert(rawHost->createBuffersCalls == createBuffersCalls);
  assert(rawHost->startCalls == startCalls);

  // The xrun burst must not have consumed the rate-limiter budget: a real fault
  // arriving right after still recovers instead of landing in the cooldown.
  rawHost->triggerEvent(AsioHostEvent::BufferFailure, "real fault after xrun burst");
  assert(waitUntil([&] { return backend.outputInfo().recoveryCount == 1; }));
  const auto afterFault = backend.outputInfo();
  assert(afterFault.diagnostics.driverXrunCount == 5);
  assert(afterFault.diagnostics.sessionRecoveryCount == 1);
  assert(afterFault.diagnostics.lastError.find("ASIO buffer failure") != std::string::npos);
  assert(afterFault.diagnostics.lastError.find("cooldown") == std::string::npos);
}

void testRecoveryCooldown() {
  auto host = makeHost();
  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:mock", sourceFormat(96000, 32), &error));
  assert(backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));

  rawHost->triggerEvent(AsioHostEvent::BufferFailure, "storm 1");
  assert(waitUntil([&] { return backend.outputInfo().recoveryCount == 1; }));
  rawHost->triggerEvent(AsioHostEvent::BufferFailure, "storm 2");
  assert(waitUntil([&] { return backend.outputInfo().recoveryCount == 2; }));
  rawHost->triggerEvent(AsioHostEvent::BufferFailure, "storm 3");
  assert(waitUntil([&] { return backend.outputInfo().recoveryCount == 3; }));
  const int openCalls = rawHost->openCalls;
  const int createBuffersCalls = rawHost->createBuffersCalls;
  const int startCalls = rawHost->startCalls;

  rawHost->triggerEvent(AsioHostEvent::BufferFailure, "storm 4");
  assert(waitUntil([&] {
    return backend.outputInfo().diagnostics.lastError.find("cooldown") != std::string::npos;
  }));
  const auto info = backend.outputInfo();
  assert(info.deviceRecovered);
  assert(info.recoveryCount == 3);
  assert(info.diagnostics.sessionRecoveryCount == 3);
  assert(info.diagnostics.lifetimeRecoveryCount == 3);
  assert(info.diagnostics.sessionUnderrunCount == 4);
  assert(info.diagnostics.lastError.find("cooldown") != std::string::npos);
  assert(rawHost->openCalls == openCalls);
  assert(rawHost->createBuffersCalls == createBuffersCalls);
  assert(rawHost->startCalls == startCalls);
}

bool runRealAsioSmokeRequested() {
  const char* value = std::getenv("TAE_RUN_REAL_ASIO_SMOKE");
  return value && std::string(value) == "1";
}

void testRealAsioSmokeOptIn() {
  if (!runRealAsioSmokeRequested()) return;

  auto host = createRealAsioHost();
  const auto devices = host->enumerateDevices();
  if (devices.empty()) {
    std::cerr << "TAE_RUN_REAL_ASIO_SMOKE=1 but no ASIO devices were enumerated; skipping real smoke\n";
    return;
  }

  const auto& device = devices.front();
  AudioFormat format;
  format.sampleRate = device.defaultSampleRate > 0
                          ? device.defaultSampleRate
                          : (device.supportedSampleRates.empty() ? 48000 : device.supportedSampleRates.front());
  format.channelCount = device.outputChannels > 0 ? std::min(2, device.outputChannels) : 2;
  format.sampleFormat = device.defaultSampleFormat;
  format.bitDepth = device.defaultBitDepth > 0 ? device.defaultBitDepth : 32;

  AsioOpenConfig config;
  config.deviceId = device.id;
  config.format = format;
  config.bufferSizeFrames = device.preferredBufferSize > 0 ? device.preferredBufferSize : 128;

  AsioOpenResult result;
  std::string error;
  assert(host->open(config, &result, &error));
  assert(result.actualFormat.sampleRate > 0);
  assert(result.actualFormat.channelCount > 0);
  assert(!result.driverName.empty());
  assert(host->createBuffers([](long) {}, [](AsioHostEvent, const std::string&) {}, &error));
  assert(host->start(&error));
  host->stop();
  host->close();
}

}  // namespace

int main() {
  testAsioBooleanSemantics();
  testAsioErrorSuccessSemantics();
  testAsioDriverSessionUsesAsioErrorSuccessSemantics();
  testAsioNativeDsdSampleRateSemantics();
  testDsdCallbackUnitClassification();
  testAsioDriverActivationRequestsDriverClsid();
  testAsioDriverSessionRequeriesBufferSizeAfterNativeDsdSwitch();
  testAsioDriverSessionHintsAtHeldDeviceWhenDsdSetIsRefused();
  testAsioDriverSessionRetriesCreateBuffersAtPreferred();
  testAsioDriverSessionRechecksChannelCountAfterRateSwitch();
  testAsioDriverSessionProbesDoPCarriersInBothRateFamilies();
  testAsioDriverSessionOnlySetsRateWhenDifferent();
  testAsioRenderCallbackDoesNotResizeScratchBuffers();
  testAsioRenderCallbackClassifiesDsdBufferUnit();
  testAsioRenderCallbackDoesNotBlockOnBackendMutex();
  testAsioRenderCallbackUsesImmutableSessionSnapshots();
  testAsioRenderCallbackDoesNotCopyStringDiagnostics();
  testAsioHostEventCallbackQueuesRecoveryOffDriverCallback();
  testAsioRecoveryQueueChecksStopRequestedWhileHoldingQueueLock();
  testAsioEmptyCatalogReportsArchitectureMismatch();
  testOpenRetriesRemainingCandidatesAfterDriverRefusal();
  testOpenReportsDriverRefusalWhenAllCandidatesFail();
  testOpenDoesNotRetryAfterDriverLevelFault();
  testOpenProbesRegistryOnlyDeviceRecord();
  testOpenSkipsProbeWhenCapabilitiesAlreadyKnown();
  testOpenStillAttemptsWhenProbeFails();
  testFormatNegotiation();
  testOpenFailureAndFallbackFormats();
  testExtremeSampleRates();
  testDopCarrierProfile();
  testDopRuntimeFactsProvenWithoutExplicitCapability();
  testDopCarrierUsesInt32AsioContainer();
  testDopRuntimeFactsMismatchWhenActualFormatDiffers();
  testDopMarkerEvidence();
  testDopMarkerMismatchDemotesRuntimeFacts();
  testNativeDsdCapabilityProfile();
  testFiiODriverNameDoesNotRewriteStandardNativeDsdRequest();
  testNativeDsdRuntimeProven();
  testNativeDsdDriverSelectedWireTypeAndIdleTail();
  testNativeDsdRuntimeDiscoveryWithoutCatalogCapability();
  testNativeDsdUnderrunWarmupCallbacks();
  testNativeDsdRejectsUnsupportedRate();
  testNativeDsdAttemptsRateMissingFromProbedCapabilities();
  testNativeDsdCandidateSurvivesProbedPcmBitDepth();
  testDsdSemanticRateProbeSetCoversDsd64Through512();
  testNativeDsdRuntimeSampleTypeMismatch();
  testNativeDsdRuntimeChannelFormatMismatch();
  testChannelCounts();
  testLifecycleAndPlaybackInfo();
  testCloseOpenRestartUsesFreshSessionSnapshot();
  testActualOutputFormats();
  testRejectsUnsupportedChannelDescriptor();
  testActualOutputFormatRefreshAfterBuffers();
  testPcmShortReadIsCountedOncePerCallback();
  testOutputReadyFailureDisablesRepeatedDriverCalls();
  testBufferSizeMatrix();
  testNativeDsdBufferSizeWithoutCatalogRange();
  testPacking();
  testTypedPassthroughPacking();
  testStartFailurePaths();
  testRecovery();
  testRecoveryBackoffIsCancelledByStop();
  testRecoveryEventDiagnostics();
  testDriverXrunIsCountedWithoutRecovery();
  testRecoveryCooldown();
  testRealAsioSmokeOptIn();
  return 0;
}
