import 'dart:convert';

import 'package:http/http.dart' as http;

import 'app_version.dart';

class ApiException implements Exception {
  ApiException(this.statusCode, this.code, this.message);

  final int statusCode;
  final String code;
  final String message;

  @override
  String toString() => 'ApiException($statusCode, $code): $message';
}

class Session {
  const Session({
    required this.accessToken,
    required this.refreshToken,
    this.accountEmail = '',
  });

  final String accessToken;
  final String refreshToken;
  final String accountEmail;

  Map<String, dynamic> toJson() => {
        'accessToken': accessToken,
        'refreshToken': refreshToken,
        'accountEmail': accountEmail,
      };

  static Session fromJson(Map<String, dynamic> json) => Session(
        accessToken: json['accessToken'] as String,
        refreshToken: json['refreshToken'] as String,
        accountEmail: (json['accountEmail'] as String?) ?? '',
      );
}

/// 网页会话：刷新后的令牌 + 可直接写入 WebView 的 7 天 Cookie。
class WebSession {
  const WebSession({required this.session, required this.cookie});

  final Session session;
  final String cookie;
}
class DeviceInfo {
  const DeviceInfo({
    required this.id,
    required this.name,
    required this.kind,
    required this.platform,
    required this.online,
    this.machineName,
    this.lastSeenAt,
  });

  final String id;
  final String name;
  final String kind;
  final String platform;
  final bool online;

  /// 计算机名称（设备身份；老设备未上报时为 null）。界面在非本机设备名后用括号显示。
  final String? machineName;
  final DateTime? lastSeenAt;

  String get platformLabel {
    switch (platform) {
      case 'win32':
        return 'Windows';
      case 'darwin':
        return 'macOS';
      case 'linux':
        return 'Linux';
      case 'android':
        return 'Android';
      case 'ios':
        return 'iOS';
      case 'harmony':
        return 'HarmonyOS';
      default:
        return platform;
    }
  }

  static DeviceInfo fromJson(Map<String, dynamic> json) => DeviceInfo(
        id: json['id'] as String,
        name: json['name'] as String,
        kind: (json['kind'] as String?) ?? 'desktop',
        platform: (json['platform'] as String?) ?? 'unknown',
        online: (json['online'] as bool?) ?? false,
        machineName: json['machineName'] is String ? json['machineName'] as String : null,
        lastSeenAt: json['lastSeenAt'] is String ? DateTime.tryParse(json['lastSeenAt'] as String) : null,
      );
}

class AccountInfo {
  const AccountInfo({
    required this.id,
    required this.email,
    this.displayName,
    this.emailVerified = false,
    this.createdAt,
    required this.desktopLimit,
    required this.mobileLimit,
    required this.desktopUsed,
    required this.mobileUsed,
  });

  final String id;
  final String email;
  final String? displayName;
  final bool emailVerified;
  final DateTime? createdAt;
  final int desktopLimit;
  final int mobileLimit;
  final int desktopUsed;
  final int mobileUsed;

  static AccountInfo fromJson(Map<String, dynamic> json) {
    final account = _asMap(json['account']);
    final limits = _asMap(account['limits']);
    final usage = _asMap(json['usage']);
    // 兼容修复规格正文曾给出的 quotas 草案形状。
    final quotas = _asMap(json['quotas']);
    final desktopQuota = _asMap(quotas['desktop']);
    final mobileQuota = _asMap(quotas['mobile']);
    return AccountInfo(
      id: (account['id'] as String?) ?? '',
      email: (account['email'] as String?) ?? '',
      displayName: _normalizeDisplayName(account['displayName']),
      emailVerified: (account['emailVerified'] as bool?) ?? false,
      createdAt: account['createdAt'] is String
          ? DateTime.tryParse(account['createdAt'] as String)
          : null,
      desktopLimit: _asInt(limits['desktopDevices'] ?? desktopQuota['limit'], 20),
      mobileLimit: _asInt(limits['mobileDevices'] ?? mobileQuota['limit'], 10),
      desktopUsed: _asInt(usage['desktopDevices'] ?? desktopQuota['used'], 0),
      mobileUsed: _asInt(usage['mobileDevices'] ?? mobileQuota['used'], 0),
    );
  }

