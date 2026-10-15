// 历史记录主界面：页签路由 + 共享工具（toast、状态栏）。
// 每个 view 渲染到各自的 <section>，互不干扰（切换不会破坏其它视图的 DOM）。

import { initSchema, counts, earliestVisitAt, getSetting } from '../lib/db.js';
import { toast } from '../lib/toast.js';

export const els = {
  content: document.getElementById('content'),
  topStatus: document.getElementById('topStatus'),
  toast: document.getElementById('toast'),
};

// toast 实现已抽到 lib/toast.js（轻量页 stash.html 也用它）；这里转发保持旧导入路径兼容
export { toast };

// 全局错误条：任何未捕获的错误/拒绝直接显示在页面上，避免"点了没反应"
function showGlobalError(text) {
  let bar = document.getElementById('globalErrorBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'globalErrorBar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;background:#c0392b;color:#fff;'
      + 'font-size:12px;padding:8px 32px 8px 16px;white-space:pre-wrap;word-break:break-all;';
    const close = document.createElement('button');
    close.textContent = '×';
    close.style.cssText = 'position:absolute;top:4px;right:8px;background:none;border:none;color:#fff;font-size:16px;cursor:pointer;';
    close.onclick = () => bar.remove();
    bar.appendChild(close);
    document.body.appendChild(bar);
  }
  bar.appendChild(document.createTextNode(text + '\n'));
  console.error('[历史记录]', text);
}

// 把底层异常翻译成用户能看懂、知道下一步做什么的提示
function friendlyErrorText(r) {
  const raw = r?.message || String(r);
  if (/not a valid key|DataError/i.test(raw)) {
    return '查询条件无法被数据库执行（筛选值格式不支持）。请调整筛选条件（时间范围/域名/关键词）后重试，或刷新页面。';
  }
  if (/lower key is greater than the upper key/i.test(raw)) {
    return '时间范围无效：开始时间晚于结束时间。请检查自定义日期（已自动做容错，刷新后重试即可）。';
  }
  if (/QuotaExceededError|quota/i.test(raw)) {
    return '本机存储空间不足，写入失败。请清理磁盘空间或删除部分历史数据后重试。';
  }
  if (/VersionError/i.test(raw)) {
    return '数据库版本冲突：可能有其它旧版历史记录页面还开着。请关闭所有历史记录标签页后刷新。';
  }
  if (/InvalidStateError/i.test(raw)) {
    return '数据库连接已失效（可能刚完成升级）。请刷新页面重试。';
  }
  if (/The database connection is closing|NotFoundError/i.test(raw)) {
    return '数据库连接中断。请刷新页面重试；若反复出现，请重启浏览器。';
  }
  return raw;
}

window.addEventListener('error', (e) => showGlobalError('脚本错误：' + (e.message || e.type)));
window.addEventListener('unhandledrejection', (e) => {
  showGlobalError('操作失败：' + friendlyErrorText(e.reason));
});

export async function refreshTopStatus() {
  try {
    const [c, recording, firstAt] = await Promise.all([
      counts(), getSetting('recordEnabled', true), earliestVisitAt(),
    ]);
    // 已保存天数 = 最早一条访问距今天数（不足一天按 1 天计；无记录不显示）
    const days = firstAt ? Math.max(1, Math.ceil((Date.now() - firstAt) / 86_400_000)) : 0;
    const span = days ? ` · 已保存 ${days} 天` : '';
    els.topStatus.textContent = recording
      ? `记录中 · 共 ${c.visits.toLocaleString()} 次访问 / ${c.websites.toLocaleString()} 个网站${span}`
      : `已暂停记录 · 共 ${c.visits.toLocaleString()} 次访问 / ${c.websites.toLocaleString()} 个网站${span}`;
  } catch {
    els.topStatus.textContent = '';
  }
}

// ---------------------------------------------------------------- 页签路由
//
// 顶层页签只有 浏览 / 标签页 / 设置。"站点""书签"是浏览页内的模式（页顶
// "浏览 | 站点 | 书签"段控件切换，选择记入 localStorage），"数据"已并入设置页。
// 浏览页的三个模式各自渲染到独立的宿主容器，互不覆盖。

