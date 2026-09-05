#include "OutputBackendFactory.h"

#include <cassert>
#include <string>

namespace twilight::audio {

void runOutputProviderSelectorTests() {
  const auto unset = resolvePcmOutputProvider(nullptr, false);
  assert(unset.status == PcmOutputProviderStatus::Ready);
  assert(unset.provider == PcmOutputProvider::Legacy);

  const auto empty = resolvePcmOutputProvider("", true);
  assert(empty.status == PcmOutputProviderStatus::Ready);
  assert(empty.provider == PcmOutputProvider::Legacy);

  const auto legacy = resolvePcmOutputProvider("legacy", true);
  assert(legacy.status == PcmOutputProviderStatus::Ready);
  assert(legacy.provider == PcmOutputProvider::Legacy);

  const auto miniaudio = resolvePcmOutputProvider("miniaudio", true);
  assert(miniaudio.status == PcmOutputProviderStatus::Ready);
  assert(miniaudio.provider == PcmOutputProvider::Miniaudio);

  const auto unavailable = resolvePcmOutputProvider("miniaudio", false);
  assert(unavailable.status == PcmOutputProviderStatus::ProviderUnavailable);
  assert(unavailable.provider == PcmOutputProvider::Miniaudio);
  assert(unavailable.error.find("TAE_ENABLE_MINIAUDIO=OFF") != std::string::npos);

  const auto invalid = resolvePcmOutputProvider("automatic", true);
  assert(invalid.status == PcmOutputProviderStatus::InvalidConfiguration);
  assert(invalid.error.find("automatic") != std::string::npos);

  const auto compiledDefault = resolvePcmOutputProvider(compiledDefaultPcmProviderControlValue(), true);
  assert(compiledDefault.status == PcmOutputProviderStatus::Ready);
  const auto expectedDefault = std::string(compiledDefaultPcmProviderControlValue()) == "miniaudio"
                                   ? PcmOutputProvider::Miniaudio
                                   : PcmOutputProvider::Legacy;
  assert(compiledDefault.provider == expectedDefault);

  assert(outputBackendUsesPcmProvider("wasapi"));
  assert(outputBackendUsesPcmProvider("wasapi-shared"));
  assert(!outputBackendUsesPcmProvider("wasapi-exclusive"));
  assert(!outputBackendUsesPcmProvider("asio"));
  assert(!outputBackendUsesPcmProvider("coreaudio"));
  assert(!outputBackendUsesPcmProvider("alsa"));
}

}  // namespace twilight::audio
