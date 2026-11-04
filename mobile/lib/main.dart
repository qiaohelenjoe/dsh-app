import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api.dart';
import 'app.dart';
import 'logging.dart';
import 'session_store.dart';
import 'webview/webview_adapter.dart';

const _serverUrl = String.fromEnvironment('DSH_SERVER_URL', defaultValue: 'https://dsh.hbzxht.com');

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  // 沉浸式：内容绘制到状态栏和手势条下面，系统栏本身透明。
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
      statusBarBrightness: Brightness.light,
      systemNavigationBarColor: Colors.transparent,
      systemNavigationBarIconBrightness: Brightness.dark,
      systemNavigationBarDividerColor: Colors.transparent,
    ),
  );
  AppLogger.instance.install();
  runApp(
    DshMobileApp(
      baseUrl: _serverUrl,
      api: ApiClient(baseUrl: _serverUrl),
      store: SecureSessionStore(),
      adapterFactory: () => FlutterWebViewAdapter(),
      openExternal: (url) => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication),
      platform: defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android',
    ),
  );
}