const viewEls = {};
for (const v of document.querySelectorAll('.view')) viewEls[v.id.slice(5)] = v;
const hostEls = {
  browse: document.getElementById('browseHost'),
  sites: document.getElementById('sitesHost'),
  bookmarks: document.getElementById('bookmarksHost'),
};
const modeSeg = document.getElementById('browseModeSeg');

const renderers = {
  browse: (opts) => import('./views/browse.js').then((m) => m.render(hostEls.browse, opts)),
  sites: (opts) => import('./views/sites.js').then((m) => m.render(hostEls.sites, opts)),
  bookmarks: (opts) => import('./views/bookmarks.js').then((m) => m.render(hostEls.bookmarks, opts)),
  tabs: (opts) => import('./views/tabs.js').then((m) => m.render(viewEls.tabs, opts)),
  stash: (opts) => import('./views/stash.js').then((m) => m.render(viewEls.stash, opts)),
  settings: (opts) => import('./views/settings-view.js').then((m) => m.render(viewEls.settings, opts)),
};

const BROWSE_MODE_KEY = 'whBrowseMode';
const BROWSE_MODES = ['browse', 'sites', 'bookmarks'];
let browseMode = BROWSE_MODES.includes(localStorage.getItem(BROWSE_MODE_KEY))
  ? localStorage.getItem(BROWSE_MODE_KEY) : 'browse';

function renderHostOf(name) {
  return hostEls[name] || viewEls[name];
}

let currentTab = null;
let renderSeq = 0;
const renderedOnce = new Set(); // 渲染过的视图：再切入直接展示缓存，由各视图自己的变更监听保鲜

