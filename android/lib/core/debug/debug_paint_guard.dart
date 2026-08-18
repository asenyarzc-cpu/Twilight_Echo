import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

class DebugPaintGuard {
  const DebugPaintGuard._();

  static void install() {
    assert(() {
      _disable();
      WidgetsBinding.instance.addPersistentFrameCallback((_) => _disable());
      return true;
    }());
  }

  static void disableNow() {
    assert(() {
      _disable();
      return true;
    }());
  }

  static void _disable() {
    WidgetsApp.showPerformanceOverlayOverride = false;
    WidgetsBinding.instance.debugExcludeRootWidgetInspector = true;
    WidgetsBinding.instance.debugShowWidgetInspectorOverrideNotifier.value =
        false;
    WidgetsBinding.instance.debugWidgetInspectorSelectionOnTapEnabled.value =
        false;
    debugPaintSizeEnabled = false;
    debugPaintBaselinesEnabled = false;
    debugPaintLayerBordersEnabled = false;
    debugPaintTextLayoutBoxes = false;
    debugPaintPointersEnabled = false;
    debugRepaintRainbowEnabled = false;
    debugRepaintTextRainbowEnabled = false;
  }
}
