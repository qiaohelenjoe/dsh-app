import 'package:dsh_mobile/api.dart';
import 'package:dsh_mobile/pages/devices_page.dart';
import 'package:dsh_mobile/session_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeApiClient extends ApiClient {
  _FakeApiClient(this.devices) : super(baseUrl: 'https://dsh.example.com');

  final List<DeviceInfo> devices;
  final List<({String id, String name})> renameCalls = [];
  final List<String> revokeCalls = [];
  bool renameUnauthorizedOnce = false;
  int refreshCalls = 0;

  @override
  Future<List<DeviceInfo>> listDevices(String accessToken) async => devices;

  @override
  Future<Session> refresh(String refreshToken) async {
    refreshCalls += 1;
    return const Session(accessToken: 'access-2', refreshToken: 'refresh-2');
  }

  @override
  Future<DeviceInfo> renameDevice(String accessToken, String id, String name) async {
    if (renameUnauthorizedOnce) {
      renameUnauthorizedOnce = false;
      throw ApiException(401, 'auth.token_expired', '登录已过期');
    }
    renameCalls.add((id: id, name: name));
    final current = devices.firstWhere((device) => device.id == id);
    return DeviceInfo(
      id: id,
      name: name,
      kind: current.kind,
      platform: current.platform,
      online: current.online,
    );
  }

  @override
  Future<void> revokeDevice(String accessToken, String id) async {
    revokeCalls.add(id);
  }

  @override
  Future<void> logout(String refreshToken) async {}
}

const _session = Session(accessToken: 'a', refreshToken: 'r', accountEmail: 'me@example.com');

const _desktop = DeviceInfo(id: 'd1', name: '我的电脑', kind: 'desktop', platform: 'win32', online: true);
const _tablet = DeviceInfo(id: 'd2', name: 'iPad', kind: 'desktop', platform: 'win32', online: false);

Widget _wrap(Widget child) => MaterialApp(home: child);

DevicesPage _page(
  _FakeApiClient api, {
  SessionStore? store,
  void Function(DeviceInfo device, Session session)? onOpenDevice,
  void Function(Session session)? onSessionRefreshed,
  void Function(Session session)? onOpenSettings,
}) {
  return DevicesPage(
    api: api,
    session: _session,
    store: store ?? MemorySessionStore(),
    onOpenDevice: onOpenDevice ?? (_, __) {},
    onSessionRefreshed: onSessionRefreshed ?? (_) {},
    onOpenSettings: onOpenSettings ?? (_) {},
  );
}

