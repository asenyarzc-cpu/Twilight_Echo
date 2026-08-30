cmake_minimum_required(VERSION 3.25)

project(TwilightAudioEngine VERSION 0.1.0 LANGUAGES CXX)

option(TAE_BUILD_NAPI "Build the Node-API bridge" OFF)
option(TAE_BUILD_TESTS "Build Twilight Audio Engine tests" ON)
option(TAE_ENABLE_WASAPI "Enable the Windows WASAPI backend" ON)
option(TAE_ENABLE_ASIO "Enable the Windows x64 ASIO compatibility backend" ON)
option(TAE_ENABLE_COREAUDIO "Enable the macOS CoreAudio backend" ON)
option(TAE_ENABLE_ALSA "Enable the Linux ALSA backend" ON)

set(TAE_NODE_INCLUDE_DIR "" CACHE PATH "Path to Node-API headers")

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(MSVC)
  add_compile_options(/utf-8)
endif()

set(TAE_WASAPI_AVAILABLE OFF)
set(TAE_ASIO_AVAILABLE OFF)
set(TAE_COREAUDIO_AVAILABLE OFF)
set(TAE_ALSA_AVAILABLE OFF)
if(WIN32 AND TAE_ENABLE_ASIO AND CMAKE_SIZEOF_VOID_P EQUAL 8)
  set(TAE_ASIO_AVAILABLE ON)
elseif(WIN32 AND TAE_ENABLE_ASIO)
  message(WARNING "ASIO compatibility backend is supported only in Windows x64 builds.")
endif()
if(WIN32 AND TAE_ENABLE_WASAPI)
  set(TAE_WASAPI_AVAILABLE ON)
endif()
if(APPLE AND TAE_ENABLE_COREAUDIO)
  set(TAE_COREAUDIO_AVAILABLE ON)
endif()
if(UNIX AND NOT APPLE AND TAE_ENABLE_ALSA)
  find_package(ALSA QUIET)
  if(ALSA_FOUND)
    set(TAE_ALSA_AVAILABLE ON)
  else()
    message(WARNING "ALSA development libraries were not found; ALSA backend will be disabled.")
    set(TAE_ENABLE_ALSA OFF CACHE BOOL "Enable the Linux ALSA backend" FORCE)
  endif()
endif()

set(TAE_ENGINE_SOURCES
  core/AudioBuffer.cpp
  core/AudioPipeline.cpp
  core/AudioTypes.cpp
  core/DiagnosticLog.cpp
  core/TwilightAudioEngine.cpp
  analysis/BpmAnalyzer.cpp
  analysis/LoudnessAnalyzer.cpp
  decoder/DopPacker.cpp
  decoder/DsdReader.cpp
  decoder/DstDecoder.cpp
  decoder/SacdDstDecoderProvider.cpp
  decoder/vendor/dstdec/dstdec.cpp
  decoder/FFmpegDecoder.cpp
  decoder/SacdIsoDemuxer.cpp
  decoder/ScarletbookToc.cpp
  devices/DeviceManager.cpp
  dsp/ChannelRouter.cpp
  dsp/ConvolverProcessor.cpp
  dsp/CrossfeedProcessor.cpp
  dsp/DspChain.cpp
  dsp/DspWorkspaceProcessors.cpp
  dsp/FftSpectrumAnalyzer.cpp
  dsp/KissFftAdapter.cpp
  dsp/ParametricEqProcessor.cpp
  dsp/PcmToDsdModulator.cpp
  dsp/ReplayGainProcessor.cpp
  dsp/Vst3BridgeProcessor.cpp
  dsp/WsolaResampler.cpp
  metadata/AudioMetadataService.cpp
  output/OutputBackendFactory.cpp
  playlist/QueueManager.cpp
  plugins/PluginRegistry.cpp
  utils/StringUtils.cpp
)

add_library(twilight_audio_engine SHARED ${TAE_ENGINE_SOURCES})

target_include_directories(twilight_audio_engine
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
  PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
)

target_compile_definitions(twilight_audio_engine PRIVATE TAE_BUILDING_LIBRARY=1)
target_link_libraries(twilight_audio_engine PRIVATE ${CMAKE_DL_LIBS})
if(UNIX AND NOT APPLE)
  target_link_options(twilight_audio_engine PRIVATE "-Wl,-Bsymbolic")
endif()

find_path(EBUR128_INCLUDE_DIR ebur128.h)
find_library(EBUR128_LIBRARY NAMES ebur128 libebur128)
set(TAE_EBUR128_AVAILABLE OFF)
if(EBUR128_INCLUDE_DIR AND EBUR128_LIBRARY)
  set(TAE_EBUR128_AVAILABLE ON)
  target_compile_definitions(twilight_audio_engine PRIVATE TAE_HAS_EBUR128=1)
  target_include_directories(twilight_audio_engine PRIVATE ${EBUR128_INCLUDE_DIR})
  target_link_libraries(twilight_audio_engine PRIVATE ${EBUR128_LIBRARY})
else()
  message(WARNING "libebur128 was not found; DSP loudness metering will use the built-in fallback.")
