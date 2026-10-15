// 浏览页（核心视图）：扁平单行时间线 + 筛选（时间/域名/搜索）
// + 按 3 天分块向前加载 + 单条删除。
// 收藏直接使用浏览器书签（lib/bookmarks.js）。
// "站点"按钮跳转到独立的站点页（左右分栏：站点列表 + 网址明细）。

import {
  queryVisits, deleteVisit, listWebsites, countByDay,
} from '../../lib/db.js';
import { confirmDialog } from '../../lib/dialog.js';
import { openBookmarkDialog } from '../../lib/bookmark-dialog.js';
import { removeBrowserBookmark, getBookmarkedUrlSet } from '../../lib/bookmarks.js';
import {
  escapeHtml, formatSmartTime, formatDateTime,
  debounce, stripWww, displayPath, setInnerHTML,
  faviconUrl,
} from '../../lib/util.js';
import { toast, switchTab } from '../dashboard.js';

const DAY = 86_400_000;
const CHUNK_DAYS = 3;                     // 每次向前加载的天数
const CHUNK_LIMIT = 5000;                 // 单块安全上限（正常远达不到）

// 筛选状态跨页签保留
const state = {
  range: '30d',
  customStart: '',
  customEnd: '',
  domains: [],
  text: '',
};

let items = [];
let bookmarkSet = new Set(); // 已加入浏览器书签的 url 集合
let chunkEnd = null;         // 下一批从此时间向前取（毫秒）
let hasMore = false;
let scanned = 0;
let built = false;
let ui = null;

function rangeToTimes() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  switch (state.range) {
    case 'today': return [todayStart, null];
    case 'yesterday': return [todayStart - DAY, todayStart];
    case '7d': return [Date.now() - 7 * DAY, null];
    case '30d': return [Date.now() - 30 * DAY, null];
    case '90d': return [Date.now() - 90 * DAY, null];
    case 'year': return [new Date(now.getFullYear(), 0, 1).getTime(), null];
    case 'custom': {
      let s = state.customStart ? new Date(state.customStart + 'T00:00:00').getTime() : null;
      let e = state.customEnd ? new Date(state.customEnd + 'T00:00:00').getTime() + DAY : null;
      // 起止颠倒时自动交换，避免构造出非法的 IDBKeyRange
      if (s != null && e != null && s > e) [s, e] = [e, s];
      return [s, e];
    }
    default: return [null, null];
  }
}

