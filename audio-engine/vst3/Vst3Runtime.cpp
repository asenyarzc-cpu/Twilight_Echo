#include "Vst3Runtime.h"

#include "../core/Utf8Path.h"

#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/vstspeaker.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/utility/memoryibstream.h"
#include "public.sdk/source/vst/vstpresetfile.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace twilight::vst3 {
namespace {

constexpr uint32_t kMaxChannels = 8;
constexpr uint32_t kMaxParameters = 2048;
constexpr uintmax_t kMaxStateBytes = 64u * 1024u * 1024u;

struct ParameterValue {
  Steinberg::Vst::ParamID id = 0;
  Steinberg::Vst::ParamValue value = 0.0;
};

bool isSpace(char value) {
  return value == ' ' || value == '\t' || value == '\r' || value == '\n';
}

void skipSpace(std::string_view value, size_t* cursor) {
  while (*cursor < value.size() && isSpace(value[*cursor])) ++*cursor;
}

bool consume(std::string_view value, size_t* cursor, char expected) {
  skipSpace(value, cursor);
  if (*cursor >= value.size() || value[*cursor] != expected) return false;
  ++*cursor;
  return true;
}

bool parseParametersJson(
    const std::string& json,
    std::vector<ParameterValue>* parameters,
    std::string* error) {
  parameters->clear();
  std::string_view value(json);
  if (value.empty()) value = "{}";
  size_t cursor = 0;
  if (!consume(value, &cursor, '{')) {
    if (error) *error = "VST3 parameters must be a JSON object";
    return false;
  }
  skipSpace(value, &cursor);
  if (cursor < value.size() && value[cursor] == '}') {
    ++cursor;
    skipSpace(value, &cursor);
    return cursor == value.size();
  }

  while (cursor < value.size()) {
    if (!consume(value, &cursor, '"')) {
      if (error) *error = "VST3 parameter IDs must be JSON string keys";
      return false;
    }
    const size_t keyBegin = cursor;
    while (cursor < value.size() && value[cursor] != '"') {
      if (value[cursor] == '\\') {
        if (error) *error = "VST3 parameter IDs must not contain escapes";
        return false;
      }
      ++cursor;
    }
    if (cursor >= value.size()) {
      if (error) *error = "VST3 parameter JSON has an unterminated key";
      return false;
    }
    const std::string_view key = value.substr(keyBegin, cursor - keyBegin);
    ++cursor;
    if (!consume(value, &cursor, ':')) {
      if (error) *error = "VST3 parameter JSON is missing a value separator";
      return false;
    }

    uint32_t parameterId = 0;
    const auto idResult = std::from_chars(key.data(), key.data() + key.size(), parameterId);
    if (idResult.ec != std::errc{} || idResult.ptr != key.data() + key.size()) {
      if (error) *error = "VST3 parameter IDs must be unsigned integers";
      return false;
    }

    skipSpace(value, &cursor);
    const char* numberStart = value.data() + cursor;
    char* numberEnd = nullptr;
    const double normalized = std::strtod(numberStart, &numberEnd);
    if (numberEnd == numberStart || !std::isfinite(normalized) || normalized < 0.0 || normalized > 1.0) {
      if (error) *error = "VST3 parameter values must be finite normalized values between 0 and 1";
      return false;
    }
    cursor = static_cast<size_t>(numberEnd - value.data());

    auto existing = std::find_if(parameters->begin(), parameters->end(), [parameterId](const ParameterValue& item) {
      return item.id == parameterId;
    });
    if (existing != parameters->end()) {
      existing->value = normalized;
    } else {
      if (parameters->size() >= kMaxParameters) {
        if (error) *error = "VST3 parameter count exceeds the managed host limit";
        return false;
      }
      parameters->push_back({parameterId, normalized});
    }

    skipSpace(value, &cursor);
    if (cursor < value.size() && value[cursor] == '}') {
      ++cursor;
      skipSpace(value, &cursor);
      if (cursor == value.size()) return true;
      if (error) *error = "VST3 parameter JSON has trailing data";
      return false;
    }
    if (!consume(value, &cursor, ',')) {
      if (error) *error = "VST3 parameter JSON is missing a comma";
      return false;
    }
  }

  if (error) *error = "VST3 parameter JSON has an unterminated object";
  return false;
}

bool equalCaseInsensitive(std::string_view left, std::string_view right) {
  if (left.size() != right.size()) return false;
  for (size_t index = 0; index < left.size(); ++index) {
    const char leftCharacter = left[index];
    const char rightCharacter = right[index];
    const char normalizedLeft = leftCharacter >= 'a' && leftCharacter <= 'z'
                                     ? static_cast<char>(leftCharacter - ('a' - 'A'))
                                     : leftCharacter;
    const char normalizedRight = rightCharacter >= 'a' && rightCharacter <= 'z'
                                      ? static_cast<char>(rightCharacter - ('a' - 'A'))
                                      : rightCharacter;
    if (normalizedLeft != normalizedRight) return false;
  }
  return true;
}

bool speakerArrangementForChannels(uint32_t channels, Steinberg::Vst::SpeakerArrangement* arrangement) {
  if (!arrangement) return false;
  switch (channels) {
    case 1:
      *arrangement = Steinberg::Vst::SpeakerArr::kMono;
      return true;
    case 2:
      *arrangement = Steinberg::Vst::SpeakerArr::kStereo;
      return true;
    case 6:
      *arrangement = Steinberg::Vst::SpeakerArr::k51;
      return true;
    case 8:
      // Twilight Echo uses L, R, C, LFE, Ls, Rs, Lrs, Rrs, matching the
      // VST3 7.1 music arrangement rather than the cinema rear-center order.
      *arrangement = Steinberg::Vst::SpeakerArr::k71Music;
      return true;
    default:
      return false;
  }
}

std::string resultError(const char* operation, Steinberg::tresult result) {
  return std::string(operation) + " failed with VST3 result " + std::to_string(result);
}

bool isStateResultOk(Steinberg::tresult result) {
  return result == Steinberg::kResultOk || result == Steinberg::kResultTrue ||
         result == Steinberg::kNotImplemented;
}

}  // namespace

