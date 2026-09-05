/*
 * Twilight Echo SMTC (System Media Transport Controls) Node-API addon.
 *
 * Windows-only: registers a hidden worker window for thread dispatch and binds
 * Windows.Media SystemMediaTransportControls to the Electron BrowserWindow
 * HWND when one is supplied (falling back to the hidden HWND for standalone
 * smoke tests).
 * The renderer/main process pushes playback metadata + timeline through
 * Update(); button/seek/shuffle/repeat requests are delivered back to JS
 * through a thread-safe N-API callback.
 *
 * Built with MSVC + WRL against the Windows SDK ABI headers (no C++/WinRT
 * dependency). The N-API entry points are resolved dynamically at load time,
 * matching the audio-engine Node addon, so no node.lib link is required.
 */

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <windows.media.h>
#include <propkey.h>
#include <shellapi.h>
#include <shobjidl.h>
#include <systemmediatransportcontrolsinterop.h>
#include <wrl.h>
#include <wrl/client.h>
#include <node_api.h>

#include <atomic>
#include <cstdio>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using namespace ABI::Windows::Foundation;
using namespace ABI::Windows::Media;
using namespace ABI::Windows::Storage::Streams;
using namespace Microsoft::WRL;
using namespace Microsoft::WRL::Wrappers;

namespace {

constexpr wchar_t kWindowClassName[] = L"TwilightEchoSmtcWindow";
constexpr wchar_t kWindowTitle[] = L"Twilight Echo SMTC";
constexpr UINT kUpdateMessage = WM_APP + 1;
constexpr DWORD kCreateTimeoutMs = 5000;
constexpr double kTimelineEpsilonSeconds = 0.25;

struct SmtcUpdate {
  bool enabled = false;
  bool hasTrack = false;
  bool isPlaying = false;
  bool isLoading = false;
  bool canNext = false;
  bool canPrevious = false;
  bool shuffle = false;
  int autoRepeatMode = 0;  // 0 none, 1 track, 2 list
  double positionSeconds = 0.0;
  double durationSeconds = 0.0;
  double playbackRate = 1.0;
  std::wstring title;
  std::wstring artist;
  std::wstring album;
  std::wstring albumArtist;
  int trackNumber = 0;
  std::wstring coverUri;
};

struct SmtcEvent {
  std::string type;  // button | position | shuffle | repeat
  std::string button;
  double positionSeconds = 0.0;
  bool shuffle = false;
  int autoRepeatMode = 0;
};

class SmtcSession {
 public:
  // Main-thread (N-API) state.
  napi_env env = nullptr;
  napi_threadsafe_function tsfn = nullptr;

  // Cross-thread handshake.
  HANDLE readyEvent = nullptr;
  std::atomic<bool> initOk{false};
  std::atomic<long> initHr{S_OK};
  std::atomic<const char*> initStage{"not-started"};

  // `targetHwnd` is captured before the worker starts. `messageHwnd` belongs to
  // the worker STA and is used only to marshal Update/Destroy requests.
  HWND targetHwnd = nullptr;
  HWND messageHwnd = nullptr;
  std::wstring appUserModelId;
  std::thread worker;
  ComPtr<ISystemMediaTransportControls> controls;
  ComPtr<ISystemMediaTransportControls2> controls2;
  ComPtr<ISystemMediaTransportControlsDisplayUpdater> display;
  ComPtr<IMusicDisplayProperties> musicProperties;
  ComPtr<IMusicDisplayProperties2> musicProperties2;
  EventRegistrationToken buttonToken{};
  EventRegistrationToken positionToken{};
  EventRegistrationToken shuffleToken{};
  EventRegistrationToken repeatToken{};
  std::wstring lastMetadataKey;
  double lastPositionSeconds = -1.0;
  double lastDurationSeconds = -1.0;
};

SmtcSession g_session;
std::mutex g_eventMutex;

std::wstring utf8ToWide(const std::string& value) {
  if (value.empty()) return {};
  const int size =
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) return {};
  std::wstring output(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                      static_cast<int>(value.size()), output.data(), size);
  return output;
}

