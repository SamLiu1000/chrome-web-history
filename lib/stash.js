// 标签收纳数据层（OneTab 兼容的树形结构）。
//
// 数据结构与 OneTab 2.21 的 IndexedDB item store 完全一致：
//   - 所有节点存 stashItems store，树挂在三个根节点下：root / quickList / trash
//   - tab:   { id, type:'tab', title, url, createDate, modifyDate, parentIds:[groupId] }
//   - group: { id, type:'group', groupType:'window'|'folder'|'quickList',
//              label?, notes?, createDate, modifyDate,
//              parentIds:[...], childIds:[...], pinnedCount,
//              locked?, rating?, collapsed? }
// 任何写操作都会 touch modifyDate，并通过 d1SyncChanged 消息通知后台同步模块。
// 删除直接记录 tombstone（chrome.storage.local 的 d1SyncTombstones），防云同步"删除复活"。

import { openDB, getSetting } from './db.js';
import { noteChange } from './d1-sync.js';

export const TOMBSTONES_KEY = 'd1SyncTombstones';

let idSeq = 0;
function genId() {
  idSeq = (idSeq + 1) % 1000;
  return 'wh' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + idSeq.toString(36);
}

/** onetap 的 notes 是 {text:[...]} 数组；这里统一取成普通字符串（读兼容两种）。 */
export function notesText(item) {
  const t = item?.notes?.text;
  if (!t) return '';
  return Array.isArray(t) ? t.join('\n') : String(t);
}

function touch(item) {
  item.modifyDate = Date.now();
  return item;
}

/** 写操作完成后调用：通知后台 D1 同步模块（debounce 在后台做）。 */
// 本模块实例的令牌（每个扩展页面一份模块实例 = 一个令牌）：广播带上它，
// 页面据此忽略"自己刚写的库"触发的广播，避免自触发全量重绘打乱滚动位置
const NOTIFY_TOKEN = (typeof crypto !== 'undefined' && crypto.randomUUID)
  ? crypto.randomUUID()
  : String(Math.random());
export { NOTIFY_TOKEN };

function notifySync() {
  // 在 SW 里运行时（右键菜单收纳等）sendMessage 不会送达发送者自己，
  // SW 的 d1SyncChanged 监听器收不到 → 变更同步丢失。直接调 noteChange。
  if (typeof document === 'undefined') {
    noteChange();
  } else {
    try {
      chrome.runtime.sendMessage({ type: 'd1SyncChanged' }, () => void chrome.runtime.lastError);
    } catch { /* SW 不可用时忽略 */ }
  }
  // 跨页面实时广播（BroadcastChannel）：弹窗/右键菜单/其它收纳页窗口写库后，
  // 已打开的收纳页立即重绘（含侧栏计数），不必等用户点击或刷新。
  // 带上本模块实例的令牌：页面收到"自己刚发的"广播要忽略——否则本页每次写库
  // （切换打开后消除、点开标签移入回收站……）都会触发全量重绘，滚动位置被打乱。
  // 每个扩展页面有自己的模块实例 = 自己的令牌，跨页面照常刷新。
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel('web-history-stash-changed');
      ch.postMessage({ token: NOTIFY_TOKEN });
      ch.close();
    }
  } catch { /* 广播失败不影响写库 */ }
}

async function recordTombstones(ids) {
  if (!ids.length) return;
  const got = await chrome.storage.local.get(TOMBSTONES_KEY);
  const t = got[TOMBSTONES_KEY] || {};
  const now = Date.now();
  for (const id of ids) t[id] = now;
  await chrome.storage.local.set({ [TOMBSTONES_KEY]: t });
}

// ---------------------------------------------------------------- 读取

/** 读全部收纳数据并返回 byId Map（渲染与操作共用）。
 *  注意：百万级数据下这是重操作（秒级 + 上 GB 内存），只应用于导出等
 *  本来就需要全量的场景；开页校验和单条操作请用下面的按需读取原语。 */
export async function readAllStashItems() {
  const db = await openDB();
  const rows = await new Promise((resolve, reject) => {
    const req = db.transaction('stashItems').objectStore('stashItems').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  return new Map(rows.filter((r) => r && r.id).map((r) => [r.id, r]));
}

// ---------------------------------------------------------------- 按需读取（百万级）
//
// 收纳数据到百万级后，"为了看/改一条记录而全表读入 Map"不可接受：
// 每次打开、每次点击都会是全表扫描 + 上 GB 内存。以下原语（DB v5 起可用）
// 把读取范围收缩到真正需要的部分：

/** 全库最大 modifyDate（byModifyDate 索引取末尾，毫秒级）。
 *  供"一次性一致性修复"判断数据是否在修复后又有变更。失败返回 0。 */
export async function maxStashModifyDate() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      let req;
      try {
        req = db.transaction('stashItems').objectStore('stashItems')
          .index('byModifyDate').openCursor(null, 'prev');
      } catch { resolve(0); return; }
      req.onsuccess = () => resolve(req.result ? (req.result.value?.modifyDate || 0) : 0);
      req.onerror = () => resolve(0);
    });
  } catch { return 0; }
}

/** 只取 modifyDate 大于 mark 的记录（byModifyDate 索引范围查询）。
 *  开页后比对新旧：没有其它来源变更时返回空数组，毫秒级完成，不再全表扫描。
 *  索引不存在（库还是 v4、升级被其它标签页阻塞）时 reject，调用方回退全量比对。 */
export async function readStashChangesSince(mark) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = db.transaction('stashItems').objectStore('stashItems')
        .index('byModifyDate').getAll(IDBKeyRange.lowerBound(mark, true));
    } catch (e) { reject(e); return; }
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** 按主键读单条——替代"为了改一条而全表读入 Map"。
 *  id 为空（如 parentIds 缺失的异常记录）时直接返回 null：
 *  store.get(undefined) 会抛 DataError，而旧实现 byId.get(undefined) 是安全返回。 */
