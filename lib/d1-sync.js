// D1 云同步模块 — 从 onetap_2.21 的 d1-sync.js 移植并适配 web-history。
//
// 与 onetap 版保持兼容的部分（可共用同一个已部署的 Cloudflare Worker 与 D1 库）：
//   - 加密方案：PBKDF2(salt "onetap-d1-sync-v1", 250000, SHA-256) -> AES-GCM(256)
//   - Worker API：/push、/pull、/health、/devices/*；Bearer token 认证
//   - 快照 items 的记录结构与合并算法（按 id + modifyDate LWW，tombstone 防删除复活）
// 适配与增强的部分：
//   - 数据源从 onetab 库的 item store 改为本库的 stashItems（标签收纳）
//   - 同步只由设置页手动按钮触发（历史版本曾有写库自动触发，已移除）
//   - 快照额外携带 bookmarks（Chrome 书签整树快照 + version）。
//     书签采用整树 LWW：远端 version（树内最大 dateGroupModified）比本地新时整树替换。
//   - 快照额外携带 crashGroups（意外关闭存档组）：上传=整包携带；「同步到本地/
//     恢复到本机」=整包覆盖本机；「合并」语义路径按组 id 取并集。
//
// 云端只见密文（deviceName 除外），口令不经过服务器。

const ITEM_STORE = 'stashItems';
import { readCrashGroups, writeCrashGroups } from './tab-guard.js';
import { recordBookmarkTimeOverrides, applyBookmarkTimeOverrides } from './bookmarks.js';
const CS_KEYS = {
  config: 'd1SyncConfig',
  state: 'd1SyncState',
};
export const TOMBSTONES_KEY = 'd1SyncTombstones';

// ---------------- chrome.storage.local 小封装 ----------------

function csGet(key, def) {
  return new Promise((res) => {
    chrome.storage.local.get([key], (o) => res(o[key] !== undefined ? o[key] : def));
  });
}
function csSet(key, val) {
  return new Promise((res) => chrome.storage.local.set({ [key]: val }, res));
}

// ---------------- IndexedDB 工具 ----------------

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('web-history-archive');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
    req.onblocked = () => rej(new Error('db blocked'));
  });
}

function storeHas(db, name) {
  return Array.from(db.objectStoreNames).includes(name);
}

function readAll(db, store) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}

function writeItem(db, records, deletes) {
  return new Promise((res, rej) => {
    const tx = db.transaction(ITEM_STORE, 'readwrite');
    const st = tx.objectStore(ITEM_STORE);
    for (const r of records) st.put(r);
    for (const id of deletes) st.delete(id);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('tx aborted'));
  });
}

// ---------------- 同步触发 ----------------

let syncing = false;

// ---------------- 自动上传（变更触发，仅 push） ----------------

export const AUTO_PUSH_ALARM = 'd1SyncAutoPush';

/** stash 每次写库都会调用（页面上下文经 d1SyncChanged 消息，SW 上下文直接调）。
 *  防抖：重置同名 alarm（静止 1 分钟后只传一次），把连续收纳/拖拽/备注编辑
 *  合并成一次上传。只上传（pushOnly），绝不下载——自动路径永远不会覆盖本机。
 *  未配置同步或用户在设置页关闭「自动同步到云」时不登记。 */
export function noteChange() {
  Promise.resolve().then(async () => {
    try {
      const c = await loadConfig();
      if (!c || c.autoPush === false) return;
      chrome.alarms.create(AUTO_PUSH_ALARM, { delayInMinutes: 1 });
    } catch { /* 环境无 alarms API 时静默 */ }
  });
}

// 必须在模块加载（SW 顶层同步执行）时注册：SW 被alarm 唤醒后事件分发不会等
// 异步 init 走完，迟注册会错过本次事件。页面上下文注册同样无害。
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_PUSH_ALARM) return;
  runSync('auto-push', { pushOnly: true, pushMode: 'overwrite', auto: true })
    .then((r) => {
      if (r && r.ok) console.info('[d1-sync] 自动上传完成:', resolveDeviceName(cfg || {}));
      else if (r && r.error !== 'name-exists') console.warn('[d1-sync] 自动上传未执行:', r);
    })
    .catch((e) => console.warn('[d1-sync] 自动上传失败', e));
});

// ---------------- 加密（与 onetap 版参数一致） ----------------

const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(passphrase) {
  // salt 与 onetap 版一致：同一 Worker / 同一口令下，两端快照可互相解密
  const salt = enc.encode('onetap-d1-sync-v1');
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function gzip(data) {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function gunzip(data) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function encryptJSON(obj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const json = enc.encode(JSON.stringify(obj));
  const gz = await gzip(json);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, gz);
  return { iv: bytesToB64(iv), data: bytesToB64(ct) };
}

async function decryptJSON(blob, key) {
  const iv = b64ToBytes(blob.iv);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64ToBytes(blob.data));
  const json = await gunzip(pt);
  return JSON.parse(dec.decode(json));
}

// ---------------- Worker API ----------------

async function apiFetch(cfg, path, opts = {}) {
  const url = cfg.workerUrl.replace(/\/+$/, '') + path;
  const headers = Object.assign({ Authorization: 'Bearer ' + cfg.token }, opts.headers || {});
  const res = await fetch(url, Object.assign({}, opts, { headers }));
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch (e) {}
    throw new Error('HTTP ' + res.status + ' ' + detail);
  }
  return res.json();
}

// ---------------- 书签整树快照 ----------------