TimeSpan secondsToTimeSpan(double seconds) {
  constexpr double kMaxMicroseconds =
      static_cast<double>(std::numeric_limits<int64_t>::max() / 10);
  double microseconds = seconds * 1e6;
  if (!std::isfinite(microseconds) || microseconds < 0) microseconds = 0;
  if (microseconds > kMaxMicroseconds) microseconds = kMaxMicroseconds;
  return TimeSpan{static_cast<int64_t>(microseconds * 10.0)};
}

void CallJsEvent(napi_env env, napi_value jsCallback, void* context, void* data);

void QueueEvent(SmtcEvent event) {
  napi_threadsafe_function tsfn = g_session.tsfn;
  if (!tsfn) return;
  auto* payload = new SmtcEvent(std::move(event));
  const napi_status status =
      napi_call_threadsafe_function(tsfn, payload, napi_tsfn_blocking);
  if (status != napi_ok) delete payload;
}

void UpdateMetadata(const SmtcUpdate& update) {
  if (!g_session.display) return;
  std::wstring key = update.title + L"|" + update.artist + L"|" + update.album +
                     L"|" + update.albumArtist + L"|" +
                     std::to_wstring(update.trackNumber) + L"|" + update.coverUri;
  if (key == g_session.lastMetadataKey) return;
  g_session.lastMetadataKey = key;

  g_session.display->ClearAll();
  if (FAILED(g_session.display->put_Type(MediaPlaybackType_Music))) return;
  // ClearAll invalidates type-specific display properties on some Windows
  // builds. Reacquire the music property interfaces before writing metadata so
  // track changes never keep a stale COM object from the previous item.
  g_session.musicProperties2.Reset();
  g_session.musicProperties.Reset();
  if (FAILED(g_session.display->get_MusicProperties(
          g_session.musicProperties.GetAddressOf()))) {
    return;
  }
  g_session.musicProperties.As(&g_session.musicProperties2);
  if (g_session.musicProperties) {
    if (!update.title.empty()) {
      g_session.musicProperties->put_Title(
          HStringReference(update.title.c_str()).Get());
    }
    if (!update.artist.empty()) {
      g_session.musicProperties->put_Artist(
          HStringReference(update.artist.c_str()).Get());
    }
    if (!update.albumArtist.empty()) {
      g_session.musicProperties->put_AlbumArtist(
          HStringReference(update.albumArtist.c_str()).Get());
    }
    if (g_session.musicProperties2) {
      if (!update.album.empty()) {
        g_session.musicProperties2->put_AlbumTitle(
            HStringReference(update.album.c_str()).Get());
      }
      if (update.trackNumber > 0) {
        g_session.musicProperties2->put_TrackNumber(
            static_cast<uint32_t>(update.trackNumber));
      }
    }
  }
  if (!update.coverUri.empty()) {
    ComPtr<IUriRuntimeClassFactory> uriFactory;
    if (SUCCEEDED(GetActivationFactory(
            HStringReference(L"Windows.Foundation.Uri").Get(), &uriFactory))) {
      ComPtr<IUriRuntimeClass> uri;
      if (SUCCEEDED(uriFactory->CreateUri(
              HStringReference(update.coverUri.c_str()).Get(), &uri))) {
        ComPtr<IRandomAccessStreamReferenceStatics> streamFactory;
        if (SUCCEEDED(GetActivationFactory(
                HStringReference(
                    L"Windows.Storage.Streams.RandomAccessStreamReference")
                    .Get(),
                &streamFactory))) {
          ComPtr<IRandomAccessStreamReference> streamReference;
          if (SUCCEEDED(streamFactory->CreateFromUri(uri.Get(),
                                                     &streamReference))) {
            g_session.display->put_Thumbnail(streamReference.Get());
          }
        }
      }
    }
  } else {
    g_session.display->put_Thumbnail(nullptr);
  }
  g_session.display->Update();
}