function buildSkeleton(container) {
  setInnerHTML(container, `
    <div class="filters">
      <div class="filter-row">
        <input type="search" id="textSearch" placeholder="搜索历史记录（标题 / 网址）…" style="flex:1; min-width:160px;">
      </div>
    </div>
    <div class="browse-split">
      <aside class="browse-side">
        <div class="quick-ranges" id="quickRanges">
          <button data-range="today">今天</button>
          <button data-range="yesterday">昨天</button>
          <button data-range="7d">近 7 天</button>
          <button data-range="30d">近 30 天</button>
          <button data-range="90d">近 90 天</button>
          <button data-range="year">今年</button>
          <button data-range="all">全部</button>
          <button data-range="custom">自定义</button>
        </div>
        <div class="custom-dates" id="customDates">
          <input type="date" id="dateStart"> <span class="muted">至</span> <input type="date" id="dateEnd">
        </div>
        <div class="domain-box">
          <input type="text" id="domainInput" placeholder="搜索站点，点选后筛选">
          <div class="domain-suggest" id="domainSuggest" hidden></div>
        </div>
        <div class="domain-chips" id="domainChips"></div>
        <button class="btn" id="goSites" title="切换到站点视图：左栏站点列表 + 右栏明细">📁 按站点浏览</button>
        <div class="cal-box" id="calendar">
          <div class="cal-head">
            <button class="cal-nav" data-dir="-1" title="上个月">‹</button>
            <span class="cal-title" id="calTitle"></span>
            <button class="cal-nav" data-dir="1" title="下个月">›</button>
            <button class="cal-nav" id="calToday" title="回到本月">今</button>
          </div>
          <div class="cal-grid" id="calGrid"></div>
        </div>
        <div class="purge-sec">
          <button class="btn" id="purgeToggle" title="按精确时间段（可限定站点）删除历史记录：自定义年月日时，或快捷 1 小时 / 6 小时 / 1 天 / 3 天">自定义时段删除记录</button>
          <div id="purgePanel" hidden>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button class="btn btn-sm" data-purge="1h">近 1 小时</button>
            <button class="btn btn-sm" data-purge="6h">近 6 小时</button>
            <button class="btn btn-sm" data-purge="1d">近 1 天</button>
            <button class="btn btn-sm" data-purge="3d">近 3 天</button>
          </div>
          <label style="font-size:12px; display:flex; flex-direction:column; gap:2px;">开始时间（年月日时）
            <button type="button" class="btn btn-sm" id="purgeStartBtn" style="justify-content:flex-start;">未设置</button>
            <input type="datetime-local" id="purgeStart" hidden>
          </label>
          <label style="font-size:12px; display:flex; flex-direction:column; gap:2px;">结束时间（年月日时）
            <button type="button" class="btn btn-sm" id="purgeEndBtn" style="justify-content:flex-start;">未设置</button>
            <input type="datetime-local" id="purgeEnd" hidden>
          </label>
          <div id="purgeDtPop" hidden>
            <div class="purge-dt-title" id="purgeDtTitle">选择时间</div>
            <div class="purge-dt-row">
              <input type="date" id="purgeDtDate">
              <input type="time" id="purgeDtTime" step="60">
            </div>
            <div class="purge-dt-actions">
              <button class="btn btn-sm primary" id="purgeDtOk">确定</button>
              <button class="btn btn-sm" id="purgeDtCancel">取消</button>
            </div>
          </div>
          <label style="font-size:12px; display:flex; align-items:center; gap:6px;">
            <input type="checkbox" id="purgeSiteOn"> 限定站点（只删该站点的记录）
          </label>
          <div id="purgeSiteBox" hidden style="position:relative;">
            <input type="text" id="purgeSite" placeholder="输入站点名称，从建议中点选" style="width:100%; box-sizing:border-box;">
            <div class="domain-suggest" id="purgeSiteSuggest" hidden></div>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn btn-sm" id="purgeQuery" title="把该时间段（及限定站点）内的记录筛出来，在右侧预览">查询</button>
            <button class="btn btn-sm st-danger" id="purgeDeleteAll" disabled title="删除预览中的全部记录（需确认）">删除全部</button>
            <button class="btn btn-sm" id="purgeExit">退出</button>
          </div>
          <div class="muted" style="font-size:12px;">先点快捷按钮或填自定义时间，点「查询」在右侧预览，确认无误后再删除。</div>
          </div>
        </div>
      </aside>
      <div class="browse-main">
        <div class="result-summary">
          <span id="resultCount"></span>
          <span id="scanNote"></span>
        </div>
        <div id="visitList" class="visit-list"></div>
        <div class="load-more">
          <button class="btn" id="loadMore" style="display:none;" title="每次向前加载 3 天">加载更多（3 天）</button>
          <button class="btn" id="showAll" style="display:none;" title="一次加载当前筛选范围内的全部记录">显示全部</button>
        </div>
      </div>
    </div>
  `);
  built = true;
  ui = {
    quickRanges: container.querySelector('#quickRanges'),
    customDates: container.querySelector('#customDates'),
    dateStart: container.querySelector('#dateStart'),
    dateEnd: container.querySelector('#dateEnd'),
    domainRow: container.querySelector('#domainRow'),
    domainInput: container.querySelector('#domainInput'),
    domainSuggest: container.querySelector('#domainSuggest'),
    domainChips: container.querySelector('#domainChips'),
    textSearch: container.querySelector('#textSearch'),
    goSites: container.querySelector('#goSites'),
    calendar: container.querySelector('#calendar'),
    calTitle: container.querySelector('#calTitle'),
    calGrid: container.querySelector('#calGrid'),
    resultCount: container.querySelector('#resultCount'),
    scanNote: container.querySelector('#scanNote'),
    visitList: container.querySelector('#visitList'),
    loadMore: container.querySelector('#loadMore'),
    showAll: container.querySelector('#showAll'),
    purgeToggle: container.querySelector('#purgeToggle'),
    purgePanel: container.querySelector('#purgePanel'),
    purgeStart: container.querySelector('#purgeStart'),
    purgeEnd: container.querySelector('#purgeEnd'),
    purgeQuery: container.querySelector('#purgeQuery'),
    purgeDeleteAll: container.querySelector('#purgeDeleteAll'),
    purgeExit: container.querySelector('#purgeExit'),
    purgeSiteOn: container.querySelector('#purgeSiteOn'),
    purgeSiteBox: container.querySelector('#purgeSiteBox'),
    purgeSite: container.querySelector('#purgeSite'),
    purgeSiteSuggest: container.querySelector('#purgeSiteSuggest'),
    purgeStartBtn: container.querySelector('#purgeStartBtn'),
    purgeEndBtn: container.querySelector('#purgeEndBtn'),
    purgeDtPop: container.querySelector('#purgeDtPop'),
    purgeDtTitle: container.querySelector('#purgeDtTitle'),
    purgeDtDate: container.querySelector('#purgeDtDate'),
    purgeDtTime: container.querySelector('#purgeDtTime'),
    purgeDtOk: container.querySelector('#purgeDtOk'),
    purgeDtCancel: container.querySelector('#purgeDtCancel'),
  };
}

