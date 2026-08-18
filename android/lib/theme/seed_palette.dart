import 'package:flutter/material.dart';

class SeedPalette {
  const SeedPalette._();

  static const Color defaultSeed = Colors.blue;

  static const List<SeedColor> presets = [
    SeedColor('Blue', Colors.blue),
    SeedColor('Purple', Colors.purple),
    SeedColor('Green', Colors.green),
    SeedColor('Orange', Colors.orange),
    SeedColor('Pink', Colors.pink),
    SeedColor('Teal', Colors.teal),
    SeedColor('Red', Colors.red),
    SeedColor('Indigo', Colors.indigo),
    SeedColor('Amber', Colors.amber),
    SeedColor('Cyan', Color(0xFF00BCD4)),
  ];
}

@immutable
class SeedColor {
  const SeedColor(this.name, this.color);

  final String name;
  final Color color;
}
