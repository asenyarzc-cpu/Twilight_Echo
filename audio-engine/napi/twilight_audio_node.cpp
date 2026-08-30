#include "twilight_audio_engine.h"

#include <node_api.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

namespace {

TAE_EngineHandle g_engine = nullptr;
std::mutex g_eventMutex;
std::string g_lastError;

std::string unescapeJsonString(const std::string& value) {
  std::string out;
  out.reserve(value.size());
  bool escaped = false;
  for (char ch : value) {
    if (escaped) {
      switch (ch) {
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        default:
          out += ch;
          break;
      }
      escaped = false;
    } else if (ch == '\\') {
      escaped = true;
    } else {
      out += ch;
    }
  }
  return out;
}

std::string errorMessageFromPayload(const char* payload) {
  if (!payload) return {};
  const std::string json(payload);
  const std::string key = "\"message\":\"";
  const size_t start = json.find(key);
  if (start == std::string::npos) return json;
  const size_t valueStart = start + key.size();
  size_t end = valueStart;
  bool escaped = false;
  for (; end < json.size(); ++end) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (json[end] == '\\') {
      escaped = true;
      continue;
    }
    if (json[end] == '"') break;
  }
  return unescapeJsonString(json.substr(valueStart, end - valueStart));
}

void eventCallback(const char* eventType, const char* payloadJson, void*) {
  if (!eventType || std::string(eventType) != "error") return;
  std::lock_guard lock(g_eventMutex);
  g_lastError = errorMessageFromPayload(payloadJson);
}

void clearLastError() {
  std::lock_guard lock(g_eventMutex);
  g_lastError.clear();
}

std::string consumeLastError() {
  std::lock_guard lock(g_eventMutex);
  std::string out = g_lastError;
  g_lastError.clear();
  return out;
}

#ifdef _WIN32
constexpr DWORD kVst3ScannerTimeoutMs = 8000;
constexpr size_t kVst3ScannerOutputLimit = 512 * 1024;

struct Vst3ScannerResult {
  bool timedOut = false;
  bool outputTruncated = false;
  DWORD exitCode = static_cast<DWORD>(-1);
  std::string standardOutput;
  std::string standardError;
  std::string launchError;
};

std::string wideToUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(
      CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string output(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(
      CP_UTF8, 0, value.data(), static_cast<int>(value.size()), output.data(), size, nullptr, nullptr);
  return output;
}

std::wstring utf8ToWide(const std::string& value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) return {};
  std::wstring output(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), output.data(), size);
  return output;
}

std::string windowsErrorMessage(DWORD error) {
  LPWSTR buffer = nullptr;
  const DWORD size = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr,
      error,
      0,
      reinterpret_cast<LPWSTR>(&buffer),
      0,
      nullptr);
  if (size == 0 || !buffer) return "Windows error " + std::to_string(error);
  std::wstring message(buffer, size);
  LocalFree(buffer);
  return wideToUtf8(message);
}

std::string trimText(std::string value) {
  const auto first = std::find_if_not(value.begin(), value.end(), [](unsigned char character) {
    return std::isspace(character) != 0;
  });
  const auto last = std::find_if_not(value.rbegin(), value.rend(), [](unsigned char character) {
    return std::isspace(character) != 0;
  }).base();
  return first < last ? std::string(first, last) : std::string();
}

std::wstring quoteWindowsArgument(const std::wstring& value) {
  std::wstring quoted;
  quoted.reserve(value.size() + 2);
  quoted.push_back(L'"');
  size_t backslashes = 0;
  for (const wchar_t character : value) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(character);
      backslashes = 0;
      continue;
    }
    quoted.append(backslashes, L'\\');
    backslashes = 0;
    quoted.push_back(character);
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'"');
  return quoted;
}