export async function readStashItem(id) {
  if (id == null) return null;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('stashItems').objectStore('stashItems').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** 批量主键读（一次事务拿多条，避免 N 次往返）。返回结果不含顺序保证。 */
export async function readStashItems(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return [];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('stashItems');
    const store = tx.objectStore('stashItems');
    const out = [];
    for (const id of list) {
      const req = store.get(id);
      req.onsuccess = () => { if (req.result) out.push(req.result); };
    }
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** 一次性全库一致性修复：显示（内存 childIds）与恢复/计数（parentIds 索引）
 *  是两条读路径，历史数据（OneTab 导入多组认领、LWW 合并、旧版 bug）可能让
 *  "组 childIds" 与 "tab.parentIds" 互相不认——表现为组卡片看着是空的，
 *  点「恢复」却能打开标签（恢复走 childIds∪索引 并集）。
 *  裁决规则与 d1-sync 的 repairImportConsistency 一致：归属 = tab.parentIds[0]
 *  （指向存在的组），无声明取第一个认领组，再没有则 root；各组 childIds 只
 *  保留归属本组的 tab；顺带删除变空的无名 window 壳。不用修改时间、不按组
 *  类型猜——OneTab 导入数据里同一 tab 被多组认领是常态，猜必错（踩过两次）。
 *  只写回有变化的记录。返回修复的记录数（0 = 本来就一致）。 */
export async function repairStashTreeConsistency() {
  const db = await openDB();
  let items;
  try {
    if (!Array.from(db.objectStoreNames).includes('stashItems')) return 0;
    items = await new Promise((resolve, reject) => {
      const tx = db.transaction('stashItems');
      const req = tx.objectStore('stashItems').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } finally {
    // openDB() 是全局共享单例连接，绝不能 close
  }
  const byId = new Map();
  for (const it of items) if (it && it.id != null) byId.set(it.id, it);
  const changed = [];
  const isGroup = (n) => n && n.type === 'group';
  // 1) 归属裁决：parentIds[0] 优先，无声明取第一个认领组，再没有 root
  const owner = new Map();
  for (const n of items) {
    if (n.type !== 'tab') continue;
    const pid0 = Array.isArray(n.parentIds) ? n.parentIds[0] : undefined;
    const p = pid0 != null ? byId.get(pid0) : null;
    if (p && isGroup(p)) owner.set(n.id, p.id);
  }
  for (const n of items) {
    if (n.type !== 'tab' || owner.has(n.id)) continue;
    const claim = items.find((g) => isGroup(g) && (g.childIds || []).includes(n.id));
    owner.set(n.id, claim ? claim.id : 'root');
  }
  // 2) 各组 childIds：清死引用/去重；tab 只保留归属本组的
  for (const n of items) {
    if (!isGroup(n)) continue;
    const kids = [];
    let dirty = false;
    for (const cid of n.childIds || []) {
      const c = byId.get(cid);
      if (!c || kids.includes(cid)) { dirty = true; continue; }
      if (c.type === 'tab' && owner.get(cid) !== n.id) { dirty = true; continue; }
      kids.push(cid);
    }
    if (dirty || (n.childIds || []).length !== kids.length) {
      n.childIds = kids;
      changed.push(n);
    }
  }
  // 3) tab.parentIds 归一；归属组缺列补尾
  for (const n of items) {
    if (n.type !== 'tab') continue;
    const own = owner.get(n.id);
    const p = byId.get(own);
    if (n.parentIds?.[0] !== own) {
      n.parentIds = [own];
      touch(n);
      changed.push(n);
    }
    if (p && isGroup(p) && !(p.childIds || []).includes(n.id)) {
      p.childIds = [...(p.childIds || []), n.id];
      changed.push(p);
    }
  }
  // 4) 组/文件夹挂靠悬空 → root；根节点 parentIds 必须为空
  for (const n of items) {
    if (!isGroup(n) || ['root', 'trash', 'quickList'].includes(n.id)) continue;
    const pid = n.parentIds?.[0];
    if (pid == null || !byId.get(pid) || byId.get(pid).type !== 'group') {
      n.parentIds = ['root'];
      touch(n);
      changed.push(n);
    }
  }
  for (const id of ['root', 'trash', 'quickList']) {
    const r = byId.get(id);
    if (r && Array.isArray(r.parentIds) && r.parentIds.length) {
      r.parentIds = [];
      changed.push(r);
    }
  }
  // 5) 丢弃空的无名 window 壳（OneTab 同步合并残留；有标签/有名字的不动）
  const drop = new Set();
  for (const n of items) {
    if (isGroup(n) && n.groupType === 'window' && !(n.childIds || []).length && !n.label) {
      drop.add(n.id);
      changed.push(n);
    }
  }
  if (!changed.length) return 0;
  const now = Date.now();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('stashItems', 'readwrite');
    const store = tx.objectStore('stashItems');
    for (const n of changed) {
      if (drop.has(n.id)) { store.delete(n.id); continue; }
      n.modifyDate = now;
      store.put(n);
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('tx aborted'));
  });
  return changed.length;
}

/** 按父节点读直接子节点（byParent 是多条目索引，parentIds 数组每个值都建索引）。
 *  文件夹内容、左栏树、回收站列表都只依赖当前可见范围。
 *  注意：返回顺序按索引，不保证父节点 childIds 的展示顺序，需要时用
 *  readChildrenOrdered 校正。索引不可用（库还没升级到 v5）时自动回退为
 *  按父节点 childIds 逐条主键读，行为与旧实现一致。 */
export async function readStashChildren(parentId) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction('stashItems').objectStore('stashItems')
        .index('byParent').getAll(parentId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    // 索引不存在（升级被其它标签页阻塞等）：按 childIds 逐条读
    const parent = await readStashItem(parentId);
    const ids = parent && Array.isArray(parent.childIds) ? parent.childIds : [];
    return readStashItems(ids);
  }
}

/** 读一个节点的直接子节点，并按该节点 childIds 的展示顺序排列。
 *  走 byParent 索引一次查询拿全，顺序用父节点 childIds 校正；
 *  索引里多出、childIds 没收录的（数据不一致）兜底附在末尾。 */
export async function readChildrenOrdered(node) {
  const kids = await readStashChildren(node.id);
  const ids = Array.isArray(node.childIds) ? node.childIds : [];
  if (!ids.length) return kids;
  const byId = new Map(kids.map((k) => [k.id, k]));
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    const k = byId.get(id);
    if (k) { out.push(k); seen.add(id); }
  }
  for (const k of kids) if (!seen.has(k.id)) out.push(k);
  return out;
}

