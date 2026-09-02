#include "../RealAsioHost.h"
#include "AsioHelperServer.h"

#include <Windows.h>

#include <iostream>
#include <string>
#include <string_view>

namespace {

struct Arguments {
  std::wstring mapping;
  std::wstring requestEvent;
  std::wstring responseEvent;
};

bool parseArguments(int argc, wchar_t* argv[], Arguments* result) {
  if (!result || argc != 8 || std::wstring_view(argv[1]) != L"--serve") return false;
  for (int index = 2; index < argc; index += 2) {
    const std::wstring_view key(argv[index]);
    const std::wstring value(argv[index + 1]);
    if (key == L"--shared-memory") result->mapping = value;
    else if (key == L"--request-event") result->requestEvent = value;
    else if (key == L"--response-event") result->responseEvent = value;
    else return false;
  }
  return !result->mapping.empty() && !result->requestEvent.empty() && !result->responseEvent.empty();
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (argc == 2 && std::wstring_view(argv[1]) == L"--self-test") {
    std::cout << "{\"kind\":\"twilight-asio-helper\",\"protocolVersion\":1,\"status\":\"ready\"}";
    return 0;
  }
  Arguments arguments;
  if (!parseArguments(argc, argv, &arguments)) {
    std::cerr << "Usage: twilight-asio-helper --self-test | --serve --shared-memory <name> "
                 "--request-event <name> --response-event <name>";
    return 64;
  }
  return twilight::audio::asio_helper::runAsioHelperServer(
      arguments.mapping,
      arguments.requestEvent,
      arguments.responseEvent,
      twilight::audio::createRealAsioHost());
}