std::wstring scannerHelperPath(std::string& error) {
  HMODULE addon = nullptr;
  if (!GetModuleHandleExW(
          GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
          reinterpret_cast<LPCWSTR>(scannerHelperPath),
          &addon)) {
    error = "Unable to resolve the native audio addon path: " + windowsErrorMessage(GetLastError());
    return {};
  }
  std::vector<wchar_t> path(32768, L'\0');
  const DWORD length = GetModuleFileNameW(addon, path.data(), static_cast<DWORD>(path.size()));
  if (length == 0 || length >= path.size() - 1) {
    error = "Unable to resolve the native audio addon filename: " + windowsErrorMessage(GetLastError());
    return {};
  }
  std::wstring addonPath(path.data(), length);
  const size_t separator = addonPath.find_last_of(L"\\/");
  if (separator == std::wstring::npos) {
    error = "Unable to resolve the isolated VST3 scanner directory";
    return {};
  }
  return addonPath.substr(0, separator + 1) + L"twilight-vst3-scanner.exe";
}

void drainPipe(HANDLE handle, std::string& output, bool& truncated) {
  std::array<char, 4096> buffer{};
  DWORD read = 0;
  while (ReadFile(handle, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr) && read > 0) {
    const size_t remaining = output.size() < kVst3ScannerOutputLimit
        ? kVst3ScannerOutputLimit - output.size()
        : 0;
    const size_t accepted = std::min(remaining, static_cast<size_t>(read));
    output.append(buffer.data(), accepted);
    if (accepted < read) truncated = true;
  }
  CloseHandle(handle);
}

Vst3ScannerResult runVst3Scanner(const std::string& modulePath) {
  Vst3ScannerResult result;
  const std::wstring modulePathWide = utf8ToWide(modulePath);
  if (modulePathWide.empty()) {
    result.launchError = "The VST3 module path is not valid UTF-8";
    return result;
  }

  std::string helperError;
  const std::wstring scannerPath = scannerHelperPath(helperError);
  if (scannerPath.empty()) {
    result.launchError = helperError;
    return result;
  }
  if (GetFileAttributesW(scannerPath.c_str()) == INVALID_FILE_ATTRIBUTES) {
    result.launchError = "The isolated VST3 scanner helper is missing beside twilight_audio_node.node";
    return result;
  }

  SECURITY_ATTRIBUTES security{};
  security.nLength = sizeof(security);
  security.bInheritHandle = TRUE;
  HANDLE outputRead = nullptr;
  HANDLE outputWrite = nullptr;
  HANDLE errorRead = nullptr;
  HANDLE errorWrite = nullptr;
  HANDLE nullInput = INVALID_HANDLE_VALUE;
  if (!CreatePipe(&outputRead, &outputWrite, &security, 0) ||
      !SetHandleInformation(outputRead, HANDLE_FLAG_INHERIT, 0) ||
      !CreatePipe(&errorRead, &errorWrite, &security, 0) ||
      !SetHandleInformation(errorRead, HANDLE_FLAG_INHERIT, 0)) {
    result.launchError = "Unable to create VST3 scanner pipes: " + windowsErrorMessage(GetLastError());
    if (outputRead) CloseHandle(outputRead);
    if (outputWrite) CloseHandle(outputWrite);
    if (errorRead) CloseHandle(errorRead);
    if (errorWrite) CloseHandle(errorWrite);
    return result;
  }
  nullInput = CreateFileW(
      L"NUL",
      GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      &security,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);
  if (nullInput == INVALID_HANDLE_VALUE) {
    result.launchError = "Unable to prepare VST3 scanner input: " + windowsErrorMessage(GetLastError());
    CloseHandle(outputRead);
    CloseHandle(outputWrite);
    CloseHandle(errorRead);
    CloseHandle(errorWrite);
    return result;
  }

  const std::wstring command =
      quoteWindowsArgument(scannerPath) + L" --module " + quoteWindowsArgument(modulePathWide);
  std::vector<wchar_t> mutableCommand(command.begin(), command.end());
  mutableCommand.push_back(L'\0');
  const size_t separator = scannerPath.find_last_of(L"\\/");
  const std::wstring scannerDirectory = scannerPath.substr(0, separator);
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
  startup.wShowWindow = SW_HIDE;
  startup.hStdInput = nullInput;
  startup.hStdOutput = outputWrite;
  startup.hStdError = errorWrite;
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(
          scannerPath.c_str(),
          mutableCommand.data(),
          nullptr,
          nullptr,
          TRUE,
          CREATE_NO_WINDOW,
          nullptr,
          scannerDirectory.c_str(),
          &startup,
          &process)) {
    result.launchError = "Unable to launch the isolated VST3 scanner: " + windowsErrorMessage(GetLastError());
    CloseHandle(nullInput);
    CloseHandle(outputRead);
    CloseHandle(outputWrite);
    CloseHandle(errorRead);
    CloseHandle(errorWrite);
    return result;
  }
  CloseHandle(nullInput);
  CloseHandle(outputWrite);
  CloseHandle(errorWrite);

  std::thread outputReader(drainPipe, outputRead, std::ref(result.standardOutput), std::ref(result.outputTruncated));
  std::thread errorReader(drainPipe, errorRead, std::ref(result.standardError), std::ref(result.outputTruncated));
  const DWORD waitResult = WaitForSingleObject(process.hProcess, kVst3ScannerTimeoutMs);
  if (waitResult == WAIT_TIMEOUT) {
    result.timedOut = true;
    TerminateProcess(process.hProcess, 0xC000013A);
    WaitForSingleObject(process.hProcess, 1000);
  } else if (waitResult != WAIT_OBJECT_0) {
    result.launchError = "Unable to wait for the isolated VST3 scanner: " + windowsErrorMessage(GetLastError());
  }
  GetExitCodeProcess(process.hProcess, &result.exitCode);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  outputReader.join();
  errorReader.join();
  return result;
}
#endif