/** 一次事务读多个父节点的直接子节点（按层批处理）。
 *  删整棵子树时逐层一把查完：查询次数 = 树的深度（通常 2~3），而不是组节点数。
 *  索引不可用（库还没升级到 v5）时回退为按各节点 childIds 批量主键读。 */
async function readStashChildrenMulti(nodes) {
  const list = (nodes || []).filter((n) => n && n.id);
  if (!list.length) return [];
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('stashItems');
      const idx = tx.objectStore('stashItems').index('byParent');
      const out = [];
      for (const n of list) {
        const req = idx.getAll(n.id);
        req.onsuccess = () => { for (const r of req.result || []) out.push(r); };
      }
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    const ids = [];
    for (const n of list) {
      for (const cid of (Array.isArray(n.childIds) ? n.childIds : [])) ids.push(cid);
    }
    return readStashItems(ids);
  }
}

/** 收集一个节点整棵子树的全部 id（含自身，用于彻底删除）。
 *  逐层走 byParent 索引批查，只读这棵子树涉及的记录，不建全量 Map；
 *  seen 集合同时防数据损坏成环时死循环，tab 不会入队（没有子节点）。 */
async function collectSubtree(root) {
  const doomed = [root.id];
  const seen = new Set([root.id]);
  let level = [root]; // 只放 group：只有组才有子节点
  while (level.length) {
    const kids = await readStashChildrenMulti(level);
    const next = [];
    for (const k of kids) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      doomed.push(k.id);
      if (k.type === 'group') next.push(k);
    }
    level = next;
  }
  return doomed;
}

/** 文件夹树 + root 直接子节点（全部结构节点，不含任何 tab）。
 *  按层批查：查询次数 = 文件夹树深度（通常 2~4），与文件夹/组总数无关。
 *  左栏、'移动到文件夹'菜单、拖拽目标都只需要结构；tab 一律不读。
 *  回收站里的文件夹不在 root 之下，不会进来（侧栏本就不显示它们）。 */
export async function readFolderTree() {
  const map = new Map();
  const root = await readStashItem('root');
  if (!root) return map;
  map.set('root', root);
  let level = [root];
  while (level.length) {
    const kids = await readStashChildrenMulti(level);
    const next = [];
    for (const k of kids) {
      if (map.has(k.id)) continue;
      map.set(k.id, k);
      if (k.type === 'group' && k.groupType === 'folder') next.push(k);
    }
    level = next;
  }
  return map;
}

/** 收集一个节点全部'组类型'后代（group/folder）的 id 集合，tab 不入队。
 *  拖拽防成环专用：落点只能是组/文件夹，只需要组结构。
 *  按层批查，每层会把该层全部子记录（含 tab）读入——巨型组（十万级 tab）
 *  在拖拽起始时会有一层的大读；与旧实现'每次点击全表读'相比仍小几个量级，
 *  且整个拖拽过程只发生一次。 */
export async function readGroupDescendants(nodeId) {
  const out = new Set();
  const root = await readStashItem(nodeId);
  if (!root || root.type !== 'group') return out;
  let level = [root];
  const seen = new Set([root.id]);
  while (level.length) {
    const kids = await readStashChildrenMulti(level);
    const next = [];
    for (const k of kids) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      if (k.type !== 'group') continue; // tab：叶子，不可能包含落点
      out.add(k.id);
      next.push(k);
    }
    level = next;
  }
  return out;
}

/** 读一个节点的整棵子树（含自身）进 Map——单组导出/复制用，不再全表扫描。
 *  按层批查（查询次数 = 子树深度），展示顺序由调用方按 childIds 自行 DFS。 */
export async function readStashSubtree(nodeId) {
  const map = new Map();
  const root = await readStashItem(nodeId);
  if (!root) return map;
  map.set(root.id, root);
  let level = root.type === 'group' ? [root] : [];
  const seen = new Set([root.id]);
  while (level.length) {
    const kids = await readStashChildrenMulti(level);
    const next = [];
    for (const k of kids) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      map.set(k.id, k);
      if (k.type === 'group') next.push(k);
    }
    level = next;
  }
  return map;
}

/** 批量统计各父节点的直接子节点数（byParent 索引 count，不读任何记录体）。
 *  侧栏计数专用：可见范围 byId 只装"当前文件夹"的 tab，侧栏里其它分组和
 *  回收站的数量没法从 byId 数（会恒显示 0，点进去才变对）。count 走索引
 *  B-tree，不物化记录，百万级也是一次毫秒级事务；语义与界面实际展示的
 *  子节点一致（readChildrenOrdered 展示的正是索引命中的集合：childIds 里
 *  存在的 + 索引里多出的孤儿，死引用不计）。
 *  返回 Map<parentId, number>；索引不可用（库未升 v5）时返回空 Map，
 *  调用方回退为按 childIds 数。 */
/** 深层标签计数：数给定父节点（文件夹 / 回收站）之下全部后代 tab 的数量
 *  （嵌套子文件夹也递归进去；组节点本身不计）。侧栏文件夹/回收站行右侧
 *  显示"标签数"专用。按 byParent 索引逐层批查：文件夹→组→tab 通常只有两三层，
 *  每层一次只读事务；返回 Map<parentId, deepTabCount>。索引不可用（库未升 v5）
 *  时返回空 Map，调用方回退为在已加载范围内递归数。 */
