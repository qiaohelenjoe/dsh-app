import 'package:flutter/material.dart';

import '../api.dart';
import '../app_version.dart';
import '../theme.dart';
import 'change_password_page.dart';
import '../session_store.dart';

/// 设置页：账号信息与配额、修改密码、登出、版本号。
class SettingsPage extends StatefulWidget {
  const SettingsPage({
    super.key,
    required this.api,
    required this.session,
    required this.store,
    required this.onLogout,
    required this.onSessionRefreshed,
    this.appVersion = kAppVersion,
  });

  final ApiClient api;
  final Session session;
  final SessionStore store;
  final VoidCallback onLogout;
  final void Function(Session session) onSessionRefreshed;
  final String appVersion;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  late Session _session = widget.session;
  AccountInfo? _account;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    super.dispose();
  }

  Future<void> _load({bool retryOn401 = true}) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final account = await widget.api.account(_session.accessToken);
      if (!mounted) return;
      setState(() {
        _account = account;
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
        _error = '加载账号信息失败：$error';
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

  Future<void> _openChangePassword() async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(
        builder: (_) => ChangePasswordPage(api: widget.api, accessToken: _session.accessToken),
      ),
    );
    if (changed == true && mounted) {
      _showMessage('密码已修改，请重新登录');
      await _logout();
    }
  }

  Future<void> _logout() async {
    try {
      await widget.api.logout(_session.refreshToken);
    } catch (_) {
      // 登出网络错误不阻塞本地清理
    }
    await widget.store.clear();
    if (!mounted) return;
    widget.onLogout();
    Navigator.of(context).popUntil((route) => route.isFirst);
  }

  void _showMessage(String message) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  String _formatDateTime(DateTime? value) {
    if (value == null) return '未知';
    final local = value.toLocal();
    String two(int number) => number.toString().padLeft(2, '0');
    return '${local.year}-${two(local.month)}-${two(local.day)} ${two(local.hour)}:${two(local.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('设置'), centerTitle: false),
      body: _buildBody(context),
    );
  }

  Widget _buildBody(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(_error!, textAlign: TextAlign.center),
              const SizedBox(height: 16),
              FilledButton(
                key: const Key('settings-retry'),
                onPressed: () => _load(),
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      );
    }
    final account = _account!;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 32),
      children: [
        _AccountHeader(account: account),
        const SizedBox(height: 22),
        const _SectionLabel('账号'),
        _SettingsCard(
          children: [
            _InfoRow(label: '邮箱', value: account.email),
            _InfoRow(label: '显示名', value: account.displayName ?? '未设置'),
            _InfoRow(label: '注册时间', value: _formatDateTime(account.createdAt)),
            _InfoRow(
              label: '设备配额',
              value: '桌面 ${account.desktopUsed}/${account.desktopLimit} · 移动 ${account.mobileUsed}/${account.mobileLimit}',
            ),
          ],
        ),
        const SizedBox(height: 22),
        const _SectionLabel('安全'),
        _SettingsCard(
          children: [
            _ActionRow(
              key: const Key('change-password-button'),
              icon: Icons.lock_outline,
              label: '修改密码',
              onTap: _openChangePassword,
            ),
          ],
        ),
        const SizedBox(height: 22),
        const _SectionLabel('关于'),
        _SettingsCard(
          children: [
            _InfoRow(key: const Key('app-version'), label: '版本', value: 'v${widget.appVersion}'),
          ],
        ),
        const SizedBox(height: 26),
        SizedBox(
          height: 48,
          child: OutlinedButton(
            key: const Key('logout-button'),
            onPressed: _logout,
            style: OutlinedButton.styleFrom(
              foregroundColor: DshTheme.danger,
              side: const BorderSide(color: DshTheme.danger),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            child: const Text('退出登录'),
          ),
        ),
      ],
    );
  }
}

/// 账号头卡：黑底白图标头像 + 显示名 + 邮箱。
class _AccountHeader extends StatelessWidget {
  const _AccountHeader({required this.account});

  final AccountInfo account;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: DshTheme.panel,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: DshTheme.line),
      ),
      child: Row(
        children: [
          Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(color: DshTheme.fg, borderRadius: BorderRadius.circular(14)),
            child: const Icon(Icons.person_outline, color: DshTheme.bg, size: 24),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  account.displayName ?? 'DSH 用户',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: DshTheme.fg, fontSize: 16, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 4),
                const Text(
                  '已登录',
                  style: TextStyle(color: DshTheme.fgDim, fontSize: 12),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// 分组标签：左侧小字，上下留白由调用方控制。
class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: 4, bottom: 8),
      child: Text(
        text,
        style: const TextStyle(color: DshTheme.fgDim, fontSize: 12, fontWeight: FontWeight.w600, letterSpacing: .3),
      ),
    );
  }
}

/// 白底描边卡片，内部行由 divider 分隔。
class _SettingsCard extends StatelessWidget {
  const _SettingsCard({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[];
    for (var i = 0; i < children.length; i++) {
      if (i > 0) rows.add(const Divider(height: 1, indent: 16, endIndent: 16));
      rows.add(children[i]);
    }
    return Container(
      decoration: BoxDecoration(
        color: DshTheme.bg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: DshTheme.line),
      ),
      child: Column(children: rows),
    );
  }
}

/// 只读信息行：左标签、右值。
class _InfoRow extends StatelessWidget {
  const _InfoRow({super.key, required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(color: DshTheme.fg, fontSize: 14)),
          const SizedBox(width: 16),
          Expanded(
            child: Text(
              value,
              textAlign: TextAlign.right,
              style: const TextStyle(color: DshTheme.fgDim, fontSize: 13, height: 1.4),
            ),
          ),
        ],
      ),
    );
  }
}

/// 可点击行：图标 + 标签 + 右箭头。
class _ActionRow extends StatelessWidget {
  const _ActionRow({super.key, required this.icon, required this.label, required this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: [
            Icon(icon, size: 20, color: DshTheme.fg),
            const SizedBox(width: 12),
            Expanded(child: Text(label, style: const TextStyle(color: DshTheme.fg, fontSize: 14))),
            const Icon(Icons.chevron_right, size: 18, color: DshTheme.fgDim),
          ],
        ),
      ),
    );
  }
}