napi_value makeUndefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

std::string getStringArg(napi_env env, napi_value value) {
  size_t length = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  std::vector<char> buffer(length + 1, '\0');
  napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length);
  return std::string(buffer.data(), length);
}

double getNumberArg(napi_env env, napi_value value, double fallback) {
  double out = fallback;
  napi_get_value_double(env, value, &out);
  return out;
}

bool getBoolArg(napi_env env, napi_value value, bool fallback) {
  bool out = fallback;
  napi_get_value_bool(env, value, &out);
  return out;
}

void ensureEngine() {
  if (!g_engine) {
    if (TAE_CreateEngine(&g_engine) == TAE_RESULT_OK && g_engine) {
      TAE_SetEventCallback(g_engine, eventCallback, nullptr);
    }
  }
}

napi_value throwOnError(napi_env env, TAE_Result result) {
  if (result != TAE_RESULT_OK) {
    std::string message = consumeLastError();
    if (message.empty()) {
      message = "原生音频引擎命令失败，结果码：" + std::to_string(static_cast<int>(result));
    }
    napi_throw_error(env, nullptr, message.c_str());
  }
  return makeUndefined(env);
}

napi_value readJson(napi_env env, TAE_Result (*fn)(TAE_EngineHandle, char*, size_t, size_t*)) {
  ensureEngine();
  size_t required = 0;
  fn(g_engine, nullptr, 0, &required);
  std::vector<char> buffer(required == 0 ? 1 : required);
  TAE_Result result = TAE_RESULT_OK;
  // The engine's clock thread mutates state every 100ms, so the JSON can grow
  // between the size probe and the fill; copyStringResult then reports
  // INVALID_ARGUMENT with a larger required size. Re-probe until a snapshot
  // fits — the same pattern GetVisualizationData already uses.
  for (int attempt = 0; attempt < 3; ++attempt) {
    result = fn(g_engine, buffer.data(), buffer.size(), &required);
    if (result == TAE_RESULT_OK) break;
    if (result != TAE_RESULT_INVALID_ARGUMENT || required <= buffer.size()) break;
    buffer.assign(required, '\0');
  }
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value json;
  napi_create_string_utf8(env, buffer.data(), NAPI_AUTO_LENGTH, &json);
  return json;
}

napi_value Play(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "播放需要音频地址");
    return makeUndefined(env);
  }
  const std::string source = getStringArg(env, argv[0]);
  const double start = argc > 1 ? getNumberArg(env, argv[1], 0.0) : 0.0;
  return throwOnError(env, TAE_Play(g_engine, source.c_str(), start));
}

napi_value Pause(napi_env env, napi_callback_info) {
  ensureEngine();
  clearLastError();
  return throwOnError(env, TAE_Pause(g_engine));
}

napi_value Stop(napi_env env, napi_callback_info) {
  ensureEngine();
  clearLastError();
  return throwOnError(env, TAE_Stop(g_engine));
}

napi_value Seek(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  return throwOnError(env, TAE_Seek(g_engine, argc > 0 ? getNumberArg(env, argv[0], 0.0) : 0.0));
}

