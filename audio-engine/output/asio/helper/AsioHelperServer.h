#pragma once

#include "../IAsioHost.h"
#include "AsioHelperProtocol.h"

#include <functional>
#include <memory>
#include <string>

namespace twilight::audio::asio_helper {

struct AsioHelperServerOptions {
  std::function<void(Command)> beforeCommand;
  std::function<void()> afterStart;
  std::function<void()> beforeClose;
  std::function<std::string()> closeErrorOverride;
};

int runAsioHelperServer(
    const std::wstring& mappingName,
    const std::wstring& requestEventName,
    const std::wstring& responseEventName,
    std::unique_ptr<IAsioHost> host,
    AsioHelperServerOptions options = {});

}  // namespace twilight::audio::asio_helper
