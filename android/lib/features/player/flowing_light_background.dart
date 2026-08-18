import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

/// A cached, static frame of the light-mode flowing backdrop.
///
/// The renderer draws this composition once at a reduced screen resolution and
/// lets [RawImage] fill the viewport. Keeping the blur out of the live scene
/// avoids rerasterizing the full-screen filter while lyrics animate.
class FlowingLightBackground extends StatefulWidget {
  const FlowingLightBackground({
    super.key,
    required this.imageProvider,
    required this.backgroundColor,
    required this.brightness,
  });

  final ImageProvider<Object> imageProvider;
  final Color backgroundColor;
  final Brightness brightness;

  @override
  State<FlowingLightBackground> createState() => _FlowingLightBackgroundState();
}

class _FlowingLightBackgroundState extends State<FlowingLightBackground> {
  ImageStream? _imageStream;
  ImageStreamListener? _imageListener;
  ui.Image? _sourceImage;
  ui.Image? _backgroundImage;
  _FlowingLightRenderSpec? _requestedSpec;
  int _imageGeneration = 0;
  int _renderGeneration = 0;
  bool _renderScheduled = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _subscribeToArtwork();
  }

  @override
  void didUpdateWidget(covariant FlowingLightBackground oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.imageProvider != oldWidget.imageProvider) {
      _subscribeToArtwork();
    }
  }

  void _subscribeToArtwork() {
    final stream = widget.imageProvider.resolve(
      createLocalImageConfiguration(context),
    );
    if (_imageStream?.key == stream.key) return;

    final oldListener = _imageListener;
    if (oldListener != null) _imageStream?.removeListener(oldListener);

    final generation = ++_imageGeneration;
    final listener = ImageStreamListener((imageInfo, synchronousCall) {
      if (!mounted || generation != _imageGeneration) return;
      final source = imageInfo.image.clone();
      final previous = _sourceImage;
      _sourceImage = source;
      previous?.dispose();
      _scheduleRender();
    }, onError: (Object error, StackTrace? stackTrace) {});
    _imageStream = stream;
    _imageListener = listener;
    stream.addListener(listener);
  }

  void _scheduleRender() {
    if (_renderScheduled || _sourceImage == null || _requestedSpec == null) {
      return;
    }
    _renderScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _renderScheduled = false;
      if (!mounted) return;
      unawaited(_renderCurrentSpec());
    });
  }

  Future<void> _renderCurrentSpec() async {
    final source = _sourceImage;
    final spec = _requestedSpec;
    if (source == null || spec == null) return;

    final generation = ++_renderGeneration;
    final sourceClone = source.clone();
    ui.Image rendered;
    try {
      rendered = await _renderFlowingLightFrame(sourceClone, spec);
    } finally {
      sourceClone.dispose();
    }
    if (!mounted || generation != _renderGeneration || spec != _requestedSpec) {
      rendered.dispose();
      return;
    }

    final previous = _backgroundImage;
    setState(() => _backgroundImage = rendered);
    if (previous != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => previous.dispose());
    }
  }

  @override
  void dispose() {
    _imageGeneration++;
    _renderGeneration++;
    final listener = _imageListener;
    if (listener != null) _imageStream?.removeListener(listener);
    _sourceImage?.dispose();
    _backgroundImage?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        final height = constraints.maxHeight;
        if (!width.isFinite || !height.isFinite || width <= 0 || height <= 0) {
          return ColoredBox(color: widget.backgroundColor);
        }

        final devicePixelRatio = MediaQuery.devicePixelRatioOf(context);
        final physicalWidth = math.max(1, (width * devicePixelRatio).round());
        final physicalHeight = math.max(1, (height * devicePixelRatio).round());
        final compositionScale = devicePixelRatio * 160 >= 420 ? 32 : 20;
        final spec = _FlowingLightRenderSpec(
          // Preserve the old tiny-canvas composition and blur, then bake its
          // visible crop into this safe quarter-resolution texture. The UI no
          // longer has to transform a tiny GPU texture by 20-32x.
          bufferWidth: math.max(1, (physicalWidth / 4).ceil()),
          bufferHeight: math.max(1, (physicalHeight / 4).ceil()),
          compositionWidth: math.max(
            1,
            (physicalWidth / compositionScale + 58).ceil(),
          ),
          compositionHeight: math.max(
            1,
            (physicalHeight / compositionScale + 58).ceil(),
          ),
          visibleCompositionWidth: physicalWidth / compositionScale,
          visibleCompositionHeight: physicalHeight / compositionScale,
          dark: widget.brightness == Brightness.dark,
        );
        if (_requestedSpec != spec) {
          _requestedSpec = spec;
          _scheduleRender();
        }

        final image = _backgroundImage;
        return ClipRect(
          key: const ValueKey('flowing-light-background'),
          child: Stack(
            fit: StackFit.expand,
            children: [
              ColoredBox(color: widget.backgroundColor),
              if (image != null)
                RawImage(
                  key: const ValueKey('flowing-light-image'),
                  image: image,
                  width: double.infinity,
                  height: double.infinity,
                  fit: BoxFit.fill,
                  filterQuality: FilterQuality.low,
                ),
            ],
          ),
        );
      },
    );
  }
}

