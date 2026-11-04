import 'package:dsh_mobile/api.dart';
import 'package:dsh_mobile/app.dart';
import 'package:dsh_mobile/pages/devices_page.dart';
import 'package:dsh_mobile/pages/login_page.dart';
import 'package:dsh_mobile/session_store.dart';
import 'package:dsh_mobile/webview/webview_adapter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeApiClient extends ApiClient {
  _FakeApiClient(this.devices) : super(baseUrl: 'https://dsh.example.com');

  final List<DeviceInfo> devices;

  @override
  Future<Session> login({
    required String email,
    required String password,
    required String deviceName,
    required String platform,
    String appVersion = '0.1.0',
  }) async =>
      Session(accessToken: 'a', refreshToken: 'r', accountEmail: email);

  @override
  Future<Session> refresh(String refreshToken) async =>
      const Session(accessToken: 'a2', refreshToken: 'r2');

  @override
  Future<List<DeviceInfo>> listDevices(String accessToken) async => devices;
}

class _FakeAdapter implements WebViewAdapter {
  final List<String> loadedUrls = [];

  @override
  Future<void> initialize() async {}

  @override
  Widget buildView() => const SizedBox.expand();

  @override
  Future<void> loadUrl(String url) async => loadedUrls.add(url);

  @override
  Future<void> setCookie({
    required String name,
    required String value,
    required String domain,
    required String path,
  }) async {}

  @override
  Future<void> injectScript(String script) async {}

  @override
  Future<void> clearSessionStorage() async {}

  @override
  Future<String> evaluateScript(String script) async => '[]';

  @override
  Future<bool> canGoBack() async => false;

  @override
  Future<void> goBack() async {}

  @override
  Future<void> reload() async {}

  @override
  void setConsoleHandler(void Function(String level, String message) handler) {}

  @override
  void setHandlers({
    required Future<bool> Function(String url) onNavigation,
    required void Function(String message) onError,
    required VoidCallback onPageFinished,
  }) {}

  @override
  void dispose() {}
}

Widget _app(ApiClient api, SessionStore store, WebViewAdapter adapter) => DshMobileApp(
      baseUrl: 'https://dsh.example.com',
      api: api,
      store: store,
      adapterFactory: () => adapter,
      openExternal: (_) async => true,
    );

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 20; i += 1) {
    await tester.pump(const Duration(milliseconds: 10));
  }
}

void main() {
  testWidgets('冷启动有会话时进入设备列表，不自动打开设备', (tester) async {
    final store = MemorySessionStore();
    await store.saveSession(
      const Session(accessToken: 'a', refreshToken: 'r'),
      lastDeviceId: '11111111-1111-4111-8111-111111111111',
    );
    final adapter = _FakeAdapter();
    await tester.pumpWidget(_app(_FakeApiClient(const [DeviceInfo(id: '11111111-1111-4111-8111-111111111111', name: 'PC', kind: 'desktop', platform: 'win32', online: true)]), store, adapter));
    await _settle(tester);

    expect(find.byType(LoginPage), findsNothing);
    expect(find.byType(DevicesPage), findsOneWidget);
    expect(adapter.loadedUrls, isEmpty);
  });

  testWidgets('无会话时显示登录页', (tester) async {
    final adapter = _FakeAdapter();
    await tester.pumpWidget(_app(_FakeApiClient(const []), MemorySessionStore(), adapter));
    await _settle(tester);

    expect(find.byType(LoginPage), findsOneWidget);
    expect(adapter.loadedUrls, isEmpty);
  });
}