void UpdateTimeline(const SmtcUpdate& update) {
  if (!g_session.controls2 || update.durationSeconds <= 0) return;
  if (std::fabs(update.positionSeconds - g_session.lastPositionSeconds) <
          kTimelineEpsilonSeconds &&
      std::fabs(update.durationSeconds - g_session.lastDurationSeconds) <
          kTimelineEpsilonSeconds) {
    return;
  }
  g_session.lastPositionSeconds = update.positionSeconds;
  g_session.lastDurationSeconds = update.durationSeconds;

  ComPtr<IInspectable> inspectable;
  if (FAILED(RoActivateInstance(
          HStringReference(
              L"Windows.Media.SystemMediaTransportControlsTimelineProperties")
              .Get(),
          &inspectable))) {
    return;
  }
  ComPtr<ISystemMediaTransportControlsTimelineProperties> timeline;
  if (FAILED(inspectable.As(&timeline))) return;

  const TimeSpan endTime = secondsToTimeSpan(update.durationSeconds);
  const TimeSpan position = secondsToTimeSpan(update.positionSeconds);
  timeline->put_StartTime({0});
  timeline->put_MinSeekTime({0});
  timeline->put_EndTime(endTime);
  timeline->put_MaxSeekTime(endTime);
  timeline->put_Position(position);
  g_session.controls2->UpdateTimelineProperties(timeline.Get());
}

void ApplyUpdate(const SmtcUpdate& update) {
  if (!g_session.controls) return;
  const bool active = update.enabled && update.hasTrack;
  if (!active) {
    if (g_session.display) {
      g_session.display->ClearAll();
      g_session.display->Update();
    }
    g_session.controls->put_PlaybackStatus(MediaPlaybackStatus_Closed);
    g_session.controls->put_IsEnabled(FALSE);
    g_session.lastMetadataKey.clear();
    g_session.lastPositionSeconds = -1.0;
    g_session.lastDurationSeconds = -1.0;
    return;
  }

  g_session.controls->put_IsEnabled(TRUE);
  g_session.controls->put_PlaybackStatus(
      update.isLoading
          ? MediaPlaybackStatus_Changing
          : (update.isPlaying ? MediaPlaybackStatus_Playing
                              : MediaPlaybackStatus_Paused));
  g_session.controls->put_IsPlayEnabled(TRUE);
  g_session.controls->put_IsPauseEnabled(TRUE);
  g_session.controls->put_IsNextEnabled(update.canNext ? TRUE : FALSE);
  g_session.controls->put_IsPreviousEnabled(update.canPrevious ? TRUE : FALSE);
  g_session.controls->put_IsStopEnabled(FALSE);
  g_session.controls->put_IsFastForwardEnabled(FALSE);
  g_session.controls->put_IsRewindEnabled(FALSE);
  g_session.controls->put_IsRecordEnabled(FALSE);
  g_session.controls->put_IsChannelUpEnabled(FALSE);
  g_session.controls->put_IsChannelDownEnabled(FALSE);

  if (g_session.controls2) {
    g_session.controls2->put_ShuffleEnabled(update.shuffle ? TRUE : FALSE);
    g_session.controls2->put_AutoRepeatMode(
        static_cast<MediaPlaybackAutoRepeatMode>(update.autoRepeatMode));
    double playbackRate = update.playbackRate;
    if (!std::isfinite(playbackRate) || playbackRate <= 0.0) playbackRate = 1.0;
    g_session.controls2->put_PlaybackRate(playbackRate);
  }

  UpdateMetadata(update);
  UpdateTimeline(update);
}

void TeardownSmtc() {
  if (g_session.controls) {
    if (g_session.display) {
      g_session.display->ClearAll();
      g_session.display->Update();
    }
    g_session.controls->put_PlaybackStatus(MediaPlaybackStatus_Closed);
    g_session.controls->put_IsEnabled(FALSE);
    if (g_session.buttonToken.value != 0) {
      g_session.controls->remove_ButtonPressed(g_session.buttonToken);
    }
  }
  if (g_session.controls2) {
    if (g_session.positionToken.value != 0) {
      g_session.controls2->remove_PlaybackPositionChangeRequested(
          g_session.positionToken);
    }
    if (g_session.shuffleToken.value != 0) {
      g_session.controls2->remove_ShuffleEnabledChangeRequested(
          g_session.shuffleToken);
    }
    if (g_session.repeatToken.value != 0) {
      g_session.controls2->remove_AutoRepeatModeChangeRequested(
          g_session.repeatToken);
    }
  }
  g_session.musicProperties.Reset();
  g_session.display.Reset();
  g_session.controls2.Reset();
  g_session.controls.Reset();
}

