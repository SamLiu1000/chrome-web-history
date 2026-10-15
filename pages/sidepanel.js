// 垂直标签栏（chrome.sidePanel）：以垂直列表接管标签页管理。
// 仅侧栏打开时生效；列表完全由 chrome.tabs / chrome.windows 事件驱动（无轮询），
// 渲染按键复用行节点并原位搬移，避免整表重建的闪烁。
// 支持：点击切换 / 关闭（×、中键）/ 固定 / 静音 / 拖拽排序（含固定区、跨窗口）/
//       搜索过滤 / 多窗口分组（聚焦窗口优先，隐身窗口标注）。
// 拖拽为自研指针事件管线（与收纳页 stash.js 同一套架构，对齐 OneTab）：
// 按下移动 3px 或长按 250ms 进入拖拽；rAF 合帧判定；行级指示线 + 目标窗口
// 整窗高亮 + 光标幽灵；Esc 取消；触屏/触控笔可用（原生 HTML5 DnD 已弃用）。

import { faviconUrl } from '../lib/util.js';

const listEl = document.getElementById('tabList');
const mainEl = document.querySelector('main');
const searchEl = document.getElementById('tabSearch');
const newTabBtn = document.getElementById('newTab');
const dashBtn = document.getElementById('openDash');
const countEl = document.getElementById('tabCount');
const emptyEl = document.getElementById('emptyState');

const DASHBOARD_URL = chrome.runtime.getURL('pages/dashboard.html#browse');

const allTabs = new Map(); // tabId -> Tab
const rows = new Map();    // tabId -> <li>
const winEls = new Map();  // windowId -> { section, head, ul }
let focusedWindowId = null;
let filterText = '';

// ---------------------------------------------------------------- 工具

function tabUrl(t) { return t.url || t.pendingUrl || ''; }
function tabTitle(t) { return t.title || tabUrl(t) || '新标签页'; }

/** 窗口内排序：固定标签在前，其余按 Chrome 的 index（固定区本身也在最前）。 */
function sortedTabs(windowId) {
  return [...allTabs.values()]
    .filter((t) => t.windowId === windowId)
    .sort((a, b) => (a.pinned === b.pinned ? a.index - b.index : a.pinned ? -1 : 1));
}

async function currentWindowId() {
  try { return (await chrome.windows.getCurrent())?.id; } catch { return undefined; }
}

// ---------------------------------------------------------------- 渲染

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function createRow(tab) {
  const li = document.createElement('li');
  li.className = 'tab';
  li.dataset.tabId = String(tab.id);
  li.innerHTML = `
    <img class="fav" alt="" draggable="false">
    <span class="ti"></span>
    <button class="act a-mute" title="静音 / 取消静音">🔇</button>
    <button class="act a-pin" title="固定 / 取消固定">📌</button>
    <button class="act a-close" title="关闭标签页（中键同）">×</button>`;
  return li;
}

function updateRow(li, tab) {
  const url = tabUrl(tab);
  const title = tabTitle(tab);
  li.classList.toggle('active', !!tab.active);
  li.classList.toggle('pinned', !!tab.pinned);
  li.classList.toggle('loading', tab.status === 'loading');
  li.classList.toggle('discarded', !!tab.discarded);
  li.title = title + (url ? `\n${url}` : '');
  const ti = li.querySelector('.ti');
  if (ti.textContent !== title) ti.textContent = title;
  const fav = li.querySelector('.fav');
  const favSrc = faviconUrl(url || 'about:blank', 16);
  if (fav.dataset.src !== favSrc) { fav.dataset.src = favSrc; fav.src = favSrc; }
  const muted = !!tab.mutedInfo?.muted;
  li.classList.toggle('audible', !!tab.audible);
  li.classList.toggle('muted', muted);
  const muteBtn = li.querySelector('.a-mute');
  muteBtn.textContent = muted ? '🔇' : tab.audible ? '🔊' : '🔇';
  muteBtn.title = muted ? '取消静音' : '静音';
}