  static Map<String, dynamic> _asMap(dynamic value) =>
      value is Map<String, dynamic> ? value : const {};

  static int _asInt(dynamic value, int fallback) =>
      value is num ? value.toInt() : fallback;

  static String? _normalizeDisplayName(dynamic value) {
    if (value is! String) return null;
    final trimmed = value.trim();
    return trimmed.isEmpty ? null : trimmed;
  }
}

class ApiClient {
  ApiClient({required this.baseUrl, http.Client? client}) : _client = client ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  Uri _uri(String path) => Uri.parse('${baseUrl.replaceAll(RegExp(r'/+$'), '')}$path');

  Map<String, String> _jsonHeaders([String? accessToken]) => {
        'content-type': 'application/json',
        if (accessToken != null) 'authorization': 'Bearer $accessToken',
      };

  ApiException _error(int status, Map<String, dynamic>? body) {
    final error = body?['error'];
    if (error is Map<String, dynamic>) {
      return ApiException(status, (error['code'] as String?) ?? 'request.invalid', (error['message'] as String?) ?? '请求失败');
    }
    return ApiException(status, 'request.invalid', '请求失败（HTTP $status）');
  }

  Future<Session> login({
    required String email,
    required String password,
    required String deviceName,
    required String platform,
    String appVersion = kAppVersion,
  }) async {
    final response = await _client.post(
      _uri('/v1/auth/login'),
      headers: _jsonHeaders(),
      body: jsonEncode({
        'email': email,
        'password': password,
        'clientType': 'mobile',
        'device': {
          'name': deviceName,
          'platform': platform,
          'appVersion': appVersion,
          // v1 移动壳不做端到端协商，先登记占位公钥；后续版本替换为真实密钥
          'signPublicKey': 'mobile-shell-placeholder',
          'ecdhPublicKey': 'mobile-shell-placeholder',
        },
      }),
    );
    final body = _decode(response);
    if (response.statusCode != 200) throw _error(response.statusCode, body);
    final account = body['account'] as Map<String, dynamic>? ?? {};
    return Session(
      accessToken: body['accessToken'] as String,
      refreshToken: body['refreshToken'] as String,
      accountEmail: (account['email'] as String?) ?? email,
    );
  }

  Future<void> register({required String email, required String password}) async {
    final response = await _client.post(
      _uri('/v1/auth/register'),
      headers: _jsonHeaders(),
      body: jsonEncode({'email': email, 'password': password}),
    );
    final body = _decode(response);
    if (response.statusCode != 201) throw _error(response.statusCode, body);
  }
  Future<Session> refresh(String refreshToken) async {
    final response = await _client.post(
      _uri('/v1/auth/refresh'),
      headers: _jsonHeaders(),
      body: jsonEncode({'refreshToken': refreshToken}),
    );
    final body = _decode(response);
    if (response.statusCode != 200) throw _error(response.statusCode, body);
    return Session(
      accessToken: body['accessToken'] as String,
      refreshToken: body['refreshToken'] as String,
    );
  }

  /// 用 refresh token 换 7 天网页 Cookie（WebView 内不再 15 分钟掉登录）。
  Future<WebSession> webSession(String refreshToken) async {
    final response = await _client.post(
      _uri('/v1/auth/web-session'),
      headers: _jsonHeaders(),
      body: jsonEncode({'refreshToken': refreshToken}),
    );
    final body = _decode(response);
    if (response.statusCode != 200) throw _error(response.statusCode, body);
    return WebSession(
      session: Session(
        accessToken: body['accessToken'] as String,
        refreshToken: body['refreshToken'] as String,
      ),
      cookie: body['cookie'] as String,
    );
  }
  Future<List<DeviceInfo>> listDevices(String accessToken) async {
    final response = await _client.get(_uri('/v1/devices'), headers: _jsonHeaders(accessToken));
    final body = _decode(response);
    if (response.statusCode != 200) throw _error(response.statusCode, body);
    final devices = (body['devices'] as List<dynamic>? ?? []);
    return devices
        .whereType<Map<String, dynamic>>()
        .map(DeviceInfo.fromJson)
        .toList(growable: false);
  }