void main() {
  testWidgets('设备列表显示在线/离线、平台与名称', (tester) async {
    final api = _FakeApiClient([_desktop, _tablet]);
    await tester.pumpWidget(_wrap(_page(api)));
    await tester.pumpAndSettle();

    expect(find.text('我的电脑'), findsOneWidget);
    expect(find.text('Windows · 电脑'), findsNWidgets(2));
    expect(find.text('iPad'), findsOneWidget);
    expect(find.text('在线'), findsOneWidget);
    expect(find.text('离线'), findsOneWidget);
    expect(find.byKey(const Key('logout-button')), findsNothing);
    expect(find.byKey(const Key('settings-button')), findsOneWidget);
  });

  testWidgets('点击在线设备打开，离线设备提示', (tester) async {
    DeviceInfo? opened;
    final api = _FakeApiClient([
      const DeviceInfo(id: 'd1', name: '在线PC', kind: 'desktop', platform: 'win32', online: true),
      const DeviceInfo(id: 'd2', name: '离线PC', kind: 'desktop', platform: 'win32', online: false),
    ]);
    await tester.pumpWidget(
      _wrap(_page(api, onOpenDevice: (device, _) => opened = device)),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('离线PC'));
    await tester.pump();
    // 离线点击不再立刻放弃：先提示重试，并自动轮询最多约 20 秒
    expect(find.textContaining('正在尝试连接'), findsOneWidget);
    expect(opened, isNull);

    // 推进重试计时器（6 次 × 3 秒）直到结束
    await tester.pump(const Duration(seconds: 21));
    await tester.pumpAndSettle();
    expect(opened, isNull);

    await tester.tap(find.text('在线PC'));
    await tester.pumpAndSettle();
    expect(opened?.id, 'd1');
  });

  testWidgets('点击设置入口回调当前会话', (tester) async {
    final api = _FakeApiClient([_desktop]);
    Session? openedWith;
    await tester.pumpWidget(
      _wrap(_page(api, onOpenSettings: (session) => openedWith = session)),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('settings-button')));
    await tester.pumpAndSettle();

    expect(openedWith?.accessToken, 'a');
  });

  testWidgets('长按弹出重命名与撤销设备菜单', (tester) async {
    final api = _FakeApiClient([_desktop]);
    await tester.pumpWidget(_wrap(_page(api)));
    await tester.pumpAndSettle();

    await tester.longPress(find.text('我的电脑'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('rename-device-action')), findsOneWidget);
    expect(find.byKey(const Key('revoke-device-action')), findsOneWidget);
    expect(find.text('重命名'), findsOneWidget);
    expect(find.text('撤销设备'), findsOneWidget);
  });

  testWidgets('重命名调用 PATCH 并更新列表', (tester) async {
    final api = _FakeApiClient([_desktop, _tablet]);
    await tester.pumpWidget(_wrap(_page(api)));
    await tester.pumpAndSettle();

    await tester.longPress(find.text('我的电脑'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('rename-device-action')));
    await tester.pumpAndSettle();

    expect(find.text('重命名设备'), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byKey(const Key('rename-field'))).controller?.text,
      '我的电脑',
    );
    await tester.enterText(find.byKey(const Key('rename-field')), '工作站');
    await tester.tap(find.byKey(const Key('rename-save')));
    await tester.pumpAndSettle();

    expect(api.renameCalls, hasLength(1));
    expect(api.renameCalls.single.id, 'd1');
    expect(api.renameCalls.single.name, '工作站');
    expect(find.text('工作站'), findsOneWidget);
    expect(find.text('我的电脑'), findsNothing);
    expect(find.text('已重命名为 工作站'), findsOneWidget);
  });

  testWidgets('重命名取消不调用接口', (tester) async {
    final api = _FakeApiClient([_desktop]);
    await tester.pumpWidget(_wrap(_page(api)));
    await tester.pumpAndSettle();

    await tester.longPress(find.text('我的电脑'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('rename-device-action')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('rename-cancel')));
    await tester.pumpAndSettle();

    expect(api.renameCalls, isEmpty);
  });

  testWidgets('重命名 401 时刷新会话并重试', (tester) async {
    final api = _FakeApiClient([_desktop])..renameUnauthorizedOnce = true;
    final store = MemorySessionStore();
    Session? refreshed;
    await tester.pumpWidget(
      _wrap(_page(api, store: store, onSessionRefreshed: (session) => refreshed = session)),
    );
    await tester.pumpAndSettle();

    await tester.longPress(find.text('我的电脑'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('rename-device-action')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('rename-field')), '工作站');
    await tester.tap(find.byKey(const Key('rename-save')));
    await tester.pumpAndSettle();

    expect(api.refreshCalls, 1);
    expect(refreshed?.accessToken, 'access-2');
    expect(api.renameCalls.single.name, '工作站');
    expect(find.text('工作站'), findsOneWidget);
  });

  testWidgets('撤销设备需二次确认，确认后调用 DELETE 并从列表移除', (tester) async {
    final api = _FakeApiClient([_desktop, _tablet]);
    final store = MemorySessionStore();
    await store.saveSession(_session, lastDeviceId: 'd1');
    await tester.pumpWidget(_wrap(_page(api, store: store)));
    await tester.pumpAndSettle();

    await tester.longPress(find.text('我的电脑'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('revoke-device-action')));
    await tester.pumpAndSettle();

    expect(find.text('撤销设备'), findsWidgets);
    expect(find.textContaining('该设备的访问与隧道将立即失效'), findsOneWidget);
    expect(api.revokeCalls, isEmpty);

    await tester.tap(find.byKey(const Key('revoke-confirm')));
    await tester.pumpAndSettle();

    expect(api.revokeCalls, ['d1']);
    expect(find.text('我的电脑'), findsNothing);
    expect(find.text('iPad'), findsOneWidget);
    expect(find.textContaining('该设备是当前打开的设备'), findsOneWidget);
    expect(await store.lastDeviceId(), isNull);
  });

  testWidgets('撤销设备取消后不调用 DELETE', (tester) async {
    final api = _FakeApiClient([_desktop]);
    await tester.pumpWidget(_wrap(_page(api)));
    await tester.pumpAndSettle();

    await tester.longPress(find.text('我的电脑'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('revoke-device-action')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('revoke-cancel')));
    await tester.pumpAndSettle();

    expect(api.revokeCalls, isEmpty);
    expect(find.text('我的电脑'), findsOneWidget);
  });
  testWidgets('手机设备不在列表中展示（无法打开 DSH）', (tester) async {
    final api = _FakeApiClient([
      const DeviceInfo(id: 'm1', name: '我的手机', kind: 'mobile', platform: 'android', online: true),
    ]);
    await tester.pumpWidget(_wrap(_page(api)));
    await tester.pumpAndSettle();
    expect(find.text('我的手机'), findsNothing);
  });
}
