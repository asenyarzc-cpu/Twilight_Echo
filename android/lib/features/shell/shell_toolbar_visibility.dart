import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Whether the floating bottom toolbar is currently shown. This is a
/// general-purpose visibility switch shared across routes: `settings_page`
/// flips it off while a modal sheet is open, and `AppShell` flips it off by
/// default while `/player` is active for an immersive full-bleed layout
/// (resetting it back to `true` on the way out so other routes aren't left
/// with a hidden toolbar).
final shellToolbarVisibleProvider = StateProvider<bool>((ref) => true);