export async function countStashTabsDeep(parentIds) {
  if (!parentIds?.length) return new Map();
  const direct = new Map(); // id -> 直接挂在它下面的 tab 数
  const kids = new Map();   // id -> 直接子组 id（按本次遍历的实际父子边，不用 parentIds 反推）
  const roots = [...new Set(parentIds.filter((id) => id != null))];
  let layer = [...roots];
  const db = await openDB();
  try {
    while (layer.length) {
      const next = [];
      await new Promise((resolve, reject) => {
        const tx = db.transaction('stashItems');
        const idx = tx.objectStore('stashItems').index('byParent');
        for (const id of layer) {
          const req = idx.getAll(id);
          req.onsuccess = () => {
            let tabs = 0;
            const gs = [];
            for (const r of req.result || []) {
              if (r?.type === 'tab') tabs++;
              else if (r?.type === 'group') { gs.push(r.id); next.push(r.id); }
            }
            direct.set(id, tabs);
            kids.set(id, gs);
          };
        }
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('tx aborted'));
      });
      layer = [...new Set(next)];
    }
  } catch {
    return new Map();
  }
  // 沿遍历树记忆化 DFS 汇总。绝不能用 parentIds 反推父节点再累加：
  // 历史数据/云同步合并可能留下同一组被多条父子边引用（multiEntry 索引下
  // 会在每个父节点名下各出现一次），按 parentIds 累加会把同一份标签数
  // 重复计入多个祖先（曾表现为文件夹计数 = 实际值的翻倍）。
  const deep = new Map();
  const visiting = new Set();
  const calc = (id) => {
    const memo = deep.get(id);
    if (memo !== undefined) return memo;
    if (visiting.has(id)) return 0; // 数据环：按 0 收口，防死循环
    visiting.add(id);
    let v = direct.get(id) || 0;
    for (const c of kids.get(id) || []) v += calc(c);
    visiting.delete(id);
    deep.set(id, v);
    return v;
  };
  for (const id of roots) calc(id);
  // openDB() 返回的是全局共享单例连接，绝不能 close——
  // 关掉后后续所有事务都会报 "The database connection is closing"。
  return deep;
}

export async function countStashChildren(parentIds) {
  const ids = [...new Set((parentIds || []).filter((id) => id != null))];
  const out = new Map();
  if (!ids.length) return out;
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('stashItems');
      const idx = tx.objectStore('stashItems').index('byParent');
      for (const id of ids) {
        const req = idx.count(id);
        req.onsuccess = () => out.set(id, req.result || 0);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('tx aborted'));
    });
  } catch {
    return new Map(); // 索引缺失：调用方回退按 childIds 数
  }
  return out;
}

/** 可见范围按需读取（百万级第三阶段核心）：一次调用拿到视图渲染+交互所需的
 *  全部节点，约 5~6 次索引查询，耗时与库总量无关：
 *    1. root / trash 两个根节点（一次事务）
 *    2. 全文件夹树 + root 直接子节点（readFolderTree，深度次查询）
 *    3. 当前文件夹的直接子节点（按 childIds 展示序）
 *    4. 这些分组各自的 tab（一次事务批查）
 *  返回的 Map 可直接当视图的 byId 用；当前文件夹已被删时 Map 里不会有它，
 *  调用方据此回退 root。索引不可用（库未升 v5）时各原语自动回退逐条读，
 *  行为与旧实现一致。
 *  回收站（folderId==='trash'）额外把各被删文件夹的整棵子树读入——主区要把
 *  它们像文件夹树一样展开（子文件夹/组/tab），查询次数 = 顶层文件夹数 × 子树深度，
 *  只在查看回收站时发生。 */
export async function readStashScope(folderId) {
  const map = new Map();
  for (const r of await readStashItems(['root', 'trash'])) map.set(r.id, r);
  for (const [id, n] of await readFolderTree()) map.set(id, n);
  const cur = map.get(folderId) || await readStashItem(folderId);
  if (!cur || cur.type !== 'group') return map; // 文件夹不存在/异常：调用方回退 root
  map.set(cur.id, cur);
  const kids = await readChildrenOrdered(cur);
  // 视图口径统一：childIds 校正为"childIds 顺序 + 索引孤儿"（仅内存，不写库）。
  // 历史数据里散落记录可能没登记进 trash.childIds——不校正的话，
  // 侧栏计数（按索引）与点开后的显示（按 childIds）对不上
  cur.childIds = kids.map((k) => k.id);
  for (const k of kids) map.set(k.id, k);
  const groups = kids.filter((k) => k.type === 'group' && k.groupType !== 'folder');
  if (groups.length) {
    // 组内 childIds 同样校正（组内也可能有索引孤儿 tab），保证计数 = 显示。
    // 就地按各组 childIds 顺序重排批量读取结果，不产生额外查询。
    const flat = await readStashChildrenMulti(groups);
    const byParent = new Map();
    for (const r of flat) {
      const pid = r.parentIds?.[0];
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(r);
    }
    for (const g of groups) {
      const list = byParent.get(g.id) || [];
      const byId2 = new Map(list.map((k) => [k.id, k]));
      const ordered = [];
      const seen = new Set();
      for (const id of (Array.isArray(g.childIds) ? g.childIds : [])) {
        const k = byId2.get(id);
        if (k && !seen.has(id)) { ordered.push(k); seen.add(id); }
      }
      for (const k of list) if (!seen.has(k.id)) ordered.push(k);
      g.childIds = ordered.map((k) => k.id);
      for (const k of ordered) map.set(k.id, k);
    }
  }
  // 侧栏「回收站」展开列表：任意文件夹视图下左栏都要能列出回收站的直接子节点
  // （被删分组/散落 tab 记录，只加载这一层；各组内的 tab 不加载——组计数走
  // byParent 索引 count，见 countTargetsOf）。回收站视图自身在上面已把 trash
  // 当 cur 加载过，跳过避免重复查询。
  if (folderId !== 'trash') {
    const trash = map.get('trash');
    if (trash && trash.type === 'group') {
      const tkids = await readChildrenOrdered(trash);
      trash.childIds = tkids.map((k) => k.id);
      for (const k of tkids) map.set(k.id, k);
    }
  }
  // 回收站视图：被删文件夹内部还有整棵子树（子文件夹/组/tab），主区要按
  // 文件夹树展开——把各顶层文件夹的子树也读进来（含文件夹自身，重复覆盖无害）
  if (folderId === 'trash') {
    for (const k of kids) {
      if (k.type === 'group' && k.groupType === 'folder') {
        for (const [id, n] of await readStashSubtree(k.id)) map.set(id, n);
      }
    }
  }
  return map;
}

