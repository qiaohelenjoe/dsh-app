import 'package:dsh_mobile/form_factor.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('形态判定', () {
    test('短边 < 600dp 注入移动适配层', () {
      expect(shouldInjectMobileAdaptation(390), isTrue);
      expect(shouldInjectMobileAdaptation(599.9), isTrue);
      expect(isWideLayout(390), isFalse);
    });

    test('短边 >= 600dp 保持桌面布局', () {
      expect(shouldInjectMobileAdaptation(600), isFalse);
      expect(shouldInjectMobileAdaptation(1024), isFalse);
      expect(isWideLayout(600), isTrue);
    });
  });
}
