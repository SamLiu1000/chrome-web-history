// 意外关闭页：浏览器异常退出时冻结的"未正常关闭的标签页"存档组列表。
//
// 本页只展示存档组（历史版本还镜像实时标签页，已按需求移除该展示区；
// 后台镜像仍在记录并在崩溃时冻结，本页只消费冻结结果）。
// 支持：单组勾选 / 全选 / 删除选中（确认后批量删除）；整组恢复；单条打开。
// 存档只在用户手动删除时才会消失——查看或恢复都不会去掉。

import {
  escapeHtml, formatDateTime, faviconUrl, setInnerHTML, displayPath, stripWww,
} from '../../lib/util.js';
import { CRASH_KEY, readCrashGroups, writeCrashGroups } from '../../lib/tab-guard.js';
import { confirmDialog } from '../../lib/dialog.js';
import { toast } from '../dashboard.js';

let built = false;
let ui = null;
let container = null;
let refreshTimer = null;
// 勾选状态跨重绘保留（storage 变化会整表重绘）
const checkedIds = new Set();
// 组折叠状态：仅会话内记忆（重绘后按组 id 恢复），默认全部展开
const collapsedGroups = new Set();
// 左侧栏当前定位的组（点击侧栏项后高亮，再次点击其它项切换）
let locatedGid = null;

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function buildSkeleton() {
  setInnerHTML(container, `
    <div class="cg-layout">
      <aside class="cg-side">
        <div class="st-side-head"><span>存档组</span><span class="st-side-count" id="cgSideCount"></span></div>
        <div class="cg-side-list" id="cgSideList"></div>
      </aside>
      <div class="cg-main">
        <div class="cg-main-top">
          <div class="tg-head">
            <div class="tg-title">未正常关闭的标签页 <span class="tg-count" id="tgCrashCount"></span></div>
            <div class="tg-desc">每次浏览器异常退出（崩溃 / 断电 / 被强杀）冻结一组。查看或恢复都不会使其消失，只有手动删除才会去掉。勾选后可批量删除；点左栏条目可定位到对应组。</div>
          </div>
          <div class="tg-toolbar">
            <label class="tg-selall"><input type="checkbox" id="tgSelAll"> 全选</label>
            <button class="btn btn-sm danger" id="tgDelSel" disabled>删除选中</button>
          </div>
        </div>
        <div id="crashGroups"></div>
      </div>
    </div>
  `);
  built = true;
  ui = {
    sideCount: container.querySelector('#cgSideCount'),
    sideList: container.querySelector('#cgSideList'),
    mainTop: container.querySelector('.cg-main-top'),
    crashCount: container.querySelector('#tgCrashCount'),
    selAll: container.querySelector('#tgSelAll'),
    delSel: container.querySelector('#tgDelSel'),
    crashGroups: container.querySelector('#crashGroups'),
  };
}

