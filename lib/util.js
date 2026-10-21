// 通用工具函数：域名解析、时间格式化、transition 语义、颜色等。

/** 从 URL 提取域名（hostname，小写）。非法 URL 返回 null。 */
export function extractDomain(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ftp:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 去掉末尾的 "www." 前缀，用于分组展示（不改变存储的 domain 键）。 */
export function stripWww(domain) {
  return domain && domain.startsWith('www.') ? domain.slice(4) : domain;
}

// 常见多段公共后缀（近似 eTLD+1，覆盖绝大多数场景；未列入的按"最后两段"处理）
const MULTI_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'mil.cn',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp',
  'com.au', 'net.au', 'org.au',
  'com.tw', 'org.tw', 'com.hk', 'org.hk', 'com.sg',
  'co.kr', 'com.br', 'co.in', 'com.mx', 'co.nz',
]);

/**
 * 提取主域名（站点主地址）：news.example.com -> example.com；
 * mail.qq.com -> qq.com；example.co.uk -> example.co.uk。
 * IP 与单段主机名原样返回。
 */
export function baseDomain(host) {
  if (!host) return '';
  const h = stripWww(host.toLowerCase());
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h === 'localhost' || !h.includes('.')) return h;
  const parts = h.split('.');
  const last2 = parts.slice(-2).join('.');
  if (MULTI_SUFFIXES.has(parts.slice(-2).join('.')) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return last2;
}

/**
 * URL 的紧凑显示形式：去掉协议与 www 前缀，保留 host + path + search。
 * 如 https://www.example.com/a/b?x=1 -> example.com/a/b?x=1
 */
export function displayPath(url) {
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, '') + u.pathname.replace(/\/$/, '') + u.search;
  } catch {
    return url;
  }
}

/**
 * 网站图标地址（走 Chrome 内置 favicon 缓存，需 manifest 的 "favicon" 权限
 * 及 web_accessible_resources 暴露 _favicon/*）。站点无图标时返回默认地球图标。
 */
export function faviconUrl(url, size = 16) {
  return chrome.runtime.getURL('/_favicon/')
    + `?pageUrl=${encodeURIComponent(url)}&size=${size}`;
}

export function isValidUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
      url.startsWith('about:') || url.startsWith('edge://') || url.startsWith('devtools:')) {
    return false;
  }
  return extractDomain(url) !== null;
}

const pad = (n) => String(n).padStart(2, '0');

/** Date -> "2026-10-07 21:30:05"（本地时间） */
export function formatDateTime(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Date -> "2026-10-07"（本地时间日期键，用于按天分组） */
export function formatDateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 相对或精确时间：今天显示 "14:32:05"，今年显示 "03-05 14:32"，否则完整日期 */
export function formatSmartTime(ms) {
  if (ms == null) return '';
  const now = new Date();
  const d = new Date(ms);
  if (formatDateKey(ms) === formatDateKey(now.getTime())) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return formatDateTime(ms);
}

/** Chrome history transition 枚举 -> 中文标签 */
export const TRANSITION_LABELS = {
  link: '链接点击',
  typed: '地址栏输入',
  auto_bookmark: '书签',
  auto_subframe: '页内框架',
  manual_subframe: '手动框架',
  generated: '搜索建议',
  auto_toplevel: '自动跳转',
  form_submit: '表单提交',
  reload: '刷新',
  keyword: '关键字（如书签关键字）',
  keyword_generated: '关键字搜索结果',
  start_page: '起始页',
  other: '其他',
};

export function transitionLabel(t) {
  return TRANSITION_LABELS[t] || t || '未知';
}

/** 转义 HTML 特殊字符，防止历史标题/URL 注入页面。 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * innerHTML 赋值 + 完整性自检 + 自动重试。
 * 背景：Chromium 在解析较大的模板字符串时存在偶发的字符丢失
 * （属性名如 class/style 被破坏，导致后续 querySelector 返回 null），
 * 间歇性出现。这里在赋值后验证模板里声明的每个 id 都真实存在，
 * 不完整则换一个字符串副本重新解析（最多 attempts 次）。
 *
 * 重试耗尽后**降级为警告而非抛错**：自检是防"丢字符"的保险，不是业务校验；
 * 误报时（历史上 data-id 曾被误判）抛错会让整个视图空白，代价远大于漏检。
 */
export function setInnerHTML(el, html, attempts = 4) {
  // 只提取真正的元素 id:id 属性前必然是空白或模板开头。
  // 不能用 \bid=" —— "data-id=" 里的 id 前是连字符,恰好构成词边界,会被误判成元素 id,
  // 导致渲染自检永远失败(历史教训,勿改回 \b)。
  const ids = [...html.matchAll(/(?:^|[\s])id="([^"]+)"/g)].map((m) => m[1]);
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    el.innerHTML = i === 0 ? html : String(html) + ''; // 重试时用新副本强制重新解析
    let ok = true;
    for (const id of ids) {
      if (!el.querySelector('#' + CSS.escape(id))) { ok = false; break; }
    }
    if (ok) return true;
    lastErr = new Error(`页面渲染不完整（第 ${i + 1} 次尝试，缺失 ${ids.filter((id) => !el.querySelector('#' + CSS.escape(id))).join(', ')}）`);
    console.warn('[历史记录] innerHTML 自检失败，重试中…', lastErr.message);
  }
  console.error('[历史记录] innerHTML 自检未通过（已降级继续，功能可能受影响）:', lastErr?.message);
  return false;
}

/** 防抖 */
export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** CSV 字段转义：包含逗号/引号/换行时加引号 */
export function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return '"' + s.replaceAll('"', '""') + '"';
  return s;
}

/** 触发浏览器下载 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------- 存储持久化

let persistedOnce = false;

/** 申请持久化存储（navigator.storage.persist）。尽力而为、完全静默：
 *  - 本扩展有 unlimitedStorage 权限，官方文档明确其同时豁免配额与驱逐，
 *    数据安全不依赖本函数；真正丢数据的场景是外部清理（清除站点数据/
 *    清理软件），那对 persist 与否一视同仁。
 *  - persist() 授予与否由浏览器启发式决定（Chrome 155 实测：扩展页面缺此
 *    API、SW 里申请被拒），结果无所谓，故不重试、不警告、不进 UI。
 *  返回 true = 已持久化；false = 未持久化。 */
export async function ensureStoragePersisted() {
  if (persistedOnce || typeof navigator === 'undefined' || !navigator.storage) return false;
  persistedOnce = true;
  try {
    if (await navigator.storage.persisted()) return true;
    // 本扩展有 unlimitedStorage 权限（官方文档：同时豁免配额与驱逐），且已有
    // 云同步 + 本地磁盘备份两层保险；persist() 授不授予都不再影响安全性。
    // 部分内核缺失此 API 或拒绝授予（Chrome 155 实测），一律静默，不刷警告。
    if (typeof navigator.storage.persist === 'function') {
      await navigator.storage.persist().catch?.(() => {});
    }
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}

export function timestampForFilename() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
