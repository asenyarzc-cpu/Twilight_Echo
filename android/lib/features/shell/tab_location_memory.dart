import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Last visited location (full URI including query) per bottom-toolbar tab
/// index, as computed by `toolbarIndexFor`. Written by `AppShell` on every
/// route change; read by the toolbar's tab-tap handler so switching back to a
/// tab restores its last page instead of the tab root.
///
/// The player tab (index 2) is a layer rather than page content and never
/// participates.
final tabLocationMemoryProvider = StateProvider<Map<int, String>>(
  (ref) => const {},
);
