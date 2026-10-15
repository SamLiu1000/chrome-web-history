// IndexedDB 封装：数据库结构、记录、查询、统计、导入导出的底层操作。
//
// 数据结构：
//   visits     一次访问：urlId、域名、精确时间、transition(访问行为)、tabId
//   urls       按 URL 聚合：标题、首末访问时间、访问次数、收藏(starred)
//   websites   按域名(host)聚合：访问统计
//   settings   键值配置：schemaVersion、偏好等
//
// 长期保存要点：unlimitedStorage 权限 + 固定 schemaVersion + 导出文件带版本号。
// DB v2：移除分类体系；urls 增加收藏字段与索引。
// DB v3：starred 由布尔改为 1/缺省 —— IndexedDB 索引 key 不支持布尔值，
//        旧数据 starred:true 在 byStarred 索引中不可见，且 getAll(true) 直接报错。
// DB v4：新增 stashItems（标签收纳，OneTab 兼容的树形结构）。
//        记录结构与 OneTab 2.21 的 item store 完全一致，导出 JSON 可直接互相导入。
// DB v5：stashItems 增加 byModifyDate 索引。收纳数据到百万级后，"每次打开全表
//        getAll 比对新旧"不可接受（秒级主线程阻塞 + 上 GB 内存的 Map）；改为按
//        modifyDate 索引范围查询，只取真正变化过的记录。一次性建索引成本在升级
//        时付出（可能需要几秒），之后每次开页都是毫秒级空范围查询。

import { extractDomain, isValidUrl, formatDateKey } from './util.js';

export const DB_NAME = 'web-history-archive';
export const DB_VERSION = 5;
export const SCHEMA_VERSION = 2;

let _dbPromise = null;

export function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    let settled = false;
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // 兜底：数据库被占用或损坏时 open 请求可能永远挂起，超时后明确报错
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      _dbPromise = null;
      reject(new Error('数据库打开超时（可能被其它历史记录页面或后台任务阻塞）。请关闭所有历史记录标签页后重试，或重启浏览器。'));
    }, 10_000);
    req.onblocked = () => {
      console.warn('[历史记录] 数据库版本升级被其它页面阻塞，请关闭旧的历史记录标签页。');
    };
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('visits')) {
        const s = db.createObjectStore('visits', { keyPath: 'id', autoIncrement: true });
        s.createIndex('byTimeId', ['visitedAt', 'id']);               // 时间线主查询（keyset 分页）
        s.createIndex('byWebsiteTimeId', ['websiteId', 'visitedAt', 'id']); // 单域名查询
        s.createIndex('byUrl', 'urlId');                              // 某 URL 的全部访问
        s.createIndex('byUrlTime', ['urlId', 'visitedAt']);           // 自录 visit 去重
        s.createIndex('bySource', 'sourceVisitId');                   // Chrome 导入 visit 去重
      }
      if (!db.objectStoreNames.contains('urls')) {
        const s = db.createObjectStore('urls', { keyPath: 'id' });
        s.createIndex('byWebsite', 'websiteId');
        s.createIndex('byStarred', 'starred');
      } else if (e.oldVersion < 2) {
        const s = req.transaction.objectStore('urls');
        if (!s.indexNames.contains('byStarred')) s.createIndex('byStarred', 'starred');
      }
      if (!db.objectStoreNames.contains('websites')) {
        db.createObjectStore('websites', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      // v4：标签收纳（OneTab 兼容的树形 item 结构）
      if (!db.objectStoreNames.contains('stashItems')) {
        const s = db.createObjectStore('stashItems', { keyPath: 'id' });
        s.createIndex('byType', 'type');
        s.createIndex('byParent', 'parentIds', { multiEntry: true });
      }
      // v5：modifyDate 索引（百万级数据下"开页按需校验"不能全表扫描）
      if (e.oldVersion < 5 && db.objectStoreNames.contains('stashItems')) {
        const s = req.transaction.objectStore('stashItems');
        if (!s.indexNames.contains('byModifyDate')) s.createIndex('byModifyDate', 'modifyDate');
      }
      // v2：移除分类体系
      if (e.oldVersion < 2 && db.objectStoreNames.contains('categories')) {
        db.deleteObjectStore('categories');
      }
      // v3：starred 布尔值改为 1（布尔不能作索引 key）
      if (e.oldVersion < 3 && db.objectStoreNames.contains('urls')) {
        const s = req.transaction.objectStore('urls');
        const rq = s.openCursor();
        rq.onsuccess = () => {
          const c = rq.result;
          if (!c) return;
          const row = c.value;
          if (row.starred === true || row.starred === false) {
            if (row.starred) {
              row.starred = 1;
              c.update(row);
            } else {
              delete row.starred;
              c.update(row);
            }
          }
          c.continue();
        };
      }
    };
    req.onsuccess = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const db = req.result;
      db.onversionchange = () => { db.close(); _dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      _dbPromise = null;
      reject(req.error || new Error('数据库打开失败'));
    };
  });
  return _dbPromise;
}

