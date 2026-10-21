// 标签收纳页（OneTab 式标签页仓库）。
//
// 布局对齐 OneTab：左侧文件夹管理栏（主列表 / 可展开收缩的文件夹树 / 标签组 / 固定在栏底的回收站），右侧内容区。
// - 收纳当前/全部窗口的标签页为一组（去重、含浏览器自带页面、保留置顶），
//   收进当前文件夹，收纳成功后自动关闭已被收纳的标签页
// - 组操作：整组恢复（新窗口打开；组勾选「打开后消除」则打开后整组删除，否则组保留）、
//   锁定（防误删）、折叠、
//   命名+备注、单组导出 HTML、复制为文本/Markdown、移动到文件夹；
//   组顶栏「打开后消除」勾选框：勾选后点击组内标签后台打开网页（焦点留在本页）、
//   该记录移入回收站「消除回收」区可移回（设置页可改为彻底删除；默认不勾选）；
//   组「恢复」勾选消除时整组打开后移入回收站
// - 标签行：点击打开、📌置顶、✎备注（导出 HTML/复制会带上）、×删除
// - 编辑模式：多选分组，批量删除（进回收站）/移动到文件夹/复制/导出 HTML；
//   任意模式下按住标签行拖动即可拖拽标签(可跨组放置、勾选多个时整批拖动，
//   也可拖到左栏:文件夹/主列表=新建组收纳,组条目=并入该组)；
//   按住组头拖动可拖拽整组（组间重排/融合,或拖到左栏）；左栏文件夹、组条目
//   本身也可按住拖动(OneTab 树三段语义:条目顶部=插到它前面、底部=插到它
//   后面、中部=within:文件夹→移入/嵌套为子文件夹,组→融合)；
//   拖动中显示插入指示线，标签组被搬空后自动消除
// - 导入文本：粘贴任意文本，提取其中的 http(s) 链接收纳成组（在"数据 ▾"菜单里）
// - 导出 HTML / JSON 与 OneTab 完全兼容（lib/stash-export.js）

import {
  readAllStashItems, readStashScope, readStashChangesSince, readGroupDescendants,
  countStashChildren, countStashTabsDeep, NOTIFY_TOKEN,
  childrenOf, notesText,
  stashTabs, restoreGroup, openStashTab, setOpenDelete, restoreLooseTab,
  toggleLock, setGroupsLocked, toggleCollapse, renameGroup, togglePinTab,
  moveToTrash, deleteTab, deleteGroupForever, emptyTrash,
  createGroupShell,
  createFolder, updateTabNotes, moveNode, reorderChildren,
  repairStashTreeConsistency, maxStashModifyDate,
} from '../../lib/stash.js';
import {
  downloadStashHtml, downloadStashJSON, parseStashJSON, buildGroupClipboard,
} from '../../lib/stash-export.js';
import { escapeHtml, faviconUrl, setInnerHTML } from '../../lib/util.js';
import { getSetting, setSetting } from '../../lib/db.js';
import { confirmDialog, formDialog } from '../../lib/dialog.js';
import { toast } from '../../lib/toast.js';

let built = false;
let container = null;
let ui = null;
let searchNeedle = '';
let emptyWarnChecked = false; // 每个页面生命周期只查一次"库被外部清空"
let lockedOnly = false; // 只看锁定：勾选后主区只显示已锁定的分组
let currentFolder = 'root'; // 'root' | folderId | 'trash'
let editing = false;
const selected = new Set();
const selectedTabs = new Set(); // 编辑模式下勾选的标签（跨组）