function renderDomainChips() {
  ui.domainChips.innerHTML = state.domains.map((d) =>
    `<span class="chip">${escapeHtml(stripWww(d))}<button data-domain="${escapeHtml(d)}" title="移除">×</button></span>`
  ).join('');
}

// ---------- 域名输入框：输入实时搜索站点，下拉点选后筛选 ----------

let websiteCache = null;      // listWebsites() 结果缓存（短时效，导入新数据后能自动刷新）
let websiteCacheAt = 0;
let suggestItems = [];        // 当前下拉展示的站点
let suggestIndex = -1;        // 键盘高亮项，-1 表示无

async function ensureWebsites() {
  if (!websiteCache || Date.now() - websiteCacheAt > 30_000) {
    try {
      websiteCache = await listWebsites();
      websiteCacheAt = Date.now();
    } catch {
      if (!websiteCache) websiteCache = [];
    }
  }
  return websiteCache;
}

function hideSuggest() {
  ui.domainSuggest.hidden = true;
  ui.domainSuggest.innerHTML = '';
  suggestItems = [];
  suggestIndex = -1;
}

/** 匹配片段高亮（两边都先做 HTML 转义，保证下标对应）。 */
function highlightMatch(text, kw) {
  const esc = escapeHtml(text);
  const kwe = escapeHtml(kw);
  const idx = kwe ? esc.toLowerCase().indexOf(kwe.toLowerCase()) : -1;
  if (idx < 0) return esc;
  return esc.slice(0, idx) + '<mark>' + esc.slice(idx, idx + kwe.length) + '</mark>' + esc.slice(idx + kwe.length);
}

function renderSuggest(list, kw) {
  suggestItems = list;
  suggestIndex = list.length ? 0 : -1;
  ui.domainSuggest.hidden = false;
  ui.domainSuggest.innerHTML = list.length
    ? list.map((w, i) => `
      <div class="ds-item ${i === suggestIndex ? 'active' : ''}" data-domain="${escapeHtml(w.id)}" title="${escapeHtml(w.id)}">
        <img class="vicon" src="${escapeHtml(faviconUrl('https://' + w.id + '/'))}" alt="" loading="lazy">
        <span class="ds-name">${highlightMatch(w.id, kw)}</span>
        <span class="ds-meta">${(w.visitCount || 0).toLocaleString()} 次</span>
      </div>`).join('')
    : '<div class="ds-empty">没有匹配的站点</div>';
}

function updateSuggestActive() {
  const nodes = ui.domainSuggest.querySelectorAll('.ds-item');
  nodes.forEach((el, i) => el.classList.toggle('active', i === suggestIndex));
  nodes[suggestIndex]?.scrollIntoView({ block: 'nearest' });
}

async function searchSuggest() {
  const kw = ui.domainInput.value.trim().toLowerCase();
  if (!kw) { hideSuggest(); return; }
  const ws = await ensureWebsites();
  // 若期间输入已变化，丢弃这次过期结果
  if (ui.domainInput.value.trim().toLowerCase() !== kw) return;
  const list = ws.filter((w) => w.id.includes(kw))
    .sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0) || (a.id < b.id ? -1 : 1))
    .slice(0, 8);
  renderSuggest(list, kw);
}

function pickDomain(d) {
  hideSuggest();
  ui.domainInput.value = '';
  if (!state.domains.includes(d)) {
    state.domains.push(d);
    renderDomainChips();
    reload();
  }
}

function syncControls() {
  ui.quickRanges.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.range === state.range));
  ui.customDates.style.display = state.range === 'custom' ? 'flex' : 'none';
  ui.dateStart.value = state.customStart;
  ui.dateEnd.value = state.customEnd;
  ui.textSearch.value = state.text;
  renderCalendar();
}

// ---------- 日历：按月显示每天的记录数，点某天直接筛选当天 ----------

const cal = {
  year: new Date().getFullYear(),
  month: new Date().getMonth(),   // 0-11
  counts: new Map(),              // 'YYYY-MM-DD' -> 记录数
  countsKey: '',                  // counts 对应的 月份|域名 缓存键
};

const pad2 = (n) => String(n).padStart(2, '0');
const dateKeyOf = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

function calCountsKey() {
  return `${cal.year}-${cal.month}|${state.domains.join(',')}`;
}