// ---------------------------------------------------------------- settings

export async function getSetting(key, defaultValue = undefined) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('settings').objectStore('settings').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : defaultValue);
    req.onerror = () => reject(req.error);
  });
}

export async function setSetting(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 初始化：写入默认设置（只在缺失时写，尊重用户修改）。
 * 每次扩展启动（SW 冷启动 / 打开页面）调用，开销可忽略。
 */
export async function initSchema() {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readwrite');
    const store = tx.objectStore('settings');
    const defaults = {
      schemaVersion: SCHEMA_VERSION,
      recordEnabled: true,
    };
    const req = store.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) {
        const { key } = c.value;
        if (key in defaults && defaults[key] !== undefined) delete defaults[key];
        c.continue();
      }
    };
    tx.oncomplete = () => {
      const remaining = Object.keys(defaults);
      if (remaining.length === 0) return resolve();
      const tx2 = db.transaction('settings', 'readwrite');
      const s2 = tx2.objectStore('settings');
      for (const k of remaining) s2.put({ key: k, value: defaults[k] });
      tx2.oncomplete = () => resolve();
      tx2.onerror = () => reject(tx2.error);
    };
    tx.onerror = () => reject(tx.error);
  });
  await ensureStashRoots();
}

/**
 * 确保标签收纳的三个根节点存在（root / quickList / trash）。
 * 结构与 OneTab 完全一致，保证导出 JSON 与 OneTab 互相兼容。
 * 只在缺失时写入，绝不覆盖已有数据。
 */
