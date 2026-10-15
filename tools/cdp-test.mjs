// 真机冒烟测试：通过 CDP 驱动 headless Chrome 里已加载的扩展。
// 用法：node tools/cdp-test.mjs <扩展id>
import fs from 'node:fs';

const EXT_ID = process.argv[2] || 'fignfifoniblkonapihmkfakmlgkbkcf';
const DEBUG = 'http://127.0.0.1:' + (process.argv[3] || 9333);

async function newPage(url) {
  const res = await fetch(`${DEBUG}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(new CDP(ws)));
    ws.addEventListener('error', reject);
  });
}

async function evaluate(cdp, expr, { awaitPromise = true } = {}) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) {
    return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  }
  return { value: r.result?.value };
}

const errors = [];
const logs = [];

// ---- 1. 打开 dashboard ----
const target = await newPage(`chrome-extension://${EXT_ID}/pages/dashboard.html`);
await sleep(2500);
const cdp = await connect(target.webSocketDebuggerUrl);
cdp.send('Runtime.enable');
cdp.send('Log.enable');
console.log('page opened:', target.id);

// 收集控制台输出与异常
setInterval(() => {
  while (cdp.events.length) {
    const m = cdp.events.shift();
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      logs.push(`[${m.params.type}] ${text}`);
      if (m.params.type === 'error') errors.push(text);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push(d.exception?.description || d.text);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error') errors.push(`${e.source}: ${e.text}`);
    }
  }
}, 200);

// ---- 2. 页面状态 ----
await sleep(1500);
let r = await evaluate(cdp, `({
  title: document.title,
  tabs: [...document.querySelectorAll('.tab')].map(t => t.textContent),
  errBar: document.getElementById('globalErrorBar')?.textContent || null,
  browseRows: document.querySelectorAll('.vrow').length,
  browseErr: document.querySelector('#view-browse .empty-tip')?.textContent || null,
  topStatus: document.getElementById('topStatus')?.textContent,
})`);
console.log('PAGE STATE:', JSON.stringify(r, null, 1));

// ---- 3. 切到数据页 ----
await evaluate(cdp, `document.querySelector('[data-tab="data"]').click()`);
await sleep(2000);
r = await evaluate(cdp, `({
  hasImportBtn: !!document.querySelector('#btnChromeImport'),
  hasExportBtn: !!document.querySelector('#btnJsonExport'),
  storageInfo: document.querySelector('#storageInfo')?.textContent,
})`);
console.log('DATA TAB:', JSON.stringify(r, null, 1));

// ---- 4. 点导入按钮，观察 20 秒 ----
await evaluate(cdp, `document.querySelector('#btnChromeImport').click()`);
for (let i = 0; i < 10; i++) {
  await sleep(2000);
  r = await evaluate(cdp, `({
    progressVisible: document.querySelector('#chromeProgress')?.style.display,
    text: document.querySelector('#chromeText')?.textContent,
    result: document.querySelector('#chromeResult')?.textContent,
    btnDisabled: document.querySelector('#btnChromeImport')?.disabled,
  })`);
  console.log(`IMPORT t=${(i + 1) * 2}s:`, JSON.stringify(r));
  if (r.value?.result) break;
}

// ---- 5. 点 JSON 导出，观察 10 秒 ----
await evaluate(cdp, `document.querySelector('#btnJsonExport').click()`);
for (let i = 0; i < 5; i++) {
  await sleep(2000);
  r = await evaluate(cdp, `({
    hint: document.querySelector('#jsonExportHint')?.textContent,
    btnDisabled: document.querySelector('#btnJsonExport')?.disabled,
  })`);
  console.log(`EXPORT t=${(i + 1) * 2}s:`, JSON.stringify(r));
  if (r.value?.hint && !r.value.btnDisabled) break;
}

// ---- 6. 切到站点页 ----
await evaluate(cdp, `document.querySelector('[data-tab="sites"]').click()`);
await sleep(2000);
r = await evaluate(cdp, `({
  summary: document.querySelector('#siteSummary')?.textContent,
  folders: document.querySelectorAll('.site-folder').length,
})`);
console.log('SITES TAB:', JSON.stringify(r, null, 1));

// ---- 7. 截图 ----
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('tools/last-screenshot.png', Buffer.from(shot.data, 'base64'));
console.log('screenshot saved: tools/last-screenshot.png');

console.log('\n=== CONSOLE ERRORS ===');
console.log(errors.length ? errors.join('\n---\n') : '(none)');
console.log('\n=== LAST LOGS ===');
console.log(logs.slice(-15).join('\n'));
process.exit(0);