@immutable
class _FlowingLightRenderSpec {
  const _FlowingLightRenderSpec({
    required this.bufferWidth,
    required this.bufferHeight,
    required this.compositionWidth,
    required this.compositionHeight,
    required this.visibleCompositionWidth,
    required this.visibleCompositionHeight,
    required this.dark,
  });

  final int bufferWidth;
  final int bufferHeight;
  final int compositionWidth;
  final int compositionHeight;
  final double visibleCompositionWidth;
  final double visibleCompositionHeight;
  final bool dark;

  @override
  bool operator ==(Object other) {
    return other is _FlowingLightRenderSpec &&
        bufferWidth == other.bufferWidth &&
        bufferHeight == other.bufferHeight &&
        compositionWidth == other.compositionWidth &&
        compositionHeight == other.compositionHeight &&
        visibleCompositionWidth == other.visibleCompositionWidth &&
        visibleCompositionHeight == other.visibleCompositionHeight &&
        dark == other.dark;
  }

  @override
  int get hashCode => Object.hash(
    bufferWidth,
    bufferHeight,
    compositionWidth,
    compositionHeight,
    visibleCompositionWidth,
    visibleCompositionHeight,
    dark,
  );
}

Future<ui.Image> _renderFlowingLightFrame(
  ui.Image source,
  _FlowingLightRenderSpec spec,
) async {
  final averageColor = await _sampleFiveByFiveAverage(source);
  final width = spec.compositionWidth.toDouble();
  final height = spec.compositionHeight.toDouble();
  final bounds = Rect.fromLTWH(0, 0, width, height);
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder)..clipRect(bounds);
  final blurPaint = Paint()
    ..imageFilter = ui.ImageFilter.blur(
      sigmaX: 25,
      sigmaY: 25,
      tileMode: TileMode.clamp,
    );

  canvas.saveLayer(bounds, blurPaint);
  canvas.drawColor(averageColor, BlendMode.src);

  final artworkPaint = Paint()
    ..isAntiAlias = true
    ..filterQuality = FilterQuality.low
    ..colorFilter = const ColorFilter.matrix(_artworkSaturationMatrix);
  final side = (math.max(width, height) * 1.3).roundToDouble();
  final left = -(side - width) / 2;
  final top = -(side - height) / 2;

  _drawArtworkLayer(
    canvas,
    source,
    artworkPaint,
    side: side,
    left: left,
    top: top,
  );
  _drawArtworkLayer(
    canvas,
    source,
    artworkPaint,
    side: side,
    left: left - width * 0.95,
    top: top - height * 0.7,
  );
  _drawArtworkLayer(
    canvas,
    source,
    artworkPaint,
    side: side,
    left: left - width * 0.5,
    top: top + height * 0.7,
  );

  // Each theme mode uses a separate two-scrim pair.
  if (spec.dark) {
    canvas.drawColor(const Color(0x52000000), BlendMode.srcOver);
    canvas.drawColor(const Color(0x1A000000), BlendMode.srcOver);
  } else {
    canvas.drawColor(const Color(0x95FFFFFF), BlendMode.srcOver);
    canvas.drawColor(const Color(0x2AFFFFFF), BlendMode.srcOver);
  }
  canvas.restore();

  final picture = recorder.endRecording();
  ui.Image composition;
  try {
    composition = await picture.toImage(
      spec.compositionWidth,
      spec.compositionHeight,
    );
  } finally {
    picture.dispose();
  }

  try {
    final horizontalInset = math.max(
      0.0,
      (spec.compositionWidth - spec.visibleCompositionWidth) / 2,
    );
    final verticalInset = math.max(
      0.0,
      (spec.compositionHeight - spec.visibleCompositionHeight) / 2,
    );
    final sourceRect = Rect.fromLTRB(
      horizontalInset,
      verticalInset,
      spec.compositionWidth - horizontalInset,
      spec.compositionHeight - verticalInset,
    );
    final outputBounds = Rect.fromLTWH(
      0,
      0,
      spec.bufferWidth.toDouble(),
      spec.bufferHeight.toDouble(),
    );
    final outputRecorder = ui.PictureRecorder();
    final outputCanvas = Canvas(outputRecorder)..clipRect(outputBounds);
    outputCanvas.drawImageRect(
      composition,
      sourceRect,
      outputBounds,
      Paint()..filterQuality = FilterQuality.medium,
    );
    final outputPicture = outputRecorder.endRecording();
    try {
      return await outputPicture.toImage(spec.bufferWidth, spec.bufferHeight);
    } finally {
      outputPicture.dispose();
    }
  } finally {
    composition.dispose();
  }
}

