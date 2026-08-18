import 'package:flutter/material.dart';

const kPlayerSurface = Color(0xFFE2E2DF);
const kPlayerInk = Color(0xFF07111E);
const kPlayerMuted = Color(0xFF70757C);
const List<String> kPlayerFontFallback = [
  'Noto Sans CJK SC',
  'Source Han Sans SC',
  'HarmonyOS Sans SC',
  'PingFang SC',
  'Microsoft YaHei',
];

Color playerSurface(BuildContext context) {
  final scheme = Theme.of(context).colorScheme;
  return scheme.brightness == Brightness.dark
      ? scheme.surfaceContainerLow
      : kPlayerSurface;
}

Color playerInk(BuildContext context) {
  final scheme = Theme.of(context).colorScheme;
  return scheme.brightness == Brightness.dark ? scheme.onSurface : kPlayerInk;
}

Color playerMuted(BuildContext context) {
  final scheme = Theme.of(context).colorScheme;
  return scheme.brightness == Brightness.dark
      ? scheme.onSurfaceVariant
      : kPlayerMuted;
}