function render() {
  // 窗口顺序：聚焦窗口优先，其余按 id 升序
  const winIds = [...new Set([...allTabs.values()].map((t) => t.windowId))];
  winIds.sort((a, b) => (a === focusedWindowId ? -1 : b === focusedWindowId ? 1 : a - b));
  const multi = winIds.length > 1;

  // 移除已消失的窗口分组
  for (const [wid, els] of winEls) {
    if (!winIds.includes(wid)) { els.section.remove(); winEls.delete(wid); }
  }

  winIds.forEach((wid, i) => {
    let els = winEls.get(wid);
    if (!els) {
      const section = document.createElement('section');
      section.className = 'win';
      section.dataset.windowId = String(wid);
      section.innerHTML = '<div class="win-head"></div><ul></ul>';
      listEl.appendChild(section);
      els = { section, head: section.querySelector('.win-head'), ul: section.querySelector('ul') };
      winEls.set(wid, els);
    }
    const tabs = sortedTabs(wid);
    els.head.hidden = !multi;
    if (multi) {
      const incog = tabs.some((t) => t.incognito);
      els.head.textContent = `窗口 ${i + 1}${incog ? '（隐身）' : ''} · ${tabs.length} 个标签页`;
    }
    for (const tab of tabs) {
      let li = rows.get(tab.id);
      if (!li) { li = createRow(tab); rows.set(tab.id, li); }
      updateRow(li, tab);
      els.ul.appendChild(li); // 位置已正确时是无操作，跨窗口/乱序时则搬移节点
    }
  });

  // 清理已关闭标签的行
  for (const [id, li] of rows) {
    if (!allTabs.has(id)) { li.remove(); rows.delete(id); }
  }

  // 搜索过滤
  const q = filterText.toLowerCase();
  let visible = 0;
  for (const [id, li] of rows) {
    const t = allTabs.get(id);
    const hit = !q || (tabTitle(t) + ' ' + tabUrl(t)).toLowerCase().includes(q);
    li.classList.toggle('hide', !hit);
    if (hit) visible++;
  }
  countEl.textContent = q ? `${visible}/${allTabs.size} 个标签页` : `${allTabs.size} 个标签页`;
  emptyEl.hidden = allTabs.size > 0;
}

// ---------------------------------------------------------------- 行为

function activateTab(tab) {
  if (!tab) return;
  chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  if (tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

listEl.addEventListener('click', (e) => {
  const li = e.target.closest('.tab');
  if (!li) return;
  const id = Number(li.dataset.tabId);
  const tab = allTabs.get(id);
  if (e.target.closest('.a-close')) { chrome.tabs.remove(id).catch(() => {}); return; }
  if (e.target.closest('.a-pin')) { chrome.tabs.update(id, { pinned: !tab?.pinned }).catch(() => {}); return; }
  if (e.target.closest('.a-mute')) { chrome.tabs.update(id, { muted: !tab?.mutedInfo?.muted }).catch(() => {}); return; }
  activateTab(tab);
});

// 中键关闭（mousedown 先阻止中键自动滚屏）
listEl.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
listEl.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const li = e.target.closest('.tab');
  if (li) chrome.tabs.remove(Number(li.dataset.tabId)).catch(() => {});
});

// ---------------------------------------------------------------- 拖拽排序（自研指针 DnD，对齐收纳页 stash.js 管线）
//
// 原生 HTML5 DnD 的短板（触屏不可用、幽灵不可定制、无 Esc 取消、长按/阈值不可调）
// 全部规避：按下移动 3px 或按住 250ms 进入拖拽（双通道），rAF 每帧判定落点，
// 行级指示线 + 目标窗口整窗高亮（Chrome 原生标签栏同款），光标幽灵显示标题，
// 拖拽中临时清除搜索过滤保证"看到的行序"与落点一致，列表边缘自动滚动。

const DND_START_PX = 3;
const DND_HOLD_MS = 250;
const SCROLL_EDGE = 36;
const SCROLL_MIN = 60;
const SCROLL_MAX = 480;

let dnd = null; // { id, srcEl, started, x0, y0, x, y, raf, holdTimer, frameAt, target, ind, ghost }

function clearDndMarks() {
  for (const li of rows.values()) li.classList.remove('drop-above', 'drop-below');
  for (const els of winEls.values()) els.section.classList.remove('drop-win');
}

function beginDnd(e, li) {
  dnd = {
    id: Number(li.dataset.tabId), srcEl: li,
    started: false, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
    raf: 0, holdTimer: 0, frameAt: 0, target: null, ind: null, ghost: null,
  };
  dnd.holdTimer = setTimeout(() => { if (dnd && !dnd.started) startDnd(); }, DND_HOLD_MS);
  document.addEventListener('pointermove', onDndMove);
  document.addEventListener('pointerup', onDndUp);
  document.addEventListener('pointercancel', cancelDnd);
  document.addEventListener('keydown', onDndKey, true);
}

function startDnd() {
  if (!dnd || dnd.started) return;
  dnd.started = true;
  // 拖拽中临时清除搜索过滤：过滤态下隐藏行不参与布局，落点会与视觉错位
  if (filterText) { filterText = ''; searchEl.value = ''; render(); }
  // 光标幽灵：favicon + 标题（固定标签带 📌）
  const t = allTabs.get(dnd.id);
  const ghost = document.createElement('div');
  ghost.className = 'dnd-ghost';
  ghost.innerHTML = `<img class="fav" alt="" src="${faviconUrl(tabUrl(t || {}), 16)}"><span></span>`;
  ghost.querySelector('span').textContent = (t?.pinned ? '📌 ' : '') + (t ? tabTitle(t) : '');
  document.body.appendChild(ghost);
  dnd.ghost = ghost;
  dnd.srcEl.classList.add('dragging');
  dnd.srcEl.style.pointerEvents = 'none'; // 不挡命中测试：拖回原位也有指示
  document.body.classList.add('dnd-active');
  moveDndGhost();
  dnd.raf = requestAnimationFrame(dndFrame);
}

