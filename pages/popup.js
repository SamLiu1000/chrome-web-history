// Popup：今日概览 + 快速搜索入口 + 最近访问。

import { initSchema, getSetting, queryVisits } from '../lib/db.js';
import { escapeHtml, formatSmartTime, stripWww } from '../lib/util.js';

function openDashboard(params = '') {
  const url = chrome.runtime.getURL('pages/dashboard.html') + (params ? `#${params}` : '');
  chrome.tabs.create({ url });
  window.close();
}

(async function init() {
  const recState = document.getElementById('recState');
  const stats = document.getElementById('stats');
  const list = document.getElementById('recentList');

  try {
    await initSchema(); // 首次安装时也能直接建立库与内置分类
    await loadRulesCache();
    const [recording, startOfToday] = await Promise.all([
      getSetting('recordEnabled', true),
      (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })(),
    ]);
    recState.textContent = recording ? '记录中' : '已暂停';
    recState.classList.toggle('paused', !recording);

    // 今日访问数与独立域名数
    const today = await queryVisits({ startTime: startOfToday, limit: Infinity, maxScan: 500_000 });
    const domains = new Set(today.items.map((v) => v.websiteId));
    stats.innerHTML = `<span>今日 <b>${today.items.length.toLocaleString()}</b> 次访问</span>
      <span>·</span><span><b>${domains.size}</b> 个域名</span>`;

    // 最近 10 条
    const recent = await queryVisits({ limit: 10 });
    list.innerHTML = recent.items.map((v) => `
      <li>
        <span class="t">${formatSmartTime(v.visitedAt)}</span>
        <a class="ti" href="${escapeHtml(v.urlId)}" title="${escapeHtml(v.title || v.urlId)}"
           target="_blank" rel="noopener noreferrer">${escapeHtml(v.title || stripWww(v.websiteId) || v.urlId)}</a>
      </li>`).join('') || '<li><span class="t muted">暂无记录，去浏览一些网页吧</span></li>';
  } catch (e) {
    stats.textContent = '数据加载失败：' + e.message;
  }
})();

// ---- 事件 ----
document.getElementById('goSearch').addEventListener('click', () => {
  const q = document.getElementById('quickSearch').value.trim();
  openDashboard(q ? `browse?q=${encodeURIComponent(q)}` : 'browse');
});

document.getElementById('quickSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('goSearch').click();
});

document.getElementById('openDash').addEventListener('click', () => openDashboard());
