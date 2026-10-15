// 数据导入导出：Chrome 历史导入、JSON 完整导出/导入、CSV 导出、备份与恢复。
//
// 导入均在扩展页面上下文执行（页面存活才能显示进度条；SW 会休眠，不适合长任务）。
// Chrome 历史导入：search 分页回溯 + getVisits 并发展开，以 "chrome:<visitId>"
// 作为去重锚点，重复导入自动跳过；单批写入失败只跳过该批，不中断整体。

import { extractDomain, isValidUrl, csvEscape, downloadBlob, timestampForFilename, formatDateTime } from './util.js';
import {
  SCHEMA_VERSION, exportAll, batchAddVisits, clearAllData,
} from './db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Chrome 历史导入

/**
 * 从 Chrome 自身历史拉取全部记录并展开为标准化 visit 行。
 * onProgress(phase, done, total)：phase = 'search' | 'expand' | 'write'。
 */
export async function fetchChromeHistoryRows({ startTime = 0, onProgress = null } = {}) {
  // 1) 分页收集全部 url 条目（按最后访问时间倒序，用 endTime 不断向过去翻页）。
  //    不以 batch.length < pageSize 判断到底——Chrome 可能对返回条数有内部上限，
  //    以"本页没有带来新 url"即终止，另以 oldest 推进翻页窗口。
  const itemsByUrl = new Map(); // url -> HistoryItem
  let endTime = Date.now() + 60_000;
  let guard = 0;
  while (guard++ < 2000) {
    const batch = await chrome.history.search({ text: '', startTime, endTime, maxResults: 5000 });
    if (!batch || batch.length === 0) break;
    const prevSize = itemsByUrl.size;
    for (const it of batch) {
      if (it.url && !itemsByUrl.has(it.url)) itemsByUrl.set(it.url, it);
    }
    onProgress?.('search', itemsByUrl.size, null);
    if (itemsByUrl.size === prevSize) break; // 这一页全是已见过的：到底了
    const oldest = batch.reduce((m, it) => Math.min(m, it.lastVisitTime ?? Date.now()), Infinity);
    if (!Number.isFinite(oldest) || oldest <= startTime || oldest >= endTime) break;
    endTime = oldest;
    await sleep(0);
  }

  // 2) 并发展开为每次 visit（每批 16 个 url 同时查询，比串行快一个量级）
  const rows = [];
  const urls = [...itemsByUrl.keys()];
  const CHUNK = 16;
  let done = 0;
  for (let i = 0; i < urls.length; i += CHUNK) {
    const chunk = urls.slice(i, i + CHUNK);
    const results = await Promise.all(chunk.map(async (url) => {
      if (!isValidUrl(url)) return [];
      try {
        return await chrome.history.getVisits({ url });
      } catch {
        return [];
      }
    }));
    results.forEach((visits, idx) => {
      const url = chunk[idx];
      const item = itemsByUrl.get(url);
      for (const v of visits) {
        if (v.visitTime == null || v.visitTime < startTime) continue;
        rows.push({
          urlId: url,
          websiteId: extractDomain(url),
          title: item.title || '',
          visitedAt: v.visitTime,
          transition: v.transition || 'link',
          tabId: null,
          windowId: null,
          source: 'chrome-history',
          sourceVisitId: `chrome:${v.visitId}`,
        });
      }
    });
    done += chunk.length;
    onProgress?.('expand', done, urls.length);
    if (done % 640 === 0) await sleep(0);
  }
  onProgress?.('expand', urls.length, urls.length);
  return rows;
}

/** 导入 Chrome 全部（或某时间之后的）历史记录。mode: 'merge' | 'overwrite'。 */
export async function importChromeHistory({ startTime = 0, mode = 'merge', onProgress = null } = {}) {
  const rows = await fetchChromeHistoryRows({ startTime, onProgress });
  onProgress?.('write', 0, rows.length);
  const result = await batchAddVisits(rows, {
    mode,
    batchSize: 300,
    onProgress: (d, t, extra) => onProgress?.('write', d, t, extra),
  });
  return result;
}

// ---------------------------------------------------------------- JSON 完整导出/导入

/** 全量导出为 JSON 字符串（含设置快照）。 */
export async function buildJSONExport(onProgress = null) {
  const dump = await exportAll({ onProgress });
  return JSON.stringify(dump, null, 1);
}

