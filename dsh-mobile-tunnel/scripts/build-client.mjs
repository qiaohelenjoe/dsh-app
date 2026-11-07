/**
 * 把 tsc 产出的 ESM 包装成 DSH 客户端模块格式（window.__ModuleLoader__.load）。
 * 官方客户端 bundle 均为该格式；直接加载 ESM 会报 "Unexpected token 'export'"。
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rawDir = join(root, 'client-raw');
const rawPath = join(rawDir, 'client.js');
const outDir = join(root, 'client');
const outPath = join(outDir, 'client.js');

let code = readFileSync(rawPath, 'utf8');
// 客户端 bundle 是单文件格式（factory 里没有模块解析器）：把生成出来的辅助模块内联进来，
// 并去掉对应的 import 语句。
for (const name of ['app-qr', 'file-panel']) {
  const modulePath = join(rawDir, `${name}.js`);
  if (!existsSync(modulePath)) continue;
  const helper = readFileSync(modulePath, 'utf8')
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+let\s+/gm, 'let ')
    .replace(/^export\s+function\s+/gm, 'function ')
    .replace(/^export\s+async\s+function\s+/gm, 'async function ')
    .replace(/^export\s+class\s+/gm, 'class ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  code = code.replace(new RegExp(`^import\\s+\\{[^}]*\\}\\s+from\\s+['"]\\./${name}\\.js['"];?\\s*$`, 'gm'), '');
  code = `${helper}\n${code}`;
}
code = code.replace(/^\/\/# sourceMappingURL=.*$/m, '');
const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
code = code.replaceAll('__PKG_VERSION__', pkgVersion);
code = code.replace(/^export\s+const\s+/gm, 'const ');
code = code.replace(/^export\s+let\s+/gm, 'let ');
code = code.replace(/^export\s+function\s+/gm, 'function ');
code = code.replace(/^export\s+async\s+function\s+/gm, 'async function ');
code = code.replace(/^export\s+class\s+/gm, 'class ');
code = code.replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
code = code.replace(/^export\s+default\s+/gm, 'const __default__ = ');

const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-mobile-tunnel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${code
  .split('\n')
  .map((line) => (line.length > 0 ? '\t\t' + line : line))
  .join('\n')}
		exports.apply = apply;
		exports.inject = pluginInject;
		exports.name = pluginName;
		return module.exports;
	}
});
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, wrapped, 'utf8');
rmSync(join(root, 'client-raw'), { recursive: true, force: true });
if (!existsSync(outPath)) throw new Error('client bundle 未生成');
console.log(`[build-client] wrote ${outPath} (${wrapped.length} bytes)`);
