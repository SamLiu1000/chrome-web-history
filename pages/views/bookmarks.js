// 书签管理视图：以文件夹树管理 Chrome 原生书签 —— 与 ★ 收藏是同一数据源，
// 所有增删改直接落在浏览器书签里（chrome.bookmarks），不维护第二套存储。
// 左栏：可折叠文件夹树（新建子文件夹 / 重命名 / 删除 / 拖拽移动）；
// 右栏：当前文件夹内容（子文件夹 + 书签），或搜索结果的平铺列表（带路径）。

import { debounce, displayPath, escapeHtml, faviconUrl, formatDateTime, setInnerHTML } from '../../lib/util.js';
import { applyBookmarkTimeOverrides } from '../../lib/bookmarks.js';
import { toast } from '../dashboard.js';

let nodeMap = new Map();     // id -> 节点（含文件夹与书签）
let selectedId = '1';        // 右栏当前显示的文件夹（默认书签栏）
let expanded = new Set(['1']); // 已展开的文件夹 id
let filterText = '';
let dragInfo = null;         // { id, isFolder }
let dropTargetId = null;
// 书签拖拽帧管道：dragover 是最高频事件，重活全部延后到 rAF 每帧一次。
// 此前每个 dragover 都做 3 次全树 querySelectorAll + getBoundingClientRect
// 强制回流，树一大拖几秒就卡死——与收纳页拖拽（几何缓存+帧内命中）对齐
let dragFramePending = false;
let dragPos = { x: 0, y: 0 };
let dragMark = null, dragMarkCls = '';   // 当前带落点标记的行（增量更新，免全树扫描）
let dragHit = null;                      // 上帧命中 { row, mode }（未变则整帧跳过）
let dragRectRow = null, dragRect = null; // 行几何缓存（拖拽中树不动，行不变不重测）
let dragIndLine = null;                  // 插入指示线（.st-drag-ind-line，与收纳页同款）
const checked = new Set();   // 勾选的条目 id（用于批量复制/移动）
let displayedIds = [];       // 右栏当前显示的条目 id（全选/反选的范围）
let editMode = false;        // 批量编辑模式：显示勾选框，行点击改为勾选
let ctxMenu = null;          // 当前打开的右键菜单元素

const isFolder = (n) => !n.url;

function pathOf(id) {
  const parts = [];
  let cur = nodeMap.get(id);
  // depth 上限：防御异常数据导致的环（正常书签树 parentId 链必终止于根）
  let depth = 0;
  while (cur && cur.id !== '0' && depth++ < 64) {
    parts.unshift(cur.title || '（未命名）');
    cur = nodeMap.get(cur.parentId);
  }
  return parts.join('/');
}

/** maybeAncestorId 是否为 id 的祖先（用于禁止把文件夹拖进自己内部）。 */
function isDescendant(id, maybeAncestorId) {
  let cur = nodeMap.get(id);
  while (cur && cur.parentId) {
    if (cur.parentId === maybeAncestorId) return true;
    cur = nodeMap.get(cur.parentId);
  }
  return false;
}

