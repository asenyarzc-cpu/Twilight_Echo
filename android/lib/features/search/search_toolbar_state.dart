import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

@immutable
class SearchToolbarState {
  const SearchToolbarState({
    this.visible = false,
    this.page = 1,
    this.canPrev = false,
    this.canNext = false,
    this.loading = false,
    this.onPrev,
    this.onNext,
  });

  final bool visible;
  final int page;
  final bool canPrev;
  final bool canNext;
  final bool loading;
  final VoidCallback? onPrev;
  final VoidCallback? onNext;
}

final searchToolbarStateProvider = StateProvider<SearchToolbarState>(
  (ref) => const SearchToolbarState(),
);
