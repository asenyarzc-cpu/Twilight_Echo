import 'package:flutter/material.dart';

import '../shell_route_utils.dart';

// Shared toolbar metrics: consumed both by the AppShell scroll state machine
// (app_shell.dart) and by the bottom toolbar widgets (widgets/).

const double toolbarMaxActionWidth = 76;
const double toolbarMinActionWidth = 48;
const double toolbarMinActionHeight = 50;
const double toolbarWideLayoutBreakpoint = 600;
const double toolbarWideMaxActionWidth = 96;
const double toolbarWideMinActionHeight = 60;
const double toolbarHorizontalPadding = 12;
const double toolbarActionVerticalChrome = 39;
const double toolbarWideActionVerticalChrome = 48;
const double toolbarLabelFontSize = 10.5;
const double toolbarWideLabelFontSize = 12;
const double toolbarIconSize = 22;
const double toolbarWideIconSize = 25;
const double toolbarIconExtent = 24;
const double toolbarWideIconExtent = 28;
const int toolbarActionCount = 4;
const double toolbarProgressStrokeWidth = 2.4;
const double toolbarMinimumBottomInset = 10;
const double toolbarDefaultTravelExtent = 68;
const double toolbarScrollDeltaEpsilon = 0.1;
const double toolbarHideDirectionThreshold = 0.72;
const double toolbarShowDirectionThreshold = 0.28;
const double toolbarHitTestRevealThreshold = 0.02;
const double toolbarFadeRevealExtent = 0.34;
// Horizontal swipe that pages the capsule between the nav toolbar and the
// mini player bar: finger travel for a full switch, and how far the pages
// shift while cross-fading.
const double toolbarPageDragExtent = 160;
const double toolbarPageSlideExtent = 20;
// Vertical pull that reveals the player page. The drag itself is 1:1 with the
// finger, so only the release behaviour needs tuning: `Fling` is the velocity
// that commits regardless of distance, `Fade` is the fraction of the pull over
// which the capsule gets out of the way.
const double playerPullFlingVelocity = 400;
const double playerPullToolbarFade = 0.15;

bool toolbarUsesWideMetrics(Size viewport) =>
    viewport.shortestSide >= toolbarWideLayoutBreakpoint;

double toolbarMaxActionWidthFor(Size viewport) =>
    toolbarUsesWideMetrics(viewport)
    ? toolbarWideMaxActionWidth
    : toolbarMaxActionWidth;

double toolbarMinActionHeightFor(Size viewport) =>
    toolbarUsesWideMetrics(viewport)
    ? toolbarWideMinActionHeight
    : toolbarMinActionHeight;

double toolbarActionVerticalChromeFor(Size viewport) =>
    toolbarUsesWideMetrics(viewport)
    ? toolbarWideActionVerticalChrome
    : toolbarActionVerticalChrome;

double toolbarLabelFontSizeFor(Size viewport) =>
    toolbarUsesWideMetrics(viewport)
    ? toolbarWideLabelFontSize
    : toolbarLabelFontSize;

double toolbarIconSizeFor(Size viewport) =>
    toolbarUsesWideMetrics(viewport) ? toolbarWideIconSize : toolbarIconSize;

double toolbarIconExtentFor(Size viewport) => toolbarUsesWideMetrics(viewport)
    ? toolbarWideIconExtent
    : toolbarIconExtent;

double toolbarOpacityFor(double reveal) {
  final fadeProgress = (reveal / toolbarFadeRevealExtent)
      .clamp(0.0, 1.0)
      .toDouble();
  return Curves.easeOut.transform(fadeProgress);
}

int toolbarIndexFor(String location) {
  if (isDiscoveryLocation(location)) return 0;
  if (isSongsLibraryLocation(location) ||
      location == '/downloads' ||
      isPlaylistLocation(location)) {
    return 1;
  }
  if (location.startsWith('/settings') || location == '/debug') return 3;
  return switch (location) {
    '/player' => 2,
    _ => 0,
  };
}
