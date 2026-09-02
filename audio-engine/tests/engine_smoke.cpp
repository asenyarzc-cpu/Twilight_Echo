#include "twilight_audio_engine.h"

#include <cassert>
#include <cstring>
#include <vector>

int main() {
  TAE_EngineHandle engine = nullptr;
  assert(TAE_CreateEngine(&engine) == TAE_RESULT_OK);
  assert(engine != nullptr);

  size_t required = 0;
  assert(TAE_GetEngineCapabilities(engine, nullptr, 0, &required) == TAE_RESULT_OK);
  assert(required > 1);
  std::vector<char> capabilities(required);
  assert(TAE_GetEngineCapabilities(engine, capabilities.data(), capabilities.size(), &required) == TAE_RESULT_OK);
  assert(std::strstr(capabilities.data(), "\"pcmPassthrough\":true") != nullptr);
  assert(std::strstr(capabilities.data(), "\"outputPerfectRequiresPcmPassthrough\":true") != nullptr);
  assert(std::strstr(capabilities.data(), "\"htmlAudioFallbackDefault\":false") != nullptr);
  assert(std::strstr(capabilities.data(), "\"dsdModes\":[\"pcm\",\"dop\",\"native\",\"unsupported\"]") != nullptr);
  assert(std::strstr(capabilities.data(), "\"sacdIsoDst\":true") != nullptr);
  assert(std::strstr(capabilities.data(), "\"sacdIsoDstMode\":\"native\"") != nullptr);
  assert(std::strstr(capabilities.data(), "\"sacdIsoDstDsdProvider\":true") != nullptr);
  assert(std::strstr(capabilities.data(), "\"devicePathKinds\":[\"default\",\"hw\",\"plughw\",\"hal\",\"asio\"]") != nullptr);
  assert(std::strstr(capabilities.data(), "\"output\":{\"accessModes\":[\"shared\",\"exclusive\",\"hog\",\"direct\",\"plugin\"]}") != nullptr);
  assert(std::strstr(capabilities.data(), "\"backendCapabilities\"") != nullptr);
  assert(std::strstr(capabilities.data(), "\"id\":\"wasapi\"") != nullptr);
  assert(std::strstr(capabilities.data(), "\"id\":\"wasapi-exclusive\"") != nullptr);
  assert(std::strstr(capabilities.data(), "\"id\":\"asio\"") != nullptr);
  assert(std::strstr(capabilities.data(), "\"devicePathKind\":\"asio\"") != nullptr);

  assert(TAE_LoadQueue(engine, "{}", 0) == TAE_RESULT_INVALID_ARGUMENT);
  required = 0;
  assert(TAE_GetLastError(engine, nullptr, 0, &required) == TAE_RESULT_OK);
  std::vector<char> lastError(required);
  assert(TAE_GetLastError(engine, lastError.data(), lastError.size(), &required) == TAE_RESULT_OK);
  assert(std::strstr(lastError.data(), "\"hasError\":true") != nullptr);
  assert(std::strstr(lastError.data(), "\"code\":\"TAE_RESULT_INVALID_ARGUMENT\"") != nullptr);
  assert(std::strstr(lastError.data(), "\"context\":\"queue\"") != nullptr);
  assert(std::strstr(lastError.data(), "\"recoverable\":false") != nullptr);

  assert(TAE_LoadQueue(engine, "[{\"id\":\"1\",\"source\":\"test.flac\"}]", 0) == TAE_RESULT_OK);
  const TAE_Result playResult = TAE_Play(engine, "test.flac", 0.0);
  assert(playResult == TAE_RESULT_OK || playResult == TAE_RESULT_BACKEND_UNAVAILABLE);
  assert(TAE_SetVolume(engine, 1.0) == TAE_RESULT_OK);

  required = 0;
  assert(TAE_GetPlaybackInfo(engine, nullptr, 0, &required) == TAE_RESULT_OK);
  assert(required > 1);
  std::vector<char> json(required);
  assert(TAE_GetPlaybackInfo(engine, json.data(), json.size(), &required) == TAE_RESULT_OK);
  assert(std::strstr(json.data(), "\"state\":\"playing\"") != nullptr ||
         std::strstr(json.data(), "\"state\":\"stopped\"") != nullptr);
  assert(std::strstr(json.data(), "\"outputInfo\":{") != nullptr);
  assert(std::strstr(json.data(), "\"providerImplementation\":\"legacy-native\"") != nullptr);
  assert(std::strstr(json.data(), "\"conversionInfo\":{") != nullptr);
  assert(std::strstr(json.data(), "\"sampleFormatConverted\"") != nullptr);
  assert(std::strstr(json.data(), "\"sampleRateConverted\"") != nullptr);
  assert(std::strstr(json.data(), "\"channelLayoutConverted\"") != nullptr);
  assert(std::strstr(json.data(), "\"source\":\"unavailable\"") != nullptr);
  assert(std::strstr(json.data(), "\"actualBackend\"") != nullptr);
  assert(std::strstr(json.data(), "\"actualOutputFormat\"") != nullptr);
  assert(std::strstr(json.data(), "\"actualSampleRate\"") != nullptr);
  assert(std::strstr(json.data(), "\"actualBitDepth\"") != nullptr);
  assert(std::strstr(json.data(), "\"actualChannels\"") != nullptr);
  assert(std::strstr(json.data(), "\"bufferSizeFrames\"") != nullptr);
  assert(std::strstr(json.data(), "\"latencyInfo\"") != nullptr);
  assert(std::strstr(json.data(), "\"bufferLatencyMs\"") != nullptr);
  assert(std::strstr(json.data(), "\"outputLatencyMs\"") != nullptr);
  assert(std::strstr(json.data(), "\"totalLatencyMs\"") != nullptr);
  assert(std::strstr(json.data(), "\"diagnostics\"") != nullptr);
  assert(std::strstr(json.data(), "\"sessionUnderrunCount\"") != nullptr);
  assert(std::strstr(json.data(), "\"sessionBufferDropCount\"") != nullptr);
  assert(std::strstr(json.data(), "\"sessionRecoveryCount\"") != nullptr);
  assert(std::strstr(json.data(), "\"driverRestartCount\"") != nullptr);
  assert(std::strstr(json.data(), "\"deviceLostCount\"") != nullptr);
  assert(std::strstr(json.data(), "\"sourceExact\"") != nullptr);
  assert(std::strstr(json.data(), "\"outputPerfect\"") != nullptr);
  assert(std::strstr(json.data(), "\"pcmPassthrough\"") != nullptr);
  assert(std::strstr(json.data(), "\"perfectReason\"") != nullptr);
  assert(std::strstr(json.data(), "\"perfectReasonCode\"") != nullptr);
  assert(std::strstr(json.data(), "\"decodedSampleRate\"") != nullptr);
  assert(std::strstr(json.data(), "\"decodedBitDepth\"") != nullptr);
  assert(std::strstr(json.data(), "\"decodedChannels\"") != nullptr);
  assert(std::strstr(json.data(), "\"decodedSampleFormat\"") != nullptr);
  assert(std::strstr(json.data(), "\"isDsd\"") != nullptr);
  assert(std::strstr(json.data(), "\"dsdMode\"") != nullptr);
  assert(std::strstr(json.data(), "\"dsdRate\"") != nullptr);
  assert(std::strstr(json.data(), "\"bitPerfect\"") == nullptr);
  assert(std::strstr(json.data(), "\"resampleReason\"") == nullptr);

  const char* dspConfig =
      "{\"dspEnabled\":true,\"volumeNormalization\":\"track\",\"replayGainPreamp\":1.5,"
      "\"replayGainFallback\":-6,\"replayGainClip\":true,"
      "\"eqEnabled\":true,\"eqMode\":\"parametric\",\"eqPreamp\":-1,"
      "\"eqBands\":[{\"frequency\":1000,\"gain\":3,\"q\":1,"
      "\"filterType\":\"peak\"}]}";
  assert(TAE_SetDspConfig(engine, dspConfig) == TAE_RESULT_OK);
  required = 0;
  assert(TAE_GetPlaybackInfo(engine, nullptr, 0, &required) == TAE_RESULT_OK);
  json.assign(required, '\0');
  assert(TAE_GetPlaybackInfo(engine, json.data(), json.size(), &required) == TAE_RESULT_OK);
  assert(std::strstr(json.data(), "\"dspActive\":true") != nullptr);
  assert(std::strstr(json.data(), "\"replayGainActive\":true") != nullptr);
  assert(std::strstr(json.data(), "\"eqActive\":true") != nullptr);
  assert(std::strstr(json.data(), "\"convolverActive\":false") != nullptr);
  assert(std::strstr(json.data(), "\"crossfeedActive\":false") != nullptr);
  assert(std::strstr(json.data(), "\"outputPerfect\":false") != nullptr);

  assert(TAE_SetCrossfeedStrength(engine, 0.5) == TAE_RESULT_OK);
  assert(TAE_SetReplayGainMode(engine, "album", 0.0, -3.0, 1) == TAE_RESULT_OK);
  assert(TAE_GetConvolverInfo(engine, nullptr, 0, &required) == TAE_RESULT_OK);
  assert(required > 1);
  assert(TAE_GetMetadata(engine, "test.flac", nullptr, 0, &required) == TAE_RESULT_OK);
  assert(required > 1);

  const uint64_t bpmExecutionsBefore = TAE_GetAnalysisExecutionCount("bpm");
  required = 0;
  assert(TAE_AnalyzeBpm(engine, "analysis-probe.wav", "{}", nullptr, 0, &required) == TAE_RESULT_OK);
  assert(required > 1);
  std::vector<char> bpmAnalysis(required);
  assert(TAE_AnalyzeBpm(
             engine,
             "analysis-probe.wav",
             "{}",
             bpmAnalysis.data(),
             bpmAnalysis.size(),
             &required) == TAE_RESULT_OK);
  assert(TAE_GetAnalysisExecutionCount("bpm") == bpmExecutionsBefore + 1);

  const uint64_t loudnessExecutionsBefore = TAE_GetAnalysisExecutionCount("loudness");
  required = 0;
  assert(TAE_AnalyzeLoudness(
             engine, "analysis-probe.wav", "{}", nullptr, 0, &required) == TAE_RESULT_OK);
  assert(required > 1);
  std::vector<char> loudnessAnalysis(required);
  assert(TAE_AnalyzeLoudness(
             engine,
             "analysis-probe.wav",
             "{}",
             loudnessAnalysis.data(),
             loudnessAnalysis.size(),
             &required) == TAE_RESULT_OK);
  assert(TAE_GetAnalysisExecutionCount("loudness") == loudnessExecutionsBefore + 1);

  float spectrum[16] = {};
  size_t written = 0;
  assert(TAE_GetSpectrumData(engine, spectrum, 16, &written) == TAE_RESULT_OK);
  assert(written == 16);

  TAE_DestroyEngine(engine);
  return 0;
}
