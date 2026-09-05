#pragma once

#include <string>
#include <vector>

namespace twilight::audio {

struct PcmDeviceCatalogEntry {
  std::string platformStableId;
  std::string label;
  bool isDefault = false;
};

std::vector<PcmDeviceCatalogEntry> keepUnambiguousPcmDevices(
    const std::vector<PcmDeviceCatalogEntry>& devices);
std::string windowsPcmDeviceCatalogJson(
    const std::vector<PcmDeviceCatalogEntry>& devices,
    const std::string& catalogError = {});

}  // namespace twilight::audio
