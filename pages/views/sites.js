// 站点页：左右分栏布局 —— 左栏站点列表（搜索/排序/日期筛选），右栏选中站点的网址明细。
// 层级：主域（左栏）→ 网址（可收藏、可展开访问时间）→ 单次访问时间列表。

import {
  listWebsites, listUrlsOfWebsite, queryVisits, counts, aggregateVisitsByWebsite,
  deleteWebsiteData,
} from '../../lib/db.js';
import { removeBrowserBookmark, getBookmarkedUrlSet } from '../../lib/bookmarks.js';
import { openBookmarkDialog } from '../../lib/bookmark-dialog.js';
import {
  escapeHtml, stripWww, baseDomain, formatSmartTime, displayPath, setInnerHTML,
  faviconUrl,
} from '../../lib/util.js';
import { confirmDialog } from '../../lib/dialog.js';
import { toast } from '../dashboard.js';

let sortBy = 'count'; // 左栏站点列表排序：'count' | 'recent' | 'name'
let filterText = '';
let dateStart = ''; // 自定义日期（含当天），留空 = 全部历史
let dateEnd = '';
let selectedBase = null; // 右栏当前选中的主域名
let rangedUrls = null; // 日期筛选激活时缓存范围内网址聚合 [{id, websiteId, title, visitCount, lastVisitAt}]
const URL_PAGE = 300; // 网址列表每次加载的条数

function dateRangeTimes() {
  const DAY = 86_400_000;
  let s = dateStart ? new Date(dateStart + 'T00:00:00').getTime() : null;
  let e = dateEnd ? new Date(dateEnd + 'T00:00:00').getTime() + DAY : null; // 含结束日当天
  // 起止颠倒时自动交换，避免非法 IDBKeyRange
  if (s != null && e != null && s > e) [s, e] = [e, s];
  return [s, e];
}

function formatRangeLabel(rs, re) {
  const f = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  if (rs != null && re != null) return `${f(rs)} ~ ${f(re - 1)}`;
  if (rs != null) return `${f(rs)} 之后`;
  return `${f(re - 1)} 之前`;
}

function groupsCount(websites) {
  return new Set(websites.map((w) => baseDomain(w.id))).size;
}

