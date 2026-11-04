import 'dart:convert';

import 'package:dsh_mobile/api.dart';
import 'package:dsh_mobile/session_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _session = Session(
  accessToken: 'access-token-secret',
  refreshToken: 'refresh-token-secret',
  accountEmail: 'me@example.com',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('SecureSessionStore', () {
    test('令牌写入安全存储且不落 SharedPreferences，可原样读回', () async {
      final secure = MemorySecureStore();
      final store = SecureSessionStore(secure: secure);

      await store.saveSession(_session, lastDeviceId: 'd1');

      final loaded = await store.loadSession();
      expect(loaded, isNotNull);
      expect(loaded!.accessToken, 'access-token-secret');
      expect(loaded.refreshToken, 'refresh-token-secret');
      expect(loaded.accountEmail, 'me@example.com');

      final raw = secure.values[SecureSessionStore.sessionKey];
      expect(raw, isNotNull);
      expect(jsonDecode(raw!)['refreshToken'], 'refresh-token-secret');

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getKeys(), isNot(contains(SecureSessionStore.sessionKey)));
      final allValues = prefs.getKeys().map((key) => '$key=${prefs.get(key)}').join('\n');
      expect(allValues, isNot(contains('access-token-secret')));
      expect(allValues, isNot(contains('refresh-token-secret')));
      expect(prefs.getString(SecureSessionStore.lastDeviceKey), 'd1');
    });

    test('clear 同时清空安全存储与 SharedPreferences', () async {
      final secure = MemorySecureStore();
      final store = SecureSessionStore(secure: secure);
      await store.saveSession(_session, lastDeviceId: 'd1');

      await store.clear();

      expect(secure.values, isEmpty);
      expect(await store.loadSession(), isNull);
      expect(await store.lastDeviceId(), isNull);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getKeys(), isEmpty);
    });

    test('clearLastDevice 只清 lastDeviceId，保留会话', () async {
      final store = SecureSessionStore(secure: MemorySecureStore());
      await store.saveSession(_session, lastDeviceId: 'd1');

      await store.clearLastDevice();

      expect(await store.lastDeviceId(), isNull);
      expect((await store.loadSession())!.accessToken, 'access-token-secret');
    });

    test('安全存储内容损坏时返回 null 而非抛异常', () async {
      final secure = MemorySecureStore({SecureSessionStore.sessionKey: 'not-json'});
      final store = SecureSessionStore(secure: secure);

      expect(await store.loadSession(), isNull);
    });

    test('注入 preferences 读取器时不依赖默认 SharedPreferences 单例', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final store = SecureSessionStore(
        secure: MemorySecureStore(),
        preferences: () async => prefs,
      );

      await store.saveSession(_session, lastDeviceId: 'd9');

      expect(await store.lastDeviceId(), 'd9');
      expect(prefs.getString(SecureSessionStore.lastDeviceKey), 'd9');
    });
  });
}