endif()

if(WIN32)
  add_compile_definitions(WIN32_LEAN_AND_MEAN NOMINMAX)
  target_compile_definitions(twilight_audio_engine PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
  set_target_properties(twilight_audio_engine PROPERTIES
    OUTPUT_NAME "twilight-audio-engine"
    PREFIX ""
    WINDOWS_EXPORT_ALL_SYMBOLS OFF
  )
else()
  set_target_properties(twilight_audio_engine PROPERTIES
    OUTPUT_NAME "twilight-audio-engine"
  )
endif()

find_package(FFMPEG QUIET)
if(NOT FFMPEG_FOUND)
  find_path(FFMPEG_INCLUDE_DIR libavformat/avformat.h)
  find_library(FFMPEG_AVFORMAT_LIBRARY avformat)
  find_library(FFMPEG_AVCODEC_LIBRARY avcodec)
  find_library(FFMPEG_AVUTIL_LIBRARY avutil)
  find_library(FFMPEG_SWRESAMPLE_LIBRARY swresample)
  if(FFMPEG_INCLUDE_DIR AND FFMPEG_AVFORMAT_LIBRARY AND FFMPEG_AVCODEC_LIBRARY AND FFMPEG_AVUTIL_LIBRARY AND FFMPEG_SWRESAMPLE_LIBRARY)
    set(FFMPEG_FOUND TRUE)
    set(FFMPEG_INCLUDE_DIRS ${FFMPEG_INCLUDE_DIR})
    set(FFMPEG_LIBRARIES
      ${FFMPEG_AVFORMAT_LIBRARY}
      ${FFMPEG_AVCODEC_LIBRARY}
      ${FFMPEG_AVUTIL_LIBRARY}
      ${FFMPEG_SWRESAMPLE_LIBRARY}
    )
  endif()
endif()

set(TAE_FFMPEG_EXTRA_LIBS)
if(WIN32)
  list(APPEND TAE_FFMPEG_EXTRA_LIBS ws2_32 secur32 ncrypt crypt32 bcrypt user32 atomic)
elseif(UNIX AND NOT APPLE)
  list(APPEND TAE_FFMPEG_EXTRA_LIBS atomic)
endif()

if(FFMPEG_FOUND)
  target_compile_definitions(twilight_audio_engine PRIVATE TAE_HAS_FFMPEG=1)
  target_include_directories(twilight_audio_engine PRIVATE ${FFMPEG_INCLUDE_DIRS})
  target_link_libraries(twilight_audio_engine PRIVATE ${FFMPEG_LIBRARIES} ${TAE_FFMPEG_EXTRA_LIBS})
else()
  message(WARNING "FFmpeg development libraries were not found; native playback will report TAE_RESULT_BACKEND_UNAVAILABLE.")
endif()

if(TAE_WASAPI_AVAILABLE)
  target_sources(twilight_audio_engine PRIVATE
    output/wasapi/WasapiFormatNegotiator.cpp
    output/wasapi/WasapiSharedBackend.cpp
    output/wasapi/WasapiExclusiveBackend.cpp
  )
  target_compile_definitions(twilight_audio_engine PRIVATE TAE_ENABLE_WASAPI=1)
  target_link_libraries(twilight_audio_engine PRIVATE ole32 uuid avrt)
endif()

if(TAE_ASIO_AVAILABLE)
  target_sources(twilight_audio_engine PRIVATE
    output/asio/AsioBackend.cpp
    output/asio/DeviceCapabilityCache.cpp
    output/asio/RealAsioHost.cpp
    output/asio/windows/AsioCallbackRouter.cpp
    output/asio/windows/AsioControlThread.cpp
    output/asio/windows/AsioDriverCatalog.cpp
    output/asio/windows/AsioDriverSession.cpp
  )
  target_compile_definitions(twilight_audio_engine PRIVATE TAE_ENABLE_ASIO=1)
  target_link_libraries(twilight_audio_engine PRIVATE ole32 uuid advapi32 user32)
endif()

if(TAE_COREAUDIO_AVAILABLE)
  target_sources(twilight_audio_engine PRIVATE
    output/coreaudio/CoreAudioBackend.cpp
    output/coreaudio/CoreAudioExclusiveBackend.cpp
    output/coreaudio/RealCoreAudioHost.cpp
  )
  target_compile_definitions(twilight_audio_engine PRIVATE TAE_ENABLE_COREAUDIO=1)
  target_link_libraries(twilight_audio_engine PRIVATE
    "-framework CoreAudio"
    "-framework CoreFoundation"
    "-framework AudioToolbox"
    "-framework AudioUnit"
  )
endif()

if(TAE_ALSA_AVAILABLE)
  target_sources(twilight_audio_engine PRIVATE
    output/alsa/AlsaBackend.cpp
    output/alsa/RealAlsaHost.cpp
  )
  target_compile_definitions(twilight_audio_engine PRIVATE TAE_ENABLE_ALSA=1)
  target_include_directories(twilight_audio_engine PRIVATE ${ALSA_INCLUDE_DIRS})
  target_link_libraries(twilight_audio_engine PRIVATE ${ALSA_LIBRARIES})
endif()

if(TAE_BUILD_NAPI)
  add_library(twilight_audio_node MODULE napi/twilight_audio_node.cpp)
  if(WIN32)
    target_sources(twilight_audio_node PRIVATE napi/node_api_dynamic_win32.cpp)
  endif()
  target_link_libraries(twilight_audio_node PRIVATE twilight_audio_engine)
  target_include_directories(twilight_audio_node PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
  target_compile_definitions(twilight_audio_node PRIVATE NAPI_VERSION=10)
  set_target_properties(twilight_audio_node PROPERTIES
    PREFIX ""
    SUFFIX ".node"
    BUILD_RPATH "$ORIGIN"
    INSTALL_RPATH "$ORIGIN"
  )
  if(APPLE)
    target_link_options(twilight_audio_node PRIVATE "-undefined" "dynamic_lookup")
  endif()

  if(NOT TAE_NODE_INCLUDE_DIR)
    set(_tae_local_node_api_headers "${CMAKE_CURRENT_SOURCE_DIR}/../node_modules/node-api-headers/include")
    if(EXISTS "${_tae_local_node_api_headers}/node_api.h")
      set(TAE_NODE_INCLUDE_DIR "${_tae_local_node_api_headers}")
    endif()
  endif()

  if(TAE_NODE_INCLUDE_DIR)
    target_include_directories(twilight_audio_node PRIVATE ${TAE_NODE_INCLUDE_DIR})
  else()
    message(FATAL_ERROR "TAE_NODE_INCLUDE_DIR is not set and node_modules/node-api-headers/include was not found.")
  endif()
endif()

message(STATUS "Twilight Audio Engine feature summary:")
message(STATUS "  WASAPI: ${TAE_WASAPI_AVAILABLE}")
message(STATUS "  ASIO compatibility backend: ${TAE_ASIO_AVAILABLE}")
message(STATUS "  CoreAudio: ${TAE_COREAUDIO_AVAILABLE}")
if(TAE_ALSA_AVAILABLE)
  message(STATUS "  ALSA: ${TAE_ALSA_AVAILABLE} (libraries: ${ALSA_LIBRARIES})")
else()
  message(STATUS "  ALSA: ${TAE_ALSA_AVAILABLE}")
endif()
message(STATUS "  FFmpeg: ${FFMPEG_FOUND}")
message(STATUS "  libebur128: ${TAE_EBUR128_AVAILABLE}")
message(STATUS "  Node-API: ${TAE_BUILD_NAPI}")

if(TAE_BUILD_TESTS)
  enable_testing()
  add_executable(twilight_audio_tests tests/engine_smoke.cpp)
  target_link_libraries(twilight_audio_tests PRIVATE twilight_audio_engine)
  add_test(NAME twilight_audio_engine_smoke COMMAND twilight_audio_tests)

  add_executable(twilight_dsp_tests
    tests/dsp_tests.cpp
    dsp/ChannelRouter.cpp
    dsp/ConvolverProcessor.cpp
    dsp/CrossfeedProcessor.cpp
    dsp/DspChain.cpp
    dsp/DspWorkspaceProcessors.cpp
    dsp/FftSpectrumAnalyzer.cpp
    dsp/KissFftAdapter.cpp
    dsp/ParametricEqProcessor.cpp
    dsp/ReplayGainProcessor.cpp
    dsp/Vst3BridgeProcessor.cpp
    dsp/WsolaResampler.cpp
    plugins/PluginRegistry.cpp
  )
  target_include_directories(twilight_dsp_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  target_compile_definitions(twilight_dsp_tests PRIVATE TAE_DSP_CHAIN_TESTS=1)
  target_link_libraries(twilight_dsp_tests PRIVATE ${CMAKE_DL_LIBS})
  if(TAE_EBUR128_AVAILABLE)
    target_compile_definitions(twilight_dsp_tests PRIVATE TAE_HAS_EBUR128=1)
    target_include_directories(twilight_dsp_tests PRIVATE ${EBUR128_INCLUDE_DIR})
    target_link_libraries(twilight_dsp_tests PRIVATE ${EBUR128_LIBRARY})
  endif()
  add_test(NAME twilight_dsp_unit COMMAND twilight_dsp_tests)

  add_executable(twilight_channel_router_tests
    tests/channel_router_tests.cpp
    dsp/ChannelRouter.cpp
    core/AudioTypes.cpp
  )
  target_include_directories(twilight_channel_router_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  add_test(NAME twilight_channel_router_unit COMMAND twilight_channel_router_tests)

  add_executable(twilight_wsola_tests
    tests/wsola_tests.cpp
    dsp/WsolaResampler.cpp
  )
  target_include_directories(twilight_wsola_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  add_test(NAME twilight_wsola_unit COMMAND twilight_wsola_tests)

  add_executable(twilight_audio_buffer_tests
    tests/audio_buffer_tests.cpp
    core/AudioBuffer.cpp
    core/AudioTypes.cpp
  )
  target_include_directories(twilight_audio_buffer_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  add_test(NAME twilight_audio_buffer_unit COMMAND twilight_audio_buffer_tests)

  add_executable(twilight_diagnostic_log_tests
    tests/diagnostic_log_tests.cpp
    core/DiagnosticLog.cpp
  )
  target_include_directories(twilight_diagnostic_log_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  add_test(NAME twilight_diagnostic_log_unit COMMAND twilight_diagnostic_log_tests)

  add_library(twilight_test_gain_dsp_plugin SHARED tests/test_gain_dsp_plugin.cpp)
  target_include_directories(twilight_test_gain_dsp_plugin PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
  add_library(twilight_test_fault_dsp_plugin SHARED tests/test_fault_dsp_plugin.cpp)
  target_include_directories(twilight_test_fault_dsp_plugin PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
  add_library(twilight_test_bad_abi_dsp_plugin SHARED tests/test_bad_abi_dsp_plugin.cpp)
  target_include_directories(twilight_test_bad_abi_dsp_plugin PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
  add_library(twilight_test_invalid_param_dsp_plugin SHARED tests/test_invalid_param_dsp_plugin.cpp)
  target_include_directories(twilight_test_invalid_param_dsp_plugin PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
  add_library(twilight_crossfeed_dsp_plugin SHARED tests/test_crossfeed_dsp_plugin.cpp)
  target_include_directories(twilight_crossfeed_dsp_plugin PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
  add_library(twilight_test_crash_dsp_plugin SHARED tests/test_crash_dsp_plugin.cpp)
  target_include_directories(twilight_test_crash_dsp_plugin PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
  add_library(twilight_test_v2_gain_dsp_plugin SHARED tests/test_v2_gain_dsp_plugin.cpp)
  target_include_directories(twilight_test_v2_gain_dsp_plugin PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
  if(WIN32)
    set_target_properties(twilight_test_gain_dsp_plugin PROPERTIES PREFIX "")
    set_target_properties(twilight_test_fault_dsp_plugin PROPERTIES PREFIX "")
    set_target_properties(twilight_test_bad_abi_dsp_plugin PROPERTIES PREFIX "")
    set_target_properties(twilight_test_invalid_param_dsp_plugin PROPERTIES PREFIX "")
    set_target_properties(twilight_crossfeed_dsp_plugin PROPERTIES PREFIX "")
    set_target_properties(twilight_test_crash_dsp_plugin PROPERTIES PREFIX "")
    set_target_properties(twilight_test_v2_gain_dsp_plugin PROPERTIES PREFIX "")
  endif()

  add_executable(twilight_native_dsp_plugin_tests
    tests/native_dsp_plugin_tests.cpp
    plugins/PluginRegistry.cpp
  )
  target_include_directories(twilight_native_dsp_plugin_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
  target_link_libraries(twilight_native_dsp_plugin_tests PRIVATE twilight_audio_engine)
  add_test(
    NAME twilight_native_dsp_plugin_unit
    COMMAND twilight_native_dsp_plugin_tests
      $<TARGET_FILE:twilight_test_gain_dsp_plugin>
      $<TARGET_FILE:twilight_test_fault_dsp_plugin>
      $<TARGET_FILE:twilight_test_bad_abi_dsp_plugin>
      $<TARGET_FILE:twilight_test_invalid_param_dsp_plugin>
      $<TARGET_FILE:twilight_crossfeed_dsp_plugin>
      $<TARGET_FILE:twilight_test_crash_dsp_plugin>
      $<TARGET_FILE:twilight_test_v2_gain_dsp_plugin>
  )
  add_test(
    NAME twilight_native_dsp_plugin_crash_fixture
    COMMAND twilight_native_dsp_plugin_tests
      --expect-crash-fixture
      $<TARGET_FILE:twilight_test_crash_dsp_plugin>
  )

  add_executable(twilight_metadata_tests
    metadata/metadata_tests.cpp
    metadata/AudioMetadataService.cpp
    decoder/SacdIsoDemuxer.cpp
    decoder/ScarletbookToc.cpp
    decoder/DstDecoder.cpp
    decoder/SacdDstDecoderProvider.cpp
    decoder/vendor/dstdec/dstdec.cpp
    core/AudioTypes.cpp
  )
  target_include_directories(twilight_metadata_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  if(FFMPEG_FOUND)
    target_compile_definitions(twilight_metadata_tests PRIVATE TAE_HAS_FFMPEG=1)
    target_include_directories(twilight_metadata_tests PRIVATE ${FFMPEG_INCLUDE_DIRS})
    target_link_libraries(twilight_metadata_tests PRIVATE ${FFMPEG_LIBRARIES} ${TAE_FFMPEG_EXTRA_LIBS})
  endif()
  add_test(NAME twilight_metadata_unit COMMAND twilight_metadata_tests)

  add_executable(twilight_bitperfect_tests
    tests/bitperfect_tests.cpp
    core/AudioTypes.cpp
  )
  target_include_directories(twilight_bitperfect_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  add_test(NAME twilight_bitperfect_unit COMMAND twilight_bitperfect_tests)

  add_executable(twilight_ffmpeg_decoder_tests
    tests/ffmpeg_decoder_tests.cpp
    tests/AudioFixtureLibrary.cpp
    decoder/FFmpegDecoder.cpp
    core/AudioTypes.cpp
  )
  target_include_directories(twilight_ffmpeg_decoder_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  if(FFMPEG_FOUND)
    target_compile_definitions(twilight_ffmpeg_decoder_tests PRIVATE TAE_HAS_FFMPEG=1)
    target_include_directories(twilight_ffmpeg_decoder_tests PRIVATE ${FFMPEG_INCLUDE_DIRS})
    target_link_libraries(twilight_ffmpeg_decoder_tests PRIVATE ${FFMPEG_LIBRARIES} ${TAE_FFMPEG_EXTRA_LIBS})
  endif()
  add_test(NAME twilight_ffmpeg_decoder_unit COMMAND twilight_ffmpeg_decoder_tests)

  add_executable(twilight_dsd_dop_tests
    tests/dsd_dop_tests.cpp
    decoder/DopPacker.cpp
    decoder/DsdReader.cpp
    decoder/SacdIsoDemuxer.cpp
    decoder/ScarletbookToc.cpp
    decoder/DstDecoder.cpp
    decoder/SacdDstDecoderProvider.cpp
    decoder/vendor/dstdec/dstdec.cpp
    core/AudioTypes.cpp
  )
  target_include_directories(twilight_dsd_dop_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  add_test(NAME twilight_dsd_dop_unit COMMAND twilight_dsd_dop_tests)

  add_executable(twilight_pcm_to_dsd_tests
    tests/pcm_to_dsd_tests.cpp
    dsp/PcmToDsdModulator.cpp
    core/AudioTypes.cpp
  )
  target_include_directories(twilight_pcm_to_dsd_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  add_test(NAME twilight_pcm_to_dsd_unit COMMAND twilight_pcm_to_dsd_tests)

  add_executable(twilight_queue_tests
    tests/queue_tests.cpp
    playlist/QueueManager.cpp
  )
  target_include_directories(twilight_queue_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  add_test(NAME twilight_queue_unit COMMAND twilight_queue_tests)

  add_executable(twilight_backend_factory_tests tests/backend_factory_tests.cpp)
  target_include_directories(twilight_backend_factory_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  target_link_libraries(twilight_backend_factory_tests PRIVATE twilight_audio_engine)
  add_test(NAME twilight_backend_factory_unit COMMAND twilight_backend_factory_tests)

  add_executable(twilight_platform_backend_smoke
    tests/platform_backend_smoke.cpp
    core/AudioTypes.cpp
  )
  target_include_directories(twilight_platform_backend_smoke PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  target_link_libraries(twilight_platform_backend_smoke PRIVATE twilight_audio_engine)
  if(TAE_WASAPI_AVAILABLE)
    target_sources(twilight_platform_backend_smoke PRIVATE
      output/wasapi/WasapiFormatNegotiator.cpp
      output/wasapi/WasapiSharedBackend.cpp
      output/wasapi/WasapiExclusiveBackend.cpp
    )
    target_compile_definitions(twilight_platform_backend_smoke PRIVATE TAE_ENABLE_WASAPI=1)
    target_link_libraries(twilight_platform_backend_smoke PRIVATE ole32 uuid avrt)
  endif()
  if(TAE_COREAUDIO_AVAILABLE)
    target_sources(twilight_platform_backend_smoke PRIVATE
      output/coreaudio/CoreAudioBackend.cpp
      output/coreaudio/CoreAudioExclusiveBackend.cpp
      output/coreaudio/RealCoreAudioHost.cpp
    )
    target_compile_definitions(twilight_platform_backend_smoke PRIVATE TAE_ENABLE_COREAUDIO=1)
    target_link_libraries(twilight_platform_backend_smoke PRIVATE
      "-framework CoreAudio"
      "-framework CoreFoundation"
      "-framework AudioToolbox"
      "-framework AudioUnit"
    )
  endif()
  if(TAE_ALSA_AVAILABLE)
    target_sources(twilight_platform_backend_smoke PRIVATE output/alsa/AlsaBackend.cpp)
    target_compile_definitions(twilight_platform_backend_smoke PRIVATE TAE_ENABLE_ALSA=1)
    target_include_directories(twilight_platform_backend_smoke PRIVATE ${ALSA_INCLUDE_DIRS})
    target_link_libraries(twilight_platform_backend_smoke PRIVATE ${ALSA_LIBRARIES})
  endif()
  add_test(NAME twilight_platform_backend_smoke COMMAND twilight_platform_backend_smoke)

  if(TAE_WASAPI_AVAILABLE)
    add_executable(twilight_wasapi_format_negotiator_tests
      tests/wasapi_format_negotiator_tests.cpp
      output/wasapi/WasapiFormatNegotiator.cpp
      core/AudioTypes.cpp
    )
    target_include_directories(twilight_wasapi_format_negotiator_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_compile_definitions(twilight_wasapi_format_negotiator_tests PRIVATE TAE_ENABLE_WASAPI=1)
    target_link_libraries(twilight_wasapi_format_negotiator_tests PRIVATE ole32 uuid)
    add_test(NAME twilight_wasapi_format_negotiator_unit COMMAND twilight_wasapi_format_negotiator_tests)
  endif()

  if(TAE_ASIO_AVAILABLE)
    add_executable(twilight_asio_backend_tests
      tests/asio_backend_tests.cpp
      output/asio/AsioBackend.cpp
      output/asio/DeviceCapabilityCache.cpp
      output/asio/MockAsioHost.cpp
      output/asio/RealAsioHost.cpp
      core/AudioTypes.cpp
    )
    target_include_directories(twilight_asio_backend_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_compile_definitions(twilight_asio_backend_tests PRIVATE TAE_ENABLE_ASIO=1)
    target_sources(twilight_asio_backend_tests PRIVATE
      output/asio/windows/AsioCallbackRouter.cpp
      output/asio/windows/AsioControlThread.cpp
      output/asio/windows/AsioDriverCatalog.cpp
      output/asio/windows/AsioDriverSession.cpp
    )
    target_link_libraries(twilight_asio_backend_tests PRIVATE ole32 uuid advapi32 user32)
    add_test(NAME twilight_asio_backend_unit COMMAND twilight_asio_backend_tests)
  endif()

  if(TAE_ASIO_AVAILABLE)
    add_executable(twilight_asio_abi_checks output/asio/abi/AsioAbiChecks.cpp)
    target_include_directories(twilight_asio_abi_checks PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_link_libraries(twilight_asio_abi_checks PRIVATE ole32 uuid)
    add_test(NAME twilight_asio_abi_checks COMMAND twilight_asio_abi_checks)

    add_executable(twilight_asio_abi_manifest output/asio/abi/AsioAbiManifest.cpp)
    target_include_directories(twilight_asio_abi_manifest PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_link_libraries(twilight_asio_abi_manifest PRIVATE ole32 uuid)
    add_test(NAME twilight_asio_abi_manifest COMMAND twilight_asio_abi_manifest)

    add_executable(twilight_asio_abi_cross_dll_tests tests/asio_abi_cross_dll_tests.cpp)
    target_include_directories(twilight_asio_abi_cross_dll_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_link_libraries(twilight_asio_abi_cross_dll_tests PRIVATE ole32 uuid)
    add_test(NAME twilight_asio_abi_cross_dll COMMAND twilight_asio_abi_cross_dll_tests)
    set_tests_properties(twilight_asio_abi_cross_dll PROPERTIES SKIP_RETURN_CODE 77)

    add_executable(twilight_asio_control_thread_tests
      output/asio/windows/AsioControlThread.test.cpp
      output/asio/windows/AsioControlThread.cpp
    )
    target_include_directories(twilight_asio_control_thread_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_compile_definitions(twilight_asio_control_thread_tests PRIVATE TAE_ENABLE_ASIO=1)
    target_link_libraries(twilight_asio_control_thread_tests PRIVATE ole32 uuid advapi32 user32)
    add_test(NAME twilight_asio_control_thread_unit COMMAND twilight_asio_control_thread_tests)
    set_tests_properties(twilight_asio_control_thread_unit PROPERTIES TIMEOUT 120)
  endif()

  add_executable(twilight_output_backend_tests
    tests/output_backend_tests.cpp
    output/asio/AsioBackend.cpp
    output/asio/DeviceCapabilityCache.cpp
    output/asio/MockAsioHost.cpp
    output/asio/RealAsioHost.cpp
    core/AudioTypes.cpp
  )
  target_include_directories(twilight_output_backend_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  if(TAE_ASIO_AVAILABLE)
    target_compile_definitions(twilight_output_backend_tests PRIVATE TAE_ENABLE_ASIO=1)
    target_sources(twilight_output_backend_tests PRIVATE
      output/asio/windows/AsioCallbackRouter.cpp
      output/asio/windows/AsioControlThread.cpp
      output/asio/windows/AsioDriverCatalog.cpp
      output/asio/windows/AsioDriverSession.cpp
    )
    target_link_libraries(twilight_output_backend_tests PRIVATE ole32 uuid advapi32 user32)
  endif()
  add_test(NAME twilight_output_backend_unit COMMAND twilight_output_backend_tests)

  add_executable(twilight_runtime_queue_reroute_tests
    tests/runtime_queue_reroute_tests.cpp
    core/AudioBuffer.cpp
    core/AudioPipeline.cpp
    core/AudioTypes.cpp
    core/DiagnosticLog.cpp
    core/TwilightAudioEngine.cpp
    analysis/BpmAnalyzer.cpp
    analysis/LoudnessAnalyzer.cpp
    decoder/DopPacker.cpp
    decoder/DsdReader.cpp
    decoder/SacdIsoDemuxer.cpp
    decoder/ScarletbookToc.cpp
    decoder/DstDecoder.cpp
    decoder/SacdDstDecoderProvider.cpp
    decoder/vendor/dstdec/dstdec.cpp
    dsp/ChannelRouter.cpp
    dsp/ConvolverProcessor.cpp
    dsp/CrossfeedProcessor.cpp
    dsp/DspChain.cpp
    dsp/DspWorkspaceProcessors.cpp
    dsp/FftSpectrumAnalyzer.cpp
    dsp/KissFftAdapter.cpp
    dsp/ParametricEqProcessor.cpp
    dsp/PcmToDsdModulator.cpp
    dsp/ReplayGainProcessor.cpp
    dsp/WsolaResampler.cpp
    dsp/Vst3BridgeProcessor.cpp
    plugins/PluginRegistry.cpp
    playlist/QueueManager.cpp
  )
  target_include_directories(twilight_runtime_queue_reroute_tests PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
  )
  target_link_libraries(twilight_runtime_queue_reroute_tests PRIVATE ${CMAKE_DL_LIBS})
  if(WIN32)
    # The fixture is a controlled process-level stand-in for the external VST3
    # host. It exercises the same shared-memory lifecycle without pretending
    # to validate a third-party VST3 module.
    add_executable(twilight_vst3_host_pressure_fixture tests/vst3_host_pressure_fixture.cpp)
    target_include_directories(twilight_vst3_host_pressure_fixture PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    # MinGW needs this switch to select wmain; MSVC recognizes wmain directly.
    if(MINGW)
      target_link_options(twilight_vst3_host_pressure_fixture PRIVATE -municode)
    endif()
    set_target_properties(twilight_vst3_host_pressure_fixture PROPERTIES
      OUTPUT_NAME "twilight-vst3-host-pressure-fixture"
    )
    add_dependencies(twilight_runtime_queue_reroute_tests twilight_vst3_host_pressure_fixture)
    add_custom_command(
      TARGET twilight_runtime_queue_reroute_tests
      POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different
        $<TARGET_FILE:twilight_vst3_host_pressure_fixture>
        $<TARGET_FILE_DIR:twilight_runtime_queue_reroute_tests>/twilight-vst3-host.exe
    )
    target_link_libraries(twilight_runtime_queue_reroute_tests PRIVATE psapi)
  endif()
  if(TAE_EBUR128_AVAILABLE)
    target_compile_definitions(twilight_runtime_queue_reroute_tests PRIVATE TAE_HAS_EBUR128=1)
    target_include_directories(twilight_runtime_queue_reroute_tests PRIVATE ${EBUR128_INCLUDE_DIR})
    target_link_libraries(twilight_runtime_queue_reroute_tests PRIVATE ${EBUR128_LIBRARY})
  endif()
  add_test(NAME twilight_runtime_queue_reroute_unit COMMAND twilight_runtime_queue_reroute_tests)

  # This is deliberately a native behavior gate, not an array-fill benchmark.
  # It drives the production AudioPipeline and FFmpeg decoder through a
  # controlled callback pump. Real-device scheduling remains an opt-in smoke.
  add_executable(twilight_audio_performance_gate
    tests/audio_performance_gate.cpp
    core/AudioBuffer.cpp
    core/AudioPipeline.cpp
    core/AudioTypes.cpp
    core/DiagnosticLog.cpp
    analysis/BpmAnalyzer.cpp
    analysis/LoudnessAnalyzer.cpp
    decoder/DopPacker.cpp
    decoder/DsdReader.cpp
    decoder/SacdIsoDemuxer.cpp
    decoder/ScarletbookToc.cpp
    decoder/DstDecoder.cpp
    decoder/SacdDstDecoderProvider.cpp
    decoder/vendor/dstdec/dstdec.cpp
    decoder/FFmpegDecoder.cpp
    dsp/ChannelRouter.cpp
    dsp/ConvolverProcessor.cpp
    dsp/CrossfeedProcessor.cpp
    dsp/DspChain.cpp
    dsp/DspWorkspaceProcessors.cpp
    dsp/FftSpectrumAnalyzer.cpp
    dsp/KissFftAdapter.cpp
    dsp/ParametricEqProcessor.cpp
    dsp/PcmToDsdModulator.cpp
    dsp/ReplayGainProcessor.cpp
    dsp/WsolaResampler.cpp
    dsp/Vst3BridgeProcessor.cpp
    plugins/PluginRegistry.cpp
    playlist/QueueManager.cpp
  )
  target_include_directories(twilight_audio_performance_gate PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
  )
  # NDEBUG is stripped from every test target at the end of this block.
  target_link_libraries(twilight_audio_performance_gate PRIVATE ${CMAKE_DL_LIBS})
  if(FFMPEG_FOUND)
    target_compile_definitions(twilight_audio_performance_gate PRIVATE TAE_HAS_FFMPEG=1)
    target_include_directories(twilight_audio_performance_gate PRIVATE ${FFMPEG_INCLUDE_DIRS})
    target_link_libraries(twilight_audio_performance_gate PRIVATE ${FFMPEG_LIBRARIES} ${TAE_FFMPEG_EXTRA_LIBS})
  endif()
  if(TAE_EBUR128_AVAILABLE)
    target_compile_definitions(twilight_audio_performance_gate PRIVATE TAE_HAS_EBUR128=1)
    target_include_directories(twilight_audio_performance_gate PRIVATE ${EBUR128_INCLUDE_DIR})
    target_link_libraries(twilight_audio_performance_gate PRIVATE ${EBUR128_LIBRARY})
  endif()
  if(WIN32)
    add_dependencies(twilight_audio_performance_gate twilight_vst3_host_pressure_fixture)
    add_custom_command(
      TARGET twilight_audio_performance_gate
      POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different
        $<TARGET_FILE:twilight_vst3_host_pressure_fixture>
        $<TARGET_FILE_DIR:twilight_audio_performance_gate>/twilight-vst3-host.exe
    )
    target_link_libraries(twilight_audio_performance_gate PRIVATE psapi)
  endif()
  add_test(NAME twilight_audio_performance_gate COMMAND twilight_audio_performance_gate)
  set_tests_properties(twilight_audio_performance_gate PROPERTIES TIMEOUT 180 SKIP_RETURN_CODE 77)

  add_executable(twilight_dst_decoder_tests
    tests/dst_decoder_tests.cpp
    decoder/DstDecoder.cpp
    decoder/vendor/dstdec/dstdec.cpp
  )
  target_include_directories(twilight_dst_decoder_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  add_test(NAME twilight_dst_decoder_unit COMMAND twilight_dst_decoder_tests)

  add_executable(twilight_coreaudio_backend_tests
    tests/coreaudio_backend_tests.cpp
    output/coreaudio/CoreAudioBackend.cpp
    output/coreaudio/CoreAudioExclusiveBackend.cpp
    output/coreaudio/MockCoreAudioHost.cpp
    core/AudioTypes.cpp
  )
  target_include_directories(twilight_coreaudio_backend_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  if(TAE_COREAUDIO_AVAILABLE)
    target_sources(twilight_coreaudio_backend_tests PRIVATE output/coreaudio/RealCoreAudioHost.cpp)
    target_compile_definitions(twilight_coreaudio_backend_tests PRIVATE TAE_ENABLE_COREAUDIO=1)
    target_link_libraries(twilight_coreaudio_backend_tests PRIVATE
      "-framework CoreAudio"
      "-framework CoreFoundation"
      "-framework AudioToolbox"
      "-framework AudioUnit"
    )
  endif()
  add_test(NAME twilight_coreaudio_backend_unit COMMAND twilight_coreaudio_backend_tests)

  add_executable(twilight_alsa_backend_tests
    tests/alsa_backend_tests.cpp
    output/alsa/AlsaBackend.cpp
    output/alsa/MockAlsaHost.cpp
    output/alsa/RealAlsaHost.cpp
    core/AudioTypes.cpp
  )
  target_include_directories(twilight_alsa_backend_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  if(TAE_ALSA_AVAILABLE)
    target_compile_definitions(twilight_alsa_backend_tests PRIVATE TAE_ENABLE_ALSA=1)
    target_include_directories(twilight_alsa_backend_tests PRIVATE ${ALSA_INCLUDE_DIRS})
    target_link_libraries(twilight_alsa_backend_tests PRIVATE ${ALSA_LIBRARIES})
  endif()
  add_test(NAME twilight_alsa_backend_unit COMMAND twilight_alsa_backend_tests)

  # Every native test asserts its expectations with assert(). The Release
  # configuration defines NDEBUG, which deletes those calls outright -- and with
  # them any side effects in the asserted expression, e.g. assert(decoder.init(...)).
  # That silently turns the whole suite into a no-op that still reports "Passed".
  # Keep assertions live on every test target regardless of configuration.
  set(TAE_TEST_TARGETS
    twilight_audio_tests
    twilight_dsp_tests
    twilight_channel_router_tests
    twilight_wsola_tests
    twilight_audio_buffer_tests
    twilight_diagnostic_log_tests
    twilight_native_dsp_plugin_tests
    twilight_metadata_tests
    twilight_bitperfect_tests
    twilight_ffmpeg_decoder_tests
    twilight_dsd_dop_tests
    twilight_pcm_to_dsd_tests
    twilight_queue_tests
    twilight_backend_factory_tests
    twilight_platform_backend_smoke
    twilight_wasapi_format_negotiator_tests
    twilight_asio_backend_tests
    twilight_asio_abi_checks
    twilight_asio_abi_manifest
    twilight_asio_abi_cross_dll_tests
    twilight_asio_control_thread_tests
    twilight_output_backend_tests
    twilight_runtime_queue_reroute_tests
    twilight_vst3_host_pressure_fixture
    twilight_audio_performance_gate
    twilight_dst_decoder_tests
    twilight_coreaudio_backend_tests
    twilight_alsa_backend_tests
  )
  foreach(tae_test_target IN LISTS TAE_TEST_TARGETS)
    if(TARGET ${tae_test_target})
      if(MSVC)
        target_compile_options(${tae_test_target} PRIVATE /UNDEBUG)
      else()
        target_compile_options(${tae_test_target} PRIVATE -UNDEBUG)
      endif()
    endif()
  endforeach()

endif()
