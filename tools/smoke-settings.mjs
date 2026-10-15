// 设置页渲染验证:分区结构、云同步卡片、数据工具是否正常渲染。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT_ROOT = process.cwd();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-set-'));
const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + profile,
  '--load-extension=' + EXT_ROOT,
  '--remote-debugging-port=9355',
  'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0; const pending = new Map();
let ws;
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); rej(new Error('cdp 超时: ' + method)); }, 15000);
  pending.set(id, (m) => { clearTimeout(timer); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate 失败');
  return r.result?.value;
};

try {
  let extId = null;
  for (let i = 0; i < 30 && !extId; i++) {
    await sleep(500);
    try {
      const t = await (await fetch('http://127.0.0.1:9355/json/list')).json();
      const sw = t.find((x) => x.type === 'service_worker' && /^chrome-extension:\/\//.test(x.url));
      if (sw) extId = sw.url.split('/')[2];
    } catch {}
  }
  if (!extId) throw new Error('扩展未加载');
  const t = await (await fetch('http://127.0.0.1:9355/json/list')).json();
  const blank = t.find((x) => x.type === 'page');
  ws = new WebSocket(blank.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await send('Page.enable');
  await send('Page.navigate', { url: `chrome-extension://${extId}/pages/dashboard.html#settings` });
  // 等页面就绪(tab 按钮出现,最多 20 秒)
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const ready = await evalJs(`!!document.querySelector('.tab[data-tab="stash"]')`).catch(() => false);
    if (ready) break;
  }
  await sleep(1500);

  const results = [];
  const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' —— ' + extra : ''}`);

  console.log('导航诊断:', await evalJs(`({
    href: location.href.slice(0, 90),
    title: document.title,
    tabs: document.querySelectorAll('.tab').length,
    bodyLen: document.body?.innerHTML?.length || 0,
  })`));
  const state = await evalJs(`(() => ({
    globalErr: document.getElementById('globalErrorBar')?.textContent || '',
    heads: [...document.querySelectorAll('.set-head')].map((h) => h.textContent.trim()).join('|'),
    swRecord: !!document.getElementById('swRecord'),
    chromeImport: !!document.getElementById('btnChromeImport'),
    jsonExport: !!document.getElementById('btnJsonExport'),
    csv: !!document.getElementById('btnCsvExport'),
    clear: !!document.getElementById('btnClear'),
    stashJson: !!document.getElementById('btnStashJsonExport'),
    stashImport: !!document.getElementById('btnStashImport'),
    openBookmarksNote: document.body.textContent.includes('书签即 Chrome 原生书签'),
    openBookmarksGone: !document.getElementById('btnOpenBookmarks'),
    openStashGone: !document.getElementById('btnOpenStash'),
    helpRows: document.querySelectorAll('.help-row').length,
    helpPanel: !!document.querySelector('.help-panel'),
    syncStats: !!document.querySelector('.sync-stats'),
    syncActions: [...document.querySelectorAll('.sync-actions .btn')].map((b) => b.textContent.trim()).join('|'),
    syncColors: [...document.querySelectorAll('.sync-actions .btn')].map((b) => b.classList.contains('sync-down') || b.classList.contains('sync-up') || b.classList.contains('sync-both')).join(','),
    autoTwoWay: !!document.getElementById('d1AutoTwoWay'),
    snapDetails: !!document.getElementById('d1SnapBox'),
    syncForm: !!document.getElementById('d1Save'),
    dangerCollapsed: (() => {
      const d = document.querySelector('details.danger-zone');
      return d && !d.open;
    })(),
    clearDisabled: document.getElementById('btnClear')?.disabled === true,
    storageInfo: (document.getElementById('storageInfo')?.textContent || '').slice(0, 50),
  }))()`);
  check('设置页无报错', !state.globalErr, state.globalErr.slice(0, 80));
  check('分区:浏览历史|书签|标签收纳|关于(云同步已并入)',
    state.heads === '浏览历史|书签|标签收纳|关于', state.heads);
  check('底部使用说明栏', state.helpPanel && state.helpRows >= 15, `rows=${state.helpRows}`);
  check('浏览历史栏目(记录开关/导入/JSON/CSV/清空)',
    state.swRecord && state.chromeImport && state.jsonExport && state.csv && state.clear,
    state.storageInfo);
  const unlockTest = await evalJs(`
    (async () => {
      const zone = document.querySelector('details.danger-zone');
      zone.open = true;
      const input = document.getElementById('clearConfirmInput');
      const btn = document.getElementById('btnClear');
      const disabledBefore = btn.disabled;
      input.value = '我想清空全部浏览记录，确定';
      input.dispatchEvent(new Event('input'));
      const enabledAfter = !btn.disabled && btn.disabled === false;
      input.value = '随便打点字';
      input.dispatchEvent(new Event('input'));
      const disabledAgain = btn.disabled;
      input.value = '我想清空全部浏览记录，确定';
      input.dispatchEvent(new Event('input'));
      return { disabledBefore, enabledAfter, disabledAgain };
    })()
  `);
  check('清空按钮输入解锁(默认禁用,包含短语才启用)',
    unlockTest.disabledBefore && unlockTest.enabledAfter && unlockTest.disabledAgain,
    JSON.stringify(unlockTest));
  check('标签收纳栏目(导出 JSON/导入,无跳转按钮)', state.stashJson && state.stashImport && state.openStashGone);
  check('书签栏目说明(无跳转按钮)', state.openBookmarksNote && state.openBookmarksGone);
  check('云同步卡片',
    state.syncStats
      ? (state.syncActions === '↓仅下载|↑仅上传|⇅双向同步…' && state.syncColors === 'true,true,true' && state.autoTwoWay && state.snapDetails)
      : !!state.syncForm,
    `stats=${state.syncStats} actions=[${state.syncActions}] twoWay=${state.autoTwoWay} snap=${state.snapDetails} form=${state.syncForm}`);

  // 恢复消息通路:未配置时应返回结构化错误而非抛异常
  const restorePath = await evalJs(`
    new Promise((res) => chrome.runtime.sendMessage({ type: 'd1SyncRestoreFromSnapshot', deviceId: 'test' }, (r) => {
      res({ ok: !chrome.runtime.lastError, err: r?.error || '' });
    }))
  `);
  check('快照恢复消息通路', restorePath.ok && restorePath.err.length > 0, restorePath.err.slice(0, 30));

  // 点击「标签收纳」页签,确认页签切换仍正常
  await evalJs(`(async () => {
    document.querySelector('.tab[data-tab="stash"]').click();
    await new Promise((r) => setTimeout(r, 800));
  })()`);
  const switched = await evalJs(`document.querySelector('.tab.active')?.dataset.tab`);
  check('页签切换到标签收纳', switched === 'stash', String(switched));

  console.log(results.join('\n'));
  const failed = results.some((r) => r.startsWith('FAIL'));
  console.log(failed ? '\n== 设置页验证存在失败项 ==' : '\n== 设置页验证全部通过 ==');
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error('设置页验证异常:', e.message);
  process.exitCode = 1;
} finally {
  try { browser.kill(); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Windows 下进程未完全退出时忽略 */ }
  setTimeout(() => process.exit(process.exitCode || 0), 200);
}
