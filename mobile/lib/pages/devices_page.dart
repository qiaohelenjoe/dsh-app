import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../session_store.dart';
import '../theme.dart';

/// 设备标题：非本机（非手机自身）在名字后用括号显示计算机名称；老设备未上报时只显示名字。
String _deviceTitle(DeviceInfo device) {
  final machine = (device.machineName ?? '').trim();
  if (machine.isEmpty) return device.name;
  return '${device.name}（${machine.toUpperCase()}）';
}


/// 设备列表：在线优先（服务端已排序），显示平台图标与在线徽标；离线设备给出提示。
/// 长按设备可重命名或撤销；AppBar 设置入口统一承载账号与登出。
class DevicesPage extends StatefulWidget {
  const DevicesPage({
    super.key,
    required this.api,
    required this.session,
    required this.store,
    required this.onOpenDevice,
    required this.onSessionRefreshed,
    required this.onOpenSettings,
    this.onSessionExpired,
  });

  final ApiClient api;
  final Session session;
  final SessionStore store;
  final void Function(DeviceInfo device, Session session) onOpenDevice;
  final void Function(Session session) onSessionRefreshed;
  final void Function(Session session) onOpenSettings;

  /// 会话被服务端判定失效（刷新也失败）时的回调：清会话直接回登录页。
  final Future<void> Function()? onSessionExpired;

  @override
  State<DevicesPage> createState() => _DevicesPageState();
}

class _DevicesPageState extends State<DevicesPage> with WidgetsBindingObserver {
  late Session _session = widget.session;
  List<DeviceInfo> _devices = const [];
  bool _loading = true;
  String? _error;
  Timer? _pollTimer;
  bool _retrying = false;
  AppLifecycleState _lifecycle = AppLifecycleState.resumed;

