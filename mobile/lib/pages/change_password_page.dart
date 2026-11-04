import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// 修改密码独立页：这里只负责表单与校验，成功后返回 `true`，由设置页负责登出。
class ChangePasswordPage extends StatefulWidget {
  const ChangePasswordPage({
    super.key,
    required this.api,
    required this.accessToken,
  });

  final ApiClient api;
  final String accessToken;

  @override
  State<ChangePasswordPage> createState() => _ChangePasswordPageState();
}

class _ChangePasswordPageState extends State<ChangePasswordPage> {
  final _oldController = TextEditingController();
  final _newController = TextEditingController();
  final _confirmController = TextEditingController();
  bool _submitting = false;
  bool _obscure = true;
  String? _error;

  @override
  void dispose() {
    _oldController.dispose();
    _newController.dispose();
    _confirmController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final oldPassword = _oldController.text;
    final newPassword = _newController.text;
    final confirm = _confirmController.text;
    if (oldPassword.isEmpty || newPassword.isEmpty || confirm.isEmpty) {
      setState(() => _error = '请填写旧密码、新密码与确认密码');
      return;
    }
    if (newPassword.length < 10) {
      setState(() => _error = '新密码至少 10 位，且不能是常见弱口令');
      return;
    }
    if (newPassword != confirm) {
      setState(() => _error = '两次输入的新密码不一致');
      return;
    }
    if (newPassword == oldPassword) {
      setState(() => _error = '新密码不能与旧密码相同');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await widget.api.changePassword(widget.accessToken, oldPassword, newPassword);
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = error.message;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = '修改密码失败：$error';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('修改密码')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                '修改后需要使用新密码重新登录。',
                style: TextStyle(color: DshTheme.fgDim, fontSize: 13, height: 1.5),
              ),
              const SizedBox(height: 20),
              TextField(
                key: const Key('old-password-field'),
                controller: _oldController,
                obscureText: _obscure,
                style: const TextStyle(color: DshTheme.fg),
                decoration: const InputDecoration(
                  hintText: '旧密码',
                  prefixIcon: Icon(Icons.lock_outline, size: 20),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('new-password-field'),
                controller: _newController,
                obscureText: _obscure,
                style: const TextStyle(color: DshTheme.fg),
                decoration: InputDecoration(
                  hintText: '新密码（至少 10 位）',
                  prefixIcon: const Icon(Icons.lock_reset, size: 20),
                  suffixIcon: IconButton(
                    onPressed: () => setState(() => _obscure = !_obscure),
                    icon: Icon(_obscure ? Icons.visibility_off_outlined : Icons.visibility_outlined, size: 20),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('confirm-password-field'),
                controller: _confirmController,
                obscureText: _obscure,
                style: const TextStyle(color: DshTheme.fg),
                decoration: const InputDecoration(
                  hintText: '确认新密码',
                  prefixIcon: Icon(Icons.lock_reset, size: 20),
                ),
                onSubmitted: (_) => _submit(),
              ),
              if (_error != null) ...[
                const SizedBox(height: 14),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.error_outline, color: DshTheme.danger, size: 16),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(_error!, style: const TextStyle(color: DshTheme.danger, fontSize: 13, height: 1.45)),
                    ),
                  ],
                ),
              ],
              const SizedBox(height: 26),
              SizedBox(
                height: 50,
                child: FilledButton(
                  key: const Key('change-password-submit'),
                  onPressed: _submitting ? null : _submit,
                  child: _submitting
                      ? const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(strokeWidth: 2, color: DshTheme.fgDim),
                        )
                      : const Text('确认修改'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
