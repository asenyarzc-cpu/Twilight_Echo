#include "DeviceCatalog.h"

#include <sstream>
#include <unordered_map>
#include <utility>

namespace twilight::audio {
namespace {

std::string escapeJson(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (char ch : value) {
    switch (ch) {
      case '\\':
        out += "\\\\";
        break;
      case '"':
        out += "\\\"";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        out += ch;
        break;
    }
  }
  return out;
}

void appendWindowsPcmFields(
    std::ostringstream& json,
    const std::string& platformStableId,
    const std::string& label,
    bool isDefault,
    const std::string& capabilityReason) {
  json << "{\"id\":\"" << escapeJson(platformStableId.empty() ? "auto" : platformStableId)
       << "\",\"platformStableId\":\"" << escapeJson(platformStableId) << "\",\"label\":\""
       << escapeJson(label) << "\",\"lastKnownLabel\":\"" << escapeJson(label)
       << "\",\"isDefault\":" << (isDefault ? "true" : "false")
       << ",\"backend\":\"wasapi\",\"providerFamily\":\"wasapi\",\"defaultRole\":\"console\""
       << ",\"supportsExclusive\":true,\"supportsHogMode\":false,\"supportsDirectHw\":false"
       << ",\"supportsDop\":false,\"supportsNativeDsd\":false,\"supportedDsdRates\":[]"
       << ",\"pathKind\":\"default\",\"capabilityReason\":\"" << escapeJson(capabilityReason) << "\"}";
}

}  // namespace

std::vector<PcmDeviceCatalogEntry> keepUnambiguousPcmDevices(
    const std::vector<PcmDeviceCatalogEntry>& devices) {
  std::unordered_map<std::string, size_t> idCounts;
  for (const auto& device : devices) {
    if (!device.platformStableId.empty()) ++idCounts[device.platformStableId];
  }

  std::vector<PcmDeviceCatalogEntry> result;
  result.reserve(devices.size());
  for (const auto& device : devices) {
    if (device.platformStableId.empty() || idCounts[device.platformStableId] != 1) continue;
    PcmDeviceCatalogEntry normalized = device;
    if (normalized.label.empty()) normalized.label = normalized.platformStableId;
    result.push_back(std::move(normalized));
  }
  return result;
}

std::string windowsPcmDeviceCatalogJson(
    const std::vector<PcmDeviceCatalogEntry>& devices,
    const std::string& catalogError) {
  std::ostringstream json;
  json << "[";
  appendWindowsPcmFields(json, {}, "系统默认", true, catalogError);
  for (const auto& device : keepUnambiguousPcmDevices(devices)) {
    json << ",";
    appendWindowsPcmFields(json, device.platformStableId, device.label, device.isDefault, {});
  }
  json << "]";
  return json.str();
}

}  // namespace twilight::audio
