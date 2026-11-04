import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../api.dart';
import '../session_store.dart';
import '../theme.dart';

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
  });

  final ApiClient api;
  final Session session;
  final SessionStore store;
  final void Function(DeviceInfo device, Session session) onOpenDevice;
  final void Function(Session session) onSessionRefreshed;
  final void Function(Session session) onOpenSettings;

  @override
  State<DevicesPage> createState() => _DevicesPageState();
}

class _DevicesPageState extends State<DevicesPage> {
  late Session _session = widget.session;
  List<DeviceInfo> _devices = const [];
  bool _loading = true;
  String? _error;
  Timer? _pollTimer;

  @override
  void initState() {
    super.initState();
    _load();
    // 设备在线状态由桌面隧道心跳决定，进入列表后定期刷新，避免展示过期状态
    _pollTimer = Timer.periodic(const Duration(seconds: 15), (_) {
      if (!_loading) _load();
    });
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  Future<void> _load({bool retryOn401 = true}) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final all = await widget.api.listDevices(_session.accessToken);
      final devices = all.where((device) => device.kind == 'desktop').toList();
      if (!mounted) return;
      setState(() {
        _devices = devices;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.statusCode == 401 && retryOn401) {
        final refreshed = await _refreshSession();
        if (refreshed) return _load(retryOn401: false);
      }
      setState(() {
        _error = error.message;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = '加载设备失败：$error';
        _loading = false;
      });
    }
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
    // 列表可能是旧快照（隧道刚重连）：先刷新一次再判断
    await _load();
    if (!mounted) return;
    DeviceInfo? fresh;
    for (final item in _devices) {
      if (item.id == device.id) {
        fresh = item;
        break;
      }
    }
    if (fresh != null && fresh.online) {
      widget.onOpenDevice(fresh, _session);
      return;
    }
    _showMessage('${device.name} 当前离线，请确认电脑已开机');
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
                          device.name,
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
        onRefresh: () => _load(),
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
        children: [
          const SizedBox(height: 8),
          const Padding(
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
                      device.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: DshTheme.fg, fontSize: 15, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      '${device.platformLabel} · 电脑',
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