HRESULT InitSmtc() {
  ComPtr<ISystemMediaTransportControlsInterop> interop;
  g_session.initStage.store("GetActivationFactory", std::memory_order_release);
  HRESULT hr = GetActivationFactory(
      HStringReference(L"Windows.Media.SystemMediaTransportControls").Get(),
      &interop);
  if (FAILED(hr)) return hr;
  g_session.initStage.store("GetForWindow", std::memory_order_release);
  const HWND smtcHwnd =
      g_session.targetHwnd && IsWindow(g_session.targetHwnd)
          ? g_session.targetHwnd
          : g_session.messageHwnd;
  if (smtcHwnd == g_session.targetHwnd && !g_session.appUserModelId.empty()) {
    g_session.initStage.store("SetWindowAppUserModelId", std::memory_order_release);
    ComPtr<IPropertyStore> propertyStore;
    hr = SHGetPropertyStoreForWindow(smtcHwnd, IID_PPV_ARGS(&propertyStore));
    if (FAILED(hr)) return hr;
    PROPVARIANT value{};
    value.vt = VT_LPWSTR;
    value.pwszVal = const_cast<wchar_t*>(g_session.appUserModelId.c_str());
    hr = propertyStore->SetValue(PKEY_AppUserModel_ID, value);
    if (FAILED(hr)) return hr;
    hr = propertyStore->Commit();
    if (FAILED(hr)) return hr;
  }
  hr = interop->GetForWindow(smtcHwnd, IID_PPV_ARGS(
                                                g_session.controls.GetAddressOf()));
  if (FAILED(hr)) return hr;
  g_session.initStage.store("QueryControls2", std::memory_order_release);
  hr = g_session.controls.As(&g_session.controls2);
  if (FAILED(hr)) return hr;
  g_session.initStage.store("GetDisplayUpdater", std::memory_order_release);
  hr = g_session.controls->get_DisplayUpdater(
      g_session.display.GetAddressOf());
  if (FAILED(hr)) return hr;
  // MusicProperties is type-specific. On current Windows 11 SDK/runtime builds
  // get_MusicProperties returns HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED) until
  // the display updater has first been switched to MediaPlaybackType_Music.
  g_session.initStage.store("SetDisplayType", std::memory_order_release);
  hr = g_session.display->put_Type(MediaPlaybackType_Music);
  if (FAILED(hr)) return hr;
  g_session.initStage.store("GetMusicProperties", std::memory_order_release);
  hr = g_session.display->get_MusicProperties(
      g_session.musicProperties.GetAddressOf());
  if (FAILED(hr)) return hr;
  g_session.musicProperties.As(&g_session.musicProperties2);

  auto buttonHandler =
      Callback<ITypedEventHandler<SystemMediaTransportControls*,
                                  SystemMediaTransportControlsButtonPressedEventArgs*>>(
          [](ISystemMediaTransportControls*,
             ISystemMediaTransportControlsButtonPressedEventArgs* args)
              -> HRESULT {
            if (!args) return S_OK;
            SystemMediaTransportControlsButton button;
            if (FAILED(args->get_Button(&button))) return S_OK;
            SmtcEvent event;
            event.type = "button";
            switch (button) {
              case SystemMediaTransportControlsButton_Play:
                event.button = "play";
                break;
              case SystemMediaTransportControlsButton_Pause:
                event.button = "pause";
                break;
              case SystemMediaTransportControlsButton_Next:
                event.button = "next";
                break;
              case SystemMediaTransportControlsButton_Previous:
                event.button = "previous";
                break;
              case SystemMediaTransportControlsButton_Stop:
                event.button = "stop";
                break;
              case SystemMediaTransportControlsButton_FastForward:
                event.button = "fastForward";
                break;
              case SystemMediaTransportControlsButton_Rewind:
                event.button = "rewind";
                break;
              default:
                return S_OK;
            }
            QueueEvent(std::move(event));
            return S_OK;
          });
  if (FAILED(g_session.controls->add_ButtonPressed(
          buttonHandler.Get(), &g_session.buttonToken))) {
    return E_FAIL;
  }

  auto positionHandler =
      Callback<ITypedEventHandler<SystemMediaTransportControls*,
                                  PlaybackPositionChangeRequestedEventArgs*>>(
          [](ISystemMediaTransportControls*,
             IPlaybackPositionChangeRequestedEventArgs* args) -> HRESULT {
            if (!args) return S_OK;
            TimeSpan value{0};
            if (FAILED(args->get_RequestedPlaybackPosition(&value))) return S_OK;
            SmtcEvent event;
            event.type = "position";
            event.positionSeconds =
                static_cast<double>(value.Duration) / (1e6 * 10.0);
            QueueEvent(std::move(event));
            return S_OK;
          });
  if (FAILED(g_session.controls2->add_PlaybackPositionChangeRequested(
          positionHandler.Get(), &g_session.positionToken))) {
    return E_FAIL;
  }

  auto shuffleHandler =
      Callback<ITypedEventHandler<SystemMediaTransportControls*,
                                  ShuffleEnabledChangeRequestedEventArgs*>>(
          [](ISystemMediaTransportControls*,
             IShuffleEnabledChangeRequestedEventArgs* args) -> HRESULT {
            if (!args) return S_OK;
            boolean requested = FALSE;
            if (FAILED(args->get_RequestedShuffleEnabled(&requested)))
              return S_OK;
            SmtcEvent event;
            event.type = "shuffle";
            event.shuffle = requested != FALSE;
            QueueEvent(std::move(event));
            return S_OK;
          });
  if (FAILED(g_session.controls2->add_ShuffleEnabledChangeRequested(
          shuffleHandler.Get(), &g_session.shuffleToken))) {
    return E_FAIL;
  }

  auto repeatHandler =
      Callback<ITypedEventHandler<SystemMediaTransportControls*,
                                  AutoRepeatModeChangeRequestedEventArgs*>>(
          [](ISystemMediaTransportControls*,
             IAutoRepeatModeChangeRequestedEventArgs* args) -> HRESULT {
            if (!args) return S_OK;
            MediaPlaybackAutoRepeatMode mode = MediaPlaybackAutoRepeatMode_None;
            if (FAILED(args->get_RequestedAutoRepeatMode(&mode))) return S_OK;
            SmtcEvent event;
            event.type = "repeat";
            event.autoRepeatMode = static_cast<int>(mode);
            QueueEvent(std::move(event));
            return S_OK;
          });
  if (FAILED(g_session.controls2->add_AutoRepeatModeChangeRequested(
          repeatHandler.Get(), &g_session.repeatToken))) {
    return E_FAIL;
  }

  g_session.initStage.store("ready", std::memory_order_release);
  return S_OK;
}

