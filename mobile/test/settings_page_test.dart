import 'package:dsh_mobile/api.dart';
import 'package:dsh_mobile/pages/settings_page.dart';
import 'package:dsh_mobile/session_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeApiClient extends ApiClient {
  _FakeApiClient(this.info) : super(baseUrl: 'https://dsh.example.com');

  AccountInfo info;
  bool failAccount = false;
  bool accountUnauthorizedOnce = false;
  ApiException? changePasswordError;
  int accountCalls = 0;
  int refreshCalls = 0;
  int changePasswordCalls = 0;
  String? capturedOldPassword;
  String? capturedNewPassword;
  bool loggedOut = false;

  @override
  Future<AccountInfo> account(String accessToken) async {
    accountCalls += 1;
    if (failAccount) throw ApiException(500, 'internal.error', '服务端异常');
    if (accountUnauthorizedOnce) {
      accountUnauthorizedOnce = false;
      throw ApiException(401, 'auth.token_expired', '登录已过期');
    }
    return info;
  }

  @override
  Future<Session> refresh(String refreshToken) async {
    refreshCalls += 1;
    return const Session(accessToken: 'access-2', refreshToken: 'refresh-2');
  }

  @override
  Future<void> changePassword(String accessToken, String oldPassword, String newPassword) async {
    if (changePasswordError != null) throw changePasswordError!;
    changePasswordCalls += 1;
    capturedOldPassword = oldPassword;
    capturedNewPassword = newPassword;
  }

  @override
  Future<void> logout(String refreshToken) async {
    loggedOut = true;
  }
}

const _session = Session(accessToken: 'a', refreshToken: 'r', accountEmail: 'me@example.com');