napi_value SetVolume(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  return throwOnError(env, TAE_SetVolume(g_engine, argc > 0 ? getNumberArg(env, argv[0], 1.0) : 1.0));
}

napi_value SetPlaybackRate(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  return throwOnError(env, TAE_SetPlaybackRate(g_engine, argc > 0 ? getNumberArg(env, argv[0], 1.0) : 1.0));
}

napi_value SetLoopRange(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const double start = argc > 0 ? getNumberArg(env, argv[0], -1.0) : -1.0;
  const double end = argc > 1 ? getNumberArg(env, argv[1], -1.0) : -1.0;
  return throwOnError(env, TAE_SetLoopRange(g_engine, start, end));
}

napi_value SetOutputDevice(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string device = argc > 0 ? getStringArg(env, argv[0]) : "auto";
  return throwOnError(env, TAE_SetOutputDevice(g_engine, device.c_str()));
}

napi_value SetOutputBackend(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string backend = argc > 0 ? getStringArg(env, argv[0]) : "wasapi";
  return throwOnError(env, TAE_SetOutputBackend(g_engine, backend.c_str()));
}

napi_value LoadQueue(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string queue = argc > 0 ? getStringArg(env, argv[0]) : "[]";
  const int start = argc > 1 ? static_cast<int>(getNumberArg(env, argv[1], 0.0)) : 0;
  return throwOnError(env, TAE_LoadQueue(g_engine, queue.c_str(), start));
}

napi_value Next(napi_env env, napi_callback_info) {
  ensureEngine();
  clearLastError();
  return throwOnError(env, TAE_Next(g_engine));
}

napi_value Previous(napi_env env, napi_callback_info) {
  ensureEngine();
  clearLastError();
  return throwOnError(env, TAE_Previous(g_engine));
}

napi_value SetPlayMode(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string mode = argc > 0 ? getStringArg(env, argv[0]) : "sequential";
  return throwOnError(env, TAE_SetPlayMode(g_engine, mode.c_str()));
}

napi_value SetDspConfig(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string json = argc > 0 ? getStringArg(env, argv[0]) : "{}";
  return throwOnError(env, TAE_SetDspConfig(g_engine, json.c_str()));
}

napi_value SetDspGraph(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string json = argc > 0 ? getStringArg(env, argv[0]) : "{\"graph\":{\"nodes\":[]}}";
  return throwOnError(env, TAE_SetDspGraph(g_engine, json.c_str()));
}

napi_value ApplyDspState(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const double revisionValue = argc > 0 ? getNumberArg(env, argv[0], 0.0) : 0.0;
  if (!std::isfinite(revisionValue) || revisionValue <= 0.0 ||
      std::floor(revisionValue) != revisionValue) {
    napi_throw_type_error(env, "TAE_DSP_REVISION_REQUIRED", "ApplyDspState requires a positive integer revision");
    return makeUndefined(env);
  }
  const std::string json = argc > 1 ? getStringArg(env, argv[1]) : "{}";
  return throwOnError(
      env,
      TAE_ApplyDspState(g_engine, static_cast<uint64_t>(revisionValue), json.c_str()));
}

napi_value GetDspGraphStatus(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetDspGraphStatus);
}

napi_value ScanVst3Module(napi_env env, napi_callback_info info) {
#ifdef _WIN32
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, "TAE_VST3_MODULE_REQUIRED", "VST3 scanning requires a module path");
    return makeUndefined(env);
  }
  const std::string modulePath = getStringArg(env, argv[0]);
  if (modulePath.empty()) {
    napi_throw_type_error(env, "TAE_VST3_MODULE_REQUIRED", "VST3 module path must not be empty");
    return makeUndefined(env);
  }

  const Vst3ScannerResult result = runVst3Scanner(modulePath);
  if (!result.launchError.empty()) {
    napi_throw_error(env, "TAE_VST3_SCANNER_UNAVAILABLE", result.launchError.c_str());
    return makeUndefined(env);
  }
  if (result.timedOut) {
    napi_throw_error(env, "TAE_VST3_SCAN_TIMEOUT", "The isolated VST3 scanner exceeded its 8 second limit");
    return makeUndefined(env);
  }
  if (result.outputTruncated) {
    napi_throw_error(env, "TAE_VST3_SCAN_OUTPUT_LIMIT", "The isolated VST3 scanner exceeded its output limit");
    return makeUndefined(env);
  }
  if (result.exitCode != 0) {
    const std::string detail = trimText(
        result.standardError.empty() ? result.standardOutput : result.standardError);
    const std::string message = "The isolated VST3 scanner exited with code " +
        std::to_string(result.exitCode) + (detail.empty() ? std::string() : ": " + detail);
    napi_throw_error(env, "TAE_VST3_SCAN_FAILED", message.c_str());
    return makeUndefined(env);
  }
  const std::string output = trimText(result.standardOutput);
  if (output.empty()) {
    napi_throw_error(env, "TAE_VST3_SCAN_EMPTY", "The isolated VST3 scanner returned no descriptor");
    return makeUndefined(env);
  }
  napi_value descriptor;
  napi_create_string_utf8(env, output.c_str(), output.size(), &descriptor);
  return descriptor;