/** 计算书签树版本：树内最大 dateGroupModified（毫秒）。 */
function treeVersion(nodes) {
  let v = 0;
  const walk = (list) => {
    for (const n of list || []) {
      if (n.dateGroupModified > v) v = n.dateGroupModified;
      if (n.dateAdded > v) v = n.dateAdded;
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return v;
}

/** 只保留可重建的字段（id 由 Chrome 重建时重新分配）。 */
function slimBookmarks(nodes) {
  return (nodes || []).map((n) => {
    const out = { title: n.title || '' };
    if (n.url) out.url = n.url;
    if (n.dateAdded) out.dateAdded = n.dateAdded;
    if (n.children) out.children = slimBookmarks(n.children);
    return out;
  });
}

async function buildBookmarksSnapshot() {
  const tree = await chrome.bookmarks.getTree();
  // 应用"原始添加时间映射"：Chrome 恢复重建后节点时间被重置为当下，
  // 快照里要用映射回的原始时间——否则恢复过的设备会一直显得"最新"，
  // 合并语义（LWW）的方向从此失真。
  const rootChildren = await applyBookmarkTimeOverrides(tree[0]?.children || []);
  return { version: treeVersion(rootChildren), tree: slimBookmarks(rootChildren) };
}

/** 用远端整树替换本地书签。关键约束（历次踩坑）：
 *  1) "书签栏/其他书签"等顶层是 Chrome 常驻根，removeTree 删不掉；
 *  2) 隐藏根(id '0')下禁止直接 create；
 *  3) bookmarks.create 只接受 index/parentId/title/url —— 传 dateAdded
 *     直接抛 "Unexpected property"（曾导致整个替换必然失败）。
 *     Chrome 也不提供改 dateAdded 的 API，重建后的添加时间只能是当下。
 *  正确做法：按标题把云端顶层节点对到本机常驻根（对不上按序号兜底），
 *  只清空常驻根的子节点再在其下重建。
 *  返回统计 {removed, failed, created, lastError}：删除单节点失败只计数
 *  （Chrome 对个别节点可能拒绝，继续重建其余）；create 失败直接抛出，
 *  让调用方/用户看到硬错误而不是"书签纹丝不动还以为成功了"。 */
export async function replaceLocalBookmarks(tree) {
  const stat = { removed: 0, failed: 0, created: 0, lastError: null };
  const root = (await chrome.bookmarks.getTree())[0];
  const locals = root.children || [];
  const createAll = async (parentId, nodes) => {
    for (const n of nodes || []) {
      const created = await chrome.bookmarks.create({
        parentId,
        title: n.title || '',
        ...(n.url ? { url: n.url } : {}),
      });
      stat.created++;
      if (n.children) await createAll(created.id, n.children);
    }
  };
  for (let i = 0; i < (tree || []).length; i++) {
    const remote = tree[i];
    let dst = locals.find((n) => n.title === remote.title);
    if (!dst) dst = locals[i];
    if (!dst) continue;
    for (const child of dst.children || []) {
      try {
        if (child.url) await chrome.bookmarks.remove(child.id);
        else await chrome.bookmarks.removeTree(child.id);
        stat.removed++;
      } catch (e) {
        stat.failed++;
        stat.lastError = String((e && e.message) || e);
        console.warn('[d1-sync] 删除本地书签节点失败', child.title, e);
      }
    }
    await createAll(dst.id, remote.children);
  }
  // 重建成功：把云端树里的原始添加时间记入映射，供本扩展内部
  // （快照构建/版本比较/HTML 导出）使用；Chrome 面板显示时间无法还原。
  await recordBookmarkTimeOverrides(tree);
  return stat;
}

// ---------------- 快照构建 / 合并 ----------------

function loadTombstones() {
  return csGet(TOMBSTONES_KEY, {});
}

async function saveTombstones(t) {
  // 最多保留 5000 条，防止无限膨胀。
  const entries = Object.entries(t).sort((a, b) => b[1] - a[1]).slice(0, 5000);
  await csSet(TOMBSTONES_KEY, Object.fromEntries(entries));
}

/** 云端归属名（v3：快照按设备名存储，同名覆盖、不同名新增）。
 *  未填设备名时回退 device-xxxxxx，保证非空——Worker 会拒空名。 */
function resolveDeviceName(c) {
  return (c.deviceName || '').trim() || 'device-' + String(c.deviceId || 'x').slice(0, 6);
}

function buildSnapshot(items, tombstones, deviceName, bookmarks, crashGroups) {
  return {
    app: 'web-history-archive',
    v: 1,
    deviceId: cfg.deviceId,
    deviceName,
    exportedAt: Date.now(),
    items,
    tombstones,
    bookmarks,
    // 意外关闭存档组（chrome.storage.local 的 whCrashGroups，数据量小整包携带）
    crashGroups: crashGroups || [],
  };
}

/** 意外关闭存档组合并：按组 id 取并集（组冻结后不可变，只增删）。
 *  用于"合并"语义的路径（同名冲突选合并、合并快照）。 */
function unionCrashGroups(local, remote) {
  const map = new Map();
  for (const g of (local || [])) if (g && g.id != null) map.set(g.id, g);
  for (const g of (remote || [])) if (g && g.id != null && !map.has(g.id)) map.set(g.id, g);
  return [...map.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
}

// 将远端快照合并进本地 items（LWW by modifyDate，处理 tombstone 与父子挂接）。
// localById 会被原地修改，返回 { changedRecords, changedDeletes } 供写回。
function mergeSnapshot(snapshot, localById, tombstones, out) {
  for (const remote of snapshot.items || []) {
    if (!remote || remote.id === undefined) continue;
    const local = localById[remote.id];
    const tomb = tombstones[remote.id] || 0;
    if (!local) {
      if (tomb >= (remote.modifyDate || 0)) continue; // 本地已删除且晚于远端修改
      localById[remote.id] = remote;
      out.changedRecords.push(remote);
      continue;
    }
    const rM = remote.modifyDate || 0;
    const lM = local.modifyDate || 0;
    if (rM > lM) {
      localById[remote.id] = remote;
      out.changedRecords.push(remote);
    }
  }
  // 远端 tombstone：本地仍存在且远端删除时间较新 -> 本地也删。
  for (const [id, ts] of Object.entries(snapshot.tombstones || {})) {
    if (ts > (tombstones[id] || 0)) tombstones[id] = ts;
    const local = localById[id];
    if (local && ts >= (local.modifyDate || 0) && !out.changedDeletes.includes(id)) {
      out.changedDeletes.push(id);
      delete localById[id];
    }
  }
}

// 把孤儿（新合并进来但父分组不在本地 childIds 里的）挂到父分组。
function attachOrphans(localById, out) {
  for (const item of Object.values(localById)) {
    if (item.type !== 'tab') continue;
    const parents = Array.isArray(item.parentIds) ? item.parentIds : [];
    for (const pid of parents) {
      const parent = localById[pid];
      if (parent && parent.type === 'group') {
        if (!Array.isArray(parent.childIds)) parent.childIds = [];
        if (!parent.childIds.includes(item.id)) {
          parent.childIds.push(item.id);
          if (!out.changedRecords.some((r) => r.id === pid)) {
            out.changedRecords.push(parent);
          }
        }
      }
    }
  }
}

// ---------------- Worker API 版本识别 + v4 冲突协议 ----------------

const WORKER_API_VERSION = 4;

/** Worker 是旧版（v2/v3：不返回 api 或 api<4）时抛出。
 *  旧 Worker 缺 409 冲突协议与"按名硬删除"语义——"删除快照没反应 / 删掉又重现"
 *  绝大多数真实原因就是 Worker 没跟着升级。必须显性报错并给出部署指引，
 *  不能静默出错让用户以为数据丢了。 */
class WorkerOutdatedError extends Error {
  constructor() {
    super('Worker 是旧版（未返回 api v4），云同步的删除/上传会失效。请按 worker/README.md 的 v4 说明重新执行 schema.sql 并 wrangler deploy，然后重试。');
    this.name = 'WorkerOutdatedError';
  }
}

/** 校验响应的 api 版本；旧版抛 WorkerOutdatedError。 */
function checkWorkerApi(res) {
  if (!res || typeof res.api !== 'number' || res.api < WORKER_API_VERSION) {
    throw new WorkerOutdatedError();
  }
  return res;
}

/** 推送快照。mode='overwrite' 时允许替换已存在的同名快照。
 *  返回 {ok:true} 或 {conflict:true, updatedAt}（409：云端已有同名快照）。 */
async function pushSnapshot(cfg, cryptoKey, deviceName, snapshot, mode) {
  const encrypted = await encryptJSON(snapshot, cryptoKey);
  const res = await fetch(cfg.workerUrl.replace(/\/+$/, '') + '/push', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(mode
      ? { deviceName, blob: encrypted, mode }
      : { deviceName, blob: encrypted }),
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    if (body && body.error === 'name-exists') {
      return { conflict: true, updatedAt: body.updatedAt || 0 };
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let body = null;
    try { body = JSON.parse(text); } catch (e) {}
    // 错误响应也带 api（v4）；缺失说明是旧 Worker，给部署指引而不是裸 HTTP 码
    if (!body || typeof body.api !== 'number' || body.api < WORKER_API_VERSION) {
      throw new WorkerOutdatedError();
    }
    throw new Error('HTTP ' + res.status + ' ' + String(text).slice(0, 200));
  }
  return checkWorkerApi(await res.json().catch(() => ({})));
}

/** 拉取指定设备名的云端快照并解密（"合并"解法用）；不存在返回 null。 */
async function pullSnapshotByName(cfg, cryptoKey, deviceName) {
  const res = await apiFetch(cfg, '/pull?name=' + encodeURIComponent(deviceName));
  checkWorkerApi(res);
  const entry = (res.snapshots || []).find((s) => s.deviceName === deviceName);
  if (!entry || !entry.blob) return null;
  return decryptJSON(entry.blob, cryptoKey);
}

// ---------------- 本地删除记忆（v4：删除即最终删除，但不被自动同步传回） ----------------

const DELETED_NAMES_KEY = 'd1SyncDeletedNames';

function loadDeletedNames() {
  return csGet(DELETED_NAMES_KEY, {});
}
async function markCloudNameDeleted(name) {
  const m = await loadDeletedNames();
  m[name] = Date.now();
  await csSet(DELETED_NAMES_KEY, m);
}
async function clearCloudNameDeleted(name) {
  const m = await loadDeletedNames();
  if (m[name]) {
    delete m[name];
    await csSet(DELETED_NAMES_KEY, m);
  }
}

/** 把一份远端快照合并进本机（LWW + tombstone），返回合并的记录数。 */
async function mergeRemoteSnapshot(db, snap, tombstones) {
  const localItems = await readAll(db, ITEM_STORE);
  const localById = Object.create(null);
  for (const it of localItems) localById[it.id] = it;
  const out = { changedRecords: [], changedDeletes: [] };
  mergeSnapshot(snap, localById, tombstones, out);
  let applied = 0;
  if (out.changedRecords.length || out.changedDeletes.length) {
    attachOrphans(localById, out);
    const finalRecords = out.changedRecords.filter((r) => localById[r.id] !== undefined);
    const finalDeletes = out.changedDeletes.filter((id) => localById[id] === undefined);
    await writeItem(db, finalRecords, finalDeletes);
    applied = finalRecords.length + finalDeletes.length;
  }
  await saveTombstones(tombstones);
  return applied;
}

/** "合并"解法的完整动作：拉云端同名快照 → 合并进本机（含书签整树 LWW）。 */
async function mergeCloudSnapshotIntoLocal(cfg, cryptoKey, deviceName) {
  const snap = await pullSnapshotByName(cfg, cryptoKey, deviceName);
  if (!snap) return 0;
  const db = await openDB();
  try {
    if (!storeHas(db, ITEM_STORE)) return 0;
    const tombstones = await loadTombstones();
    let applied = await mergeRemoteSnapshot(db, snap, tombstones);
    try {
      // 版本比较基于"原始时间映射"后的树：云端快照的时间口径与本机一致
      const localBmVersion = treeVersion(await applyBookmarkTimeOverrides(
        (await chrome.bookmarks.getTree())[0]?.children || []));
      if (snap.bookmarks && snap.bookmarks.version > localBmVersion
          && snap.bookmarks.tree && snap.bookmarks.tree.length) {
        await replaceLocalBookmarks(snap.bookmarks.tree);
        applied++;
      }
    } catch (e) { /* 无书签权限时跳过 */ }
    // 意外关闭存档组：合并语义，按组 id 取并集（组冻结后不可变，无 LWW 冲突）
    try {
      if (Array.isArray(snap.crashGroups) && snap.crashGroups.length) {
        const local = await readCrashGroups();
        const merged = unionCrashGroups(local, snap.crashGroups);
        if (merged.length !== local.length) {
          await writeCrashGroups(merged);
          applied++;
        }
      }
    } catch (e) { /* 存档组合并失败不影响标签收纳合并 */ }
    return applied;
  } finally {
    db.close();
  }
}

// ---------------- 同步主流程 ----------------

/** 「同步到本地」（v5 覆盖语义）：拉取云端全部快照，解密后取"最新"的一份
 *  （按 Worker 记录的 updatedAt），整包替换本机标签收纳数据。
 *  复用 importAll：替换 stashItems、清空 tombstones、暂停自动同步——
 *  用户核对无误后手动「同步到云」才恢复推送。
 *  书签走整树 LWW：仅云端版本比本地新时替换（书签误覆盖不可逆，保守处理）。 */
async function runPullOverwrite() {
  if (syncing) return { ok: false, error: '正在同步中，请稍后再试' };
  const c = await loadConfig();
  if (!c) return { ok: false, error: '尚未配置同步' };
  syncing = true;
  try {
    cfg = c;
    cryptoKey = await deriveKey(c.passphrase);
    const remote = checkWorkerApi(await apiFetch(c, '/pull'));
    const entries = (remote.snapshots || []).filter((s) => s && s.blob);
    let best = null;
    let bestTs = 0;
    let decryptFailed = 0;
    const failedNames = [];
    for (const entry of entries) {
      try {
        const snap = await decryptJSON(entry.blob, cryptoKey);
        const ts = entry.updatedAt || snap.exportedAt || 0;
        if (ts > bestTs) { bestTs = ts; best = { snap, deviceName: entry.deviceName }; }
      } catch (e) {
        decryptFailed++;
        failedNames.push(entry.deviceName || '?');
        console.warn('[d1-sync] decrypt failed for device', entry.deviceName, e.message);
      }
    }
    if (!best) {
      return {
        ok: false,
        error: entries.length
          ? `云端有 ${entries.length} 份快照但全部解密失败（口令与上传设备不一致？）`
          : '云端没有任何快照（先在任一设备点「同步到云」上传）',
        decryptFailed,
        failedNames,
      };
    }
    // 整包覆盖本机（含书签以外的全部标签收纳数据）
    const r = await importAll(best.snap.items);
    // 意外关闭存档组：同样走整包覆盖语义（同步到本地 = 云端为真，与本机标签收纳一致；
    // 本机删过的组在下一次「同步到云」上传后即从云端消失，不会复活）
    try {
      const remoteCrash = Array.isArray(best.snap.crashGroups) ? best.snap.crashGroups : [];
      await writeCrashGroups(remoteCrash);
    } catch (e) {
      console.warn('[d1-sync] 覆盖意外关闭存档组失败（不影响标签收纳覆盖）', e);
    }
    // 书签整树：与标签收纳同语义——「同步本地」= 云端为真，无条件整树替换。
    // 旧版有"云端版本更新才替换"的版本闸门，但删除书签同样会顶新本机版本，
    // 导致"本机删了想恢复云端"永远拉不回来（用户的实际场景）；且本入口的
    // 弹窗已明确警告整包覆盖。合并语义的路径（mergeCloudSnapshotIntoLocal）
    // 仍保留版本闸门，两处语义不同。
    let bookmarksApplied = false;
    let bookmarkSkip = null;
    try {
      const bm = best.snap.bookmarks;
      if (!bm || !bm.tree || !bm.tree.length) {
        bookmarkSkip = '云端快照未含书签（旧版扩展上传的快照没有该字段，先重新「同步到云」一次）';
      } else {
        const stat = await replaceLocalBookmarks(bm.tree);
        bookmarksApplied = true;
        if (stat.failed) {
          bookmarkSkip = `重建完成（新建 ${stat.created}、删除 ${stat.removed}），但 ${stat.failed} 个旧节点删除失败：${stat.lastError || '?'}`;
        }
      }
    } catch (e) {
      bookmarkSkip = '整树替换执行失败：' + String((e && e.message) || e);
    }
    await setState({
      lastSync: Date.now(),
      lastPull: Date.now(),
      lastError: null,
      lastTrigger: 'manual-pull',
      applied: r.count ?? 0,
    });
    notifyPages();
    return {
      ok: true,
      restored: true,
      count: r.count ?? best.snap.items.length,
      deviceName: best.deviceName,
      updatedAt: bestTs,
      bookmarksApplied,
      bookmarkSkip,
      decryptFailed,
      failedNames,
    };
  } catch (e) {
    await setState({ lastError: String(e && e.message ? e.message : e), lastTrigger: 'manual-pull' });
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    syncing = false;
  }
}

let cfg = null;
let cryptoKey = null;

async function loadConfig() {
  const c = await csGet(CS_KEYS.config, null);
  if (!c || !c.workerUrl || !c.token || !c.passphrase || !c.deviceId) return null;
  return c;
}

function getState() {
  return csGet(CS_KEYS.state, { lastSync: 0, lastPush: 0, lastPull: 0, lastError: null, lastSyncDirection: null });
}
function setState(patch) {
  return getState().then((s) => csSet(CS_KEYS.state, Object.assign({}, s, patch)));
}

export async function runSync(trigger, opts = {}) {
  if (syncing) return { skipped: true, reason: 'sync-in-progress' };
  const manual = trigger === 'manual' || trigger === 'manual-push' || trigger === 'manual-pull';
  const current = await loadConfig();
  if (!current) return { skipped: true, reason: 'no-config' };
  syncing = true;
  try {
    cfg = current;
    cryptoKey = await deriveKey(cfg.passphrase);
    // 上行策略：只有「同步到云」（pushOnly）会上传。
    const upload = opts.pushOnly === true;

    const db = await openDB();
    if (!storeHas(db, ITEM_STORE)) {
      db.close();
      return { skipped: true, reason: 'db-not-ready' };
    }

    // 1. 导出本地（标签收纳 + 书签整树 + 意外关闭存档组）
    const localItems = await readAll(db, ITEM_STORE);
    const tombstones = await loadTombstones();
    const localCrashGroups = await readCrashGroups();
    let bookmarks = null;
    try {
      bookmarks = await buildBookmarksSnapshot();
    } catch (e) {
      console.warn('[d1-sync] 读取书签失败，本次快照不含书签', e);
    }

    // 2. push 本地快照（仅「同步到云」手动触发）
    let pushOk = false;   // 本次是否真的推了快照（lastPush 只随真实上传推进）
    if (upload) {
      const deviceName = resolveDeviceName(cfg);
      // 自动上传尊重"已删除设备名"名单：用户在云端删过本机快照后，
      // 自动路径不得把它传回去（手动「同步到云」是显式操作，仍允许重传）。
      if (opts.auto) {
        const deleted = await loadDeletedNames();
        if (deleted[deviceName]) {
          db.close();
          return { skipped: true, reason: 'device-name-deleted' };
        }
      }
      const snapshot = buildSnapshot(localItems, tombstones, deviceName, bookmarks, localCrashGroups);
      const r = await pushSnapshot(cfg, cryptoKey, deviceName, snapshot, opts.pushMode);
      if (r.conflict) {
        // 手动同步遇同名快照，不静默覆盖——记下待处理冲突，
        // 返回 name-exists 让设置页弹「覆盖 / 合并 / 取消」。
        // 自动上传理论上不会走到（pushMode=overwrite），兜底只记错误不弹窗。
        db.close();
        if (opts.auto) {
          await setState({ lastError: '自动上传遇同名冲突，已跳过（请在设置页手动同步）', lastTrigger: trigger });
          return { ok: false, error: 'name-exists', deviceName };
        }
        await setState({
          pendingConflict: {
            deviceName,
            updatedAt: r.updatedAt,
            trigger,
            opts: {
              pushOnly: !!opts.pushOnly,
            },
          },
        });
        return {
          ok: false,
          error: 'name-exists',
          conflict: { deviceName, updatedAt: r.updatedAt },
          deviceName,
        };
      }
      pushOk = true;
      // 手动推送成功 = 用户显式重新上传，清除该设备名的"已删除"记忆
      await clearCloudNameDeleted(deviceName);
      // v4.1 改名清理：本机上次是用旧设备名上传的，这次换了名——默认把云端旧名
      // 那一行删掉，保证"云端快照名 = 当前填写的设备名"。开启 keepOldSnapshots
      // 后不清理：改名上传会在云端累积多个快照（可当历史版本用），旧快照可在
      // 设置页"云端快照"里手动删除。只删本机自己上传过的旧名（lastPushName 记在
      // 本地状态里），不碰其它设备的行；删除失败不影响本次同步结果（旧名行留着
      // 最多是列表多一行，下次上传会再尝试清理）。
      if (pushOk) {
        const oldName = (await getState()).lastPushName;
        if (oldName && oldName !== deviceName && cfg.keepOldSnapshots !== true) {
          try {
            await apiFetch(cfg, '/devices/' + encodeURIComponent(oldName), { method: 'DELETE' });
            await clearCloudNameDeleted(oldName);
          } catch (e) {
            console.warn('[d1-sync] 清理旧设备名云端快照失败（不影响本次同步）:', e && e.message);
          }
        }
        await setState({ lastPushName: deviceName });
      }
    }

    // 3. pull 其他设备快照并合并（仅上传模式跳过）
    if (opts.pushOnly) {
      db.close();
      await setState({
        lastSync: Date.now(),
        lastPush: Date.now(),
        lastError: null,
        lastTrigger: trigger || null,
      });
      notifyPages();
      // 书签回执：本次上传快照是否携带书签树 + 节点数（书签读取失败时为 null，
      // 设置页据此提示"本次快照不含书签"而不是让用户猜）
      let bmCount = null;
      try {
        const countNodes = (list) => (list || []).reduce((n, x) => n + 1 + countNodes(x.children), 0);
        bmCount = bookmarks ? countNodes(bookmarks.tree) : null;
      } catch { /* 保持 null */ }
      return { ok: true, applied: 0, pushedOnly: true, pulled: 0, decryptFailed: 0, deviceName: resolveDeviceName(cfg), bookmarkNodes: bmCount };
    }
    // 不传 exclude：拉取云端全部设备快照。
    // 为什么不能按本机名排除：同名设备在云端共享同一条快照（同名覆盖），
    // 按本机名排除会把"其它同名设备刚覆盖写入"的那份也排掉——同步到本地
    // 就永远拉不到任何数据（曾表现为"同步到本地是废的"）。
    // 拉回自己旧快照也无害：LWW 按 modifyDate 判新，本地删除有 tombstone
    // 保护（tomb >= 远端 modifyDate 时跳过），不会被旧快照复活。
    const remote = checkWorkerApi(await apiFetch(cfg, '/pull'));
    const pulled = (remote.snapshots || []).length;
    const localById = Object.create(null);
    for (const it of localItems) localById[it.id] = it;

    const out = { changedRecords: [], changedDeletes: [] };
    let remoteCount = 0;
    let decryptFailed = 0;
    const failedNames = [];
    let bookmarksApplied = false;
    // 本地书签版本（用于整树 LWW）
    let localBmVersion = 0;
    try {
      // 版本比较基于"原始时间映射"后的树（与快照构建同口径）
      localBmVersion = treeVersion(await applyBookmarkTimeOverrides(
        (await chrome.bookmarks.getTree())[0]?.children || []));
    } catch (e) { /* 无书签权限时跳过书签同步 */ }

    for (const entry of remote.snapshots || []) {
      try {
        const snap = await decryptJSON(entry.blob, cryptoKey);
        remoteCount++;
        mergeSnapshot(snap, localById, tombstones, out);
        // 书签整树 LWW：远端 version 更新且确实有内容时才替换
        if (snap.bookmarks && snap.bookmarks.version > localBmVersion
            && snap.bookmarks.tree && snap.bookmarks.tree.length) {
          await replaceLocalBookmarks(snap.bookmarks.tree);
          bookmarksApplied = true;
          localBmVersion = snap.bookmarks.version;
        }
      } catch (e) {
        // 解密失败通常意味着口令不一致，跳过该设备——但必须计数并上报，
        // 否则"同步到本地完成"背后其实一个设备都没合并上（曾表现为"废的"）。
        decryptFailed++;
        failedNames.push(entry.deviceName || '?');
        console.warn('[d1-sync] decrypt failed for device', entry.deviceName, e.message);
      }
    }

    let applied = 0;
    if (out.changedRecords.length || out.changedDeletes.length) {
      attachOrphans(localById, out);
      const finalRecords = out.changedRecords.filter((r) => localById[r.id] !== undefined);
      const finalDeletes = out.changedDeletes.filter((id) => localById[id] === undefined);
      await writeItem(db, finalRecords, finalDeletes);
      applied = finalRecords.length + finalDeletes.length;
    }
    await saveTombstones(tombstones);

    db.close();

    const prev = await getState();
    await setState({
      lastSync: Date.now(),
      lastPull: Date.now(),
      // 走到这里说明 pull 已执行；pushOk=true 时上传也必然成功（失败会走 catch）。
      // 分别记录上传/下载时间：云端快照时间只随真实上传变化，与下载在显示上彻底解耦。
      lastPush: pushOk ? Date.now() : (prev.lastPush || 0),
      // 仅下载的成功不清 lastError：之前的上传失败（如 blob too large）不该被
      // 一次自动拉取的成功掩盖成"一切正常"；只有真正覆盖上传方向的成功
      // （或显式仅拉取）才清掉。
      lastError: (pushOk || opts.pullOnly) ? null : (prev.lastError || null),
      lastTrigger: trigger || null,
      remoteDevices: remoteCount,
      applied: applied + (bookmarksApplied ? 1 : 0),
      // 诊断：上次 pull 拉到几个快照 / 几个解密失败（设置页状态行与 toast 用）
      lastPullPulled: pulled,
      lastPullDecryptFailed: decryptFailed,
    });
    if (applied > 0 || bookmarksApplied) notifyPages();
    return {
      ok: true, applied, bookmarksApplied, pulled, decryptFailed,
      failedNames, deviceName: resolveDeviceName(cfg),
      // 云端存在与当前设备名不同的快照行（改过名还没上传过）——设置页据此
      // 解释"快照名字和我填的设备名不一样"，并提示上传后会自动更新
      nameMismatch: pulled > 0 && (remote.snapshots || [])
        .some((s) => s.deviceName && s.deviceName !== resolveDeviceName(cfg)),
    };
  } catch (e) {
    console.error('[d1-sync] sync failed:', e);
    await setState({ lastError: String(e && e.message ? e.message : e), lastTrigger: trigger || null });
    return { ok: false, error: String(e) };
  } finally {
    syncing = false;
  }
}

// 合并写回后通知前端重绘（web-history 的 stash 页直接重读 IndexedDB，无需重载扩展）
function notifyPages() {
  try {
    chrome.runtime.sendMessage({ type: 'd1SyncUpdated' }, () => void chrome.runtime.lastError);
  } catch { /* 无接收页面时忽略 */ }
}

// ---------------- 完整导出 / 导入（OneTab 兼容格式） ----------------

async function exportAll() {
  const db = await openDB();
  if (!storeHas(db, ITEM_STORE)) {
    db.close();
    return { ok: false, error: 'db-not-ready' };
  }
  const items = await readAll(db, ITEM_STORE);
  db.close();
  return {
    ok: true,
    data: {
      format: 'onetap-full-backup',
      v: 2,
      exportedAt: Date.now(),
      itemCount: items.filter((i) => i && i.type === 'tab').length,
      items,
    },
  };
}

/** 导入/恢复前的一致性修复（返回修复后的新数组，不改传入项）。
 *  OneTab 导入/云同步合并的数据里，同一个 tab 常被 2~6 个 window 组同时
 *  认领（childIds），而 tab 自己的 parentIds[0] 指向真正的归属——那是从
 *  OneTab 结构直接继承的事实。裁决规则因此只有一条：
 *    归属 = tab.parentIds[0]（指向存在的组）；无声明则取第一个认领组；
 *    再没有则 root。不用修改时间、不按组类型猜——猜必错（踩过两次）。
 *  配套：各组 childIds 只保留归属本组的 tab；归属组缺列补尾；清掉因此
 *  变空的无名 window 空壳（真正的空用户组有 label 或非 window 型，不受影响）。
 *  注意：必须先拷贝、再在拷贝上建索引并修改——若索引指向原始对象，
 *  修复会落在原始项上、写库的副本仍是坏数据（曾经踩过的坑）。 */
function repairImportConsistency(items) {
  const now = Date.now();
  const out = items.map((it) => (it && it.id != null ? { ...it, modifyDate: now } : it));
  const byId = new Map();
  for (const it of out) if (it && it.id != null) byId.set(it.id, it);
  const get = (id) => byId.get(id);
  const isGroupNode = (n) => n && n.type === 'group';
  // 1) 归属裁决
  const owner = new Map(); // tabId -> 归属组 id（或 'root'）
  for (const n of out) {
    if (n.type !== 'tab') continue;
    const pid0 = Array.isArray(n.parentIds) ? n.parentIds[0] : undefined;
    const p = pid0 != null ? get(pid0) : null;
    if (p && isGroupNode(p)) owner.set(n.id, p.id);
  }
  for (const n of out) {
    if (n.type !== 'tab' || owner.has(n.id)) continue;
    const claim = out.find((g) => isGroupNode(g) && (g.childIds || []).includes(n.id));
    owner.set(n.id, claim ? claim.id : 'root');
  }
  // 2) 各组 childIds：清死引用/去重；tab 只保留归属本组的
  for (const n of out) {
    if (!isGroupNode(n)) continue;
    const kids = [];
    for (const cid of n.childIds || []) {
      const c = get(cid);
      if (!c || kids.includes(cid)) continue;
      if (c.type === 'tab' && owner.get(cid) !== n.id) continue;
      kids.push(cid);
    }
    n.childIds = kids;
  }
  // 3) tab.parentIds 归一；归属组缺列补尾
  for (const n of out) {
    if (n.type !== 'tab') continue;
    const own = owner.get(n.id);
    n.parentIds = [own];
    const g = get(own);
    if (g && isGroupNode(g) && !g.childIds.includes(n.id)) g.childIds.push(n.id);
  }
  // 4) 组/文件夹自身 parentIds 指向不存在的记录 → 挂 root；根节点 parentIds 置空
  const fixDangling = () => {
    for (const n of out) {
      if (!isGroupNode(n) || ['root', 'trash', 'quickList'].includes(n.id)) continue;
      const pid = n.parentIds?.[0];
      if (pid == null || !get(pid) || get(pid).type !== 'group') n.parentIds = ['root'];
    }
    for (const id of ['root', 'trash', 'quickList']) {
      const r = get(id);
      if (r && Array.isArray(r.parentIds) && r.parentIds.length) r.parentIds = [];
    }
  };
  fixDangling();
  // 5) 丢弃空的无名 window 壳（OneTab 同步合并残留；有标签/有名字的不动）
  const drop = new Set();
  for (const n of out) {
    if (isGroupNode(n) && n.groupType === 'window' && !(n.childIds || []).length && !n.label) {
      drop.add(n.id);
    }
  }
  let kept = out;
  if (drop.size) {
    for (const n of kept) {
      if (isGroupNode(n) && (n.childIds || []).some((cid) => drop.has(cid))) {
        n.childIds = n.childIds.filter((cid) => !drop.has(cid));
      }
    }
    kept = kept.filter((n) => !drop.has(n?.id));
    fixDangling();
  }
  return kept;
}

export async function importAll(items) {
  items = repairImportConsistency(items);
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'bad-file' };
  const db = await openDB();
  if (!storeHas(db, ITEM_STORE)) {
    db.close();
    return { ok: false, error: 'db-not-ready' };
  }
  try {
    await new Promise((res, rej) => {
      const tx = db.transaction(ITEM_STORE, 'readwrite');
      tx.objectStore(ITEM_STORE).clear();
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('tx aborted'));
    });
    await writeItem(db, items, []);
    // 导入文件可能不含根节点（OneTab 某些导出路径），缺哪个补哪个
    const have = new Set(items.map((i) => i && i.id));
    if (!have.has('root') || !have.has('trash') || !have.has('quickList')) {
      const now = Date.now();
      const roots = [];
      for (const id of ['root', 'quickList', 'trash']) {
        if (!have.has(id)) {
          roots.push({
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
      }
      await writeItem(db, roots, []);
    }
  } finally {
    db.close();
  }
  await csSet(TOMBSTONES_KEY, {});
  // 整包覆盖/导入后清除待触发的自动上传 alarm：本机刚被云端快照（或文件）
  // 整体替换，用户应先核对结果；新的自动上传只由覆盖之后的写操作触发。
  try { await chrome.alarms.clear(AUTO_PUSH_ALARM); } catch { /* 无 alarms API */ }
  notifyPages();
  return { ok: true, count: items.length };
}

// ---------------- 消息处理（由 background SW 的 onMessage 转发） ----------------

export async function handleD1Message(msg) {
  // 统一错误包装：checkWorkerApi 等抛出的错误(如"Worker 是旧版")要原样
  // 带回前端 toast，而不是变成 undefined 让调用方显示"未知错误"。
  try {
    switch (msg.type) {
    case 'd1SyncGetState': {
      const [c, s, t] = await Promise.all([loadConfig(), getState(), loadTombstones()]);
      return {
        config: c
          ? {
              workerUrl: c.workerUrl,
              token: c.token,
              deviceId: c.deviceId,
              deviceName: c.deviceName,
              passphrase: c.passphrase,
              keepOldSnapshots: c.keepOldSnapshots === true,
              autoPush: c.autoPush !== false,
            }
          : null,
        state: s,
        tombstoneCount: Object.keys(t).length,
      };
    }
    case 'd1SyncSaveConfig': {
      const prev = (await csGet(CS_KEYS.config, null)) || {};
      const next = Object.assign({}, prev, msg.config);
      if (!next.deviceId) {
        next.deviceId = crypto.randomUUID
          ? crypto.randomUUID()
          : 'd' + Date.now() + Math.random().toString(36).slice(2);
      }
      await csSet(CS_KEYS.config, next);
      cfg = next;
      return { ok: true, deviceId: next.deviceId };
    }
    case 'd1SyncPush':
      return runSync('manual-push', { pushOnly: true });
    case 'd1SyncPull': {
      // v5 语义变更：同步到本地 = 拉取云端"最新"的一份快照，整包覆盖本机
      // （旧语义"按修改时间合并"已废弃：合并永远不会撤销本机删除/移乱，
      //  与用户对"同步到本地"的直觉相悖）。返回结果由设置页如实汇报。
      return runPullOverwrite();
    }
    case 'd1SyncExport':
      return exportAll();
    case 'd1SyncImport':
      return importAll(msg.items);
    case 'd1SyncRestoreFromSnapshot': {
      // 从云端某设备的最新快照恢复(全量替换本机标签收纳)。
      // 这是"本机删错/移乱后想回到云端状态"的正规途径:仅下载是合并,
      // 不会撤销本机的删除/移动(tombstone 与 LWW 的语义决定)。
      const c4 = await loadConfig();
      if (!c4) return { ok: false, error: '尚未配置同步' };
      if (syncing) return { ok: false, error: '正在同步中,请稍后再试' };
      syncing = true;
      try {
        cfg = c4;
        cryptoKey = await deriveKey(c4.passphrase);
        // 不带 exclude:让 /pull 返回包括本设备在内的所有快照
        const remote = checkWorkerApi(await apiFetch(c4, '/pull'));
        // v4: 按设备名定位快照
        const entry = (remote.snapshots || []).find((s) => s.deviceName === msg.deviceName);
        if (!entry || !entry.blob) return { ok: false, error: '云端找不到该设备的快照' };
        const snap = await decryptJSON(entry.blob, cryptoKey);
        if (!Array.isArray(snap.items) || !snap.items.length) {
          return { ok: false, error: '该快照没有可恢复的标签数据' };
        }
        // importAll 会整体替换 stashItems、清空 tombstones；意外关闭存档组同样整包覆盖
        const r = await importAll(snap.items);
        try {
          await writeCrashGroups(Array.isArray(snap.crashGroups) ? snap.crashGroups : []);
        } catch (e) { /* 存档组覆盖失败不影响标签收纳恢复 */ }
        // 书签整树：与标签收纳同为覆盖语义（云端的快照是什么样，本机就是什么样）
        let bookmarksApplied = false;
        let bookmarkSkip = null;
        try {
          const bm = snap.bookmarks;
          if (!bm || !bm.tree || !bm.tree.length) {
            bookmarkSkip = '该快照未含书签';
          } else {
            await replaceLocalBookmarks(bm.tree);
            bookmarksApplied = true;
          }
        } catch (e) {
          bookmarkSkip = '整树替换执行失败：' + String((e && e.message) || e);
        }
        return {
          ok: true,
          count: r.count ?? snap.items.length,
          deviceName: entry.deviceName,
          bookmarksApplied,
          bookmarkSkip,
        };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      } finally {
        syncing = false;
      }
    }
    case 'd1SyncListSnapshots': {
      const c1 = await loadConfig();
      if (!c1) return { ok: false, error: '尚未配置同步' };
      const r1 = await apiFetch(c1, '/health');
      checkWorkerApi(r1);
      return { ok: true, devices: r1.devices || [] };
    }
    case 'd1SyncDeleteSnapshot': {
      const c2 = await loadConfig();
      if (!c2) return { ok: false, error: '尚未配置同步' };
      // v4: 按设备名硬删除（Worker 删行、不拉黑）。删除即最终删除。
      if (!msg.deviceName) return { ok: false, error: '缺少设备名' };
      const r = await apiFetch(c2, '/devices/' + encodeURIComponent(msg.deviceName), { method: 'DELETE' });
      checkWorkerApi(r);
      // 本地记下该设备名：自动同步不再上传它（否则"删掉又被自动同步传回来"）；
      // 手动同步仍允许重新上传（显式操作，存在同名时走覆盖/合并选择）。
      await markCloudNameDeleted(msg.deviceName);
      return { ok: true };
    }
    case 'd1SyncDeleteAllSnapshots': {
      const c3 = await loadConfig();
      if (!c3) return { ok: false, error: '尚未配置同步' };
      const r3 = await apiFetch(c3, '/devices', { method: 'DELETE' });
      checkWorkerApi(r3);
      // 本机名同样记"已删除"：全部清空后自动同步不应立刻把本机快照又传回去
      await markCloudNameDeleted(resolveDeviceName(c3));
      return { ok: true };
    }
    case 'd1SyncResolvePush': {
      // v4 冲突协议的落点：手动 push 撞到同名快照时，设置页弹
      // 「覆盖 / 合并 / 取消」，这里按用户选择继续把同步跑完。
      const st = await getState();
      const pc = st.pendingConflict;
      if (!pc) return { ok: false, error: '没有待处理的同名冲突（可能已处理过）' };
      await setState({ pendingConflict: null });
      if (msg.resolution === 'cancel') {
        return { ok: true, cancelled: true, deviceName: pc.deviceName };
      }
      const c6 = await loadConfig();
      if (!c6) return { ok: false, error: '尚未配置同步' };
      cfg = c6;
      cryptoKey = await deriveKey(c6.passphrase);
      if (msg.resolution === 'merge') {
        // 合并：先把云端同名快照合并进本机，再带 overwrite 推合并结果
        const merged = await mergeCloudSnapshotIntoLocal(c6, cryptoKey, pc.deviceName);
        const r = await runSync(pc.trigger, Object.assign({}, pc.opts, { pushMode: 'overwrite' }));
        return Object.assign({ merged }, r);
      }
      if (msg.resolution === 'overwrite') {
        // 覆盖：本机数据替换云端同名快照，然后照原触发选项跑完（如下载合并）
        return runSync(pc.trigger, Object.assign({}, pc.opts, { pushMode: 'overwrite' }));
      }
      return { ok: false, error: '未知的处理方式：' + msg.resolution };
    }
    case 'd1SyncMergeSnapshots': {
      // 合并快照：把云端选中的若干份快照合并为一份"新快照"上传。
      // 规则：按记录 id 跨快照 LWW（modifyDate 新者胜），得到记录并集；
      // 不带 tombstones（不把删除传播进新快照）；不含书签（不动书签）。
      // 原快照保留不动。同名冲突时返回 conflict 由设置页询问是否覆盖。
      const cm = await loadConfig();
      if (!cm) return { ok: false, error: '尚未配置同步' };
      const newName = String(msg.newName || '').trim();
      const names = (msg.deviceNames || []).filter((n) => n && n !== newName);
      if (names.length < 2) return { ok: false, error: '合并快照需至少选中 2 份' };
      if (!newName) return { ok: false, error: '缺少新快照名称' };
      if (syncing) return { ok: false, error: '正在同步中，请稍后再试' };
      syncing = true;
      try {
        cfg = cm;
        cryptoKey = await deriveKey(cm.passphrase);
        const remote = checkWorkerApi(await apiFetch(cm, '/pull'));
        const byId = Object.create(null);
        let crash = [];
        let total = 0;
        for (const entry of remote.snapshots || []) {
          if (!names.includes(entry.deviceName)) continue;
          const snap = await decryptJSON(entry.blob, cryptoKey);
          for (const it of snap.items || []) {
            if (!it || it.id === undefined) continue;
            total++;
            const cur = byId[it.id];
            if (!cur || (it.modifyDate || 0) > (cur.modifyDate || 0)) byId[it.id] = it;
          }
          // 意外关闭存档组：按组 id 取并集
          crash = unionCrashGroups(crash, snap.crashGroups);
        }
        const items = Object.values(byId);
        if (!items.length) return { ok: false, error: '选中的快照里没有标签数据' };
        const snapshot = buildSnapshot(items, {}, newName, null, crash);
        const pr = await pushSnapshot(cm, cryptoKey, newName, snapshot, msg.overwrite ? 'overwrite' : undefined);
        if (pr.conflict) {
          return { ok: false, conflict: true, error: 'name-exists', deviceName: newName };
        }
        return { ok: true, deviceName: newName, count: items.length, total };
      } finally {
        syncing = false;
      }
    }
    case 'd1SyncDisconnect':
      await chrome.storage.local.remove([CS_KEYS.config, CS_KEYS.state]);
      cfg = null;
      return { ok: true };
    case 'd1SyncResetDeviceId': {
      // v3 起云端快照按设备名归属（同名覆盖），deviceId 只作本地标识，
      // 不再影响云端存储位置。此操作保留用于兼容旧配置；如遇两台设备
      // 设备名相同互相覆盖，改设备名即可（设置页"设备名"字段）。
      const c5 = await loadConfig();
      if (!c5) return { ok: false, error: '尚未配置同步' };
      const next = Object.assign({}, c5, {
        deviceId: crypto.randomUUID
          ? crypto.randomUUID()
          : 'd' + Date.now() + Math.random().toString(36).slice(2),
      });
      await csSet(CS_KEYS.config, next);
      cfg = next;
      return { ok: true, deviceId: next.deviceId };
    }
    default:
      return { ok: false, error: 'unknown type: ' + msg.type };
    }
  } catch (e) {
    console.error('[d1-sync] message failed:', msg.type, e);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---------------- 初始化 ----------------

export async function initD1Sync() {
  // 自动上传的 alarm 监听在模块顶层注册（见 noteChange 上方）；
  // 这里只做启动兜底：SW 冷启动时若存在待触发的自动上传 alarm，
  // chrome 会按时唤醒 SW 并触发 onAlarm，无需额外处理。
  console.log('[d1-sync] module initialized（手动同步 + 变更自动上传）');
}