function updateEditCount() {
  if (ui?.editCount) {
    ui.editCount.textContent = `已选 ${selected.size} 组${selectedTabs.size ? ` / ${selectedTabs.size} 个标签` : ''}`;
  }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// ---------------------------------------------------------------- 筛选（扁平视图，替代原排序）

/** 筛选模式：'' = 正常分组视图；'title' = 全部标签拿出按标题 A→Z 排；
 *  'site' = 按根域名归组排（同站点按标题）。仅视图状态，不改库。 */
let filterMode = '';

/** 站点键：取根域名（去掉 www，保留最后两段，如 docs.google.com → google.com）。 */
function rootDomain(url) {
  const h = hostOf(url).replace(/^www\./, '');
  const parts = h.split('.').filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('.') : h;
}

function cmpByTitle(a, b) {
  const ta = (a.title || a.url || '').toLowerCase();
  const tb = (b.title || b.url || '').toLowerCase();
  return ta.localeCompare(tb, 'zh-Hans-CN', { numeric: true });
}

function cmpBySite(a, b) {
  const da = rootDomain(a.url || '');
  const db = rootDomain(b.url || '');
  if (da !== db) return da.localeCompare(db);
  return cmpByTitle(a, b);
}

/** 筛选菜单：把当前文件夹各组里的标签"拿出来"平铺排列（不改动库里的分组）。
 *  按标题 A→Z；按网站（根域名归组，同站点按标题）。再点一次或"退出筛选"回分组视图。 */
function showFilterMenu(anchor) {
  showMenu(anchor, [
    { icon: '🔤', label: '按标题', desc: '全部标签拿出按标题 A → Z 平铺', run: () => setFilterMode('title') },
    { icon: '🌐', label: '按网站', desc: '按根域名归组排列，同站点按标题', run: () => setFilterMode('site') },
    ...(filterMode ? [{ icon: '✖️', label: '退出筛选', desc: '回到分组视图', run: () => setFilterMode('') }] : []),
  ]);
}

function setFilterMode(mode) {
  filterMode = mode;
  if (ui.byId) paintWith(ui.byId);
  scheduleSnapSave(); // saveSnapshot 里对筛选视图跳过保存，见下
  toast(mode === 'title' ? '筛选：全部标签按标题 A → Z 平铺'
    : mode === 'site' ? '筛选：全部标签按网站排列'
    : '已退出筛选，回到分组视图');
}

// ---------------------------------------------------------------- 弹出菜单（.ctx-menu）

function closeMenu() {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  openMenuAnchor = null;
  if (menuOutsideClose) {
    document.removeEventListener('click', menuOutsideClose);
    menuOutsideClose = null;
  }
}

let openMenuAnchor = null;   // 当前打开菜单的锚点按钮（再点同一按钮 = 收起菜单）
let menuOutsideClose = null; // 当前菜单的"点外部关闭"监听引用（换菜单/收起时精确移除）

function showMenu(anchor, items) {
  if (openMenuAnchor === anchor) { closeMenu(); return; } // 菜单开着时再点同一按钮 = 关闭
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      menu.appendChild(s);
      continue;
    }
    // 富条目：icon 芯片 + 主文字 + 副说明(desc)两行；只有 label 时退化为单行
    const b = document.createElement('button');
    b.className = 'ctx-item' + ((it.icon || it.desc) ? ' ctx-rich' : '') + (it.danger ? ' danger' : '');
    if (it.icon || it.desc) {
      b.innerHTML = '<span class="ci-ico"></span><span class="ci-txt"><span class="ci-label"></span>'
        + (it.desc ? '<span class="ci-desc"></span>' : '') + '</span>';
      b.querySelector('.ci-ico').textContent = it.icon || '•';
      b.querySelector('.ci-label').textContent = it.label;
      if (it.desc) b.querySelector('.ci-desc').textContent = it.desc;
    } else {
      b.textContent = it.label;
    }
    b.addEventListener('click', () => { closeMenu(); it.run(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  openMenuAnchor = anchor;
  // 点外部关闭。关键：用可移除的引用而非 once——否则上一个菜单残留的 once 监听
  // 会在"本次点击"继续冒泡到 document 时，把刚打开的新菜单立刻关掉
  //（表现：开着 A 菜单时点 B 按钮，B 闪现即消失，像按钮没反应）
  setTimeout(() => {
    menuOutsideClose = closeMenu;
    document.addEventListener('click', menuOutsideClose);
  }, 0);
}

// ---------------------------------------------------------------- 渲染

function groupTitle(g, byId) {
  if (g.label) return g.label;
  return `${countOfNode(g)} 个标签`;
}

/** 某分组/文件夹的显示名（含 type 区分）。计数走 countOfNode（范围外也准）。 */
function nodeName(n, byId) {
  return n.type !== 'group' ? '' : (n.label || (n.groupType === 'folder' ? '未命名文件夹' : `${countOfNode(n)} 个标签`));
}

/** 搜索命中高亮：把 needle 命中段包上 <mark class="st-hl">（大小写不敏感）。
 *  先按原文切分段、逐段 escapeHtml，再拼 mark——不能对已转义的 HTML 做替换，
 *  否则 &amp; 这类实体会被切碎。 */
function stHl(text, needle) {
  if (!needle || !text) return escapeHtml(text || '');
  const low = text.toLowerCase();
  const nl = needle.toLowerCase();
  let out = '', i = 0;
  while (i < text.length) {
    const hit = low.indexOf(nl, i);
    if (hit < 0) { out += escapeHtml(text.slice(i)); break; }
    out += escapeHtml(text.slice(i, hit))
      + '<mark class="st-hl">' + escapeHtml(text.slice(hit, hit + needle.length)) + '</mark>';
    i = hit + needle.length;
  }
  return out;
}

function tabRowHtml(t, gLabel = '', needle = '') {
  const url = t.url || '';
  const title = t.title || url;
  const notes = notesText(t);
  const titleHit = needle && title.toLowerCase().includes(needle);
  const urlHit = needle && url.toLowerCase().includes(needle);
  // 网址命中而标题没命中：网址栏改显完整网址并高亮命中段——
  // 否则行上只有域名，用户看不出这一行为什么被搜出来
  const showFullUrl = Boolean(needle) && urlHit && !titleHit;
  const prefix = gLabel ? `<span class="st-filter-src" title="来自分组：${escapeHtml(gLabel)}">🏷 ${escapeHtml(gLabel)} · </span>` : '';
  return `
    <div class="vrow tg-row" data-tid="${t.id}" data-url="${escapeHtml(url)}">
      <input type="checkbox" class="st-sel st-tab-sel" data-tid="${t.id}" ${selectedTabs.has(t.id) ? 'checked' : ''} title="选中该标签；长按可拖拽（跨组放置）">
      <img class="vicon" src="${escapeHtml(faviconUrl(url || 'about:blank'))}" alt="" loading="lazy" decoding="async" fetchpriority="low">
      <div class="vmain">
        <span class="vtitle st-open" title="${escapeHtml(url)}">${prefix}${needle ? stHl(title, needle) : escapeHtml(title)}</span>
        <span class="vurl"${showFullUrl ? ' title="' + escapeHtml(url) + '"' : ''}>${showFullUrl ? stHl(url, needle) : escapeHtml(hostOf(url))}${notes ? ' · ✎ ' + escapeHtml(notes.split('\n')[0]) : ''}</span>
      </div>
      <button class="st-act" data-act="tabNotes" data-id="${t.id}" title="编辑备注（导出 HTML/复制时会带上）">✎</button>
      <button class="st-act" data-act="pin" data-id="${t.id}" title="置顶到组头部">📌</button>
      <button class="vdel st-act" data-act="delTab" data-id="${t.id}" title="从收纳中删除">×</button>
    </div>`;
}

function groupHtml(g, needle = '') {
  const byId = ui.byId;
  const kids = childrenOf(byId, g.id);
  const pinnedCount = g.pinnedCount || 0;
  const notes = notesText(g);
  // 搜索时真正筛选:只显示标题/网址匹配的标签行;组名或组备注命中则显示整组
  const labelMatch = needle
    ? [g.label || '', notes].join('\n').toLowerCase().includes(needle)
    : false;
  const visibleKids = !needle || labelMatch
    ? kids
    : kids.filter((t) => ((t.title || '') + '\n' + (t.url || '')).toLowerCase().includes(needle));
  // 固定区视觉边界(A5):置顶行之后画一条分隔线,拖拽时用户能看出"落进固定区"的界线
  const rows = visibleKids.map((t, i) => {
    const row = tabRowHtml(t, '', needle);
    return (!needle && i === pinnedCount && pinnedCount > 0 && pinnedCount < kids.length)
      ? '<div class="st-pin-line" title="📌 固定区边界：此线之上的标签为置顶"></div>' + row
      : row;
  }).join('');
  const matchMeta = needle && !labelMatch
    ? ` · <b>${visibleKids.length}</b>/${kids.length} 条匹配`
    : '';
  const checked = selected.has(g.id) ? 'checked' : '';
  return `
    <div class="tg-group st-group ${g.locked ? 'st-locked' : ''}" data-gid="${g.id}">
      <div class="tg-group-head">
        <input type="checkbox" class="st-sel" data-id="${g.id}" ${checked} title="选中该分组">
        <button class="st-caret" data-act="collapse" data-id="${g.id}" title="${g.collapsed ? '展开' : '折叠'}">${g.collapsed ? '▸' : '▾'}</button>
        <button class="st-lock ${g.locked ? 'on' : ''}" data-act="lock" data-id="${g.id}" title="${g.locked ? '解锁（允许整组删除）' : '锁定分组（防止整组被删除）'}">${g.locked ? '🔒' : '🔓'}</button>
        <label class="st-open-del-wrap" title="打开后消除：勾选后，点击本组标签打开网页时该记录移入回收站（可在回收站移回；设置页可改为彻底删除）">
          <input type="checkbox" class="st-open-del" data-id="${g.id}" ${g.openDelete ? 'checked' : ''}>打开后消除
        </label>
        <span class="st-label" data-act="rename" data-id="${g.id}" title="${escapeHtml(notes ? `备注：${notes}\n\n（点击命名分组或编辑备注）` : '点击命名分组或添加备注')}">${escapeHtml(groupTitle(g, byId))}</span>
        <span class="st-meta">${g.createDate ? `创建于 ${new Date(g.createDate).toLocaleDateString('zh-CN')}` : ''}${matchMeta}</span>
        ${notes ? `<span class="st-notes" title="${escapeHtml(notes)}">✎ ${escapeHtml(notes.split('\n')[0])}</span>` : ''}
        <span class="spacer"></span>
        <button class="btn btn-sm st-act" data-act="restore" data-id="${g.id}" title="在新窗口打开整组标签页">还原</button>
        <button class="btn btn-sm st-act" data-act="menu" data-id="${g.id}" title="更多操作">⋯</button>
      </div>
      <div class="visit-list tg-group-body" ${g.collapsed && !needle ? 'hidden' : ''}>${rows || `<div class="empty-tip">${needle ? '该分组没有匹配的标签' : '空分组'}</div>`}</div>
    </div>`;
}

/** 左栏标签组条目名：已命名组显示原名，未命名组用「年-月-日-X个」。 */
function groupSideName(g, byId) {
  if (g.label) return g.label;
  const d = g.createDate ? new Date(g.createDate) : null;
  const ymd = d
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : '未知日期';
  return `${ymd}-${countOfNode(g)}个`;
}

// 左栏文件夹的展开状态（集合内的为展开）：仅会话内记忆，默认全部收起（不写库，不参与云同步）
const sideFolderExpanded = new Set();

// 左栏「回收站」的折叠状态（集合内的为折叠）：仅会话内记忆。默认展开——
// 展开后在回收站条目下方列出其中的标签组（与文件夹树同款条目，点击定位）
const sideTrashCollapsed = new Set();

// 左栏当前"聚焦"的标签组条目（点选后保持高亮，点别的组才切换）。
// 仅会话内记忆，不写库；重绘（paintSide）时按 locatedGid 恢复高亮。
let locatedGid = null;

/** 左栏标签组条目：点击定位到主区分组。 */
function sideGroupItemHtml(n, depth, byId) {
  const cnt = countOfNode(n);
  const title = `创建于 ${n.createDate ? new Date(n.createDate).toLocaleDateString('zh-CN') : '未知'} · ${cnt} 个标签，点击在右侧定位`;
  return `
    <div class="st-side-item st-side-group${depth > 0 ? ' st-side-nested' : ''}${locatedGid === n.id ? ' located' : ''}" data-group="${n.id}" style="padding-left:${10 + depth * 14}px; --tree-x: ${Math.max(2, 4 + depth * 14)}px;" title="${escapeHtml(title)}">
      <!-- 展开按钮占位：与文件夹行 .st-caret 同宽，保证标签组的图标/文字与文件夹列对齐 -->
      <span class="st-caret st-caret-ph" aria-hidden="true"></span>
      <span class="st-side-name">🏷 ${escapeHtml(groupSideName(n, byId))}</span>
      <span class="st-side-count">${cnt}</span>
    </div>`;
}

/** 左栏「回收站」条目下方的分组列表（折叠时不渲染）。数据来自
 *  readStashScope 常载的回收站直接子节点（任意文件夹视图都有）；组计数走
 *  countOfNode → ui.counts（byParent 索引 count，范围无关都准）。 */
function trashSideListHtml(byId) {
  // 回收站视图下栏身就是这份列表：不再受顶部入口 caret 的折叠态控制
  // 列出回收站全部直接子节点——普通标签组 + 被删的文件夹（📁 标识），
  // 只列组会漏掉整夹删除的记录
  const nodes = (byId.get('trash')?.childIds || [])
    .map((id) => byId.get(id))
    .filter((n) => n && n.type === 'group');
  if (!nodes.length) return '';
  return `<div class="st-side-trash-list">`
    + nodes.map((n) => sideGroupItemHtml(n, 0, byId)
      .replace('🏷', n.groupType === 'folder' ? '📁' : '🏷')).join('')
    + `</div>`;
}

/** 左栏文件夹树：文件夹优先排列、可展开/收缩；展开时列出子文件夹与其中的标签组。 */
function sideFolderTreeHtml(byId, nodeId, depth) {
  let html = '';
  for (const id of byId.get(nodeId)?.childIds || []) {
    const n = byId.get(id);
    if (!n || n.type !== 'group' || n.groupType !== 'folder') continue;
    const expanded = sideFolderExpanded.has(id);
    const active = currentFolder === id ? ' active' : '';
    html += `
      <div class="st-side-item${active}${depth > 0 ? ' st-side-nested' : ''}" data-folder="${id}" style="padding-left:${10 + depth * 14}px; --tree-x: ${Math.max(2, 4 + depth * 14)}px;">
        <button class="st-caret" data-act="sideFolderToggle" data-id="${id}" title="${expanded ? '收起' : '展开'}">${expanded ? '▾' : '▸'}</button>
        <span class="st-side-name">📁 ${escapeHtml(n.label || '未命名文件夹')} <span class="st-side-gcount">(${sideGroupCount(byId, n)})</span></span>
        <button class="st-side-act" data-act="folderMenu" data-id="${id}" title="文件夹操作">⋯</button>
        <span class="st-side-count">${sideTabCount(byId, n)}</span>
      </div>
      ${expanded
        ? sideFolderTreeHtml(byId, id, depth + 1)
          + childrenOf(byId, id)
            .filter((c) => c.type === 'group' && c.groupType !== 'folder')
            .map((c) => sideGroupItemHtml(c, depth + 1, byId)).join('')
        : ''}`;
  }
  return html;
}

/** 节点的有效直接子节点数（过滤 childIds 里的死引用——历史数据/删除竞态
 *  可能留下记录已不存在的 id，直接数 length 会让计数虚高不减）。
 *  只能数"已加载进 byId 的子节点"：侧栏里非当前文件夹的组、回收站的数量
 *  不能用它（它们的 tab 不在范围里，会恒显示 0）——那些走 countOfNode。
 *  byId 为空（首绘前/读库失败）时退回 childIds 原长，与旧行为一致。 */
function aliveChildCount(byId, node) {
  const ids = node?.childIds || [];
  if (!byId) return ids.length;
  return ids.filter((id) => byId.has(id)).length;
}

/** 数量显示统一入口：优先索引 count 结果（ui.counts，与可见范围无关，
 *  侧栏任何位置都准）；没有 count 结果时回退在范围里数（当前文件夹的组，
 *  tab 已加载，同样准）。修复：侧栏分组/回收站数量曾恒显示 0 或 1，
 *  只有点进对应对象重绘后才变对。 */
function countOfNode(n) {
  if (!n) return 0;
  const c = ui?.counts && ui.counts.get(n.id);
  if (typeof c === 'number') return c;
  return aliveChildCount(ui?.byId, n);
}

/** 需要索引 count 的节点：所有非文件夹组（root 下的组、各文件夹里的组）
 *  + 回收站。文件夹自身的直接子节点已被 readFolderTree 全量装进范围，
 *  不需要 count；组内 tab 只有当前文件夹的那些在范围里，其余必须 count。 */
function countTargetsOf(byId) {
  const ids = ['trash'];
  for (const n of byId.values()) {
    if (n.type === 'group' && n.groupType !== 'folder') ids.push(n.id);
  }
  return ids;
}

let deepCountSeq = 0;
/** 刷新侧栏计数（paint / verifyFreshness 各路径共用）。
 *  直接子节点数走索引 count（纯 B-tree 计数，毫秒级）同步算；
 *  深层标签数（文件夹/回收站/主列表行）要走 getAll 物化全库记录，数据多时
 *  是大头——延后到空闲回调后台算，算完就地补数字，不阻塞切页签/首绘。
 *  等待期间沿用上一次的 tabCounts（可能略旧但接近，不会闪 0）。 */
async function refreshCounts(byId) {
  try {
    ui.counts = await countStashChildren(countTargetsOf(byId));
  } catch {
    ui.counts = new Map();
  }
  const seq = ++deepCountSeq;
  idleRun(async () => {
    if (seq !== deepCountSeq) return; // 已有更新的计数请求：本次作废
    try {
      const folderIds = [];
      for (const n of (ui.byId || byId).values()) {
        if (n.type === 'group' && n.groupType === 'folder') folderIds.push(n.id);
      }
      ui.tabCounts = await countStashTabsDeep(['root', 'trash', ...folderIds]);
      if (container?.isConnected && seq === deepCountSeq) patchSnapCounts();
    } catch { /* 保留旧 tabCounts：比闪 0 好 */ }
  });
}

/** 主列表行右侧计数 = 主列表视图（root 直接子组）里的标签总数，
 *  不含文件夹子树的标签（那些计入各文件夹自己的行）。
 *  = root 深层标签总数 - root 直接子文件夹的深层标签数。 */
function sideRootTabCount(byId) {
  const root = byId.get('root');
  if (!root) return 0;
  const total = ui?.tabCounts?.get('root');
  if (typeof total === 'number') {
    let inFolders = 0;
    for (const cid of root.childIds || []) {
      const c = byId.get(cid);
      if (c?.type === 'group' && c.groupType === 'folder') inFolders += ui.tabCounts.get(c.id) || 0;
    }
    return Math.max(0, total - inFolders);
  }
  // 回退：在已加载范围里数 root 直接子组的标签
  let n = 0;
  for (const cid of root.childIds || []) {
    const c = byId.get(cid);
    if (c?.type === 'group' && c.groupType !== 'folder') n += countTabs(byId, c);
  }
  return n;
}

/** 侧栏回收站行右侧计数 = 深层标签数（散落标签 + 各组内标签）。 */
function trashCount(byId) {
  return sideTabCount(byId, byId.get('trash'));
}

/** 侧栏文件夹/回收站行右侧的计数 = 深层标签数（含嵌套子文件夹里的 tab）。
 *  优先用索引批查结果（ui.tabCounts，refreshCounts 填充，范围无关都准）；
 *  没有索引结果时回退在已加载范围内递归数（当前文件夹视图下同样准）。 */
function sideTabCount(byId, node) {
  if (!node) return 0;
  const c = ui?.tabCounts?.get(node.id);
  if (typeof c === 'number') return c;
  return countTabs(byId, node);
}

/** 侧栏文件夹/回收站名称后括号里的数字 = 直接子标签组数（不含子文件夹，
 *  子文件夹有自己的行）。只数已加载进 byId 的活引用，死引用不计。 */
function sideGroupCount(byId, node) {
  return (node?.childIds || []).filter((id) => {
    const c = byId.get(id);
    return c && c.type === 'group' && c.groupType !== 'folder';
  }).length;
}

/** 快照计数校对：快照是上次渲染的 HTML，计数数字烤死在文本里，可能生于旧逻辑。
 *  verifyFreshness 的"无变更"路径按设计不重绘（保秒开），这里只把计数就地
 *  改对——数据源是刚刷新的 ui.counts（byParent 索引 count）+ ui.byId，
 *  不重建 DOM、不产生长任务。侧栏（#stSideList/#stSideBottom）是同步整块注入，
 *  全覆盖；#stGroups 只补已注入的部分（其余批次与侧栏同源，版本校验已保证）。
 *  覆盖：侧栏文件夹/主列表/回收站计数、侧栏未命名组名与提示、主区未命名组
 *  标题、回收站组卡片"N 项"、回收站文件夹卡片"N 项 · 共 M 个标签"。 */
function patchSnapCounts() {
  if (!container || !ui.byId) return;
  const byId = ui.byId;
  // 1) 侧栏行计数：主列表 / 各文件夹 / 回收站
  for (const row of container.querySelectorAll('.st-side-item[data-folder] > .st-side-count')) {
    const item = row.parentElement;
    const id = item?.dataset?.folder;
    if (id == null) continue;
    const node = byId.get(id);
    let want;
    if (id === 'root') {
      // 主列表行：root 直接子组的标签总数（与 paintSide 同口径）
      want = sideRootTabCount(byId);
    } else {
      // 文件夹/回收站行：右侧计数 = 深层标签数（与 paintSide 同口径）
      want = sideTabCount(byId, node);
    }
    if (row.textContent !== String(want)) row.textContent = String(want);
    // 文件夹/回收站名称后的括号（标签组数）同步就地更新
    const gc = item.querySelector(':scope > .st-side-name > .st-side-gcount');
    if (gc) {
      const gWant = `(${sideGroupCount(byId, node)})`;
      if (gc.textContent !== gWant) gc.textContent = gWant;
    }
  }
  // 2) 侧栏未命名组：名字里的"年-月-日-N个"与 title 里的计数（已命名组不含计数）
  for (const item of container.querySelectorAll('.st-side-group[data-group]')) {
    const g = byId.get(item.dataset.group);
    if (!g || g.label) continue;
    const name = item.querySelector('.st-side-name');
    if (name) name.textContent = `🏷 ${groupSideName(g, byId)}`;
    const d = g.createDate ? new Date(g.createDate).toLocaleDateString('zh-CN') : '未知';
    item.title = `创建于 ${d} · ${countOfNode(g)} 个标签，点击在右侧定位`;
  }
  // 3) 主区分组卡片：未命名组标题"N 个标签"；回收站卡片的元信息行
  for (const card of container.querySelectorAll('#stGroups .tg-group[data-gid]')) {
    const g = byId.get(card.dataset.gid);
    if (!g) continue;
    const head = card.querySelector(':scope > .tg-group-head');
    if (!head) continue;
    const label = head.querySelector(':scope > .st-label');
    const meta = head.querySelector(':scope > .st-meta');
    if (g.groupType === 'folder') {
      // 回收站里的被删文件夹卡片（主区正常视图不显示文件夹）
      if (meta) meta.textContent = `${childrenOf(byId, g.id).length} 项 · 共 ${countTabs(byId, g)} 个标签`;
    } else if (currentFolder === 'trash') {
      if (label && !g.label) label.textContent = groupTitle(g, byId);
      if (meta) {
        const when = g.createDate ? `创建于 ${new Date(g.createDate).toLocaleDateString('zh-CN')}` : '';
        meta.textContent = `${when} · ${countOfNode(g)} 项`;
      }
    } else if (label && !g.label) {
      label.textContent = groupTitle(g, byId);
    }
  }
}

/** 顶部固定的纵向偏移链：topbar 贴视窗顶 → tabs 贴 topbar 底。全部量实际高度
 *  （offsetHeight），不硬编码——字体缩放/换行都不会漂。
 *  轻量页（stash.html）没有 topbar/tabs。
 *  注意：收纳工具栏区/左栏的 sticky top 不再由 JS 写内联值——滚动中被 repaint
 *  重算会微调数值造成"松动"感；改用 CSS var(--header-h)（dashboard.js 启动时
 *  实测写入、resize 时同步），全程稳定不变。 */
function syncStickyOffsets() {
  let y = 0;
  const topbar = document.querySelector('.topbar');
  if (topbar) {
    topbar.style.top = '0px';
    y += topbar.offsetHeight;
  }
  const tabs = document.querySelector('.tabs');
  if (tabs) tabs.style.top = y + 'px';
}

/** 收纳区布局（整页滚动版）：不再把 .stash-split 框在"视口剩余高度"里——
 *  内容自然向下延伸，页面本身滚动，底部不再被裁切框住。
 *  左栏与工具栏改为 sticky 吸顶保持可见。这里做三件事：
 *  1) 清掉旧的内联高度；2) 把"页头(topbar+页签)+工具栏"总高度写给 CSS
 *  （--st-top-h，供 .tg-group 的 scroll-margin-top 避让）；3) 对齐左栏的
 *  吸顶 top 与 max-height（量实际高度，不硬编码）。 */
function syncStashLayout() {
  const split = container?.querySelector('.stash-split');
  if (!split) return;
  split.style.height = '';
  let y = 0;
  const topbar = document.querySelector('.topbar');
  if (topbar) y += topbar.offsetHeight;
  const tabs = document.querySelector('.tabs');
  if (tabs) y += tabs.offsetHeight;
  const sec = split.querySelector('.st-toolbar-sec');
  const secH = sec ? sec.offsetHeight : 0;
  document.documentElement.style.setProperty('--st-top-h', (y + secH) + 'px');
  const side = split.querySelector('.stash-side');
  if (side) {
    // 吸顶 top/max-height 改由 CSS var(--header-h) 计算（见 .stash-side 规则）；
    // 这里不再写内联值，避免重绘时数值微调导致固定栏"松动"。
    side.style.top = '';
    side.style.maxHeight = '';
  }
}

/** 筛选模式下把当前文件夹各组的标签"拿出来"平铺：按所选标准排序，逐行显示
 *  （含分组名前缀，来源一眼可见）。不改库——只是另一种看数据的视图。 */
function filterListHtml(byId) {
  const needle = searchNeedle.toLowerCase();
  let tabs = [];
  for (const g of childrenOf(byId, currentFolder)) {
    if (g.type !== 'group') continue; // 回收站里的散落 tab 也一并纳入
    for (const t of childrenOf(byId, g.id)) {
      if (t.type !== 'tab') continue;
      if (needle && !(((t.title || '') + '\n' + (t.url || '')).toLowerCase().includes(needle))) continue;
      tabs.push({ t, gLabel: groupTitle(g, byId) });
    }
  }
  const cmp = filterMode === 'site' ? cmpBySite : cmpByTitle;
  tabs.sort((a, b) => cmp(a.t, b.t));
  const rows = tabs.map(({ t, gLabel }) => tabRowHtml(t, gLabel, needle)).join('');
  return `
    <div class="tg-group st-group st-filter-head">
      <div class="tg-group-head">
        <span class="st-label">🔎 筛选：${filterMode === 'site' ? '按网站' : '按标题'} · ${tabs.length} 个标签</span>
        <span class="st-meta">只改变显示顺序，分组与数据不变</span>
        <span class="spacer"></span>
        <button class="btn btn-sm st-act" data-act="filterMenu" id="stFilterExit" title="回到分组视图">退出筛选</button>
      </div>
    </div>
    ${rows || '<div class="empty-tip">没有匹配的标签</div>'}`;
}

/** 主区：当前文件夹下的标签分组（文件夹只在左栏管理，不在主区显示）。 */
function contentHtml(byId) {
  if (filterMode && currentFolder !== 'trash') return filterListHtml(byId);
  const needle = searchNeedle.toLowerCase();
  return childrenOf(byId, currentFolder)
    .filter((n) => n.type === 'group' && n.groupType !== 'folder')
    // 只看锁定：与搜索叠加（同时满足）
    .filter((g) => !lockedOnly || g.locked)
    .filter((g) => !needle
      || [g.label || '', notesText(g)].join('\n').toLowerCase().includes(needle)
      || childrenOf(byId, g.id).some((t) => ((t.title || '') + '\n' + (t.url || '')).toLowerCase().includes(needle)))
    .map((g) => groupHtml(g, needle))
    .join('');
}

/** 左栏渲染（主列表 + 文件夹树 + 底部回收站条）。数据现成时可单独调用，不走库。 */
function paintSide(byId) {
  syncStashLayout();
  syncStickyOffsets(); // topStatus 文案变化可能让 topbar/tabs 高度变化，每次绘制校准
  // 侧栏重绘会清掉内部滚动位置（点栏底条目触发重绘时列表被迫跳回顶部）——保留之
  const keepSideScroll = ui.sideList?.scrollTop || 0;
  const rootGroupNodes = childrenOf(byId, 'root')
    .filter((n) => n.type === 'group' && n.groupType !== 'folder');
  // 按 id 去重：历史数据 childIds 可能重复登记同一组
  const rootGroupCount = new Set(rootGroupNodes.map((n) => n.id)).size;
  const rootGroups = rootGroupNodes
    .map((n) => sideGroupItemHtml(n, 0, byId)).join('');
  setInnerHTML(ui.sideList, `
    <div class="st-side-item${currentFolder === 'root' ? ' active' : ''}" data-folder="root">
      <span class="st-side-name">📋 主列表</span>
      <span class="st-side-count">${sideRootTabCount(byId)}</span>
    </div>
    ${sideFolderTreeHtml(byId, 'root', 0)}
    ${rootGroups}
  `);
  // 顶部页签：标签 / 回收站（data-folder 走既有切换分支）；高亮随当前视图。
  // 页签不带数量——数量放栏身顶部统计行。
  // 新建按钮在回收站视图用 visibility 隐藏：保留占位，头部不跳变
  const sideTabs = container.querySelectorAll('.st-side-tab');
  sideTabs.forEach((b) => b.classList.toggle('active', b.dataset.folder === currentFolder));
  if (ui.newFolder) ui.newFolder.style.visibility = currentFolder === 'trash' ? 'hidden' : '';
  // 栏身顶部统计行 + 当前视图的完整内容
  if (currentFolder === 'trash') {
    setInnerHTML(ui.sideList, `
      <div class="st-side-stats">${new Set((byId.get('trash')?.childIds || []).filter((id) => {
        const c = byId.get(id);
        return c && c.type === 'group';
      })).size} 个标签组 · ${trashCount(byId)} 个标签</div>
      ${trashSideListHtml(byId)}
    `);
  } else {
    setInnerHTML(ui.sideList, `
      <div class="st-side-stats">${rootGroupCount} 个标签组 · ${sideRootTabCount(byId)} 个标签</div>
      ${sideFolderTreeHtml(byId, 'root', 0)}
      ${rootGroups}
    `);
  }
  if (ui.sideBottom) setInnerHTML(ui.sideBottom, '');
  // 恢复侧栏内部滚动位置（见函数开头）
  if (ui.sideList) ui.sideList.scrollTop = keepSideScroll;
}

async function paint() {
  if (drag) return; // 拖拽进行中不重建 DOM（被拖元素引用会失效）；拖拽结束由落库链路补刷
  const t0 = performance.now();
  // 可见范围按需读取（百万级）：约 5~6 次索引查询，只取当前文件夹的组与 tab、
  // 全文件夹树与两个根节点，不再全表 getAll + 建全量 Map。
  let byId = await readStashScope(currentFolder);
  if (currentFolder !== 'root' && currentFolder !== 'trash' && !byId.has(currentFolder)) {
    currentFolder = 'root'; // 当前文件夹已被（其它标签页/云同步）删除：回退主列表重载
    byId = await readStashScope('root');
  }
  const t1 = performance.now();
  ui.byId = byId;
  // "库被外部清空"检测（每页一次）：IndexedDB 可能被 Chrome「清除 Cookie 及
  // 站点数据」、清理软件、磁盘满驱逐整库删掉。历史上有过数据而现在是全空的
  // （三个根 + 深层标签数 = 0），大概率就是被清了——主动提醒从云端快照恢复，
  // 不要让用户以为数据"自己蒸发"而不知道有备份可救。
  if (!emptyWarnChecked) {
    emptyWarnChecked = true;
    try {
      const deep = await countStashTabsDeep(['root', 'trash', 'quickList']);
      const total = [...deep.values()].reduce((s, n) => s + n, 0);
      if (total === 0) {
        const { stashHadData } = await chrome.storage.local.get('stashHadData');
        if (stashHadData) {
          await chrome.storage.local.remove('stashHadData'); // 只提醒一次
          toast('检测到标签收纳数据为空（可能被浏览器清理或误删）。'
            + '如已配置云同步，请到 设置 → 云同步 → 快照列表「恢复」找回最近备份。', true);
        }
      } else {
        chrome.storage.local.set({ stashHadData: true }).catch(() => {});
      }
    } catch { /* 检测失败不影响正常渲染 */ }
  }
  // 侧栏计数：非当前文件夹的组/回收站的数量走索引 count（范围 byId 里没有
  // 它们的 tab，直接数 childIds 会恒显示 0——点进对象重绘后才变对）。
  await refreshCounts(byId);

  // 左栏：主列表 + 文件夹树（可展开/收缩）+ 普通标签组；回收站固定在栏底（stSideBottom）
  paintWith(byId);
  scheduleSnapSave();
  if (!openLogDone) {
    openLogDone = true;
    console.info(`[收纳页] 打开耗时：模块链 ${T_MODULE}ms · ${renderSnapInfo} · 读库 ${Math.round(t1 - t0)}ms · 渲染 ${Math.round(performance.now() - t1)}ms（自页面打开起算）`);
  }
}

// 回收站组的展开状态：仅会话内记忆，默认展开（不写库，不参与云同步）
const trashCollapsed = new Set();

/** 视图缓存：folder -> {html, byId, scope, counts, tabCounts}。
 *  页签切换（数据未变）直接恢复，免读库+免整表重建；数据变化时 repaint() 清空。 */
const viewCache = new Map();
let switchSeq = 0; // 视图切换代数：快速连点时旧加载静默丢弃

/** 切换到目标视图：优先恢复视图缓存（零重建、零闪烁）；未命中返回 false，
 *  此时 currentFolder 已就位，调用方需自行 repaintFromCache()。 */
/** 把 #stGroups 现有子节点整体摘下成一个 DocumentFragment（不销毁，
 *  挂回时零解析——比 innerHTML 字符串往返快一个量级）。 */
function detachGroups() {
  const frag = document.createDocumentFragment();
  while (ui.groups.firstChild) frag.appendChild(ui.groups.firstChild);
  return frag;
}

/** 清掉搜索词与筛选态。切换视图 / 点左侧标签组定位时调用：
 *  searchNeedle 是全局过滤词，残留会让"点'标签'页签看全部"永远停在搜索结果；
 *  viewCache 里带 frag 的条目是过滤态渲染出的 DOM（切走时摘下的节点原样保留），
 *  只要清理发生过就一并作废，否则切回该视图时旧搜索结果会原样挂回。 */
function resetViewFilters() {
  if (!searchNeedle && !filterMode) return;
  searchNeedle = '';
  filterMode = '';
  if (ui.search) ui.search.value = '';
  viewCache.forEach((c, k) => { if (c.frag) viewCache.delete(k); });
}

async function switchFolderTo(target) {
  if (target === currentFolder) {
    // 点当前视图的页签/条目（如搜索后再点"标签"）= 清残留回到完整视图；
    // 无残留时保持原行为（return 不动）
    if (searchNeedle || filterMode) {
      resetViewFilters();
      repaintFromCache();
    }
    return;
  }
  const seq = ++switchSeq; // 快速连点防竞态：过期加载静默丢弃
  // 记住当前视图的滚动位置（主区 window + 侧栏列表内部）：两个视图高度不同，
  // 绝对 scrollY 原样套用会被钳制/落点随机，来回切换就"抖动闪动没有稳定感"。
  // 每个视图记住自己的位置，切回时原地恢复——切换像换层，各自稳定。
  const remember = (entry) => {
    entry.scrollY = window.scrollY;
    entry.sideScroll = ui.sideList ? ui.sideList.scrollTop : 0;
    return entry;
  };
  if (ui.byId && ui.scope === currentFolder && !snapFillActive) {
    const prev = viewCache.get(currentFolder);
    if (prev && prev.frag == null && prev.scope === ui.scope) {
      prev.frag = detachGroups(); // repaint 刚登记的条目：现在才摘节点
      remember(prev);
    } else {
      viewCache.set(currentFolder, remember({
        frag: detachGroups(), byId: ui.byId, scope: ui.scope,
        counts: ui.counts, tabCounts: ui.tabCounts,
      }));
    }
  }
  currentFolder = target;
  resetViewFilters(); // 带着搜索词/筛选态切视图：残留会让新视图只显示过滤子集
  selected.clear();
  selectedTabs.clear();
  const c = viewCache.get(target);
  if (c && c.frag) {
    ui.byId = c.byId; ui.scope = c.scope;
    ui.counts = c.counts; ui.tabCounts = c.tabCounts;
    ui.groups.appendChild(c.frag); // 节点原样挂回，零解析
    paintSide(ui.byId);
    // 恢复该视图上次的位置（钳到当前内容高度内，防内容变短时被浏览器硬钳跳变）
    window.scrollTo(0, Math.min(c.scrollY || 0,
      Math.max(0, document.documentElement.scrollHeight - window.innerHeight)));
    if (ui.sideList) ui.sideList.scrollTop = c.sideScroll || 0;
    return;
  }
  // 缓存未命中（首次进入该视图）：直接加载目标范围 + paintWith，
  // 绝不回落 repaint()——repaint 开头的 viewCache.clear() 会把刚摘下的
  // 当前视图（大文件夹的整棵 DOM）扔掉，切回必然全量重建（"从回收站切回
  // 标签变慢变重"的根因）。这里只加目标视图，其它视图缓存原样保留。
  try {
    let byId = await readStashScope(target);
    if (seq !== switchSeq) return; // 期间已切往其它视图：丢弃过期加载
    if (currentFolder !== 'root' && currentFolder !== 'trash' && !byId.has(currentFolder)) {
      currentFolder = 'root';
      byId = await readStashScope('root');
    }
    ui.byId = byId;
    await refreshCounts(byId);
    if (seq !== switchSeq) return;
    paintWith(byId);
    if (!snapFillActive) {
      viewCache.set(currentFolder, {
        frag: null, byId: ui.byId, scope: ui.scope,
        counts: ui.counts, tabCounts: ui.tabCounts,
      });
    }
    window.scrollTo(0, 0); // 新视图从页首开始，落点确定（原 miss 路径行为）
  } catch (e) {
    console.warn('[收纳页] 切换视图失败', e);
    scheduleRepaint(0); // 读库失败 → 退回全量路径兜底
  }
}

/** 用缓存数据重绘（不重读库）。纯导航类操作（左栏点击/展开）用：
 *  数据本身没变（变更路径都会 repaint），跳过索引查询 + 主区重建，点击即时响应。
 *  缓存是按"可见范围"加载的（ui.scope 记录加载时的文件夹）：切到没加载过的
 *  文件夹时缓存里没有它的组与 tab，必须回退 repaint 重新取范围。 */
function repaintFromCache() {
  if (!ui.byId || ui.scope !== currentFolder) return repaint();
  try {
    delete container.dataset.paintError;
    paintWith(ui.byId);
  } catch (e) {
    console.warn('[历史记录] 标签收纳页刷新失败', e);
    scheduleRepaint(0); // 缓存渲染异常 → 退回全量路径
  }
}

/** paint 的同步版本：数据由调用方给定。 */
function paintWith(byId) {
  ui.byId = byId;
  // 整表重build会换掉 #stGroups 的全部子节点：使进行中的快照分块补注立即失效
  // （旧批次据此静默退出，绝不会把陈旧 HTML 追加到新渲染之后）
  snapFillToken++;
  snapFillActive = false;
  // 保留列表滚动位置：整表重建会把 .st-groups 的 scrollTop 打回/打乱，
  // 用户正滚动到半路时重绘（如跨页面变更广播）表现为"页面随机跳位置"
  const groupsEl = ui.groups;
  const keepScroll = groupsEl ? groupsEl.scrollTop : 0;
  ui.scope = currentFolder; // 记录本缓存覆盖的文件夹（repaintFromCache 的命中判据）
  if (currentFolder !== 'root' && currentFolder !== 'trash' && !byId.has(currentFolder)) currentFolder = 'root';
  paintSide(byId);
  container.classList.toggle('st-editing', editing);
  ui.editBar.classList.toggle('st-editbar-off', !editing);
  syncStashLayout(); // 编辑条显隐改变吸顶工具栏高度：重测 --st-top-h，停靠/避让跟上
  ui.editToggle.textContent = editing ? '完成' : '编辑';
  ui.editToggle.classList.toggle('primary', editing);
  updateEditCount();
  if (currentFolder === 'trash') {
    const kids = childrenOf(byId, 'trash');
    const items = kids.filter((g) => g.type === 'group');
    const loose = kids.filter((t) => t.type === 'tab');
    setInnerHTML(ui.groups, (items.length || loose.length)
      ? (loose.length ? trashLooseHtml(loose) : '') + items.map((g) => trashGroupHtml(g, byId)).join('')
      : '<div class="empty-tip">回收站是空的</div>');
    // 占位显隐：只切 visibility（空间常驻）。用 hidden 会增删一行高，左栏
    // 列表高度随之变化、内部滚动被钳动——来回切换就细小跳动
    ui.trashActions.style.visibility = (items.length === 0 && !loose.length) ? 'hidden' : 'visible';
  } else {
    ui.trashActions.style.visibility = 'hidden';
    const html = contentHtml(byId);
    setInnerHTML(ui.groups, html || `<div class="empty-tip">${searchNeedle ? '没有匹配的标签或分组。' : '这里还没有分组 —— 从浏览器拖链接进来，或用左栏切换文件夹。'}</div>`);
  }
  // 恢复滚动位置（内容被整体替换后 scrollTop 会被浏览器钳制/重置）
  if (groupsEl && groupsEl.isConnected) groupsEl.scrollTop = keepScroll;
  freshMark = Date.now(); // DOM 已反映此刻的库数据：后续"按需校验"以此为比对基准
}

/** 回收站标签行：只读展示（点击可打开），不放编辑按钮——回收站里的编辑有歧义。 */
function trashTabRowHtml(t) {
  const url = t.url || '';
  const notes = notesText(t);
  return `
    <div class="vrow tg-row" data-tid="${t.id}" data-url="${escapeHtml(url)}">
      <img class="vicon" src="${escapeHtml(faviconUrl(url || 'about:blank'))}" alt="" loading="lazy" decoding="async" fetchpriority="low">
      <div class="vmain">
        <span class="vtitle st-open" title="${escapeHtml(url)}">${escapeHtml(t.title || url)}</span>
        <span class="vurl">${escapeHtml(hostOf(url))}${notes ? ' · ✎ ' + escapeHtml(notes.split('\n')[0]) : ''}</span>
      </div>
    </div>`;
}

/** 回收站「消除回收」区：由「打开后消除」产生的单条标签记录（挂在 trash 根下），可移回、可彻底删除。 */
function trashLooseRowHtml(t) {
  const url = t.url || '';
  const notes = notesText(t);
  return `
    <div class="vrow tg-row" data-tid="${t.id}" data-url="${escapeHtml(url)}">
      <img class="vicon" src="${escapeHtml(faviconUrl(url || 'about:blank'))}" alt="" loading="lazy" decoding="async" fetchpriority="low">
      <div class="vmain">
        <span class="vtitle st-open" title="${escapeHtml(url)}">${escapeHtml(t.title || url)}</span>
        <span class="vurl">${escapeHtml(hostOf(url))}${notes ? ' · ✎ ' + escapeHtml(notes.split('\n')[0]) : ''}</span>
      </div>
      <button class="st-act" data-act="untrashTab" data-id="${t.id}" title="移回原分组（原分组已消除则进入按恢复日期命名的标签组）">↩</button>
      <button class="vdel st-act" data-act="delLooseTab" data-id="${t.id}" title="彻底删除（不可恢复）">×</button>
    </div>`;
}

function trashLooseHtml(loose) {
  const collapsed = trashCollapsed.has('trash:loose');
  const rows = loose.map(trashLooseRowHtml).join('');
  return `
    <div class="tg-group st-group" data-gid="trash">
      <div class="tg-group-head">
        <button class="st-caret" data-act="trashCollapse" data-id="trash:loose" title="${collapsed ? '展开' : '折叠'}">${collapsed ? '▸' : '▾'}</button>
        <span class="st-label">消除回收</span>
        <span class="st-meta">${loose.length} 条 · 由「打开后消除」产生</span>
        <span class="spacer"></span>
      </div>
      <div class="visit-list tg-group-body" ${collapsed ? 'hidden' : ''}>${rows}</div>
    </div>`;
}

/** 回收站中的文件夹节点：仿左栏文件夹结构，可展开显示其下的标签组。
 *  展开后按 childIds 序列出：子文件夹（递归嵌套）、标签组（分组卡片：tab 行 +
 *  恢复/彻底删除）、散落 tab 行。默认展开——trashCollapsed 只收录用户手动折叠的，
 *  进回收站就能直接看到每个被删文件夹内部的结构，可逐组恢复/彻底删除。 */
function trashFolderHtml(g, byId) {
  const collapsed = trashCollapsed.has(g.id);
  const kids = childrenOf(byId, g.id);
  const body = kids.map((k) => k.type === 'tab'
    ? trashTabRowHtml(k)
    : k.groupType === 'folder'
      ? trashFolderHtml(k, byId)
      : trashGroupHtml(k, byId)).join('') || '<div class="empty-tip">空文件夹</div>';
  return `
    <div class="tg-group st-group st-trash-folder" data-gid="${g.id}">
      <div class="tg-group-head">
        <input type="checkbox" class="st-sel" data-id="${g.id}" ${selected.has(g.id) ? 'checked' : ''} title="选中该文件夹（编辑模式下批量彻底删除）">
        <button class="st-caret" data-act="trashCollapse" data-id="${g.id}" title="${collapsed ? '展开' : '折叠'}">${collapsed ? '▸' : '▾'}</button>
        <span class="st-label">📁 ${escapeHtml(nodeName(g, byId))}</span>
        <span class="st-meta">${kids.length} 项 · 共 ${countTabs(byId, g)} 个标签</span>
        <span class="spacer"></span>
        <button class="btn btn-sm st-act" data-act="untrash" data-id="${g.id}" title="恢复：弹出位置选择（主列表/任意文件夹）">恢复</button>
        <button class="btn btn-sm st-act st-danger" data-act="delForever" data-id="${g.id}" title="彻底删除（含内部全部内容，不可恢复）">彻底删除</button>
      </div>
      <div class="visit-list tg-group-body trash-tree" ${collapsed ? 'hidden' : ''}>${body}</div>
    </div>`;
}

/** 回收站中的标签组卡片（tab 行 + 恢复/彻底删除）。文件夹走 trashFolderHtml。 */
function trashGroupHtml(g, byId) {
  if (g.groupType === 'folder') return trashFolderHtml(g, byId); // 兜底：被直接调用时不丢结构
  const n = countOfNode(g);
  const collapsed = trashCollapsed.has(g.id);
  const rows = childrenOf(byId, g.id)
    .filter((t) => t.type === 'tab')
    .map(trashTabRowHtml).join('');
  return `
    <div class="tg-group st-group" data-gid="${g.id}">
      <div class="tg-group-head">
        <input type="checkbox" class="st-sel" data-id="${g.id}" ${selected.has(g.id) ? 'checked' : ''} title="选中该分组（编辑模式下批量彻底删除）">
        <button class="st-caret" data-act="trashCollapse" data-id="${g.id}" title="${collapsed ? '展开' : '折叠'}">${collapsed ? '▸' : '▾'}</button>
        <span class="st-label">${escapeHtml(nodeName(g, byId))}</span>
        <span class="st-meta">${g.createDate ? `创建于 ${new Date(g.createDate).toLocaleDateString('zh-CN')}` : ''} · ${n} 项</span>
        <span class="spacer"></span>
        <button class="btn btn-sm st-act" data-act="untrash" data-id="${g.id}" title="恢复：弹出位置选择（主列表/任意文件夹）">恢复</button>
        <button class="btn btn-sm st-act st-danger" data-act="delForever" data-id="${g.id}" title="彻底删除（不可恢复）">彻底删除</button>
      </div>
      <div class="visit-list tg-group-body" ${collapsed ? 'hidden' : ''}>${rows || '<div class="empty-tip">空分组</div>'}</div>
    </div>`;
}

function countTabs(byId, g) {
  let n = 0;
  for (const cid of g.childIds || []) {
    const c = byId.get(cid);
    if (c?.type === 'tab') n++;
    else if (c?.type === 'group') n += countTabs(byId, c);
  }
  return n;
}

/** 就地更新侧栏当前文件夹行的计数（一个组从当前视图消失后调用）。
 *  三种行（主列表/文件夹/回收站）现在都显示标签数：主列表 = root 深层总数
 *  -其子文件夹深层总数 → 组消失时减该组全部标签数；文件夹/回收站行同理。
 *  只按已加载范围数，随后 refreshCounts 会校准；并同步 ui.tabCounts 缓存。 */
function sideDecrementForRemovedGroup(byId, gid, removedTabsOverride) {
  const g = byId?.get(gid);
  const removedTabs = Math.max(1, removedTabsOverride || (g ? countTabs(byId, g) : 1));
  const sel = `[data-folder="${currentFolder}"] .st-side-count`;
  const cnt = ui.sideList?.querySelector(sel) || ui.trashTop?.querySelector(sel) || ui.sideBottom?.querySelector(sel);
  if (cnt) {
    cnt.textContent = String(Math.max(0, (Number(cnt.textContent) || 0) - removedTabs));
  }
  if (ui.tabCounts?.has(currentFolder)) {
    ui.tabCounts.set(currentFolder, Math.max(0, (ui.tabCounts.get(currentFolder) || 0) - removedTabs));
  }
  if (ui.counts?.has(currentFolder)) {
    ui.counts.set(currentFolder, Math.max(0, (ui.counts.get(currentFolder) || 0) - 1));
  }
}

async function repaint() {
  try {
    // 数据即将重绘：其它视图的缓存全部作废（当前视图绘完后重新入缓存）
    viewCache.clear();
    delete container.dataset.paintError;
    await paint();
    // 数据变化重绘完成后登记当前视图缓存（frag 延迟到切走时才摘取——
    // 现在摘会把刚画好的页面掏空）；下一次切走/切回零重建
    if (ui.byId && ui.scope === currentFolder && !snapFillActive) {
      viewCache.set(currentFolder, {
        frag: null, byId: ui.byId, scope: ui.scope,
        counts: ui.counts, tabCounts: ui.tabCounts,
      });
    }
    // 编辑条显隐/内容变化会改变工具栏高度：重算吸顶偏移，避免固定栏轻微下坠
    syncStashLayout();
  } catch (e) {
    console.warn('[历史记录] 标签收纳页刷新失败', e);
    const msg = String((e && e.message) || e);
    container.dataset.paintError = msg;
    // 错误直接显示在页面上，避免"空白且无提示"
    const groups = container.querySelector('#stGroups');
    if (groups) {
      groups.innerHTML = `<div class="sync-warn">标签收纳页渲染出错：${escapeHtml(msg)}<br>
        若提示 Extension context invalidated，请刷新本页面（扩展刚重载过）；其它情况请把这段文字反馈。</div>`;
    }
  }
}

// ---------------------------------------------------------------- 操作

let repaintTimer = 0;
/** 高频来源（搜索输入/云同步通知）合并为一次重绘，避免每次按键都全量重建列表。 */
function scheduleRepaint(delay = 150) {
  clearTimeout(repaintTimer);
  repaintTimer = setTimeout(() => repaint().catch(() => {}), delay);
}

function actFail(e) {
  console.error(e);
  toast('操作失败：' + (e?.message || e), true);
}

/** "移动到文件夹"菜单：主列表 + 全部文件夹（缩进）+ 新建。 */
function showMoveMenu(anchor, ids) {
  const byId = ui.byId || new Map();
  const items = [{ label: '📋 主列表', run: () => doMove(ids, 'root') }];
  const walk = (nodeId, depth) => {
    for (const id of byId.get(nodeId)?.childIds || []) {
      const n = byId.get(id);
      if (!n || n.type !== 'group' || n.groupType !== 'folder') continue;
      if (ids.includes(id)) continue; // 不能移进自身
      items.push({
        label: '　'.repeat(depth) + '📁 ' + (n.label || '未命名文件夹'),
        run: () => doMove(ids, id),
      });
      walk(id, depth + 1);
    }
  };
  walk('root', 0);
  items.push({ sep: true });
  items.push({
    label: '➕ 新建文件夹并移入…',
    run: async () => {
      const vals = await formDialog({ title: '新建文件夹', fields: [{ key: 'label', label: '文件夹名称：' }] });
      const label = vals?.label?.trim();
      if (!label) return;
      const f = await createFolder(label, 'root');
      await doMove(ids, f.id);
      toast(`已创建文件夹「${label.trim()}」并移入 ${ids.length} 项`);
    },
  });
  showMenu(anchor, items);
}

async function doMove(ids, target) {
  for (const id of ids) await moveNode(id, target);
  toast(`已移动 ${ids.length} 项`);
  await repaint();
}

/** 分组 "⋯" 菜单。 */
function showGroupMenu(anchor, gid) {
  const g = ui.byId?.get(gid);
  if (!g) return;
  showMenu(anchor, [
    { label: '📄 导出本组为 HTML…', run: () => downloadStashHtml({ groupId: gid }).then((n) => toast(`已导出「${groupTitle(g, ui.byId)}」（${n} 个标签）`)).catch(actFail) },
    { label: '📋 复制为 标题+网址', run: () => copyGroup(gid, 'text') },
    { label: '📝 复制为 Markdown', run: () => copyGroup(gid, 'markdown') },
    { sep: true },
    { label: '✏️ 重命名 / 备注…', run: () => onAction('rename', gid) },
    { label: '📂 移动到文件夹…', run: () => showMoveMenu(anchor, [gid]) },
    { sep: true },
    { label: '🗑 移入回收站', run: () => onAction('trash', gid) },
  ]);
}

/** 文件夹 "⋯" 菜单。 */
function showFolderMenu(anchor, fid) {
  const f = ui.byId?.get(fid);
  if (!f) return;
  showMenu(anchor, [
    { label: '📂 打开', run: () => { currentFolder = fid; repaint(); } },
    { label: '➕ 新建子文件夹…', run: async () => {
      const vals = await formDialog({ title: '新建子文件夹', fields: [{ key: 'label', label: '文件夹名称：' }] });
      const label = vals?.label?.trim();
      if (label) { await createFolder(label, fid); await repaint(); }
    } },
    { label: '✏️ 重命名…', run: () => onAction('rename', fid) },
    { sep: true },
    { label: '🗑 删除文件夹（含内容，进回收站）', run: () => onAction('trash', fid) },
  ]);
}

async function copyGroup(gid, fmt) {
  const text = await buildGroupClipboard(gid, fmt);
  await navigator.clipboard.writeText(text);
  toast(fmt === 'markdown' ? '已复制为 Markdown' : '已复制为 标题+网址 文本');
}

/** 右键"复制链接"：把标签行网址写入剪贴板（回收站行也可用，纯只读操作）。 */
async function copyTabUrl(url) {
  if (!url) { toast('该条目没有网址', true); return; }
  try {
    await navigator.clipboard.writeText(url);
    toast('已复制链接');
  } catch (e) {
    toast('复制失败：' + (e?.message || e), true);
  }
}

/** 「打开后消除」生效后就地移除标签行（组空连组一起移除），与手动 × 删除的视觉一致。 */
function removeTabRowDom(tid) {
  selectedTabs.delete(tid);
  updateEditCount();
  const row = container.querySelector(`.tg-row[data-tid="${tid}"]`);
  if (!row) return;
  const body = row.closest('.tg-group-body');
  const group = row.closest('.st-group');
  const gid = group?.dataset.gid;
  row.remove();
  ui.byId?.delete(tid);
  if (body && group && !body.querySelector('.tg-row')) {
    const removedTabs = ui.byId?.has(gid) ? countTabs(ui.byId, ui.byId.get(gid)) : 0;
    group.remove();
    ui.byId?.delete(gid);
    // 侧栏行就地更新：文件夹/回收站行 = 深层标签数 -该组标签数
    if (removedTabs > 0) sideDecrementForRemovedGroup(ui.byId, gid, removedTabs);
    else if (ui.counts?.has(currentFolder)) {
      ui.counts.set(currentFolder, Math.max(0, (ui.counts.get(currentFolder) || 0) - 1));
    }
  } else if (gid) {
    const gc = ui.byId?.get(gid);
    if (gc) gc.childIds = (gc.childIds || []).filter((x) => x !== tid);
    if (ui.counts?.has(gid)) {
      ui.counts.set(gid, Math.max(0, (ui.counts.get(gid) || 0) - 1));
    }
    // 主列表/文件夹/回收站行的标签数同步减一（refreshCounts 随后会校准）
    if (ui.tabCounts?.has(currentFolder)) {
      ui.tabCounts.set(currentFolder, Math.max(0, (ui.tabCounts.get(currentFolder) || 0) - 1));
      const sel = `[data-folder="${currentFolder}"] .st-side-count`;
      const cnt = ui.sideList?.querySelector(sel) || ui.trashTop?.querySelector(sel) || ui.sideBottom?.querySelector(sel);
      if (cnt) cnt.textContent = String(Math.max(0, (Number(cnt.textContent) || 0) - 1));
    }
  }
}

/** 打开收纳标签；组勾选了「打开后消除」时行随之从列表消失。
 *  消除判定用视图缓存（勾选瞬间即生效），不依赖异步写库是否已落盘。 */
function openTabAndPrune(tid) {
  const t = ui.byId?.get(tid);
  const gid = t?.parentIds?.[0];
  const g = gid != null ? ui.byId?.get(gid) : null;
  const remove = !!(g?.openDelete) && gid !== 'trash';
  return openStashTab(tid, { remove })
    .then((removed) => { if (removed) removeTabRowDom(tid); })
    .catch(actFail);
}

/** 导入文本：提取 http(s) 链接（每行取第一个 URL，行内其余部分作标题）。 */
async function importTextDialog() {
  const vals = await formDialog({
    title: '从文本导入标签',
    note: '粘贴任意文本（网页列表、笔记、其它标签管理器导出的文本），自动提取其中的 http(s) 链接收纳为一组。每行格式："标题 网址" 或纯网址。',
    fields: [{
      key: 'text', label: '', type: 'textarea',
      placeholder: '示例页面 https://example.com/\nhttps://developer.mozilla.org/zh-CN/',
    }],
    confirmText: '导入',
  });
  if (!vals) return;
  const tabs = [];
  const seen = new Set();
  for (const line of (vals.text || '').split(/\r?\n/)) {
    const m = line.match(/https?:\/\/[^\s"'<>））]+/i);
    if (!m) continue;
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    const title = line.replace(m[0], '').replace(/^[\s|·—\t-]+|[\s|·—\t-]+$/g, '');
    tabs.push({ url, title: title.slice(0, 200), pinned: false });
  }
  if (!tabs.length) { toast('没有在文本中找到 http(s) 链接', true); return; }
  const parent = currentFolder === 'trash' ? 'root' : currentFolder;
  const g = await stashTabs(tabs, { groupLabel: '文本导入 ' + new Date().toLocaleDateString('zh-CN'), parent });
  toast(`已收纳 ${g.childIds.length} 个链接`);
  await repaint();
}

/** 折叠/展开动画：高度+内边距 0.2s 过渡，结束后恢复 hidden 语义状态。
 *  只动 height/padding 不动内容；系统开启"减少动态效果"时直接切换不播动画。 */
function animateCollapse(body, collapse) {
  if (!body) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { body.hidden = collapse; return; }
  const done = () => {
    body.classList.remove('st-anim');
    body.style.height = body.style.paddingTop = body.style.paddingBottom = '';
  };
  if (collapse) {
    body.classList.add('st-anim');
    body.style.height = body.scrollHeight + 'px';
    body.offsetHeight; // 强制回流：确保起始高度先生效再过渡到 0
    body.style.height = '0px';
    body.style.paddingTop = body.style.paddingBottom = '0px';
    setTimeout(() => { body.hidden = true; done(); }, 230);
  } else {
    body.hidden = false;
    const target = body.scrollHeight; // 自然高度（含内边距）
    body.classList.add('st-anim');
    body.style.height = '0px';
    body.style.paddingTop = body.style.paddingBottom = '0px';
    body.offsetHeight;
    body.style.height = target + 'px';
    setTimeout(() => done(), 230);
  }
}

/** 折叠箭头小弹跳：让"这里发生了变化"更容易被余光捕捉到。 */
function popCaret(caret) {
  if (!caret) return;
  caret.classList.remove('st-pop');
  void caret.offsetWidth;
  caret.classList.add('st-pop');
}

async function onAction(act, id) {
  switch (act) {
    case 'collapse': {
      // 高频操作就地更新 DOM，不做全量重绘（大列表下全量重绘会明显卡顿）
      await toggleCollapse(id);
      const el = container.querySelector(`.st-group[data-gid="${id}"]`);
      if (el) {
        const caret = el.querySelector('.st-caret');
        const collapsed = caret.textContent.trim() === '▾';
        caret.textContent = collapsed ? '▸' : '▾';
        caret.title = collapsed ? '展开' : '折叠';
        popCaret(caret);
        const body = el.querySelector('.tg-group-body');
        animateCollapse(body, collapsed && !searchNeedle);
        const gc = ui.byId?.get(id);
        if (gc) gc.collapsed = collapsed; // 同步缓存，与库保持一致
      }
      return;
    }
    case 'lock': {
      const g = ui.byId?.get(id);
      await toggleLock(id);
      const locked = !g?.locked;
      if (g) g.locked = locked; // 同步缓存：否则下次点击会按旧状态再翻转回去
      toast(locked ? '已锁定（整组删除会被拒绝）' : '已解锁');
      const el = container.querySelector(`.st-group[data-gid="${id}"]`);
      if (el) {
        const btn = el.querySelector('.st-lock');
        if (btn) {
          btn.classList.toggle('on', locked);
          btn.textContent = locked ? '🔒' : '🔓';
          btn.title = locked ? '解锁（允许整组删除）' : '锁定分组（防止整组被删除）';
        }
        el.classList.toggle('st-locked', locked);
      }
      return;
    }
    case 'restore': {
      const r = await restoreGroup(id);
      if (!r.opened) { toast('该组没有可恢复的标签页'); break; }
      toast(r.eliminated
        ? `已在新窗口恢复 ${r.opened} 个标签页，该组已消除`
        : `已在新窗口恢复 ${r.opened} 个标签页`);
      break;
    }
    case 'trash': {
      const ok = await moveToTrash(id);
      toast(ok ? '已移入回收站' : '锁定的分组不能删除，请先解锁', !ok);
      break;
    }
    case 'rename': {
      const g = ui.byId?.get(id);
      if (!g) return;
      const isFolder = g.groupType === 'folder';
      const fields = [{ key: 'label', label: isFolder ? '文件夹名称：' : '分组名称（留空则显示标签数）：', value: g.label || '' }];
      if (!isFolder) fields.push({ key: 'notes', label: '备注（可选，可留空）：', type: 'textarea', value: notesText(g) });
      const vals = await formDialog({ title: isFolder ? '重命名文件夹' : '命名分组 / 备注', fields });
      if (!vals) return;
      await renameGroup(id, vals.label.trim(), vals.notes === undefined ? undefined : vals.notes.trim());
      break;
    }
    case 'pin': {
      // 就地更新，不走末尾的 repaint()：全量重绘会重建 #stGroups 的全部 DOM，
      // 整页滚动版的页面滚动位置被钳制/重置，表现为分组"跳动到其它位置"。
      // 做法：先用缓存记录操作前状态，调库后镜像 togglePinTab 的
      // childIds/pinnedCount 变更同步缓存，再只重建该组组体的行。
      const tRec = ui.byId?.get(id);
      const gid = tRec?.parentIds?.[0];
      const g = gid != null ? ui.byId?.get(gid) : null;
      const wasPinned = !!(g && Array.isArray(g.childIds)
        && g.childIds.findIndex((x) => x === id) < (g.pinnedCount || 0));
      await togglePinTab(id);
      if (g && Array.isArray(g.childIds)) {
        g.childIds = g.childIds.filter((x) => x !== id);
        if (wasPinned) {
          g.pinnedCount = Math.max(0, (g.pinnedCount || 0) - 1);
          g.childIds.splice(g.pinnedCount, 0, id);
        } else {
          g.childIds.unshift(id);
          g.pinnedCount = (g.pinnedCount || 0) + 1;
        }
      }
      const groupEl = gid != null ? container.querySelector(`.st-group[data-gid="${gid}"]`) : null;
      const body = groupEl?.querySelector('.tg-group-body');
      // 搜索/筛选视图的行序另有规则，且组体可能不在 DOM：这类情况退回全量重绘
      if (body && g && !searchNeedle && !filterMode && currentFolder !== 'trash') {
        const pinnedCount = g.pinnedCount || 0;
        const kids = childrenOf(ui.byId, gid).filter((k) => k?.type === 'tab');
        setInnerHTML(body, kids.map((t2, i) => {
          const row = tabRowHtml(t2);
          // 固定区分隔线：与 groupHtml 同口径（第 pinnedCount 行之前画线）
          return (i === pinnedCount && pinnedCount > 0 && pinnedCount < kids.length)
            ? '<div class="st-pin-line" title="📌 固定区边界：此线之上的标签为置顶"></div>' + row
            : row;
        }).join('') || '<div class="empty-tip">空分组</div>');
        return;
      }
      break;
    }
    case 'tabNotes': {
      const t = ui.byId?.get(id);
      if (!t) return;
      const vals = await formDialog({
        title: '标签备注',
        note: '备注会显示在标签行下方，并在导出 HTML、复制时带上。',
        fields: [{ key: 'notes', label: '', type: 'textarea', value: notesText(t) }],
      });
      if (!vals) return;
      await updateTabNotes(id, vals.notes.trim());
      break;
    }
    case 'delTab': {
      // 就地删行 + 同步 ui.byId 缓存（镜像 DB 层 deleteTab：删 tab；组空则
      // 删组；组从父 childIds 摘除）。
      // 关键：同步不能依赖 DOM 行是否存在——分块补注中 / 行不在当前视图时
      // row 为 null，旧代码整段跳过缓存同步，ui.byId 留下幽灵组，之后
      // repaintFromCache 把"有组无内容"渲染出来，saveSnapshot 再存进快照，
      // 下次开页从快照注入 = 删掉的组复活。改为以 DB 结果为准同步。
      const row = container.querySelector(`.tg-row[data-tid="${id}"]`);
      const tabRec = ui.byId?.get(id);
      const gid = tabRec?.parentIds?.[0];
      selectedTabs.delete(id);
      updateEditCount();
      await deleteTab(id);
      ui.byId?.delete(id);
      if (gid) {
        const g = ui.byId?.get(gid);
        if (g) {
          const before = (g.childIds || []).length;
          g.childIds = (g.childIds || []).filter((x) => x !== id);
          if (before > 0 && !g.childIds.length && g.groupType !== 'folder') {
            // DB 层已把搬空的普通组删掉：缓存同步删组 + 父 childIds 摘除
            ui.byId?.delete(gid);
            const p = ui.byId?.get(g.parentIds?.[0]);
            if (p) p.childIds = (p.childIds || []).filter((x) => x !== gid);
          } else if (ui.counts?.has(gid)) {
            // 组还在：计数同步减一（与 byId 的 childIds 保持一致）
            ui.counts.set(gid, Math.max(0, (ui.counts.get(gid) || 0) - 1));
          }
        }
      }
      // 作废未执行完的快照补注批次：剩余批次是打开时的旧 HTML，会把刚删掉的
      // 行/组又追加回来（补注进行中删除的经典竞态）。flag 一并复位，
      // 否则 saveSnapshot 会被无限期禁止（与 paintWith 的作废方式一致）。
      snapFillToken++;
      snapFillActive = false;
      if (row) {
        const body = row.closest('.tg-group-body');
        const group = row.closest('.st-group');
        row.remove();
        if (body && group && !body.querySelector('.tg-row')) {
          group.remove();
          const cnt = ui.sideList?.querySelector(`[data-folder="${currentFolder}"] .st-side-count`);
          if (cnt) sideDecrementForRemovedGroup(ui.byId, gid);
          else if (ui.counts?.has(currentFolder)) {
            ui.counts.set(currentFolder, Math.max(0, (ui.counts.get(currentFolder) || 0) - 1));
          }
        }
      }
      return;
    }
    case 'trashCollapse': {
      // 回收站组折叠/展开：会话内记忆，就地更新，不写库
      const collapsed = trashCollapsed.has(id);
      if (collapsed) trashCollapsed.delete(id); else trashCollapsed.add(id);
      const el = container.querySelector(`.st-group[data-gid="${id}"]`);
      if (el) {
        const caret = el.querySelector('.st-caret');
        if (caret) {
          caret.textContent = collapsed ? '▾' : '▸';
          caret.title = collapsed ? '折叠' : '展开';
          popCaret(caret);
        }
        const body = el.querySelector('.tg-group-body');
        animateCollapse(body, !collapsed); // 操作前是折叠 → 现在展开
      }
      return;
    }
    case 'sideFolderToggle': {
      // 左栏文件夹展开/收缩：会话内记忆，不写库。
      // 高频操作：只重绘左栏、用缓存数据（不重读库、不动主区）——点击即时响应
      if (sideFolderExpanded.has(id)) sideFolderExpanded.delete(id); else sideFolderExpanded.add(id);
      if (ui.byId) paintSide(ui.byId);
      return;
    }
    case 'sideTrashToggle': {
      // 左栏回收站分组列表展开/收缩：同 sideFolderToggle，会话内记忆、只重绘左栏
      if (sideTrashCollapsed.has(id)) sideTrashCollapsed.delete(id); else sideTrashCollapsed.add(id);
      if (ui.byId) paintSide(ui.byId);
      return;
    }
    case 'untrashTab':
      // 「打开后消除」的消除回收：移回原分组（原组已消除则进入按恢复日期命名的标签组）
      await restoreLooseTab(id);
      toast('已移回');
      break;
    case 'delLooseTab': {
      // 消除回收彻底删除：就地删行；「消除回收」区不是真实分组，不走 delTab 的组消除逻辑
      const row = container.querySelector(`.tg-row[data-tid="${id}"]`);
      await deleteTab(id);
      ui.byId?.delete(id);
      if (row) {
        const zone = row.closest('.st-group');
        row.remove();
        if (zone && !zone.querySelector('.tg-row')) zone.remove();
      }
      return;
    }
    case 'delForever':
      if (!(await confirmDialog({
        title: '彻底删除',
        message: '彻底删除这一项（含全部内容）？不可恢复。',
        confirmText: '彻底删除', danger: true,
      }))) return;
      await deleteGroupForever(id);
      toast('已彻底删除');
      break;
  }
  await repaint();
}

// ---------------------------------------------------------------- 拖拽
//
// 交互对齐 OneTab 的 DnD 架构（逆向 onetab 2.21 的实现）：
// - 按下并移动 3px 即拖（无等待）；判定用 requestAnimationFrame 每帧一次，
//   pointermove 只更新指针坐标，高刷下不卡顿
// - 拖动中源元素 pointer-events:none，不挡命中测试——拖回原位也有插入指示
// - 行级指示线插入列表、行实时让位；每帧判定前先隐藏指示线再量几何，
//   等效 OneTab 对指示线高度的补偿 → 无布局反馈振荡
// - 组级语义与 OneTab 一致的三种落点：组头顶部 20%（≥9px）= 插到组前、
//   组收起时的头部底部 = 插到组后、组体/头部中部 = within（放进组尾，整组高亮）
// - 拖到视口/滚动容器（含左栏列表）边缘 48px 内自动滚动，80~640px/s 二次加速
// - 松手瞬间按指针位置重判落点后落库；原组被搬空后自动消除（moveNode 内处理）
// 原位松开（无移动）仍走普通点击：勾选 / 折叠组头。

const DRAG_START_PX = 6;  // 移动超过这个距离才算拖（太小会把点击的手抖误判成拖）
const HOLD_START_MS = 250; // 按住不动这么久也进入拖拽（与移动即拖双通道，取先）
const CLICK_RETURN_PX = 8; // 按下到松开位移小于此值 = 纯点击（手抖/慢速点击被误判成拖时，取消拖拽把 click 还给浏览器）
const SCROLL_EDGE = 48;   // 距边缘多少 px 开始滚动
const SCROLL_MIN = 80;    // 起始滚动速度 px/s
const SCROLL_MAX = 640;   // 贴边时最大滚动速度 px/s
let drag = null; // { kind, ids, srcEl, ind, target, started, x0, y0, x, y, raf, holdTimer }

let markedSideEl = null;
let markedWithinEl = null;
function clearDropMarks() {
  // 引用式清理:不扫 DOM,只移除上一帧标记的元素(性能:拖拽每帧调用)
  if (markedSideEl) { markedSideEl.classList.remove('drop-target'); markedSideEl = null; }
  if (markedWithinEl) { markedWithinEl.classList.remove('st-drop-within'); markedWithinEl = null; }
}

/** id 是否是被拖节点自身或其后代（不能把组拖进自己里面）。
 *  范围缓存下，嵌套组的深层结构不一定在缓存里（只加载了当前文件夹各组的 tab），
 *  缓存 Walk 会漏判 → 成环污染整棵树。改以 startDrag 时从库预取的精确后代集合
 *  （drag.descIds，只含组/文件夹——落点只能是这两类，tab 是叶子）为准：
 *  预取未完成（null）或失败时一律按"是后代"拦截——拖拽刚开始几毫秒不出指示线，
 *  换万无一失；预取失败也保持拦截（拖拽仍可按 Esc/松开取消），绝不冒成环风险。 */
function isSelfOrDescendant(id) {
  if (!drag || drag.ids.includes(id)) return true;
  if (drag.descIds) return drag.descIds.has(id);
  return true; // 后代集合未就绪：保守拦截
}

/** 组头顶/底部的边缘判定区（OneTab：头部高度的 20%，至少 9px）。 */
function headEdgeZone(headRect) {
  return Math.max(9, Math.floor(headRect.height * 0.2));
}

function beginPress(e, kind, ids, srcEl) {
  if (drag) return;
  drag = { kind, ids, srcEl, ind: null, target: null, started: false, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, raf: 0, holdTimer: 0, frameAt: 0 };
  // 双通道启动：移动 ≥3px 立即拖；按住不动 250ms 也进入拖拽（原位）
  drag.holdTimer = setTimeout(() => { if (drag && !drag.started) startDrag(); }, HOLD_START_MS);
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', cancelPress);
  document.addEventListener('keydown', onDragKey);
}

function startDrag() {
  if (!drag || drag.started) return;
  drag.started = true;
  if (drag.kind === 'group') {
    // 防成环预取：被拖节点（组/文件夹）的全部组类型后代 id。按层批查，
    // 查询次数 = 嵌套深度；巨型组会有一层的大读，但整个拖拽只发生一次，
    // 仍比旧实现"每次点击全表读"小几个量级。
    drag.descIds = null;
    const d = drag; // 身份令牌：预取回来时 drag 可能已取消/换成新拖拽，不能写错对象
    const gid = drag.ids[0];
    readGroupDescendants(gid)
      .then((set) => { if (drag === d) d.descIds = set; })
      .catch(() => { /* 保持 null：isSelfOrDescendant 持续保守拦截 */ });
  }
  if (drag.kind === 'tab') {
    // 锚行已勾选 → 整批拖动勾选的标签（按当前视图分组顺序）
    const anchor = drag.srcEl?.dataset.tid;
    if (anchor && selectedTabs.has(anchor) && selectedTabs.size > 1) {
      const ordered = [];
      for (const g of childrenOf(ui.byId, currentFolder)) {
        if (g.type !== 'group' || g.groupType === 'folder') continue;
        for (const cid of g.childIds || []) if (selectedTabs.has(cid)) ordered.push(cid);
      }
      drag.ids = ordered.length ? ordered : [anchor];
    } else {
      drag.ids = [anchor];
    }
  }
  drag.ind = document.createElement('div');
  drag.ind.className = 'st-drag-ind';
  // 占位矩形与被拖源同等宽度;高度:行=行高,组/条目=其头部高度(拖动把手)
  const srcRect = drag.srcEl.getBoundingClientRect();
  let h = srcRect.height;
  if (drag.kind === 'group') {
    const head = drag.srcEl.querySelector(':scope > .tg-group-head');
    if (head) h = head.getBoundingClientRect().height;
  }
  drag.phW = Math.round(srcRect.width);
  drag.phH = Math.max(20, Math.round(h));
  drag.ind.style.display = 'none';
  container.appendChild(drag.ind);
  drag.srcEl.classList.add(drag.kind === 'tab' ? 'st-drag-src' : 'st-drag-src-group');
  drag.srcEl.style.pointerEvents = 'none';
  // 标签行"拿起":被拖行暂时不占布局,总高不变(OneTab 的 remove 模式,取消/失败时恢复)
  if (drag.kind === 'tab') {
    for (const tid of drag.ids) {
      const r = container.querySelector('.tg-row[data-tid="' + tid + '"]');
      if (r) r.classList.add('st-drag-taken');
    }
  }
  container.classList.add('st-dragging');
  // 行/组几何快照(OneTab 的行几何缓存):此刻起布局恒定(占位只做覆盖式补偿),
  // 之后每帧判定用纯数学查表,零 elementFromPoint / 零强制回流
  const sy = window.scrollY;
  const sideEl = container.querySelector('.stash-side');
  drag.snap = {
    scrollY: sy,
    gsScrollTop: 0, // 拖拽开始时列表容器的滚动位置（容器滚动量参与坐标换算）
    sideRight: sideEl ? sideEl.getBoundingClientRect().right : 0,
    gsBottom: 0,
    rows: [],
    groups: [],
  };
  const gsEl = container.querySelector('#stGroups');
  if (gsEl) {
    drag.snap.gsScrollTop = gsEl.scrollTop;
    drag.snap.gsBottom = gsEl.getBoundingClientRect().bottom + sy;
  }
  // 分组几何：组元素数量少（几十个），且 content-visibility:auto 下测量
  // 离屏组只返回估算盒，代价可忽略——仍然同步建。
  // 行几何：NOT 在这里逐行测量！几百行 = 拖起瞬间一次巨大的强制布局，
  // 正是"点击拖拽后要等很久"的根源。改为懒测：悬停到哪个组才测哪个组的行
  // （rowsOfGroup，一次一个组、结果缓存），拖起瞬间零行级回流。
  for (const g of container.querySelectorAll('#stGroups .st-group')) {
    const gRect = g.getBoundingClientRect();
    const headEl = g.querySelector(':scope > .tg-group-head');
    const hRect = headEl ? headEl.getBoundingClientRect() : null;
    drag.snap.groups.push({
      gid: g.dataset.gid,
      top: gRect.top + sy, bottom: gRect.bottom + sy,
      headTop: hRect ? hRect.top + sy : null, headBottom: hRect ? hRect.bottom + sy : null,
      collapsed: !!ui.byId?.get(g.dataset.gid)?.collapsed,
      left: gRect.left, width: gRect.width,
      el: g,
      rows: null, // 懒测缓存：rowsOfGroup(sg) 首次访问时测量
    });
  }
  drag.phDocPos = Infinity; // 占位插入点之后的元素补偿 +phComp(初始无占位)
  // 光标幽灵(OneTab 的 Kn 注册表):小浮层跟随指针,增强"抓起来"的手感
  const ghost = document.createElement('div');
  ghost.className = 'st-drag-ghost';
  if (drag.kind === 'group') {
    const g = ui.byId?.get(drag.ids[0]);
    ghost.innerHTML = `<span class="st-ghost-ico">🏷</span><span class="st-ghost-txt"></span>`;
    ghost.querySelector('.st-ghost-txt').textContent = g ? nodeName(g, ui.byId) : '';
  } else if (drag.ids.length > 1) {
    // 多选整批拖动:显示首个标签标题 + 计数(OneTab 同款)
    const first = ui.byId?.get(drag.ids[0]);
    ghost.innerHTML = `<span class="st-ghost-ico">📑</span><span class="st-ghost-txt"></span>`;
    ghost.querySelector('.st-ghost-txt').textContent = `${first ? (first.title || first.url || '') : ''} 等 ${drag.ids.length} 个标签`;
  } else {
    const t0 = ui.byId?.get(drag.ids[0]);
    const u = t0?.url || '';
    ghost.innerHTML = `<img class="st-ghost-fav" src="${escapeHtml(faviconUrl(u || 'about:blank'))}" alt=""><span class="st-ghost-txt"></span>`;
    ghost.querySelector('.st-ghost-txt').textContent = t0 ? (t0.title || u) : '';
  }
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  moveDragGhost();
  drag.raf = requestAnimationFrame(dragFrame);
}

/** 光标幽灵跟随指针(+14px 偏移,避开被按住的光标热点)。
 *  用 transform 走合成器路径（不改 left/top 触发布局），拖动全程零回流、更跟手。 */
function moveDragGhost() {
  if (!drag?.ghost) return;
  drag.ghost.style.transform = `translate3d(${Math.round(drag.x) + 14}px, ${Math.round(drag.y) + 16}px, 0)`;
}

function onDragKey(e) {
  if (drag?.started && e.key === 'Escape') { e.preventDefault(); cancelPress(); }
}

/** 取消/中断拖拽（Esc、pointercancel）：恢复视觉，不落库。 */
function cancelPress() {
  if (!drag) return;
  clearTimeout(drag.holdTimer);
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  document.removeEventListener('pointercancel', cancelPress);
  document.removeEventListener('keydown', onDragKey);
  if (drag.started) {
    if (drag.raf) cancelAnimationFrame(drag.raf);
    drag.ind?.remove();
    drag.ghost?.remove();
    drag.srcEl?.classList.remove('st-drag-src', 'st-drag-src-group');
    drag.srcEl.style.pointerEvents = '';
    container.classList.remove('st-dragging');
    container.querySelectorAll('.st-drag-taken').forEach((el) => el.classList.remove('st-drag-taken'));
    clearDropMarks();
  }
  drag = null;
}

/** 指针位置下最近的纵向滚动容器（对齐 OneTab 的 hover 容器策略），无则 window。 */
/** 指针位置下最近的纵向滚动容器(对齐 OneTab 的 hover 容器策略),无则 window。
 *  结果按命中元素缓存,避免每帧向上爬 getComputedStyle。 */
const scrollContainerCache = new WeakMap();
function scrollContainerAt(x, y) {
  const hit = document.elementFromPoint(x, y);
  if (hit && scrollContainerCache.has(hit)) return scrollContainerCache.get(hit);
  let c = window;
  for (let n = hit; n && n !== document.documentElement; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') { c = n; break; }
  }
  if (hit) scrollContainerCache.set(hit, c);
  return c;
}

/** 距容器(或视口)边缘 48px 内的滚动速度;贴边越近越快(二次曲线)。 */
function autoScrollStep(x, y, sc) {
  let top, bottom, cur, max;
  if (sc === window) {
    top = 0; bottom = window.innerHeight;
    cur = window.scrollY; max = document.documentElement.scrollHeight - window.innerHeight;
  } else {
    const r = sc.getBoundingClientRect();
    top = r.top; bottom = r.bottom;
    cur = sc.scrollTop; max = sc.scrollHeight - sc.clientHeight;
  }
  const yy = Math.min(bottom, Math.max(top, y));
  const up = yy - top, down = bottom - yy;
  let dir = 0, dist = 0;
  if (up < SCROLL_EDGE) { dir = -1; dist = up; } else if (down < SCROLL_EDGE) { dir = 1; dist = down; }
  if (!dir || (dir < 0 && cur <= 0) || (dir > 0 && cur >= max)) return 0;
  let w = 1 - Math.min(1, dist / SCROLL_EDGE);
  w *= w;
  return (SCROLL_MIN + (SCROLL_MAX - SCROLL_MIN) * w) * dir;
}

/**
 * 标签拖拽的落点（x,y 为指针坐标；调用前指示线已隐藏，量到的是自然几何）：
 * 行上/下半 → 行前/行后；组头顶部区 → 组前；组收起头部底部 → 组后；
 * 组体或头部中部 → within（放进组尾，整组高亮）。
 */
/** 目标组内、参照行前/后的插入 index(基于该组 childIds,剔除被拖标签)。 */
function listIndexOf(gid, refTid, before) {
  const list = (ui.byId?.get(gid)?.childIds || []).filter((c) => !drag.ids.includes(c));
  const idx = list.indexOf(refTid);
  return idx < 0 ? list.length : (before ? idx : idx + 1);
}

/** 目标组剔除被拖标签后的子项数（within 时插到组尾用）。 */
function childCount(gid) {
  return (ui.byId?.get(gid)?.childIds || []).filter((c) => !drag.ids.includes(c)).length;
}

/**
 * 标签拖拽的落点（x,y 为指针坐标；调用前指示线已隐藏，量到的是自然几何）：
 * 行上/下半 → 行前/行后；组头顶部区 → 组前；组收起头部底部 → 组后；
 * 组体或头部中部 → within（放进组尾，整组高亮）。
 */
/** 拖拽行几何懒测：首次悬停到某组时才测量该组的行（一次只回流一个组），
 *  结果缓存在 snap.groups[i].rows，本次拖拽内复用。 */
function rowsOfGroup(sg, snap) {
  if (sg.rows) return sg.rows;
  const rows = [];
  for (const r of sg.el.querySelectorAll(':scope > .tg-group-body > .tg-row')) {
    if (r.classList.contains('st-drag-taken')) continue;
    const rRect = r.getBoundingClientRect();
    rows.push({
      tid: r.dataset.tid, gid: sg.gid, el: r,
      top: rRect.top + snap.scrollY, bottom: rRect.bottom + snap.scrollY,
      left: rRect.left, width: rRect.width,
    });
  }
  sg.rows = rows;
  return rows;
}

function computeTabDrop(x, y) {
  const snap = drag.snap;
  if (!snap) return null;
  // 坐标换算：dy = 窗口滚动差（占位/指示线的视口换算用）；
  // gsDelta = 列表容器滚动量（快照几何的文档坐标校正用，见 dragFrame）
  const gsDelta = drag.gsDelta || 0;
  const dy = window.scrollY - snap.scrollY + gsDelta;
  const phComp = drag.phH + 2; // 占位插入使后续元素下移的量
  const compOf = (docTop) => (docTop >= drag.phDocPos ? phComp : 0);
  const yDoc = y + window.scrollY + gsDelta; // 指针的文档坐标(与快照区间同一坐标系)
  // 左栏(OneTab 的 navCol):仅当指针在左栏横向范围才做 hit-test,主区拖拽零强制布局
  if (x <= snap.sideRight) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const sideItem = el.closest('.st-side-item');
    if (sideItem) {
      const fid = sideItem.dataset.folder;
      if (fid) return { sideNewGroup: fid, sideTarget: sideItem }; // 含 trash：拖标签=在回收站新建组收纳
      const sgid = sideItem.dataset.group;
      const sg = sgid && ui.byId?.get(sgid);
      if (sg && sg.groupType !== 'folder' && !sg.locked && !drag.ids.includes(sgid)) {
        return { gid: sgid, index: (sg.childIds || []).length, sideTarget: sideItem };
      }
    }
    return null;
  }
  // 主区:纯数学查快照(OneTab 的"最近行"判定,无空洞、无强制回流)
  // 1) 组头三段:顶部边缘=组间新组(前);收起组底部边缘=新组(后);中部=并入组尾
  for (const g of snap.groups) {
    if (drag.ids.includes(g.gid) || g.headTop == null) continue;
    if (ui.byId?.get(g.gid)?.locked) continue; // 锁定组不接收拖入
    const sc = compOf(g.headTop);
    if (yDoc < g.headTop + sc || yDoc > g.headBottom + sc) continue;
    const zone = headEdgeZone({ height: g.headBottom - g.headTop });
    if (yDoc < g.headTop + sc + zone) {
      return { newGroupBeforeGid: g.gid, placement: { left: g.left, width: g.width, top: g.headTop - dy + sc - 2 } };
    }
    if (g.collapsed && yDoc > g.headBottom + sc - zone) {
      return { newGroupAfterGid: g.gid, placement: { left: g.left, width: g.width, top: g.headBottom - dy + sc - 2 } };
    }
    return { gid: g.gid, index: childCount(g.gid), within: g.el };
  }
  // 2) 组体:该组内"最近行"(按行中点文档距离)→ 行前/行后;空组体 → 并入组尾
  for (const g of snap.groups) {
    if (drag.ids.includes(g.gid) || ui.byId?.get(g.gid)?.locked) continue;
    const sc = compOf(g.headTop);
    const bodyTop = (g.headBottom ?? g.top) + sc;
    const bodyBottom = g.bottom + sc;
    if (yDoc < bodyTop || yDoc > bodyBottom) continue;
    let best = null, bestD = Infinity, bestBefore = false;
    for (const r of rowsOfGroup(g, snap)) {
      if (r.gid !== g.gid) continue;
      const rc = compOf(r.top);
      const mid = (r.top + r.bottom) / 2 + rc;
      const d = Math.abs(yDoc - mid);
      if (d < bestD) { bestD = d; best = r; bestBefore = yDoc < mid; }
    }
    if (best) {
      return { gid: g.gid, index: listIndexOf(g.gid, best.tid, bestBefore), place: { el: best.el, where: bestBefore ? 'before' : 'after' } };
    }
    return { gid: g.gid, index: childCount(g.gid), within: g.el };
  }
  // 3) 列表末尾空白 → 末尾新建分组
  if (yDoc >= snap.gsBottom + compOf(snap.gsBottom) - 8) {
    return { newGroupAtEnd: true, placement: { left: 0, width: 0, top: 0, atEnd: true } };
  }
  return null;
}

/** 组拖拽的落点：组头顶部区 = 插到组前；收起组的头部底部 = 插到组后；
 *  组体/头部中部 = within（融合：整组高亮，子标签按序并入目标组，源组消除）；
 *  组体内具体标签行 = 融合到该行前/后（排序位置合并，左栏拖组到右侧的核心交互）；
 *  或左栏「主列表」/文件夹 = 移入（index 顶部）。 */
function computeGroupDrop(x, y) {
  // 锁定语义(对齐 OneTab 的 ks() 校验矩阵):锁定的组不能被移动/融合/进回收站
  if (ui.byId?.get(drag.ids[0])?.locked) return null;
  const el = document.elementFromPoint(x, y);
  if (!el || (!container.contains(el) && el !== container)) return null;
  // ── 左栏(OneTab 树的三段语义):条目顶部 20%(≥9px)=插到它前面,
  //    底部 20%=插到它后面,中部=within(文件夹:移入/嵌套;组:融合)
  const sideItem = el.closest('.st-side-item');
  if (sideItem) {
    const sr = sideItem.getBoundingClientRect();
    const zone = Math.max(9, Math.floor(sr.height * 0.2));
    const before = y < sr.top + zone;
    const after = !before && y > sr.bottom - zone;
    const dragged = ui.byId?.get(drag.ids[0]);
    const draggedIsFolder = dragged?.groupType === 'folder';
    const sgid = sideItem.dataset.group;
    if (sgid) {
      const sg = ui.byId?.get(sgid);
      if (!sg || sg.groupType === 'folder' || isSelfOrDescendant(sgid)) return null;
      if (sg.locked) return null; // 锁定组不接收融合
      if (before || after) {
        // 组条目之间重排(可跨父:插到该组所在位置)
        const gp = sg.parentIds?.[0] || 'root';
        const list = (ui.byId.get(gp)?.childIds || []).filter((c) => !drag.ids.includes(c));
        const idx = list.indexOf(sgid);
        if (idx < 0) return null;
        return { parent: gp, index: before ? idx : idx + 1, placement: { left: sr.left, width: sr.width, top: (before ? sr.top : sr.bottom) - 2 } };
      }
      if (draggedIsFolder) return null; // 组内不能放文件夹
      return { parent: sgid, index: (sg.childIds || []).length, within: sideItem, merge: true, sideTarget: sideItem };
    }
    const fid = sideItem.dataset.folder;
    if (fid) {
      if (fid === 'trash') {
        // 拖入回收站 = 整组移入回收站（锁定组拒绝；已在回收站的忽略）
        if (!dragged || dragged.locked || dragged.parentIds?.[0] === 'trash') return null;
        return { parent: 'trash', index: 0, sideTarget: sideItem };
      }
      if (isSelfOrDescendant(fid)) return null;
      if (fid === 'root') return { parent: 'root', index: 0, sideTarget: sideItem };
      const f = ui.byId?.get(fid);
      if (!f) return null;
      if (before || after) {
        const fp = f.parentIds?.[0] || 'root';
        const list = (ui.byId.get(fp)?.childIds || []).filter((c) => !drag.ids.includes(c));
        const idx = list.indexOf(fid);
        if (idx < 0) return null;
        return { parent: fp, index: before ? idx : idx + 1, placement: { left: sr.left, width: sr.width, top: (before ? sr.top : sr.bottom) - 2 } };
      }
      // 中部 within:文件夹→嵌套为其子文件夹;组→移入该文件夹
      return { parent: fid, index: 0, sideTarget: sideItem };
    }
    return null;
  }
  const groupEl = el.closest('.st-group[data-gid]');
  if (!groupEl) {
    // ── 组间空隙/列表上下边缘 = 插入区(OneTab 式宽松放置)：
    //    组与组之间的留白整段都是"插到这两组之间"的落点，不必挤头部 9px 窄条。
    //    用 startDrag 的几何快照做纯数学判定(指针在主区、不在任何组内才会走到这)。
    if (currentFolder !== 'trash' && drag.snap && x > drag.snap.sideRight) {
      const cands = drag.snap.groups.filter((sg) => {
        if (drag.ids.includes(sg.gid)) return false;
        const n = ui.byId?.get(sg.gid);
        return n && (n.parentIds?.[0] || 'root') !== 'trash';
      });
      const yDoc = y + window.scrollY + (drag.gsDelta || 0);
      let prev = null, next = null;
      for (const sg of cands) {
        if (yDoc >= sg.bottom) { prev = sg; continue; }
        next = sg; break;
      }
      const anchor = next || prev; // 上/下最近的相邻组作为定位锚
      const anchorNode = anchor && ui.byId?.get(anchor.gid);
      if (anchorNode && !isSelfOrDescendant(anchor.gid)) {
        const parent = anchorNode.parentIds?.[0] || 'root';
        const list = (ui.byId.get(parent)?.childIds || []).filter((c) => !drag.ids.includes(c));
        const aIdx = list.indexOf(anchor.gid);
        if (aIdx >= 0) {
          const rr = anchor.el.getBoundingClientRect();
          return {
            parent,
            index: next ? aIdx : aIdx + 1, // 有下邻=插到它前；只有上邻=插到列表末尾
            placement: { left: rr.left, width: rr.width, top: y - 2 },
          };
        }
      }
    }
    return null;
  }
  const gid = groupEl.dataset.gid;
  if (isSelfOrDescendant(gid)) return null;
  const g = ui.byId?.get(gid);
  const parent = g?.parentIds?.[0] || 'root';
  if (parent === 'trash') return null;
  const list = (ui.byId.get(parent)?.childIds || []).filter((c) => !drag.ids.includes(c));
  const idx = list.indexOf(gid);
  if (idx < 0) return null;
  const dragged = ui.byId?.get(drag.ids[0]);
  const draggedIsFolder = dragged?.groupType === 'folder';
  const head = el.closest('.tg-group-head');
  const r = groupEl.getBoundingClientRect();
  if (head) {
    const hr = head.getBoundingClientRect();
    if (y < hr.top + headEdgeZone(hr)) {
      return {
        parent, index: idx,
        place: { el: groupEl, where: 'before' },
        placement: { left: r.left, width: r.width, top: r.top - 2 },
      };
    }
    if (g.collapsed && y > hr.bottom - headEdgeZone(hr)) {
      return {
        parent, index: idx + 1,
        place: { el: groupEl, where: 'after' },
        placement: { left: r.left, width: r.width, top: r.bottom - 2 },
      };
    }
  }
  // 组体：组 → 融合进目标组（OneTab 的 merge）；文件夹 → 插到该组后面（重排）
  if (draggedIsFolder) {
    return { parent, index: idx + 1, placement: { left: r.left, width: r.width, top: r.bottom - 2 } };
  }
  if (g.locked) {
    // 锁定组不接收融合，退化为插到它后面（仅重排）
    return { parent, index: idx + 1, placement: { left: r.left, width: r.width, top: r.bottom - 2 } };
  }
  // 融合到期望的排序位置：指针压在目标组的某个标签行上 → 合并到该行前/后，
  // 而不是一律追加到组尾。index 与 moveNode 一致按"剔除被拖项后"的列表算
  // （被拖的是组，不在目标组 childIds 里，无需过滤）。
  const rowEl = el.closest('.tg-row[data-tid]');
  if (rowEl && rowEl.closest('.st-group') === groupEl) {
    const rr = rowEl.getBoundingClientRect();
    const beforeRow = y < rr.top + rr.height / 2;
    const ti = (g.childIds || []).indexOf(rowEl.dataset.tid);
    if (ti >= 0) {
      return {
        parent: gid,
        index: beforeRow ? ti : ti + 1,
        merge: true,
        anchorTid: rowEl.dataset.tid,
        rowWhere: beforeRow ? 'before' : 'after',
        placement: { left: rr.left, width: rr.width, top: (beforeRow ? rr.top : rr.bottom) - 2 },
      };
    }
  }
  return { parent: gid, index: (g.childIds || []).length, within: groupEl, merge: true };
}

/** 每帧：自动滚动 + 判定落点 + 更新指示。判定前先隐藏指示线再量几何。 */
function applyDragFeedback() {
  const ind = drag.ind;
  clearDropMarks();
  ind.style.display = 'none'; // 量自然几何，避免指示线影响布局造成振荡
  const t = drag.kind === 'tab' ? computeTabDrop(drag.x, drag.y) : computeGroupDrop(drag.x, drag.y);
  drag.target = t;
  // 落点未变化时跳过全部 DOM 操作(性能:悬停静止时零回流)
  const ref = t ? (t.place?.el || t.sideTarget || t.within || null) : null;
  const sig = t
    ? [t.gid, t.parent, t.index, t.sideNewGroup || '', t.newGroupBeforeGid || '', t.newGroupAfterGid || '', t.newGroupAtEnd || '', t.place?.where || '', ref === drag.lastRef]
    : 'null';
  drag.lastRef = ref;
  if (sig === drag.lastSig) return;
  drag.lastSig = sig;
  if (!t) return;
  if (t.sideTarget) {
    t.sideTarget.classList.add('drop-target');
    markedSideEl = t.sideTarget;
    return;
  }
  if (t.within && drag.kind === 'tab') {
    // 标签放进组尾:占位矩形跟到组体尾部(总高恒定,不塌缩)
    const body = t.within.querySelector(':scope > .tg-group-body');
    if (body) {
      ind.className = 'st-drag-ind';
      ind.style.display = '';
      ind.style.height = drag.phH + 'px';
      ind.style.width = drag.phW + 'px';
      body.appendChild(ind);
      drag.phDocPos = t.within.getBoundingClientRect().bottom + window.scrollY + (drag.gsDelta || 0);
      return;
    }
  }
  if (t.within) {
    t.within.classList.add('st-drop-within');
    markedWithinEl = t.within;
    return;
  }
  if (t.placement) {
    // 覆盖式虚线(不参与布局):组排序/组间新组/左栏条目排序,对象不跳动
    ind.className = 'st-drag-ind-line';
    let pp = t.placement;
    if (pp.atEnd) {
      const gsr = container.querySelector('#stGroups')?.getBoundingClientRect();
      if (gsr) pp = { left: gsr.left, width: gsr.width, top: gsr.bottom - 2 };
    }
    ind.style.display = '';
    ind.style.left = pp.left + 'px';
    ind.style.width = pp.width + 'px';
    ind.style.top = Math.max(0, pp.top) + 'px';
    return;
  }
  if (t.place) {
    // 等源行尺寸的虚线矩形,插入目标位置顶替被拖行(内容实时让位,总高不变)
    ind.className = 'st-drag-ind';
    ind.style.display = '';
    ind.style.height = drag.phH + 'px';
    ind.style.width = drag.phW + 'px';
    const { el, where } = t.place;
    const rr = el.getBoundingClientRect();
    drag.phDocPos = (where === 'before' ? rr.top : rr.bottom) + window.scrollY + (drag.gsDelta || 0);
    if (where === 'tail') el.appendChild(ind);
    else el[where === 'before' ? 'before' : 'after'](ind);
  }
}

function dragFrame(ts) {
  if (!drag?.started) { if (drag) drag.raf = 0; return; }
  drag.raf = 0;
  // autoScrollStep 返回的是 px/s 速度,须按实际帧间隔换算成本帧位移
  // (否则 60fps 下速度被放大 60 倍,一帧暴冲 640px 直接到页顶,落点判定全失效)
  const dt = drag.frameAt ? Math.min(100, ts - drag.frameAt) : 16.7; // 后台恢复时限幅防跳滚
  drag.frameAt = ts;
  const sc = scrollContainerAt(drag.x, drag.y);
  const step = autoScrollStep(drag.x, drag.y, sc) * dt / 1000;
  let scrolled = false;
  if (step) {
    if (sc === window) { window.scrollBy(0, step); scrolled = true; }
    else { sc.scrollTop += step; scrolled = true; }
  }
  // 列表容器的滚动量：快照几何是在拖拽开始那一刻测的（文档坐标），
  // 容器每滚 1px，快照里所有元素的当前文档位置就整体偏移 1px——
  // 落点判定与占位/指示线换算必须补偿这个量，否则拖远后落点与指示线差很多
  drag.gsDelta = (ui.groups ? ui.groups.scrollTop : 0) - (drag.snap?.gsScrollTop || 0);
  // 指针与滚动都没变 → 跳过整帧判定与 DOM(性能:静止悬停零回流)
  const moved = drag.x !== drag.lastX || drag.y !== drag.lastY;
  moveDragGhost();
  if (moved || scrolled) {
    drag.lastX = drag.x;
    drag.lastY = drag.y;
    applyDragFeedback();
  }
  drag.raf = requestAnimationFrame(dragFrame);
}

function onDragMove(e) {
  if (!drag) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < DRAG_START_PX) return;
    clearTimeout(drag.holdTimer);
    startDrag();
    return;
  }
  e.preventDefault();
  if (!drag.raf) drag.raf = requestAnimationFrame(dragFrame);
  // 幽灵用 transform 移动（合成器路径，零回流），每个 pointermove 都跟随，
  // 跟手感由浏览器合成器保证；落点判定/指示线统一交给 dragFrame（每帧一次），
  // 不在 pointermove 里做命中测试——高频 move 事件里做几何判定正是"拖动发重"的来源
  moveDragGhost();
}

/** 在 ui.byId 缓存里镜像 moveNode 的移动（含置顶计数与空组消除），返回被消除的组。 */
function memoryMove(id, parent, index) {
  const byId = ui.byId;
  const item = byId.get(id);
  if (!item) return null;
  const oldParent = item.parentIds?.[0];
  let eliminated = null;
  if (oldParent) {
    const p = byId.get(oldParent);
    if (p) {
      const oldIdx = (p.childIds || []).indexOf(id);
      p.childIds = (p.childIds || []).filter((c) => c !== id);
      if (item.type === 'tab' && oldIdx >= 0 && oldIdx < (p.pinnedCount || 0)) {
        p.pinnedCount = Math.max(0, (p.pinnedCount || 0) - 1);
      }
      if (oldParent !== parent && p.groupType !== 'folder' && p.id !== 'trash' && !(p.childIds || []).length) {
        eliminated = p;
        byId.delete(p.id);
        const gp = byId.get(p.parentIds?.[0]);
        if (gp) gp.childIds = (gp.childIds || []).filter((c) => c !== p.id);
      }
    }
  }
  item.parentIds = [parent];
  const np = byId.get(parent);
  if (np) {
    np.childIds = (np.childIds || []).filter((c) => c !== id);
    let idx = index;
    if (item.type === 'tab') idx = Math.max(idx, np.pinnedCount || 0);
    np.childIds.splice(Math.max(0, Math.min(idx, np.childIds.length)), 0, id);
  }
  return eliminated;
}

/** 落位视觉：把被拖行/组的 DOM 就地移动到指示位置（OneTab 的即时反馈），空组 DOM 随之移除。 */
function applyDropDom(d) {
  const t = d.target;
  if (d.kind === 'tab') {
    const rows = d.ids.map((tid) => container.querySelector(`.tg-row[data-tid="${tid}"]`)).filter(Boolean);
    if (!rows.length) return;
    for (const rw of rows) rw.classList.remove('st-drag-taken');
    // 落到左栏或"新建分组":目标不在主区 DOM 可表达,行移除、源组空则删,交给 repaint
    if (t.sideTarget || t.sideNewGroup || t.newGroupBeforeGid || t.newGroupAfterGid || t.newGroupAtEnd) {
      const srcGroups = new Set(rows.map((r) => r.closest('.st-group[data-gid]')).filter(Boolean));
      for (const row of rows) row.remove();
      for (const g of srcGroups) {
        const gBody = g.querySelector(':scope > .tg-group-body');
        if (gBody && !gBody.querySelector('.tg-row')) g.remove();
      }
      return;
    }
    if (t.place && t.place.el.classList.contains('st-group')) {
      // 组前 / 组后（整组边界，行线插在组之间）
      if (t.place.where === 'before') for (const row of rows) t.place.el.before(row);
      else {
        let after = t.place.el;
        for (const row of rows) { after.after(row); after = row; }
      }
    } else if (t.place) {
      // 行前 / 行后：锚点跟着已插入的行走，保持拖拽顺序
      if (t.place.where === 'before') for (const row of rows) t.place.el.before(row);
      else {
        let after = t.place.el;
        for (const row of rows) { after.after(row); after = row; }
      }
    } else {
      // within / 组尾
      const body = (t.within || t.place?.el?.closest('.st-group'))?.querySelector(':scope > .tg-group-body');
      if (body) for (const row of rows) body.appendChild(row);
    }
    // 源组被搬空 → DOM 移除（与 moveNode 的空组消除一致）
    const seen = new Set();
    for (const row of rows) {
      const g = row.closest('.st-group[data-gid]');
      if (!g || seen.has(g)) continue;
      seen.add(g);
      const gBody = g.querySelector(':scope > .tg-group-body');
      if (gBody && !gBody.querySelector('.tg-row')) g.remove();
    }
  } else {
    const el = container.querySelector(`.st-group[data-gid="${d.ids[0]}"]`);
    if (!el) return;
    if (t.merge) {
      // 融合：被拖组的行按原顺序并入目标组。有 anchorTid = 精准释放到目标组
      // 某标签行的前/后(排序位置)；否则追加到组尾。目标在左栏时目标组不在主区,
      // 直接移除源组 DOM,行内容交给 repaint
      if (t.sideTarget) {
        el.remove();
        return;
      }
      const dstBody = (t.within || container.querySelector(`.st-group[data-gid="${t.parent}"]`))
        ?.querySelector(':scope > .tg-group-body');
      const srcBody = el.querySelector(':scope > .tg-group-body');
      const rows = [...(srcBody?.querySelectorAll('.tg-row') || [])];
      const anchor = t.anchorTid
        ? container.querySelector(`.tg-row[data-tid="${t.anchorTid}"]`)
        : null;
      if (dstBody && rows.length) {
        if (anchor) {
          if (t.rowWhere === 'before') for (const row of rows) anchor.before(row);
          else { let a = anchor; for (const row of rows) { a.after(row); a = row; } }
        } else {
          for (const row of rows) dstBody.appendChild(row);
        }
      }
      el.remove();
    } else if (t.sideTarget) el.remove(); // 移入文件夹：主区不再显示，左栏由 repaint 刷新
    else if (t.place?.where === 'before') t.place.el.before(el);
    else if (t.place?.where === 'after') t.place.el.after(el);
  }
}

async function doDrop(d) {
  const t = d.target;
  // 融合前先记住被拖组的子项（内存同步后 childIds 会清空）
  const mergeKids = (d.kind === 'group' && t.merge)
    ? [...(ui.byId?.get(d.ids[0])?.childIds || [])]
    : null;
  // 拖标签到左栏文件夹/主列表：先在库里建一个空组(OneTab 的 fs 模式),拿到 id 后走通用移入
  if (d.kind === 'tab' && t.sideNewGroup) {
    const g = await createGroupShell(t.sideNewGroup);
    t.gid = g.id;
    t.index = 0;
    ui.byId.set(g.id, JSON.parse(JSON.stringify(g)));
    const fp = ui.byId.get(t.sideNewGroup);
    if (fp) fp.childIds = [g.id, ...(fp.childIds || []).filter((c) => c !== g.id)];
  }
  // 拖标签到组之间/列表末尾：以这些标签新建一个分组(OneTab 核心交互)
  if (d.kind === 'tab' && (t.newGroupBeforeGid || t.newGroupAfterGid || t.newGroupAtEnd)) {
    const g = await createGroupShell(currentFolder);
    ui.byId.set(g.id, JSON.parse(JSON.stringify(g)));
    const fp = ui.byId.get(currentFolder);
    if (fp) fp.childIds = [g.id, ...(fp.childIds || []).filter((c) => c !== g.id)];
    // 标签先入新组(源组可能因此消除),再按最终布局定位新组 → 与占位符位置一致
    let i = 0;
    for (const tid of d.ids) { memoryMove(tid, g.id, i); i++; }
    const siblings = (fp?.childIds || []).filter((c) => c !== g.id);
    let idx;
    if (t.newGroupBeforeGid) idx = siblings.indexOf(t.newGroupBeforeGid);
    else if (t.newGroupAfterGid) idx = siblings.indexOf(t.newGroupAfterGid) + 1;
    else idx = siblings.length;
    t.newGroupIdx = Math.max(0, idx);
    memoryMove(g.id, currentFolder, t.newGroupIdx);
    t.gid = g.id;
    t.index = 0;
  }
  // 1. 立即反馈：DOM 就位 + 内存缓存同步（OneTab 式，不等数据层）
  applyDropDom(d);
  const tabsPreMoved = d.kind === 'tab' && (t.newGroupBeforeGid || t.newGroupAfterGid || t.newGroupAtEnd);
  if (d.kind === 'tab') {
    if (!tabsPreMoved) {
      let i = t.index;
      for (const tid of d.ids) { memoryMove(tid, t.gid, i); i++; }
    }
    for (const tid of d.ids) selectedTabs.delete(tid);
    updateEditCount();
    toast(t.sideNewGroup || t.newGroupBeforeGid || t.newGroupAfterGid || t.newGroupAtEnd
      ? (t.sideNewGroup === 'trash'
        ? `已移入回收站 ${d.ids.length} 个标签`
        : `已收纳 ${d.ids.length} 个标签为新的分组`)
      : `已移动 ${d.ids.length} 个标签`);
  } else if (t.merge) {
    let i = t.index;
    for (const kid of mergeKids) { memoryMove(kid, t.parent, i); i++; }
    toast(`已合并 ${mergeKids.length} 个标签进目标组`);
  } else {
    memoryMove(d.ids[0], t.parent, t.index);
    toast(t.parent === 'trash' ? '已移入回收站'
      : t.sideTarget ? '已移动到左栏目标' : '已调整分组位置');
  }
  // 2. 后台写库（不阻塞视觉）；完成后刷新左栏树/计数等跨视图部分
  void (async () => {
    try {
      if (d.kind === 'tab') {
        let i = t.index;
        for (const tid of d.ids) { await moveNode(tid, t.gid, i); i++; }
        // 标签入库(源组消除)后再定位新组,与内存布局及占位符位置一致
        if (t.newGroupIdx != null) await moveNode(t.gid, currentFolder, t.newGroupIdx);
      } else if (t.merge) {
        let i = t.index;
        for (const kid of mergeKids) { await moveNode(kid, t.parent, i); i++; }
        // 最后一个子项移走时 moveNode 的空组消除会自动删掉源组壳
      } else {
        await moveNode(d.ids[0], t.parent, t.index);
      }
    } catch (err) {
      actFail(err);
      await repaint(); // 写库失败：以库为准恢复
      return;
    }
    // 空组消除/组移动/移入文件夹会影响左栏树与计数 → 防抖刷新；纯 tab 归属变化主区已就位
    scheduleRepaint(200);
  })();
}

function finishDragVisual(d) {
  d.ind?.remove();
  d.ghost?.remove();
  d.srcEl?.classList.remove('st-drag-src', 'st-drag-src-group');
  d.srcEl.style.pointerEvents = '';
  container.classList.remove('st-dragging');
  clearDropMarks();
}

function onDragEnd(e) {
  if (!drag) return;
  clearTimeout(drag.holdTimer);
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  document.removeEventListener('pointercancel', cancelPress);
  document.removeEventListener('keydown', onDragKey);
  // 松手瞬间按指针位置重新判定落点，保证落库位置与看到的指示一致
  if (drag.started && e && typeof e.clientX === 'number') {
    drag.x = e.clientX;
    drag.y = e.clientY;
    applyDragFeedback();
  }
  const d = drag;
  // 误判归还：拖拽虽已启动，但按下到松开几乎没动——鼠标细抖或慢速点击被
  // "移动即拖/长按即拖"双通道误判成拖拽，随后吞噬器会吃掉 click，
  // 表现为"点击切换没反应"。位移小于 CLICK_RETURN_PX 时按取消恢复视觉，
  // 不装吞噬器，让这次点击正常触发（勾选/折叠/切换）。
  const ex = e && typeof e.clientX === 'number' ? e.clientX : d.x;
  const ey = e && typeof e.clientY === 'number' ? e.clientY : d.y;
  if (d.started && Math.hypot(ex - d.x0, ey - d.y0) < CLICK_RETURN_PX) {
    cancelPress();
    return;
  }
  drag = null;
  if (d.raf) cancelAnimationFrame(d.raf);
  if (!d.started) return; // 原位松开 → 交回普通点击（勾选/折叠）
  // 吞掉紧随的 click，避免误触发勾选/折叠/打开标签。
  // 只吞落在行/组/左栏条目上的 click；按钮/输入框/菜单的 click 必然是用户
  // 真实的独立点击，必须放行——否则当松手没有产生 click(源组被移除等)时
  // 吞噬器会一直挂着，吃掉下一次工具栏点击，表现为"按钮时灵时不灵"。
  const swallow = (ev) => {
    if (ev.target.closest('button, input, select, textarea, label, a, .ctx-menu')) return;
    ev.stopPropagation(); ev.preventDefault();
  };
  document.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => document.removeEventListener('click', swallow, true), 250);
  finishDragVisual(d);
  if (d.target) doDrop(d);
  else container.querySelectorAll('.st-drag-taken').forEach((el) => el.classList.remove('st-drag-taken'));
}

// ---------------------------------------------------------------- 编辑模式

/** 批量锁定/解锁选中的分组（编辑条按钮）。文件夹无锁定语义，自动跳过。 */
async function editSetLocked(locked) {
  const ids = [...selected].filter((id) => {
    const g = ui.byId?.get(id);
    return g && g.type === 'group' && g.groupType !== 'folder' && g.locked !== locked;
  });
  if (!ids.length) {
    toast(locked ? '没有可锁定的分组（可能已锁定或未勾选）' : '没有可解锁的分组（可能已解锁或未勾选）', true);
    return;
  }
  await setGroupsLocked(ids, locked);
  // 同步缓存：锁定图标就地更新，避免整表重绘
  for (const id of ids) {
    const g = ui.byId?.get(id);
    if (g) g.locked = locked;
    const el = container.querySelector(`.st-group[data-gid="${id}"]`);
    if (el) {
      const btn = el.querySelector('.st-lock');
      if (btn) {
        btn.classList.toggle('on', locked);
        btn.textContent = locked ? '🔒' : '🔓';
        btn.title = locked ? '解锁（允许整组删除）' : '锁定分组（防止整组被删除）';
      }
      el.classList.toggle('st-locked', locked);
    }
  }
  toast(`${locked ? '已锁定' : '已解锁'} ${ids.length} 个分组`);
}

async function editDeleteSelected() {
  const ids = [...selected];
  if (!ids.length) { toast('请先勾选分组', true); return; }
  const inTrash = currentFolder === 'trash';
  if (!(await confirmDialog({
    title: inTrash ? '彻底删除所选' : '批量删除',
    message: inTrash
      ? `彻底删除选中的 ${ids.length} 项（含全部内容）？不可恢复。`
      : `把选中的 ${ids.length} 个分组移入回收站？\n锁定的分组会被跳过。`,
    confirmText: inTrash ? '彻底删除' : '移入回收站', danger: true,
  }))) return;
  let done = 0, skipped = 0;
  if (inTrash) {
    // 回收站视图：勾选的是组/文件夹，"删除"的语义就是彻底删除
    for (const id of ids) { await deleteGroupForever(id); done++; }
    toast(`已彻底删除 ${done} 项`);
  } else {
    for (const id of ids) { if (await moveToTrash(id)) done++; else skipped++; }
    toast(`已移入回收站 ${done} 组${skipped ? `，跳过锁定 ${skipped} 组` : ''}`);
  }
  selected.clear();
  await repaint();
}

// ---------------------------------------------------------------- 事件绑定
//
// 所有按钮统一走容器上的事件委托(data-act),不逐个 addEventListener——
// Chromium 大模板偶发丢字符会让个别骨架元素缺失,逐个绑定会在缺失时
// 抛 null.addEventListener 使整页瘫痪;委托则天然免疫。
//
// 注：「收纳当前窗口 / 全部窗口」按钮已按需求从工具栏移除；
// doStash(stashOpenTabs) 保留在 lib/stash.js，需要时可在 popup 等处重新接上。

/** 左栏点击组条目：确保右侧显示其父文件夹内容，然后滚动定位并短暂高亮。
 *  轻量路径：目标组已在当前视图（同父文件夹，绝大多数点击）时完全不重绘——
 *  只就地切换左栏高亮 class + 滚动定位。此前每次点击都走 repaintFromCache
 *  把整个主区 HTML 重建一遍（大列表下明显卡顿），还需要它只为"切文件夹"。 */
// 主区定位高亮互斥锁：记录当前高亮卡片与淡出定时器。快速连点时先摘旧再点新，
// 否则旧高亮未淡出、新高亮又加，主区会同时叠出多个高亮框（像多选一样）
let locateFx = null;
async function locateGroupEntry(gid) {
  const g = ui.byId?.get(gid);
  if (!g) return;
  // 搜索/筛选残留下点组：目标组可能被过滤词藏掉（querySelector 落空 = 点了
  // 没反应）。先清残留重绘，保证主区是完整分组视图再定位
  if (searchNeedle || filterMode) {
    resetViewFilters();
    repaintFromCache();
  }
  // 回收站里的组父节点就是 'trash'：直接切到回收站视图定位（此前错回 root，
  // 组不在 root 下，定位永远落空）
  const parent = g.parentIds?.[0] || 'root';
  if (currentFolder !== parent) {
    // 跨文件夹：优先用视图缓存恢复（无重建、无闪烁）；缓存未命中由
    // switchFolderTo 内部直接加载目标范围（不经过会清缓存的 repaint）。
    // 等它重绘完再查询 DOM，否则定位不到
    await switchFolderTo(parent);
  }
  // 左栏聚焦高亮：就地切换 class（重绘路径由 sideGroupItemHtml 按 locatedGid 恢复）。
  // 注意组条目可能在上列表区（文件夹树/主列表）或底区（回收站列表）：
  // 摘旧加新都要两边都查，只查 sideList 会让底区旧高亮永远摘不掉
  locatedGid = gid;
  for (const prev of container.querySelectorAll('.st-side-group.located')) {
    if (prev.dataset.group !== gid) prev.classList.remove('located');
  }
  const sideEl = container.querySelector(`.st-side-group[data-group="${gid}"]`);
  if (sideEl) sideEl.classList.add('located');
  const el = container.querySelector(`.st-group[data-gid="${gid}"]`);
  if (!el) return;
  // 滚动定位（整页滚动）：只用 window.scrollTo 滚页面——绝不用 scrollIntoView，
  // 它会连带滚动沿途所有可滚祖先（比如侧栏列表内部），看起来整栏被拖走。
  // 停靠点 = 吸顶页头+工具栏总高(--st-top-h) + 18px 呼吸：固定栏不动，只让
  // 主内容滚上来；目标组已在视野内（工具栏以下全部可见）时只高亮不滚。
  const r = el.getBoundingClientRect();
  const topLimit = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--st-top-h')) || 0) + 18;
  const alreadyVisible = r.top >= topLimit && r.bottom <= window.innerHeight;
  if (!alreadyVisible) {
    // 距离近（<1 屏）用平滑滚动（跟手且舒适）；距离远用瞬时跳转。不能一律
    // smooth：分组卡片开了 content-visibility:auto（视口外不布局），平滑滚过
    // 几千行时每一帧都要现算中途卡片布局 = 全程卡顿发重；瞬时跳转只重一帧。
    if (Math.abs(r.top - topLimit) < window.innerHeight) {
      window.scrollTo({ top: window.scrollY + r.top - topLimit, behavior: 'smooth' });
    } else {
      window.scrollTo(0, window.scrollY + r.top - topLimit);
    }
  }
  // 定位高亮互斥：先摘掉上一张卡片的高亮并清其定时器（快速连点不叠框），
  // 再点亮目标卡片，1.6s 后淡出。重绘会换 DOM，旧引用已脱离文档也无害
  if (locateFx) {
    clearTimeout(locateFx.t);
    locateFx.el.classList.remove('st-locate');
  }
  el.classList.add('st-locate');
  locateFx = {
    el,
    t: setTimeout(() => {
      el.classList.remove('st-locate');
      if (locateFx && locateFx.el === el) locateFx = null;
    }, 1600),
  };
}

async function onNewFolder() {
  const vals = await formDialog({ title: '新建文件夹', fields: [{ key: 'label', label: '文件夹名称：' }] });
  const label = vals?.label?.trim();
  if (label) {
    await createFolder(label, currentFolder === 'trash' ? 'root' : currentFolder);
    toast('已创建文件夹');
    await repaint();
  }
}

async function onTrashClear() {
  if (!(await confirmDialog({
    title: '清空回收站',
    message: '清空回收站？其中全部分组与标签页将被彻底删除，不可恢复。',
    confirmText: '清空', danger: true,
  }))) return;
  await emptyTrash();
  toast('已清空回收站');
  await repaint();
}

function showDataMenu(anchor) {
  showMenu(anchor, [
    { icon: '📥', label: '导入文本…', desc: '粘贴任意文本，提取其中的链接收纳为一组', run: () => importTextDialog().catch(actFail) },
    { icon: '📄', label: '导出为 HTML…', desc: 'OneTab 同款模板，可静态查看', run: () => downloadStashHtml().then((n) => toast(`已导出全部 ${n} 个标签的 HTML 文件`)).catch(actFail) },
    { icon: '💾', label: '导出为 JSON…', desc: 'OneTab 兼容备份，可互相导入', run: () => downloadStashJSON().then(() => toast('已导出 JSON 备份（含分组/文件夹/回收站，不含浏览历史）')).catch(actFail) },
    { sep: true },
    { icon: '♻️', label: '导入 JSON…', desc: '用备份替换本机收纳数据（先导出备份）', danger: true, run: () => ui.importFile?.click() },
  ]);
}

function editMoveSelected(anchor) {
  if (!selected.size) { toast('请先勾选分组', true); return; }
  showMoveMenu(anchor, [...selected]);
}

/** 批量复制选中的分组到剪贴板（组与组之间空一行）。 */
async function editCopySelected(fmt) {
  if (!selected.size) { toast('请先勾选分组', true); return; }
  const parts = [];
  for (const gid of selected) {
    try { parts.push(await buildGroupClipboard(gid, fmt)); } catch { /* 组刚被删则跳过 */ }
  }
  if (!parts.length) { toast('没有可复制的内容', true); return; }
  await navigator.clipboard.writeText(parts.join('\n\n'));
  toast(fmt === 'markdown' ? `已复制 ${parts.length} 组为 Markdown` : `已复制 ${parts.length} 组为 标题+网址`);
}

/** 把选中的分组导出为一个 HTML 文件（OneTab 同款模板）。 */
async function editExportSelected() {
  if (!selected.size) { toast('请先勾选分组', true); return; }
  const ids = [...selected];
  const n = await downloadStashHtml({ groupIds: ids });
  toast(`已导出所选 ${ids.length} 组（共 ${n} 个标签）`);
}

function editSelectAll() {
  // 只针对分组勾选框（标签勾选框不参与全选）
  const boxes = container.querySelectorAll('.st-sel:not(.st-tab-sel)');
  const allChecked = [...boxes].every((b) => b.checked);
  boxes.forEach((b) => { b.checked = !allChecked; });
  selected.clear();
  if (!allChecked) boxes.forEach((b) => selected.add(b.dataset.id));
  updateEditCount();
}

function bindEvents() {
  if (!ui.importFile || !ui.search) {
    console.error('[历史记录] 标签收纳骨架元素缺失（Chromium 渲染丢字符），导入/搜索暂不可用；重载扩展并重开页面可恢复。');
  }
  ui.importFile?.addEventListener('change', async () => {
    const file = ui.importFile.files?.[0];
    if (!file) return;
    try {
      const items = parseStashJSON(await file.text());
      if (!(await confirmDialog({
        title: '导入标签收纳',
        message: `导入将替换本机全部标签收纳数据（共 ${items.length} 条记录，含分组/文件夹/回收站），浏览历史与书签不受影响。\n建议先用"数据 ▾ → 导出 JSON"备份当前数据。确定继续？`,
        confirmText: '导入并替换', danger: true,
      }))) return;
      const r = await sendD1({ type: 'd1SyncImport', items });
      if (!r.ok) throw new Error(r.error || '导入失败');
      currentFolder = 'root';
      await repaint();
      toast(`导入完成：${items.length} 条记录。自动同步已暂停，可在设置页手动同步。`);
    } catch (e) {
      actFail(e);
    } finally {
      ui.importFile.value = '';
    }
  });

  ui.search?.addEventListener('input', () => {
    searchNeedle = ui.search.value.trim();
    // 搜索只改过滤词、不动数据：作用域命中时用缓存重绘（零读库、即时响应）；
    // 缓存不在当前范围（刚切文件夹等）才回退防抖全量重绘
    if (ui.byId && ui.scope === currentFolder) repaintFromCache();
    else scheduleRepaint();
  });

  // 只看锁定：与搜索同一重绘策略（改过滤条件、不动数据）
  ui.lockedOnly?.addEventListener('change', () => {
    lockedOnly = ui.lockedOnly.checked;
    if (ui.byId && ui.scope === currentFolder) repaintFromCache();
    else scheduleRepaint();
  });

  // 主区 + 工具栏统一事件委托
  container.addEventListener('click', (e) => {
    const actEl = e.target.closest('[data-act]');
    if (actEl) {
      const act = actEl.dataset.act;
      const id = actEl.dataset.id;
      try {
        switch (act) {
          case 'filterMenu': showFilterMenu(actEl); return;
          case 'dataMenu': showDataMenu(actEl); return;
          case 'editToggle': {
            // 分块补注进行中（超大文件夹刚打开）：先补全再进编辑模式，
            // 否则"全选 / 批量"只会作用于已注入的部分分组
            if (snapFillActive) repaint();
            // 编辑模式切换只改容器 class（勾选框由 CSS 显隐）和编辑条，不做全量重绘
            editing = !editing;
            if (!editing) {
              selected.clear();
              selectedTabs.clear();
              container.querySelectorAll('.st-sel:checked').forEach((b) => { b.checked = false; });
            }
            container.classList.toggle('st-editing', editing);
            ui.editBar.classList.toggle('st-editbar-off', !editing);
            syncStashLayout(); // 编辑条显隐改变吸顶工具栏高度：重测 --st-top-h
            ui.editToggle.textContent = editing ? '完成' : '编辑';
            ui.editToggle.classList.toggle('primary', editing);
            updateEditCount();
            return;
          }
          case 'editAll': editSelectAll(); return;
          case 'editDelete': editDeleteSelected().catch(actFail); return;
          case 'editLock': editSetLocked(true).catch(actFail); return;
          case 'editUnlock': editSetLocked(false).catch(actFail); return;
          case 'editMove': editMoveSelected(actEl); return;
          case 'editCopy': showMenu(actEl, [
            { label: '📋 复制为 标题+网址', run: () => editCopySelected('text').catch(actFail) },
            { label: '📝 复制为 Markdown', run: () => editCopySelected('markdown').catch(actFail) },
          ]); return;
          case 'editExport': editExportSelected().catch(actFail); return;
          case 'newFolder': onNewFolder().catch(actFail); return;
          case 'trashClear': onTrashClear().catch(actFail); return;
          case 'menu': showGroupMenu(actEl, id); return;
          case 'folderMenu': showFolderMenu(actEl, id); return;
          case 'untrash':
            // 回收站恢复：弹「选择还原位置」菜单（主列表/任意文件夹/新建），与 OneTab 一致
            showMoveMenu(actEl, [id]);
            return;
        }
        onAction(act, id).catch(actFail);
      } catch (err) {
        actFail(err);
      }
      return;
    }
    // 打开文件夹 / 左栏导航（纯导航：数据未变，用缓存重绘，跳过重读库）
    const folderEl = e.target.closest('[data-folder]');
    if (folderEl) {
      // 视图缓存：离开时存下当前视图（含滚动位置），切回时原地恢复（见
      // switchFolderTo）；未命中缓存（首次进入该视图）由其内部直接加载目标
      // 范围重绘——不经过 repaint()，其它视图的缓存不被清掉
      switchFolderTo(folderEl.dataset.folder).catch(actFail);
      return;
    }
    // 左栏点击标签组条目：切到其父文件夹并定位高亮该组
    const sideGroupEl = e.target.closest('[data-group]');
    if (sideGroupEl) {
      locateGroupEntry(sideGroupEl.dataset.group).catch(actFail);
      return;
    }
    // 点击组头空白区域:折叠/展开(按钮、勾选框、名称等各有自己的行为);回收站走会话内折叠
    const headEl = e.target.closest('.tg-group-head');
    if (headEl && !e.target.closest('button, input, label, .st-label')) {
      const group = headEl.closest('.st-group[data-gid]');
      if (group) onAction(currentFolder === 'trash' ? 'trashCollapse' : 'collapse', group.dataset.gid).catch(actFail);
      return;
    }
    // 点击标签行（标题/图标区域）打开页面；编辑模式下点击行 = 勾选/取消该标签。
    // 判据用 data-tid 而非 data-url：快照注入的行剥掉了 data-url（省体积），
    // 数据没变化时不重绘——用 url 当判据会让"初始打开后点标签无反应"
    // （openStashTab 自己会读库拿 url，行上有没有都无所谓）
    const row = e.target.closest('.tg-row');
    if (row && row.dataset.tid) {
      if (editing && row.dataset.tid && !e.target.closest('button, .st-tab-sel')) {
        const tid = row.dataset.tid;
        const box = row.querySelector('.st-tab-sel');
        if (selectedTabs.has(tid)) selectedTabs.delete(tid); else selectedTabs.add(tid);
        if (box) box.checked = selectedTabs.has(tid);
        updateEditCount();
        return;
      }
      openTabAndPrune(row.dataset.tid);
    }
  });

  // 拖拽入口(OneTab 式,无需编辑模式):按住标签行拖 → 拖标签;
  // 按住组头拖 → 拖整组;回收站内禁用。原位松手仍走普通点击(勾选/打开/折叠)。
  container.addEventListener('pointerdown', (e) => {
    if (currentFolder === 'trash' || filterMode || e.button !== 0 || drag || !ui.byId) return;
    const row = e.target.closest('.tg-row');
    if (row && row.dataset.tid && !e.target.closest('button')) {
      e.preventDefault();
      beginPress(e, 'tab', null, row);
      return;
    }
    const head = e.target.closest('.tg-group-head');
    if (head && !e.target.closest('button, input, label')) {
      const groupEl = head.closest('.st-group[data-gid]');
      if (!groupEl) return;
      e.preventDefault();
      beginPress(e, 'group', [groupEl.dataset.gid], groupEl);
      return;
    }
    // 左栏条目也是拖拽源(OneTab 树):按住文件夹/组条目拖动 → 拖该节点
    const sideItem = e.target.closest('.st-side-item');
    if (sideItem && !e.target.closest('button')) {
      const sid = sideItem.dataset.group || sideItem.dataset.folder;
      if (sid && sid !== 'root' && sid !== 'trash' && ui.byId?.get(sid)) {
        e.preventDefault();
        beginPress(e, 'group', [sid], sideItem);
      }
    }
  });

  // checkbox 单独处理（避免触发行点击）：「打开后移除」/ 标签框与分组框分别记账
  container.addEventListener('change', (e) => {
    const openDelBox = e.target.closest('.st-open-del');
    if (openDelBox) {
      // 就地更新缓存（判定即时生效）+ 显式写库，不重绘（勾选框状态自持）
      const g = ui.byId?.get(openDelBox.dataset.id);
      if (g) g.openDelete = openDelBox.checked;
      setOpenDelete(openDelBox.dataset.id, openDelBox.checked).catch(actFail);
      return;
    }
    const tabBox = e.target.closest('.st-tab-sel');
    if (tabBox) {
      if (tabBox.checked) selectedTabs.add(tabBox.dataset.tid); else selectedTabs.delete(tabBox.dataset.tid);
      updateEditCount();
      return;
    }
    const box = e.target.closest('.st-sel');
    if (!box) return;
    if (box.checked) selected.add(box.dataset.id); else selected.delete(box.dataset.id);
    updateEditCount();
  });

  // 右键菜单：左栏条目（主列表/文件夹树/组条目/回收站）→ 组头 / 标签行
  container.addEventListener('contextmenu', (e) => {
    // 左栏：文件夹/特殊节点右键复用主区现成菜单（showFolderMenu 等），动作一致
    const sideItem = e.target.closest('.st-side-item');
    if (sideItem && !e.target.closest('button, input')) {
      const fid = sideItem.dataset.folder;
      const gid = sideItem.dataset.group;
      if (fid === 'trash') {
        e.preventDefault();
        showMenu(sideItem, [{ label: '🧹 清空回收站…', run: () => onTrashClear() }]);
        return;
      }
      if (fid === 'root') {
        e.preventDefault();
        showMenu(sideItem, [{ label: '➕ 新建文件夹…', run: () => onNewFolder().catch(actFail) }]);
        return;
      }
      if (fid && ui.byId?.get(fid)?.groupType === 'folder') {
        e.preventDefault();
        showFolderMenu(sideItem, fid);
        return;
      }
      if (gid && ui.byId?.get(gid)) {
        e.preventDefault();
        if (currentFolder === 'trash') {
          // 回收站内的组：还原到指定位置 / 彻底删除（与回收站视图行内动作一致）
          showMenu(sideItem, [
            { label: '♻️ 还原到…', run: () => showMoveMenu(sideItem, [gid]) },
            { sep: true },
            { label: '🗑 彻底删除…', run: async () => {
              if (!(await confirmDialog({
                title: '彻底删除',
                message: '彻底删除这一组及其全部内容？不可恢复。',
                confirmText: '彻底删除', danger: true,
              }))) return;
              await deleteGroupForever(gid);
              toast('已彻底删除');
              await repaint();
            } },
          ]);
        } else {
          showGroupMenu(sideItem, gid);
        }
        return;
      }
      return; // 右键在左栏但未命中节点：不出菜单
    }

    const row = e.target.closest('.tg-row');
    if (row && row.dataset.tid) {
      e.preventDefault();
      const tid = row.dataset.tid;
      const t = ui.byId?.get(tid);
      // 回收站里的行只读：右键仅允许打开（置顶/备注/删除对回收站数据有歧义）
      if (currentFolder === 'trash') {
        showMenu(e.target, [
          { label: '🌐 打开', run: () => openTabAndPrune(tid) },
          { label: '🔗 复制链接', run: () => copyTabUrl(row.dataset.url) },
        ]);
        void t;
        return;
      }
      showMenu(e.target, [
        { label: '🌐 打开', run: () => openTabAndPrune(tid) },
        { label: '🔗 复制链接', run: () => copyTabUrl(row.dataset.url) },
        { label: '📌 置顶到组头部', run: () => onAction('pin', tid).catch(actFail) },
        { label: '✎ 备注…', run: () => onAction('tabNotes', tid).catch(actFail) },
        { sep: true },
        { label: '🗑 删除', run: () => onAction('delTab', tid).catch(actFail) },
      ]);
      void t;
      return;
    }
    const head = e.target.closest('.tg-group-head');
    if (head) {
      const group = head.closest('[data-gid]');
      if (group) {
        e.preventDefault();
        showGroupMenu(e.target, group.dataset.gid);
      }
    }
  });

  // 外部拖入(OneTab 的 Xs):把浏览器/其它应用拖来的链接解析成一组,收纳到当前文件夹。
  // dragover 阶段 dataTransfer.getData 被禁,只读 types 判定;drop 时再按
  // text/uri-list → text/html → text/plain 三个分支解析。
  const hasExternalDragTypes = (dt) => {
    if (!dt) return false;
    const types = [...(dt.types || [])];
    // 本扩展内部的拖拽(如书签页的行拖拽)不算外部拖入，避免全局监听干扰其 dropEffect
    if (types.includes('application/x-webhistory-bm')) return false;
    return types.some((t) => t === 'text/uri-list' || t === 'text/html' || t === 'text/plain');
  };
  const extractExternalLinks = (dt) => {
    const out = [];
    const seen = new Set();
    const push = (url, title) => {
      if (!/^https?:\/\//i.test(url || '') || seen.has(url)) return;
      seen.add(url);
      out.push({ url, title: (title || '').replace(/^[\s|·—\t-]+|[\s|·—\t-]+$/g, '').slice(0, 200), pinned: false });
    };
    const firstUrl = (s) => (s || '').match(/https?:\/\/[^\s"'<>）]+/i)?.[0] || '';
    const uriList = dt.getData('text/uri-list');
    if (uriList) {
      for (const line of uriList.split(/\r?\n/)) {
        if (line.startsWith('#')) continue;
        const url = firstUrl(line);
        if (url) push(url, line.replace(url, '').trim());
      }
    }
    if (!out.length) {
      const html = dt.getData('text/html');
      if (html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        for (const a of doc.querySelectorAll('a[href]')) push(a.href, a.textContent.trim());
        if (!out.length) {
          const url = firstUrl(doc.body?.textContent || '');
          if (url) push(url, doc.title || '');
        }
      }
    }
    if (!out.length) {
      const text = dt.getData('text/plain');
      if (text) {
        for (const line of text.split(/\r?\n/)) {
          const url = firstUrl(line);
          if (url) push(url, line.replace(url, '').trim());
        }
        if (!out.length) {
          const url = firstUrl(text);
          if (url) push(url, '');
        }
      }
    }
    return out;
  };
  let extDragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (!built || !container?.isConnected || drag || currentFolder === 'trash') return;
    if (!hasExternalDragTypes(e.dataTransfer)) return;
    extDragDepth++;
    container.classList.add('st-ext-drag');
  });
  document.addEventListener('dragleave', () => {
    if (extDragDepth > 0 && --extDragDepth === 0) container.classList.remove('st-ext-drag');
  });
  document.addEventListener('dragover', (e) => {
    if (!container.classList.contains('st-ext-drag')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', (e) => {
    if (!container.classList.contains('st-ext-drag')) return;
    e.preventDefault();
    extDragDepth = 0;
    container.classList.remove('st-ext-drag');
    const tabs = extractExternalLinks(e.dataTransfer);
    if (!tabs.length) { toast('拖入的内容里没有可识别的 http(s) 链接', true); return; }
    const parent = currentFolder === 'trash' ? 'root' : currentFolder;
    stashTabs(tabs, { groupLabel: '拖入 ' + new Date().toLocaleDateString('zh-CN'), parent })
      .then((g) => {
        toast(`已收纳 ${g.childIds.length} 个拖入的链接`);
        return repaint();
      })
      .catch(actFail);
  });

  // 云端合并或其它设备变更 → 重绘
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'd1SyncUpdated') scheduleRepaint();
    });
    // 跨页面写库广播（弹窗/右键菜单/其它收纳页窗口）：收到即重绘（含侧栏计数）。
    // 带本页面实例令牌的广播 = 自己刚写的库，忽略——否则本页每次写库都全量
    // 重绘，滚动位置被打乱（表现为"点标签后页面随机跳位置"）
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel('web-history-stash-changed');
      ch.onmessage = (e) => {
        if (e.data?.token !== NOTIFY_TOKEN) scheduleRepaint();
      };
    }
  } catch { /* 忽略 */ }

  // 窗口尺寸变化可能让页面头部换行/变高：侧栏高度上限与 sticky 偏移链需重算
  window.addEventListener('resize', () => {
    syncStashLayout();
    syncStickyOffsets();
  });

  // 吸顶偏移防"稍微下移"：骨架刚建好时字体/图标未加载完，页头实际高度比测量值
  // 大几像素，sticky 元素会先滑到页头背后再停住。首帧后与字体就绪后各重算一次。
  requestAnimationFrame(() => { syncStashLayout(); syncStickyOffsets(); });
  if (document.fonts?.ready) document.fonts.ready.then(() => {
    syncStashLayout();
    syncStickyOffsets();
  });

  // 图标加载失败时隐藏，避免裂图
  container.addEventListener('error', (e) => {
    if (e.target.tagName === 'IMG') e.target.style.display = 'none';
  }, true);
}

