#pragma once

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#  if defined(TAE_BUILDING_LIBRARY)
#    define TAE_API __declspec(dllexport)
#  else
#    define TAE_API __declspec(dllimport)
#  endif
#else
#  define TAE_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef void* TAE_EngineHandle;

typedef enum TAE_Result {
  TAE_RESULT_OK = 0,
  TAE_RESULT_INVALID_ARGUMENT = 1,
  TAE_RESULT_NOT_INITIALIZED = 2,
  TAE_RESULT_BACKEND_UNAVAILABLE = 3,
  TAE_RESULT_INTERNAL_ERROR = 4
} TAE_Result;

typedef void (*TAE_EventCallback)(const char* event_type, const char* payload_json, void* user_data);

TAE_API TAE_Result TAE_CreateEngine(TAE_EngineHandle* out_engine);
TAE_API void TAE_DestroyEngine(TAE_EngineHandle engine);
TAE_API TAE_Result TAE_SetEventCallback(TAE_EngineHandle engine, TAE_EventCallback callback, void* user_data);

TAE_API TAE_Result TAE_Play(TAE_EngineHandle engine, const char* source, double start_time_seconds);
TAE_API TAE_Result TAE_Pause(TAE_EngineHandle engine);
TAE_API TAE_Result TAE_Stop(TAE_EngineHandle engine);
TAE_API TAE_Result TAE_Seek(TAE_EngineHandle engine, double position_seconds);
TAE_API TAE_Result TAE_SetVolume(TAE_EngineHandle engine, double volume);
TAE_API TAE_Result TAE_SetPlaybackRate(TAE_EngineHandle engine, double rate);
/**
 * Sample-timed A-B loop on the active track.
 * Pass end_seconds <= start_seconds (or either negative) to clear the range.
 * Enforcement runs on the engine control/clock path (seek is not RT-safe).
 */
TAE_API TAE_Result TAE_SetLoopRange(TAE_EngineHandle engine, double start_seconds, double end_seconds);
TAE_API TAE_Result TAE_SetOutputDevice(TAE_EngineHandle engine, const char* device_id);
TAE_API TAE_Result TAE_SetOutputBackend(TAE_EngineHandle engine, const char* backend_id);

TAE_API TAE_Result TAE_LoadQueue(TAE_EngineHandle engine, const char* queue_json, int start_index);
TAE_API TAE_Result TAE_AddToQueue(TAE_EngineHandle engine, const char* item_json);
TAE_API TAE_Result TAE_RemoveFromQueue(TAE_EngineHandle engine, int index);
TAE_API TAE_Result TAE_Next(TAE_EngineHandle engine);
TAE_API TAE_Result TAE_Previous(TAE_EngineHandle engine);
TAE_API TAE_Result TAE_SetPlayMode(TAE_EngineHandle engine, const char* mode);
TAE_API TAE_Result TAE_GetQueue(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_GetUpcomingTrack(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);

TAE_API TAE_Result TAE_SetDspConfig(TAE_EngineHandle engine, const char* dsp_config_json);
TAE_API TAE_Result TAE_SetDspGraph(TAE_EngineHandle engine, const char* dsp_graph_json);
TAE_API TAE_Result TAE_ApplyDspState(
    TAE_EngineHandle engine,
    uint64_t revision,
    const char* dsp_state_json);
TAE_API TAE_Result TAE_SetOutputConfig(TAE_EngineHandle engine, const char* output_config_json);
TAE_API TAE_Result TAE_GetDspConfig(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_GetDspGraphStatus(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_LoadImpulseResponse(TAE_EngineHandle engine, const char* path);
TAE_API TAE_Result TAE_UnloadImpulseResponse(TAE_EngineHandle engine);
TAE_API TAE_Result TAE_GetConvolverInfo(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_SetEqBands(TAE_EngineHandle engine, const char* eq_json);
TAE_API TAE_Result TAE_SetEqPreset(TAE_EngineHandle engine, const char* preset_json);
TAE_API TAE_Result TAE_SetCrossfeedStrength(TAE_EngineHandle engine, double strength);
TAE_API TAE_Result TAE_SetReplayGainMode(
    TAE_EngineHandle engine,
    const char* mode,
    double preamp_db,
    double fallback_db,
    int clip);
TAE_API TAE_Result TAE_SetDspPluginChain(TAE_EngineHandle engine, const char* chain_json);
TAE_API TAE_Result TAE_GetDspPluginStatus(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_GetMetadata(
    TAE_EngineHandle engine,
    const char* source,
    char* buffer,
    size_t buffer_size,
    size_t* required_size);
TAE_API TAE_Result TAE_EnumerateDevices(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_EnumerateBackends(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_GetEngineCapabilities(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_GetLastError(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
/**
 * Engine diagnostic event log (bounded process-wide ring). Returns a JSON
 * array of events with sequence > since_sequence, oldest first, capped at
 * max_entries (0 uses the engine default). next_sequence receives the cursor
 * to pass on the next call so repeated polls only ever see new events.
 */
TAE_API TAE_Result TAE_GetDiagnosticLog(
    TAE_EngineHandle engine,
    uint64_t since_sequence,
    size_t max_entries,
    char* buffer,
    size_t buffer_size,
    size_t* required_size,
    uint64_t* next_sequence);

TAE_API TAE_Result TAE_GetPlaybackInfo(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_GetSpectrumData(TAE_EngineHandle engine, float* buffer, size_t point_count, size_t* written_count);
TAE_API TAE_Result TAE_GetVisualizationData(
    TAE_EngineHandle engine,
    const char* options_json,
    char* buffer,
    size_t buffer_size,
    size_t* required_size);
TAE_API TAE_Result TAE_AnalyzeBpm(
    TAE_EngineHandle engine,
    const char* source,
    const char* options_json,
    char* buffer,
    size_t buffer_size,
    size_t* required_size);
TAE_API TAE_Result TAE_AnalyzeLoudness(
    TAE_EngineHandle engine,
    const char* source,
    const char* options_json,
    char* buffer,
    size_t buffer_size,
    size_t* required_size);
/* Diagnostic counter: number of actual analyzer executions, excluding cached size-probe reads. */
TAE_API uint64_t TAE_GetAnalysisExecutionCount(const char* analysis_kind);
TAE_API const char* TAE_GetVersion(void);

#ifdef __cplusplus
}
#endif
