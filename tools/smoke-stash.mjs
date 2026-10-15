// 标签收纳功能冒烟测试：
// 启动一个加载本扩展的 headless 浏览器（新版 Chrome 禁止 headless --load-extension，
// 用 Edge），通过 CDP 驱动 dashboard 页面验证：
//   1. 收纳页渲染无错误；2. stashTabs 写入与列表渲染；3. 组操作与回收站流转；
//   4. OneTab 兼容 HTML/JSON 导出；5. d1Sync 消息通路。
// 用法：node tools/smoke-stash.mjs [port]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(dir, '..');
const PORT = process.argv[2] || '9347';
const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-smoke-'));
const browser = spawn(EXE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`,
  `--load-extension=${EXT_ROOT}`,
  `--remote-debugging-port=${PORT}`,
  'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { browser.kill(); fs.rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

let seq = 0;
const pending = new Map();
let ws = null;

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error('CDP 超时: ' + method)); }, 15000);
    pending.set(id, (m) => { clearTimeout(timer); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

try {
  let version = null;
  for (let i = 0; i < 40 && !version; i++) {
    await sleep(500);
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
  }
  if (!version) throw new Error('浏览器调试端口未就绪');

  let extId = null;
  for (let i = 0; i < 20 && !extId; i++) {
    await sleep(500);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const sw = targets.find((t) => t.type === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\//.test(t.url));
    if (sw) extId = sw.url.split('/')[2];
  }
  if (!extId) throw new Error('未找到扩展 service worker target');
  console.log('扩展 id:', extId);

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const blank = targets.find((t) => t.type === 'page');
  if (!blank) throw new Error('没有可用的 page target');
  ws = new WebSocket(blank.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await send('Page.enable');
  await send('Page.navigate', { url: `chrome-extension://${extId}/pages/dashboard.html#stash` });
  await sleep(2500);

  const results = [];
  const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' —— ' + extra : ''}`);

  // 1. 页面基本渲染
  const pageInfo = await evalJs(`(() => ({
    ok: location.href.startsWith('chrome-extension://'),
    hasError: !!document.getElementById('globalErrorBar'),
    errText: document.getElementById('globalErrorBar')?.textContent || '',
    toolbar: !!document.getElementById('stStashWin'),
    emptyTip: document.getElementById('stGroups')?.textContent || '',
  }))()`);
  check('收纳页渲染', pageInfo.ok && pageInfo.toolbar && !pageInfo.hasError, pageInfo.errText || pageInfo.emptyTip.slice(0, 40));
  if (!pageInfo.toolbar) {
    console.log('页面未渲染，诊断:', JSON.stringify(await evalJs(`({
      href: location.href.slice(0, 90),
      title: document.title,
      viewHtml: document.getElementById('view-stash')?.innerHTML.slice(0, 120) || '(空)',
      bodyStart: document.body.innerHTML.slice(0, 150),
    })`)));
  }

  // 2. 写入一组标签并验证渲染
  const stashRes = await evalJs(`
    (async () => {
      const m = await import(chrome.runtime.getURL('lib/stash.js'));
      const g = await m.stashTabs([
        { url: 'https://example.com/', title: '示例页面', pinned: true },
        { url: 'https://developer.mozilla.org/zh-CN/', title: 'MDN 文档' },
      ], { groupLabel: '测试分组' });
      return g ? g.childIds.length : 0;
    })()
  `);
  check('stashTabs 写入', stashRes === 2, `childIds=${stashRes}`);

  // 搜索框 input 触发 repaint（空关键词 = 全量）
  await evalJs(`
    (async () => {
      const el = document.getElementById('stSearch');
      el.value = '';
      el.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 400));
    })()
  `);
  const listState = await evalJs(`(() => ({
    groupTitle: document.querySelector('.st-label')?.textContent || '',
    rows: document.querySelectorAll('#stGroups .tg-row').length,
    hasPin: !!document.querySelector('[data-act="pin"]'),
    starOn: !!document.querySelector('.st-star.on'),
  }))()`);
  check('列表渲染分组与标签', listState.groupTitle === '测试分组' && listState.rows === 2 && listState.hasPin,
    `title=${listState.groupTitle}, rows=${listState.rows}`);

  // 搜索筛选:组内只显示匹配的标签行,并显示匹配计数
  const searchTest = await evalJs(`
    (async () => {
      const el = document.getElementById('stSearch');
      el.value = 'MDN';
      el.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 400));
      const out = {
        rows: document.querySelectorAll('#stGroups .tg-row').length,
        meta: document.querySelector('#stGroups .st-meta')?.textContent || '',
      };
      el.value = '';
      el.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 300));
      return out;
    })()
  `);
  check('搜索直接筛选标签行', searchTest.rows === 1 && searchTest.meta.includes('1/2'),
    JSON.stringify(searchTest));

  // 3. 组操作：锁定 -> 星标 -> 回收站
  const ops = await evalJs(`
    (async () => {
      const m = await import(chrome.runtime.getURL('lib/stash.js'));
      const byId = await m.readAllStashItems();
      const gid = byId.get('root').childIds[0];
      await m.toggleLock(gid);
      const refused = !(await m.moveToTrash(gid));
      await m.toggleLock(gid);
      await m.toggleStar(gid);
      const on = (await m.readAllStashItems()).get(gid).rating === 5;
      await m.renameGroup(gid, '改名组', '备注');
      const mid = (await m.readAllStashItems()).get(gid);
      await m.moveToTrash(gid);
      const inTrash = ((await m.readAllStashItems()).get('trash').childIds || []).includes(gid);
      return { refused, on, label: mid.label, notes: mid.notes?.text, inTrash };
    })()
  `);
  check('锁定阻止整组删除', ops.refused === true);
  check('星标/命名/备注', ops.on && ops.label === '改名组' && ops.notes[0] === '备注');
  check('移入回收站', ops.inTrash === true);

  // 清掉测试组，重建一组做导出测试
  await evalJs(`
    (async () => {
      const m = await import(chrome.runtime.getURL('lib/stash.js'));
      await m.emptyTrash();
      await m.stashTabs([
        { url: 'https://example.com/', title: '示例页面' },
        { url: 'https://developer.mozilla.org/zh-CN/', title: 'MDN 文档' },
      ], { groupLabel: '导出测试' });
    })()
  `);

  // 4. OneTab 兼容导出
  const exp = await evalJs(`
    (async () => {
      const e = await import(chrome.runtime.getURL('lib/stash-export.js'));
      const html = await e.buildStashHtml();
      const json = JSON.parse(await e.buildStashJSON());
      return {
        htmlOk: html.html.includes('tabGroupTitleText') && html.html.includes('示例页面') && html.count === 2,
        jsonOk: json.format === 'onetap-full-backup' && json.v === 2 && json.itemCount === 2
          && json.items.some((i) => i.id === 'root'),
      };
    })()
  `);
  check('HTML 导出(OneTab 模板)', exp.htmlOk === true);
  check('JSON 导出(onetap-full-backup v2, 含根节点)', exp.jsonOk === true);

  // 6. 文件夹管理 + 编辑模式
  const folderFlow = await evalJs(`
    (async () => {
      const m = await import(chrome.runtime.getURL('lib/stash.js'));
      // 建文件夹并移入一组
      const f = await m.createFolder('工作', 'root');
      const g = await m.stashTabs([{ url: 'https://example.org/x', title: 'X 页' }], { parent: 'root' });
      await m.moveNode(g.id, f.id);
      const after = await m.readAllStashItems();
      const inFolder = after.get(f.id).childIds.includes(g.id) && after.get(g.id).parentIds[0] === f.id
        && !(after.get('root').childIds || []).includes(g.id);
      // tab 备注
      const tid = after.get(g.id).childIds[0];
      await m.updateTabNotes(tid, '稍后读');
      const notes = (await m.readAllStashItems()).get(tid).notes?.text;
      // 文件夹进回收站与恢复
      await m.moveToTrash(f.id);
      const trashed = ((await m.readAllStashItems()).get('trash').childIds || []).includes(f.id);
      await m.restoreFromTrash(f.id);
      const back = ((await m.readAllStashItems()).get('root').childIds || []).includes(f.id);
      // 清理
      await m.deleteGroupForever(f.id);
      return { inFolder, notes: notes?.[0], trashed, back };
    })()
  `);
  check('文件夹创建/移入/tab 备注', folderFlow.inFolder && folderFlow.notes === '稍后读', JSON.stringify(folderFlow));
  check('文件夹回收站流转', folderFlow.trashed && folderFlow.back);

  // 7. 单组导出 HTML 与剪贴板格式
  const oneGroup = await evalJs(`
    (async () => {
      const m = await import(chrome.runtime.getURL('lib/stash.js'));
      const e = await import(chrome.runtime.getURL('lib/stash-export.js'));
      const g = await m.stashTabs([
        { url: 'https://a.example.com/', title: 'Alpha' },
        { url: 'https://b.example.com/', title: 'Beta' },
      ], { groupLabel: '单组导出' });
      await m.updateTabNotes((await m.readAllStashItems()).get(g.id).childIds[0], '备注甲');
      const html = await e.buildStashHtml({ groupId: g.id });
      const md = await e.buildGroupClipboard(g.id, 'markdown');
      const txt = await e.buildGroupClipboard(g.id, 'text');
      await m.deleteGroupForever(g.id);
      return {
        htmlOk: html.count === 2 && html.html.includes('单组导出') && html.html.includes('备注甲'),
        mdOk: md.includes('[Alpha](https://a.example.com/)') && md.includes('备注甲'),
        txtOk: txt.includes('Alpha https://a.example.com/'),
      };
    })()
  `);
  check('单组导出 HTML(含备注)', oneGroup.htmlOk === true, JSON.stringify(oneGroup));
  check('复制格式(markdown/text)', oneGroup.mdOk && oneGroup.txtOk);

  // 8. 页面 UI:左栏/编辑模式出现
  await evalJs(`
    (async () => {
      const el = document.getElementById('stSearch');
      el.value = '';
      el.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 400));
    })()
  `);
  const uiState = await evalJs(`(() => ({
    paintError: document.getElementById('view-stash')?.dataset.paintError || '',
    sideMain: !!document.querySelector('.st-side-item[data-folder="root"]'),
    sideTrash: !!document.querySelector('.st-side-item[data-folder="trash"]'),
    editBtn: !!document.getElementById('stEditToggle'),
    editBarHidden: document.getElementById('stEditBar').hidden,
    noFolderInMain: !document.querySelector('#stGroups .st-folder'),
  }))()`);
  check('左栏(主列表/回收站)与编辑模式入口,主区无文件夹',
    uiState.sideMain && uiState.sideTrash && uiState.editBtn && uiState.editBarHidden && !uiState.paintError && uiState.noFolderInMain,
    JSON.stringify(uiState));

  // 组头空白区域点击 = 折叠/展开
  const foldTest = await evalJs(`
    (async () => {
      // 每次点击前重新查询(repaint 会重建 DOM,旧节点已脱离文档)
      document.querySelector('#stGroups .tg-group-head .st-meta').click();
      await new Promise((r) => setTimeout(r, 400));
      const collapsed1 = !!document.querySelector('#stGroups .tg-group-body[hidden]');
      document.querySelector('#stGroups .tg-group-head .st-meta').click();
      await new Promise((r) => setTimeout(r, 400));
      const collapsed2 = !!document.querySelector('#stGroups .tg-group-body[hidden]');
      return { collapsed1, collapsed2 };
    })()
  `);
  check('组头点击折叠/展开', foldTest.collapsed1 && !foldTest.collapsed2, JSON.stringify(foldTest));

  // 编辑按钮:进入后按钮文字变"完成"且仍可见,可退出
  const editTest = await evalJs(`
    (async () => {
      const btn = document.getElementById('stEditToggle');
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      const inEditing = btn.textContent === '完成' && btn.offsetParent !== null;
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      const back = btn.textContent === '编辑' && btn.offsetParent !== null;
      return { inEditing, back };
    })()
  `);
  check('编辑模式可进入可退出', editTest.inEditing && editTest.back, JSON.stringify(editTest));

  // 9. d1Sync 消息通路
  const d1 = await evalJs(`
    new Promise((res) => chrome.runtime.sendMessage({ type: 'd1SyncGetState' }, (r) => {
      res({ ok: !chrome.runtime.lastError, keys: r ? Object.keys(r).join(',') : '' });
    }))
  `);
  check('d1SyncGetState 消息通路', d1.ok && d1.keys.includes('config') && d1.keys.includes('state'), d1.keys);

  // 10. 收纳页顶部按钮真实点击（headless 里无 http 标签 -> 应提示但不出错）
  const btnClick = await evalJs(`
    (async () => {
      document.getElementById('stStashAll').click();
      await new Promise((r) => setTimeout(r, 800));
      return { err: !!document.getElementById('globalErrorBar'), toast: document.getElementById('toast')?.textContent || '' };
    })()
  `);
  check('收纳按钮点击不报错', !btnClick.err && btnClick.toast.length > 0, btnClick.toast.slice(0, 40));

  console.log(results.join('\n'));
  const failed = results.some((r) => r.startsWith('FAIL'));
  console.log(failed ? '\n== 冒烟测试存在失败项 ==' : '\n== 冒烟测试全部通过 ==');
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error('冒烟测试异常:', e.message);
  process.exitCode = 1;
} finally {
  cleanup();
  setTimeout(() => process.exit(process.exitCode || 0), 200);
}