/** 侧栏条目时间用短格式（组标题里已是完整格式，重复太长）。 */
function sideTime(at) {
  const d = new Date(at);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} `
    + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function sideItemHtml(g) {
  return `
    <div class="st-side-item${locatedGid === g.id ? ' located' : ''}" data-group="${g.id}"
         title="${formatDateTime(g.at)} · ${g.tabs.length} 个标签页，点击定位">
      <span class="st-side-name">⚠ ${sideTime(g.at)}</span>
      <span class="st-side-count">${g.tabs.length}</span>
    </div>`;
}

function crashGroupHtml(g) {
  const collapsed = collapsedGroups.has(g.id);
  const rows = g.tabs.map((t, idx) => `
    <div class="vrow tg-row" data-group="${g.id}" data-idx="${idx}" data-url="${escapeHtml(t.url)}">
      <img class="vicon" src="${escapeHtml(faviconUrl(t.url))}" alt="" loading="lazy">
      <div class="vmain">
        <span class="vtitle tg-nolink" title="${escapeHtml(t.url)}">${escapeHtml(t.title || displayPath(t.url))}</span>
        <span class="vurl">${escapeHtml(stripWww(hostOf(t.url)))}</span>
      </div>
      ${t.pinned ? '<span class="tg-pin" title="固定标签">📌</span>' : ''}
      <button class="btn btn-sm tg-open" title="在新标签页打开">打开</button>
    </div>`).join('');
  const checked = checkedIds.has(g.id);
  return `
    <div class="tg-group" data-group="${g.id}">
      <div class="tg-group-head">
        <input type="checkbox" class="tg-check" data-group="${g.id}" ${checked ? 'checked' : ''} title="选中以批量删除">
        <button class="st-caret" data-act="cgCollapse" data-group="${g.id}" title="${collapsed ? '展开' : '折叠'}">${collapsed ? '▸' : '▾'}</button>
        <span class="tg-group-title">⚠ ${formatDateTime(g.at)} · ${g.tabs.length} 个标签页</span>
        <span class="spacer"></span>
        <button class="btn btn-sm tg-restore" data-group="${g.id}" title="在一个新窗口中打开整组标签页">整组恢复</button>
      </div>
      <div class="visit-list tg-group-body" ${collapsed ? 'hidden' : ''}>${rows}</div>
    </div>`;
}

function syncSelState(groups) {
  const boxes = [...ui.crashGroups.querySelectorAll('.tg-check')];
  ui.delSel.disabled = !checkedIds.size;
  ui.selAll.checked = boxes.length > 0 && boxes.every((b) => checkedIds.has(Number(b.dataset.group)));
  // 组数变化后清掉已不存在的勾选，避免状态残留
  const ids = new Set(groups.map((g) => g.id));
  for (const id of [...checkedIds]) if (!ids.has(id)) checkedIds.delete(id);
}

async function paint() {
  const groups = await readCrashGroups();
  const totalTabs = groups.reduce((n, g) => n + g.tabs.length, 0);
  // 主区顶部（标题+工具栏）是吸顶的：把它的实际高度写给 CSS，
  // 供 .tg-group 的 scroll-margin-top 使用——定位后组头不被吸顶块遮住
  document.documentElement.style.setProperty('--cg-top-h', ui.mainTop.offsetHeight + 'px');
  ui.crashCount.textContent = groups.length ? `（${groups.length} 组）` : '';
  ui.sideCount.textContent = groups.length ? `${groups.length} 组 / ${totalTabs} 个` : '';
  setInnerHTML(ui.sideList, groups.length
    ? groups.map(sideItemHtml).join('')
    : '<div class="empty-tip" style="padding:10px 6px;">暂无存档</div>');
  setInnerHTML(ui.crashGroups, groups.length
    ? groups.map(crashGroupHtml).join('')
    : '<div class="empty-tip">没有未正常关闭的记录 —— 浏览器都是正常退出的，很好</div>');
  syncSelState(groups);
}

async function repaint() {
  try { await paint(); } catch (e) { console.warn('[历史记录] 意外关闭页刷新失败', e); }
}

// ---------------------------------------------------------------- 行内操作

async function restoreGroup(gid) {
  const groups = await readCrashGroups();
  const g = groups.find((x) => x.id === gid);
  if (!g || !g.tabs.length) return;
  await chrome.windows.create({ url: g.tabs.map((t) => t.url), focused: true });
  toast(`已在新窗口恢复 ${g.tabs.length} 个标签页`);
}

async function deleteGroups(gids) {
  const groups = await readCrashGroups();
  const ids = new Set(gids);
  await writeCrashGroups(groups.filter((x) => !ids.has(x.id)));
  for (const id of gids) checkedIds.delete(id);
  if (ids.has(locatedGid)) locatedGid = null;
  toast(`已删除 ${gids.length} 组存档`);
  await repaint();
}

/** 左栏点击定位：滚动到对应组并短暂高亮（组体 outline + 侧栏 located 态）。
 *  注意：快速连点不同条目时必须立即清掉上一个目标的高亮——
 *  若只靠单个共享定时器，前一个的清除会被覆盖，多个组同时亮着。 */
const locateState = { el: null, t: 0 };
function locateGroup(gid) {
  locatedGid = gid;
  for (const item of ui.sideList.querySelectorAll('.st-side-item')) {
    item.classList.toggle('located', Number(item.dataset.group) === gid);
  }
  const target = ui.crashGroups.querySelector(`.tg-group[data-group="${gid}"]`);
  if (!target) return;
  if (locateState.el && locateState.el !== target) locateState.el.classList.remove('located');
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.classList.add('located');
  locateState.el = target;
  clearTimeout(locateState.t);
  locateState.t = setTimeout(() => {
    target.classList.remove('located');
    if (locateState.el === target) locateState.el = null;
  }, 2000);
}

// ---------------------------------------------------------------- 右键菜单
// 左栏存档组条目的右键菜单（与书签页右键菜单同款交互：点菜单内不关闭、
// 点击外部 / Esc 关闭、贴边自动收进视口）。

let ctxMenu = null;

function closeContextMenu() {
  if (!ctxMenu) return;
  ctxMenu.remove();
  ctxMenu = null;
  document.removeEventListener('mousedown', closeCtxOnDown, true);
  document.removeEventListener('keydown', closeCtxOnKey, true);
}
function closeCtxOnDown(e) {
  // 点在菜单内部不关闭——否则 mousedown 先移除菜单，click 永远落不到菜单项上
  if (ctxMenu && e.target instanceof Node && ctxMenu.contains(e.target)) return;
  closeContextMenu();
}
function closeCtxOnKey(e) { if (e.key === 'Escape') closeContextMenu(); }

/** 就地折叠/展开某组（供组头点击与右键菜单共用）。 */
function toggleCollapse(gid) {
  const collapsed = !collapsedGroups.has(gid);
  if (collapsed) collapsedGroups.add(gid); else collapsedGroups.delete(gid);
  const group = ui.crashGroups.querySelector(`.tg-group[data-group="${gid}"]`);
  const caret = group?.querySelector('[data-act="cgCollapse"]');
  if (caret) {
    caret.textContent = collapsed ? '▸' : '▾';
    caret.title = collapsed ? '展开' : '折叠';
  }
  const body = group?.querySelector('.tg-group-body');
  if (body) body.hidden = collapsed;
}

function openGroupContextMenu(e, gid) {
  closeContextMenu();
  const items = [
    { label: '🎯 定位到该组', run: () => locateGroup(gid) },
    { label: '整组恢复', run: () => restoreGroup(gid).catch((err) => toast('恢复失败：' + (err?.message || err), true)) },
    { label: collapsedGroups.has(gid) ? '▸ 展开' : '▾ 折叠', run: () => toggleCollapse(gid) },
    { sep: true },
    {
      label: '🗑 删除该组…', danger: true,
      run: async () => {
        const ok = await confirmDialog({
          title: '删除存档组',
          message: '删除这一组"未正常关闭"存档？\n删除后无法找回（组内的标签页可以先用「整组恢复」打开再删）。',
          confirmText: '删除', danger: true,
        });
        if (ok) await deleteGroups([gid]);
      },
    },
  ];
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); continue; }
    const b = document.createElement('div');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', () => { closeContextMenu(); it.run(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - r.height - 8)) + 'px';
  ctxMenu = menu;
  // 右键的 mousedown 已发生完毕，下一帧再挂全局关闭监听，避免菜单立即自关
  setTimeout(() => {
    document.addEventListener('mousedown', closeCtxOnDown, true);
    document.addEventListener('keydown', closeCtxOnKey, true);
  });
}

async function onDeleteSelected() {
  const names = [...ui.crashGroups.querySelectorAll('.tg-check:checked')]
    .map((b) => Number(b.dataset.group));
  if (!names.length) return;
  const ok = await confirmDialog({
    title: '删除选中的存档',
    message: `删除选中的 ${names.length} 组"未正常关闭"存档？\n删除后无法找回（组内的标签页可以先用「整组恢复」打开再删）。`,
    confirmText: '删除选中', danger: true,
  });
  if (ok) await deleteGroups(names);
}

function bindEvents() {
  // 左栏：点击定位到对应组；右键弹组操作菜单
  ui.sideList.addEventListener('click', (e) => {
    const item = e.target.closest('.st-side-item');
    if (item) locateGroup(Number(item.dataset.group));
  });
  ui.sideList.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.st-side-item');
    if (!item) return;
    e.preventDefault();
    openGroupContextMenu(e, Number(item.dataset.group));
  });

  ui.crashGroups.addEventListener('click', (e) => {
    // 折叠/展开：就地切换（caret 文字 + body 显隐），不重绘
    const caret = e.target.closest('[data-act="cgCollapse"]');
    if (caret) { toggleCollapse(Number(caret.dataset.group)); return; }
    // 点组头"身体"（非按钮/勾选框区域）也能折叠/展开
    const head = e.target.closest('.tg-group-head');
    if (head && !e.target.closest('button, input, .tg-check, .tg-restore')) {
      const group = head.closest('.tg-group');
      if (group) toggleCollapse(Number(group.dataset.group));
      return;
    }
    const restore = e.target.closest('.tg-restore');
    if (restore) { restoreGroup(Number(restore.dataset.group)).catch((err) => toast('恢复失败：' + (err?.message || err), true)); return; }
    const row = e.target.closest('.tg-row');
    if (!row) return;
    if (e.target.closest('.tg-open')) {
      const url = row.dataset.url;
      if (url) chrome.tabs.create({ url });
    }
  });
  // 勾选（change 事件不冒泡到 click 里处理，单独绑）
  ui.crashGroups.addEventListener('change', (e) => {
    const box = e.target.closest('.tg-check');
    if (!box) return;
    const gid = Number(box.dataset.group);
    if (box.checked) checkedIds.add(gid); else checkedIds.delete(gid);
    ui.delSel.disabled = !checkedIds.size;
    const boxes = [...ui.crashGroups.querySelectorAll('.tg-check')];
    ui.selAll.checked = boxes.every((b) => b.checked);
  });
  ui.selAll.addEventListener('change', () => {
    ui.crashGroups.querySelectorAll('.tg-check').forEach((b) => {
      b.checked = ui.selAll.checked;
      const gid = Number(b.dataset.group);
      if (ui.selAll.checked) checkedIds.add(gid); else checkedIds.delete(gid);
    });
    ui.delSel.disabled = !checkedIds.size;
  });
  ui.delSel.addEventListener('click', () => onDeleteSelected().catch((err) => toast('删除失败：' + (err?.message || err), true)));

  // 后台数据变化（新增存档 / 其它页删除）→ 防抖重绘
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(CRASH_KEY in changes)) return;
    if (!document.getElementById('view-tabs')?.classList.contains('active')) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(repaint, 300);
  });

  // 图标加载失败时隐藏，避免裂图
  container.addEventListener('error', (e) => {
    if (e.target.tagName === 'IMG') e.target.style.display = 'none';
  }, true);
}

export async function render(el) {
  container = el;
  if (!built) {
    buildSkeleton();
    bindEvents();
  }
  await repaint();
}