class Vst3Runtime::Impl {
 public:
  bool initialize(const RuntimeConfig& config, RuntimeInfo* info) {
    shutdown();
    config_ = config;
    if (config.modulePath.empty() || config.classId.empty()) {
      return fail(info, "VST3 module path and class ID are required");
    }
    if (config.sampleRate == 0 || config.maxFrames == 0 || config.maxFrames > 4096 ||
        !speakerArrangementForChannels(config.channels, &arrangement_)) {
      return fail(info, "VST3 hosting supports only Mono, Stereo, 5.1, or 7.1 PCM formats");
    }
    if (!parseParametersJson(config.parametersJson, &parameters_, &parameterError_)) {
      return fail(info, parameterError_);
    }
    if (config.statePath.empty() != config.stateFormat.empty() ||
        (!config.stateFormat.empty() && config.stateFormat != "preset" &&
         config.stateFormat != "componentState")) {
      return fail(info, "VST3 state assets require a preset or componentState format");
    }

    std::string moduleError;
    module_ = VST3::Hosting::Module::create(config.modulePath, moduleError);
    if (!module_) return fail(info, moduleError.empty() ? "VST3 module could not be loaded" : moduleError);

    const auto classInfos = module_->getFactory().classInfos();
    const auto classIt = std::find_if(classInfos.begin(), classInfos.end(), [&](const auto& classInfo) {
      return classInfo.category() == kVstAudioEffectClass &&
             equalCaseInsensitive(classInfo.ID().toString(), config.classId);
    });
    if (classIt == classInfos.end()) {
      return fail(info, "The requested VST3 audio-effect class was not found in this module");
    }

    hostApplication_ = std::make_unique<Steinberg::Vst::HostApplication>();
    module_->getFactory().setHostContext(hostApplication_.get());
    Steinberg::Vst::PluginContextFactory::instance().setPluginContext(hostApplication_.get());
    Steinberg::Vst::PlugProvider::setErrorStream(nullptr);
    provider_ = std::make_unique<Steinberg::Vst::PlugProvider>(module_->getFactory(), *classIt, true);
    if (!provider_->initialize()) return fail(info, "The VST3 component could not be initialized");

    component_ = provider_->getComponentPtr();
    controller_ = provider_->getControllerPtr();
    if (!component_) return fail(info, "The VST3 provider did not expose an IComponent");
    Steinberg::Vst::IAudioProcessor* rawProcessor = nullptr;
    if (component_->queryInterface(
            Steinberg::Vst::IAudioProcessor::iid,
            reinterpret_cast<void**>(&rawProcessor)) != Steinberg::kResultTrue ||
        !rawProcessor) {
      return fail(info, "The VST3 component does not expose IAudioProcessor");
    }
    processor_ = Steinberg::owned(rawProcessor);

    const Steinberg::FUID componentClassId = Steinberg::FUID::fromTUID(classIt->ID().data());
    if (!restoreManagedState(componentClassId, info)) return false;

    const Steinberg::int32 inputBusCount = component_->getBusCount(Steinberg::Vst::kAudio, Steinberg::Vst::kInput);
    const Steinberg::int32 outputBusCount = component_->getBusCount(Steinberg::Vst::kAudio, Steinberg::Vst::kOutput);
    if (inputBusCount != 1 || outputBusCount != 1) {
      return fail(info, "Only VST3 effects with one main input and one main output bus are supported");
    }
    Steinberg::Vst::BusInfo inputBus{};
    Steinberg::Vst::BusInfo outputBus{};
    if (component_->getBusInfo(Steinberg::Vst::kAudio, Steinberg::Vst::kInput, 0, inputBus) != Steinberg::kResultTrue ||
        component_->getBusInfo(Steinberg::Vst::kAudio, Steinberg::Vst::kOutput, 0, outputBus) != Steinberg::kResultTrue ||
        inputBus.busType != Steinberg::Vst::kMain || outputBus.busType != Steinberg::Vst::kMain) {
      return fail(info, "The VST3 effect does not expose a compatible main audio bus");
    }
    if (processor_->canProcessSampleSize(Steinberg::Vst::kSample32) != Steinberg::kResultTrue) {
      return fail(info, "The VST3 effect does not support 32-bit float processing");
    }

    Steinberg::Vst::SpeakerArrangement inputArrangement = arrangement_;
    Steinberg::Vst::SpeakerArrangement outputArrangement = arrangement_;
    if (const auto result = processor_->setBusArrangements(&inputArrangement, 1, &outputArrangement, 1);
        result != Steinberg::kResultTrue) {
      return fail(info, resultError("VST3 bus arrangement negotiation", result));
    }
    Steinberg::Vst::SpeakerArrangement negotiatedInput{};
    Steinberg::Vst::SpeakerArrangement negotiatedOutput{};
    if (processor_->getBusArrangement(Steinberg::Vst::kInput, 0, negotiatedInput) != Steinberg::kResultTrue ||
        processor_->getBusArrangement(Steinberg::Vst::kOutput, 0, negotiatedOutput) != Steinberg::kResultTrue ||
        negotiatedInput != arrangement_ || negotiatedOutput != arrangement_) {
      return fail(info, "The VST3 effect changed the requested channel layout");
    }

    if (!processData_.prepare(*component_, 0, Steinberg::Vst::kSample32) || processData_.numInputs != 1 ||
        processData_.numOutputs != 1 || processData_.inputs[0].numChannels != static_cast<Steinberg::int32>(config.channels) ||
        processData_.outputs[0].numChannels != static_cast<Steinberg::int32>(config.channels)) {
      return fail(info, "The VST3 effect does not provide the requested exact input/output layout");
    }

    for (uint32_t channel = 0; channel < config.channels; ++channel) {
      inputPlanes_[channel].assign(config.maxFrames, 0.0f);
      outputPlanes_[channel].assign(config.maxFrames, 0.0f);
      if (!processData_.setChannelBuffer(
              Steinberg::Vst::kInput,
              0,
              static_cast<Steinberg::int32>(channel),
              inputPlanes_[channel].data()) ||
          !processData_.setChannelBuffer(
              Steinberg::Vst::kOutput,
              0,
              static_cast<Steinberg::int32>(channel),
              outputPlanes_[channel].data())) {
        return fail(info, "Unable to bind the VST3 effect audio buffers");
      }
    }

    processContext_ = {};
    processContext_.state = Steinberg::Vst::ProcessContext::kPlaying | Steinberg::Vst::ProcessContext::kTempoValid |
                            Steinberg::Vst::ProcessContext::kContTimeValid;
    processContext_.sampleRate = static_cast<double>(config.sampleRate);
    processContext_.tempo = 120.0;
    processContext_.projectTimeSamples = 0;
    processContext_.continousTimeSamples = 0;
    processData_.inputParameterChanges = &parameterChanges_;
    processData_.outputParameterChanges = nullptr;
    processData_.inputEvents = nullptr;
    processData_.outputEvents = nullptr;
    processData_.processContext = &processContext_;

    if (const auto result = component_->activateBus(Steinberg::Vst::kAudio, Steinberg::Vst::kInput, 0, true);
        result != Steinberg::kResultTrue) {
      return fail(info, resultError("VST3 input-bus activation", result));
    }
    inputBusActive_ = true;
    if (const auto result = component_->activateBus(Steinberg::Vst::kAudio, Steinberg::Vst::kOutput, 0, true);
        result != Steinberg::kResultTrue) {
      return fail(info, resultError("VST3 output-bus activation", result));
    }
    outputBusActive_ = true;

    Steinberg::Vst::ProcessSetup setup{};
    setup.processMode = Steinberg::Vst::kRealtime;
    setup.symbolicSampleSize = Steinberg::Vst::kSample32;
    setup.maxSamplesPerBlock = static_cast<Steinberg::int32>(config.maxFrames);
    setup.sampleRate = static_cast<double>(config.sampleRate);
    if (const auto result = processor_->setupProcessing(setup); result != Steinberg::kResultTrue) {
      return fail(info, resultError("VST3 processing setup", result));
    }
    if (const auto result = component_->setActive(true); result != Steinberg::kResultTrue) {
      return fail(info, resultError("VST3 activation", result));
    }
    componentActive_ = true;
    if (const auto result = processor_->setProcessing(true); result != Steinberg::kResultTrue) {
      return fail(info, resultError("VST3 processing activation", result));
    }
    processingActive_ = true;

    refreshInfo(info);
    parametersPending_ = !parameters_.empty();
    ready_ = true;
    return true;
  }