/** 刷新日历：缓存命中直接重绘；否则按当前月份+域名筛选查库统计。 */
async function refreshCalendarCounts() {
  renderCalendar();
  const key = calCountsKey();
  if (cal.countsKey === key) return;
  const start = new Date(cal.year, cal.month, 1).getTime();
  const end = new Date(cal.year, cal.month + 1, 1).getTime();
  try {
    const rows = await countByDay({
      startTime: start,
      endTime: end,
      domains: state.domains.length ? state.domains : null,
    });
    // 查库期间用户可能已切到别的月份或改了域名，过期结果直接丢弃
    if (calCountsKey() !== key) return;
    cal.counts = new Map(rows.map((r) => [r.dateKey, r.count]));
    cal.countsKey = key;
  } catch {
    cal.counts = new Map();
  }
  renderCalendar();
}

function renderCalendar() {
  if (!ui) return;
  const now = new Date();
  const todayKey = dateKeyOf(now.getFullYear(), now.getMonth(), now.getDate());
  const daysInMonth = new Date(cal.year, cal.month + 1, 0).getDate();
  const lead = new Date(cal.year, cal.month, 1).getDay();   // 1 号前的空位（周日=0）
  const countsValid = cal.countsKey === calCountsKey();     // 未加载完的月份不显示圆点
  const selKey = state.range === 'custom' && state.customStart && state.customStart === state.customEnd
    ? state.customStart : null;

  let cells = '';
  for (const wd of ['日', '一', '二', '三', '四', '五', '六']) cells += `<span class="cal-wd">${wd}</span>`;
  for (let i = 0; i < lead; i++) cells += '<span class="cal-day dim"></span>';
  for (let d = 1; d <= daysInMonth; d++) {
    const key = dateKeyOf(cal.year, cal.month, d);
    const count = countsValid ? (cal.counts.get(key) || 0) : 0;
    const cls = ['cal-day'];
    if (key === todayKey) cls.push('today');
    if (key === selKey) cls.push('selected');
    cells += `<button class="${cls.join(' ')}" data-date="${key}" `
      + `title="${count ? `${key}：${count} 条记录` : key}">`
      + `${d}${count ? '<span class="cal-dot"></span>' : ''}</button>`;
  }
  ui.calTitle.textContent = `${cal.year} 年 ${cal.month + 1} 月`;
  ui.calGrid.innerHTML = cells;
}

function visitRowHtml(v) {
  const starred = bookmarkSet.has(v.urlId);
  return `
    <div class="vrow" data-id="${v.id}" data-url="${escapeHtml(v.urlId)}">
      <span class="vtime" title="${formatDateTime(v.visitedAt)}">${formatSmartTime(v.visitedAt)}</span>
      <button class="vstar ${starred ? 'on' : ''}" title="${starred ? '取消收藏' : '收藏该网址'}">★</button>
      <img class="vicon" src="${escapeHtml(faviconUrl(v.urlId))}" alt="" loading="lazy">
      <div class="vmain">
        <a class="vtitle" href="${escapeHtml(v.urlId)}" target="_blank" rel="noopener noreferrer">${escapeHtml(v.title || displayPath(v.urlId))}</a>
        <a class="vurl" href="${escapeHtml(v.urlId)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(v.urlId)}">${escapeHtml(displayPath(v.urlId))}</a>
      </div>
      <button class="vdel" title="删除这条记录">×</button>
      <button class="vsite" title="筛选该网站的所有记录">🌐</button>
    </div>`;
}

function paintList() {
  let html = '';
  let lastDay = null;
  for (const v of items) {
    const dayKey = formatSmartTimeKey(v.visitedAt);
    if (dayKey !== lastDay) {
      html += `<div class="day-sep">${dayKey}</div>`;
      lastDay = dayKey;
    }
    html += visitRowHtml(v);
  }
  ui.visitList.innerHTML = html || '<div class="empty-tip">没有符合条件的记录</div>';
  ui.resultCount.textContent = items.length
    ? `共 ${items.length} 条${hasMore ? '（还有更多）' : ''}`
    : '';
  ui.scanNote.textContent = scanned > 50_000 ? `（已扫描 ${scanned.toLocaleString()} 条，建议缩小范围）` : '';
  ui.loadMore.style.display = hasMore ? '' : 'none';
  ui.showAll.style.display = hasMore ? '' : 'none';
}

function formatSmartTimeKey(ms) {
  const d = new Date(ms);
  const now = new Date();
  const wd = '日一二三四五六'[d.getDay()];
  const md = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return d.getFullYear() === now.getFullYear() ? `${md} 周${wd}` : `${d.getFullYear()} 年 ${md} 周${wd}`;
}

// ---------- 精准删除（按时间段）：快捷/自定义选时段 → 右侧预览 → 确认删除 ----------

const purge = { active: false, items: [], site: null };

