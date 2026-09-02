#include "AsioHelperProcess.h"

#include <Windows.h>

#include <array>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <string_view>
#include <thread>
#include <vector>

namespace twilight::audio::asio_helper {
namespace {

std::atomic<uint64_t> processSerial{1};

std::string wideToUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(
      CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string output(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(
      CP_UTF8,
      0,
      value.data(),
      static_cast<int>(value.size()),
      output.data(),
      size,
      nullptr,
      nullptr);
  return output;
}

std::string windowsError(DWORD value) {
  LPWSTR buffer = nullptr;
  const DWORD size = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr,
      value,
      0,
      reinterpret_cast<LPWSTR>(&buffer),
      0,
      nullptr);
  if (size == 0 || !buffer) return "Windows error " + std::to_string(value);
  std::wstring message(buffer, size);
  LocalFree(buffer);
  while (!message.empty() && (message.back() == L'\r' || message.back() == L'\n' || message.back() == L' ')) {
    message.pop_back();
  }
  return wideToUtf8(message);
}

std::wstring quoteWindowsArgument(const std::wstring& value) {
  std::wstring quoted;
  quoted.reserve(value.size() + 2);
  quoted.push_back(L'"');
  size_t slashCount = 0;
  for (const wchar_t character : value) {
    if (character == L'\\') {
      ++slashCount;
      continue;
    }
    if (character == L'"') {
      quoted.append(slashCount * 2 + 1, L'\\');
      quoted.push_back(character);
      slashCount = 0;
      continue;
    }
    quoted.append(slashCount, L'\\');
    slashCount = 0;
    quoted.push_back(character);
  }
  quoted.append(slashCount * 2, L'\\');
  quoted.push_back(L'"');
  return quoted;
}

std::wstring environmentHelperPath() {
  std::array<wchar_t, 32768> value{};
  const DWORD length = GetEnvironmentVariableW(
      L"TAE_ASIO_HELPER_PATH", value.data(), static_cast<DWORD>(value.size()));
  if (length == 0 || length >= value.size()) return {};
  return std::wstring(value.data(), length);
}

}  // namespace

std::wstring locateAsioHelperExecutable(std::string* error) {
  const std::wstring overridePath = environmentHelperPath();
  if (!overridePath.empty()) return overridePath;
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(
          GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
          reinterpret_cast<LPCWSTR>(locateAsioHelperExecutable),
          &module)) {
    if (error) *error = "Unable to locate the audio engine module: " + windowsError(GetLastError());
    return {};
  }
  std::array<wchar_t, 32768> path{};
  const DWORD length = GetModuleFileNameW(module, path.data(), static_cast<DWORD>(path.size()));
  if (length == 0 || length >= path.size() - 1) {
    if (error) *error = "Unable to locate the audio engine directory: " + windowsError(GetLastError());
    return {};
  }
  std::wstring modulePath(path.data(), length);
  const size_t separator = modulePath.find_last_of(L"\\/");
  if (separator == std::wstring::npos) {
    if (error) *error = "Unable to locate the ASIO helper directory";
    return {};
  }
  return modulePath.substr(0, separator + 1) + L"twilight-asio-helper.exe";
}

AsioHelperProcess::AsioHelperProcess(std::wstring executablePath)
    : executablePath_(std::move(executablePath)) {}

AsioHelperProcess::~AsioHelperProcess() {
  shutdown();
  releaseHandles();
}