  Future<DeviceInfo> renameDevice(String accessToken, String id, String name) async {
    final response = await _client.patch(
      _uri('/v1/devices/${Uri.encodeComponent(id)}'),
      headers: _jsonHeaders(accessToken),
      body: jsonEncode({'name': name}),
    );
    final body = _decode(response);
    if (response.statusCode != 200) throw _error(response.statusCode, body);
    final device = body['device'];
    if (device is! Map<String, dynamic>) {
      throw ApiException(response.statusCode, 'request.invalid', '服务端未返回设备信息');
    }
    return DeviceInfo.fromJson(device);
  }

  Future<void> revokeDevice(String accessToken, String id) async {
    final response = await _client.delete(
      _uri('/v1/devices/${Uri.encodeComponent(id)}'),
      headers: _jsonHeaders(accessToken),
    );
    if (response.statusCode != 204 && response.statusCode != 200) {
      throw _error(response.statusCode, _decode(response));
    }
  }

  Future<AccountInfo> account(String accessToken) async {
    final response = await _client.get(_uri('/v1/account'), headers: _jsonHeaders(accessToken));
    final body = _decode(response);
    if (response.statusCode != 200) throw _error(response.statusCode, body);
    return AccountInfo.fromJson(body);
  }

  Future<void> uploadLogs(
    String accessToken,
    List<Map<String, dynamic>> entries, {
    required String appVersion,
    required String platform,
  }) async {
    if (entries.isEmpty) return;
    final response = await _client.post(
      _uri('/v1/client-logs'),
      headers: _jsonHeaders(accessToken),
      body: jsonEncode({
        'appVersion': appVersion,
        'platform': platform,
        'entries': entries,
      }),
    );
    if (response.statusCode != 202) {
      throw _error(response.statusCode, _decode(response));
    }
  }
  Future<void> changePassword(String accessToken, String oldPassword, String newPassword) async {
    final response = await _client.post(
      _uri('/v1/auth/change-password'),
      headers: _jsonHeaders(accessToken),
      // 服务端 schema 字段名为 currentPassword（见 server/src/http/schemas.ts）。
      body: jsonEncode({'currentPassword': oldPassword, 'newPassword': newPassword}),
    );
    if (response.statusCode != 204 && response.statusCode != 200) {
      throw _error(response.statusCode, _decode(response));
    }
  }

  Future<void> logout(String refreshToken) async {    await _client.post(
      _uri('/v1/auth/logout'),
      headers: _jsonHeaders(),
      body: jsonEncode({'refreshToken': refreshToken}),
    );
  }

  /// 忘记密码第二步：校验邮箱验证码，成功返回短时重置令牌。
  Future<String> verifyResetCode(String email, String code) async {
    final response = await _client.post(
      _uri('/v1/auth/verify-reset-code'),
      headers: _jsonHeaders(),
      body: jsonEncode({'email': email, 'code': code}),
    );
    final body = _decode(response);
    if (response.statusCode != 200) throw _error(response.statusCode, body);
    final token = body['resetToken'];
    if (token is! String || token.isEmpty) throw ApiException(response.statusCode, 'request.invalid', '服务端未返回重置令牌');
    return token;
  }

  /// 忘记密码第三步：用重置令牌设置新密码（成功后全部会话失效）。
  Future<void> resetPassword(String resetToken, String newPassword) async {
    final response = await _client.post(
      _uri('/v1/auth/reset-password'),
      headers: _jsonHeaders(),
      body: jsonEncode({'resetToken': resetToken, 'newPassword': newPassword}),
    );
    if (response.statusCode != 204 && response.statusCode != 200) {
      throw _error(response.statusCode, _decode(response));
    }
  }

  /// 忘记密码：服务端恒返回 202（防枚举），界面统一提示"若邮箱存在，重置邮件已发送"。
  Future<void> forgotPassword(String email) async {
    final response = await _client.post(
      _uri('/v1/auth/forgot-password'),
      headers: _jsonHeaders(),
      body: jsonEncode({'email': email}),
    );
    if (response.statusCode != 202 && response.statusCode != 200) {
      throw _error(response.statusCode, _decode(response));
    }
  }

  Map<String, dynamic> _decode(http.Response response) {
    if (response.body.isEmpty) return {};
    try {
      final decoded = jsonDecode(response.body);
      return decoded is Map<String, dynamic> ? decoded : {};
    } catch (_) {
      return {};
    }
  }
}