export function downloadJSON(jsonText) {
  downloadBlob(new Blob([jsonText], { type: 'application/json' }),
    `web-history-backup_${timestampForFilename()}.json`);
}

function normalizeVisitRow(v) {
  if (!v || typeof v !== 'object') return null;
  const url = v.urlId ?? v.url;
  if (!isValidUrl(url)) return null;
  const visitedAt = Number(v.visitedAt ?? v.visitTime);
  if (!Number.isFinite(visitedAt) || visitedAt <= 0) return null;
  const row = {
    urlId: url,
    websiteId: extractDomain(url),
    title: typeof v.title === 'string' ? v.title : '',
    visitedAt,
    transition: typeof v.transition === 'string' ? v.transition : 'link',
    tabId: v.tabId ?? null,
    windowId: v.windowId ?? null,
    source: typeof v.source === 'string' ? v.source : 'import',
  };
  if (v.sourceVisitId != null) row.sourceVisitId = String(v.sourceVisitId);
  return row;
}

/**
 * 解析并导入 JSON 备份。
 * mode:
 *   'merge'     —— 合并：重复 visit 跳过，收藏状态保留本地，本地设置保留
 *   'overwrite' —— 覆盖：先清空浏览记录（visits/urls/websites），再导入全部；设置保留本地
 * 兼容 v1 备份（含 categories 字段）：分类数据自动忽略。
 * 返回 { added, skipped, failed, total, invalid }
 */
export async function importJSON(jsonText, { mode = 'merge', onProgress = null } = {}) {
  let dump;
  try {
    dump = JSON.parse(jsonText);
  } catch (e) {
    throw new Error('不是有效的 JSON 文件：' + e.message);
  }
  if (!dump || dump.app !== 'web-history-archive' || !dump.data) {
    // 防呆：标签收纳的备份（onetap-full-backup / items 数组）不是浏览历史档案，
    // 别让用户拿着收纳备份来导历史、还以为是文件坏了
    const isStashBackup = dump && typeof dump === 'object' && (
      dump.format === 'onetap-full-backup'
      || Array.isArray(dump.items)
      || (dump.data && Array.isArray(dump.data.items))
      || Array.isArray(dump)
    );
    if (isStashBackup) {
      throw new Error('这是「标签收纳」的备份文件，不能导入浏览历史。如要导入标签收纳：请到标签收纳页或「设置 ▸ 数据」的「导入标签收纳 JSON」。');
    }
    throw new Error('文件格式不符：这不是本扩展导出的档案备份');
  }
  const ver = Number(dump.schemaVersion ?? 0);
  if (ver > SCHEMA_VERSION) {
    throw new Error(`备份 schema 版本 (${ver}) 高于当前扩展 (${SCHEMA_VERSION})，请先升级扩展`);
  }
  const data = dump.data;
  const rows = (Array.isArray(data.visits) ? data.visits : [])
    .map(normalizeVisitRow).filter(Boolean);
  const invalid = (Array.isArray(data.visits) ? data.visits.length : 0) - rows.length;

  if (mode === 'overwrite') {
    await clearAllData({ keepSettings: true });
  }
  onProgress?.('write', 0, rows.length);
  const result = await batchAddVisits(rows, {
    mode: 'merge', // overwrite 已清库，此处始终合并写入
    batchSize: 300,
    onProgress: (d, t, extra) => onProgress?.('write', d, t, extra),
  });
  return { ...result, invalid };
}

// ---------------------------------------------------------------- CSV 导出

const CSV_HEADERS = ['访问时间', '标题', 'URL', '域名', '访问方式', '标签页ID', '收藏', '来源'];

/** visit 行数组 -> CSV 字符串（含 BOM，Excel 直接打开不乱码）。starredSet: 收藏 urlId 集合。 */
export function buildCSV(visitsRows, starredSet = new Set()) {
  const lines = [CSV_HEADERS.map(csvEscape).join(',')];
  for (const v of visitsRows) {
    lines.push([
      csvEscape(formatDateTime(v.visitedAt)), // "YYYY-MM-DD HH:mm:ss" 本地时间
      v.title || '',
      v.urlId,
      v.websiteId,
      v.transition || '',
      v.tabId ?? '',
      starredSet.has(v.urlId) ? '是' : '',
      v.source || '',
    ].map(csvEscape).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

export function downloadCSV(csvText) {
  downloadBlob(new Blob([csvText], { type: 'text/csv;charset=utf-8' }),
    `web-history_${timestampForFilename()}.csv`);
}