  bool process(const float* input, float* output, uint32_t frames, RuntimeInfo* info) {
    if (!ready_ || !processor_ || !input || !output || frames == 0 || frames > config_.maxFrames) {
      return fail(info, "VST3 process received an invalid audio block");
    }
    const size_t channels = config_.channels;
    for (uint32_t frame = 0; frame < frames; ++frame) {
      const size_t sourceOffset = static_cast<size_t>(frame) * channels;
      for (size_t channel = 0; channel < channels; ++channel) {
        inputPlanes_[channel][frame] = input[sourceOffset + channel];
        outputPlanes_[channel][frame] = 0.0f;
      }
    }
    processData_.numSamples = static_cast<Steinberg::int32>(frames);
    processData_.inputs[0].silenceFlags = 0;
    processData_.outputs[0].silenceFlags = 0;
    processContext_.projectTimeSamples += static_cast<Steinberg::Vst::TSamples>(frames);
    processContext_.continousTimeSamples += static_cast<Steinberg::Vst::TSamples>(frames);

    if (parametersPending_) {
      parameterChanges_.clearQueue();
      for (const ParameterValue& parameter : parameters_) {
        Steinberg::int32 index = 0;
        Steinberg::Vst::IParamValueQueue* queue = parameterChanges_.addParameterData(parameter.id, index);
        if (!queue || queue->addPoint(0, parameter.value, index) != Steinberg::kResultTrue) {
          parameterChanges_.clearQueue();
          return fail(info, "Unable to queue a VST3 parameter change");
        }
        if (controller_) controller_->setParamNormalized(parameter.id, parameter.value);
      }
      parametersPending_ = false;
    }

    const Steinberg::tresult result = processor_->process(processData_);
    parameterChanges_.clearQueue();
    if (result != Steinberg::kResultTrue) return fail(info, resultError("VST3 processing", result));

    for (uint32_t frame = 0; frame < frames; ++frame) {
      const size_t destinationOffset = static_cast<size_t>(frame) * channels;
      for (size_t channel = 0; channel < channels; ++channel) {
        output[destinationOffset + channel] = outputPlanes_[channel][frame];
      }
    }
    refreshInfo(info);
    return true;
  }