function localDtValue(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function setPurgeRange(startMs, endMs) {
  ui.purgeStart.value = localDtValue(startMs);
  ui.purgeEnd.value = localDtValue(endMs);
  refreshPurgeDtBtns();
}

/** 自建时间选择浮窗：原生 datetime-local 的弹层是 Chrome 画的、没有"确定"
 *  按钮，无法定制——改为隐藏 datetime-local 仅作数据存储，可见的是按钮 +
 *  自建浮窗（日期 + 时间 + 确定/取消），确定才写入。 */
let purgeDtTarget = null; // 'start' | 'end'

function refreshPurgeDtBtns() {
  if (ui.purgeStartBtn) ui.purgeStartBtn.textContent = ui.purgeStart.value ? ui.purgeStart.value.replace('T', ' ') : '未设置';
  if (ui.purgeEndBtn) ui.purgeEndBtn.textContent = ui.purgeEnd.value ? ui.purgeEnd.value.replace('T', ' ') : '未设置';
}

function openPurgeDt(which) {
  purgeDtTarget = which;
  const input = which === 'start' ? ui.purgeStart : ui.purgeEnd;
  const btn = which === 'start' ? ui.purgeStartBtn : ui.purgeEndBtn;
  ui.purgeDtTitle.textContent = which === 'start' ? '选择开始时间' : '选择结束时间';
  const v = input.value || '';
  ui.purgeDtDate.value = v ? v.slice(0, 10) : '';
  ui.purgeDtTime.value = v ? v.slice(11, 16) : '00:00';
  // 定位到按钮下方（相对 .purge-sec）
  const sec = btn.closest('.purge-sec');
  const br = btn.getBoundingClientRect();
  const sr = sec.getBoundingClientRect();
  ui.purgeDtPop.style.top = Math.round(br.bottom - sr.top + 4) + 'px';
  ui.purgeDtPop.style.left = Math.max(0, Math.round(br.left - sr.left)) + 'px';
  ui.purgeDtPop.hidden = false;
}

function confirmPurgeDt() {
  if (!purgeDtTarget) return;
  if (!ui.purgeDtDate.value) { toast('请先选择日期', true); return; }
  const input = purgeDtTarget === 'start' ? ui.purgeStart : ui.purgeEnd;
  input.value = `${ui.purgeDtDate.value}T${ui.purgeDtTime.value || '00:00'}`;
  ui.purgeDtPop.hidden = true;
  refreshPurgeDtBtns();
}

async function purgeQuery() {
  const s = ui.purgeStart.value ? new Date(ui.purgeStart.value).getTime() : null;
  const e = ui.purgeEnd.value ? new Date(ui.purgeEnd.value).getTime() : null;
  if (s == null || e == null) { toast('请先填写开始和结束时间（或点快捷按钮）', true); return; }
  if (s >= e) { toast('开始时间必须早于结束时间', true); return; }
  toast('正在查询时间段…');
  const r = await queryVisits({ startTime: s, endTime: e, limit: 100_000 });
  // 限定站点：按 hostname 精确匹配（建议列表与 🌐 站点筛选用同一域名口径）
  if (purge.site) {
    r.items = r.items.filter((v) => {
      try { return new URL(v.urlId).hostname === purge.site; }
      catch { return false; }
    });
  }
  purge.items = r.items;
  paintPurge();
}

function paintPurge() {
  const n = purge.items.length;
  ui.purgeDeleteAll.disabled = n === 0;
  let html = '', lastDay = null;
  for (const v of purge.items) {
    const dayKey = formatSmartTimeKey(v.visitedAt);
    if (dayKey !== lastDay) { html += `<div class="day-sep">${dayKey}</div>`; lastDay = dayKey; }
    html += visitRowHtml(v);
  }
  ui.visitList.innerHTML = html || '<div class="empty-tip">该时间段内没有记录</div>';
  ui.resultCount.textContent = n
    ? `删除预览：共 ${n} 条记录${purge.site ? `（仅 ${purge.site}）` : ''}，请确认后删除`
    : purge.site ? `${purge.site} 在该时间段内没有记录` : '该时间段内没有记录';
  ui.loadMore.style.display = 'none';
  ui.showAll.style.display = 'none';
}

function purgeExit() {
  purge.active = false;
  purge.items = [];
  purge.site = null;
  ui.purgePanel.hidden = true; // 收起面板（此前漏了这行，退出按钮看起来没反应）
  ui.purgeDeleteAll.disabled = true;
  ui.purgeSiteOn.checked = false;
  ui.purgeSiteBox.hidden = true;
  ui.purgeSite.value = '';
  hidePurgeSuggest();
  if (ui.purgeDtPop) ui.purgeDtPop.hidden = true;
  reload();
}

/** 站点限定：建议下拉（复用 websiteCache 与 .ds-item 样式，口径与 🌐 一致）。 */
function hidePurgeSuggest() {
  ui.purgeSiteSuggest.hidden = true;
  ui.purgeSiteSuggest.innerHTML = '';
  purgeSuggestItems = [];
}
let purgeSuggestItems = [];

async function purgeSiteSuggest() {
  const kw = ui.purgeSite.value.trim().toLowerCase();
  if (!kw) { hidePurgeSuggest(); return; }
  const ws = await ensureWebsites();
  if (ui.purgeSite.value.trim().toLowerCase() !== kw) return; // 输入已变化：丢弃过期结果
  const list = ws.filter((w) => w.id.includes(kw))
    .sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0) || (a.id < b.id ? -1 : 1))
    .slice(0, 8);
  purgeSuggestItems = list;
  ui.purgeSiteSuggest.hidden = false;
  ui.purgeSiteSuggest.innerHTML = list.length
    ? list.map((w, i) => `
      <div class="ds-item ${i === 0 ? 'active' : ''}" data-pdomain="${escapeHtml(w.id)}" title="${escapeHtml(w.id)}">
        <img class="vicon" src="${escapeHtml(faviconUrl('https://' + w.id + '/'))}" alt="" loading="lazy">
        <span class="ds-name">${highlightMatch(w.id, kw)}</span>
        <span class="ds-meta">${(w.visitCount || 0).toLocaleString()} 次</span>
      </div>`).join('')
    : '<div class="ds-empty">没有匹配的站点</div>';
}