LRESULT CALLBACK WindowProc(HWND hwnd, UINT message, WPARAM wParam,
                            LPARAM lParam) {
  switch (message) {
    case kUpdateMessage: {
      std::unique_ptr<SmtcUpdate> update(
          reinterpret_cast<SmtcUpdate*>(lParam));
      if (update) ApplyUpdate(*update);
      return 0;
    }
    case WM_CLOSE:
      DestroyWindow(hwnd);
      return 0;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
    default:
      return DefWindowProcW(hwnd, message, wParam, lParam);
  }
}

bool CreateHiddenWindow() {
  WNDCLASSW windowClass{};
  windowClass.lpfnWndProc = WindowProc;
  windowClass.hInstance = GetModuleHandleW(nullptr);
  windowClass.lpszClassName = kWindowClassName;
  if (!RegisterClassW(&windowClass)) {
    if (GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return false;
  }
  g_session.messageHwnd = CreateWindowExW(
      0, kWindowClassName, kWindowTitle, 0, CW_USEDEFAULT, CW_USEDEFAULT, 0, 0,
      nullptr, nullptr, windowClass.hInstance, nullptr);
  return g_session.messageHwnd != nullptr;
}

void CloseHiddenWindow() {
  if (g_session.messageHwnd) {
    DestroyWindow(g_session.messageHwnd);
    g_session.messageHwnd = nullptr;
  }
  UnregisterClassW(kWindowClassName, GetModuleHandleW(nullptr));
}

DWORD WINAPI WorkerProc(LPVOID) {
  bool ok = false;
  g_session.initStage.store("RoInitialize", std::memory_order_release);
  HRESULT hr = RoInitialize(RO_INIT_SINGLETHREADED);
  g_session.initHr.store(hr, std::memory_order_release);
  if (SUCCEEDED(hr)) {
    g_session.initStage.store("CreateHiddenWindow", std::memory_order_release);
    if (CreateHiddenWindow()) {
      hr = InitSmtc();
      g_session.initHr.store(hr, std::memory_order_release);
      ok = SUCCEEDED(hr);
    } else {
      hr = HRESULT_FROM_WIN32(GetLastError());
      g_session.initHr.store(hr, std::memory_order_release);
    }
  }
  g_session.initOk.store(ok, std::memory_order_release);
  SetEvent(g_session.readyEvent);
  if (!ok) {
    // InitSmtc may have acquired a partial COM graph before failing. Release it
    // on the STA worker before RoUninitialize; leaving those global ComPtrs alive
    // until DLL/process teardown used to crash with 0xC0000005.
    TeardownSmtc();
    if (g_session.messageHwnd) {
      DestroyWindow(g_session.messageHwnd);
      g_session.messageHwnd = nullptr;
    }
    UnregisterClassW(kWindowClassName, GetModuleHandleW(nullptr));
    if (SUCCEEDED(hr)) RoUninitialize();
    return 0;
  }

  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  TeardownSmtc();
  CloseHiddenWindow();
  RoUninitialize();
  return 0;
}

// ---- N-API helpers ----

napi_value MakeUndefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

std::string GetStringValue(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
      length == 0) {
    return {};
  }
  std::string output(length, '\0');
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, output.data(), length + 1,
                                 &written) != napi_ok) {
    return {};
  }
  output.resize(written);
  return output;
}