bool AsioHelperProcess::launch(std::string* error) {
  std::lock_guard lock(requestMutex_);
  if (alive() && shared_) return true;
  releaseHandles();
  failureReason_.store(FailureReason::None, std::memory_order_release);
  {
    std::lock_guard failureLock(failureMutex_);
    lastFailure_.clear();
  }
  if (executablePath_.empty() || GetFileAttributesW(executablePath_.c_str()) == INVALID_FILE_ATTRIBUTES) {
    const std::string detail = "The isolated ASIO helper is missing beside the audio engine";
    publishFailure(FailureReason::LaunchFailed, detail);
    if (error) *error = failureMessage(FailureReason::LaunchFailed, detail);
    return false;
  }

  const uint64_t serial = processSerial.fetch_add(1, std::memory_order_relaxed);
  const std::wstring suffix = std::to_wstring(GetCurrentProcessId()) + L"_" + std::to_wstring(serial);
  const std::wstring mappingName = L"Local\\TwilightEchoAsioMap_" + suffix;
  const std::wstring requestEventName = L"Local\\TwilightEchoAsioRequest_" + suffix;
  const std::wstring responseEventName = L"Local\\TwilightEchoAsioResponse_" + suffix;

  mapping_ = CreateFileMappingW(
      INVALID_HANDLE_VALUE,
      nullptr,
      PAGE_READWRITE,
      0,
      static_cast<DWORD>(sizeof(SharedMemory)),
      mappingName.c_str());
  if (!mapping_) {
    const std::string detail = "Unable to create ASIO helper shared memory: " + windowsError(GetLastError());
    publishFailure(FailureReason::LaunchFailed, detail);
    if (error) *error = failureMessage(FailureReason::LaunchFailed, detail);
    releaseHandles();
    return false;
  }
  shared_ = static_cast<SharedMemory*>(
      MapViewOfFile(mapping_, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedMemory)));
  if (!shared_) {
    const std::string detail = "Unable to map ASIO helper shared memory: " + windowsError(GetLastError());
    publishFailure(FailureReason::LaunchFailed, detail);
    if (error) *error = failureMessage(FailureReason::LaunchFailed, detail);
    releaseHandles();
    return false;
  }
  std::memset(shared_, 0, sizeof(*shared_));
  shared_->magic = kProtocolMagic;
  shared_->version = kProtocolVersion;
  shared_->structureBytes = sizeof(SharedMemory);
  exchangeAtomic(&shared_->helperState, static_cast<LONG>(HelperState::Initializing));

  requestEvent_ = CreateEventW(nullptr, FALSE, FALSE, requestEventName.c_str());
  responseEvent_ = CreateEventW(nullptr, FALSE, FALSE, responseEventName.c_str());
  if (!requestEvent_ || !responseEvent_) {
    const std::string detail = "Unable to create ASIO helper control events: " + windowsError(GetLastError());
    publishFailure(FailureReason::LaunchFailed, detail);
    if (error) *error = failureMessage(FailureReason::LaunchFailed, detail);
    releaseHandles();
    return false;
  }

  job_ = CreateJobObjectW(nullptr, nullptr);
  if (!job_) {
    const std::string detail =
        "Unable to create the ASIO helper lifetime job: " + windowsError(GetLastError());
    publishFailure(FailureReason::LaunchFailed, detail);
    if (error) *error = failureMessage(FailureReason::LaunchFailed, detail);
    releaseHandles();
    return false;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobLimits{};
  jobLimits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(
          job_,
          JobObjectExtendedLimitInformation,
          &jobLimits,
          sizeof(jobLimits))) {
    const std::string detail =
        "Unable to configure the ASIO helper lifetime job: " + windowsError(GetLastError());
    publishFailure(FailureReason::LaunchFailed, detail);
    if (error) *error = failureMessage(FailureReason::LaunchFailed, detail);
    releaseHandles();
    return false;
  }

  std::wstring command = quoteWindowsArgument(executablePath_) + L" --serve --shared-memory " +
      quoteWindowsArgument(mappingName) + L" --request-event " + quoteWindowsArgument(requestEventName) +
      L" --response-event " + quoteWindowsArgument(responseEventName);
  std::vector<wchar_t> commandBuffer(command.begin(), command.end());
  commandBuffer.push_back(L'\0');
  const size_t separator = executablePath_.find_last_of(L"\\/");
  const std::wstring directory = separator == std::wstring::npos ? L"" : executablePath_.substr(0, separator);
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(
          executablePath_.c_str(),
          commandBuffer.data(),
          nullptr,
          nullptr,
          FALSE,
          CREATE_NO_WINDOW | CREATE_SUSPENDED,
          nullptr,
          directory.empty() ? nullptr : directory.c_str(),
          &startup,
          &process)) {
    const std::string detail = "Unable to launch the isolated ASIO helper: " + windowsError(GetLastError());
    publishFailure(FailureReason::LaunchFailed, detail);
    if (error) *error = failureMessage(FailureReason::LaunchFailed, detail);
    releaseHandles();
    return false;
  }
  process_ = process.hProcess;
  if (!AssignProcessToJobObject(job_, process_)) {
    const std::string detail =
        "Unable to bind the ASIO helper to its lifetime job: " + windowsError(GetLastError());
    TerminateProcess(process_, 0xC000013A);
    WaitForSingleObject(process_, 500);
    CloseHandle(process.hThread);
    publishFailure(FailureReason::LaunchFailed, detail);
    if (error) *error = failureMessage(FailureReason::LaunchFailed, detail);
    releaseHandles();
    return false;
  }
  if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
    const std::string detail =
        "Unable to start the isolated ASIO helper: " + windowsError(GetLastError());
    TerminateProcess(process_, 0xC000013A);
    WaitForSingleObject(process_, 500);
    CloseHandle(process.hThread);
    publishFailure(FailureReason::LaunchFailed, detail);
    if (error) *error = failureMessage(FailureReason::LaunchFailed, detail);
    releaseHandles();
    return false;
  }
  CloseHandle(process.hThread);

  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (std::chrono::steady_clock::now() < deadline) {
    const HelperState state = static_cast<HelperState>(readAtomic(&shared_->helperState));
    if (state == HelperState::Ready) {
      nextRequestSequence_ = 1;
      return true;
    }
    if (state == HelperState::Failed || WaitForSingleObject(process_, 0) == WAIT_OBJECT_0) {
      const FailureReason reason = state == HelperState::Failed
          ? static_cast<FailureReason>(readAtomic(&shared_->failureReason))
          : FailureReason::ProcessExited;
      const std::string detail = readText(shared_->statusMessage);
      publishFailure(reason == FailureReason::None ? FailureReason::ProtocolError : reason, detail);
      if (alive()) {
        TerminateProcess(process_, 0xC000013A);
        WaitForSingleObject(process_, 500);
      }
      if (error) *error = lastFailure();
      return false;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  const std::string detail = "ASIO helper did not complete its handshake within 5 seconds";
  publishFailure(FailureReason::ControlTimeout, detail);
  TerminateProcess(process_, 0xC000013A);
  WaitForSingleObject(process_, 500);
  if (error) *error = failureMessage(FailureReason::ControlTimeout, detail);
  return false;
}

bool AsioHelperProcess::request(
    Command command,
    const std::function<void(Request&)>& prepare,
    Response* response,
    std::chrono::milliseconds timeout,
    std::string* error) {
  std::lock_guard lock(requestMutex_);
  if (!shared_ || !alive() || readAtomic(&shared_->helperState) != static_cast<LONG>(HelperState::Ready)) {
    const FailureReason reason = failureReason() == FailureReason::None
        ? FailureReason::ProcessExited
        : failureReason();
    const std::string detail = lastFailure().empty() ? "ASIO helper is unavailable" : lastFailure();
    if (error) *error = failureMessage(reason, detail);
    return false;
  }

  const int32_t sequence = nextRequestSequence_++;
  shared_->request = {};
  shared_->response = {};
  shared_->request.command = static_cast<int32_t>(command);
  if (prepare) prepare(shared_->request);
  MemoryBarrier();
  exchangeAtomic(&shared_->requestSequence, sequence);
  if (!SetEvent(requestEvent_)) {
    const std::string detail = "Unable to signal the ASIO helper request: " + windowsError(GetLastError());
    abort(FailureReason::CommandFailed, detail);
    if (error) *error = failureMessage(FailureReason::CommandFailed, detail);
    return false;
  }

  const auto deadline = std::chrono::steady_clock::now() + timeout;
  HANDLE waits[] = {responseEvent_, process_};
  while (std::chrono::steady_clock::now() < deadline) {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
        deadline - std::chrono::steady_clock::now());
    const DWORD wait = WaitForMultipleObjects(
        static_cast<DWORD>(std::size(waits)),
        waits,
        FALSE,
        static_cast<DWORD>(std::max<int64_t>(1, remaining.count())));
    if (wait == WAIT_OBJECT_0 + 1) {
      const std::string detail = "ASIO helper exited while processing a control command";
      publishFailure(FailureReason::ProcessExited, detail);
      if (error) *error = failureMessage(FailureReason::ProcessExited, detail);
      return false;
    }
    if (wait == WAIT_FAILED) {
      const std::string detail = "ASIO helper control wait failed: " + windowsError(GetLastError());
      abort(FailureReason::CommandFailed, detail);
      if (error) *error = failureMessage(FailureReason::CommandFailed, detail);
      return false;
    }
    if (wait == WAIT_TIMEOUT) break;
    if (readAtomic(&shared_->responseSequence) != sequence) continue;
    MemoryBarrier();
    const Response result = shared_->response;
    if (response) *response = result;
    if (result.ok != 0) return true;
    FailureReason reason = static_cast<FailureReason>(result.failureReason);
    if (reason < FailureReason::None || reason > FailureReason::CommandFailed) {
      reason = FailureReason::ProtocolError;
    }
    const std::string detail = readText(result.message);
    if (reason == FailureReason::ProtocolError) abort(reason, detail);
    if (error) *error = failureMessage(reason, detail);
    return false;
  }

  const std::string detail = "ASIO helper control command timed out";
  publishFailure(FailureReason::ControlTimeout, detail);
  TerminateProcess(process_, 0xC000013A);
  WaitForSingleObject(process_, 500);
  if (error) *error = failureMessage(FailureReason::ControlTimeout, detail);
  return false;
}