function sendD1(msg) {
  return new Promise((res) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        if (chrome.runtime.lastError) res({ ok: false, error: chrome.runtime.lastError.message });
        else res(r || { ok: false, error: '后台无响应' });
      });
    } catch (e) {
      res({ ok: false, error: String(e) });
    }
  });
}

function buildSkeleton() {
  // 分块渲染：Chromium 对大模板字符串有偶发解析丢字符的 bug（见 util.setInnerHTML），
  // 骨架拆成外壳 + 侧栏 + 主区三块，每块足够小以通过自检。
  setInnerHTML(container, `
    <div class="stash-split">
      <aside class="stash-side" id="stSide"></aside>
      <div class="stash-main" id="stMain"></div>
    </div>
    <input type="file" id="stImportFile" accept=".json,application/json" hidden>
  `);
  syncStashLayout(); // 骨架建好即可定高，首绘前布局就位（避免闪一次整页滚动）
  setInnerHTML(container.querySelector('#stSide'), `
    <div class="st-side-head">
      <div class="st-side-tabs">
        <!-- active 写死在骨架里：默认视图就是 root（标签），不依赖首次 paintSide
             补挂——否则打开页面瞬间页签无高亮，要手动切换一次才显示 -->
        <button class="st-side-tab active" data-folder="root" title="显示主列表与文件夹">标签</button>
        <button class="st-side-tab" data-folder="trash" title="显示回收站">回收站</button>
      </div>
      <button class="btn btn-sm" id="stNewFolder" data-act="newFolder" title="在当前位置新建文件夹">＋ 新建</button>
    </div>
    <div class="st-side-scroll" id="stSideList"></div>
    <div class="st-side-bottom" id="stSideBottom"></div>
    <!-- 占位常驻（显隐用 visibility，见 paintWith）：hidden 增删一行高会让
         左栏列表压缩/弹回，标签/回收站来回切细小跳动 -->
    <div class="st-side-actions" id="stTrashActions" style="visibility:hidden">
      <button class="btn btn-sm st-danger" id="stTrashClear" data-act="trashClear">清空回收站</button>
    </div>
  `);
  setInnerHTML(container.querySelector('#stMain'), `
    <div class="tg-section st-toolbar-sec">
      <div class="row st-toolbar" id="stToolbar">
        <input type="search" id="stSearch" placeholder="搜索标题 / 网址 / 分组名" style="flex:1;min-width:160px;">
        <label class="st-locked-only" style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;user-select:none;white-space:nowrap;" title="只显示已锁定的分组（锁定的分组不能被整组删除/移动/融合）">
          <input type="checkbox" id="stLockedOnly" ${lockedOnly ? 'checked' : ''}> 只看锁定
        </label>
        <button class="btn" id="stSortMenu" data-act="filterMenu" title="把各组标签拿出来平铺排列（不改动分组）">筛选 ▾</button>
        <button class="btn" id="stDataMenu" data-act="dataMenu" title="导出 / 导入（与 OneTab 兼容）">数据 ▾</button>
        <button class="btn" id="stEditToggle" data-act="editToggle" title="进入编辑模式：多选分组，批量删除或移动">编辑</button>
      </div>
      <!-- 编辑条：搜索栏下方独立一行（仅编辑模式显示，见 .st-editbar-off）。
           它在吸顶工具栏块内，出现时吸顶区变高——syncStashLayout 会重测
           --st-top-h，让组卡停靠点/滚动避让跟上，不会被编辑条盖住 -->
      <div class="row st-toolbar st-editbar st-editbar-off" id="stEditBar">
        <button class="btn btn-sm" id="stEditAll" data-act="editAll">全选 / 反选</button>
        <button class="btn btn-sm" id="stEditLock" data-act="editLock" title="锁定选中的分组（防止整组删除/移动/融合）">🔒 锁定所选</button>
        <button class="btn btn-sm" id="stEditUnlock" data-act="editUnlock" title="解锁选中的分组">🔓 解锁所选</button>
        <button class="btn btn-sm" id="stEditCopy" data-act="editCopy" title="把选中的分组复制到剪贴板">复制所选 ▾</button>
        <button class="btn btn-sm" id="stEditMove" data-act="editMove" title="把选中的分组移动到其它文件夹">移动到文件夹…</button>
        <button class="btn btn-sm" id="stEditExport" data-act="editExport" title="把选中的分组导出为一个 HTML 文件（OneTab 同款模板）">导出所选</button>
        <button class="btn btn-sm st-danger" id="stEditDelete" data-act="editDelete" title="把选中的分组移入回收站">删除所选</button>
        <span class="muted" id="stEditCount"></span>
      </div>
    </div>
    <div id="stGroups" class="st-groups"></div>
  `);
  ui = {
    byId: null,
    counts: null, // 侧栏计数 Map<nodeId, number>（索引 count，范围外也准）
    scope: null, // 缓存覆盖的文件夹（'root' | folderId | 'trash'）；repaintFromCache 的命中判据
    sideList: container.querySelector('#stSideList'),
    sideBottom: container.querySelector('#stSideBottom'),
    newFolder: container.querySelector('#stNewFolder'),
    trashActions: container.querySelector('#stTrashActions'),
    trashClear: container.querySelector('#stTrashClear'),
    groups: container.querySelector('#stGroups'),
    toolbar: container.querySelector('#stToolbar'),
    editBar: container.querySelector('#stEditBar'),
    editCount: container.querySelector('#stEditCount'),
    dataMenu: container.querySelector('#stDataMenu'),
    importFile: container.querySelector('#stImportFile'),
    search: container.querySelector('#stSearch'),
    lockedOnly: container.querySelector('#stLockedOnly'),
    editToggle: container.querySelector('#stEditToggle'),
    editAll: container.querySelector('#stEditAll'),
    editCopy: container.querySelector('#stEditCopy'),
    editMove: container.querySelector('#stEditMove'),
    editExport: container.querySelector('#stEditExport'),
    editDelete: container.querySelector('#stEditDelete'),
  };
  built = true;
}

