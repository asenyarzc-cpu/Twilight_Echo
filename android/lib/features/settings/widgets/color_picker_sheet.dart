import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../theme/app_theme.dart';

Future<Color?> showColorPickerSheet(BuildContext context, Color initial) {
  return showModalBottomSheet<Color>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (ctx) => _ColorPickerSheet(initial: initial),
  );
}

class _ColorPickerSheet extends StatefulWidget {
  const _ColorPickerSheet({required this.initial});

  final Color initial;

  @override
  State<_ColorPickerSheet> createState() => _ColorPickerSheetState();
}

class _ColorPickerSheetState extends State<_ColorPickerSheet> {
  late HSVColor _hsv;
  late TextEditingController _hexCtrl;
  bool _editingHex = false;

  @override
  void initState() {
    super.initState();
    _hsv = HSVColor.fromColor(widget.initial);
    _hexCtrl = TextEditingController(text: _toHex(widget.initial));
  }

  @override
  void dispose() {
    _hexCtrl.dispose();
    super.dispose();
  }

  String _toHex(Color color) {
    final value = color.toARGB32() & 0xFFFFFF;
    return value.toRadixString(16).padLeft(6, '0').toUpperCase();
  }

  Color get _color => _hsv.toColor();

  void _setHsv(HSVColor next) {
    setState(() {
      _hsv = next;
      if (!_editingHex) {
        _hexCtrl.text = _toHex(next.toColor());
      }
    });
  }

  void _applyHex(String value) {
    var text = value.trim();
    if (text.startsWith('#')) text = text.substring(1);
    if (text.length != 6 && text.length != 8) return;

    final parsed = int.tryParse(text, radix: 16);
    if (parsed == null) return;
    final argb = text.length == 6 ? (0xFF000000 | parsed) : parsed;
    setState(() {
      _hsv = HSVColor.fromColor(Color(argb));
    });
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final preview = ColorScheme.fromSeed(
      seedColor: _color,
      brightness: Theme.of(context).brightness,
    );
    final viewInsets = MediaQuery.viewInsetsOf(context);

    return Padding(
      padding: EdgeInsets.only(bottom: viewInsets.bottom),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Container(
                  width: 56,
                  height: 56,
                  decoration: BoxDecoration(
                    color: _color,
                    shape: BoxShape.circle,
                    border: Border.all(color: scheme.outlineVariant),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: TextField(
                    controller: _hexCtrl,
                    decoration: const InputDecoration(
                      prefixText: '#',
                      labelText: 'HEX',
                      border: OutlineInputBorder(),
                      isDense: true,
                    ),
                    textCapitalization: TextCapitalization.characters,
                    inputFormatters: [
                      FilteringTextInputFormatter.allow(RegExp(r'[0-9a-fA-F]')),
                      LengthLimitingTextInputFormatter(8),
                    ],
                    onTap: () => _editingHex = true,
                    onEditingComplete: () => _editingHex = false,
                    onSubmitted: (value) {
                      _editingHex = false;
                      _applyHex(value);
                    },
                    onChanged: _applyHex,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            _LabeledSlider(
              label: '色相',
              value: _hsv.hue,
              min: 0,
              max: 360,
              activeColor: HSVColor.fromAHSV(1, _hsv.hue, 1, 1).toColor(),
              onChanged: (value) => _setHsv(_hsv.withHue(value)),
            ),
            _LabeledSlider(
              label: '饱和',
              value: _hsv.saturation,
              min: 0,
              max: 1,
              activeColor: _color,
              onChanged: (value) => _setHsv(_hsv.withSaturation(value)),
            ),
            _LabeledSlider(
              label: '明度',
              value: _hsv.value,
              min: 0,
              max: 1,
              activeColor: _color,
              onChanged: (value) => _setHsv(_hsv.withValue(value)),
            ),
            const SizedBox(height: 12),
            Text('预览', style: textTheme.labelLarge),
            const SizedBox(height: 8),
            Row(
              children: [
                _Swatch(
                  label: 'Primary',
                  color: preview.primary,
                  onColor: preview.onPrimary,
                ),
                const SizedBox(width: 8),
                _Swatch(
                  label: 'Secondary',
                  color: preview.secondary,
                  onColor: preview.onSecondary,
                ),
                const SizedBox(width: 8),
                _Swatch(
                  label: 'Tertiary',
                  color: preview.tertiary,
                  onColor: preview.onTertiary,
                ),
              ],
            ),
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('取消'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: () => Navigator.of(context).pop(_color),
                  child: const Text('应用'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _LabeledSlider extends StatelessWidget {
  const _LabeledSlider({
    required this.label,
    required this.value,
    required this.min,
    required this.max,
    required this.activeColor,
    required this.onChanged,
  });

  final String label;
  final double value;
  final double min;
  final double max;
  final Color activeColor;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    final display = max == 1
        ? (value * 100).round().toString()
        : value.round().toString();

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          SizedBox(width: 56, child: Text(label, style: textTheme.labelMedium)),
          Expanded(
            child: SliderTheme(
              data: SliderTheme.of(context).copyWith(
                activeTrackColor: activeColor,
                thumbColor: activeColor,
                inactiveTrackColor: scheme.appContainerHighest,
                overlayColor: activeColor.withValues(alpha: 0.12),
                trackHeight: 6,
              ),
              child: Slider(
                value: value,
                min: min,
                max: max,
                onChanged: onChanged,
              ),
            ),
          ),
          SizedBox(
            width: 42,
            child: Text(
              display,
              textAlign: TextAlign.end,
              style: textTheme.labelMedium,
            ),
          ),
        ],
      ),
    );
  }
}

class _Swatch extends StatelessWidget {
  const _Swatch({
    required this.label,
    required this.color,
    required this.onColor,
  });

  final String label;
  final Color color;
  final Color onColor;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Container(
        height: 48,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        alignment: Alignment.centerLeft,
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: onColor,
            fontSize: 12,
            fontWeight: FontWeight.w500,
          ),
        ),
      ),
    );
  }
}