function moveDndGhost() {
  if (!dnd?.ghost) return;
  dnd.ghost.style.left = dnd.x + 12 + 'px';
  dnd.ghost.style.top = dnd.y + 14 + 'px';
}

function onDndMove(e) {
  if (!dnd) return;
  dnd.x = e.clientX;
  dnd.y = e.clientY;
  if (!dnd.started) {
    if (Math.hypot(e.clientX - dnd.x0, e.clientY - dnd.y0) < DND_START_PX) return;
    clearTimeout(dnd.holdTimer);
    startDnd();
    return;
  }
  e.preventDefault();
  moveDndGhost();
  if (!dnd.raf) dnd.raf = requestAnimationFrame(dndFrame);
}

function onDndKey(e) {
  if (dnd?.started && e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    cancelDnd();
  }
}

function removeDndListeners() {
  document.removeEventListener('pointermove', onDndMove);
  document.removeEventListener('pointerup', onDndUp);
  document.removeEventListener('pointercancel', cancelDnd);
  document.removeEventListener('keydown', onDndKey, true);
}

/** 取消/中断（Esc、pointercancel）：恢复视觉，不落库。 */
function cancelDnd() {
  if (!dnd) return;
  clearTimeout(dnd.holdTimer);
  removeDndListeners();
  if (dnd.raf) cancelAnimationFrame(dnd.raf);
  dnd.ghost?.remove();
  dnd.srcEl?.classList.remove('dragging');
  dnd.srcEl.style.pointerEvents = '';
  document.body.classList.remove('dnd-active');
  clearDndMarks();
  dnd = null;
}

/** 每帧：自动滚动 + 判定落点 + 更新指示线/窗口高亮。 */
function dndFrame(ts) {
  if (!dnd?.started) { if (dnd) dnd.raf = 0; return; }
  dnd.raf = 0;
  const dt = dnd.frameAt ? Math.min(100, ts - dnd.frameAt) : 16.7;
  dnd.frameAt = ts;
  // 主列表边缘自动滚动（二次加速，与收纳页同参数体系）
  const mr = mainEl.getBoundingClientRect();
  const yy = Math.min(mr.bottom, Math.max(mr.top, dnd.y));
  const up = yy - mr.top, down = mr.bottom - yy;
  let v = 0;
  if (up < SCROLL_EDGE) v = -(SCROLL_MIN + (SCROLL_MAX - SCROLL_MIN) * Math.pow(1 - up / SCROLL_EDGE, 2));
  else if (down < SCROLL_EDGE) v = SCROLL_MIN + (SCROLL_MAX - SCROLL_MIN) * Math.pow(1 - down / SCROLL_EDGE, 2);
  if (v) mainEl.scrollTop = Math.max(0, Math.min(mainEl.scrollHeight - mainEl.clientHeight, mainEl.scrollTop + v * dt / 1000));
  // 判定落点：源行已 pointer-events:none，elementFromPoint 直接命中目标
  clearDndMarks();
  dnd.target = null;
  const el = document.elementFromPoint(dnd.x, dnd.y);
  if (el && listEl.contains(el)) {
    const win = el.closest('.win');
    const head = el.closest('.win-head');
    const li = el.closest('.tab');
    if (li) {
      const id = Number(li.dataset.tabId);
      if (id !== dnd.id) {
        const r = li.getBoundingClientRect();
        const below = dnd.y > r.top + r.height / 2;
        dnd.target = { tabId: id, below };
        li.classList.add(below ? 'drop-below' : 'drop-above');
      }
    } else if (head && win) {
      // 窗口标题区 = 落到该窗口顶部（目标窗口没有固定标签时也能从顶部进入）
      dnd.target = { windowTop: true, windowId: Number(win.dataset.windowId) };
      win.classList.add('drop-win');
    } else if (win) {
      // 窗口空白区 = 落到该窗口末尾（跨窗口拖拽），整窗高亮给出"将移动到此窗口"提示
      dnd.target = { windowEnd: true, windowId: Number(win.dataset.windowId) };
      win.classList.add('drop-win');
    }
  }
  dnd.raf = requestAnimationFrame(dndFrame);
}