// ---------------------------------------------------------- 打开提速：页面快照
//
// 每次打开 dashboard 都是新页面，"读库+重建 DOM"有固定开销。
// 数据渲染完成后把左栏/主区 HTML 存入 IndexedDB settings 表（localStorage 只有
// ~5MB 配额，大收藏量必然 QuotaExceeded），下次打开先注入快照——
// 打开瞬间即是完整内容（图标命中浏览器磁盘缓存），随后 repaint 校对数据。
// 本页全部交互走容器级事件委托，注入的 HTML 即刻可用。

const SNAPSHOT_KEY = 'stashSnapshotV1';
/** 快照的渲染逻辑版本：渲染/计数逻辑改动时 +1。旧版本快照直接弃用（下次打开
 *  走全量首绘）——否则上次保存的 HTML 会把旧逻辑烤死的显示（如修复前恒显 0
 *  的侧栏计数）继续展示，而"无变更"校对路径按设计不会重绘，坏显示会一直留传。 */
const SNAP_VER = 7; // v7：快照不再保存搜索态（v6 及以前的快照可能含搜索结果 DOM，作废）
const T_MODULE = Math.round(performance.now()); // 模块链求值时刻（相对页面打开）
let openLogDone = false;   // 打开耗时只打一次日志
let renderSnapInfo = '';   // 本次进入的快照命中情况
let lastSnapSave = 0;      // 节流：快照保存至少间隔 3s
let freshMark = 0;         // DOM 所反映的数据时刻（每次 paintWith 结束更新）

