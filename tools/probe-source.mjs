// 验证：浏览器拿到的扩展 JS 文件内容是否与磁盘一致（排查代码缓存/加载层损坏）。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const port = process.argv[2] || '9335';
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = list.find((t) => t.url.includes('dashboard.html'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
  const ev = (expr) => new Promise((res) => { const i = ++id; pend.set(i, (r) => res(r.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });

  const expr = `(async () => {
    const origin = location.origin;
    const src = await (await fetch(origin + '/pages/views/data.js')).text();
    return {
      fetchOk: src.length,
      hasClassCard: src.includes('class="card"'),
      hasClaSpace: src.includes('cla ="') || src.includes('cla ='),
      sampleAroundCard: src.slice(src.indexOf('card') - 60, src.indexOf('card') + 30),
      // 运行时函数源码（来自 V8 编译产物）
      renderSrcHasClassCard: (window.__probe ? 'n/a' : 'n/a'),
    };
  })()`;
  console.log('文件内容检查:', JSON.stringify(await ev(expr), null, 1));

  const expr2 = `(async () => {
    const m = await import(chrome.runtime.getURL('pages/views/data.js'));
    const src = m.render.toString();
    return {
      fnSrcLen: src.length,
      fnHasClassCard: src.includes('class="card"'),
      fnSample: src.slice(src.indexOf('card') - 80, src.indexOf('card') + 40),
    };
  })()`;
  console.log('运行时函数源码:', JSON.stringify(await ev(expr2), null, 1));
  process.exit(0);
})();