export async function switchTab(name, opts = {}) {
  if (!renderers[name]) return;
  if (BROWSE_MODES.includes(name)) browseMode = name;
  const top = BROWSE_MODES.includes(name) ? 'browse' : name;
  currentTab = top;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === top));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${top}`));
  modeSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === browseMode));
  for (const [mode, el] of Object.entries(hostEls)) {
    el.classList.toggle('active', mode === browseMode);
  }
  const seq = ++renderSeq;
  const cached = renderedOnce.has(name) && opts.q == null;
  const pending = renderers[name](opts);
  if (cached) {
    // 先展示已渲染内容（上面已切换视图），刷新放到后台，不阻塞切换
    pending.then(
      () => { if (seq === renderSeq) { renderHostOf(name)?.querySelector('.load-error-tip')?.remove(); syncBrowseLayout(); } },
      () => { /* 后台刷新失败：继续展示缓存内容 */ },
    );
    syncBrowseLayout();
    return;
  }
  try {
    await pending;
    renderedOnce.add(name);
    syncBrowseLayout();
    // 渲染成功后清掉上一次失败留下的错误提示(避免错误在容器里越积越多)
    const stale = renderHostOf(name)?.querySelector('.load-error-tip');
    if (stale) stale.remove();
  } catch (e) {
    if (seq === renderSeq) {
      console.error(e);
      const host = renderHostOf(name);
      host?.querySelector('.load-error-tip')?.remove();
      host?.insertAdjacentHTML('beforeend',
        `<div class="empty-tip load-error-tip">页面加载出错：${String(e.message || e)}\n若提示与实际不符，先关闭并重新打开本页（扩展刚重载过时旧页面会继续跑旧代码）。</div>`);
    }
  }
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  // 点"历史记录"页签时回到上次的浏览/站点/书签模式
  if (btn) switchTab(btn.dataset.tab === 'browse' ? browseMode : btn.dataset.tab);
});

modeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  localStorage.setItem(BROWSE_MODE_KEY, btn.dataset.mode);
  switchTab(btn.dataset.mode);
});

/** 吸顶测量（历史与书签页三种模式通用，零死区，收纳页同款）：
 *  模式条/搜索栏/左栏的吸顶位置全部 = 各自自然位置，滚动全程固定区不动。
 *  搜索栏自然位置 = 页头 + 视图残余顶距12px + 模式条高 + 其下间距14px；
 *  左栏吸顶点(--bs-top) = 搜索栏底沿，左栏再 +10px 间距 = 其自然位置。
 *  否则固定区要滑行数十像素才"入座"，看起来像跟着页面滚走。 */
function syncBrowseLayout() {
  const modeBar = document.querySelector('#view-browse .mode-bar');
  const mbH = modeBar ? modeBar.offsetHeight : 0;
  document.documentElement.style.setProperty('--mb-h', mbH + 'px');
  document.querySelectorAll('.filters').forEach((filters) => {
    const host = filters.parentElement;
    const split = host?.querySelector('.browse-split, .site-split');
    if (!split) return;
    let top = 0;
    const topbar = document.querySelector('.topbar');
    if (topbar) top += topbar.offsetHeight;
    const tabs = document.querySelector('.tabs');
    if (tabs) top += tabs.offsetHeight;
    top += 12 + mbH + 14; // 视图残余顶距(16-4) + 模式条高 + 模式条下间距
    top += filters.offsetHeight;
    // --bs-top 写在宿主上：统计行(.result-summary)与分栏左栏都要读它接龙吸顶
    host.style.setProperty('--bs-top', top + 'px');
    // 统计行高（站点/书签页有且吸顶，历史页无）：左栏吸顶点 = 统计行底 + 6px
    const summary = host.querySelector(':scope > .result-summary');
    host.style.setProperty('--sum-h', summary ? summary.offsetHeight + 'px' : '0px');
  });
}

// 启动：UI 先行，数据库初始化放后台（失败显示在全局错误条，不阻塞页面）
(async function boot() {
  // 顶部固定区：topbar 吸顶(top:0)，tabs 吸顶于 topbar 之下（此前 sticky 缺 top 不生效）。
  // 总高度写入 --header-h，供设置页左栏等 sticky 元素计算 top——
  // 否则它们滚到位后会滑到顶栏背后被盖住，看起来像跟着页面滚走了。
  const topbarEl = document.querySelector('.topbar');
  const tabsEl = document.getElementById('tabs');
  const syncHeaderH = () => {
    tabsEl.style.top = topbarEl.offsetHeight + 'px';
    document.documentElement.style.setProperty(
      '--header-h', (topbarEl.offsetHeight + tabsEl.offsetHeight) + 'px');
  };
  syncHeaderH();
  window.addEventListener('resize', () => { syncHeaderH(); syncBrowseLayout(); }, { passive: true });
  // 字体加载完成后页头实际高度会变（启动瞬间字体未就绪，量出的偏小）——
  // 不重算的话 sticky 元素吸顶位置定矮几像素，滚动时会滑到页头背后（"没固定住"）。
  if (document.fonts?.ready) document.fonts.ready.then(() => { syncHeaderH(); syncBrowseLayout(); });
  window.addEventListener('load', () => { syncHeaderH(); syncBrowseLayout(); });
  refreshTopStatus();
  // 顶栏云同步快捷条：与设置页同一后台状态，未配置时自动渲染为空。
  // 动态 import，不进首屏关键路径预热清单。
  import('./views/sync-quick.js')
    .then((m) => m.renderQuickBar(document.getElementById('syncQuick')))
    .catch((e) => console.warn('[历史记录] 云同步快捷条加载失败', e));
  // URL hash 支持：dashboard.html#browse?q=关键词 / #sites
  const [raw, query] = location.hash.replace(/^#/, '').split('?');
  // 旧锚点兼容：#data 已并入设置页
  const initial = raw === 'data' ? 'settings' : raw;
  const tab = renderers[initial] ? initial : 'stash';
  const params = new URLSearchParams(query || '');
  // 建库/开库与首屏渲染并行：首个视图读数据不再排队等 initSchema
  const dbReady = initSchema()
    .then(() => refreshTopStatus())
    .catch((e) => showGlobalError('历史记录数据库初始化失败：' + (e?.message || e)));
  await switchTab(tab, { q: params.get('q') });
  syncBrowseLayout(); // 首个视图渲染完成后测量搜索栏高度
  await dbReady;
})();
