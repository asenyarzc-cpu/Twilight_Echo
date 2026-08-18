import 'package:twilight_echo/core/app_info.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:package_info_plus/package_info_plus.dart';

void main() {
  test('app version label uses package version', () async {
    PackageInfo.setMockInitialValues(
      appName: appDisplayName,
      packageName: 'com.twilight.echo',
      version: '1.0.0',
      buildNumber: '1',
      buildSignature: '',
    );

    final container = ProviderContainer();
    addTearDown(container.dispose);

    await container.read(packageInfoProvider.future);

    expect(container.read(appVersionLabelProvider), 'Twilight Echo 1.0.0');
  });
}