const idleRun = window.requestIdleCallback || ((f) => setTimeout(f, 200));

/** 快照分块注入的行预算：首屏先注入累计行数达到该值的"整组"，其余批次在空闲回调里
 *  按同预算追加。只按整组切分——分组是 #stGroups 的顶层节点，把一组拆到一半会破坏
 *  HTML 结构（片段解析会隐式闭合未闭合标签，后半段行会掉到组外），因此单个行数超预算
 *  的组会作为一批整体注入（该场景罕见，且与常规 paint 整组渲染同耗时，可接受）。 */
const SNAP_CHUNK_ROWS = 200;
/** 分组 / 行在 HTML 里的起始标记。全部用户文本都经 escapeHtml（& < > " ' 全转义），
 *  这两个标记不可能出现在属性值或文本内容里，按 indexOf 顺序扫描切分是安全的。 */
const SNAP_GROUP_OPEN = '<div class="tg-group st-group';
const SNAP_ROW_OPEN = '<div class="vrow tg-row" data-tid="';
let snapFillToken = 0;      // 分块补注代数：paintWith / 重新注入时递增，旧批次据此静默中止
let snapFillActive = false; // 分块补注进行中：此时 #stGroups 只有一部分，禁止存快照

/** 按需数据校验（OneTab 哲学：没变化就什么都不做）。
 *  后台只读库比对新旧——纯数据比对，不动 DOM、不产生主线程长任务；
 *  数据真的变了（其它标签页/云同步改的）才重建。本页自己的变更走
 *  paintWith 时已推进 freshMark，天然跳过。
 *  百万级数据：优先按 byModifyDate 索引只取"变化过的记录"——没有其它来源
 *  变更时是一次毫秒级空范围查询；随后仍会加载一份可见范围填充交互缓存
 *  （ui.byId，约 5~6 次索引查询、毫秒级），供菜单/拖拽/重命名等即时使用，
 *  但不动 DOM（快照注入的内容继续显示）。
 *  索引不可用（库还没升级到 v5）时抛错，回退旧的全量比对，行为不变。 */
