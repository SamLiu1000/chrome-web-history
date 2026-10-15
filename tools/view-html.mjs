// 工具脚本：worker.js 中内嵌的 VIEW_HTML 字符串 <-> view.html 源文件互转。
// node tools/view-html.mjs decode  # worker.js -> view.html
// node tools/view-html.mjs encode  # view.html -> worker.js（替换 VIEW_HTML 字面量）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const workerFile = path.join(dir, '..', 'worker', 'src', 'worker.js');
const viewFile = path.join(dir, '..', 'worker', 'src', 'view.html');

const mode = process.argv[2];
if (mode === 'decode') {
  const src = fs.readFileSync(workerFile, 'utf8');
  const m = src.match(/const VIEW_HTML = ("(?:[^"\\]|\\.)*");/);
  if (!m) { console.error('VIEW_HTML not found'); process.exit(1); }
  const html = new Function('return ' + m[1])();
  fs.writeFileSync(viewFile, html);
  console.log('decoded', html.length, 'chars ->', viewFile);
} else if (mode === 'encode') {
  const html = fs.readFileSync(viewFile, 'utf8');
  let src = fs.readFileSync(workerFile, 'utf8');
  if (!/const VIEW_HTML = (?:\"(?:[^\"\\]|\\.)*\");/.test(src)) {
    console.error('VIEW_HTML not found in worker.js');
    process.exit(1);
  }
  src = src.replace(/const VIEW_HTML = (?:\"(?:[^\"\\]|\\.)*\");/, () => 'const VIEW_HTML = ' + JSON.stringify(html) + ';');
  fs.writeFileSync(workerFile, src);
  console.log('encoded view.html ->', workerFile, JSON.stringify(html).length, 'chars');
} else {
  console.error('usage: node tools/view-html.mjs decode|encode');
  process.exit(1);
}