final _account = AccountInfo(
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

SettingsPage _page(
  _FakeApiClient api, {
  SessionStore? store,
  VoidCallback? onLogout,
  void Function(Session session)? onSessionRefreshed,
  String appVersion = '0.1.0',
}) {
  return SettingsPage(
    api: api,
    session: _session,
    store: store ?? MemorySessionStore(),
    onLogout: onLogout ?? () {},
    onSessionRefreshed: onSessionRefreshed ?? (_) {},
    appVersion: appVersion,
  );
}

Future<void> _openChangePassword(WidgetTester tester) async {
  final button = find.byKey(const Key('change-password-button'));
  await tester.scrollUntilVisible(button, 200);
  await tester.tap(button);
  await tester.pumpAndSettle();
}

Future<void> _fillPasswords(
  WidgetTester tester, {
  String oldPassword = 'old-pass-123',
  String newPassword = 'new-pass-456',
  String? confirmPassword,
}) async {
  await tester.enterText(find.byKey(const Key('old-password-field')), oldPassword);
  await tester.enterText(find.byKey(const Key('new-password-field')), newPassword);
  await tester.enterText(
    find.byKey(const Key('confirm-password-field')),
    confirmPassword ?? newPassword,
  );
}

void main() {
  testWidgets('渲染邮箱、显示名、注册时间、配额与版本', (tester) async {
    final api = _FakeApiClient(_account);
    await tester.pumpWidget(MaterialApp(home: _page(api)));
    await tester.pumpAndSettle();

    expect(find.text('设置'), findsOneWidget);
    expect(find.text('me@example.com'), findsOneWidget);
    expect(find.text('未设置'), findsOneWidget);
    expect(find.text('2026-10-20 09:05'), findsOneWidget);
    expect(find.textContaining('桌面 2/20'), findsOneWidget);
    expect(find.textContaining('移动 1/10'), findsOneWidget);

    await tester.drag(find.byType(ListView), const Offset(0, -400));
    await tester.pumpAndSettle();
    expect(find.textContaining('0.1.0'), findsOneWidget);
  });

  testWidgets('修改密码调用 changePassword，成功后清会话并登出', (tester) async {
    final api = _FakeApiClient(_account);
    final store = MemorySessionStore();
    await store.saveSession(_session, lastDeviceId: 'd1');
    var loggedOut = false;
    await tester.pumpWidget(
      MaterialApp(home: _page(api, store: store, onLogout: () => loggedOut = true)),
    );
    await tester.pumpAndSettle();

    await _openChangePassword(tester);
    await _fillPasswords(tester);
    await tester.tap(find.byKey(const Key('change-password-submit')));
    await tester.pumpAndSettle();

    expect(api.changePasswordCalls, 1);
    expect(api.capturedOldPassword, 'old-pass-123');
    expect(api.capturedNewPassword, 'new-pass-456');
    expect(api.loggedOut, isTrue);
    expect(loggedOut, isTrue);
    expect(await store.loadSession(), isNull);
    expect(await store.lastDeviceId(), isNull);
    expect(find.text('密码已修改，请重新登录'), findsOneWidget);
  });

  testWidgets('新密码与确认不一致时不调用接口', (tester) async {
    final api = _FakeApiClient(_account);
    await tester.pumpWidget(MaterialApp(home: _page(api)));
    await tester.pumpAndSettle();

    await _openChangePassword(tester);
    await _fillPasswords(tester, confirmPassword: 'another-pass-789');
    await tester.tap(find.byKey(const Key('change-password-submit')));
    await tester.pumpAndSettle();

    expect(find.text('两次输入的新密码不一致'), findsOneWidget);
    expect(api.changePasswordCalls, 0);
    expect(api.loggedOut, isFalse);
  });

  testWidgets('旧密码错误显示服务端错误且不登出', (tester) async {
    final api = _FakeApiClient(_account)
      ..changePasswordError = ApiException(401, 'auth.invalid_credentials', '旧密码不正确');
    await tester.pumpWidget(MaterialApp(home: _page(api)));
    await tester.pumpAndSettle();

    await _openChangePassword(tester);
    await _fillPasswords(tester);
    await tester.tap(find.byKey(const Key('change-password-submit')));
    await tester.pumpAndSettle();

    expect(find.text('旧密码不正确'), findsOneWidget);
    expect(api.loggedOut, isFalse);
  });

  testWidgets('登出清除本地会话并回调', (tester) async {
    final api = _FakeApiClient(_account);
    final store = MemorySessionStore();
    await store.saveSession(_session, lastDeviceId: 'd1');
    var loggedOut = false;
    await tester.pumpWidget(
      MaterialApp(home: _page(api, store: store, onLogout: () => loggedOut = true)),
    );
    await tester.pumpAndSettle();

    final logout = find.byKey(const Key('logout-button'));
  await tester.drag(find.byType(ListView), const Offset(0, -160));
  await tester.pumpAndSettle();
  await tester.tap(logout);
    await tester.pumpAndSettle();

    expect(api.loggedOut, isTrue);
    expect(loggedOut, isTrue);
    expect(await store.loadSession(), isNull);
  });

  testWidgets('加载失败显示重试，重试成功后渲染账号', (tester) async {
    final api = _FakeApiClient(_account)..failAccount = true;
    await tester.pumpWidget(MaterialApp(home: _page(api)));
    await tester.pumpAndSettle();

    expect(find.text('服务端异常'), findsOneWidget);
    expect(find.byKey(const Key('settings-retry')), findsOneWidget);

    api.failAccount = false;
    await tester.tap(find.byKey(const Key('settings-retry')));
    await tester.pumpAndSettle();

    expect(find.text('me@example.com'), findsOneWidget);
    expect(api.accountCalls, 2);
  });

  testWidgets('账号加载 401 时刷新会话并重试', (tester) async {
    final api = _FakeApiClient(_account)..accountUnauthorizedOnce = true;
    Session? refreshed;
    await tester.pumpWidget(
      MaterialApp(home: _page(api, onSessionRefreshed: (session) => refreshed = session)),
    );
    await tester.pumpAndSettle();

    expect(api.refreshCalls, 1);
    expect(refreshed?.accessToken, 'access-2');
    expect(find.text('me@example.com'), findsOneWidget);
  });
}
