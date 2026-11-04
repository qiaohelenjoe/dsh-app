/// 应用版本号。
///
/// 构建时用 `--dart-define=APP_VERSION=x.y.z` 注入；未注入时使用下面的默认值。
/// 发版前请与 `pubspec.yaml` 的 `version` 保持一致（这里是展示/上报用的语义版本）。
const String kAppVersion = String.fromEnvironment('APP_VERSION', defaultValue: '1.0.0');
