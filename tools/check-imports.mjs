// 开发辅助：交叉校验 import 的导出名在目标模块中存在。node tools/check-imports.mjs
// （在项目根目录运行，使用相对路径，避免中文路径 URL 编码问题）
import fs from 'node:fs';
import path from 'node:path';

const files = [
  'lib/util.js', 'lib/db.js', 'lib/io.js',
  'background/service-worker.js',
  'pages/dashboard.js', 'pages/popup.js', 'pages/sidepanel.js',
  'pages/views/bookmarks.js',
  'pages/views/browse.js', 'pages/views/sites.js',
  'pages/views/data.js', 'pages/views/settings-view.js',
];

const cache = new Map();
function exportsOf(f) {
  if (cache.has(f)) return cache.get(f);
  const src = fs.readFileSync(f, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const s of m[1].split(',')) {
      const n = s.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  cache.set(f, names);
  return names;
}

let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = path.normalize(path.join(path.dirname(f), m[2]));
    if (!fs.existsSync(target)) { console.log('MISSING FILE:', f, '->', m[2]); bad++; continue; }
    const avail = exportsOf(target);
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name && !avail.has(name)) { console.log('MISSING EXPORT:', f, 'imports', name, 'from', m[2]); bad++; }
    }
  }
}
console.log(bad === 0 ? 'ALL IMPORTS RESOLVE' : bad + ' problems');
process.exit(bad === 0 ? 0 : 1);