export async function render(container) {
  setInnerHTML(container, `
    <div class="filters">
      <div class="filter-row">
        <div class="search-bar" title="留空日期 = 全部历史">
          <input type="search" id="siteSearch" placeholder="过滤站点…">
          <input type="date" id="siteDateStart" title="起始日期（留空 = 全部历史）">
          <span class="muted">至</span>
          <input type="date" id="siteDateEnd" title="结束日期（留空 = 全部历史）">
          <button class="btn" id="siteDateClear" style="display:none;">清除日期</button>
        </div>
        <span class="muted" style="font-size:12px;">站点排序</span>
        <div class="seg" id="sortSeg">
          <button data-sort="count" title="按累计访问次数">按访问量</button>
          <button data-sort="recent" title="按最近访问时间">按最近</button>
          <button data-sort="name" title="按站点域名 A→Z">按名称</button>
        </div>
      </div>
    </div>
    <div class="result-summary"><span id="siteSummary"></span></div>
    <div class="site-split">
      <div class="site-side" id="siteSide"></div>
      <div class="site-detail" id="siteDetail"><div class="empty-tip">从左侧选择一个站点，查看网址与访问明细</div></div>
    </div>
  `);
  const siteSide = container.querySelector('#siteSide');
  const siteDetail = container.querySelector('#siteDetail');
  const siteSearch = container.querySelector('#siteSearch');
  const sortSeg = container.querySelector('#sortSeg');
  const dateStartEl = container.querySelector('#siteDateStart');
  const dateEndEl = container.querySelector('#siteDateEnd');
  const dateClear = container.querySelector('#siteDateClear');
  const siteSummary = container.querySelector('#siteSummary');
  dateStartEl.value = dateStart;
  dateEndEl.value = dateEnd;
  siteSearch.value = filterText;

  // 左栏图标加载失败时隐藏，避免裂图
  siteSide.addEventListener('error', (e) => {
    if (e.target.tagName === 'IMG') e.target.style.display = 'none';
  }, true);

  let lastWebsites = []; // paint() 最近一次得到的站点聚合（全历史或范围内），右栏取明细用
  let lastGroups = [];   // 主域分组（已过滤），左栏渲染与重排共用

  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  const sortGroups = () => {
    lastGroups.sort((a, b) => {
      if (sortBy === 'count') return b.count - a.count;
      if (sortBy === 'name') return collator.compare(a.base, b.base);
      return b.last - a.last;
    });
  };

  function renderSide() {
    const top = lastGroups.slice(0, 400);
    siteSide.innerHTML = top.map((g) => `
      <div class="site-item ${g.base === selectedBase ? 'on' : ''}" data-base="${escapeHtml(g.base)}" title="${escapeHtml(g.base)}">
        <img class="vicon" src="${escapeHtml(faviconUrl('https://' + g.base + '/'))}" alt="" loading="lazy">
        <span class="si-name">${escapeHtml(g.base)}</span>
        <span class="si-meta">${g.count.toLocaleString()} 次</span>
      </div>`).join('')
      + (lastGroups.length > top.length
        ? `<div class="muted" style="padding:8px 4px;font-size:12px;">共 ${lastGroups.length.toLocaleString()} 个站点，仅显示前 ${top.length} 个，可用上方过滤。</div>`
        : '')
      || '<div class="empty-tip">还没有任何站点记录，去浏览一些网页吧</div>';
  }

  // ---------------------------------------------------------- 右键菜单
  // 左栏站点条目右键：删除该站点（主域下全部子域名的访问档案）。
  // 菜单交互与书签页/意外关闭页同款：点菜单内不关闭、点击外部 / Esc 关闭。

  let ctxMenu = null;
  function closeCtxMenu() {
    if (!ctxMenu) return;
    ctxMenu.remove();
    ctxMenu = null;
    document.removeEventListener('mousedown', closeCtxOnDown, true);
    document.removeEventListener('keydown', closeCtxOnKey, true);
  }
  function closeCtxOnDown(e) {
    // 点在菜单内部不关闭——否则 mousedown 先移除菜单，click 落不到菜单项上
    if (ctxMenu && e.target instanceof Node && ctxMenu.contains(e.target)) return;
    closeCtxMenu();
  }
  function closeCtxOnKey(e) { if (e.key === 'Escape') closeCtxMenu(); }

  /** 删除主域 base 下全部子域名的档案（visits/urls/websites），含收藏状态。 */
  async function deleteSiteData(base) {
    const hosts = (await listWebsites()).map((w) => w.id).filter((h) => baseDomain(h) === base);
    for (const h of hosts) await deleteWebsiteData(h);
    return hosts.length;
  }

  siteSide.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.site-item[data-base]');
    if (!item) return;
    e.preventDefault();
    const base = item.dataset.base;
    closeCtxMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    const del = document.createElement('div');
    del.className = 'ctx-item danger';
    del.textContent = '🗑 删除该站点（含全部子域名）…';
    del.addEventListener('click', async () => {
      closeCtxMenu();
      const ok = await confirmDialog({
        title: '删除站点记录',
        message: `删除「${base}」及其全部子域名的浏览记录？\n\n将删除该站点全部历史访问、网址档案（含在这些网址上的收藏 ★）。不可恢复，建议先在"数据"页导出备份。`,
        confirmText: '删除', danger: true,
      });
      if (!ok) return;
      try {
        const n = await deleteSiteData(base);
        toast(`已删除「${base}」（${n} 个域名）的全部记录`);
        if (selectedBase === base) selectedBase = null;
        await paint();
      } catch (err) {
        toast('删除失败：' + (err?.message || err), true);
      }
    });
    menu.appendChild(del);
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
  });

  async function paint() {
    const [rs, re] = dateRangeTimes();
    const ranged = rs != null || re != null;
    let websites, summary;
    if (ranged) {
      // 日期筛选：从 visits 按范围真实聚合（websites 存储是全历史口径）
      const agg = await aggregateVisitsByWebsite({ startTime: rs, endTime: re });
      websites = agg.sites;
      rangedUrls = agg.urls;
      const totalVisits = agg.sites.reduce((s, w) => s + (w.visitCount || 0), 0);
      summary = `${formatRangeLabel(rs, re)}：${totalVisits.toLocaleString()} 次访问 · ${agg.urls.length.toLocaleString()} 个网址 · ${agg.sites.length.toLocaleString()} 个站点`;
    } else {
      rangedUrls = null;
      websites = await listWebsites();
      const c = await counts();
      summary = `${c.visits.toLocaleString()} 次访问 · ${c.urls.toLocaleString()} 个网址 · ${groupsCount(websites)} 个站点`;
    }
    // 聚合到主域
    const byBase = new Map();
    for (const w of websites) {
      const b = baseDomain(w.id);
      let g = byBase.get(b);
      if (!g) {
        g = { base: b, count: 0, last: 0, hosts: [] };
        byBase.set(b, g);
      }
      g.count += w.visitCount || 0;
      g.last = Math.max(g.last, w.lastVisitAt || 0);
      g.hosts.push(w);
    }
    const kw = filterText.trim().toLowerCase();
    let groups = [...byBase.values()];
    if (kw) groups = groups.filter((g) => g.base.includes(kw) || g.hosts.some((h) => h.id.includes(kw)));

    siteSummary.textContent = summary;
    lastWebsites = websites;
    lastGroups = groups;
    sortGroups();

    // 原选中站点被过滤掉时落到第一个，再渲染左栏
    if (!selectedBase || !lastGroups.some((g) => g.base === selectedBase)) {
      selectedBase = lastGroups[0]?.base ?? null;
    }
    renderSide();
    await paintDetail();
  }

  async function paintDetail() {
    const websites = lastWebsites;
    if (!selectedBase) {
      siteDetail.innerHTML = '<div class="empty-tip">从左侧选择一个站点，查看网址与访问明细</div>';
      return;
    }
    let urlRows;
    if (rangedUrls) {
      // 日期筛选：用范围内聚合结果，按主域过滤
      urlRows = rangedUrls.filter((u) => baseDomain(u.websiteId) === selectedBase);
    } else {
      const hosts = websites
        .filter((w) => baseDomain(w.id) === selectedBase)
        .sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0));
      urlRows = (await Promise.all(hosts.map((h) => listUrlsOfWebsite(h.id)))).flat();
    }
    // 网址明细固定按最近访问排列（排序功能只属于左栏站点列表）
    urlRows.sort((a, b) => (b.lastVisitAt || 0) - (a.lastVisitAt || 0));
    const totalVisits = urlRows.reduce((s, u) => s + (u.visitCount || 0), 0);

    siteDetail.innerHTML = `
      <div class="sd-head">
        <img class="vicon" src="${escapeHtml(faviconUrl('https://' + selectedBase + '/'))}" alt="">
        <span class="sd-name">${escapeHtml(selectedBase)}</span>
        <span class="sd-meta">${totalVisits.toLocaleString()} 次访问 · ${urlRows.length.toLocaleString()} 个网址</span>
      </div>
      <div class="sd-body"><div class="muted" style="padding:8px 4px;">加载中…</div></div>`;

    const body = siteDetail.querySelector('.sd-body');
    if (!urlRows.length) {
      body.innerHTML = '<div class="muted" style="padding:4px 8px;">该站点在当前筛选范围内暂无网址明细。</div>';
      return;
    }
    body.innerHTML = ''; // 清掉"加载中…"占位，后续由分页渲染填充

    let bookmarked = new Set();
    try {
      bookmarked = await getBookmarkedUrlSet();
    } catch { /* 无 bookmarks 权限时全部视为未收藏 */ }

    // 图标加载失败时隐藏，避免裂图
    body.addEventListener('error', (e) => {
      if (e.target.tagName === 'IMG') e.target.style.display = 'none';
    }, true);

    // 点标题 = 打开原网页（阻止 details 展开）；点行内其他区域 = 展开明细
    body.addEventListener('click', (e) => {
      const a = e.target.closest('a.uf-title');
      if (!a) return;
      e.preventDefault();
      window.open(a.href, '_blank', 'noopener');
    });

    const bind = (scope) => {
      for (const d of scope.querySelectorAll('details.url-fold:not([data-bound])')) {
        d.dataset.bound = '1';
        // 星标 = 浏览器书签
        const star = d.querySelector('.vstar');
        if (bookmarked.has(d.dataset.url)) {
          star.classList.add('on');
          star.title = '从浏览器书签中移除';
        }
        star.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          star.disabled = true;
          const url = d.dataset.url;
          try {
            if (star.classList.contains('on')) {
              // 已收藏：点击即移除
              await removeBrowserBookmark(url);
              star.classList.remove('on');
              star.title = '添加到浏览器书签';
              toast('已从浏览器书签移除');
            } else {
              // 未收藏：弹出添加书签对话框（可改名称/选文件夹），确认后才写入
              const dlg = await openBookmarkDialog({ url, title: d.querySelector('.uf-title')?.textContent || '' });
              if (dlg.saved) {
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
        });
        // 展开时加载该网址的访问时间列表
        d.addEventListener('toggle', () => {
          if (d.open && !d.dataset.loaded) {
            d.dataset.loaded = '1';
            paintVisits(d.querySelector('.uf-visits'), d.dataset.url);
          }
        });
      }
    };

    // 分页渲染：每次插入 URL_PAGE 条，"加载更多"只追加，不重绘已展开的条目
    const moreDiv = document.createElement('div');
    moreDiv.className = 'muted';
    moreDiv.style.cssText = 'padding:4px 8px;';
    let shown = 0;
    const updateMore = () => {
      if (shown >= urlRows.length) {
        moreDiv.remove();
        return;
      }
      moreDiv.innerHTML = `
        <button class="btn u-more">加载更多（已显示 ${shown.toLocaleString()} / ${urlRows.length.toLocaleString()}）</button>
        <button class="btn u-all" title="显示该站点全部网址">显示全部</button>`;
      if (!moreDiv.isConnected) body.appendChild(moreDiv);
    };
    const loadMore = (count = URL_PAGE) => {
      const end = Math.min(shown + count, urlRows.length);
      // 用 fragment 插入，不依赖 moreDiv 是否已在 DOM 中（首次调用时尚未挂载）
      const tpl = document.createElement('template');
      tpl.innerHTML = urlRows.slice(shown, end).map((u) => `
      <details class="url-fold" data-url="${escapeHtml(u.id)}">
        <summary>
          <span class="vtime">${formatSmartTime(u.lastVisitAt)}</span>
          <button class="vstar" title="添加到浏览器书签">★</button>
          <img class="vicon" src="${escapeHtml(faviconUrl(u.id))}" alt="" loading="lazy">
          <a class="uf-title" href="${escapeHtml(u.id)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u.title || displayPath(u.id))}</a>
          <span class="uf-meta">${(u.visitCount || 0).toLocaleString()} 次</span>
        </summary>
        <div class="uf-visits"><span class="muted">加载中…</span></div>
      </details>`).join('');
      body.insertBefore(tpl.content, moreDiv.isConnected ? moreDiv : null);
      bind(body);
      shown = end;
      updateMore();
    };
    loadMore();
    moreDiv.addEventListener('click', (e) => {
      if (e.target.closest('.u-more')) loadMore();
      else if (e.target.closest('.u-all')) loadMore(Infinity);
    });
  }

  async function paintVisits(el, url) {
    const r = await queryVisits({ urlId: url, limit: 30 });
    el.innerHTML = r.items.map((v) => `
      <div class="visit-line">
        <span class="vtime">${formatSmartTime(v.visitedAt)}</span>
      </div>`).join('')
      + (r.nextCursor ? '<div class="muted" style="padding:2px 8px;">更早的访问未显示。</div>' : '')
      || '<div class="muted" style="padding:2px 8px;">无明细。</div>';
  }

  // ---- 事件 ----
  siteSide.addEventListener('click', (e) => {
    const item = e.target.closest('.site-item');
    if (!item || item.dataset.base === selectedBase) return;
    selectedBase = item.dataset.base;
    siteSide.querySelectorAll('.site-item').forEach((el) =>
      el.classList.toggle('on', el.dataset.base === selectedBase));
    paintDetail();
  });
  siteSearch.oninput = debounceInput(() => {
    filterText = siteSearch.value;
    paint();
  });
  sortSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    sortBy = btn.dataset.sort;
    sortSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    // 站点排序只作用于左栏列表：内存重排 + 重绘，不重新查库、不刷新右栏
    sortGroups();
    renderSide();
  });
  sortSeg.querySelector(`[data-sort="${sortBy}"]`).classList.add('active');

  // ---- 自定义日期筛选 ----
  const syncDateClear = () => {
    dateClear.style.display = (dateStartEl.value || dateEndEl.value) ? '' : 'none';
  };
  const onDateChange = () => {
    dateStart = dateStartEl.value;
    dateEnd = dateEndEl.value;
    syncDateClear();
    paint();
  };
  dateStartEl.addEventListener('change', onDateChange);
  dateEndEl.addEventListener('change', onDateChange);
  dateClear.addEventListener('click', () => {
    dateStart = dateEnd = '';
    dateStartEl.value = '';
    dateEndEl.value = '';
    syncDateClear();
    paint();
  });

  await paint();
}

function debounceInput(fn) {
  let t = null;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, 250);
  };
}
