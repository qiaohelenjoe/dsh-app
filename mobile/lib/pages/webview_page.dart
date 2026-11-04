import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';
import '../logging.dart';
import '../form_factor.dart';
import '../session_store.dart';
import '../webview/webview_adapter.dart';
import '../webview_bridge.dart';

/// DSH Web UI 容器：加载 `/t/<deviceId>/`，按短边注入适配脚本，折叠屏切换不重载。
class DshWebViewPage extends StatefulWidget {
  const DshWebViewPage({
    super.key,
    required this.baseUrl,
    required this.deviceId,
    required this.deviceName,
    required this.session,
    required this.api,
    required this.store,
    required this.adapterFactory,
    required this.openExternal,
    this.onSessionExpired,
  });

  final String baseUrl;
  final String deviceId;
  final String deviceName;
  final Session session;
  final ApiClient api;
  final SessionStore store;
  final WebViewAdapter Function() adapterFactory;
  final Future<bool> Function(String url) openExternal;
  final Future<void> Function()? onSessionExpired;

  @override
  State<DshWebViewPage> createState() => _DshWebViewPageState();
}

class _DshWebViewPageState extends State<DshWebViewPage> {
  late final WebViewAdapter _adapter = widget.adapterFactory();
  bool _initialized = false;
  bool _pageReady = false;
  String? _error;
  double _shortestSide = 0;
  bool? _injectedMobile;
  final List<String> _logs = [];
  String _currentUrl = '';
  List<Map<String, dynamic>> _netLogs = [];

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    await _adapter.initialize();
    // 只在首次进入或切换设备时清空 WebView 本地状态。同一设备再次进入时
    // 保留 localStorage，DSH 才能恢复上次打开的会话与侧栏状态；
    // 之前每次进入都清，导致刷新后总是在原工作区里新建一个对话。
    final lastDevice = await widget.store.lastDeviceId();
    if (lastDevice != widget.deviceId) {
      await _adapter.clearSessionStorage();
    }
    _adapter.setHandlers(
      onNavigation: _handleNavigation,
      onError: (message) {
        if (!mounted) return;
        setState(() => _error = message);
      },
      onPageFinished: _onPageFinished,
    );
    _initialized = true;
    _adapter.setConsoleHandler((level, message) {
      if (!mounted) return;
      AppLogger.instance.log(level == 'error' ? 'error' : 'info', 'webview_console', message, {'device': widget.deviceId});
      final line = '[$level] $message';
      setState(() {
        _logs.add(line.length > 320 ? '${line.substring(0, 320)}…' : line);
        if (_logs.length > 120) _logs.removeAt(0);
      });
    });
    final host = Uri.parse(widget.baseUrl).host;
    final rootUrl = '${widget.baseUrl.replaceAll(RegExp(r'/+$'), '')}/';
    // DSH 前端只支持根路径：用 dsh_device cookie 决定设备，dsh_access 用 7 天网页 Cookie
    Future<void> openRoot(String accessToken) async {
      await _adapter.setCookie(name: 'dsh_access', value: accessToken, domain: host, path: '/');
      await _adapter.setCookie(name: 'dsh_device', value: widget.deviceId, domain: host, path: '/');
      _currentUrl = rootUrl;
      await _adapter.loadUrl(rootUrl);
    }

    try {
      final webSession = await widget.api.webSession(widget.session.refreshToken);
      await widget.store.saveSession(
        Session(
          accessToken: webSession.session.accessToken,
          refreshToken: webSession.session.refreshToken,
          accountEmail: widget.session.accountEmail,
        ),
      );
      await openRoot(webSession.cookie);
      return;
    } on ApiException catch (error) {
      if (error.statusCode == 401) {
        await widget.onSessionExpired?.call();
        return;
      }
    } catch (_) {
      // 网络异常：退回 access token
    }

