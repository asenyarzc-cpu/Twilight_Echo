#include "AsioHelperProcess.h"

#include <Windows.h>

#include <filesystem>
#include <fstream>
#include <string>

int wmain(int argc, wchar_t* argv[]) {
  if (argc != 3) return 64;
  SetEnvironmentVariableW(L"TAE_ASIO_HELPER_FIXTURE_MODE", L"normal");
  twilight::audio::asio_helper::AsioHelperProcess process(argv[1]);
  std::string error;
  if (!process.launch(&error)) return 2;
  std::ofstream output(std::filesystem::path(argv[2]), std::ios::trunc);
  if (!output) return 3;
  output << process.processId() << '\n';
  output.close();
  Sleep(INFINITE);
  return 0;
}
