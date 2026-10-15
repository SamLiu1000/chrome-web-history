// 用 data.js 的真实模板重复赋值，抓损坏现场 + MutationObserver 监视第三方修改。
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
    const src = await (await fetch(location.origin + '/pages/views/data.js')).text();
    const start = src.indexOf('setInnerHTML(container,') + 'setInnerHTML(container,'.length;
    const end = src.indexOf('\`);', start);
    const tmpl = src.slice(src.indexOf('\`', start) + 1, end);
    const ids = [...tmpl.matchAll(/\\bid="([^"]+)"/g)].map((m) => m[1]);

    const mutations = [];
    const mo = new MutationObserver((list2) => {
      for (const m of list2) {
        mutations.push(m.type + '@' + (m.target.nodeName || '') + (m.attributeName ? ':' + m.attributeName : ''));
      }
    });
    mo.observe(document.documentElement, { attributes: true, childList: true, subtree: true, characterData: true });

    let corrupted = 0; const samples = [];
    for (let i = 0; i < 15; i++) {
      const d = document.createElement('div');
      d.innerHTML = tmpl;
      const missing = ids.filter((x) => !d.querySelector('#' + x));
      if (missing.length) {
        corrupted++;
        if (samples.length < 2) samples.push({ missing: missing.slice(0, 5), html: d.innerHTML.slice(0, 400) });
      }
      await new Promise((r2) => setTimeout(r2, 100));
    }
    mo.disconnect();
    return { corrupted, total: 15, samples, mutationCount: mutations.length, mutationSample: mutations.slice(0, 10) };
  })()`;
  console.log(JSON.stringify(await ev(expr), null, 1));
  process.exit(0);
})();
