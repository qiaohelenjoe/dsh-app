import 'package:flutter/material.dart';

import 'api.dart';
import 'logging.dart';
import 'pages/devices_page.dart';
import 'pages/login_page.dart';
import 'pages/settings_page.dart';
import 'pages/webview_page.dart';
import 'session_store.dart';
import 'theme.dart';
import 'webview/webview_adapter.dart';

/// App 引导：冷启动有会话与上次设备则直接进入 WebView；否则登录页。
class DshMobileApp extends StatelessWidget {
  const DshMobileApp({
    super.key,
    required this.baseUrl,
    required this.api,
    required this.store,
    required this.adapterFactory,
    required this.openExternal,
    this.platform = 'android',
  });

  final String baseUrl;
  final ApiClient api;
  final SessionStore store;
  final WebViewAdapter Function() adapterFactory;
  final Future<bool> Function(String url) openExternal;
  final String platform;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'DSH Harness',
      debugShowCheckedModeBanner: false,
      theme: DshTheme.light(),
      home: _BootstrapPage(
        baseUrl: baseUrl,
        api: api,
        store: store,
        adapterFactory: adapterFactory,
        openExternal: openExternal,
        platform: platform,
      ),
    );
  }
}

class _BootstrapPage extends StatefulWidget {
  const _BootstrapPage({
    required this.baseUrl,
    required this.api,
    required this.store,
    required this.adapterFactory,
    required this.openExternal,
    required this.platform,
  });

  final String baseUrl;
  final ApiClient api;
  final SessionStore store;
  final WebViewAdapter Function() adapterFactory;
  final Future<bool> Function(String url) openExternal;
  final String platform;

  @override
  State<_BootstrapPage> createState() => _BootstrapPageState();
}

class _BootstrapPageState extends State<_BootstrapPage> {
  Session? _session;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _restore();
  }

  Future<void> _restore() async {
    var session = await widget.store.loadSession();
    if (session != null) {
      // 冷启动可能距上次使用很久，先刷新 access token
      try {
        final refreshed = await widget.api.refresh(session.refreshToken);
        session = Session(
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          accountEmail: session.accountEmail,
        );
        await widget.store.saveSession(session);
      } on ApiException catch (error) {
        // 刷新令牌被撤销/过期：直接回到登录页，避免卡在“会话已失效”
        if (error.statusCode == 401) {
          await widget.store.clear();
          session = null;
        }
      } catch (_) {
        // 网络异常不阻塞启动；后续请求 401 时再走刷新/登录
      }
    }
    if (!mounted) return;
    setState(() {
      _session = session;
      _loading = false;
    });
    AppLogger.instance.configure(api: widget.api, accessToken: session?.accessToken);
    AppLogger.instance.log('info', 'startup', 'app restored', {'hasSession': session != null});
    AppLogger.instance.flush();
  }

  Future<void> _onLoggedIn(Session session) async {
    await widget.store.saveSession(session);
    if (!mounted) return;
    // 登录后不自动打开设备：用户可能有多台电脑，统一进设备列表选择
    setState(() => _session = session);
    AppLogger.instance.configure(api: widget.api, accessToken: session.accessToken);
    AppLogger.instance.log('info', 'login', 'login succeeded', {'email': session.accountEmail});
  }

  void _openDevice(DeviceInfo device, Session session) {
    widget.store.saveSession(session, lastDeviceId: device.id);
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DshWebViewPage(
          baseUrl: widget.baseUrl,
          deviceId: device.id,
          deviceName: device.name,
          session: session,
          api: widget.api,
          store: widget.store,
          adapterFactory: widget.adapterFactory,
          openExternal: widget.openExternal,
          onSessionExpired: () async {
            final navigator = Navigator.of(context);
            await widget.store.clear();
            if (!mounted) return;
            setState(() => _session = null);
            navigator.popUntil((route) => route.isFirst);
          },        ),
      ),
    );
  }

  /// 会话被服务端判定失效（刷新也失败）：清本地会话直接回登录页，不弹提示、不需要用户点退出。
  Future<void> _handleSessionExpired() async {
    await widget.store.clear();
    if (!mounted) return;
    setState(() => _session = null);
  }

  Future<void> _logout() async {
    await widget.store.clear();
    AppLogger.instance.configure(api: widget.api, accessToken: null);
    if (!mounted) return;
    setState(() => _session = null);
  }

  void _openSettings(Session session) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SettingsPage(
          api: widget.api,
          session: session,
          store: widget.store,
          onLogout: _logout,
          onSessionRefreshed: (next) => setState(() => _session = next),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_session == null) {
      return LoginPage(
        api: widget.api,
        platform: widget.platform,
        onLoggedIn: _onLoggedIn,
      );
    }
    return DevicesPage(
      api: widget.api,
      session: _session!,
      store: widget.store,
      onOpenDevice: _openDevice,
      onSessionRefreshed: (session) => setState(() => _session = session),
      onSessionExpired: _handleSessionExpired,
      onOpenSettings: _openSettings,
    );
  }
}