function pickPurgeSite(d) {
  purge.site = d;
  ui.purgeSite.value = d;
  hidePurgeSuggest();
}

async function purgeDeleteRow(id) {
  const v = purge.items.find((x) => x.id === id);
  if (!(await confirmDialog({
    title: '删除这条历史记录',
    message: `删除「${v ? (v.title || v.urlId) : '该记录'}」？\n删除后无法恢复。`,
    confirmText: '删除', danger: true,
  }))) return;
  await deleteVisit(id);
  purge.items = purge.items.filter((x) => x.id !== id);
  toast('已删除该条记录');
  paintPurge();
}

async function purgeDeleteAll() {
  if (!purge.items.length) return;
  if (!(await confirmDialog({
    title: '删除该时间段的历史记录',
    message: `将删除预览中的 ${purge.items.length} 条历史记录：\n${ui.purgeStart.value || '?'} 至 ${ui.purgeEnd.value || '?'}${purge.site ? `\n仅站点：${purge.site}` : ''}\n\n删除后无法恢复（除非重新导入备份）。`,
    confirmText: '全部删除', danger: true,
  }))) return;
  toast('正在删除…');
  let done = 0;
  for (const v of purge.items) { await deleteVisit(v.id); done++; }
  purge.items = [];
  ui.purgeDeleteAll.disabled = true;
  toast(`已删除 ${done} 条记录`);
  paintPurge();
}

async function refreshBookmarkSet() {
  try {
    bookmarkSet = await getBookmarkedUrlSet();
  } catch {
    bookmarkSet = new Set(); // 无 bookmarks 权限等情况下降级为全部未收藏
  }
}

function resetPaging() {
  items = [];
  chunkEnd = null;
  hasMore = false;
  scanned = 0;
}

async function reload() {
  resetPaging();
  refreshCalendarCounts(); // 域名筛选变化后日历计数随之更新（内部有缓存）
  await loadPage({ reset: true });
}

/**
 * 按 3 天一块向前加载：首块从时间范围上沿（或当前时刻）开始，
 * 之后每点一次"加载更多"就再向前取 3 天，直到到达范围下沿。
 */
async function loadPage({ reset = false, quiet = false } = {}) {
  const [rangeStart, rangeEnd] = rangeToTimes();
  if (reset) chunkEnd = rangeEnd ?? Date.now();
  // 保证窗口始终向前推进，即使该块被筛选后一条不剩
  const end = chunkEnd;
  let start = end - CHUNK_DAYS * DAY;
  if (rangeStart != null) start = Math.max(start, rangeStart);
  ui.loadMore.disabled = true;
  ui.showAll.disabled = true;
  try {
    const r = await queryVisits({
      startTime: start,
      endTime: end,
      domains: state.domains.length ? state.domains : null,
      text: state.text.trim(),
      limit: CHUNK_LIMIT,
    });
    if (reset) items = [];
    items.push(...r.items);
    chunkEnd = start;
    scanned = reset ? r.scanned : scanned + r.scanned;
    // 范围下沿已知（具体时间段）时按边界判断；无下沿时按本块是否有结果判断
    hasMore = rangeStart != null ? chunkEnd > rangeStart : r.items.length > 0;
    await refreshBookmarkSet();
    if (!quiet) paintList(); // quiet：显示全部时批量取数，结束后一次重绘
  } finally {
    ui.loadMore.disabled = false;
    ui.showAll.disabled = false;
  }
}