  void shutdown() {
    if (processor_ && processingActive_) processor_->setProcessing(false);
    processingActive_ = false;
    if (component_ && componentActive_) component_->setActive(false);
    componentActive_ = false;
    if (component_ && inputBusActive_) component_->activateBus(Steinberg::Vst::kAudio, Steinberg::Vst::kInput, 0, false);
    inputBusActive_ = false;
    if (component_ && outputBusActive_) component_->activateBus(Steinberg::Vst::kAudio, Steinberg::Vst::kOutput, 0, false);
    outputBusActive_ = false;
    processData_.unprepare();
    processor_.reset();
    controller_.reset();
    component_.reset();
    provider_.reset();
    Steinberg::Vst::PluginContextFactory::instance().setPluginContext(nullptr);
    hostApplication_.reset();
    module_.reset();
    parameters_.clear();
    for (auto& plane : inputPlanes_) plane.clear();
    for (auto& plane : outputPlanes_) plane.clear();
    ready_ = false;
  }

 private:
  bool restoreManagedState(const Steinberg::FUID& classId, RuntimeInfo* info) {
    if (config_.statePath.empty()) return true;

    std::error_code fileError;
    const std::filesystem::path statePath = std::filesystem::u8path(config_.statePath);
    const uintmax_t size = std::filesystem::file_size(utf8Path(statePath), fileError);
    if (fileError || size == 0 || size > kMaxStateBytes) {
      return fail(info, "The managed VST3 state file is missing, empty, or exceeds 64 MiB");
    }

    std::ifstream input(utf8Path(statePath), std::ios::binary);
    if (!input) return fail(info, "Unable to open the managed VST3 state file");
    std::vector<uint8_t> bytes(static_cast<size_t>(size));
    input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    if (!input || input.gcount() != static_cast<std::streamsize>(bytes.size())) {
      return fail(info, "Unable to read the managed VST3 state file");
    }

    const auto makeStream = [&bytes]() -> Steinberg::IPtr<Steinberg::IBStream> {
      auto stream = Steinberg::owned(new Steinberg::ResizableMemoryIBStream(bytes.size()));
      Steinberg::int32 written = 0;
      if (stream->write(bytes.data(), static_cast<Steinberg::int32>(bytes.size()), &written) != Steinberg::kResultTrue ||
          written != static_cast<Steinberg::int32>(bytes.size())) {
        return {};
      }
      stream->rewind();
      return stream;
    };

    auto stream = makeStream();
    if (!stream) return fail(info, "Unable to prepare the managed VST3 state stream");
    if (config_.stateFormat == "preset") {
      if (!Steinberg::Vst::PresetFile::loadPreset(stream, classId, component_, controller_)) {
        return fail(info, "The VST3 preset is invalid or targets a different component class");
      }
      return true;
    }

    if (!isStateResultOk(component_->setState(stream))) {
      return fail(info, "The VST3 component rejected its managed state");
    }
    if (!controller_) return true;
    stream = makeStream();
    if (!stream || !isStateResultOk(controller_->setComponentState(stream))) {
      return fail(info, "The VST3 controller rejected the managed component state");
    }
    return true;
  }

