import 'dart:async';

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

/// WebView 抽象：Widget 测试注入 Fake，真机使用 FlutterWebViewAdapter。
abstract class WebViewAdapter {
  Future<void> initialize();

  Widget buildView();

  Future<void> loadUrl(String url);

  Future<void> setCookie({
    required String name,
    required String value,
    required String domain,
    required String path,
  });

  Future<void> injectScript(String script);

  /// 执行 JS 并返回字符串结果（诊断读取页面内日志用）。
  Future<String> evaluateScript(String script);

  /// 清理 WebView 本地存储/缓存（避免残留失效的会话引用）。
  Future<void> clearSessionStorage();

  Future<bool> canGoBack();

  Future<void> goBack();

  Future<void> reload();

  void setHandlers({
    required Future<bool> Function(String url) onNavigation,
    required void Function(String message) onError,
    required VoidCallback onPageFinished,
  });

  /// 捕获网页 console 输出（诊断 WS/RPC 问题用）。
  void setConsoleHandler(void Function(String level, String message) handler);

  void dispose();
}

class FlutterWebViewAdapter implements WebViewAdapter {
  final WebViewController _controller = WebViewController();

  @override
  Future<void> initialize() async {
    await _controller.setJavaScriptMode(JavaScriptMode.unrestricted);
    await _controller.setBackgroundColor(const Color(0xFFFFFFFF));
  }

  @override
  Widget buildView() => WebViewWidget(controller: _controller);

  @override
  Future<void> loadUrl(String url) => _controller.loadRequest(Uri.parse(url));

  @override
  Future<void> setCookie({
    required String name,
    required String value,
    required String domain,
    required String path,
  }) async {
    await WebViewCookieManager().setCookie(WebViewCookie(name: name, value: value, domain: domain, path: path));
  }

  @override
  Future<void> injectScript(String script) => _controller.runJavaScript(script);

  @override
  Future<void> clearSessionStorage() async {
    await _controller.clearLocalStorage();
    await _controller.clearCache();
  }

  @override
  Future<String> evaluateScript(String script) async {
    final result = await _controller.runJavaScriptReturningResult(script);
    return result.toString();
  }

  @override
  Future<bool> canGoBack() => _controller.canGoBack();

  @override
  Future<void> goBack() => _controller.goBack();

  @override
  Future<void> reload() => _controller.reload();

  @override
  void setHandlers({
    required Future<bool> Function(String url) onNavigation,
    required void Function(String message) onError,
    required VoidCallback onPageFinished,
  }) {
    _controller.setNavigationDelegate(
      NavigationDelegate(
        onNavigationRequest: (request) async {
          final allow = await onNavigation(request.url);
          return allow ? NavigationDecision.navigate : NavigationDecision.prevent;
        },
        // 只有主框架失败才展示错误页；插件 JS/图片等子资源失败交给页面自己容错，
        // 否则首次加载缓存为空时，任何一个子资源失败都会误报「无法打开 DSH」。
        onWebResourceError: (error) {
          if (error.isForMainFrame ?? true) onError(error.description);
        },
        onPageFinished: (_) => onPageFinished(),
      ),
    );
  }

  @override
  void setConsoleHandler(void Function(String level, String message) handler) {
    _controller.setOnConsoleMessage((message) {
      handler(message.level.name, message.message);
    });
  }

  @override
  void dispose() {
    // WebViewController 无需显式销毁
  }
}