async function verifyFreshness() {
  let changed = null;
  try {
    changed = await readStashChangesSince(freshMark);
  } catch { /* 索引不可用：走下面的全量比对回退 */ }

  if (changed && !changed.length) {
    // 没有其它来源的变更：只补交互缓存，DOM 保持快照不动
    try {
      ui.byId = await readStashScope(currentFolder);
      ui.scope = currentFolder;
      await refreshCounts(ui.byId);
      // 计数就地校对：快照 HTML 里的计数可能生于旧逻辑（版本校验只兜底跨版本，
      // 同版本内异常保存的坏计数也一并修正），不重绘、不牺牲秒开
      patchSnapCounts();
      // 左栏按当前模板重绘：快照里的左栏 HTML 可能生于旧版模板（改模板不必再
      // 靠 SNAP_VER+1 兜底）——数据已在手上，重绘只是拼几十行字符串，开销可忽略
      paintSide(ui.byId);
      // 登记当前视图缓存（与 repaint 同款，frag 延迟到切走时才摘）：快照会话
      // 此前从不登记缓存，切走→重绘会清空缓存→切回必然全量重建主区（大文件夹
      // 下"从回收站切回标签变慢变重"的根因）。登记后切换链路闭合：来回切换
      // 都是零重建的缓存命中
      if (!snapFillActive) {
        viewCache.set(currentFolder, {
          frag: null, byId: ui.byId, scope: currentFolder,
          counts: ui.counts, tabCounts: ui.tabCounts,
        });
      }
    } catch { /* 读库失败忽略：后续任意变更操作都会触发 repaint */ }
    return;
  }

  try {
    if (changed) {
      // 有变更：只重取可见范围（不全表读），按需重绘
      let byId = await readStashScope(currentFolder);
      if (currentFolder !== 'root' && currentFolder !== 'trash' && !byId.has(currentFolder)) {
        currentFolder = 'root';
        byId = await readStashScope('root');
      }
      ui.byId = byId;
      await refreshCounts(byId);
      paintWith(byId);
      return;
    }
    // 回退路径（老库无 byModifyDate 索引）：全量比对，行为与旧实现一致
    const byId = await readAllStashItems();
    let dirty = false;
    for (const it of byId.values()) if ((it.modifyDate || 0) > freshMark) { dirty = true; break; }
    ui.byId = byId; // 刷新缓存（含"没变"时）
    await refreshCounts(byId);
    patchSnapCounts(); // 同上：DOM 不动，只把计数改对
    paintSide(ui.byId); // 左栏按当前模板重绘（同上：快照模板可能过时）
    if (!dirty && !snapFillActive) {
      // 登记当前视图缓存（同索引路径）：保证快照会话切换链路闭合，切回零重建
      viewCache.set(currentFolder, {
        frag: null, byId: ui.byId, scope: currentFolder,
        counts: ui.counts, tabCounts: ui.tabCounts,
      });
    }
    if (!dirty) return; // 数据没变：DOM 不动
    if (currentFolder !== 'root' && currentFolder !== 'trash' && !byId.has(currentFolder)) currentFolder = 'root';
    paintWith(byId);
  } catch { /* 读库失败忽略：后续任意变更操作都会触发 repaint */ }
}