bool AsioHelperProcess::request(
    Command command,
    Response* response,
    std::chrono::milliseconds timeout,
    std::string* error) {
  return request(command, {}, response, timeout, error);
}

void AsioHelperProcess::abort(FailureReason reason, const std::string& detail) {
  publishFailure(reason, detail);
  if (process_ && WaitForSingleObject(process_, 0) == WAIT_TIMEOUT) {
    TerminateProcess(process_, 0xC000013A);
    WaitForSingleObject(process_, 500);
  }
}

void AsioHelperProcess::shutdown() {
  if (!process_) return;
  if (alive() && shared_ &&
      readAtomic(&shared_->helperState) == static_cast<LONG>(HelperState::Ready)) {
    Response response;
    std::string ignored;
    request(Command::Shutdown, &response, std::chrono::seconds(3), &ignored);
  }
  if (alive()) {
    if (WaitForSingleObject(process_, 500) == WAIT_TIMEOUT) {
      TerminateProcess(process_, 0xC000013A);
      WaitForSingleObject(process_, 500);
    }
  }
}

bool AsioHelperProcess::alive() const noexcept {
  return process_ && WaitForSingleObject(process_, 0) == WAIT_TIMEOUT;
}

DWORD AsioHelperProcess::processId() const noexcept {
  return process_ ? GetProcessId(process_) : 0;
}

