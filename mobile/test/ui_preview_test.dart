import 'dart:io';

import 'package:dsh_mobile/api.dart';
import 'package:dsh_mobile/pages/change_password_page.dart';
import 'package:dsh_mobile/pages/devices_page.dart';
import 'package:dsh_mobile/pages/login_page.dart';
import 'package:dsh_mobile/pages/settings_page.dart';
import 'package:dsh_mobile/session_store.dart';
import 'package:dsh_mobile/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// 仅用于人工看效果：把关键页面渲染成 PNG（golden 输出），不参与功能断言。
class _FakeApiClient extends ApiClient {
  _FakeApiClient() : super(baseUrl: 'https://dsh.example.com');
}

Future<void> _loadFont(String family, String path) async {
  final file = File(path);
  if (!file.existsSync()) return;
  final bytes = file.readAsBytesSync();
  final loader = FontLoader(family)..addFont(Future<ByteData>.value(ByteData.view(bytes.buffer)));
  await loader.load();
}

Future<void> _loadFonts() async {
  await _loadFont('SimHei', r'C:\Windows\Fonts\simhei.ttf');
  await _loadFont(
    'BrandFont',
    r'G:\zxht-git\other\dsh-app\mobile\assets\fonts\Montserrat-Medium.ttf',
  );
  // Flutter SDK 自带的图标字体，golden 环境默认不加载，需要手动注册。
  await _loadFont(
    'MaterialIcons',
    r'G:\tools\flutter-sdk-extract\flutter\bin\cache\artifacts\material_fonts\MaterialIcons-Regular.otf',
  );
}

TextStyle? _withFont(TextStyle? style) => style?.copyWith(fontFamily: 'SimHei');


class _DevicesApi extends ApiClient {
  _DevicesApi() : super(baseUrl: 'https://dsh.example.com');

  @override
  Future<List<DeviceInfo>> listDevices(String accessToken) async => const [
        DeviceInfo(id: 'd1', name: 'DESKTOP-LFJSTDL', kind: 'desktop', platform: 'win32', online: true),
        DeviceInfo(id: 'd2', name: '办公室主机', kind: 'desktop', platform: 'win32', online: false),
      ];
}

const _previewSession = Session(accessToken: 'a', refreshToken: 'r', accountEmail: 'me@example.com');


class _SettingsApi extends ApiClient {
  _SettingsApi() : super(baseUrl: 'https://dsh.example.com');

  @override
  Future<AccountInfo> account(String accessToken) async => AccountInfo(
        id: 'acc_1',
        email: 'me@example.com',
        displayName: null,
        emailVerified: true,
        createdAt: DateTime(2026, 10, 20, 9, 5),
        desktopLimit: 20,
        mobileLimit: 10,
        desktopUsed: 2,
        mobileUsed: 1,
      );
}

Widget _frame(Widget child) {
  final base = DshTheme.light();
  final buttonStyle = base.filledButtonTheme.style;
  final textButtonStyle = base.textButtonTheme.style;
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: base.copyWith(
      textTheme: base.textTheme.apply(fontFamily: 'SimHei'),
      primaryTextTheme: base.primaryTextTheme.apply(fontFamily: 'SimHei'),
      appBarTheme: base.appBarTheme.copyWith(titleTextStyle: _withFont(base.appBarTheme.titleTextStyle)),
      filledButtonTheme: FilledButtonThemeData(
        style: buttonStyle?.copyWith(
          textStyle: const WidgetStatePropertyAll(
            TextStyle(fontFamily: 'SimHei', fontSize: 15, fontWeight: FontWeight.w600),
          ),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: textButtonStyle?.copyWith(
          textStyle: const WidgetStatePropertyAll(TextStyle(fontFamily: 'SimHei', fontSize: 13)),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          textStyle: const TextStyle(fontFamily: 'SimHei', fontSize: 15, fontWeight: FontWeight.w600),
        ),
      ),
    ),
    home: child,
  );
}

void main() {
  setUpAll(_loadFonts);

  testWidgets('preview login page', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final api = _FakeApiClient();
    await tester.pumpWidget(_frame(LoginPage(api: api, onLoggedIn: (_) {})));
    await tester.pumpAndSettle();
    await expectLater(find.byType(LoginPage), matchesGoldenFile('goldens/login.png'));
  });

  testWidgets('preview change password page', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final api = _FakeApiClient();
    await tester.pumpWidget(_frame(ChangePasswordPage(api: api, accessToken: 'token')));
    await tester.pumpAndSettle();
    await expectLater(
      find.byType(ChangePasswordPage),
      matchesGoldenFile('goldens/change-password.png'),
    );
  });

  testWidgets('font probe', (tester) async {
    tester.view.physicalSize = const Size(600, 200);
    tester.view.devicePixelRatio = 2.0;
    addTearDown(tester.view.reset);
    await _loadFont('SegoeProbe', r'C:\Windows\Fonts\segoeui.ttf');
    await tester.pumpWidget(
      Directionality(
        textDirection: TextDirection.ltr,
        child: Center(
          child: Text(
            'deepseek HARNESS',
            style: const TextStyle(fontFamily: 'SegoeProbe', fontSize: 28, fontWeight: FontWeight.w600),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await expectLater(find.byType(Text), matchesGoldenFile('goldens/probe.png'));
  });

  testWidgets('preview devices page', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final api = _DevicesApi();
    await tester.pumpWidget(
      _frame(
        DevicesPage(
          api: api,
          session: _previewSession,
          store: MemorySessionStore(),
          onOpenDevice: (_, __) {},
          onSessionRefreshed: (_) {},
          onOpenSettings: (_) {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    await expectLater(find.byType(DevicesPage), matchesGoldenFile('goldens/devices.png'));
  });

  testWidgets('preview device menu', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final api = _DevicesApi();
    await tester.pumpWidget(
      _frame(
        DevicesPage(
          api: api,
          session: _previewSession,
          store: MemorySessionStore(),
          onOpenDevice: (_, __) {},
          onSessionRefreshed: (_) {},
          onOpenSettings: (_) {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.longPress(find.byKey(const Key('device-d1')));
    await tester.pumpAndSettle();
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/device-menu.png'));
  });

  testWidgets('preview settings page', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final api = _SettingsApi();
    await tester.pumpWidget(
      _frame(
        SettingsPage(
          api: api,
          session: _previewSession,
          store: MemorySessionStore(),
          onLogout: () {},
          onSessionRefreshed: (_) {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    await expectLater(find.byType(SettingsPage), matchesGoldenFile('goldens/settings.png'));
  });
}
