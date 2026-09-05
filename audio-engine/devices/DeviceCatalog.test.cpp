#include "DeviceCatalog.h"

#include <cassert>
#include <string>
#include <vector>

namespace twilight::audio {

void runDeviceCatalogTests() {
  const std::vector<PcmDeviceCatalogEntry> devices = {
      {"endpoint-a", "USB DAC", true},
      {"endpoint-b", "USB DAC", false},
      {"", "Invalid", false},
      {"duplicate", "First duplicate", false},
      {"duplicate", "Second duplicate", false},
      {"endpoint-c", "", false}};

  const auto normalized = keepUnambiguousPcmDevices(devices);
  assert(normalized.size() == 3);
  assert(normalized[0].platformStableId == "endpoint-a");
  assert(normalized[1].platformStableId == "endpoint-b");
  assert(normalized[0].label == normalized[1].label);
  assert(normalized[2].platformStableId == "endpoint-c");
  assert(normalized[2].label == "endpoint-c");

  const std::string json = windowsPcmDeviceCatalogJson(devices);
  assert(json.find("\"id\":\"auto\"") != std::string::npos);
  assert(json.find("\"platformStableId\":\"endpoint-a\"") != std::string::npos);
  assert(json.find("\"platformStableId\":\"endpoint-b\"") != std::string::npos);
  assert(json.find("\"lastKnownLabel\":\"USB DAC\"") != std::string::npos);
  assert(json.find("\"providerFamily\":\"wasapi\"") != std::string::npos);
  assert(json.find("\"defaultRole\":\"console\"") != std::string::npos);
  assert(json.find("\"backend\":\"wasapi\"") != std::string::npos);
  assert(json.find("adapterDeviceId") == std::string::npos);
  assert(json.find("First duplicate") == std::string::npos);
  assert(json.find("Second duplicate") == std::string::npos);

  const std::string failed = windowsPcmDeviceCatalogJson({}, "catalog failed");
  assert(failed.find("\"id\":\"auto\"") != std::string::npos);
  assert(failed.find("catalog failed") != std::string::npos);
}

}  // namespace twilight::audio