  /// 前台 10 秒、后台 30 秒：前台更实时，后台省电。
  Duration get _pollInterval =>
      _lifecycle == AppLifecycleState.resumed ? const Duration(seconds: 10) : const Duration(seconds: 30);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
    _startPolling();
  }

  void _startPolling() {
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(_pollInterval, (_) {
      if (!_loading) _load(silent: true);
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == _lifecycle) return;
    _lifecycle = state;
    _startPolling();
    if (state == AppLifecycleState.resumed && !_loading) _load(silent: true);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _pollTimer?.cancel();
    super.dispose();
  }

  /// 静默刷新：定时轮询不显示转圈、数据没变不重建列表（与桌面面板一致）。
  Future<void> _load({bool retryOn401 = true, bool silent = false}) async {
    if (!silent) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final all = await widget.api.listDevices(_session.accessToken);
      final devices = all.where((device) => device.kind == 'desktop').toList()
        ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
      if (!mounted) return;
      // 静默刷新且数据没变：完全不触发重建
      if (silent && _sameDevices(_devices, devices) && _error == null) return;
      setState(() {
        _devices = devices;
        _loading = false;
        _error = null;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.statusCode == 401 && retryOn401) {
        final refreshed = await _refreshSession();
        if (refreshed) return _load(retryOn401: false, silent: silent);
        // 刷新也失败：会话已失效，直接回登录页（不提示、不需要用户点退出）
        await widget.onSessionExpired?.call();
        return;
      }
      if (silent && _devices.isNotEmpty) return;
      setState(() {
        _error = error.message;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      // 静默刷新失败：保留当前列表，不打断用户
      if (silent && _devices.isNotEmpty) return;
      setState(() {
        // 区分手机自身网络异常与设备离线：网络异常保留刚才的列表，等症状消失自动恢复
        _error = '网络异常，正在自动重试…';
        _loading = false;
      });
    }
  }

  /// 判断两次拉取的设备列表是否等价（id/名称/电脑名/平台/在线/最后在线）。
  bool _sameDevices(List<DeviceInfo> a, List<DeviceInfo> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i += 1) {
      final x = a[i];
      final y = b[i];
      if (x.id != y.id ||
          x.name != y.name ||
          x.platform != y.platform ||
          x.online != y.online ||
          x.machineName != y.machineName ||
          x.lastSeenAt?.toIso8601String() != y.lastSeenAt?.toIso8601String()) {
        return false;
      }
    }
    return true;
  }

  Future<bool> _refreshSession() async {
    try {
      final refreshed = await widget.api.refresh(_session.refreshToken);
      final next = Session(
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        accountEmail: _session.accountEmail,
      );
      await widget.store.saveSession(next);
      if (!mounted) return false;
      setState(() => _session = next);
      widget.onSessionRefreshed(next);
      return true;
    } catch (_) {
      return false;
    }
  }

  /// 401 时刷新一次会话并重试，其它错误原样抛出。
  Future<T> _withRefresh<T>(Future<T> Function() action) async {
    try {
      return await action();
    } on ApiException catch (error) {
      if (error.statusCode != 401) rethrow;
      final refreshed = await _refreshSession();
      if (!refreshed) rethrow;
      return action();
    }
  }

  Future<void> _openDevice(DeviceInfo device) async {
    if (device.online) {
      widget.onOpenDevice(device, _session);
      return;
    }
    if (_retrying) return;
    // 列表可能是旧快照（隧道刚重连）：先刷新一次再判断
    await _load(silent: true);
    if (!mounted) return;
    DeviceInfo? fresh = _findDevice(device.id);
    if (fresh != null && fresh.online) {
      widget.onOpenDevice(fresh, _session);
      return;
    }
    // 网络抖动时隧道可能几秒内恢复：自动重试最多约 20 秒，避免用户看到"离线"就直接放弃
    _retrying = true;
    _showMessage('${device.name} 当前离线，正在尝试连接…');
    try {
      for (var attempt = 0; attempt < 6; attempt += 1) {
        await Future<void>.delayed(const Duration(seconds: 3));
        if (!mounted) return;
        await _load(silent: true);
        if (!mounted) return;
        fresh = _findDevice(device.id);
        if (fresh != null && fresh.online) {
          widget.onOpenDevice(fresh, _session);
          return;
        }
      }
      if (!mounted) return;
      _showMessage('${device.name} 仍处于离线，请确认电脑网络与 DSH 是否正常');
    } finally {
      _retrying = false;
    }
  }

  DeviceInfo? _findDevice(String id) {
    for (final item in _devices) {
      if (item.id == id) return item;
    }
    return null;
  }


  Future<void> _showDeviceMenu(DeviceInfo device) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: DshTheme.bg,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 10, bottom: 2),
              child: Container(
                width: 36,
                height: 4,
                decoration: BoxDecoration(color: DshTheme.line, borderRadius: BorderRadius.circular(2)),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
              child: Row(
                children: [
                  Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(color: DshTheme.panel, borderRadius: BorderRadius.circular(10)),
                    child: Icon(_platformIcon(device.platform), size: 20, color: DshTheme.fg),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _deviceTitle(device),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(color: DshTheme.fg, fontSize: 15, fontWeight: FontWeight.w600),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          '${device.platformLabel} · ${device.online ? '在线' : '离线'}',
                          style: const TextStyle(color: DshTheme.fgDim, fontSize: 12),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            ListTile(
              key: const Key('rename-device-action'),
              leading: const Icon(Icons.edit_outlined, size: 20),
              title: const Text('重命名', style: TextStyle(fontSize: 15)),
              onTap: () => Navigator.of(sheetContext).pop('rename'),
            ),
            ListTile(
              key: const Key('revoke-device-action'),
              leading: const Icon(Icons.delete_outline, size: 20, color: DshTheme.danger),
              title: const Text('撤销设备', style: TextStyle(fontSize: 15, color: DshTheme.danger)),
              onTap: () => Navigator.of(sheetContext).pop('revoke'),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (!mounted) return;
    if (action == 'rename') await _renameDevice(device);
    if (action == 'revoke') await _revokeDevice(device);
  }

  Future<void> _renameDevice(DeviceInfo device) async {
    final name = await showDialog<String>(
      context: context,
      builder: (_) => _RenameDialog(initialName: device.name),
    );
    if (name == null || !mounted) return;
    final trimmed = name.trim();
    if (trimmed.isEmpty) {
      _showMessage('设备名称不能为空');
      return;
    }
    try {
      final renamed = await _withRefresh(
        () => widget.api.renameDevice(_session.accessToken, device.id, trimmed),
      );
      if (!mounted) return;
      setState(() {
        _devices = [
          for (final item in _devices) item.id == device.id ? renamed : item,
        ];
      });
      _showMessage('已重命名为 ${renamed.name}');
    } on ApiException catch (error) {
      if (mounted) _showMessage(error.message);
    } catch (error) {
      if (mounted) _showMessage('重命名失败：$error');
    }
  }

  Future<void> _revokeDevice(DeviceInfo device) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: DshTheme.bg,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Text('撤销设备'),
        content: Text('撤销「${device.name}」后，该设备的访问与隧道将立即失效，确定继续？'),
        actions: [
          TextButton(
            key: const Key('revoke-cancel'),
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            key: const Key('revoke-confirm'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('撤销'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await _withRefresh(
        () => widget.api.revokeDevice(_session.accessToken, device.id),
      );
      final wasCurrent = await widget.store.lastDeviceId() == device.id;
      if (wasCurrent) await widget.store.clearLastDevice();
      if (!mounted) return;
      setState(() {
        _devices = _devices.where((item) => item.id != device.id).toList();
      });
      _showMessage(
        wasCurrent
            ? '已撤销 ${device.name}；该设备是当前打开的设备，请重新选择'
            : '已撤销 ${device.name}',
      );
    } on ApiException catch (error) {
      if (mounted) _showMessage(error.message);
    } catch (error) {
      if (mounted) _showMessage('撤销失败：$error');
    }
  }

  void _showMessage(String message) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  IconData _platformIcon(String platform) {
    switch (platform) {
      case 'android':
      case 'ios':
      case 'harmony':
        return Icons.phone_iphone;
      default:
        return Icons.desktop_windows;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('我的设备'),
        actions: [
          IconButton(
            key: const Key('settings-button'),
            tooltip: '设置',
            onPressed: () => widget.onOpenSettings(_session),
            icon: const Icon(Icons.settings_outlined, size: 22),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => _load(silent: true),
        child: _buildBody(context),
      ),
    );
  }

  Widget _buildBody(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return ListView(
        children: [
          Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              children: [
                Text(_error!, textAlign: TextAlign.center),
                const SizedBox(height: 16),
                FilledButton(onPressed: () => _load(), child: const Text('重试')),
              ],
            ),
          ),
        ],
      );
    }
    if (_devices.isEmpty) {
      return ListView(
        children: const [
          SizedBox(height: 8),
          Padding(
            padding: EdgeInsets.fromLTRB(20, 64, 20, 0),
            child: Column(
              children: [
                Icon(Icons.desktop_windows_outlined, size: 44, color: DshTheme.fgDim),
                SizedBox(height: 14),
                Text('还没有电脑接入', style: TextStyle(color: DshTheme.fg, fontSize: 15, fontWeight: FontWeight.w600)),
                SizedBox(height: 6),
                Text(
                  '请在电脑上登录 DSH 并开启「允许手机控制」',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: DshTheme.fgDim, fontSize: 13, height: 1.5),
                ),
              ],
            ),
          ),
        ],
      );
    }
    return ListView(
      padding: EdgeInsets.fromLTRB(16, 0, 16, 28 + MediaQuery.of(context).padding.bottom),
      children: [
        const SizedBox(height: 6),
        for (final device in _devices)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: _DeviceCard(
              key: Key('device-${device.id}'),
              device: device,
              icon: _platformIcon(device.platform),
              onTap: () => _openDevice(device),
              onLongPress: () => _showDeviceMenu(device),
            ),
          ),
        const SizedBox(height: 10),
        const Center(
          child: Text('长按设备可重命名或移除', style: TextStyle(color: DshTheme.fgDim, fontSize: 12)),
        ),
      ],
    );
  }
}

/// 离线时显示「最后在线 x 分钟前」，比单纯「离线」更有信息量。
String? _lastSeenText(DeviceInfo device) {
  if (device.online) return null;
  final lastSeen = device.lastSeenAt;
  if (lastSeen == null) return null;
  final diff = DateTime.now().difference(lastSeen);
  if (diff.inMinutes < 1) return '最后在线 刚刚';
  if (diff.inHours < 1) return '最后在线 ${diff.inMinutes} 分钟前';
  if (diff.inDays < 1) return '最后在线 ${diff.inHours} 小时前';
  return '最后在线 ${diff.inDays} 天前';
}

/// 单台设备卡片：描边圆角卡，在线用绿点、离线用灰点。
class _DeviceCard extends StatelessWidget {
  const _DeviceCard({
    super.key,
    required this.device,
    required this.icon,
    required this.onTap,
    required this.onLongPress,
  });

  final DeviceInfo device;
  final IconData icon;
  final VoidCallback onTap;
  final VoidCallback onLongPress;

  @override
  Widget build(BuildContext context) {
    final online = device.online;
    return Material(
      color: DshTheme.bg,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        onLongPress: onLongPress,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: DshTheme.line),
          ),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(color: DshTheme.panel, borderRadius: BorderRadius.circular(10)),
                child: Icon(icon, size: 20, color: DshTheme.fg),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _deviceTitle(device),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: DshTheme.fg, fontSize: 15, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      [
                        device.platformLabel,
                        '电脑',
                        if (_lastSeenText(device) != null) _lastSeenText(device)!,
                      ].join(' · '),
                      style: const TextStyle(color: DshTheme.fgDim, fontSize: 12),
                    ),
                  ],
                ),
              ),
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: online ? const Color(0xFF22C55E) : const Color(0xFFC7CBD1),
                ),
              ),
              const SizedBox(width: 6),
              Text(
                online ? '在线' : '离线',
                style: TextStyle(color: online ? const Color(0xFF16A34A) : DshTheme.fgDim, fontSize: 12),
              ),
              const SizedBox(width: 4),
              const Icon(Icons.chevron_right, size: 18, color: DshTheme.fgDim),
            ],
          ),
        ),
      ),
    );
  }
}

/// 重命名对话框：自己持有控制器，避免关闭动画期间控制器已被释放。
class _RenameDialog extends StatefulWidget {
  const _RenameDialog({required this.initialName});

  final String initialName;

  @override
  State<_RenameDialog> createState() => _RenameDialogState();
}

class _RenameDialogState extends State<_RenameDialog> {
  late final TextEditingController _controller =
      TextEditingController(text: widget.initialName);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: DshTheme.bg,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      title: const Text('重命名设备'),
      content: TextField(
        key: const Key('rename-field'),
        controller: _controller,
        autofocus: true,
        maxLength: 64,
        decoration: const InputDecoration(labelText: '设备名称'),
      ),
      actions: [
        TextButton(
          key: const Key('rename-cancel'),
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          key: const Key('rename-save'),
          onPressed: () => Navigator.of(context).pop(_controller.text),
          child: const Text('保存'),
        ),
      ],
    );
  }
}
