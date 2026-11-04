import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'app_version.dart';

/// 测试包（--dart-define=DSH_DEBUG_UI=true）显示诊断入口并上传全量日志；
/// 生产包只上传 warn/error。
const bool kDebugUi = bool.fromEnvironment('DSH_DEBUG_UI');

/// 移动端日志中心：环形缓冲 + 批量上传服务端。
class AppLogger {
  AppLogger._();

  static final AppLogger instance = AppLogger._();

  final List<Map<String, dynamic>> _buffer = <Map<String, dynamic>>[];
  ApiClient? _api;
  String? _accessToken;
  Timer? _timer;
  bool _flushing = false;

  void install() {
    if (_timer != null) return;
    _timer = Timer.periodic(const Duration(seconds: 60), (_) {
      if (_buffer.isNotEmpty) unawaited(flush());
    });
    FlutterError.onError = (details) {
      log('error', 'flutter_error', details.exceptionAsString(), {
        'library': details.library,
      });
      FlutterError.presentError(details);
    };
  }

  void configure({required ApiClient api, required String? accessToken}) {
    _api = api;
    _accessToken = accessToken;
  }

  bool _accepts(String level) {
    if (kDebugUi) return true;
    return level == 'warn' || level == 'error';
  }

  void log(String level, String event, String message, [Map<String, dynamic>? context]) {
    if (!_accepts(level)) return;
    final entry = <String, dynamic>{
      'level': level,
      'event': event,
      'message': _redact(message),
      if (context != null) 'context': _redactContext(context),
    };
    _buffer.add(entry);
    if (_buffer.length > 500) _buffer.removeAt(0);
    if (level == 'error') unawaited(flush());
  }

  String _redact(String value) {
    return value
        .replaceAll(RegExp(r'([?&](token|access_token|refresh_token)=)[^&\s]*'), r'$1***')
        .replaceAll(RegExp(r'(token|cookie|authorization|password|secret)\s*[:=]\s*\S+', caseSensitive: false), r'$1=***')
        .trim();
  }

  Map<String, dynamic> _redactContext(Map<String, dynamic> context) {
    final result = <String, dynamic>{};
    context.forEach((key, value) {
      if (RegExp(r'token|cookie|authorization|password|secret', caseSensitive: false).hasMatch(key)) return;
      if (value is String) {
        result[key] = _redact(value).length > 512 ? _redact(value).substring(0, 512) : _redact(value);
      } else if (value is num || value is bool || value == null) {
        result[key] = value;
      }
    });
    return result;
  }

  Future<void> flush() async {
    if (_flushing) return;
    final api = _api;
    final token = _accessToken;
    if (api == null || token == null || _buffer.isEmpty) return;
    _flushing = true;
    final batch = _buffer.take(50).toList(growable: false);
    try {
      await api.uploadLogs(token, batch, appVersion: kAppVersion, platform: Platform.operatingSystem);
      _buffer.removeRange(0, batch.length);
    } catch (_) {
      // 网络失败保留日志，等下次重试
      while (_buffer.length > 300) {
        _buffer.removeAt(0);
      }
    } finally {
      _flushing = false;
    }
  }

  List<Map<String, dynamic>> snapshot() => List<Map<String, dynamic>>.unmodifiable(_buffer);

  void dispose() {
    _timer?.cancel();
    _timer = null;
  }
}