std::string GetStringProperty(napi_env env, napi_value object,
                              const char* name) {
  napi_value value;
  bool hasProperty = false;
  if (napi_has_named_property(env, object, name, &hasProperty) != napi_ok ||
      !hasProperty ||
      napi_get_named_property(env, object, name, &value) != napi_ok) {
    return {};
  }
  return GetStringValue(env, value);
}

double GetDoubleProperty(napi_env env, napi_value object, const char* name,
                         double fallback) {
  napi_value value;
  bool hasProperty = false;
  if (napi_has_named_property(env, object, name, &hasProperty) != napi_ok ||
      !hasProperty ||
      napi_get_named_property(env, object, name, &value) != napi_ok) {
    return fallback;
  }
  double result = fallback;
  if (napi_get_value_double(env, value, &result) != napi_ok) return fallback;
  return result;
}

bool GetBoolProperty(napi_env env, napi_value object, const char* name,
                     bool fallback) {
  napi_value value;
  bool hasProperty = false;
  if (napi_has_named_property(env, object, name, &hasProperty) != napi_ok ||
      !hasProperty ||
      napi_get_named_property(env, object, name, &value) != napi_ok) {
    return fallback;
  }
  bool result = fallback;
  if (napi_get_value_bool(env, value, &result) != napi_ok) return fallback;
  return result;
}

