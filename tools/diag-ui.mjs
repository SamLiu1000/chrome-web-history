// 带界面复现:真实渲染 stash 页,收集 console 错误、页面状态与截图。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT_ROOT = process.cwd();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-ui-'));
const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,900',
  '--user-data-dir=' + profile,
  '--load-extension=' + EXT_ROOT,
  '--remote-debugging-port=9361',
  'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0; const pending = new Map(); const logs = [];
let ws;
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); rej(new Error('cdp 超时: ' + method)); }, 20000);
  pending.set(id, (m) => { clearTimeout(timer); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return 'ERR: ' + String(r.exceptionDetails.exception?.description || '').slice(0, 400);
  return r.result?.value;
};

try {
  let extId = null;
  for (let i = 0; i < 30 && !extId; i++) {
    await sleep(500);
    try {
      const t = await (await fetch('http://127.0.0.1:9361/json/list')).json();
      const sw = t.find((x) => x.type === 'service_worker' && /^chrome-extension:\/\//.test(x.url));
      if (sw) extId = sw.url.split('/')[2];
    } catch {}
  }
  if (!extId) throw new Error('扩展未加载');
  console.log('extId =', extId);
  const t = await (await fetch('http://127.0.0.1:9361/json/list')).json();
  const blank = t.find((x) => x.type === 'page');
  ws = new WebSocket(blank.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('exception: ' + String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300));
    } else if (m.method === 'Log.entryAdded') {
      logs.push(m.params.entry.level + ': ' + String(m.params.entry.text).slice(0, 300));
    }
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `chrome-extension://${extId}/pages/dashboard.html#stash` });
  await sleep(3000);

  // 注入一条真实数据再重绘
  await evalJs(`(async () => {
    const m = await import(chrome.runtime.getURL('lib/stash.js'));
    await m.stashTabs([
      { url: 'https://example.com/', title: '示例页面', pinned: true },
      { url: 'https://developer.mozilla.org/zh-CN/', title: 'MDN 文档' },
    ], { groupLabel: '实测分组' });
    const el = document.getElementById('stSearch');
    el.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 500));
  })()`);

  const state = await evalJs(`(() => {
    const view = document.getElementById('view-stash');
    return {
      href: location.href.slice(0, 80),
      globalErr: document.getElementById('globalErrorBar')?.textContent?.slice(0, 200) || '(无)',
      paintError: view?.dataset.paintError || '(无)',
      pageTail: view?.innerHTML.slice(-160),
      sideLen: document.getElementById('stSideList')?.innerHTML.length,
      groupsLen: document.getElementById('stGroups')?.innerHTML.length,
      groupCount: document.querySelectorAll('#stGroups .tg-group').length,
      rowCount: document.querySelectorAll('#stGroups .tg-row').length,
      folderCount: document.querySelectorAll('#stSideList .st-side-item').length,
    };
  })()`);
  console.log(JSON.stringify(state, null, 1));
  console.log('--- console ---');
  console.log(logs.slice(-10).join('\n') || '(无错误日志)');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('tools/stash-screenshot.png', Buffer.from(shot.data, 'base64'));
  console.log('截图: tools/stash-screenshot.png');
} catch (e) {
  console.log('诊断失败:', e.message);
  console.log('--- console ---');
  console.log(logs.slice(-10).join('\n') || '(无日志)');
} finally {
  try { browser.kill(); } catch {}
  setTimeout(() => process.exit(0), 300);
}