    await openRoot(widget.session.accessToken);
  }
  Future<bool> _handleNavigation(String url) async {
    final external = isExternalUrl(url, appBaseUrl: widget.baseUrl);
    if (external) {
      final opened = await widget.openExternal(url);
      return !opened; // 外部链接不在 WebView 内跳转
    }
    return true;
  }

  Future<void> _onPageFinished() async {
    if (!mounted) return;
    setState(() {
      _pageReady = true;
      _error = null;
    });
    await _applyInjection();
  }



  Future<void> _applyInjection() async {
    if (!_initialized) return;
    final mobile = shouldInjectMobileAdaptation(_shortestSide);
    if (_injectedMobile == mobile) return;
    _injectedMobile = mobile;
    await _adapter.injectScript(
      adaptationInjectionScript(shortestSideDp: _shortestSide, deviceId: widget.deviceId),
    );
  }

  Future<void> _handleBack() async {
    // 设备详情是独立路由：返回一律回到设备列表，不进入网页历史
    if (mounted) Navigator.of(context).pop();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final shortest = MediaQuery.sizeOf(context).shortestSide;
    if (shortest != _shortestSide) {
      _shortestSide = shortest;
      // 折叠屏展开/折叠：只重新注入布局标记，不重载 WebView
      if (_pageReady) {
        _injectedMobile = null;
        unawaited(_applyInjection());
      }
    }
  }

  Future<void> _loadNetLogs() async {
    try {
      final raw = await _adapter.evaluateScript('JSON.stringify(window.__dshNetLog||[])');
      final decoded = jsonDecode(raw);
      if (decoded is List) {
        setState(() {
          _netLogs = decoded.whereType<Map>().map((item) => Map<String, dynamic>.from(item)).toList();
        });
      }
    } catch (_) {
      // 页面尚未就绪时忽略
    }
  }

  String _formatNetLine(Map<String, dynamic> entry) {
    final kind = entry['kind'] ?? '?';
    final url = entry['url'] ?? '';
    if (kind == 'ws') {
      final event = entry['event'] ?? '';
      final code = entry['code'];
      return '[ws] $event $url${code == null ? '' : ' code=$code'}';
    }
    final status = entry['status'];
    final ms = entry['ms'];
    final err = entry['err'];
    return '[$kind] $url status=$status ${ms}ms${err == null ? '' : ' $err'}';
  }
  Future<void> _showDiagnostics() async {
    await _loadNetLogs();
    if (!mounted) return;
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: SizedBox(
          height: MediaQuery.sizeOf(sheetContext).height * 0.75,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    const Expanded(
                      child: Text('连接诊断', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                    ),
                    TextButton(onPressed: () => setState(() => _logs.clear()), child: const Text('清空')),
                    TextButton(onPressed: () => Navigator.of(sheetContext).pop(), child: const Text('关闭')),
                  ],
                ),
                Text('URL: ${_currentUrl.isEmpty ? '-' : _currentUrl}'),
                Text('设备: ${widget.deviceName} / ${widget.deviceId}'),
                const SizedBox(height: 8),
                const Text('网络请求 / 网页日志（不包含 token 与请求体）'),
                const SizedBox(height: 8),
                Expanded(
                  child: Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: [..._netLogs.map(_formatNetLine), ..._logs].isEmpty
                        ? const Center(child: Text('暂无日志'))
                        : ListView.builder(
                            itemCount: [..._netLogs.map(_formatNetLine), ..._logs].length,
                            itemBuilder: (_, index) => Text(
                              [..._netLogs.map(_formatNetLine), ..._logs][index],
                              style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
                            ),
                          ),
                  ),
                ),
                const SizedBox(height: 8),
                FilledButton(
                  onPressed: () async {
                    setState(() => _logs.clear());
                    await _adapter.reload();
                  },
                  child: const Text('重新加载页面'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        await _handleBack();
      },
      child: Scaffold(
        appBar: AppBar(
          leading: IconButton(
            key: const Key('back-to-devices-button'),
            tooltip: '返回设备列表',
            icon: const Icon(Icons.arrow_back),
            onPressed: () => Navigator.of(context).pop(),
          ),
          title: Text(widget.deviceName),
          actions: [
            if (kDebugUi)
              IconButton(
              key: const Key('diagnostics-button'),
              tooltip: '诊断',
              onPressed: _showDiagnostics,
              icon: const Icon(Icons.bug_report_outlined),
            ),
            IconButton(
              key: const Key('reload-button'),
              tooltip: '刷新',
              onPressed: () async {
                await _adapter.reload();
              },
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        body: SafeArea(
          top: false,
          bottom: true,
          child: Stack(
            children: [
              if (_initialized) _adapter.buildView(),
            if (!_pageReady && _error == null) const Center(child: CircularProgressIndicator()),
            if (_error != null)
              ColoredBox(
                color: DshTheme.bg,
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.cloud_off_outlined, size: 42, color: DshTheme.fgDim),
                        const SizedBox(height: 16),
                        const Text(
                          '无法打开 DSH',
                          style: TextStyle(color: DshTheme.fg, fontSize: 17, fontWeight: FontWeight.w600),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          '$_error',
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: DshTheme.fgDim, fontSize: 13, height: 1.5),
                        ),
                        const SizedBox(height: 22),
                        SizedBox(
                          width: 160,
                          height: 46,
                          child: FilledButton(
                            key: const Key('retry-button'),
                            onPressed: () async {
                              setState(() => _error = null);
                              await _adapter.reload();
                            },
                            child: const Text('重试'),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  void dispose() {
    _adapter.dispose();
    super.dispose();
  }
}