napi_value CreateBinding(napi_env env, napi_callback_info info) {
  if (g_session.worker.joinable()) {
    bool ok = g_session.initOk.load(std::memory_order_acquire);
    napi_value result;
    napi_get_boolean(env, ok, &result);
    return result;
  }

  size_t argc = 3;
  napi_value argv[3];
  napi_value callback = nullptr;
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc >= 1) callback = argv[0];

  g_session.targetHwnd = nullptr;
  g_session.appUserModelId.clear();
  if (argc >= 2) {
    double rawHandle = 0.0;
    if (napi_get_value_double(env, argv[1], &rawHandle) == napi_ok &&
        std::isfinite(rawHandle) && rawHandle > 0.0) {
      g_session.targetHwnd =
          reinterpret_cast<HWND>(static_cast<uintptr_t>(rawHandle));
    }
  }
  if (argc >= 3) {
    g_session.appUserModelId = utf8ToWide(GetStringValue(env, argv[2]));
  }

  napi_value resourceName;
  napi_create_string_utf8(env, "twilight-smtc-events", NAPI_AUTO_LENGTH,
                          &resourceName);
  napi_value asyncResource;
  napi_create_object(env, &asyncResource);
  napi_status status = napi_create_threadsafe_function(
      env, callback, asyncResource, resourceName, 0, 1, nullptr, nullptr,
      nullptr, CallJsEvent, &g_session.tsfn);
  if (status != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create SMTC event bridge");
    return MakeUndefined(env);
  }
  napi_unref_threadsafe_function(env, g_session.tsfn);

  g_session.env = env;
  g_session.readyEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!g_session.readyEvent) return MakeUndefined(env);

  g_session.worker = std::thread([]() { WorkerProc(nullptr); });
  const DWORD wait = WaitForSingleObject(g_session.readyEvent, kCreateTimeoutMs);
  const bool ok = wait == WAIT_OBJECT_0 &&
                  g_session.initOk.load(std::memory_order_acquire);
  CloseHandle(g_session.readyEvent);
  g_session.readyEvent = nullptr;

  // Failed initialization must be fully reclaimable. Previously the exited
  // worker remained joinable and the TSFN survived until env cleanup, where a
  // null napi_env was passed into MakeUndefined and crashed the process.
  if (!ok) {
    if (g_session.worker.joinable()) g_session.worker.join();
    if (g_session.tsfn) {
      napi_release_threadsafe_function(g_session.tsfn, napi_tsfn_abort);
      g_session.tsfn = nullptr;
    }
    g_session.env = nullptr;
    g_session.initOk.store(false, std::memory_order_release);
  }

  napi_value result;
  napi_get_boolean(env, ok, &result);
  return result;
}

napi_value UpdateBinding(napi_env env, napi_callback_info info) {
  if (!g_session.worker.joinable() ||
      !g_session.initOk.load(std::memory_order_acquire)) {
    return MakeUndefined(env);
  }
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) return MakeUndefined(env);

  SmtcUpdate update;
  update.enabled = GetBoolProperty(env, argv[0], "enabled", false);
  update.hasTrack = GetBoolProperty(env, argv[0], "hasTrack", false);
  update.isPlaying = GetBoolProperty(env, argv[0], "isPlaying", false);
  update.isLoading = GetBoolProperty(env, argv[0], "isLoading", false);
  update.canNext = GetBoolProperty(env, argv[0], "canNext", false);
  update.canPrevious = GetBoolProperty(env, argv[0], "canPrevious", false);
  update.shuffle = GetBoolProperty(env, argv[0], "shuffle", false);
  update.autoRepeatMode =
      static_cast<int>(GetDoubleProperty(env, argv[0], "autoRepeatMode", 0));
  update.positionSeconds =
      GetDoubleProperty(env, argv[0], "positionSeconds", 0);
  update.durationSeconds =
      GetDoubleProperty(env, argv[0], "durationSeconds", 0);
  update.playbackRate = GetDoubleProperty(env, argv[0], "playbackRate", 1);
  update.title = utf8ToWide(GetStringProperty(env, argv[0], "title"));
  update.artist = utf8ToWide(GetStringProperty(env, argv[0], "artist"));
  update.album = utf8ToWide(GetStringProperty(env, argv[0], "album"));
  update.albumArtist =
      utf8ToWide(GetStringProperty(env, argv[0], "albumArtist"));
  update.trackNumber =
      static_cast<int>(GetDoubleProperty(env, argv[0], "trackNumber", 0));
  update.coverUri = utf8ToWide(GetStringProperty(env, argv[0], "coverUri"));

  if (!g_session.messageHwnd || !IsWindow(g_session.messageHwnd)) {
    return MakeUndefined(env);
  }
  auto* payload = new SmtcUpdate(std::move(update));
  if (!PostMessageW(g_session.messageHwnd, kUpdateMessage, 0,
                    reinterpret_cast<LPARAM>(payload))) {
    delete payload;
  }
  return MakeUndefined(env);
}

