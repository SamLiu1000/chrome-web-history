// 压力测试：验证浏览器 innerHTML/querySelector 的可靠性（排查外部内存篡改）。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const port = process.argv[2] || '9335';
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = list.find((t) => t.url.includes('dashboard.html'));
  if (!page) { console.log('dashboard page not found'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
  const ev = (expr) => new Promise((res) => { const i = ++id; pend.set(i, (r) => res(r.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });

  const expr = `(async () => {
    let corrupted = 0; const samples = [];
    const tmpl = '<input type="file" id="jf" accept=".json"><select id="jsm"><option value="merge">合并</option></select><button class="btn primary" id="bjie">导入</button><span id="st">统计</span>';
    for (let i = 0; i < 100; i++) {
      const d = document.createElement('div');
      d.innerHTML = tmpl;
      const ok = d.querySelector('#jf') && d.querySelector('#jsm') && d.querySelector('#bjie') && d.querySelector('#st');
      if (!ok) { corrupted++; if (samples.length < 3) samples.push(d.innerHTML); }
      await new Promise((r2) => setTimeout(r2, 20));
    }
    return { corrupted, samples };
  })()`;
  console.log('压力测试:', JSON.stringify(await ev(expr), null, 1));
  process.exit(0);
})();
