import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/app_info.dart';
import '../../core/ui/app_circular_loading_indicator.dart';
import '../../theme/app_motion.dart';
import 'jinrishici_client.dart';
import 'startup_logo.dart';

class StartupGate extends ConsumerStatefulWidget {
  const StartupGate({super.key, required this.child, this.onReady});

  final Widget child;
  final Future<void> Function()? onReady;

  @override
  ConsumerState<StartupGate> createState() => _StartupGateState();
}

class _StartupGateState extends ConsumerState<StartupGate> {
  late Future<void> _startupFuture;
  late StartupPoem _startupPoem;
  bool _notifiedReady = false;

  @override
  void initState() {
    super.initState();
    _startupPoem = randomFallbackStartupPoem();
    _startupFuture = _preload();
    unawaited(_loadStartupPoem());
  }

  Future<void> _preload() async {
    await WidgetsBinding.instance.endOfFrame;
    await Future<void>.delayed(const Duration(milliseconds: 1450));
  }

  Future<void> _loadStartupPoem() async {
    try {
      final poem = await ref.read(jinrishiciClientProvider).fetchOneSentence();
      if (mounted) setState(() => _startupPoem = poem);
    } catch (_) {
      // Keep the local fallback visible when the poem service is unavailable.
    }
  }

  @override
  Widget build(BuildContext context) {
    final versionLabel = ref.watch(appVersionLabelProvider);

    return FutureBuilder<void>(
      future: _startupFuture,
      builder: (context, snapshot) {
        final done = snapshot.connectionState == ConnectionState.done;
        if (done && !_notifiedReady) {
          _notifiedReady = true;
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) unawaited(widget.onReady?.call());
          });
        }
        return AnimatedSwitcher(
          duration: const Duration(milliseconds: 620),
          switchInCurve: AppMotion.emphasizedDecelerate,
          switchOutCurve: Curves.easeOutCubic,
          transitionBuilder: (child, animation) {
            final scale = Tween<double>(begin: 0.97, end: 1).animate(animation);
            return FadeTransition(
              opacity: animation,
              child: ScaleTransition(scale: scale, child: child),
            );
          },
          child: done
              ? KeyedSubtree(key: const ValueKey('app'), child: widget.child)
              : _StartupLoading(
                  key: const ValueKey('startup'),
                  poem: _startupPoem,
                  versionLabel: versionLabel,
                ),
        );
      },
    );
  }
}

class _StartupLoading extends StatelessWidget {
  const _StartupLoading({
    super.key,
    required this.poem,
    required this.versionLabel,
  });

  final StartupPoem poem;
  final String versionLabel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final author = poem.author?.trim();
    final attribution = author == null || author.isEmpty ? null : '-- $author';

    return Scaffold(
      backgroundColor: scheme.surface,
      body: Stack(
        fit: StackFit.expand,
        children: [
          const _StartupBackdrop(),
          Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const StartupLogo(size: 124),
                const SizedBox(height: 28),
                Text(
                  'Twilight Echo',
                  style: theme.textTheme.headlineMedium?.copyWith(
                    color: scheme.onSurface,
                    fontWeight: FontWeight.w600,
                    fontSize: 38,
                    letterSpacing: 0,
                  ),
                ),
                const SizedBox(height: 10),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 320),
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 260),
                    switchInCurve: AppMotion.emphasizedDecelerate,
                    switchOutCurve: Curves.easeOutCubic,
                    child: Column(
                      key: ValueKey('${poem.content}:${attribution ?? ''}'),
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          poem.content,
                          textAlign: TextAlign.center,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: scheme.onSurfaceVariant,
                            fontWeight: FontWeight.w500,
                            height: 1.45,
                          ),
                        ),
                        if (attribution != null) ...[
                          const SizedBox(height: 8),
                          Text(
                            attribution,
                            textAlign: TextAlign.center,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.labelMedium?.copyWith(
                              color: scheme.onSurfaceVariant.withValues(
                                alpha: 0.74,
                              ),
                              fontWeight: FontWeight.w500,
                              letterSpacing: 0,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 50),
                const AppCircularLoadingIndicator(),
              ],
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: SafeArea(
              child: Padding(
                padding: const EdgeInsets.only(bottom: 20),
                child: Text(
                  versionLabel,
                  textAlign: TextAlign.center,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: scheme.onSurfaceVariant.withValues(alpha: 0.62),
                    fontWeight: FontWeight.w500,
                    letterSpacing: 1.2,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _StartupBackdrop extends StatelessWidget {
  const _StartupBackdrop();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final isDark = scheme.brightness == Brightness.dark;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: scheme.surface,
        gradient: RadialGradient(
          center: const Alignment(0.18, -0.22),
          radius: 1.05,
          colors: [
            scheme.primary.withValues(alpha: isDark ? 0.20 : 0.13),
            scheme.secondary.withValues(alpha: isDark ? 0.10 : 0.07),
            scheme.surface,
          ],
          stops: const [0.0, 0.46, 1.0],
        ),
      ),
    );
  }
}
