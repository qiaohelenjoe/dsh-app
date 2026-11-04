import 'package:dsh_mobile/api.dart';
import 'package:dsh_mobile/pages/webview_page.dart';
import 'package:dsh_mobile/session_store.dart';
import 'package:dsh_mobile/webview/webview_adapter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeWebViewAdapter implements WebViewAdapter {
  final List<String> loadedUrls = [];
  final List<String> scripts = [];
  Map<String, String>? cookie;
  bool canBack = false;
  int goBackCount = 0;
  int reloadCount = 0;
  bool initialized = false;

  Future<bool> Function(String url)? _onNavigation;
  void Function(String message)? _onError;
  VoidCallback? _onPageFinished;

  @override
  Future<void> initialize() async {
    initialized = true;
  }

  @override
  Widget buildView() => const SizedBox.expand(key: Key('fake-webview'));

  @override
  Future<void> loadUrl(String url) async {
    loadedUrls.add(url);
  }

  @override
  Future<void> setCookie({
    required String name,
    required String value,
    required String domain,
    required String path,
  }) async {
    cookie = {'name': name, 'value': value, 'domain': domain, 'path': path};
  }

  @override
  Future<void> injectScript(String script) async {
    scripts.add(script);
  }

  @override
  Future<void> clearSessionStorage() async {}

  @override
  Future<String> evaluateScript(String script) async => '[]';

  @override
  Future<bool> canGoBack() async => canBack;

  @override
  Future<void> goBack() async {
    goBackCount += 1;
  }

  @override
  Future<void> reload() async {
    reloadCount += 1;
  }

  @override
  void setConsoleHandler(void Function(String level, String message) handler) {}

  @override
  void setHandlers({
    required Future<bool> Function(String url) onNavigation,
    required void Function(String message) onError,
    required VoidCallback onPageFinished,
  }) {
    _onNavigation = onNavigation;
    _onError = onError;
    _onPageFinished = onPageFinished;
  }

  @override
  void dispose() {}

  void finishPage() => _onPageFinished?.call();

  void failPage(String message) => _onError?.call(message);

  Future<bool> navigate(String url) async => _onNavigation!(url);
}

const _session = Session(accessToken: 'token-1', refreshToken: 'refresh-1');

class _FallbackApi extends ApiClient {
  _FallbackApi() : super(baseUrl: 'https://dsh.example.com');

  @override
  Future<WebSession> webSession(String refreshToken) async {
    throw Exception('offline');
  }
}

class _WebSessionApi extends ApiClient {
  _WebSessionApi() : super(baseUrl: 'https://dsh.example.com');

  @override
  Future<WebSession> webSession(String refreshToken) async => const WebSession(
        session: Session(accessToken: 'token-2', refreshToken: 'refresh-2'),
        cookie: 'cookie-2',
      );
}

final _fallbackApi = _FallbackApi();
final _store = MemorySessionStore();

Future<void> pumpUntilReady(WidgetTester tester, FakeWebViewAdapter adapter) async {
  for (var i = 0; i < 50; i += 1) {
    await tester.pump(const Duration(milliseconds: 10));
    if (adapter.initialized && adapter.loadedUrls.isNotEmpty) {
      await tester.pump();
      return;
    }
  }
  fail('WebView 初始化超时');
}