#else
  napi_throw_error(
      env,
      "TAE_VST3_UNSUPPORTED",
      "VST3 scanning is unavailable: this audio-engine build does not include the isolated VST3 scanner helper");
  return makeUndefined(env);
#endif
}

napi_value SetOutputConfig(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string json = argc > 0 ? getStringArg(env, argv[0]) : "{}";
  return throwOnError(env, TAE_SetOutputConfig(g_engine, json.c_str()));
}

napi_value LoadImpulseResponse(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "加载脉冲响应需要文件路径");
    return makeUndefined(env);
  }
  const std::string path = getStringArg(env, argv[0]);
  return throwOnError(env, TAE_LoadImpulseResponse(g_engine, path.c_str()));
}

napi_value UnloadImpulseResponse(napi_env env, napi_callback_info) {
  ensureEngine();
  clearLastError();
  return throwOnError(env, TAE_UnloadImpulseResponse(g_engine));
}

napi_value GetConvolverInfo(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetConvolverInfo);
}

napi_value SetEqBands(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string json = argc > 0 ? getStringArg(env, argv[0]) : "{}";
  return throwOnError(env, TAE_SetEqBands(g_engine, json.c_str()));
}

napi_value SetEqPreset(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string json = argc > 0 ? getStringArg(env, argv[0]) : "{}";
  return throwOnError(env, TAE_SetEqPreset(g_engine, json.c_str()));
}

napi_value SetCrossfeedStrength(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const double strength = argc > 0 ? getNumberArg(env, argv[0], 0.0) : 0.0;
  return throwOnError(env, TAE_SetCrossfeedStrength(g_engine, strength));
}

napi_value SetReplayGainMode(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string mode = argc > 0 ? getStringArg(env, argv[0]) : "off";
  const double preamp = argc > 1 ? getNumberArg(env, argv[1], 0.0) : 0.0;
  const double fallback = argc > 2 ? getNumberArg(env, argv[2], 0.0) : 0.0;
  const bool clip = argc > 3 ? getBoolArg(env, argv[3], true) : true;
  return throwOnError(env, TAE_SetReplayGainMode(g_engine, mode.c_str(), preamp, fallback, clip ? 1 : 0));
}

napi_value SetDspPluginChain(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string json = argc > 0 ? getStringArg(env, argv[0]) : "{\"plugins\":[]}";
  return throwOnError(env, TAE_SetDspPluginChain(g_engine, json.c_str()));
}

napi_value GetDspPluginStatus(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetDspPluginStatus);
}

napi_value GetMetadata(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "读取元数据需要音频地址");
    return makeUndefined(env);
  }
  const std::string source = getStringArg(env, argv[0]);
  size_t required = 0;
  TAE_GetMetadata(g_engine, source.c_str(), nullptr, 0, &required);
  std::vector<char> buffer(required == 0 ? 1 : required);
  TAE_Result result = TAE_RESULT_OK;
  // Same probe/fill growth race as readJson: retry while the snapshot grew.
  for (int attempt = 0; attempt < 3; ++attempt) {
    result = TAE_GetMetadata(g_engine, source.c_str(), buffer.data(), buffer.size(), &required);
    if (result == TAE_RESULT_OK) break;
    if (result != TAE_RESULT_INVALID_ARGUMENT || required <= buffer.size()) break;
    buffer.assign(required, '\0');
  }
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value json;
  napi_create_string_utf8(env, buffer.data(), NAPI_AUTO_LENGTH, &json);
  return json;
}

