// 总备份：把本程序管理的四类数据（浏览历史 / 标签收纳 / 书签 / 意外关闭存档）
// 打包成一个 JSON 文件，或从一个这样的文件整体恢复。
// 文件格式（kind: 'full-backup'）：
//   history    —— exportAll() 的原样输出（visits/urls/websites/settings）
//   stash      —— buildStashJSON() 的原样输出（onetap-full-backup 格式）
//   bookmarks  —— { version, tree }（与云同步快照同构；dateAdded 为原始时间映射后的值）
//   crashGroups —— whCrashGroups 数组
// 各类数据内部结构不重新发明，导入时逐类走各自既有的入口。

import { exportAll } from './db.js';
import { importJSON } from './io.js';
import { buildStashJSON, parseStashJSON } from './stash-export.js';
import { importAll, replaceLocalBookmarks } from './d1-sync.js';
import { readCrashGroups, writeCrashGroups } from './tab-guard.js';
import { applyBookmarkTimeOverrides } from './bookmarks.js';

/** 书签树版本（与 d1-sync 的 treeVersion 同口径：树内最大时间戳）。 */
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

// ---------------------------------------------------------------- 导出

export async function buildFullBackup({ onProgress = null } = {}) {
  onProgress?.('history');
  const history = await exportAll();
  onProgress?.('stash');
  const stash = JSON.parse(await buildStashJSON());
  onProgress?.('bookmarks');
  const tree = await applyBookmarkTimeOverrides(
    (await chrome.bookmarks.getTree())[0]?.children || []);
  const bookmarks = { version: treeVersion(tree), tree };
  onProgress?.('crash');
  const crashGroups = await readCrashGroups();
  return {
    app: 'web-history-archive',
    kind: 'full-backup',
    v: 1,
    exportedAt: new Date().toISOString(),
    counts: {
      visits: history.counts?.visits || 0,
      stashTabs: (stash.items || []).filter((i) => i?.type === 'tab').length,
      bookmarks: countBookmarkNodes(tree),
      crashGroups: crashGroups.length,
    },
    history,
    stash,
    bookmarks,
    crashGroups,
  };
}

function countBookmarkNodes(nodes) {
  let n = 0;
  for (const x of nodes || []) {
    if (x.url) n++;
    if (x.children) n += countBookmarkNodes(x.children);
  }
  return n;
}

// ---------------------------------------------------------------- 导入

/** 书签合并：把备份整树挂到书签栏下新建的"导入的书签 <时间>"文件夹
 *  （与 HTML 导入同一落点语义，绝不动现有书签）。返回创建的节点数。 */
async function importBookmarksMerge(tree) {
  const roots = (await chrome.bookmarks.getTree())[0]?.children || [];
  const bar = roots.find((r) => r.title === '书签栏' || r.title === 'Bookmarks bar') || roots[0];
  if (!bar) throw new Error('找不到书签栏根节点');
  const stamp = new Date().toISOString().slice(0, 10);
  const folder = await chrome.bookmarks.create({
    parentId: bar.id, title: `导入的书签 ${stamp}`,
  });
  let created = 0;
  const createAll = async (parentId, nodes) => {
    for (const n of nodes || []) {
      const c = await chrome.bookmarks.create({
        parentId,
        title: n.title || '',
        ...(n.url ? { url: n.url } : {}),
      });
      created++;
      if (n.children) await createAll(c.id, n.children);
    }
  };
  // 备份树的顶层是"书签栏/其他书签"等常驻根，把它们的 children 挂进新文件夹
  for (const top of tree || []) await createAll(folder.id, top.children);
  return created;
}

/**
 * 从总备份文件恢复。
 * mode = 'merge'：浏览历史合并去重、标签收纳整包替换（既有语义）、书签挂进
 *                 新建文件夹、存档组按 id 并集——不动现有书签。
 * mode = 'overwrite'：浏览历史先清空再导入、标签收纳整包替换、书签整树替换、
 *                 存档组整包覆盖——一切以备份文件为准。
 * onProgress(step, detail) 用于界面状态显示。
 */
export async function importFullBackup(jsonText, {
  mode = 'merge', onProgress = null, sendD1 = null,
} = {}) {
  let dump;
  try {
    dump = JSON.parse(jsonText);
  } catch (e) {
    throw new Error('不是有效的 JSON 文件：' + e.message);
  }
  if (!dump || dump.kind !== 'full-backup' || dump.app !== 'web-history-archive') {
    throw new Error('这不是「总备份」文件（缺少 kind: full-backup 标记）。'
      + '各类数据的单类备份请用对应栏目各自的导入入口。');
  }
  const result = {};

  // 1. 浏览历史（exportAll 的原样结构，直接复用 importJSON 的校验与写入）
  if (dump.history?.data) {
    onProgress?.('history', '导入浏览历史…');
    const hr = await importJSON(JSON.stringify(dump.history), { mode });
    result.history = hr;
  }

  // 2. 标签收纳（整包替换语义，与单类导入一致）
  if (dump.stash) {
    onProgress?.('stash', '导入标签收纳…');
    const items = parseStashJSON(JSON.stringify(dump.stash));
    if (sendD1) {
      const r = await sendD1({ type: 'd1SyncImport', items });
      if (!r.ok) throw new Error('标签收纳导入失败：' + (r.error || '未知错误'));
      result.stash = { count: items.length };
    }
  }

  // 3. 书签
  if (dump.bookmarks?.tree?.length) {
    onProgress?.('bookmarks', '导入书签…');
    if (mode === 'overwrite') {
      const stat = await replaceLocalBookmarks(dump.bookmarks.tree);
      result.bookmarks = { mode, created: stat.created, removed: stat.removed, failed: stat.failed };
    } else {
      result.bookmarks = { mode, created: await importBookmarksMerge(dump.bookmarks.tree) };
    }
  }

  // 4. 意外关闭存档组
  if (Array.isArray(dump.crashGroups)) {
    onProgress?.('crash', '导入意外关闭存档…');
    if (mode === 'overwrite') {
      await writeCrashGroups(dump.crashGroups);
      result.crash = { count: dump.crashGroups.length };
    } else {
      // 按 id 取并集（与云同步的合并语义一致：组冻结后不可变）
      const local = await readCrashGroups();
      const map = new Map(local.map((g) => [g.id, g]));
      let added = 0;
      for (const g of dump.crashGroups) {
        if (g && g.id != null && !map.has(g.id)) { map.set(g.id, g); added++; }
      }
      if (added) await writeCrashGroups([...map.values()]);
      result.crash = { count: local.length + added, added };
    }
  }

  return result;
}
