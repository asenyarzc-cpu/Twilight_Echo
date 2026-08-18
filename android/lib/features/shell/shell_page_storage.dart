import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// App-lifetime [PageStorageBucket] shared by every shell route.
///
/// Each `NoTransitionPage` route carries its own per-route `PageStorage`
/// (inside `ModalRoute`), which is destroyed together with the route on every
/// navigation — so `PageStorageKey`s alone cannot preserve scroll offsets
/// across shell page swaps. Wrapping each route's child in [ShellPageStorage]
/// puts this long-lived bucket *closer* to the scrollables than the per-route
/// one, letting their offsets survive.
///
/// The bucket lives in Riverpod (not a module-level static) so widget tests
/// get a fresh bucket per ProviderScope.
final shellPageStorageBucketProvider = Provider<PageStorageBucket>(
  (ref) => PageStorageBucket(),
);

class ShellPageStorage extends ConsumerWidget {
  const ShellPageStorage({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return PageStorage(
      bucket: ref.watch(shellPageStorageBucketProvider),
      child: child,
    );
  }
}
