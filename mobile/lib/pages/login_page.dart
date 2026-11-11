import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../api.dart';
import '../theme.dart';
import 'forgot_password_page.dart';

/// 登录/注册页：邮箱 + 密码；注册成功后自动登录并进入设备列表。
class LoginPage extends StatefulWidget {
  const LoginPage({
    super.key,
    required this.api,
    required this.onLoggedIn,
    this.deviceName = '手机',
    this.platform = 'android',
  });

  final ApiClient api;
  final void Function(Session session) onLoggedIn;
  final String deviceName;
  final String platform;

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  final _confirmController = TextEditingController();
  bool _loading = false;
  bool _registerMode = false;
  String? _error;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    _confirmController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final email = _emailController.text.trim();
    final password = _passwordController.text;
    if (email.isEmpty || password.isEmpty) {
      setState(() => _error = '请输入邮箱和密码');
      return;
    }
    if (_registerMode) {
      if (password.length < 10) {
        setState(() => _error = '密码至少 10 位，且不能是常见弱口令');
        return;
      }
      if (password != _confirmController.text) {
        setState(() => _error = '两次输入的密码不一致');
        return;
      }
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      if (_registerMode) {
        await widget.api.register(email: email, password: password);
      }
      final session = await widget.api.login(
        email: email,
        password: password,
        deviceName: widget.deviceName,
        platform: widget.platform,
      );
      if (!mounted) return;
      widget.onLoggedIn(session);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = '${_registerMode ? '注册' : '登录'}失败：$error');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _toggleMode() {
    setState(() {
      _registerMode = !_registerMode;
      _error = null;
      _confirmController.clear();
    });
  }

  /// 忘记密码：进入三步页（邮箱 → 验证码 → 新密码），成功后回到登录页提示用新密码登录。
  Future<void> _forgotPassword() async {
    final done = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => ForgotPasswordPage(
          api: widget.api,
          initialEmail: _emailController.text.trim(),
        ),
      ),
    );
    if (done == true && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('密码已重置，请用新密码登录')),
      );
    }
  }

  bool _obscurePassword = true;

  @override
  Widget build(BuildContext context) {
    final action = _registerMode ? '注册' : '登录';
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      SizedBox(
                        width: 32,
                        height: 32,
                        child: Transform.translate(
                          offset: const Offset(0, 4.5),
                          child: SvgPicture.asset(
                            'assets/deepseek-mark.svg',
                            width: 32,
                            height: 32,
                            colorFilter: const ColorFilter.mode(DshTheme.fg, BlendMode.srcIn),
                          ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      SizedBox(
                        height: 32,
                        child: Center(
                          child: Transform.translate(
                            offset: const Offset(0, -2),
                            child: const Text(
                              'deepseek',
                              style: TextStyle(
                                color: DshTheme.fg,
                                fontFamily: 'BrandFont',
                                fontSize: 21,
                                height: 1.0,
                                fontWeight: FontWeight.w500,
                                letterSpacing: .2,
                              ),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      SizedBox(
                        height: 32,
                        child: Center(
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                            decoration: BoxDecoration(
                              color: DshTheme.fg,
                              borderRadius: BorderRadius.circular(5),
                            ),
                            child: const Text(
                              'HARNESS',
                              style: TextStyle(
                                color: DshTheme.bg,
                                fontFamily: 'BrandFont',
                                fontSize: 10,
                                height: 1.2,
                                fontWeight: FontWeight.w500,
                                letterSpacing: 1.0,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 44),
                  Text(action, style: Theme.of(context).textTheme.headlineSmall),
                  const SizedBox(height: 6),
                  Text(
                    _registerMode ? '创建账号后自动登录' : '请先在桌面版登录账号',
                    style: const TextStyle(color: DshTheme.fgDim, fontSize: 13, height: 1.5),
                  ),
                  const SizedBox(height: 26),
                  TextField(
                    key: const Key('email-field'),
                    controller: _emailController,
                    keyboardType: TextInputType.emailAddress,
                    autofillHints: const [AutofillHints.username],
                    style: const TextStyle(color: DshTheme.fg),
                    decoration: const InputDecoration(
                      hintText: '邮箱',
                      prefixIcon: Icon(Icons.alternate_email, size: 20),
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    key: const Key('password-field'),
                    controller: _passwordController,
                    obscureText: _obscurePassword,
                    autofillHints: const [AutofillHints.password],
                    style: const TextStyle(color: DshTheme.fg),
                    decoration: InputDecoration(
                      hintText: _registerMode ? '密码（至少 10 位）' : '密码',
                      prefixIcon: const Icon(Icons.lock_outline, size: 20),
                      suffixIcon: IconButton(
                        onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                        icon: Icon(_obscurePassword ? Icons.visibility_off_outlined : Icons.visibility_outlined, size: 20),
                      ),
                    ),
                    onSubmitted: (_) => _submit(),
                  ),
                  if (_registerMode) ...[
                    const SizedBox(height: 12),
                    TextField(
                      key: const Key('confirm-field'),
                      controller: _confirmController,
                      obscureText: _obscurePassword,
                      style: const TextStyle(color: DshTheme.fg),
                      decoration: const InputDecoration(
                        hintText: '确认密码',
                        prefixIcon: Icon(Icons.lock_reset, size: 20),
                      ),
                      onSubmitted: (_) => _submit(),
                    ),
                  ],
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
                      key: const Key('login-button'),
                      onPressed: _loading ? null : _submit,
                      child: _loading
                          ? const SizedBox(
                              height: 20,
                              width: 20,
                              child: CircularProgressIndicator(strokeWidth: 2, color: DshTheme.fgDim),
                            )
                          : Text(action),
                    ),
                  ),
                  const SizedBox(height: 8),
                  TextButton(
                    key: const Key('toggle-mode-button'),
                    onPressed: _loading ? null : _toggleMode,
                    child: Text(_registerMode ? '已有账号？去登录' : '没有账号？注册'),
                  ),
                  if (!_registerMode)
                    TextButton(
                      key: const Key('forgot-password-button'),
                      onPressed: _loading ? null : _forgotPassword,
                      child: const Text('忘记密码'),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
