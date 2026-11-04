import 'package:dsh_mobile/api.dart';
import 'package:dsh_mobile/pages/login_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeApiClient extends ApiClient {
  _FakeApiClient({this.shouldFail = false}) : super(baseUrl: 'https://dsh.example.com');

  final bool shouldFail;

  @override
  Future<Session> login({
    required String email,
    required String password,
    required String deviceName,
    required String platform,
    String appVersion = '0.1.0',
  }) async {
    if (shouldFail) throw ApiException(401, 'auth.invalid_credentials', '邮箱或密码不正确');
    return Session(accessToken: 'a', refreshToken: 'r', accountEmail: email);
  }
}

void main() {
  testWidgets('登录成功回调 Session', (tester) async {
    Session? received;
    await tester.pumpWidget(
      MaterialApp(
        home: LoginPage(
          api: _FakeApiClient(),
          onLoggedIn: (session) => received = session,
        ),
      ),
    );
    await tester.enterText(find.byKey(const Key('email-field')), 'me@example.com');
    await tester.enterText(find.byKey(const Key('password-field')), 'Str0ng-Passw0rd-2026');
    await tester.tap(find.byKey(const Key('login-button')));
    await tester.pumpAndSettle();

    expect(received, isNotNull);
    expect(received!.accountEmail, 'me@example.com');
  });

  testWidgets('登录失败显示错误信息', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: LoginPage(api: _FakeApiClient(shouldFail: true), onLoggedIn: (_) {}),
      ),
    );
    await tester.enterText(find.byKey(const Key('email-field')), 'me@example.com');
    await tester.enterText(find.byKey(const Key('password-field')), 'wrong');
    await tester.tap(find.byKey(const Key('login-button')));
    await tester.pumpAndSettle();

    expect(find.text('邮箱或密码不正确'), findsOneWidget);
  });

  testWidgets('空表单提示输入', (tester) async {
    await tester.pumpWidget(
      MaterialApp(home: LoginPage(api: _FakeApiClient(), onLoggedIn: (_) {})),
    );
    await tester.tap(find.byKey(const Key('login-button')));
    await tester.pumpAndSettle();
    expect(find.text('请输入邮箱和密码'), findsOneWidget);
  });
}