  bool fail(RuntimeInfo* info, const std::string& error) {
    if (info) info->error = error.empty() ? "VST3 runtime failed" : error;
    return false;
  }

  void refreshInfo(RuntimeInfo* info) {
    if (!info || !processor_) return;
    info->latencyFrames = processor_->getLatencySamples();
    info->tailFrames = processor_->getTailSamples();
    info->error.clear();
  }

  RuntimeConfig config_;
  Steinberg::Vst::SpeakerArrangement arrangement_ = Steinberg::Vst::SpeakerArr::kEmpty;
  VST3::Hosting::Module::Ptr module_;
  std::unique_ptr<Steinberg::Vst::HostApplication> hostApplication_;
  std::unique_ptr<Steinberg::Vst::PlugProvider> provider_;
  Steinberg::IPtr<Steinberg::Vst::IComponent> component_;
  Steinberg::IPtr<Steinberg::Vst::IEditController> controller_;
  Steinberg::IPtr<Steinberg::Vst::IAudioProcessor> processor_;
  Steinberg::Vst::HostProcessData processData_;
  Steinberg::Vst::ProcessContext processContext_{};
  Steinberg::Vst::ParameterChanges parameterChanges_{static_cast<Steinberg::int32>(kMaxParameters)};
  std::array<std::vector<float>, kMaxChannels> inputPlanes_;
  std::array<std::vector<float>, kMaxChannels> outputPlanes_;
  std::vector<ParameterValue> parameters_;
  std::string parameterError_;
  bool parametersPending_ = false;
  bool inputBusActive_ = false;
  bool outputBusActive_ = false;
  bool componentActive_ = false;
  bool processingActive_ = false;
  bool ready_ = false;
};

Vst3Runtime::Vst3Runtime() : impl_(std::make_unique<Impl>()) {}

Vst3Runtime::~Vst3Runtime() {
  shutdown();
}

bool Vst3Runtime::initialize(const RuntimeConfig& config) {
  info_ = {};
  if (!impl_) impl_ = std::make_unique<Impl>();
  if (!impl_->initialize(config, &info_)) {
    impl_->shutdown();
    return false;
  }
  return true;
}

bool Vst3Runtime::process(const float* input, float* output, uint32_t frames) {
  if (!impl_ || !impl_->process(input, output, frames, &info_)) return false;
  return true;
}

void Vst3Runtime::shutdown() {
  if (impl_) impl_->shutdown();
}

}  // namespace twilight::vst3
