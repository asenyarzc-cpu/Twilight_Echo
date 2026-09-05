#pragma once

#include "IOutputBackend.h"

#include <memory>
#include <string>

namespace twilight::audio {

enum class PcmOutputProvider {
  Legacy,
  Miniaudio
};

enum class PcmOutputProviderStatus {
  Ready,
  InvalidConfiguration,
  ProviderUnavailable
};

struct PcmOutputProviderSelection {
  PcmOutputProvider provider = PcmOutputProvider::Legacy;
  PcmOutputProviderStatus status = PcmOutputProviderStatus::Ready;
  std::string error;
};

PcmOutputProviderSelection resolvePcmOutputProvider(const char* configuredValue, bool miniaudioBuilt);
const char* compiledDefaultPcmProviderControlValue();
const PcmOutputProviderSelection& configuredPcmOutputProvider();
bool outputBackendUsesPcmProvider(const std::string& backendId);
PcmOutputProviderStatus validatePcmOutputProviderForBackend(
    const std::string& backendId,
    std::string* error);

std::string defaultBackendId();
std::unique_ptr<IOutputBackend> createOutputBackend(
    const std::string& backendId,
    std::string* error = nullptr);

}  // namespace twilight::audio
