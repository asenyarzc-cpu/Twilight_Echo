cmake_minimum_required(VERSION 3.25)

project(TwilightSmtcNode VERSION 0.1.0 LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "Twilight SMTC addon is supported only on Windows x64.")
endif()

if(NOT MSVC)
  message(FATAL_ERROR "Twilight SMTC addon must be built with MSVC (Windows SDK ABI + WRL).")
endif()

if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "Twilight SMTC addon is supported only on x64.")
endif()

set(TAE_NODE_INCLUDE_DIR "" CACHE PATH "Path to Node-API headers (node-api-headers)")
if(NOT TAE_NODE_INCLUDE_DIR)
  message(FATAL_ERROR "TAE_NODE_INCLUDE_DIR is required (point it at node_modules/node-api-headers/include).")
endif()
cmake_path(ABSOLUTE_PATH TAE_NODE_INCLUDE_DIR NORMALIZE OUTPUT_VARIABLE TAE_NODE_INCLUDE_DIR)
if(NOT EXISTS "${TAE_NODE_INCLUDE_DIR}/node_api.h")
  message(FATAL_ERROR "TAE_NODE_INCLUDE_DIR does not contain node_api.h: ${TAE_NODE_INCLUDE_DIR}")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
# The addon is loaded inside Electron, which ships the MSVC runtime; keep the
# dynamic runtime and stage the matching VC runtime DLLs beside the addon.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL" CACHE STRING "" FORCE)

add_library(twilight_smtc_node MODULE
  twilight_smtc_node.cpp
  node_api_dynamic_win32.cpp
)
target_include_directories(twilight_smtc_node PRIVATE ${TAE_NODE_INCLUDE_DIR})
target_compile_definitions(twilight_smtc_node PRIVATE
  NAPI_VERSION=10
  WIN32_LEAN_AND_MEAN
  NOMINMAX
)
target_compile_options(twilight_smtc_node PRIVATE /W4 /permissive- /EHsc /utf-8)
# Modern Windows SDKs no longer ship the legacy winstring/combase split import
# libraries used by older WinRT samples. The ABI entry points used here are
# available through runtimeobject on the supported Windows 10/11 SDKs.
target_link_libraries(twilight_smtc_node PRIVATE runtimeobject shell32)
set_target_properties(twilight_smtc_node PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

message(STATUS "Twilight SMTC addon: Windows x64 MSVC")
