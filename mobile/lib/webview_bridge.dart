import 'form_factor.dart';

/// 设备 UI 地址：`{base}/t/{deviceId}/`，可选带上 access token（首次进入用于建立 Cookie）。
String deviceUiUrl(String baseUrl, String deviceId, {String? accessToken}) {
  final base = baseUrl.replaceAll(RegExp(r'/+$'), '');
  final baseUrlWithDevice = '$base/t/$deviceId/';
  if (accessToken == null || accessToken.isEmpty) return baseUrlWithDevice;
  return '$baseUrlWithDevice?token=${Uri.encodeComponent(accessToken)}';
}

/// 登录后在 WebView 中设置访问 Cookie（服务端 `/t/*` 认 `dsh_access`）。
Map<String, String> accessCookie(String baseUrl, String deviceId, String accessToken) {
  final uri = Uri.parse(baseUrl);
  return {
    'name': 'dsh_access',
    'value': accessToken,
    'domain': uri.host,
    'path': '/t/$deviceId',
  };
}

/// 注入脚本：窄屏时给 `<html>` 打标记，供 T10 适配层 CSS 使用。
String adaptationInjectionScript({required double shortestSideDp, required String deviceId}) {
  final inject = shouldInjectMobileAdaptation(shortestSideDp);
  final deviceLiteral = _jsString(deviceId);
  final mode = inject ? 'mobile' : 'desktop';
  return '''
(function () {
  try {
    document.documentElement.setAttribute('data-dsh-device', $deviceLiteral);
    document.documentElement.setAttribute('data-dsh-layout', '$mode');
    document.documentElement.style.setProperty('--dsh-shortest-side', '${shortestSideDp.toStringAsFixed(1)}dp');
  } catch (error) { /* 页面未就绪时忽略 */ }
})();
''';
}

String _jsString(String value) => "'${value.replaceAll(r'\', r'\\').replaceAll("'", r"\'")}'";

/// 外部链接判定：只允许同源（DSH 代理域）留在 WebView 内。
bool isExternalUrl(String url, {required String appBaseUrl}) {
  final parsed = Uri.tryParse(url);
  if (parsed == null) return false;
  if (parsed.scheme == 'about' || parsed.scheme == 'data' || parsed.scheme == 'javascript') return false;
  if (parsed.scheme == 'http' || parsed.scheme == 'https') {
    return parsed.host != Uri.parse(appBaseUrl).host;
  }
  return true;
}

/// 登录后应保存的本地状态（安全存储/偏好）。
class SessionState {
  const SessionState({
    required this.accessToken,
    required this.refreshToken,
    required this.lastDeviceId,
    this.accountEmail = '',
  });

  final String accessToken;
  final String refreshToken;
  final String lastDeviceId;
  final String accountEmail;
}