napi_value DestroyBinding(napi_env env, napi_callback_info info) {
  if (g_session.worker.joinable()) {
    if (g_session.messageHwnd) {
      PostMessageW(g_session.messageHwnd, WM_CLOSE, 0, 0);
    }
    g_session.worker.join();
  }
  if (g_session.tsfn) {
    napi_release_threadsafe_function(g_session.tsfn, napi_tsfn_abort);
    g_session.tsfn = nullptr;
  }
  g_session.env = nullptr;
  g_session.targetHwnd = nullptr;
  g_session.appUserModelId.clear();
  g_session.initOk.store(false, std::memory_order_release);
  return env ? MakeUndefined(env) : nullptr;
}

napi_value GetLastErrorBinding(napi_env env, napi_callback_info info) {
  const long hr = g_session.initHr.load(std::memory_order_acquire);
  const char* stage = g_session.initStage.load(std::memory_order_acquire);
  char buffer[128];
  std::snprintf(buffer, sizeof(buffer), "%s: 0x%08lX", stage ? stage : "unknown",
                static_cast<unsigned long>(hr));
  napi_value result;
  napi_create_string_utf8(env, buffer, NAPI_AUTO_LENGTH, &result);
  return result;
}

napi_value SelfTestBinding(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

void SetEventString(napi_env env, napi_value object, const char* name,
                    const std::string& value) {
  napi_value string;
  if (napi_create_string_utf8(env, value.c_str(), value.size(), &string) ==
      napi_ok) {
    napi_set_named_property(env, object, name, string);
  }
}

void SetEventDouble(napi_env env, napi_value object, const char* name,
                    double value) {
  napi_value number;
  if (napi_create_double(env, value, &number) == napi_ok) {
    napi_set_named_property(env, object, name, number);
  }
}

void SetEventBool(napi_env env, napi_value object, const char* name,
                  bool value) {
  napi_value boolean;
  if (napi_get_boolean(env, value, &boolean) == napi_ok) {
    napi_set_named_property(env, object, name, boolean);
  }
}

void CallJsEvent(napi_env env, napi_value jsCallback, void*, void* data) {
  std::unique_ptr<SmtcEvent> event(static_cast<SmtcEvent*>(data));
  if (!jsCallback) return;
  napi_value object;
  napi_value undefined;
  if (napi_create_object(env, &object) != napi_ok) return;
  napi_get_undefined(env, &undefined);
  SetEventString(env, object, "type", event->type);
  if (event->type == "button") {
    SetEventString(env, object, "button", event->button);
  } else if (event->type == "position") {
    SetEventDouble(env, object, "positionSeconds", event->positionSeconds);
  } else if (event->type == "shuffle") {
    SetEventBool(env, object, "shuffle", event->shuffle);
  } else if (event->type == "repeat") {
    SetEventDouble(env, object, "autoRepeatMode", event->autoRepeatMode);
  }
  napi_value argv[1] = {object};
  napi_call_function(env, undefined, jsCallback, 1, argv, nullptr);
}

void OnEnvCleanup(void*) { DestroyBinding(nullptr, nullptr); }

void Define(napi_env env, napi_value exports, const char* name,
            napi_callback callback) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &fn);
  napi_set_named_property(env, exports, name, fn);
}

napi_value Init(napi_env env, napi_value exports) {
  napi_add_env_cleanup_hook(env, OnEnvCleanup, nullptr);
  Define(env, exports, "Create", CreateBinding);
  Define(env, exports, "Update", UpdateBinding);
  Define(env, exports, "Destroy", DestroyBinding);
  Define(env, exports, "SelfTest", SelfTestBinding);
  Define(env, exports, "GetLastError", GetLastErrorBinding);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)


