import 'package:flutter/material.dart';
import 'package:dynamic_color/dynamic_color.dart';
import 'package:material_color_utilities/material_color_utilities.dart';

// CorePalette is still the public Android palette returned by dynamic_color
// 1.8.x, even though material_color_utilities marks it deprecated internally.
// ignore_for_file: deprecated_member_use

class DynamicColorScheme {
  const DynamicColorScheme._();

  static ColorScheme fromCorePalette(
    CorePalette palette, {
    required Brightness brightness,
  }) {
    final scheme = palette.toColorScheme(brightness: brightness);
    final dynamicScheme = DynamicScheme(
      sourceColorHct: Hct.fromInt(scheme.primary.toARGB32()),
      variant: Variant.tonalSpot,
      isDark: brightness == Brightness.dark,
      contrastLevel: 0,
      primaryPalette: palette.primary,
      secondaryPalette: palette.secondary,
      tertiaryPalette: palette.tertiary,
      neutralPalette: palette.neutral,
      neutralVariantPalette: palette.neutralVariant,
    );

    return scheme.copyWith(
      surfaceDim: Color(dynamicScheme.surfaceDim),
      surfaceBright: Color(dynamicScheme.surfaceBright),
      surfaceContainerLowest: Color(dynamicScheme.surfaceContainerLowest),
      surfaceContainerLow: Color(dynamicScheme.surfaceContainerLow),
      surfaceContainer: Color(dynamicScheme.surfaceContainer),
      surfaceContainerHigh: Color(dynamicScheme.surfaceContainerHigh),
      surfaceContainerHighest: Color(dynamicScheme.surfaceContainerHighest),
      primaryFixed: Color(dynamicScheme.primaryFixed),
      primaryFixedDim: Color(dynamicScheme.primaryFixedDim),
      onPrimaryFixed: Color(dynamicScheme.onPrimaryFixed),
      onPrimaryFixedVariant: Color(dynamicScheme.onPrimaryFixedVariant),
      secondaryFixed: Color(dynamicScheme.secondaryFixed),
      secondaryFixedDim: Color(dynamicScheme.secondaryFixedDim),
      onSecondaryFixed: Color(dynamicScheme.onSecondaryFixed),
      onSecondaryFixedVariant: Color(dynamicScheme.onSecondaryFixedVariant),
      tertiaryFixed: Color(dynamicScheme.tertiaryFixed),
      tertiaryFixedDim: Color(dynamicScheme.tertiaryFixedDim),
      onTertiaryFixed: Color(dynamicScheme.onTertiaryFixed),
      onTertiaryFixedVariant: Color(dynamicScheme.onTertiaryFixedVariant),
      surfaceTint: scheme.primary,
    );
  }
}
