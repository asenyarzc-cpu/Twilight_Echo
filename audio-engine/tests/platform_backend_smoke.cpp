#include "../core/AudioTypes.h"
#include "../output/alsa/AlsaBackend.h"
#include "../output/coreaudio/CoreAudioBackend.h"
#include "../output/coreaudio/CoreAudioExclusiveBackend.h"
#include "../output/wasapi/WasapiExclusiveBackend.h"
#include "../output/wasapi/WasapiSharedBackend.h"

#include <cassert>
#include <chrono>
#include <cstdlib>
#include <string>
#include <thread>

using namespace twilight::audio;

namespace {

AudioFormat pcm() {
  AudioFormat format;
  format.sampleRate = 48000;
  format.channelCount = 2;
  format.bitDepth = 32;
  format.sampleFormat = AudioSampleFormat::Float32Interleaved;
  return format;
}

bool runRealBackendTests() {
  const char* value = std::getenv("TAE_RUN_REAL_AUDIO_BACKEND_TESTS");
  return value && std::string(value) == "1";
}

void assertActualFormatFacts(const OutputInfo& info) {
  assert(!info.actualOutputFormat.empty());
  assert(info.actualSampleRate > 0);
  assert(info.actualBitDepth > 0);
  assert(info.actualChannels > 0);
  assert(info.bufferSizeFrames > 0);
}

void assertLatencyFacts(const OutputInfo& info) {
  assert(info.latencyInfo.bufferLatencyMs >= 0.0);
  assert(info.latencyInfo.outputLatencyMs >= 0.0);
  assert(info.latencyInfo.totalLatencyMs >= info.latencyInfo.bufferLatencyMs);
  assert(info.latencyMs == info.latencyInfo.totalLatencyMs);
}

}  // namespace

int main() {
#if defined(_WIN32)
  {
    WasapiSharedBackend backend;
    assert(std::string(backend.id()) == "wasapi");
    if (runRealBackendTests()) {
      std::string error;
      if (backend.open("auto", pcm(), &error)) {
        const OutputInfo info = backend.outputInfo();
        assert(info.actualBackend == "wasapi");
        assert(!info.actualDeviceName.empty());
        assert(!info.actualDeviceId.empty());
        assert(!info.actualOutputFormat.empty());
        assert(info.actualSampleRate > 0);
        assert(info.actualBitDepth > 0);
        assert(info.actualChannels > 0);
        assert(info.bufferSizeFrames > 0);
        assertLatencyFacts(info);
        assert(!info.exclusive);
        assert(!info.supportsOutputPerfect);
        assert(!info.outputPerfect);
        assert(info.perfectReasonCode == "shared_mixer");
        assert(!info.perfectReason.empty());
        backend.close();
      } else {
        assert(!error.empty());
      }
    }
  }

  {
    WasapiExclusiveBackend backend;
    assert(std::string(backend.id()) == "wasapi-exclusive");
    if (runRealBackendTests()) {
      std::string error;
      if (backend.open("auto", pcm(), &error)) {
        const OutputInfo info = backend.outputInfo();
        assert(info.actualBackend == "wasapi-exclusive");
        assert(!info.actualDeviceName.empty());
        assert(!info.actualOutputFormat.empty());
        assert(info.actualSampleRate > 0);
        assert(info.actualBitDepth > 0);
        assert(info.actualChannels > 0);
        assert(info.bufferSizeFrames > 0);
        assertLatencyFacts(info);
        assert(info.exclusive);
        assert(info.supportsOutputPerfect);
        assert(info.perfectReasonCode.empty() || info.perfectReasonCode == "pcm_converted" || info.perfectReasonCode == "dsd_dop");
        assert(!info.outputPerfect);
        backend.close();
      } else {
        const OutputInfo info = backend.outputInfo();
        assert(!error.empty());
        assert(info.actualBackend == "wasapi-exclusive");
        assert(!info.perfectReason.empty());
      }
    }
  }
#endif

#if defined(__APPLE__)
  {
    CoreAudioBackend backend;
    assert(std::string(backend.id()) == "coreaudio");
    if (runRealBackendTests() && coreAudioBackendAvailable()) {
      std::string error;
      assert(backend.open("auto", pcm(), &error));
      const OutputInfo info = backend.outputInfo();
      assert(info.actualBackend == "coreaudio");
      assert(!info.actualDeviceName.empty());
      assertActualFormatFacts(info);
      assert(!info.supportsOutputPerfect);
      assert(!info.outputPerfect);
      assert(!info.perfectReason.empty());
      assert(info.perfectReason.find("CoreAudio") != std::string::npos);
      assert(backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
      std::this_thread::sleep_for(std::chrono::milliseconds(30));
      backend.stop();
      backend.close();
    }
  }

  {
    CoreAudioExclusiveBackend backend;
    assert(std::string(backend.id()) == "coreaudio-exclusive");
    if (runRealBackendTests() && coreAudioExclusiveBackendAvailable()) {
      std::string error;
      if (backend.open("auto", pcm(), &error)) {
        const OutputInfo info = backend.outputInfo();
        assert(info.actualBackend == "coreaudio-exclusive");
        assert(!info.actualDeviceName.empty());
        assertActualFormatFacts(info);
        assert(info.exclusive);
        assert(info.accessMode == "exclusive");
        assertLatencyFacts(info);
        assert(backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
        std::this_thread::sleep_for(std::chrono::milliseconds(30));
        backend.stop();
        backend.close();
      } else {
        const OutputInfo info = backend.outputInfo();
        assert(!error.empty());
        assert(info.actualBackend == "coreaudio-exclusive");
        assert(!info.perfectReason.empty());
      }
    }
  }
#endif

#if defined(__linux__)
  {
    AlsaBackend backend;
    assert(std::string(backend.id()) == "alsa");
    std::string error;
    if (backend.open("null", pcm(), &error)) {
      const OutputInfo info = backend.outputInfo();
      assert(info.actualBackend == "alsa");
      assert(!info.actualDeviceName.empty());
      assertActualFormatFacts(info);
      assert(!info.supportsOutputPerfect);
      assert(!info.outputPerfect);
      assert(!info.perfectReason.empty());
      assert(info.perfectReason.find("null") != std::string::npos);
      assert(backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
      std::this_thread::sleep_for(std::chrono::milliseconds(30));
      backend.stop();
      backend.close();
    }
  }
#endif

  return 0;
}