/** 某个根节点（root / trash）下的顶层分组，按 childIds 顺序。 */
export function childrenOf(byId, nodeId) {
  const node = byId.get(nodeId);
  return node && Array.isArray(node.childIds)
    ? node.childIds.map((id) => byId.get(id)).filter(Boolean)
    : [];
}

// ---------------------------------------------------------------- 收纳

/**
 * 收纳标签页为一组。
 * tabs: [{url, title, pinned}]（已过滤掉扩展自身页面）。
 * 返回新建的 group item。
 */
export async function stashTabs(tabs, { groupLabel = '', parent = 'root' } = {}) {
  if (!tabs.length) return null;
  const db = await openDB();
  const now = Date.now();
  const gid = genId();
  const group = {
    id: gid,
    type: 'group',
    groupType: 'window',
    createDate: now,
    modifyDate: now,
    parentIds: [parent],
    childIds: [],
    pinnedCount: 0,
  };
  if (groupLabel) group.label = groupLabel;
  for (const t of tabs) {
    const tid = genId();
    group.childIds.push(tid);
    const item = {
      id: tid,
      type: 'tab',
      title: t.title || '',
      url: t.url,
      createDate: now,
      modifyDate: now,
      parentIds: [gid],
    };
    if (t.pinned) {
      // 与 OneTab 一致：置顶项排在组头部并计入 pinnedCount
      group.childIds.pop();
      group.childIds.unshift(tid);
      group.pinnedCount = (group.pinnedCount || 0) + 1;
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction('stashItems', 'readwrite');
      tx.objectStore('stashItems').put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  await new Promise((resolve, reject) => {
    const tx = db.transaction('stashItems', 'readwrite');
    const store = tx.objectStore('stashItems');
    store.put(group);
    // 挂到父节点
    const preq = store.get(parent);
    preq.onsuccess = () => {
      const p = preq.result;
      if (!p) return;
      p.childIds = Array.isArray(p.childIds) ? p.childIds : [];
      p.childIds.unshift(gid); // 新组排在最前（OneTab 习惯：新的在上面）
      touch(p);
      store.put(p);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  notifySync();
  return group;
}

/** 取一个 chrome tab 的可收纳 URL；本扩展自身的页面（收纳页/侧栏）不收。 */
function stashableUrl(t) {
  const url = t.url || t.pendingUrl || '';
  if (!url) return null;
  try {
    if (url.startsWith(chrome.runtime.getURL(''))) return null;
  } catch { /* getURL 不可用时忽略 */ }
  return url;
}

/** 收纳一组 chrome tab，成功后关闭已被收纳的标签页（重复 URL 的只关入库的那一个）。 */
async function stashChromeTabs(rawTabs, { parent = 'root' } = {}) {
  const seen = new Set();
  const clean = [];
  const closeIds = [];
  for (const t of rawTabs) {
    const url = stashableUrl(t);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    clean.push({ url, title: t.title || '', pinned: !!t.pinned });
    if (t.id != null) closeIds.push(t.id);
  }
  const group = await stashTabs(clean, { parent });
  if (group) {
    for (const id of closeIds) await chrome.tabs.remove(id).catch(() => {});
  }
  return group;
}

/** 收纳当前窗口（allWindows=true 时收纳全部窗口的全部标签页），收完关闭已收纳的。 */
export async function stashOpenTabs({ allWindows = false, parent = 'root' } = {}) {
  const tabs = await chrome.tabs.query(allWindows ? {} : { currentWindow: true });
  return stashChromeTabs(tabs, { parent });
}

/**
 * 右键图标快捷收纳：只收本窗口，以基点标签页（插件页）为界，含浏览器自带页面。
 * mode: 'active'（当前活动标签）| 'left'（基点左侧）| 'right'（基点右侧）| 'all'（本窗口全部）。
 */
export async function stashWindowTabs({ windowId, pivotIndex = -1, mode = 'all', parent = 'root' } = {}) {
  const tabs = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
  const pick = {
    active: (t) => t.active,
    left: (t) => t.index < pivotIndex,
    right: (t) => t.index > pivotIndex,
    all: () => true,
  }[mode] || (() => true);
  return stashChromeTabs(tabs.filter(pick), { parent });
}

// ---------------------------------------------------------------- 恢复

/**
 * 恢复一组：在新窗口打开全部标签页（固定标签除外）。
 * 组勾选了「打开后消除」且未锁定：后台开窗（不抢焦点，停在程序界面），
 * 打开后整组移除——默认移入回收站（可找回），设置 stashOpenDeleteForever=true
 * 时彻底删除；否则窗口聚焦打开、组原样保留。
 * 返回 { opened, eliminated }。
 */
export async function restoreGroup(gid) {
  const group = await readStashItem(gid);
  if (!group || group.type !== 'group') return { opened: 0, eliminated: false };
  const kids = await readChildrenOrdered(group);
  const selfUrl = (() => { try { return chrome.runtime.getURL(''); } catch { return ''; } })();
  const urls = kids.filter((t) => t.type === 'tab').map((t) => t.url)
    .filter((u) => u && !u.startsWith(selfUrl));
  if (urls.length) await chrome.windows.create({ url: urls, focused: !group.openDelete });
  const eliminate = !!group.openDelete && !group.locked;
  if (eliminate) {
    if (await getSetting('stashOpenDeleteForever', false)) await deleteGroupForever(gid);
    else await moveNode(gid, 'trash');
    notifySync();
  }
  return { opened: urls.length, eliminated: eliminate };
}

/** 「打开后消除」默认模式：标签记录移入回收站（消除回收，可移回），记 originGroupId；
 *  组被搬空时按 OneTab 语义处理：锁定的/已命名的组保留组壳，未命名普通组消除。 */
async function stashTabToTrash(tid, gid) {
  const tab = await readStashItem(tid);
  if (!tab || tab.type !== 'tab') return;
  const group = await readStashItem(gid);
  const trash = await readStashItem('trash');
  const db = await openDB();
  const doomed = [];
  await new Promise((resolve, reject) => {
    const tx = db.transaction('stashItems', 'readwrite');
    const store = tx.objectStore('stashItems');
    tab.parentIds = ['trash'];
    tab.originGroupId = gid;
    touch(tab);
    store.put(tab);
    // 登记进 trash.childIds：否则这条记录是索引孤儿——计数（按索引）算得到、
    // 视图（按 childIds）显示不到，回收站"右侧 10 条、点开只有 1 条"的根源
    if (trash) {
      trash.childIds = Array.isArray(trash.childIds) ? trash.childIds : [];
      if (!trash.childIds.includes(tid)) trash.childIds.push(tid);
      touch(trash);
      store.put(trash);
    }
    if (group && group.id !== 'trash') {
      const oldIdx = (group.childIds || []).indexOf(tid);
      group.childIds = (group.childIds || []).filter((x) => x !== tid);
      if (oldIdx >= 0 && oldIdx < (group.pinnedCount || 0)) {
        group.pinnedCount = Math.max(0, (group.pinnedCount || 0) - 1);
      }
      if (!(group.childIds || []).length && group.groupType !== 'folder'
        && !group.locked && !group.label) {
        store.delete(group.id);
        doomed.push(group.id);
      } else {
        touch(group);
        store.put(group);
      }
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await recordTombstones(doomed);
  notifySync();
}

/** 把回收站里的消除回收移回：优先原分组（还在就回去）；
 *  原分组已消除 → 进入以恢复日期命名的标签组（当天多次恢复共用同一天的那组，
 *  避免每次恢复都散出一堆单标签组）。 */
export async function restoreLooseTab(tid) {
  const t = await readStashItem(tid);
  if (!t || t.type !== 'tab' || t.parentIds?.[0] !== 'trash') return false;
  let target = null;
  if (t.originGroupId) {
    const og = await readStashItem(t.originGroupId);
    if (og && og.type === 'group' && og.id !== 'trash' && og.parentIds?.[0] !== 'trash') {
      target = og.id;
    }
  }
  if (!target) {
    // 恢复日期组名（如"2026-10-14"）：优先复用当天已存在的同名组
    const d = new Date();
    const dayLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const root = await readStashItem('root');
    const kids = root ? await readChildrenOrdered(root) : [];
    const dayGroup = kids.find((n) => n.type === 'group' && n.groupType !== 'folder'
      && n.label === dayLabel);
    if (dayGroup) {
      target = dayGroup.id;
    } else {
      const shell = await createGroupShell('root');
      await updateItem(shell.id, (n) => { n.label = dayLabel; });
      target = shell.id;
    }
  }
  await moveNode(tid, target);
  await updateItem(tid, (x) => { delete x.originGroupId; });
  return true;
}

/** 后台打开单个收纳的标签页（焦点留在当前页面，不跳走）；
 *  opts.remove=true 或所在组勾选了「打开后消除」时，打开后删除该记录，
 *  返回是否已消除。remove 由调用方（视图缓存）传入，避免读库判定被写库时序影响。
 *  消除默认为移入回收站（可找回）；设置 stashOpenDeleteForever=true 时彻底删除。 */
export async function openStashTab(id, { remove = false } = {}) {
  const item = await readStashItem(id);
  if (!item?.url) return false;
  // 显式指定 windowId（扩展页面所在窗口）+ active:false：网页在当前窗口
  // 后台加载，不把焦点从程序界面切走
  let windowId;
  try { windowId = (await chrome.windows.getCurrent()).id; } catch { /* 上下文无窗口时忽略 */ }
  await chrome.tabs.create({ url: item.url, ...(windowId != null ? { windowId } : {}), active: false });
  // 组顶栏勾选了「打开后消除」：打开网页后移除这条记录
  const gid = item.parentIds?.[0];
  const g = gid != null ? await readStashItem(gid) : null;
  if ((remove || g?.openDelete) && gid !== 'trash') {
    if (await getSetting('stashOpenDeleteForever', false)) await deleteTab(id);
    else await stashTabToTrash(id, gid);
    return true;
  }
  return false;
}

/** 设置分组的「打开后消除」标记（显式写入目标状态，不做读-改-写翻转）。 */
export async function setOpenDelete(gid, on) {
  const g = await readStashItem(gid);
  if (!g || g.type !== 'group' || g.groupType === 'folder') return;
  await updateItem(gid, (n) => {
    if (on) n.openDelete = true;
    else delete n.openDelete;
  });
}

// ---------------------------------------------------------------- 组操作

async function updateItem(id, mutator) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('stashItems', 'readwrite');
    const store = tx.objectStore('stashItems');
    const req = store.get(id);
    req.onsuccess = () => {
      const item = req.result;
      if (item) {
        mutator(item);
        touch(item);
        store.put(item);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  notifySync();
}

export const toggleLock = (id) => updateItem(id, (g) => { g.locked = !g.locked; });

/** 批量设置锁定态（编辑模式「锁定/解锁所选」用）。逐个 updateItem，
 *  自动 touch + notifySync，云同步按 modifyDate 正常收敛。 */
export async function setGroupsLocked(ids, locked) {
  for (const id of ids) await updateItem(id, (g) => { g.locked = locked; });
}

/**
 * 重写某节点 childIds 的顺序（排序功能用）：只对既有子项重排，不增删；
 * 走 updateItem 自动 touch + notifySync，云同步按 modifyDate 正常收敛。
 * orderedIds 需给出完整顺序；未列出的子项按原相对顺序排在末尾。
 */
export async function reorderChildren(parentId, orderedIds) {
  const rank = new Map((orderedIds || []).map((id, i) => [id, i]));
  await updateItem(parentId, (item) => {
    const cur = item.childIds || [];
    item.childIds = cur
      .map((id, i) => ({ id, i, r: rank.has(id) ? rank.get(id) : cur.length + i }))
      .sort((a, b) => a.r - b.r)
      .map((x) => x.id);
  });
}
export const toggleCollapse = (id) => updateItem(id, (g) => { g.collapsed = !g.collapsed; });
export const toggleStar = (id) => updateItem(id, (g) => { g.rating = g.rating ? 0 : 5; });

/** 命名分组 / 添加备注（notes 沿用 OneTab 的 {text:[...]} 结构）。 */
export async function renameGroup(id, label, notes) {
  await updateItem(id, (g) => {
    if (label !== undefined) {
      if (label) g.label = label; else delete g.label;
    }
    if (notes !== undefined) {
      if (notes) g.notes = { text: notes.split('\n') }; else delete g.notes;
    }
  });
}

/** 置顶/取消置顶一个标签页（排到组头部置顶区 / 移回普通区）。 */
export async function togglePinTab(tid) {
  const tab = await readStashItem(tid);
  if (!tab || tab.type !== 'tab') return;
  const gid = tab.parentIds?.[0];
  const group = gid != null ? await readStashItem(gid) : null;
  if (!group || !Array.isArray(group.childIds)) return;
  const pinned = group.childIds.findIndex((x) => x === tid) < (group.pinnedCount || 0);
  group.childIds = group.childIds.filter((x) => x !== tid);
  if (pinned) {
    group.pinnedCount = Math.max(0, (group.pinnedCount || 0) - 1);
    group.childIds.splice(group.pinnedCount, 0, tid);
  } else {
    group.childIds.unshift(tid);
    group.pinnedCount = (group.pinnedCount || 0) + 1;
  }
  touch(group);
  touch(tab);
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('stashItems', 'readwrite');
    tx.objectStore('stashItems').put(group);
    tx.objectStore('stashItems').put(tab);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  notifySync();
}

/** 新建文件夹（OneTab 左侧栏的文件夹，可嵌套；folder 也是一种 group）。 */
export async function createFolder(label, parent = 'root') {
  if (!label) return null;
  const db = await openDB();
  const now = Date.now();
  const folder = {
    id: genId(),
    type: 'group',
    groupType: 'folder',
    label,
    createDate: now,
    modifyDate: now,
    parentIds: [parent],
    childIds: [],
    pinnedCount: 0,
  };
  await new Promise((resolve, reject) => {
    const tx = db.transaction('stashItems', 'readwrite');
    const store = tx.objectStore('stashItems');
    store.put(folder);
    const nreq = store.get(parent);
    nreq.onsuccess = () => {
      const np = nreq.result;
      if (np) {
        np.childIds = Array.isArray(np.childIds) ? np.childIds : [];
        if (!np.childIds.includes(folder.id)) np.childIds.unshift(folder.id);
        touch(np);
        store.put(np);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  notifySync();
  return folder;
}

/** 新建一个空的普通标签组挂在 parent 下（拖标签到文件夹时用：先建组再移入）。 */
export async function createGroupShell(parent = 'root') {
  const db = await openDB();
  const now = Date.now();
  const group = {
    id: genId(),
    type: 'group',
    groupType: 'window',
    createDate: now,
    modifyDate: now,
    parentIds: [parent],
    childIds: [],
    pinnedCount: 0,
  };
  await new Promise((resolve, reject) => {
    const tx = db.transaction('stashItems', 'readwrite');
    const store = tx.objectStore('stashItems');
    store.put(group);
    const nreq = store.get(parent);
    nreq.onsuccess = () => {
      const np = nreq.result;
      if (np) {
        np.childIds = Array.isArray(np.childIds) ? np.childIds : [];
        np.childIds.unshift(group.id);
        touch(np);
        store.put(np);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  notifySync();
  return group;
}

/** 编辑单个收纳标签的备注（导出 HTML 与复制时会带上）。 */
export async function updateTabNotes(tid, notes) {
  await updateItem(tid, (t) => {
    if (notes) t.notes = { text: notes.split('\n') }; else delete t.notes;
  });
}

/**
 * 把节点（含整棵子树）移动到指定父节点下。
 * index 为插入位置，基于「先从原位置移除后」的 childIds（0 = 顶部）；
 * tab 的插入位置不会落进置顶区（自动 clamp 到置顶计数之后），
 * 置顶项被移出时原组的 pinnedCount 自动减一；
 * 普通标签组被搬空后随之消除（文件夹/回收站根保留）。
 */
export async function moveNode(id, parent = 'root', index = 0) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('stashItems', 'readwrite');
    const store = tx.objectStore('stashItems');
    const req = store.get(id);
    req.onsuccess = () => {
      const item = req.result;
      if (!item) return;
      const oldParent = item.parentIds?.[0];
      const sameParent = oldParent === parent;
      item.parentIds = [parent];
      touch(item);
      store.put(item);
      const doomed = [];
      /** 从 childIds 移除并维护置顶计数。必须 touch：云同步按 modifyDate 判新旧。 */
      const applyRemove = (p) => {
        const oldIdx = (p.childIds || []).indexOf(id);
        p.childIds = (p.childIds || []).filter((x) => x !== id);
        if (item.type === 'tab' && oldIdx >= 0 && oldIdx < (p.pinnedCount || 0)) {
          p.pinnedCount = Math.max(0, (p.pinnedCount || 0) - 1);
        }
        touch(p);
      };
      /** 插入到 childIds 的 index 位置（tab 不进置顶区）。 */
      const applyInsert = (np) => {
        np.childIds = Array.isArray(np.childIds) ? np.childIds : [];
        np.childIds = np.childIds.filter((x) => x !== id);
        let idx = index;
        if (item.type === 'tab') idx = Math.max(idx, np.pinnedCount || 0);
        np.childIds.splice(Math.max(0, Math.min(idx, np.childIds.length)), 0, id);
        touch(np);
      };
      if (!oldParent) return;
      if (sameParent) {
        // 同一记录：一次 get 内完成移除+插入，避免两次 put 相互覆盖
        const preq = store.get(oldParent);
        preq.onsuccess = () => {
          const p = preq.result;
          if (!p) return;
          applyRemove(p);
          applyInsert(p);
          store.put(p);
        };
        return;
      }
      const preq = store.get(oldParent);
      preq.onsuccess = () => {
        const p = preq.result;
        if (!p) return;
        applyRemove(p);
        const canEliminate = p.groupType !== 'folder' && p.id !== 'trash'
          && !(p.childIds || []).length;
        if (canEliminate) {
          store.delete(p.id);
          doomed.push(p.id);
          const pid = p.parentIds?.[0];
          if (pid) {
            const gpreq = store.get(pid);
            gpreq.onsuccess = () => {
              const gp = gpreq.result;
              if (gp) {
                gp.childIds = (gp.childIds || []).filter((x) => x !== p.id);
                store.put(gp);
              }
            };
          }
        } else {
          store.put(p);
        }
      };
      const nreq = store.get(parent);
      nreq.onsuccess = () => {
        const np = nreq.result;
        if (!np) return;
        applyInsert(np);
        store.put(np);
      };
      if (doomed.length) void recordTombstones(doomed);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  notifySync();
}

/** 删除一组（锁定组拒绝）→ 移入回收站。 */
export async function moveToTrash(gid) {
  const group = await readStashItem(gid);
  if (!group || group.type !== 'group') return false;
  if (group.locked) return false;
  if (group.parentIds?.[0] === 'trash') return true;
  await moveNode(gid, 'trash');
  return true;
}

/** 从回收站恢复一组到主列表。 */
export async function restoreFromTrash(gid) {
  await moveNode(gid, 'root');
}

/** 物理删除单个标签页（记录 tombstone 供云同步传播）。 */
export async function deleteTab(tid) {
  const tab = await readStashItem(tid);
  if (!tab || tab.type !== 'tab') return;
  const gid = tab.parentIds?.[0];
  const doomed = [tid];
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('stashItems', 'readwrite');
    const store = tx.objectStore('stashItems');
    store.delete(tid);
    if (gid) {
      const greq = store.get(gid);
      greq.onsuccess = () => {
        const g = greq.result;
        if (!g) return;
        g.childIds = (g.childIds || []).filter((x) => x !== tid);
        touch(g);
        if (!g.childIds.length && g.groupType !== 'folder') {
          // 最后一个标签被删掉：普通标签组随之消除（文件夹保留）
          store.delete(gid);
          doomed.push(gid);
          const pid = g.parentIds?.[0];
          if (pid) {
            const preq = store.get(pid);
            preq.onsuccess = () => {
              const p = preq.result;
              if (p) {
                p.childIds = (p.childIds || []).filter((x) => x !== gid);
                store.put(p);
              }
            };
          }
        } else {
          store.put(g);
        }
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await recordTombstones(doomed);
  notifySync();
}

/** 物理删除一组及其整棵子树（回收站清空 / 彻底删除）。记录 tombstones。
 *  子树收集走 byParent 索引逐层查询，只读这棵树涉及的记录——
 *  百万级数据下不再"为了删一组而全表读入 Map"。
 *  删除后必须把节点从父节点的 childIds 移除：childIds 是计数与渲染的唯一
 *  依据（trashCount / childrenOf 都读它），留死引用会导致回收站数字不减、
 *  UI 缓存渲染出"有组无内容"的幽灵节点。 */
export async function deleteGroupForever(gid) {
  const group = await readStashItem(gid);
  if (!group || group.type !== 'group') return;
  const doomed = await collectSubtree(group);
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('stashItems', 'readwrite');
    const store = tx.objectStore('stashItems');
    for (const id of doomed) store.delete(id);
    // 从父节点 childIds 摘除本节点（父 = trash / root / 文件夹 / 嵌套组）。
    // 与 deleteTab 的组空自销路径保持一致：先删记录再清引用，同一事务。
    const pid = group.parentIds?.[0];
    if (pid) {
      const preq = store.get(pid);
      preq.onsuccess = () => {
        const p = preq.result;
        if (!p) return;
        p.childIds = (p.childIds || []).filter((x) => x !== gid);
        touch(p);
        store.put(p);
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await recordTombstones(doomed);
  notifySync();
}

/** 清空回收站。逐个彻底删除；收尾再显式把 trash.childIds 收敛为空——
 *  防止历史脏数据（更早版本遗留的死引用）在中途失败后仍让计数虚高。
 *  注意两点（"清空后标签还在"的根源）：
 *  1. 遍历集合 = childIds ∪ byParent 索引孤儿——历史散落记录可能没登记进
 *     childIds，只按 childIds 删会漏；
 *  2. 散落记录是单条 tab（type!=='group'），deleteGroupForever 会跳过，
 *     必须走 deleteTab。 */
export async function emptyTrash() {
  const trash = await readStashItem('trash');
  const ids = new Set(trash?.childIds || []);
  try {
    for (const r of await readStashChildren('trash')) {
      if (r?.id && r.id !== 'trash') ids.add(r.id);
    }
  } catch { /* 索引不可用：按 childIds 收敛 */ }
  for (const id of ids) {
    const item = await readStashItem(id);
    if (!item) continue;
    if (item.type === 'tab') await deleteTab(id);
    else await deleteGroupForever(id);
  }
  // 收尾：trash 的 childIds 只应包含真实存在的节点
  const cur = await readStashItem('trash');
  if (cur && (cur.childIds || []).length) {
    const alive = new Set(await readStashItems(cur.childIds).then((rs) => rs.filter(Boolean).map((r) => r.id)));
    const next = (cur.childIds || []).filter((id) => alive.has(id));
    if (next.length !== (cur.childIds || []).length) {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('stashItems', 'readwrite');
        const store = tx.objectStore('stashItems');
        cur.childIds = next;
        touch(cur);
        store.put(cur);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  }
}
