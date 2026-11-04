import 'package:flutter/material.dart';

/// 官方品牌风：白底黑字，只用 1px 浅灰分隔线，不用阴影和渐变。
abstract final class DshTheme {
  static const bg = Color(0xFFFFFFFF);
  static const panel = Color(0xFFF7F8FA);
  static const line = Color(0xFFE5E7EB);
  static const fg = Color(0xFF0F1115);
  static const fgDim = Color(0xFF6B7280);
  static const danger = Color(0xFFDC2626);

  static ThemeData light() {
    const scheme = ColorScheme.light(
      surface: bg,
      onSurface: fg,
      primary: fg,
      onPrimary: bg,
      secondary: fgDim,
      onSecondary: bg,
      outline: line,
      surfaceContainerHighest: panel,
      error: danger,
      onError: bg,
    );

    OutlineInputBorder border(Color color, {double width = 1}) => OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: color, width: width),
        );

    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      colorScheme: scheme,
      scaffoldBackgroundColor: bg,
      appBarTheme: const AppBarTheme(
        backgroundColor: bg,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(color: fg, fontSize: 18, fontWeight: FontWeight.w600),
        iconTheme: IconThemeData(color: fg),
      ),
      textTheme: const TextTheme(
        headlineSmall: TextStyle(color: fg, fontSize: 24, fontWeight: FontWeight.w700, letterSpacing: -.3),
        titleLarge: TextStyle(color: fg, fontSize: 18, fontWeight: FontWeight.w600),
        titleMedium: TextStyle(color: fg, fontSize: 15, fontWeight: FontWeight.w600),
        bodyMedium: TextStyle(color: fg, fontSize: 14),
        bodySmall: TextStyle(color: fgDim, fontSize: 12),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: panel,
        hintStyle: const TextStyle(color: fgDim, fontSize: 14),
        labelStyle: const TextStyle(color: fgDim, fontSize: 13),
        prefixIconColor: fgDim,
        suffixIconColor: fgDim,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        border: border(line),
        enabledBorder: border(line),
        focusedBorder: border(fg, width: 1.4),
        errorBorder: border(danger),
        focusedErrorBorder: border(danger, width: 1.4),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: fg,
          foregroundColor: bg,
          disabledBackgroundColor: line,
          disabledForegroundColor: fgDim,
          minimumSize: const Size.fromHeight(48),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(foregroundColor: fgDim, textStyle: const TextStyle(fontSize: 13)),
      ),
      cardTheme: CardTheme(
        color: bg,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: line),
        ),
      ),
      dividerTheme: const DividerThemeData(color: line, thickness: 1, space: 1),
      snackBarTheme: const SnackBarThemeData(
        backgroundColor: fg,
        contentTextStyle: TextStyle(color: bg),
        behavior: SnackBarBehavior.floating,
      ),
      progressIndicatorTheme: const ProgressIndicatorThemeData(color: fg),
    );
  }
}