void _drawArtworkLayer(
  Canvas canvas,
  ui.Image source,
  Paint paint, {
  required double side,
  required double left,
  required double top,
}) {
  final scale = side / source.height;
  canvas.save();
  canvas.translate(left, top);
  canvas.scale(scale, scale);
  canvas.drawImage(source, Offset.zero, paint);
  canvas.restore();
}

Future<Color> _sampleFiveByFiveAverage(ui.Image source) async {
  final data = await source.toByteData(format: ui.ImageByteFormat.rawRgba);
  if (data == null || source.width <= 0 || source.height <= 0) {
    return Colors.black;
  }

  final bytes = data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
  var red = 0;
  var green = 0;
  var blue = 0;
  var count = 0;
  for (var row = 0; row < 5; row++) {
    final y = (((row + 0.5) * source.height) / 5).floor().clamp(
      0,
      source.height - 1,
    );
    for (var column = 0; column < 5; column++) {
      final x = (((column + 0.5) * source.width) / 5).floor().clamp(
        0,
        source.width - 1,
      );
      final offset = (y * source.width + x) * 4;
      final alpha = bytes[offset + 3];
      red += bytes[offset] * alpha ~/ 255;
      green += bytes[offset + 1] * alpha ~/ 255;
      blue += bytes[offset + 2] * alpha ~/ 255;
      count++;
    }
  }
  if (count == 0) return Colors.black;
  return Color.fromARGB(255, red ~/ count, green ~/ count, blue ~/ count);
}

const List<double> _artworkSaturationMatrix = [
  2.1805,
  -1.0725,
  -0.108,
  0,
  0,
  -0.3195,
  1.4275,
  -0.108,
  0,
  0,
  -0.3195,
  -1.0725,
  2.392,
  0,
  0,
  0,
  0,
  0,
  1,
  0,
];
