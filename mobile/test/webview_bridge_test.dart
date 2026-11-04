import 'package:dsh_mobile/webview_bridge.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('WebView 桥接', () {
    test('设备 UI 地址带 /t/<id>/ 前缀，token 可选', () {
      expect(deviceUiUrl('https://dsh.example.com', 'abc'), 'https://dsh.example.com/t/abc/');
      expect(
        deviceUiUrl('https://dsh.example.com/', 'abc', accessToken: 't o+k'),
        'https://dsh.example.com/t/abc/?token=t%20o%2Bk',
      );
    });

    test('访问 Cookie 作用域限定在 /t/<id>', () {
      final cookie = accessCookie('https://dsh.example.com', 'abc', 'token-1');
      expect(cookie['name'], 'dsh_access');
      expect(cookie['value'], 'token-1');
      expect(cookie['domain'], 'dsh.example.com');
      expect(cookie['path'], '/t/abc');
    });

    test('窄屏注入 mobile 标记，宽屏注入 desktop 标记', () {
      final mobile = adaptationInjectionScript(shortestSideDp: 390, deviceId: 'abc');
      expect(mobile, contains("data-dsh-layout', 'mobile"));
      expect(mobile, contains("data-dsh-device', 'abc'"));

      final desktop = adaptationInjectionScript(shortestSideDp: 900, deviceId: 'abc');
      expect(desktop, contains("data-dsh-layout', 'desktop"));
    });

    test('外链判定：异源/非 http 视为外部，同源留在 WebView', () {
      const base = 'https://dsh.example.com';
      expect(isExternalUrl('https://dsh.example.com/t/abc/', appBaseUrl: base), isFalse);
      expect(isExternalUrl('https://github.com/x', appBaseUrl: base), isTrue);
      expect(isExternalUrl('mailto:a@b.com', appBaseUrl: base), isTrue);
      expect(isExternalUrl('javascript:void(0)', appBaseUrl: base), isFalse);
    });
  });
}