export async function ensureStashRoots() {
  const db = await openDB();
  if (!db.objectStoreNames.contains('stashItems')) return;
  await new Promise((resolve, reject) => {
    const tx = db.transaction('stashItems', 'readwrite');
    const store = tx.objectStore('stashItems');
    const req = store.get('root');
    req.onsuccess = () => {
      if (req.result) return; // 已初始化
      const now = Date.now();
      for (const id of ['root', 'quickList', 'trash']) {
        store.put({
          id,
          type: 'group',
          groupType: id === 'quickList' ? 'quickList' : 'folder',
          parentIds: [],
          childIds: [],
          pinnedCount: 0,
          createDate: now,
          modifyDate: now,
        });
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function asPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------- websites / urls

export async function getWebsite(domain) {
  const db = await openDB();
  return asPromise(db.transaction('websites').objectStore('websites').get(domain));
}

export async function listWebsites() {
  const db = await openDB();
  return asPromise(db.transaction('websites').objectStore('websites').getAll());
}

/** 某域名(host)下的全部网址（站点页展开用）。 */
export async function listUrlsOfWebsite(host) {
  const db = await openDB();
  return asPromise(db.transaction('urls').objectStore('urls').index('byWebsite').getAll(host));
}

export async function getUrl(urlId) {
  const db = await openDB();
  return asPromise(db.transaction('urls').objectStore('urls').get(urlId));
}

/** 批量读取 url 行（浏览页渲染收藏状态用）。 */
export async function getUrls(urlIds) {
  const db = await openDB();
  const out = new Map();
  if (!urlIds.length) return out;
  await new Promise((resolve, reject) => {
    const tx = db.transaction('urls');
    const store = tx.objectStore('urls');
    for (const id of urlIds) {
      const req = store.get(id);
      req.onsuccess = () => { if (req.result) out.set(id, req.result); };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return out;
}

/** 切换网址收藏状态。 */
export async function toggleUrlStar(urlId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('urls', 'readwrite');
    const store = tx.objectStore('urls');
    const req = store.get(urlId);
    req.onsuccess = () => {
      const row = req.result;
      if (!row) return resolve({ starred: false, found: false });
      const starred = !row.starred;
      if (starred) {
        row.starred = 1; // 索引 key 必须是数字，不能用布尔
        row.starredAt = Date.now();
      } else {
        delete row.starred;
        delete row.starredAt;
      }
      store.put(row);
      resolve({ starred, found: true });
    };
    tx.oncomplete = () => {};
    tx.onerror = () => reject(tx.error);
  });
}

/** 全部收藏网址的 id 集合（"只看收藏"筛选用）。 */
export async function listStarredUrlIds() {
  const db = await openDB();
  // starred 存的是 1（布尔不能作 IDB key）
  const rows = await asPromise(db.transaction('urls').objectStore('urls').index('byStarred').getAll(1));
  return new Set(rows.map((r) => r.id));
}

// ---------------------------------------------------------------- 记录 visit

/**
 * 在给定事务内记录一次访问（供单条记录与批量导入共用）。
 * 返回 Promise<{added:boolean, id?:number, reason?:string}>。
 * 事务内只 await IDB 请求（微任务链保持事务活跃，不可夹杂外部异步）。
 */
async function recordVisitInTx(tx, v) {
  const visits = tx.objectStore('visits');
  const urls = tx.objectStore('urls');
  const websites = tx.objectStore('websites');

  const urlId = v.urlId;
  const domain = v.websiteId || extractDomain(urlId);
  if (!domain) return { added: false, reason: 'invalid-url' };
  // visitedAt 非法（导入数据缺时间戳等）会让索引 key 变成 [urlId, undefined] 直接抛 DataError
  if (!Number.isFinite(v.visitedAt)) return { added: false, reason: 'invalid-visit' };

  // 1. 去重
  if (v.sourceVisitId != null) {
    const dup = await asPromise(visits.index('bySource').get(v.sourceVisitId));
    if (dup && dup.urlId === urlId && Math.abs((dup.visitedAt || 0) - v.visitedAt) <= 1000) {
      // 同源 visitId + 同 URL + 时间一致（1 秒容差）才判定重复；
      // 不同浏览器 profile 的 visitId 可能撞号，时间不同则照常插入
      return { added: false, reason: 'duplicate' };
    }
  } else {
    const dups = await asPromise(visits.index('byUrlTime').getAll([urlId, v.visitedAt]));
    if (dups && dups.some((d) => d.tabId === (v.tabId ?? null) && (d.transition || '') === (v.transition || ''))) {
      return { added: false, reason: 'duplicate' };
    }
  }

  // 2. website
  const ws = await asPromise(websites.get(domain));
  if (ws) {
    websites.put({
      ...ws,
      lastVisitAt: Math.max(ws.lastVisitAt || 0, v.visitedAt),
      visitCount: (ws.visitCount || 0) + 1,
    });
  } else {
    websites.put({
      id: domain,
      firstSeenAt: v.visitedAt,
      lastVisitAt: v.visitedAt,
      visitCount: 1,
    });
  }

  // 3. url（保留收藏状态）
  const ur = await asPromise(urls.get(urlId));
  if (ur) {
    urls.put({
      ...ur,
      title: v.title || ur.title,
      lastVisitAt: Math.max(ur.lastVisitAt || 0, v.visitedAt),
      visitCount: (ur.visitCount || 0) + 1,
    });
  } else {
    urls.put({
      id: urlId,
      websiteId: domain,
      title: v.title || '',
      firstVisitAt: v.visitedAt,
      lastVisitAt: v.visitedAt,
      visitCount: 1,
    });
  }

  // 4. visit
  const row = {
    urlId,
    websiteId: domain,
    title: v.title || '',
    visitedAt: v.visitedAt,
    transition: v.transition || 'link',
    tabId: v.tabId ?? null,
    windowId: v.windowId ?? null,
    source: v.source || 'extension',
  };
  if (v.sourceVisitId != null) row.sourceVisitId = v.sourceVisitId;
  const addReq = visits.add(row);
  await asPromise(addReq);
  return { added: true, id: addReq.result };
}

/** 记录一次访问（扩展后台实时记录入口）。 */
export async function addVisit(visit) {
  if (!isValidUrl(visit.urlId)) return { added: false, reason: 'invalid-url' };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['visits', 'urls', 'websites'], 'readwrite');
    let result = { added: false, reason: 'unknown' };
    recordVisitInTx(tx, visit).then((r) => { result = r; }).catch(() => { /* tx.onerror 兜底 */ });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => resolve({ added: false, reason: 'tx-error' });
  });
}

/**
 * 批量导入。rows: 标准化 visit 数组。
 * mode: 'merge'（去重合并）| 'overwrite'（先清空 visits/urls/websites 再写入）。
 * 单批失败只跳过该批（计入 failed），不中断整体导入。
 * onProgress(done, total, {added, skipped, failed})
 */
export async function batchAddVisits(rows, { mode = 'merge', batchSize = 400, onProgress = null } = {}) {
  const db = await openDB();
  if (mode === 'overwrite') {
    await clearAllData({ keepSettings: true });
  }
  let added = 0, skipped = 0, failed = 0;
  const total = rows.length;
  for (let i = 0; i < total; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['visits', 'urls', 'websites'], 'readwrite');
        (async () => {
          for (const row of batch) {
            const r = await recordVisitInTx(tx, row);
            if (r.added) added++; else skipped++;
          }
        })().catch(reject);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('transaction error'));
      });
    } catch (e) {
      failed += batch.length;
      console.warn('[历史记录] 导入批次失败，已跳过：', e);
    }
    if (onProgress) onProgress(Math.min(i + batchSize, total), total, { added, skipped, failed });
    // 让出主线程，保持页面响应
    await new Promise((r) => setTimeout(r, 0));
  }
  return { added, skipped, failed, total };
}

