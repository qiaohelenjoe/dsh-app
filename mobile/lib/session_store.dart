import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';

/// 本地会话与“上次设备”持久化。
///
/// 敏感令牌只能经由 [SecureSessionStore] 写入平台安全存储；
/// 非敏感的 `lastDeviceId` 仍保存在 SharedPreferences。
abstract class SessionStore {
  Future<Session?> loadSession();
  Future<void> saveSession(Session session, {String? lastDeviceId});
  Future<String?> lastDeviceId();
  Future<void> clearLastDevice();
  Future<void> clear();
}

/// 平台安全存储的最小键值抽象。
///
/// 生产实现是 [FlutterSecureKeyValueStore]（Android Keystore / iOS Keychain）；
/// 测试注入 [MemorySecureStore]，避免依赖原生通道。
abstract class SecureKeyValueStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// `flutter_secure_storage` 适配器：令牌落系统安全存储。
class FlutterSecureKeyValueStore implements SecureKeyValueStore {
  FlutterSecureKeyValueStore([FlutterSecureStorage? storage])
      : _storage = storage ??
            const FlutterSecureStorage(
              // Android：优先使用 EncryptedSharedPreferences（Keystore 包裹）。
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

/// 测试用内存安全存储。
class MemorySecureStore implements SecureKeyValueStore {
  MemorySecureStore([Map<String, String>? initialValues])
      : values = {...?initialValues};

  final Map<String, String> values;

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

/// 令牌 JSON 写入平台安全存储，`lastDeviceId` 写入 SharedPreferences。
class SecureSessionStore implements SessionStore {
  SecureSessionStore({
    SecureKeyValueStore? secure,
    Future<SharedPreferences> Function()? preferences,
  })  : _secure = secure ?? FlutterSecureKeyValueStore(),
        _preferences = preferences ?? SharedPreferences.getInstance;

  static const sessionKey = 'dsh.session';
  static const lastDeviceKey = 'dsh.lastDeviceId';

  final SecureKeyValueStore _secure;
  final Future<SharedPreferences> Function() _preferences;

  @override
  Future<Session?> loadSession() async {
    final raw = await _secure.read(sessionKey);
    if (raw == null) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      return Session.fromJson(decoded);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> saveSession(Session session, {String? lastDeviceId}) async {
    await _secure.write(sessionKey, jsonEncode(session.toJson()));
    if (lastDeviceId != null) {
      final prefs = await _preferences();
      await prefs.setString(lastDeviceKey, lastDeviceId);
    }
  }

  @override
  Future<String?> lastDeviceId() async {
    final prefs = await _preferences();
    return prefs.getString(lastDeviceKey);
  }

  @override
  Future<void> clearLastDevice() async {
    final prefs = await _preferences();
    await prefs.remove(lastDeviceKey);
  }

  @override
  Future<void> clear() async {
    await _secure.delete(sessionKey);
    await clearLastDevice();
  }
}

/// Widget 测试用内存会话存储。
class MemorySessionStore implements SessionStore {
  Session? session;
  String? deviceId;

  @override
  Future<Session?> loadSession() async => session;

  @override
  Future<void> saveSession(Session session, {String? lastDeviceId}) async {
    this.session = session;
    if (lastDeviceId != null) deviceId = lastDeviceId;
  }

  @override
  Future<String?> lastDeviceId() async => deviceId;

  @override
  Future<void> clearLastDevice() async {
    deviceId = null;
  }

  @override
  Future<void> clear() async {
    session = null;
    deviceId = null;
  }
}