export async function render(container) {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove()); // 清掉上次渲染遗留的菜单
  ctxMenu = null;
  setInnerHTML(container, `
    <div class="filters">
      <div class="filter-row">
        <input type="search" id="bmSearch" placeholder="搜索书签（标题 / 网址）…" style="flex:1; min-width:160px;">
        <button class="btn" id="bmNewFolder" title="在当前选中的文件夹下新建子文件夹">＋ 新建文件夹</button>
        <button class="btn" id="bmOpenAll" title="在新标签页打开当前文件夹里的全部书签">打开全部</button>
        <button class="btn" id="bmImport" title="从浏览器导出的书签 HTML 文件导入（Chrome/Edge 书签管理器均可导出）">导入 HTML</button>
        <button class="btn" id="bmExport" title="把全部书签（书签栏 + 其他书签）导出为书签 HTML 文件，可导入任意浏览器">导出 HTML</button>
        <input type="file" id="bmImportFile" accept=".html,.htm,text/html" hidden>
      </div>
      <div class="filter-row" style="align-items:center;">
        <button class="btn small" id="bmEdit" title="进入批量编辑模式：显示勾选框，可全选/反选后批量复制或移动">编辑</button>
        <span id="bmBatchBtns" hidden>
          <button class="btn small" id="bmSelAll" title="勾选当前显示的全部条目">全选</button>
          <button class="btn small" id="bmSelInv" title="反向勾选当前显示的条目">反选</button>
          <button class="btn small" id="bmCopy" title="把勾选的条目复制到其它文件夹">复制到…</button>
          <button class="btn small" id="bmMove" title="把勾选的条目移动到其它文件夹">移动到…</button>
          <span class="muted" id="bmSelInfo" style="font-size:12px;"></span>
        </span>
        <button class="btn small" id="bmDomain" title="把某个域名的书签批量替换为新域名（路径保持不变）">替换域名…</button>
      </div>
    </div>
    <div class="result-summary"><span id="bmSummary"></span></div>
    <div class="site-split">
      <div class="site-side" id="bmTreeSide"></div>
      <div class="site-detail" id="bmDetail"></div>
    </div>
  `);

  const treeSide = container.querySelector('#bmTreeSide');
  const detail = container.querySelector('#bmDetail');
  const summary = container.querySelector('#bmSummary');
  const searchEl = container.querySelector('#bmSearch');
  searchEl.value = filterText;
  searchEl.addEventListener('input', debounce(() => {
    filterText = searchEl.value.trim();
    renderDetail();
    renderSummary();
  }, 250));
  container.querySelector('#bmNewFolder').addEventListener('click', () => createFolder(selectedId));
  container.querySelector('#bmOpenAll').addEventListener('click', openAllInSelected);
  const importFile = container.querySelector('#bmImportFile');
  container.querySelector('#bmImport').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => importBookmarksHtml(importFile).finally(() => { importFile.value = ''; }));
  container.querySelector('#bmExport').addEventListener('click', () => exportBookmarksHtml());
  container.querySelector('#bmSelAll').addEventListener('click', () => {
    displayedIds.forEach((id) => checked.add(id));
    syncChecks();
  });
  container.querySelector('#bmSelInv').addEventListener('click', () => {
    displayedIds.forEach((id) => (checked.has(id) ? checked.delete(id) : checked.add(id)));
    syncChecks();
  });
  container.querySelector('#bmCopy').addEventListener('click', () => openTransferDialog('copy'));
  container.querySelector('#bmMove').addEventListener('click', () => openTransferDialog('move'));
  container.querySelector('#bmDomain').addEventListener('click', openDomainDialog);
  container.querySelector('#bmEdit').addEventListener('click', () => {
    editMode = !editMode;
    if (!editMode) { checked.clear(); }
    applyEditMode();
    syncChecks();
  });
  applyEditMode();

  // ---- 左栏：树 ----
  treeSide.addEventListener('click', (e) => {
    const twist = e.target.closest('[data-twist]');
    if (twist) {
      const id = twist.closest('.bm-node').dataset.id;
      expanded.has(id) ? expanded.delete(id) : expanded.add(id);
      renderTree();
      return;
    }
    handleRowClick(e, treeSide);
  });
  treeSide.addEventListener('dblclick', (e) => {
    // 双击空白处（非行）不处理；双击文件夹行 = 折叠/展开
    const row = e.target.closest('.bm-row[data-id]');
    if (!row || e.target.closest('[data-twist], [data-act]')) return;
    const n = nodeMap.get(row.dataset.id);
    if (n && isFolder(n)) {
      expanded.has(n.id) ? expanded.delete(n.id) : expanded.add(n.id);
      renderTree();
    }
  });
  wireDrag(treeSide);

  // ---- 右栏：内容 / 搜索结果 ----
  detail.addEventListener('click', (e) => handleRowClick(e, detail));
  detail.addEventListener('change', (e) => {
    const cb = e.target.closest('.bm-check');
    if (!cb) return;
    if (cb.checked) checked.add(cb.dataset.id); else checked.delete(cb.dataset.id);
    cb.closest('.site-item')?.classList.toggle('checked', cb.checked);
    updateSelInfo();
  });
  wireDrag(detail);
  treeSide.addEventListener('contextmenu', rowContextMenu);
  detail.addEventListener('contextmenu', rowContextMenu);

  async function refresh() {
    try {
      const tree = await chrome.bookmarks.getTree();
      nodeMap = new Map();
      const walk = (n) => { nodeMap.set(n.id, n); (n.children || []).forEach(walk); };
      walk(tree[0]);
      for (const id of [...checked]) if (!nodeMap.has(id)) checked.delete(id); // 清掉已不存在的勾选
      if (!nodeMap.has(selectedId)) {
        selectedId = nodeMap.get('1') ? '1' : (tree[0].children?.[0]?.id || '1');
      }
      if (filterText) expanded.add(selectedId);
    } catch (e) {
      summary.textContent = '读取书签失败：' + (e?.message || e);
      return;
    }
    renderTree();
    renderDetail();
    renderSummary();
  }

  function renderTree() {
    const rootKids = (nodeMap.get('0')?.children || []).filter(isFolder);
    treeSide.innerHTML = rootKids.map((n) => folderNodeHtml(n)).join('')
      || '<div class="empty-tip">没有文件夹</div>';
  }

  function folderNodeHtml(n) {
    const kids = (n.children || []).filter(isFolder);
    const isOpen = expanded.has(n.id);
    const sel = n.id === selectedId ? ' on' : '';
    return `
    <div class="bm-node" data-id="${n.id}">
      <div class="site-item bm-row${sel}" draggable="true" data-id="${n.id}" title="${escapeHtml(pathOf(n.id))}">
        <span class="bm-twist${kids.length ? '' : ' leaf'}" data-twist="1">${isOpen ? '▾' : '▸'}</span>
        <span class="bm-ico">${isOpen && kids.length ? '📂' : '📁'}</span>
        <span class="si-name">${escapeHtml(n.title || '（未命名）')}</span>
        <span class="si-meta">${(n.children || []).length}</span>
      </div>
      ${kids.length ? `<div class="bm-kids" ${isOpen ? '' : 'hidden'}>${kids.map((c) => folderNodeHtml(c)).join('')}</div>` : ''}
    </div>`;
  }

  function bookmarkRowHtml(n, withPath = false) {
    return `
    <div class="site-item bm-row${checked.has(n.id) ? ' checked' : ''}" draggable="true" data-id="${n.id}" title="${escapeHtml(n.url || '')}">
      <input type="checkbox" class="bm-check" data-id="${n.id}" ${checked.has(n.id) ? 'checked' : ''} title="选中（可批量复制/移动）">
      <img class="vicon" src="${faviconUrl(n.url || '', 16)}" alt="">
      <span class="si-name bm-name">${escapeHtml(n.title || n.url || '（未命名）')}</span>
      ${withPath ? `<span class="si-meta bm-path" title="${escapeHtml(pathOf(n.parentId))}">${escapeHtml(pathOf(n.parentId))}</span>` : ''}
      <span class="si-meta bm-url">${escapeHtml(displayPath(n.url || ''))}</span>
    </div>`;
  }

  function flatFolderRowHtml(n) {
    return `
    <div class="site-item bm-row${checked.has(n.id) ? ' checked' : ''}" draggable="true" data-id="${n.id}" title="${escapeHtml(pathOf(n.id))}">
      <input type="checkbox" class="bm-check" data-id="${n.id}" ${checked.has(n.id) ? 'checked' : ''} title="选中（可批量复制/移动）">
      <span class="bm-ico">📁</span>
      <span class="si-name">${escapeHtml(n.title || '（未命名）')}</span>
      <span class="si-meta">${(n.children || []).length}</span>
    </div>`;
  }

  async function renderDetail() {
    if (filterText) {
      let hits = [];
      try { hits = await chrome.bookmarks.search(filterText); } catch { /* 搜索失败按空处理 */ }
      const rows = hits.filter((h) => h.url && nodeMap.has(h.id)).slice(0, 500);
      displayedIds = rows.map((n) => n.id);
      detail.innerHTML = `
        <div class="sd-head"><span class="sd-name">搜索"${escapeHtml(filterText)}"</span>
          <span class="sd-meta">${rows.length} 条结果（最多显示 500 条）</span></div>
        ${rows.map((n) => bookmarkRowHtml(n, true)).join('')}
        ${rows.length ? '' : '<div class="empty-tip">没有匹配的书签</div>'}`;
      return;
    }
    const n = nodeMap.get(selectedId);
    if (!n) { detail.innerHTML = '<div class="empty-tip">请选择一个文件夹</div>'; displayedIds = []; return; }
    // 混排渲染：严格保留 Chrome 原生 children 顺序（书签和文件夹可以交错），
    // 不再按类型拆成"文件夹区 + 书签区"两段——那会凭空重排用户在书签管理器
    // 里的排列，也导致拖拽落点(index)与视觉位置对不上。
    const kids = n.children || [];
    const folders = kids.filter(isFolder);
    const bks = kids.filter((c) => c.url);
    displayedIds = kids.map((c) => c.id);
    detail.innerHTML = `
      <div class="sd-head">
        <span class="sd-name">📁 ${escapeHtml(pathOf(n.id) || n.title)}</span>
        <span class="sd-meta">${bks.length} 个书签 · ${folders.length} 个子文件夹</span>
      </div>
      ${kids.map((c) => (isFolder(c) ? flatFolderRowHtml(c) : bookmarkRowHtml(c))).join('')}
      ${kids.length ? '' : '<div class="empty-tip">此文件夹是空的。点击上方"＋ 新建文件夹"，或在其它视图里点 ★ 收藏网址。</div>'}`;
  }

  function renderSummary() {
    if (filterText) return; // 搜索时结果数已在右栏头部
    let bk = 0, fd = 0;
    for (const n of nodeMap.values()) {
      if (n.id === '0') continue;
      n.url ? bk++ : fd++;
    }
    summary.textContent = `共 ${bk.toLocaleString()} 个书签 · ${fd.toLocaleString()} 个文件夹`;
  }

  // ------------------------------------------------------------ 行为

  function handleRowClick(e, scope) {
    if (e.target.closest('.bm-check')) return; // 复选框由 change 事件处理，避免触发打开/切换
    // 编辑模式下，右栏点击行 = 切换勾选（不打开/不跳转），文件夹树仍正常导航
    if (editMode && scope === detail) {
      const row = e.target.closest('.site-item[data-id]');
      if (row) {
        const id = row.dataset.id;
        checked.has(id) ? checked.delete(id) : checked.add(id);
        syncChecks();
      }
      return;
    }
    const row = e.target.closest('.bm-row[data-id]');
    if (!row) return;
    const n = nodeMap.get(row.dataset.id);
    if (!n) return;
    if (isFolder(n)) {
      selectedId = n.id;
      expanded.add(n.id);
      renderTree();
      renderDetail();
    } else {
      chrome.tabs.create({ url: n.url }).catch(() => {});
    }
  }

  async function doAction(act, id, scope) {
    const n = nodeMap.get(id);
    if (!n) return;
    try {
      if (act === 'add') {
        await createFolder(id);
      } else if (act === 'ren') {
        const t = prompt('重命名', n.title || '');
        if (t == null) return;
        const title = t.trim();
        if (!title || title === n.title) return;
        const changes = { title };
        if (n.url) {
          const u = prompt('网址（留空保持不变）', n.url);
          if (u == null) return;
          const url = u.trim();
          if (url && url !== n.url) changes.url = url;
        }
        await chrome.bookmarks.update(id, changes);
        toast('已保存');
        await refresh();
      } else if (act === 'del') {
        if (isFolder(n)) {
          if (!confirm(`删除文件夹"${n.title || '（未命名）'}"及其全部内容？不可恢复。`)) return;
          await chrome.bookmarks.removeTree(id);
          if (selectedId === id || isDescendant(selectedId, id)) selectedId = n.parentId || '1';
        } else {
          if (!confirm(`删除书签"${n.title || n.url}"？`)) return;
          await chrome.bookmarks.remove(id);
        }
        toast('已删除');
        await refresh();
      }
    } catch (e) {
      toast((act === 'del' ? '删除失败' : '操作失败') + '：' + (e?.message || e), true);
    }
  }

  async function createFolder(parentId) {
    const name = prompt(`在"${pathOf(parentId) || '书签栏'}"下新建文件夹：`, '新建文件夹');
    if (name == null) return;
    const title = name.trim();
    if (!title) return;
    try {
      const created = await chrome.bookmarks.create({ parentId, title });
      selectedId = created.id;
      expanded.add(parentId);
      filterText = '';
      const searchEl = container.querySelector('#bmSearch');
      if (searchEl) searchEl.value = '';
      await refresh();
    } catch (e) {
      toast('创建失败：' + (e?.message || e), true);
    }
  }

  function openAllInSelected() { openFolderBookmarks(nodeMap.get(selectedId)); }

  function openFolderBookmarks(n) {
    const bks = (n?.children || []).filter((c) => c.url);
    if (!bks.length) { toast('该文件夹里没有书签', true); return; }
    for (const b of bks) chrome.tabs.create({ url: b.url, active: false }).catch(() => {});
    toast(`已在新标签页打开 ${bks.length} 个书签`);
  }

  // ---------------------------------------------------------- 右键菜单

  function closeContextMenu() {
    if (!ctxMenu) return;
    ctxMenu.remove();
    ctxMenu = null;
    document.removeEventListener('mousedown', closeCtxOnDown, true);
    document.removeEventListener('keydown', closeCtxOnKey, true);
  }
  function closeCtxOnDown(e) {
    // 点在菜单内部不关闭——否则 mousedown 先移除菜单，click 永远落不到菜单项上，
    // 所有菜单项(删除/重命名/打开全部…)都会"点了没反应"
    if (ctxMenu && e.target instanceof Node && ctxMenu.contains(e.target)) return;
    closeContextMenu();
  }
  function closeCtxOnKey(e) { if (e.key === 'Escape') closeContextMenu(); }

  function rowContextMenu(e) {
    const row = e.target.closest('.bm-row[data-id]');
    if (!row) return;
    const n = nodeMap.get(row.dataset.id);
    if (!n) return;
    e.preventDefault();
    openContextMenu(e, n);
  }

  function openContextMenu(e, n) {
    closeContextMenu();
    const items = [];
    if (isFolder(n)) {
      items.push({ label: '打开全部', run: () => openFolderBookmarks(n) });
      items.push({ label: '新建子文件夹', run: () => createFolder(n.id) });
    } else {
      items.push({ label: '打开', run: () => chrome.tabs.create({ url: n.url }).catch(() => {}) });
    }
    items.push({ sep: true });
    items.push({ label: '重命名', run: () => doAction('ren', n.id) });
    items.push({ label: '删除', run: () => doAction('del', n.id) });
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    for (const it of items) {
      if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); continue; }
      const b = document.createElement('div');
      b.className = 'ctx-item';
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

  // ---------------------------------------------------------- 多选与批量转移

  function updateSelInfo() {
    const el = container.querySelector('#bmSelInfo');
    if (el) el.textContent = checked.size ? `已选 ${checked.size} 项` : '';
  }

  /** 应用编辑模式状态：按钮文字、批量按钮显隐、勾选框显隐。 */
  function applyEditMode() {
    container.classList.toggle('bm-editing', editMode);
    const btn = container.querySelector('#bmEdit');
    const batch = container.querySelector('#bmBatchBtns');
    if (btn) {
      btn.textContent = editMode ? '完成' : '编辑';
      btn.classList.toggle('primary', editMode);
    }
    if (batch) batch.hidden = !editMode;
  }

  function syncChecks() {
    for (const li of container.querySelectorAll('.site-item[data-id]')) {
      const cb = li.querySelector('.bm-check');
      const on = checked.has(li.dataset.id);
      if (cb) cb.checked = on;
      li.classList.toggle('checked', on);
    }
    updateSelInfo();
  }

  /** 简易弹窗（复用书签对话框样式），返回 { overlay, close }。 */
  function openBmDialog(title, bodyHtml) {
    const overlay = document.createElement('div');
    overlay.className = 'bm-overlay';
    overlay.innerHTML = `<div class="bm-dialog"><div class="bm-title">${escapeHtml(title)}</div>${bodyHtml}</div>`;
    document.body.appendChild(overlay);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);
    return { overlay, close };
  }

  /** ids 及其全部子孙 id（防止把文件夹移动/复制进自己内部）。 */
  function withDescendants(ids) {
    const out = new Set();
    const mark = (id) => {
      out.add(id);
      for (const c of nodeMap.get(id)?.children || []) mark(c.id);
    };
    ids.forEach(mark);
    return out;
  }

  /** 递归复制节点子树到目标文件夹。 */
  async function copyNodes(nodes, parentId) {
    for (const n of nodes) {
      if (!n) continue;
      if (isFolder(n)) {
        const folder = await chrome.bookmarks.create({ parentId, title: n.title || '（未命名）' });
        await copyNodes(n.children || [], folder.id);
      } else {
        await chrome.bookmarks.create({ parentId, title: n.title || n.url, url: n.url });
      }
    }
  }

  function openTransferDialog(mode) {
    const ids = [...checked].filter((id) => nodeMap.has(id));
    if (!ids.length) { toast('请先勾选要转移的条目', true); return; }
    const exclude = withDescendants(ids); // 目标不能是自己或自己的子孙
    let opts = '';
    const walk = (node, depth) => {
      if (!exclude.has(node.id)) {
        opts += `<option value="${node.id}" ${node.id === selectedId ? 'selected' : ''}>${'　'.repeat(depth)}${escapeHtml(pathOf(node.id))}</option>`;
      }
      for (const c of node.children || []) if (isFolder(c)) walk(c, depth + 1);
    };
    for (const r of (nodeMap.get('0')?.children || []).filter(isFolder)) walk(r, 0);
    const verb = mode === 'copy' ? '复制' : '移动';
    const { overlay, close } = openBmDialog(`${verb} ${ids.length} 项到…`, `
      <label class="bm-label">目标文件夹</label>
      <select class="bm-input" id="bmTargetSel" size="12">${opts}</select>
      <div class="bm-actions">
        <button class="btn" id="bmDlgCancel">取消</button>
        <button class="btn primary" id="bmDlgOk">${verb}</button>
      </div>`);
    const sel = overlay.querySelector('#bmTargetSel');
    if (exclude.has(selectedId)) sel.value = sel.options[0]?.value ?? '';
    overlay.querySelector('#bmDlgCancel').addEventListener('click', close);
    overlay.querySelector('#bmDlgOk').addEventListener('click', async () => {
      const target = sel.value;
      if (!target || exclude.has(target)) return;
      close();
      let ok = 0, failed = 0;
      for (const id of ids) {
        try {
          if (mode === 'move') await chrome.bookmarks.move(id, { parentId: target });
          else await copyNodes([nodeMap.get(id)], target);
          ok++;
        } catch { failed++; }
      }
      checked.clear();
      updateSelInfo();
      await refresh();
      toast(`${verb}完成：${ok} 项${failed ? `，${failed} 项失败` : ''}`);
    });
  }

  // ---------------------------------------------------------- 批量替换域名

  function openDomainDialog() {
    const { overlay, close } = openBmDialog('替换域名', `
      <label class="bm-label">旧域名（只填域名本身，含子域名一并匹配）</label>
      <input type="text" class="bm-input" id="bmOldDomain" placeholder="old.example.com">
      <label class="bm-label">新域名（书签路径保持不变）</label>
      <input type="text" class="bm-input" id="bmNewDomain" placeholder="new.example.com">
      <label class="bm-label" style="display:flex; align-items:center; gap:6px; cursor:pointer;">
        <input type="checkbox" id="bmDomScope" style="margin:0;"> 仅当前文件夹（含子文件夹）
      </label>
      <div class="bm-actions">
        <button class="btn" id="bmDlgCancel">取消</button>
        <button class="btn primary" id="bmDlgOk">替换</button>
      </div>`);
    const oldInput = overlay.querySelector('#bmOldDomain');
    overlay.querySelector('#bmDlgCancel').addEventListener('click', close);
    overlay.querySelector('#bmDlgOk').addEventListener('click', async () => {
      const norm = (v) => v.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/\.+$/, '');
      const oldD = norm(oldInput.value);
      const newD = norm(overlay.querySelector('#bmNewDomain').value);
      if (!oldD || !newD) { toast('请填写旧域名和新域名', true); return; }
      if (oldD === newD) { toast('新旧域名相同', true); return; }
      const scoped = overlay.querySelector('#bmDomScope').checked && nodeMap.has(selectedId);
      const inScope = (id) => !scoped || id === selectedId || isDescendant(id, selectedId);
      const hostOf = (url) => { try { return new URL(url).hostname; } catch { return null; } };
      const matches = [...nodeMap.values()].filter((n) => {
        if (!n.url || !inScope(n.id)) return false;
        const h = hostOf(n.url);
        return h === oldD || h.endsWith('.' + oldD);
      });
      if (!matches.length) { toast(`没有找到 ${oldD}（含子域名）的书签`, true); return; }
      if (!confirm(`找到 ${matches.length} 条 ${oldD}（含子域名）的书签，将把域名替换为 ${newD}，路径保持不变。\n确定替换？`)) return;
      close();
      let ok = 0, failed = 0;
      for (const n of matches) {
        try {
          const u = new URL(n.url);
          const h = u.hostname;
          // 精确匹配整域替换；子域名只替换后缀，保留前缀（mail.old.com -> mail.new.com）
          u.hostname = h === oldD ? newD : h.slice(0, h.length - oldD.length) + newD;
          await chrome.bookmarks.update(n.id, { url: u.href });
          ok++;
        } catch { failed++; }
      }
      await refresh();
      toast(`已替换 ${ok} 条书签的域名${failed ? `，${failed} 条失败` : ''}`);
    });
    oldInput.focus();
  }

  // ---------------------------------------------------------- 书签 HTML 导出

  /** 把 chrome.bookmarks 整树导出为 Netscape 书签 HTML（浏览器通用格式，
   *  Chrome/Edge/Firefox 的"导入书签"都能直接吃）。顶层按"书签栏/其他书签"分组。 */
  async function exportBookmarksHtml() {
    const btn = container.querySelector('#bmExport');
    btn.disabled = true;
    btn.textContent = '导出中…';
    try {
      const tree = await chrome.bookmarks.getTree();
      // 导出用"原始添加时间"（Chrome 恢复重建后真实字段被重置，扩展侧有映射）
      const orig = await applyBookmarkTimeOverrides(tree[0]?.children || []);
      const esc = (s) => String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const secs = (ms) => Math.floor((ms || Date.now()) / 1000);
      let links = 0, folders = 0;
      const walk = (nodes, pad) => (nodes || []).map((n) => {
        if (n.url) {
          links++;
          return `${pad}<DT><A HREF="${esc(n.url)}" ADD_DATE="${secs(n.dateAdded)}">${esc(n.title)}</A>\n`;
        }
        folders++;
        return `${pad}<DT><H3 ADD_DATE="${secs(n.dateAdded)}">${esc(n.title || '未命名文件夹')}</H3>\n`
          + `${pad}<DL><p>\n${walk(n.children, pad + '    ')}${pad}</DL><p>\n`;
      }).join('');
      const topFolders = orig.map((r) => ({
        title: r.title || '书签',
        children: r.children || [],
        dateAdded: r.dateAdded,
      }));
      const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n`
        + `<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->\n`
        + `<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n`
        + `<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n`
        + topFolders.map((r) => r.children.length || r.title
          ? `    <DT><H3 ADD_DATE="${secs(r.dateAdded)}">${esc(r.title)}</H3>\n`
            + `    <DL><p>\n${walk(r.children, '        ')}    </DL><p>\n`
          : '').join('')
        + `</DL><p>\n`;
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `书签导出_${stamp}.html`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(`导出完成：${links} 个书签、${folders} 个文件夹`);
    } catch (e) {
      toast('导出失败：' + (e?.message || e), true);
    } finally {
      btn.disabled = false;
      btn.textContent = '导出 HTML';
    }
  }

  // ---------------------------------------------------------- 书签 HTML 导入
  //
  // 解析浏览器导出的 Netscape 书签格式（Chrome/Edge 的"导出书签"产物），
  // 整棵树写入 chrome.bookmarks：在书签栏下自动新建"导入的书签 <时间>"文件夹归类。

  /** Netscape 书签 HTML -> 节点树 [{type:'folder'|'link', title, url?, children?}] */
  function parseBookmarksHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const convertDl = (dl) => {
      const nodes = [];
      if (!dl) return nodes;
      for (const dt of dl.children) {
        if (dt.tagName !== 'DT') continue;
        const a = dt.querySelector(':scope > a[href]');
        const h3 = dt.querySelector(':scope > h3');
        if (a) {
          const url = a.getAttribute('href');
          if (url && !url.startsWith('place:')) {
            nodes.push({ type: 'link', title: (a.textContent || '').trim(), url });
          }
        } else if (h3) {
          nodes.push({
            type: 'folder',
            title: (h3.textContent || '').trim() || '未命名文件夹',
            children: convertDl(dt.querySelector(':scope > dl')),
          });
        }
      }
      return nodes;
    };
    return convertDl(doc.querySelector('dl'));
  }

  function countNodes(nodes, acc = { links: 0, folders: 0 }) {
    for (const n of nodes) {
      if (n.type === 'folder') { acc.folders++; countNodes(n.children, acc); }
      else acc.links++;
    }
    return acc;
  }

  async function createImportedNodes(nodes, parentId) {
    let failed = 0;
    for (const n of nodes) {
      try {
        if (n.type === 'folder') {
          const folder = await chrome.bookmarks.create({ parentId, title: n.title });
          failed += await createImportedNodes(n.children, folder.id);
        } else {
          await chrome.bookmarks.create({ parentId, title: n.title || n.url, url: n.url });
        }
      } catch {
        failed++; // 单条失败（如非法 URL）不中断整体导入
      }
    }
    return failed;
  }

  /** 按文件自身编码解码为文本。
   *  顺序：BOM（UTF-16）→ <meta charset> 声明 → 严格 UTF-8 校验 → 回退 GBK
   *  （gb2312/gbk 家族由 TextDecoder 的 gbk 解码器覆盖；老浏览器导出常见 GB2312）。 */
  async function decodeFileText(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
    // meta 里的 charset 声明是 ASCII，任何单字节编码下都能原样读出
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
    const declared = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
    if (declared && !/^utf-?8$/.test(declared)) {
      try {
        return new TextDecoder(declared, { fatal: true }).decode(buf);
      } catch { /* 声明的编码不受支持（或声明有误）则继续探测 */ }
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf); // 严格模式：GB2312 字节流必然报错
    } catch {
      try { return new TextDecoder('gbk').decode(buf); } // GB2312/GBK 回退
      catch { return new TextDecoder('utf-8').decode(buf); }
    }
  }

  async function importBookmarksHtml(fileInput) {
    const file = fileInput.files?.[0];
    if (!file) return;
    const importBtn = container.querySelector('#bmImport');
    importBtn.disabled = true;
    importBtn.textContent = '导入中…';
    try {
      const nodes = parseBookmarksHtml(await decodeFileText(file));
      const stats = countNodes(nodes);
      if (!stats.links && !stats.folders) { toast('文件里没有找到书签', true); return; }
      const folderName = `导入的书签 ${formatDateTime(Date.now())}`;
      let root;
      try {
        root = await chrome.bookmarks.create({ parentId: '1', title: folderName }); // 书签栏
      } catch {
        root = await chrome.bookmarks.create({ parentId: '2', title: folderName }); // 兜底：其他书签
      }
      const failed = await createImportedNodes(nodes, root.id);
      selectedId = root.id;
      expanded.add(root.parentId);
      filterText = '';
      const searchEl = container.querySelector('#bmSearch');
      if (searchEl) searchEl.value = '';
      await refresh();
      toast(`导入完成：${stats.links} 个书签、${stats.folders} 个文件夹已放入"${folderName}"`
        + (failed ? `（${failed} 项失败跳过）` : ''));
    } catch (e) {
      toast('导入失败：' + (e?.message || e), true);
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = '导入 HTML';
    }
  }

  // ------------------------------------------------------------ 拖拽移动
  //
  // 对齐收纳页(OneTab 式)的拖拽体验：
  //  - 光标幽灵跟随指针(复用收纳页 .st-drag-ghost 样式)；
  //  - 文件夹行三分区：上 25% 插到它前面 / 下 25% 插到它后面 / 中间移入它(成为其子级,层级改变)；
  //  - 书签行二分区：上半插到前面 / 下半插到后面(右栏内也能重排书签)；
  //  - 编辑模式勾选多项时拖其中一项 = 整批按顺序插入(收纳页同逻辑)；
  //  - 全部走 chrome.bookmarks.move 落库；Esc 取消由 dragend 兜底恢复。

  const DRAG_ROOT_IDS = new Set(['0', '1', '2']); // Chrome 根节点不可移动/重排

  /** 计算 id 移入 parentId 中 anchorId(前/后)应传给 chrome.bookmarks.move 的 index。
   *  返回 null = 位置未变(无需落库)。
   *  关键：Chromium BookmarkModel::Move 的 index 以"被移动项仍在列表中"的当前列表为基准，
   *  同父级向下移动时浏览器自己会 index--，这里绝不能再做 -1 补偿(会双重调整导致落点偏移)。 */
  async function moveSlotIndex(id, parentId, anchorId, before) {
    const kids = await chrome.bookmarks.getChildren(parentId);
    let idx;
    if (anchorId == null) {
      idx = kids.length; // 末尾
    } else {
      const ai = kids.findIndex((k) => k.id === anchorId);
      if (ai < 0) return null;
      idx = before ? ai : ai + 1;
    }
    const di = kids.findIndex((k) => k.id === id);
    if (di !== -1 && (idx === di || idx === di + 1)) return null; // 位置未变(与 Chromium 判定一致)
    return idx;
  }

  function moveDragGhost(x, y) {
    if (dragInfo?.ghost) {
      // transform 走合成器路径（left/top 每次都强制回流），高频跟随零布局
      dragInfo.ghost.style.transform = `translate(${x + 14}px, ${y + 16}px)`;
    }
  }

  function wireDrag(scope) {
    scope.addEventListener('dragstart', (e) => {
      const row = e.target.closest('[draggable="true"]');
      if (!row) return;
      const n = nodeMap.get(row.dataset.id);
      if (!n || DRAG_ROOT_IDS.has(n.id)) { e.preventDefault(); return; }
      dragInfo = { id: n.id, isFolder: isFolder(n) };
      dropTargetId = null;
      setDragMark(null); dragHit = null; dragRectRow = null; dragRect = null;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // 只设内部自定义类型，不设 text/plain——否则收纳页的全局"外部拖入"监听
      // (dragover 强制 dropEffect='copy')会与本拖拽的 effectAllowed='move' 冲突，
      // 导致 drop 事件根本不触发(排序/合并全部失效)
      try { e.dataTransfer.setData('application/x-webhistory-bm', n.id); } catch { /* 旧内核忽略 */ }
      // 光标幽灵：图标 + 名称，拖动中跟随指针(与收纳页同款观感)
      const ghost = document.createElement('div');
      ghost.className = 'st-drag-ghost';
      if (isFolder(n)) {
        ghost.innerHTML = '<span class="st-ghost-ico">📁</span><span class="st-ghost-txt"></span>';
      } else {
        ghost.innerHTML = `<img class="st-ghost-fav" src="${escapeHtml(faviconUrl(n.url || 'about:blank'))}" alt=""><span class="st-ghost-txt"></span>`;
      }
      ghost.querySelector('.st-ghost-txt').textContent = n.title || n.url || '（未命名）';
      document.body.appendChild(ghost);
      dragInfo.ghost = ghost;
      moveDragGhost(e.clientX, e.clientY);
    });
    scope.addEventListener('dragover', (e) => {
      if (!dragInfo) return;
      // HTML5 DnD 契约：preventDefault/dropEffect 必须在本事件内同步完成，
      // 否则 drop 不会触发——这里只做这两件零成本的事，重活（幽灵跟随、
      // 命中测试、落点标记）全部延后到 rAF 每帧一次
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      dragPos.x = e.clientX;
      dragPos.y = e.clientY;
      if (!dragFramePending) {
        dragFramePending = true;
        requestAnimationFrame(dragFrame);
      }
    });
    scope.addEventListener('drop', async (e) => {
      e.preventDefault();
      const t = dropTargetId;
      const info = dragInfo;
      resetDrag();
      if (!info || !t) return;
      // 整批：编辑模式下勾选多项时拖其中一项 = 批量移动(收纳页同逻辑)
      const ids = (checked.has(info.id) && checked.size > 1)
        ? [...checked].filter((id) => nodeMap.has(id))
        : [info.id];
      const bad = ids.some((id) => {
        const n = nodeMap.get(id);
        if (!n) return true;
        if (t.mode === 'into') return isFolder(n) && (t.targetId === id || isDescendant(t.targetId, id));
        return t.parentId === id || isDescendant(t.parentId, id);
      });
      if (bad) { toast('不能把文件夹移进它自己内部', true); return; }
      try {
        let moved = 0;
        let prevId = null; // before/after 批量：链式插到上一项之后
        for (const id of ids) {
          if (t.mode === 'into') {
            // 移入目标文件夹(层级改变)：追加到末尾
            const idx = await moveSlotIndex(id, t.targetId, null, false);
            if (idx != null) {
              await chrome.bookmarks.move(id, { parentId: t.targetId, index: idx });
              moved++;
            }
          } else {
            const anchorId = prevId ?? t.anchorId;
            const before = prevId == null ? t.before : false;
            const idx = await moveSlotIndex(id, t.parentId, anchorId, before);
            if (idx != null) await chrome.bookmarks.move(id, { parentId: t.parentId, index: idx });
            prevId = id; // 无论是否实际移动，该项已处于链上正确位置
          }
        }
        if (moved) {
          const dest = t.mode === 'into' ? t.targetId : t.parentId;
          expanded.add(dest);
          toast(`已移动 ${moved} 项到"${pathOf(dest)}"`);
        }
        await refresh();
      } catch (err) {
        toast('移动失败：' + (err?.message || err), true);
      }
    });
    scope.addEventListener('dragend', resetDrag);
  }

  /** rAF 帧任务：一帧最多一次幽灵移动 + 命中测试 + 标记更新。
   *  行几何缓存（拖拽中树不动）；命中行/模式未变则整帧跳过标记操作。 */
  function dragFrame() {
    dragFramePending = false;
    if (!dragInfo) return;
    moveDragGhost(dragPos.x, dragPos.y);
    const row = document.elementFromPoint(dragPos.x, dragPos.y)?.closest('.bm-row[data-id]');
    if (!row) { clearHit(); return; }
    const target = nodeMap.get(row.dataset.id);
    if (!target || target.id === dragInfo.id) { clearHit(); return; }
    if (row !== dragRectRow) { dragRectRow = row; dragRect = row.getBoundingClientRect(); }
    const ry = (dragPos.y - dragRect.top) / dragRect.height; // 行内相对位置 0~1
    const folder = isFolder(target);
    // 分区：文件夹行 上25%/下25%/中间50%(合并区要容易命中)；书签行 上半/下半
    const mode = folder
      ? (ry < 0.25 ? 'before' : ry > 0.75 ? 'after' : 'into')
      : (ry < 0.5 ? 'before' : 'after');
    // 落点合法性：插入位置的父母不能是被拖项自己或其子孙；Chrome 根层('0')不可插入
    const parentId = target.parentId;
    let legal = true;
    if (mode === 'into') {
      if (dragInfo.isFolder && isDescendant(target.id, dragInfo.id)) legal = false;
    } else {
      if (!parentId || parentId === '0' || parentId === dragInfo.id || isDescendant(parentId, dragInfo.id)) legal = false;
    }
    if (!legal) { clearHit(); return; }
    dropTargetId = { mode, targetId: target.id, parentId, anchorId: target.id, before: mode === 'before' };
    if (dragHit && dragHit.row === row && dragHit.mode === mode) return; // 命中未变：标记已就位
    dragHit = { row, mode };
    if (mode === 'into') {
      // 移入文件夹：整行高亮（与收纳页"放进组"同语义）
      setDragMark(row, 'drop-into');
      hideIndLine();
    } else {
      // 插入前/后：悬浮虚线指示条贴在行边界上（收纳页同款观感，
      // 不再往行内画 box-shadow 占位线）
      setDragMark(null);
      showIndLine(dragRect, mode === 'after');
    }
  }

  /** 插入指示线（.st-drag-ind-line，position:fixed 虚线）：before 贴行顶、
   *  after 贴行底，宽度=行宽（树内缩进自然随行左缘）。惰性创建，拖拽结束移除。 */
  function showIndLine(r, after) {
    if (!dragIndLine) {
      dragIndLine = document.createElement('div');
      dragIndLine.className = 'st-drag-ind-line';
      document.body.appendChild(dragIndLine);
    }
    dragIndLine.style.display = 'block';
    dragIndLine.style.left = r.left + 'px';
    dragIndLine.style.width = r.width + 'px';
    dragIndLine.style.top = (after ? r.bottom : r.top) - 1 + 'px';
  }
  function hideIndLine() {
    if (dragIndLine) dragIndLine.style.display = 'none';
  }

  /** 落点标记增量更新：只摘/只给当前这一行的 class，绝不全树扫描。 */
  function setDragMark(row, cls) {
    if (dragMark === row && dragMarkCls === (cls || '')) return;
    if (dragMark) dragMark.classList.remove('drop-into', 'drop-before', 'drop-after');
    dragMark = row;
    dragMarkCls = cls || '';
    if (row && cls) row.classList.add(cls);
  }

  /** 无有效落点：清行标记 + 收指示线 + 清空落点（drop 时无 t 直接放弃）。 */
  function clearHit() {
    setDragMark(null);
    hideIndLine();
    dropTargetId = null;
    dragHit = null;
  }

  function clearDropMarks() {
    setDragMark(null);
  }

  function resetDrag() {
    dragInfo?.ghost?.remove();
    dragIndLine?.remove();
    dragIndLine = null;
    dragInfo = null;
    dropTargetId = null;
    clearDropMarks();
    for (const el of container.querySelectorAll('.bm-row.dragging')) el.classList.remove('dragging');
  }

  await refresh();
}