/** 一次加载完当前筛选范围内的全部记录（按 3 天块连续取数，最后统一渲染）。 */
async function showAll() {
  ui.loadMore.disabled = true;
  ui.showAll.disabled = true;
  ui.showAll.textContent = '加载中…';
  try {
    while (hasMore) {
      await loadPage({ quiet: true });
    }
    paintList();
  } finally {
    ui.loadMore.disabled = false;
    ui.showAll.disabled = false;
    ui.showAll.textContent = '显示全部';
  }
}

export async function render(container, opts = {}) {
  if (!built) {
    buildSkeleton(container);
    bindEvents();
  }
  syncControls();
  renderDomainChips();
  if (opts.q != null && opts.q !== state.text) {
    state.text = opts.q;
    ui.textSearch.value = state.text;
    await reload();
  } else if (items.length === 0 && !hasMore && chunkEnd == null) {
    await reload();
  }
}

function bindEvents() {
  ui.quickRanges.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.range = btn.dataset.range;
    syncControls();
    reload();
  });
  ui.dateStart.addEventListener('change', () => { state.customStart = ui.dateStart.value; reload(); });
  ui.dateEnd.addEventListener('change', () => { state.customEnd = ui.dateEnd.value; reload(); });

  // 精准删除：开面板 / 快捷时段 / 查询 / 删除全部 / 退出
  ui.purgeToggle.addEventListener('click', () => {
    purge.active = !purge.active;
    ui.purgePanel.hidden = !purge.active;
    if (!purge.active && purge.items.length) purgeExit();
  });
  ui.purgePanel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-purge]');
    if (!b) return;
    const hours = { '1h': 1, '6h': 6, '1d': 24, '3d': 72 }[b.dataset.purge];
    const now = Date.now();
    setPurgeRange(now - hours * 3_600_000, now);
  });
  ui.purgeQuery.addEventListener('click', () => purgeQuery().catch((err) => toast('查询失败：' + (err?.message || err), true)));
  ui.purgeDeleteAll.addEventListener('click', () => purgeDeleteAll().catch((err) => toast('删除失败：' + (err?.message || err), true)));
  ui.purgeExit.addEventListener('click', purgeExit);
  // 自建时间浮窗：按钮打开 → 确定/取消
  ui.purgeStartBtn.addEventListener('click', () => openPurgeDt('start'));
  ui.purgeEndBtn.addEventListener('click', () => openPurgeDt('end'));
  ui.purgeDtOk.addEventListener('click', confirmPurgeDt);
  ui.purgeDtCancel.addEventListener('click', () => { ui.purgeDtPop.hidden = true; });
  ui.purgeDtDate.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmPurgeDt(); });
  ui.purgeDtTime.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmPurgeDt(); });
  // 站点限定：勾选显示输入框，输入出建议，点选确认；取消勾选清除限定
  ui.purgeSiteOn.addEventListener('change', () => {
    ui.purgeSiteBox.hidden = !ui.purgeSiteOn.checked;
    if (!ui.purgeSiteOn.checked) {
      purge.site = null;
      ui.purgeSite.value = '';
      hidePurgeSuggest();
    }
  });
  ui.purgeSite.addEventListener('input', debounce(purgeSiteSuggest, 150));
  ui.purgeSiteSuggest.addEventListener('mousedown', (e) => {
    const item = e.target.closest('[data-pdomain]');
    if (item) pickPurgeSite(item.dataset.pdomain);
  });
  ui.purgeSite.addEventListener('blur', () => setTimeout(hidePurgeSuggest, 120));
  ui.purgeSite.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hidePurgeSuggest(); }
    if (e.key === 'Enter' && purgeSuggestItems.length) {
      e.preventDefault();
      pickPurgeSite(purgeSuggestItems[0].id);
    }
  });

  // 日历：翻月 / 回本月 / 点击某天筛选当天记录
  ui.calendar.addEventListener('click', (e) => {
    if (e.target.closest('#calToday')) {
      const now = new Date();
      cal.year = now.getFullYear();
      cal.month = now.getMonth();
      refreshCalendarCounts();
      return;
    }
    const nav = e.target.closest('.cal-nav');
    if (nav) {
      cal.month += Number(nav.dataset.dir);
      if (cal.month < 0) { cal.month = 11; cal.year--; }
      if (cal.month > 11) { cal.month = 0; cal.year++; }
      refreshCalendarCounts();
      return;
    }
    const day = e.target.closest('.cal-day[data-date]');
    if (day) {
      state.range = 'custom';
      state.customStart = day.dataset.date;
      state.customEnd = day.dataset.date;
      syncControls();
      reload();
    }
  });

  const addDomain = () => {
    let d = ui.domainInput.value.trim().toLowerCase();
    if (!d) return;
    d = d.replace(/^https?:\/\//, '').split('/')[0];
    if (d && !state.domains.includes(d)) {
      state.domains.push(d);
      renderDomainChips();
      reload();
    }
    ui.domainInput.value = '';
  };

  // 输入实时搜索站点（下拉点选确认后才筛选）；回车仍可直接添加精确域名
  ui.domainInput.addEventListener('input', debounce(searchSuggest, 150));
  ui.domainInput.addEventListener('keydown', (e) => {
    const open = !ui.domainSuggest.hidden;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (open && suggestItems.length) {
        e.preventDefault();
        const n = suggestItems.length;
        suggestIndex = e.key === 'ArrowDown' ? (suggestIndex + 1) % n : (suggestIndex - 1 + n) % n;
        updateSuggestActive();
      }
      return;
    }
    if (e.key === 'Enter') {
      if (open && suggestIndex >= 0 && suggestItems[suggestIndex]) {
        e.preventDefault();
        pickDomain(suggestItems[suggestIndex].id);
      } else {
        addDomain();
      }
      return;
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      hideSuggest();
    }
  });
  // mousedown 并阻止默认，避免点击建议项时输入框先失焦把下拉关掉
  ui.domainSuggest.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const item = e.target.closest('.ds-item');
    if (item) pickDomain(item.dataset.domain);
  });
  ui.domainInput.addEventListener('blur', () => setTimeout(hideSuggest, 120));
  ui.domainChips.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.domains = state.domains.filter((d) => d !== btn.dataset.domain);
    renderDomainChips();
    reload();
  });

  ui.textSearch.addEventListener('input', debounce(() => {
    state.text = ui.textSearch.value;
    reload();
  }, 400));

  // "按站点浏览"：切到浏览页内的站点模式（左右分栏）
  ui.goSites.addEventListener('click', () => switchTab('sites'));

  ui.loadMore.addEventListener('click', () => loadPage());
  ui.showAll.addEventListener('click', () => showAll());

  // 图标加载失败时隐藏（如该页被 Chrome 回收了 favicon），避免裂图
  ui.visitList.addEventListener('error', (e) => {
    if (e.target.tagName === 'IMG') e.target.style.display = 'none';
  }, true);

  // 行内操作：收藏（浏览器书签）/ 删除 / 域名快速筛选
  ui.visitList.addEventListener('click', async (e) => {
    const star = e.target.closest('.vstar');
    if (star) {
      const row = star.closest('.vrow');
      const url = row.dataset.url;
      const title = row.querySelector('.vtitle')?.textContent || '';
      star.disabled = true;
      try {
        if (star.classList.contains('on')) {
          // 已收藏：点击即移除
          await removeBrowserBookmark(url);
          bookmarkSet = await getBookmarkedUrlSet();
          star.classList.remove('on');
          star.title = '添加到浏览器书签';
          toast('已从浏览器书签移除');
        } else {
          // 未收藏：弹出添加书签对话框（可改名称/选文件夹），确认后才写入
          const dlg = await openBookmarkDialog({ url, title });
          if (dlg.saved) {
            bookmarkSet = await getBookmarkedUrlSet();
            star.classList.add('on');
            star.title = '从浏览器书签移除';
            toast('已加入浏览器书签');
          }
        }
      } catch (err) {
        toast('收藏操作失败：' + (err?.message || err), true);
      } finally {
        star.disabled = false;
      }
      return;
    }
    const del = e.target.closest('.vdel');
    if (del) {
      const row = del.closest('.vrow');
      // 精准删除模式下：单条删除带确认，并从预览列表同步移除
      if (purge.active) { await purgeDeleteRow(Number(row.dataset.id)); return; }
      await deleteVisit(Number(row.dataset.id));
      items = items.filter((v) => v.id !== Number(row.dataset.id));
      paintList();
      toast('已删除该条记录');
      return;
    }
    const vsite = e.target.closest('.vsite');
    if (vsite) {
      // 筛选同网站所有记录：域名与存储的 websiteId 保持一致（hostname 原样）
      const row = vsite.closest('.vrow');
      const host = new URL(row.dataset.url).hostname;
      if (state.domains.includes(host)) {
        toast('该网站已在筛选条件中');
        return;
      }
      state.domains.push(host);
      renderDomainChips();
      reload();
      toast(`已筛选 ${stripWww(host)} 的所有记录`);
      return;
    }
  });
}