function onDndUp(e) {
  if (!dnd) return;
  clearTimeout(dnd.holdTimer);
  removeDndListeners();
  if (!dnd.started) { dnd = null; return; } // 原位松开 → 交回普通点击
  // 松手瞬间按指针位置重判一次落点，保证落库与指示一致
  dnd.x = e.clientX;
  dnd.y = e.clientY;
  const d = dnd;
  dnd = null;
  if (d.raf) cancelAnimationFrame(d.raf);
  // 吞掉紧随的 click，避免误触发激活/关闭
  const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
  document.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => document.removeEventListener('click', swallow, true), 250);
  d.ghost?.remove();
  d.srcEl?.classList.remove('dragging');
  d.srcEl.style.pointerEvents = '';
  document.body.classList.remove('dnd-active');
  clearDndMarks();
  if (d.target) performMove(d.id, d.target);
}

// 拖拽入口：按下标签行（非操作按钮）开始待定拖拽
listEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || dnd) return;
  const li = e.target.closest('.tab');
  if (!li || e.target.closest('.act')) return;
  e.preventDefault(); // 防文本选择/触摸滚动，触屏长按 250ms 同样进入拖拽
  beginDnd(e, li);
});

/** 执行拖放移动。tabs.move 的 index 是移动后的最终位置（同窗口时先移除再插入）。 */
async function performMove(id, info) {
  const drag = allTabs.get(id);
  if (!drag) return;
  try {
    if (info.windowEnd || info.windowTop) {
      await chrome.tabs.move(id, { windowId: info.windowId, index: info.windowTop ? 0 : -1 });
      return;
    }
    const target = allTabs.get(info.tabId);
    if (!target) return;
    // 拖进/拖出固定区：先改变固定状态，Chrome 会自动把标签归位到对应区域
    if (target.pinned !== drag.pinned) {
      await chrome.tabs.update(id, { pinned: target.pinned });
    }
    const others = sortedTabs(target.windowId).filter((t) => t.id !== id);
    const at = others.findIndex((t) => t.id === target.id);
    if (at < 0) return;
    await chrome.tabs.move(id, { windowId: target.windowId, index: at + (info.below ? 1 : 0) });
  } catch (e) {
    console.warn('[历史记录] 移动标签页失败', e);
    scheduleRender(); // 事件流的 index 可能与预期不一致，回正显示
  }
}

// ---------------------------------------------------------------- 标签页 / 窗口事件

chrome.tabs.onCreated.addListener((tab) => {
  if (tab && tab.id != null) { allTabs.set(tab.id, tab); scheduleRender(); }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  allTabs.set(tabId, tab);
  scheduleRender();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  allTabs.delete(tabId);
  scheduleRender();
});

chrome.tabs.onMoved.addListener((tabId, moveInfo, tab) => {
  allTabs.set(tabId, tab);
  scheduleRender();
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  for (const t of allTabs.values()) {
    if (t.windowId === windowId) t.active = t.id === tabId;
  }
  scheduleRender();
});

chrome.tabs.onAttached.addListener((tabId, info) => {
  const t = allTabs.get(tabId);
  if (t) { t.windowId = info.newWindowId; t.index = info.newPosition; }
  scheduleRender();
});

chrome.tabs.onDetached.addListener((tabId) => {
  const t = allTabs.get(tabId);
  if (t) t.index = -1; // 随后的 onAttached 会带上新位置
  scheduleRender();
});

chrome.tabs.onReplaced.addListener((addedId, removedId) => {
  allTabs.delete(removedId);
  chrome.tabs.get(addedId)
    .then((t) => { allTabs.set(t.id, t); scheduleRender(); })
    .catch(() => scheduleRender());
});

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, t] of allTabs) {
    if (t.windowId === windowId) allTabs.delete(id);
  }
  scheduleRender();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  focusedWindowId = windowId;
  scheduleRender();
});

// ---------------------------------------------------------------- 头部按钮与搜索

newTabBtn.addEventListener('click', async () => {
  chrome.tabs.create({ windowId: await currentWindowId(), active: true });
});

dashBtn.addEventListener('click', async () => {
  chrome.tabs.create({ windowId: await currentWindowId(), url: DASHBOARD_URL, active: true });
});

searchEl.addEventListener('input', () => {
  filterText = searchEl.value.trim();
  scheduleRender();
});
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchEl.value = '';
    filterText = '';
    scheduleRender();
  }
});

// ---------------------------------------------------------------- 初始化

(async function init() {
  try {
    const [tabs, win] = await Promise.all([
      chrome.tabs.query({}),
      chrome.windows.getLastFocused().catch(() => null),
    ]);
    for (const t of tabs) if (t.id != null) allTabs.set(t.id, t);
    focusedWindowId = win?.id ?? null;
  } catch (e) {
    console.warn('[历史记录] 垂直标签栏初始化失败', e);
  }
  render();
})();