napi_value GetPlaybackInfo(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetPlaybackInfo);
}

napi_value GetDiagnosticLog(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const double sinceRaw = argc > 0 ? getNumberArg(env, argv[0], 0.0) : 0.0;
  const double maxRaw = argc > 1 ? getNumberArg(env, argv[1], 0.0) : 0.0;
  const auto sinceSequence = static_cast<uint64_t>(sinceRaw > 0 ? sinceRaw : 0);
  const auto maxEntries = static_cast<size_t>(maxRaw > 0 ? maxRaw : 0);
  size_t required = 0;
  uint64_t nextSequence = 0;
  TAE_GetDiagnosticLog(g_engine, sinceSequence, maxEntries, nullptr, 0, &required, &nextSequence);
  std::vector<char> buffer(required == 0 ? 1 : required);
  TAE_Result result = TAE_RESULT_OK;
  // New entries can land between the size probe and the fill; re-probe until a
  // snapshot fits, mirroring readJson.
  for (int attempt = 0; attempt < 3; ++attempt) {
    result = TAE_GetDiagnosticLog(
        g_engine, sinceSequence, maxEntries, buffer.data(), buffer.size(), &required, &nextSequence);
    if (result == TAE_RESULT_OK) break;
    if (result != TAE_RESULT_INVALID_ARGUMENT || required <= buffer.size()) break;
    buffer.assign(required, '\0');
  }
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value json;
  napi_create_string_utf8(env, buffer.data(), NAPI_AUTO_LENGTH, &json);
  return json;
}

napi_value GetQueue(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetQueue);
}

napi_value GetUpcomingTrack(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetUpcomingTrack);
}

napi_value GetDspConfig(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetDspConfig);
}

napi_value EnumerateDevices(napi_env env, napi_callback_info) {
  return readJson(env, TAE_EnumerateDevices);
}

napi_value EnumerateBackends(napi_env env, napi_callback_info) {
  return readJson(env, TAE_EnumerateBackends);
}

napi_value GetEngineCapabilities(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetEngineCapabilities);
}

napi_value GetLastError(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetLastError);
}

napi_value GetSpectrumData(napi_env env, napi_callback_info info) {
  ensureEngine();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const size_t points = argc > 0 ? static_cast<size_t>(getNumberArg(env, argv[0], 64.0)) : 64;
  std::vector<float> spectrum(points);
  size_t written = 0;
  TAE_GetSpectrumData(g_engine, spectrum.data(), spectrum.size(), &written);
  napi_value array;
  napi_create_array_with_length(env, written, &array);
  for (size_t i = 0; i < written; ++i) {
    napi_value value;
    napi_create_double(env, spectrum[i], &value);
    napi_set_element(env, array, static_cast<uint32_t>(i), value);
  }
  return array;
}

napi_value GetVisualizationData(napi_env env, napi_callback_info info) {
  ensureEngine();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string options = argc > 0 ? getStringArg(env, argv[0]) : "{}";
  size_t required = 0;
  std::vector<char> buffer(65536);
  TAE_Result result = TAE_GetVisualizationData(g_engine, options.c_str(), buffer.data(), buffer.size(), &required);
  if (result == TAE_RESULT_INVALID_ARGUMENT && required > buffer.size()) {
    buffer.assign(required, '\0');
    result = TAE_GetVisualizationData(g_engine, options.c_str(), buffer.data(), buffer.size(), &required);
  }
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value json;
  napi_create_string_utf8(env, buffer.data(), NAPI_AUTO_LENGTH, &json);
  return json;
}

napi_value AnalyzeBpm(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "BPM 分析需要音频文件路径");
    return makeUndefined(env);
  }
  const std::string source = getStringArg(env, argv[0]);
  const std::string options = argc > 1 ? getStringArg(env, argv[1]) : "{}";
  size_t required = 0;
  TAE_AnalyzeBpm(g_engine, source.c_str(), options.c_str(), nullptr, 0, &required);
  std::vector<char> buffer(required == 0 ? 1 : required);
  const TAE_Result result = TAE_AnalyzeBpm(g_engine, source.c_str(), options.c_str(), buffer.data(), buffer.size(), &required);
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value json;
  napi_create_string_utf8(env, buffer.data(), NAPI_AUTO_LENGTH, &json);
  return json;
}