SharedMemory* AsioHelperProcess::shared() const noexcept {
  return shared_;
}

FailureReason AsioHelperProcess::failureReason() const noexcept {
  return failureReason_.load(std::memory_order_acquire);
}

std::string AsioHelperProcess::lastFailure() const {
  std::lock_guard lock(failureMutex_);
  return lastFailure_;
}

const std::wstring& AsioHelperProcess::executablePath() const noexcept {
  return executablePath_;
}

void AsioHelperProcess::publishFailure(FailureReason reason, const std::string& detail) {
  failureReason_.store(reason, std::memory_order_release);
  const std::string message = failureMessage(reason, detail);
  {
    std::lock_guard lock(failureMutex_);
    lastFailure_ = message;
  }
  if (!shared_) return;
  copyText(shared_->statusMessage, sizeof(shared_->statusMessage), detail);
  exchangeAtomic(&shared_->failureReason, static_cast<LONG>(reason));
  MemoryBarrier();
  exchangeAtomic(&shared_->helperState, static_cast<LONG>(HelperState::Failed));
}

void AsioHelperProcess::releaseHandles() {
  if (process_) CloseHandle(process_);
  if (job_) CloseHandle(job_);
  if (responseEvent_) CloseHandle(responseEvent_);
  if (requestEvent_) CloseHandle(requestEvent_);
  if (shared_) UnmapViewOfFile(shared_);
  if (mapping_) CloseHandle(mapping_);
  process_ = nullptr;
  job_ = nullptr;
  responseEvent_ = nullptr;
  requestEvent_ = nullptr;
  shared_ = nullptr;
  mapping_ = nullptr;
}

}  // namespace twilight::audio::asio_helper
