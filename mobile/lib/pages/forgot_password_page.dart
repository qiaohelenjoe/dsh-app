import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// 找回密码：三步页（邮箱 → 验证码 → 新密码），与 App 其它页面风格一致。
/// 成功后返回 true，由登录页提示"密码已重置，请用新密码登录"。
class ForgotPasswordPage extends StatefulWidget {
  const ForgotPasswordPage({
    super.key,
    required this.api,
    this.initialEmail = '',
  });

  final ApiClient api;
  final String initialEmail;

  @override
  State<ForgotPasswordPage> createState() => _ForgotPasswordPageState();
}

class _ForgotPasswordPageState extends State<ForgotPasswordPage> {
  late final TextEditingController _emailController = TextEditingController(text: widget.initialEmail);
  final _codeController = TextEditingController();
  final _passwordController = TextEditingController();
  final _confirmController = TextEditingController();

  int _step = 1; // 1=邮箱, 2=验证码, 3=新密码
  bool _busy = false;
  String? _error;
  String? _hint;
  String _resetToken = '';

  @override
  void dispose() {
    _emailController.dispose();
    _codeController.dispose();
    _passwordController.dispose();
    _confirmController.dispose();
    super.dispose();
  }

  Future<void> _sendCode() async {
    final email = _emailController.text.trim();
    if (email.isEmpty) {
      setState(() => _error = '请输入邮箱');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _hint = null;
    });
    try {
      await widget.api.forgotPassword(email);
      if (!mounted) return;
      setState(() {
        _step = 2;
        _hint = '若邮箱存在，验证码已发送，请查收邮件（10 分钟内有效）';
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = '发送失败：$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verifyCode() async {
    final code = _codeController.text.trim();
    if (!RegExp(r'^\d{6}$').hasMatch(code)) {
      setState(() => _error = '请输入 6 位数字验证码');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final token = await widget.api.verifyResetCode(_emailController.text.trim(), code);
      if (!mounted) return;
      setState(() {
        _resetToken = token;
        _step = 3;
        _hint = null;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = '校验失败：$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _savePassword() async {
    final password = _passwordController.text;
    if (password.length < 10) {
      setState(() => _error = '密码至少 10 位，且不能是常见弱口令');
      return;
    }
    if (password != _confirmController.text) {
      setState(() => _error = '两次输入的新密码不一致');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.resetPassword(_resetToken, password);
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = '保存失败：$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String get _stepTitle => switch (_step) {
        1 => '第 1 步 / 3：输入注册邮箱',
        2 => '第 2 步 / 3：输入邮件验证码',
        _ => '第 3 步 / 3：设置新密码',
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: DshTheme.bg,
      appBar: AppBar(
        backgroundColor: DshTheme.bg,
        foregroundColor: DshTheme.fg,
        elevation: 0,
        title: const Text('找回密码', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 28),
          children: [
            Text(_stepTitle, style: const TextStyle(color: DshTheme.fgDim, fontSize: 13)),
            const SizedBox(height: 18),
            if (_step == 1) ...[
              _field(
                controller: _emailController,
                hint: '注册邮箱',
                icon: Icons.alternate_email,
                keyboardType: TextInputType.emailAddress,
              ),
              const SizedBox(height: 20),
              _primary('发送验证码', _sendCode),
            ],
            if (_step == 2) ...[
              _field(
                controller: _codeController,
                hint: '6 位验证码',
                icon: Icons.password_outlined,
                keyboardType: TextInputType.number,
                maxLength: 6,
              ),
              const SizedBox(height: 20),
              _primary('下一步', _verifyCode),
              const SizedBox(height: 6),
              Center(
                child: TextButton(
                  onPressed: _busy ? null : () => setState(() => _step = 1),
                  child: const Text('重新发送验证码'),
                ),
              ),
            ],
            if (_step == 3) ...[
              _field(
                controller: _passwordController,
                hint: '新密码（至少 10 位）',
                icon: Icons.lock_outline,
                obscure: true,
              ),
              const SizedBox(height: 12),
              _field(
                controller: _confirmController,
                hint: '确认新密码',
                icon: Icons.lock_reset,
                obscure: true,
              ),
              const SizedBox(height: 20),
              _primary('保存并返回登录', _savePassword),
            ],
            if (_hint != null) ...[
              const SizedBox(height: 16),
              Text(_hint!, style: const TextStyle(color: DshTheme.fgDim, fontSize: 12, height: 1.5)),
            ],
            if (_error != null) ...[
              const SizedBox(height: 16),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.error_outline, color: DshTheme.danger, size: 16),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _error!,
                      style: const TextStyle(color: DshTheme.danger, fontSize: 13, height: 1.45),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _field({
    required TextEditingController controller,
    required String hint,
    required IconData icon,
    TextInputType? keyboardType,
    bool obscure = false,
    int? maxLength,
  }) {
    return TextField(
      controller: controller,
      keyboardType: keyboardType,
      obscureText: obscure,
      maxLength: maxLength,
      style: const TextStyle(color: DshTheme.fg),
      decoration: InputDecoration(
        hintText: hint,
        counterText: '',
        prefixIcon: Icon(icon, size: 20),
      ),
    );
  }

  Widget _primary(String label, Future<void> Function() action) {
    return SizedBox(
      height: 50,
      child: FilledButton(
        onPressed: _busy ? null : action,
        child: _busy
            ? const SizedBox(
                height: 20,
                width: 20,
                child: CircularProgressIndicator(strokeWidth: 2, color: DshTheme.fgDim),
              )
            : Text(label),
      ),
    );
  }
}
