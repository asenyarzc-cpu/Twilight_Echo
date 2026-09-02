#pragma once

#include "AsioHelperProtocol.h"

#include <Windows.h>

#include <atomic>
#include <chrono>
#include <functional>
#include <mutex>
#include <string>

namespace twilight::audio::asio_helper {

class AsioHelperProcess final {
 public:
  explicit AsioHelperProcess(std::wstring executablePath);
  ~AsioHelperProcess();

  AsioHelperProcess(const AsioHelperProcess&) = delete;
  AsioHelperProcess& operator=(const AsioHelperProcess&) = delete;

  bool launch(std::string* error);
  bool request(
      Command command,
      const std::function<void(Request&)>& prepare,
      Response* response,
      std::chrono::milliseconds timeout,
      std::string* error);
  bool request(
      Command command,
      Response* response,
      std::chrono::milliseconds timeout,
      std::string* error);
  void abort(FailureReason reason, const std::string& detail);
  void shutdown();

  bool alive() const noexcept;
  DWORD processId() const noexcept;
  SharedMemory* shared() const noexcept;
  FailureReason failureReason() const noexcept;
  std::string lastFailure() const;
  const std::wstring& executablePath() const noexcept;

 private:
  void releaseHandles();
  void publishFailure(FailureReason reason, const std::string& detail);

  std::wstring executablePath_;
  HANDLE mapping_ = nullptr;
  HANDLE requestEvent_ = nullptr;
  HANDLE responseEvent_ = nullptr;
  HANDLE job_ = nullptr;
  HANDLE process_ = nullptr;
  SharedMemory* shared_ = nullptr;
  std::atomic<FailureReason> failureReason_{FailureReason::None};
  mutable std::mutex failureMutex_;
  std::string lastFailure_;
  std::mutex requestMutex_;
  int32_t nextRequestSequence_ = 1;
};

std::wstring locateAsioHelperExecutable(std::string* error);

}  // namespace twilight::audio::asio_helper