/** 生成快照 HTML：用字符串替换而非 cloneNode 逐节点遍历——title/data-url 的值
 *  都经过 escapeHtml（不含未转义引号），正则安全且快一个量级。
 *  网址在行内重复存 3-4 处是体积大头，去除后由 repaint 原样恢复。 */
function snapHtml(sel) {
  const el = container.querySelector(sel);
  if (!el) return '';
  return el.innerHTML
    .replace(/ title="[^"]*"/g, '')
    .replace(/ data-url="[^"]*"/g, '');
}

/** 保存页面快照到 IndexedDB。渲染后空闲时自动调用(节流 3s)，页面隐藏/关闭时 force。 */
async function saveSnapshot(force = false) {
  try {
    if (!built || !container || !ui?.byId) return;
    if (snapFillActive) return; // 分块补注进行中：#stGroups 只有一部分，存进去就是半张表
    if (filterMode) return; // 筛选视图是临时视图：不覆盖快照，下次打开仍是分组视图
    // 搜索同理：搜索结果只是过滤视图，存进快照会让刷新后永远停在旧搜索结果
    // （恢复时 searchNeedle 已归零，任何清理逻辑都判定"无残留"而不重绘）
    if (searchNeedle) return;
    const now = Date.now();
    if (!force && now - lastSnapSave < 3000) return;
    lastSnapSave = now;
    const payload = {
      ver: SNAP_VER,
      folder: currentFolder,
      sideList: snapHtml('#stSideList'),
      sideBottom: snapHtml('#stSideBottom'),
      groups: snapHtml('#stGroups'),
      savedAt: now,
    };
    await setSetting(SNAPSHOT_KEY, payload);
    console.debug('[收纳页] 快照已保存到 IndexedDB');
  } catch (e) {
    console.warn('[收纳页] 快照保存失败：', e);
  }
}

