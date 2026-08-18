import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

@immutable
class DynamicColorStatus {
  const DynamicColorStatus({required this.available, this.seed});

  final bool available;
  final Color? seed;
}

final dynamicColorStatusProvider = StateProvider<DynamicColorStatus>(
  (ref) => const DynamicColorStatus(available: false),
);