// ---------------------------------------------------------------- 查询

function normalizeDomains(domains) {
  if (!domains) return null;
  const arr = Array.isArray(domains) ? domains : [...domains];
  return arr.length ? new Set(arr) : null;
}

/**
 * 核心查询。options:
 *   startTime/endTime  时间范围 [start, end)（毫秒，可 null）
 *   domains            域名数组/Set（可 null）
 *   starredOnly        true 时只返回已收藏网址的访问
 *   text               标题/URL 包含匹配（不区分大小写）
 *   urlId              精确 URL（不支持 keyset 分页）
 *   limit              返回条数上限（默认 300）
 *   cursor             上一页返回的 nextCursor { t, id }（keyset 分页）
 *   maxScan            游标扫描上限（防全库 LIKE 扫描过慢）
 * 返回 { items, nextCursor, scanned, truncated }
 * items 按 visitedAt 降序。
 */
export async function queryVisits(options = {}) {
  const {
    startTime = null, endTime = null,
    domains = null, starredOnly = false, text = '', urlId = null,
    limit = 300, cursor = null, maxScan = 400_000,
  } = options;

  const db = await openDB();
  // 起止颠倒（自定义日期填反等）会让 IDBKeyRange.bound 抛 DataError，直接按空结果处理
  if (startTime != null && endTime != null && startTime >= endTime) {
    return { items: [], nextCursor: null, scanned: 0, truncated: false };
  }
  let domainSet = normalizeDomains(domains);
  let starSet = null;
  if (starredOnly) {
    starSet = await listStarredUrlIds();
    if (starSet.size === 0) return { items: [], nextCursor: null, scanned: 0, truncated: false };
  }

  const needle = text ? text.toLowerCase() : '';
  // 单域名 + 无其它过滤：走 [domain, visitedAt, id] 复合索引（高效路径）
  const singleDomain = domainSet && domainSet.size === 1 && !needle && !urlId && !starredOnly
    ? [...domainSet][0] : null;

  const items = [];
  let scanned = 0;
  let nextCursor = null;

  await new Promise((resolve, reject) => {
    const visits = db.transaction('visits').objectStore('visits');
    let store, range;

    if (urlId) {
      store = visits.index('byUrl');
      range = IDBKeyRange.only(urlId);
    } else if (singleDomain) {
      store = visits.index('byWebsiteTimeId');
      const d = singleDomain;
      let upper = endTime != null ? [d, endTime] : [d, Infinity];
      if (cursor) upper = [d, cursor.t, cursor.id];
      const lower = startTime != null ? [d, startTime, -Infinity] : undefined;
      range = lower
        ? IDBKeyRange.bound(lower, upper, false, true)
        : IDBKeyRange.upperBound(upper, true);
    } else {
      store = visits.index('byTimeId');
      let upper = endTime != null ? [endTime, Infinity] : [Infinity, Infinity];
      if (cursor) upper = [cursor.t, cursor.id];
      const lower = startTime != null ? [startTime, -Infinity] : undefined;
      range = lower
        ? IDBKeyRange.bound(lower, upper, false, true)
        : IDBKeyRange.upperBound(upper, true);
    }

    const req = store.openCursor(range, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      const v = c.value;
      scanned++;
      let ok = true;
      if (domainSet && !singleDomain && !domainSet.has(v.websiteId)) ok = false;
      if (ok && starSet && !starSet.has(v.urlId)) ok = false;
      if (ok && needle) {
        const hay = (v.title || '') + '\n' + v.urlId;
        if (!hay.toLowerCase().includes(needle)) ok = false;
      }
      if (ok) items.push(v);
      if (items.length >= limit) {
        const last = items[items.length - 1];
        nextCursor = { t: last.visitedAt, id: last.id };
        resolve();
        return;
      }
      if (scanned >= maxScan) {
        resolve();
        return;
      }
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });

  return { items, nextCursor, scanned, truncated: !!nextCursor };
}

/** 按天聚合访问数（populat 今日统计等）。返回 [{ dateKey, count }]，日期升序。 */
export async function countByDay({ startTime = null, endTime = null, domains = null, maxScan = 2_000_000 } = {}) {
  const db = await openDB();
  if (startTime != null && endTime != null && startTime >= endTime) return [];
  const domainSet = normalizeDomains(domains);
  const map = new Map();
  await new Promise((resolve, reject) => {
    const visits = db.transaction('visits').objectStore('visits');
    let store, range;
    if (domainSet && domainSet.size === 1) {
      const d = [...domainSet][0];
      store = visits.index('byWebsiteTimeId');
      range = startTime != null && endTime != null
        ? IDBKeyRange.bound([d, startTime], [d, endTime], false, true)
        : startTime != null ? IDBKeyRange.lowerBound([d, startTime])
        : endTime != null ? IDBKeyRange.upperBound([d, endTime], true)
        : IDBKeyRange.bound([d, -Infinity], [d, Infinity]);
    } else {
      store = visits.index('byTimeId');
      const lower = startTime != null ? [startTime, -Infinity] : undefined;
      const upper = endTime != null ? [endTime, Infinity] : undefined;
      range = lower && upper ? IDBKeyRange.bound(lower, upper, false, true)
        : lower ? IDBKeyRange.lowerBound(lower)
        : upper ? IDBKeyRange.upperBound(upper, true)
        : null;
    }
    let scanned = 0;
    const req = store.openCursor(range, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      const v = c.value;
      if (!domainSet || domainSet.has(v.websiteId)) {
        const key = formatDateKey(v.visitedAt);
        map.set(key, (map.get(key) || 0) + 1);
      }
      if (++scanned >= maxScan) return resolve();
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return [...map.entries()]
    .map(([dateKey, count]) => ({ dateKey, count }))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

/**
 * 按时间范围聚合：单次游标扫描同时产出站点与网址两级统计。
 * 返回 { sites: [{id, visitCount, lastVisitAt, firstVisitAt}],
 *        urls:  [{id, websiteId, title, visitCount, lastVisitAt}] }。
 * 站点页自定义日期查询用（websites/urls 存的是全历史聚合，无法按时间切片）。
 */
export async function aggregateVisitsByWebsite({ startTime = null, endTime = null, maxScan = 2_000_000 } = {}) {
  if (startTime != null && endTime != null && startTime >= endTime) return { sites: [], urls: [] };
  const db = await openDB();
  const sites = new Map();
  const urls = new Map();
  await new Promise((resolve, reject) => {
    const store = db.transaction('visits').objectStore('visits').index('byTimeId');
    const lower = startTime != null ? [startTime, -Infinity] : undefined;
    const upper = endTime != null ? [endTime, Infinity] : undefined;
    const range = lower && upper ? IDBKeyRange.bound(lower, upper, false, true)
      : lower ? IDBKeyRange.lowerBound(lower)
      : upper ? IDBKeyRange.upperBound(upper, true)
      : null;
    let scanned = 0;
    const req = store.openCursor(range, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      const v = c.value;
      const w = sites.get(v.websiteId);
      if (w) {
        w.visitCount++;
        if (v.visitedAt > w.lastVisitAt) w.lastVisitAt = v.visitedAt;
      } else {
        sites.set(v.websiteId, { id: v.websiteId, visitCount: 1, lastVisitAt: v.visitedAt, firstVisitAt: v.visitedAt });
      }
      const u = urls.get(v.urlId);
      if (u) {
        u.visitCount++;
        if (v.visitedAt > u.lastVisitAt) u.lastVisitAt = v.visitedAt;
        if (!u.title && v.title) u.title = v.title;
      } else {
        urls.set(v.urlId, { id: v.urlId, websiteId: v.websiteId, title: v.title || '', visitCount: 1, lastVisitAt: v.visitedAt });
      }
      if (++scanned >= maxScan) return resolve();
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return { sites: [...sites.values()], urls: [...urls.values()] };
}

// ---------------------------------------------------------------- 删除与统计

export async function counts() {
  const db = await openDB();
  const names = ['visits', 'urls', 'websites'];
  const out = {};
  await Promise.all(names.map((n) => asPromise(db.transaction(n).objectStore(n).count()).then((c) => { out[n] = c; })));
  return out;
}

/** 最早一条访问的时间（毫秒）；无记录返回 null。走 byTimeId 索引第一条，O(1)。 */
export async function earliestVisitAt() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('visits').objectStore('visits')
      .index('byTimeId').openCursor(null, 'next');
    req.onsuccess = () => {
      const c = req.result;
      resolve(c ? c.key[0] : null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteVisit(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('visits', 'readwrite');
    tx.objectStore('visits').delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 回填标题：visit 行仅在标题为空时补写（保留导航时刻的准确性），
 * url 行始终更新为最新标题。后台 onUpdated(title) 时调用。
 */
export async function applyObservedTitle(urlId, visitRowId, title) {
  if (!title) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['visits', 'urls'], 'readwrite');
    if (visitRowId != null) {
      const req = tx.objectStore('visits').get(visitRowId);
      req.onsuccess = () => {
        const row = req.result;
        if (row && !row.title) {
          row.title = title;
          tx.objectStore('visits').put(row);
        }
      };
    }
    const ureq = tx.objectStore('urls').get(urlId);
    ureq.onsuccess = () => {
      const row = ureq.result;
      if (row && row.title !== title) {
        row.title = title;
        tx.objectStore('urls').put(row);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 删除某域名的全部档案（websites + urls + visits）。 */
export async function deleteWebsiteData(domain) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['visits', 'urls', 'websites'], 'readwrite');
    const visits = tx.objectStore('visits');
    const urls = tx.objectStore('urls');
    tx.objectStore('websites').delete(domain);
    const vq = visits.index('byWebsiteTimeId').openCursor(IDBKeyRange.bound([domain, -Infinity], [domain, Infinity]));
    vq.onsuccess = () => { const c = vq.result; if (c) { c.delete(); c.continue(); } };
    const uq = urls.index('byWebsite').openCursor(domain);
    uq.onsuccess = () => { const c = uq.result; if (c) { c.delete(); c.continue(); } };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 清空数据。keepSettings=true 时保留设置（导入覆盖模式用）；
 * false 时连设置一并重置（危险操作：彻底重置）。
 */
export async function clearAllData({ keepSettings = true } = {}) {
  const db = await openDB();
  const stores = keepSettings ? ['visits', 'urls', 'websites'] : ['visits', 'urls', 'websites', 'settings'];
  await new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    for (const s of stores) tx.objectStore(s).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  if (!keepSettings) await initSchema();
}

// ---------------------------------------------------------------- 导出

/** 全量导出为结构化对象（游标分批收集，避免超大库一次性 getAll 撑爆内存）。 */
export async function exportAll({ onProgress = null } = {}) {
  const db = await openDB();
  const collect = (storeName) => new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction(storeName).objectStore(storeName).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) {
        out.push(c.value);
        if (onProgress && out.length % 5000 === 0) onProgress(storeName, out.length);
        c.continue();
      } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
  const [visits, urls, websites, settings] = await Promise.all([
    collect('visits'), collect('urls'), collect('websites'), collect('settings'),
  ]);
  return {
    app: 'web-history-archive',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    counts: { visits: visits.length, urls: urls.length, websites: websites.length },
    data: { visits, urls, websites, settings },
  };
}
