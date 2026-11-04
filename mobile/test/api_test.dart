import 'dart:convert';

import 'package:dsh_mobile/api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('ApiClient', () {
    test('登录请求带设备信息并解析会话', () async {
      late Map<String, dynamic> sent;
      final client = MockClient((request) async {
        expect(request.url.path, '/v1/auth/login');
        sent = jsonDecode(request.body) as Map<String, dynamic>;
        return http.Response(
          jsonEncode({
            'account': {'id': 'a1', 'email': 'me@example.com'},
            'accessToken': 'access-1',
            'refreshToken': 'refresh-1',
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      });
      final api = ApiClient(baseUrl: 'https://dsh.example.com', client: client);
      final session = await api.login(
        email: 'me@example.com',
        password: 'Str0ng-Passw0rd-2026',
        deviceName: 'iPhone',
        platform: 'ios',
      );
      expect(session.accessToken, 'access-1');
      expect(session.refreshToken, 'refresh-1');
      expect(session.accountEmail, 'me@example.com');
      expect((sent['device'] as Map<String, dynamic>)['platform'], 'ios');
      expect(sent['clientType'], 'mobile');
    });

    test('登录失败抛出带错误码的 ApiException', () async {
      final client = MockClient((request) async => http.Response(
            jsonEncode({
              'error': {'code': 'auth.invalid_credentials', 'message': '邮箱或密码不正确'},
            }),
            401,
            headers: {'content-type': 'application/json'},
          ));
      final api = ApiClient(baseUrl: 'https://dsh.example.com', client: client);
      expect(
        () => api.login(email: 'a@b.com', password: 'x', deviceName: 'd', platform: 'ios'),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'auth.invalid_credentials')),
      );
    });

    test('设备列表解析 online 与平台', () async {
      final client = MockClient((request) async {
        expect(request.headers['authorization'], 'Bearer access-1');
        return http.Response(
          jsonEncode({
            'devices': [
              {'id': 'd1', 'name': '我的电脑', 'kind': 'desktop', 'platform': 'win32', 'online': true},
              {'id': 'd2', 'name': 'iPad', 'kind': 'mobile', 'platform': 'ios', 'online': false},
            ],
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      });
      final devices = await ApiClient(baseUrl: 'https://dsh.example.com', client: client)
          .listDevices('access-1');
      expect(devices, hasLength(2));
      expect(devices.first.name, '我的电脑');
      expect(devices.first.online, isTrue);
      expect(devices.first.platformLabel, 'Windows');
      expect(devices.last.online, isFalse);
    });

    test('重命名发送 PATCH 与 name 并解析返回设备', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'device': {
              'id': 'd1',
              'name': '工作站',
              'kind': 'desktop',
              'platform': 'win32',
              'online': true,
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      });
      final device = await ApiClient(baseUrl: 'https://dsh.example.com', client: client)
          .renameDevice('access-1', 'd1', '工作站');

      expect(captured.method, 'PATCH');
      expect(captured.url.path, '/v1/devices/d1');
      expect(captured.headers['authorization'], 'Bearer access-1');
      expect(jsonDecode(captured.body), {'name': '工作站'});
      expect(device.id, 'd1');
      expect(device.name, '工作站');
      expect(device.online, isTrue);
    });

    test('重命名 404 抛出带错误码的 ApiException', () async {
      final client = MockClient((request) async => http.Response(
            jsonEncode({
              'error': {'code': 'not_found.device', 'message': '设备不存在'},
            }),
            404,
            headers: {'content-type': 'application/json'},
          ));
      expect(
        () => ApiClient(baseUrl: 'https://dsh.example.com', client: client)
            .renameDevice('access-1', 'missing', '新名字'),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'not_found.device')),
      );
    });

    test('撤销设备发送 DELETE 并接受 204', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('', 204);
      });
      await ApiClient(baseUrl: 'https://dsh.example.com', client: client)
          .revokeDevice('access-1', 'd1');

      expect(captured.method, 'DELETE');
      expect(captured.url.path, '/v1/devices/d1');
      expect(captured.headers['authorization'], 'Bearer access-1');
    });

    test('账号信息解析 account.limits 与 usage', () async {
      final client = MockClient((request) async {
        expect(request.method, 'GET');
        expect(request.url.path, '/v1/account');
        expect(request.headers['authorization'], 'Bearer access-1');
        return http.Response(
          jsonEncode({
            'account': {
              'id': 'acc_1',
              'email': 'me@example.com',
              'displayName': '测试用户',
              'emailVerified': true,
              'createdAt': '2026-10-20T09:00:00.000Z',
              'limits': {'desktopDevices': 20, 'mobileDevices': 10},
            },
            'usage': {'desktopDevices': 2, 'mobileDevices': 1},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      });
      final account = await ApiClient(baseUrl: 'https://dsh.example.com', client: client)
          .account('access-1');

      expect(account.id, 'acc_1');
      expect(account.email, 'me@example.com');
      expect(account.displayName, '测试用户');
      expect(account.emailVerified, isTrue);
      expect(account.createdAt, DateTime.utc(2026, 10, 20, 9));
      expect(account.desktopLimit, 20);
      expect(account.mobileLimit, 10);
      expect(account.desktopUsed, 2);
      expect(account.mobileUsed, 1);
    });

    test('账号信息兼容规格草案的 quotas 形状且 displayName 为空时归一为 null', () async {
      final client = MockClient((request) async => http.Response(
            jsonEncode({
              'account': {
                'id': 'acc_1',
                'email': 'me@example.com',
                'displayName': null,
                'createdAt': '2026-10-20T09:00:00.000Z',
              },
              'quotas': {
                'desktop': {'used': 3, 'limit': 20},
                'mobile': {'used': 1, 'limit': 10},
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          ));
      final account = await ApiClient(baseUrl: 'https://dsh.example.com', client: client)
          .account('access-1');

      expect(account.displayName, isNull);
      expect(account.desktopUsed, 3);
      expect(account.desktopLimit, 20);
      expect(account.mobileUsed, 1);
      expect(account.mobileLimit, 10);
    });

    test('修改密码发送 currentPassword/newPassword 字段', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('', 204);
      });
      await ApiClient(baseUrl: 'https://dsh.example.com', client: client)
          .changePassword('access-1', 'old-pass-123', 'new-pass-456');

      expect(captured.method, 'POST');
      expect(captured.url.path, '/v1/auth/change-password');
      expect(captured.headers['authorization'], 'Bearer access-1');
      expect(jsonDecode(captured.body), {
        'currentPassword': 'old-pass-123',
        'newPassword': 'new-pass-456',
      });
    });

    test('修改密码失败（旧密码错误）抛出 ApiException', () async {
      final client = MockClient((request) async => http.Response(
            jsonEncode({
              'error': {'code': 'auth.invalid_credentials', 'message': '旧密码不正确'},
            }),
            401,
            headers: {'content-type': 'application/json'},
          ));
      expect(
        () => ApiClient(baseUrl: 'https://dsh.example.com', client: client)
            .changePassword('access-1', 'wrong', 'new-pass-456'),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'auth.invalid_credentials')),
      );
    });
  });
}