/** 渲染后的快照保存放到空闲时机——主线程不为序列化大 HTML 停顿。 */
function scheduleSnapSave() {
  idleRun(() => { void saveSnapshot(); });
}

/** 注入上次快照。轻量页在 <head> 里已并行预读（window.__stashSnapData，毫秒级可得），
 *  仪表盘路径回退 getSetting。返回 { hit, info }：hit=是否注入了可用快照
 *  （供 render 决定"后台校对"还是"直接首绘"），info 是人可读的命中情况（打开耗时日志）。
 *  未命中时 render 直接走 paint()——此时没有 freshMark=0 的全索引扫描问题。 */
async function restoreSnapshot() {
  try {
    const snap = window.__stashSnapData || await getSetting(SNAPSHOT_KEY, null);
    window.__stashSnapData = null; // 预读数据只用一次，之后以库为准
    if (!snap || typeof snap.groups !== 'string') return { hit: false, info: '无快照(尚未生成)' };
    if (Date.now() - snap.savedAt > 30 * 864e5) return { hit: false, info: '快照过期(已忽略)' };
    if (snap.ver !== SNAP_VER) return { hit: false, info: '快照版本过旧(已重绘)' };
    currentFolder = snap.folder || 'root';
    freshMark = snap.savedAt; // 注入的快照反映 savedAt 时刻的数据
    const q = (sel) => container.querySelector(sel);
    const t0 = performance.now();
    if (snap.sideList) q('#stSideList').innerHTML = snap.sideList;
    if (snap.sideBottom) { const el = q('#stSideBottom'); if (el) el.innerHTML = snap.sideBottom; }
    // 主区分块注入：先出累计 200 行的整组（首屏立即可见、不产生长任务），
    // 其余批次在空闲回调里按 200 行/批追加（只追加在末尾，已见内容与滚动位置不动）
    const rest = injectSnapGroups(q('#stGroups'), snap.groups);
    const ms = Math.round(performance.now() - t0);
    return { hit: true, info: rest ? `快照注入 ${ms}ms（余 ${rest} 批空闲补注）` : `快照注入 ${ms}ms` };
  } catch (e) {
    console.warn('[收纳页] 快照读取失败：', e);
    return { hit: false, info: '快照读取失败' };
  }
}

/** 统计一段 HTML 里的行数（按行起始标记计数）。 */
function countSnapRows(seg) {
  let n = 0;
  for (let p = 0; (p = seg.indexOf(SNAP_ROW_OPEN, p)) >= 0;) {
    n++;
    p += SNAP_ROW_OPEN.length;
  }
  return n;
}

/** 把 #stGroups 的快照 HTML 按"顶层整组"切片，并按行预算分批。
 *  返回 { first, batches }：first 是首屏块（分组前的非组内容——如空态提示——并入其中，
 *  再加整组直到累计行数首次达到预算，至少含一组）；batches 是剩余批次（每批同样按
 *  行预算合并整组，组后的尾随内容并入最后一批）。无分组时整体即 first（空态等场景）。
 *  边界判定用 div 嵌套深度：只有深度 0 处的分组起始标记才是顶层节点——回收站里
 *  被删文件夹展开后，其内部分组卡片是嵌套节点，仅按标记字符串切会切进半截组。 */
function planSnapChunks(html) {
  const isDivOpen = (i) => html.startsWith('<div', i) && (html[i + 4] === ' ' || html[i + 4] === '>');
  const starts = [];
  let depth = 0;
  for (let p = 0; p < html.length;) {
    const open = html.indexOf('<div', p);
    const close = html.indexOf('</div', p);
    if (open < 0 && close < 0) break;
    if (open >= 0 && (close < 0 || open < close)) {
      if (depth === 0 && isDivOpen(open) && html.startsWith(SNAP_GROUP_OPEN, open)) starts.push(open);
      depth++;
      p = open + 4;
    } else {
      depth--;
      p = close + 5;
    }
  }
  if (!starts.length) return { first: html, batches: [] };
  const bounds = [...starts, html.length]; // 第 i 组占据 [starts[i], bounds[i+1])
  const first = [html.slice(0, starts[0])]; // 分组前导内容（通常为空）
  let rows = 0;
  let i = 0;
  for (; i < starts.length; i++) {
    const seg = html.slice(starts[i], bounds[i + 1]);
    first.push(seg);
    rows += countSnapRows(seg);
    if (rows >= SNAP_CHUNK_ROWS) { i++; break; }
  }
  const batches = [];
  for (; i < starts.length;) {
    const batch = [];
    let r = 0;
    for (; i < starts.length; i++) {
      const seg = html.slice(starts[i], bounds[i + 1]);
      batch.push(seg);
      r += countSnapRows(seg);
      if (r >= SNAP_CHUNK_ROWS) { i++; break; }
    }
    batches.push(batch.join('')); // 每批至少吞掉一组，不会死循环
  }
  return { first: first.join(''), batches };
}

/** 分块注入快照主区：首屏块立即写入，其余批次在空闲回调里逐批追加。
 *  追加只用 insertAdjacentHTML('beforeend')——已见 DOM 节点不动、滚动位置不漂移；
 *  重绘（paintWith）会递增 snapFillToken，使未执行的旧批次静默退出。
 *  返回剩余批次数（0 表示一次性注入完成，与旧行为一致）。 */
function injectSnapGroups(el, html) {
  const { first, batches } = planSnapChunks(html);
  el.innerHTML = first;
  if (!batches.length) return 0;
  const token = ++snapFillToken;
  snapFillActive = true;
  const run = () => {
    if (token !== snapFillToken) return; // 已被重绘取代：静默退出（flag 归新持有者管理）
    const chunk = batches.shift();
    if (chunk != null) el.insertAdjacentHTML('beforeend', chunk);
    if (batches.length) { idleRun(run); return; }
    snapFillActive = false; // 全部注入完：恢复快照保存资格
  };
  idleRun(run);
  return batches.length;
}

window.addEventListener('pagehide', () => { void saveSnapshot(true); });
// 补充保险：部分关闭路径 pagehide 不可靠，页面切到后台时也立即保存
//（pagehide 时 IndexedDB 事务可能来不及提交，但渲染完成后的空闲保存是兜底）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void saveSnapshot(true);
});

export async function render(el) {
  container = el;
  if (!built) {
    buildSkeleton();
    bindEvents();
    syncStickyOffsets();
    syncStashLayout();
  }
  if (ui.byId) {
    // 二次进入：视图只是被 display:none 隐藏过，DOM 完好——不重建。
    // 只后台校验数据新鲜度（verifyFreshness 的"没变化"路径不动 DOM，只就地
    // 补计数；有变更才按需重绘），同时校准布局（窗口可能在其它页签时改过尺寸）。
    // 此前这里走 repaintFromCache：每次切回都全量重建主区 HTML，大列表下
    // 切页签明显卡顿——重建的收益为零，因为内容根本没变。
    syncStickyOffsets();
    syncStashLayout();
    void verifyFreshness();
    return;
  }
  // 首次进入：先做一次全库一致性修复（仅当数据版本自上次修复后有变化才真正跑）。
  // 显示（内存 childIds）与恢复/计数（parentIds 索引）是两条读路径，历史数据
  // 可能让两者不一致——组卡片看着空、「恢复」却能打开标签。修复后就统一了。
  // 修复改动了数据 → 本次的页面快照必然过期，跳过注入直接首绘。
  let repaired = 0;
  if (!built) {
    try {
      const ver = await getSetting('stashConsistencyVer', 0);
      const maxMod = await maxStashModifyDate();
      if (maxMod > ver) {
        repaired = await repairStashTreeConsistency();
        await setSetting('stashConsistencyVer', Math.max(maxMod, Date.now()));
      }
    } catch { /* 修复失败不阻塞打开 */ }
  }
  // 首次进入：先注入上次的页面快照（打开即完整内容）。
  const snap = repaired > 0 ? { hit: false, info: `一致性修复 ${repaired} 条(跳过快照)` } : await restoreSnapshot();
  renderSnapInfo = snap.info;
  if (snap.hit) {
    // 数据校对按 OneTab 哲学"没变化就什么都不做"：后台只读库比对新旧（纯数据比对，
    // 不动 DOM），数据真变了才重建——开页后主线程零长任务，交互始终跟手。
    // 范围读取后校对本身也只是几次索引查询，无需再等空闲，立即跑。
    void verifyFreshness();
  } else {
    // 没有可用快照：直接首绘（可见范围读取 + 渲染）。
    // 不能走 verifyFreshness——freshMark 还是 0，按索引比对等于全表扫描。
    await repaint();
  }
}
