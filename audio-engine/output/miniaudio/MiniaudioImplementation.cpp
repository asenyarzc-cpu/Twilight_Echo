#define MA_ENABLE_ONLY_SPECIFIC_BACKENDS
#define MA_ENABLE_WASAPI
#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#define MA_NO_GENERATION
#define MA_NO_CUSTOM
#define MA_NO_NULL

#include "../../third_party/miniaudio/miniaudio.c"

#if MA_VERSION_MAJOR != 0 || MA_VERSION_MINOR != 11 || MA_VERSION_REVISION != 25
#error "Vendored miniaudio version must remain 0.11.25"
#endif

extern "C" const char* TAE_MiniaudioBuildMarkerForCapabilityManifest() {
  return "twilight-miniaudio-provider:miniaudio-0.11.25:backend-wasapi:runtime-unverified";
}