napi_value AnalyzeLoudness(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "响度分析需要音频文件路径");
    return makeUndefined(env);
  }
  const std::string source = getStringArg(env, argv[0]);
  const std::string options = argc > 1 ? getStringArg(env, argv[1]) : "{}";
  size_t required = 0;
  TAE_AnalyzeLoudness(g_engine, source.c_str(), options.c_str(), nullptr, 0, &required);
  std::vector<char> buffer(required == 0 ? 1 : required);
  const TAE_Result result =
      TAE_AnalyzeLoudness(g_engine, source.c_str(), options.c_str(), buffer.data(), buffer.size(), &required);
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value json;
  napi_create_string_utf8(env, buffer.data(), NAPI_AUTO_LENGTH, &json);
  return json;
}

void cleanup(void*) {
  if (g_engine) {
    TAE_DestroyEngine(g_engine);
    g_engine = nullptr;
  }
}

void define(napi_env env, napi_value exports, const char* name, napi_callback callback) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &fn);
  napi_set_named_property(env, exports, name, fn);
}

napi_value Init(napi_env env, napi_value exports) {
  napi_add_env_cleanup_hook(env, cleanup, nullptr);
  define(env, exports, "Play", Play);
  define(env, exports, "Pause", Pause);
  define(env, exports, "Stop", Stop);
  define(env, exports, "Seek", Seek);
  define(env, exports, "SetVolume", SetVolume);
  define(env, exports, "SetPlaybackRate", SetPlaybackRate);
  define(env, exports, "SetLoopRange", SetLoopRange);
  define(env, exports, "SetOutputDevice", SetOutputDevice);
  define(env, exports, "SetOutputBackend", SetOutputBackend);
  define(env, exports, "LoadQueue", LoadQueue);
  define(env, exports, "Next", Next);
  define(env, exports, "Previous", Previous);
  define(env, exports, "SetPlayMode", SetPlayMode);
  define(env, exports, "SetDspConfig", SetDspConfig);
  define(env, exports, "SetDspGraph", SetDspGraph);
  define(env, exports, "ApplyDspState", ApplyDspState);
  define(env, exports, "GetDspGraphStatus", GetDspGraphStatus);
  define(env, exports, "ScanVst3Module", ScanVst3Module);
  define(env, exports, "SetOutputConfig", SetOutputConfig);
  define(env, exports, "LoadImpulseResponse", LoadImpulseResponse);
  define(env, exports, "UnloadImpulseResponse", UnloadImpulseResponse);
  define(env, exports, "GetConvolverInfo", GetConvolverInfo);
  define(env, exports, "SetEqBands", SetEqBands);
  define(env, exports, "SetEqPreset", SetEqPreset);
  define(env, exports, "SetCrossfeedStrength", SetCrossfeedStrength);
  define(env, exports, "SetReplayGainMode", SetReplayGainMode);
  define(env, exports, "SetDspPluginChain", SetDspPluginChain);
  define(env, exports, "GetDspPluginStatus", GetDspPluginStatus);
  define(env, exports, "GetMetadata", GetMetadata);
  define(env, exports, "GetPlaybackInfo", GetPlaybackInfo);
  define(env, exports, "GetDiagnosticLog", GetDiagnosticLog);
  define(env, exports, "GetQueue", GetQueue);
  define(env, exports, "GetUpcomingTrack", GetUpcomingTrack);
  define(env, exports, "GetDspConfig", GetDspConfig);
  define(env, exports, "EnumerateDevices", EnumerateDevices);
  define(env, exports, "EnumerateBackends", EnumerateBackends);
  define(env, exports, "GetEngineCapabilities", GetEngineCapabilities);
  define(env, exports, "GetLastError", GetLastError);
  define(env, exports, "GetSpectrumData", GetSpectrumData);
  define(env, exports, "GetVisualizationData", GetVisualizationData);
  define(env, exports, "AnalyzeBpm", AnalyzeBpm);
  define(env, exports, "AnalyzeLoudness", AnalyzeLoudness);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