void main() {
  testWidgets('窄屏（<600dp）加载 /t/<id>/ 并注入 mobile 适配脚本', (tester) async {
    final adapter = FakeWebViewAdapter();
    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(size: Size(390, 844)),
        child: MaterialApp(
          home: DshWebViewPage(
            baseUrl: 'https://dsh.example.com',
            deviceId: 'd1',
            deviceName: '我的电脑',
            session: _session,
            api: _fallbackApi,
            store: _store,
            adapterFactory: () => adapter,
            openExternal: (_) async => true,
          ),
        ),
      ),
    );
    await pumpUntilReady(tester, adapter);
    expect(adapter.loadedUrls.single, 'https://dsh.example.com/');
    expect(adapter.cookie?['name'], 'dsh_device');
    expect(adapter.cookie?['value'], 'd1');

    adapter.finishPage();
    await tester.pumpAndSettle();
    expect(adapter.scripts, hasLength(1));
    expect(adapter.scripts.single, contains("data-dsh-layout', 'mobile"));
  });

  testWidgets('宽屏（>=600dp）注入 desktop 布局标记', (tester) async {
    final adapter = FakeWebViewAdapter();
    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(size: Size(1024, 768)),
        child: MaterialApp(
          home: DshWebViewPage(
            baseUrl: 'https://dsh.example.com',
            deviceId: 'd1',
            deviceName: '我的电脑',
            session: _session,
            api: _fallbackApi,
            store: _store,
            adapterFactory: () => adapter,
            openExternal: (_) async => true,
          ),
        ),
      ),
    );
    await pumpUntilReady(tester, adapter);
    adapter.finishPage();
    await tester.pumpAndSettle();
    expect(adapter.scripts.single, contains("data-dsh-layout', 'desktop"));
  });

  testWidgets('折叠屏切换布局只重新注入，不重载 WebView', (tester) async {
    final adapter = FakeWebViewAdapter();
    var size = const Size(390, 844);
    late StateSetter setHost;
    final page = DshWebViewPage(
      baseUrl: 'https://dsh.example.com',
      deviceId: 'd1',
      deviceName: '我的电脑',
      session: _session,
            api: _fallbackApi,
            store: _store,
      adapterFactory: () => adapter,
      openExternal: (_) async => true,
    );
    await tester.pumpWidget(
      StatefulBuilder(
        builder: (context, setState) {
          setHost = setState;
          return MediaQuery(
            data: MediaQueryData(size: size),
            child: MaterialApp(home: page),
          );
        },
      ),
    );
    await pumpUntilReady(tester, adapter);
    adapter.finishPage();
    await tester.pumpAndSettle();
    expect(adapter.scripts, hasLength(1));
    expect(adapter.loadedUrls, hasLength(1));

    setHost(() => size = const Size(1024, 768));
    await tester.pumpAndSettle();

    expect(adapter.scripts, hasLength(2));
    expect(adapter.scripts.last, contains("data-dsh-layout', 'desktop"));
    expect(adapter.loadedUrls, hasLength(1), reason: '布局切换不应重载 WebView');
  });

  testWidgets('外部链接交给系统浏览器，同源留在 WebView', (tester) async {
    final adapter = FakeWebViewAdapter();
    final opened = <String>[];
    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(size: Size(390, 844)),
        child: MaterialApp(
          home: DshWebViewPage(
            baseUrl: 'https://dsh.example.com',
            deviceId: 'd1',
            deviceName: '我的电脑',
            session: _session,
            api: _fallbackApi,
            store: _store,
            adapterFactory: () => adapter,
            openExternal: (url) async {
              opened.add(url);
              return true;
            },
          ),
        ),
      ),
    );
    await pumpUntilReady(tester, adapter);

    expect(await adapter.navigate('https://dsh.example.com/t/d1/api/x'), isTrue);
    expect(await adapter.navigate('https://github.com/x'), isFalse);
    expect(opened, ['https://github.com/x']);
  });

  testWidgets('返回键返回设备列表（不进入网页历史）', (tester) async {
    final adapter = FakeWebViewAdapter()..canBack = true;
    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(size: Size(390, 844)),
        child: MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => DshWebViewPage(
                      baseUrl: 'https://dsh.example.com',
                      deviceId: 'd1',
                      deviceName: '我的电脑',
                      session: _session,
                      api: _fallbackApi,
                      store: _store,
                      adapterFactory: () => adapter,
                      openExternal: (_) async => true,
                    ),
                  ),
                ),
                child: const Text('打开设备'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开设备'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await pumpUntilReady(tester, adapter);
    adapter.finishPage();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    await tester.tap(find.byKey(const Key('back-to-devices-button')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('打开设备'), findsOneWidget);
  });

  testWidgets('加载失败显示重试并可重新加载', (tester) async {
    final adapter = FakeWebViewAdapter();
    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(size: Size(390, 844)),
        child: MaterialApp(
          home: DshWebViewPage(
            baseUrl: 'https://dsh.example.com',
            deviceId: 'd1',
            deviceName: '我的电脑',
            session: _session,
            api: _fallbackApi,
            store: _store,
            adapterFactory: () => adapter,
            openExternal: (_) async => true,
          ),
        ),
      ),
    );
    await pumpUntilReady(tester, adapter);
    adapter.failPage('网络不可用');
    await tester.pumpAndSettle();
    expect(find.textContaining('无法打开 DSH'), findsOneWidget);

    await tester.tap(find.byKey(const Key('retry-button')));
    await tester.pump();
    await tester.pump();
    expect(adapter.reloadCount, 1);
  });
  testWidgets('有 web-session 时写入 7 天 Cookie 并加载干净 URL', (tester) async {
    final adapter = FakeWebViewAdapter();
    await tester.pumpWidget(
      MaterialApp(
        home: DshWebViewPage(
          baseUrl: 'https://dsh.example.com',
          deviceId: 'd1',
          deviceName: 'PC',
          session: _session,
          api: _WebSessionApi(),
          store: _store,
          adapterFactory: () => adapter,
          openExternal: (_) async => true,
        ),
      ),
    );
    await pumpUntilReady(tester, adapter);
    expect(adapter.cookie?['name'], 'dsh_device');
    expect(adapter.cookie?['value'], 'd1');
    expect(adapter.cookie?['path'], '/');
    expect(adapter.loadedUrls.single, isNot(contains('token=')));
  });}
