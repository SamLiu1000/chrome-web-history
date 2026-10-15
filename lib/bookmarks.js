// 浏览器书签封装：收藏直接使用 Chrome 自带书签（manifest 需 bookmarks 权限），
// 不再在 IndexedDB 里单独维护收藏状态。

/** 全部已收藏网址集合（批量判断用，书签数量通常不大）。 */
export async function getBookmarkedUrlSet() {
  const all = await chrome.bookmarks.search({});
  return new Set(all.filter((b) => b.url).map((b) => b.url));
}

export async function isBookmarked(url) {
  const hits = await chrome.bookmarks.search({ url });
  return hits.some((b) => b.url === url);
}

/**
 * 列出全部书签文件夹（平铺，带层级路径，如"书签栏/工作"），对话框选存放位置用。
 */
export async function getBookmarkFolders() {
  const tree = await chrome.bookmarks.getTree();
  const out = [];
  const walk = (nodes, path) => {
    for (const n of nodes) {
      if (n.url) continue; // 书签项跳过，只看文件夹
      const isRoot = n.id === '0';
      const p = isRoot ? '' : (path ? `${path}/${n.title}` : n.title);
      if (!isRoot) out.push({ id: n.id, title: p || n.title });
      if (n.children) walk(n.children, p);
    }
  };
  walk(tree, '');
  return out;
}

/** 从浏览器书签移除某网址（全部匹配项）。 */
export async function removeBrowserBookmark(url) {
  const hits = (await chrome.bookmarks.search({ url })).filter((b) => b.url === url);
  for (const b of hits) {
    try { await chrome.bookmarks.remove(b.id); } catch { /* 已被其它入口移除则忽略 */ }
  }
}

// ---------------------------------------------------------------- 原始添加时间映射
//
// Chrome 的 bookmarks.create 不接受 dateAdded（参数白名单只有
// index/parentId/title/url），也没有任何 API 能改它——云端快照恢复到本机后，
// Chrome 给重建节点的添加时间只能是"恢复那一刻"。
// 本映射把云端快照里的原始时间记在 chrome.storage.local，供本扩展内部
// （书签 HTML 导出的 ADD_DATE、云同步快照与版本号）使用；Chrome 自带书签
// 管理器里显示什么时间则随它去（显示的是 Chrome 的真实字段）。
//
// 键控：书签节点按 url（'u:' + url）；文件夹按从根到该节点的标题路径
// （'f:' + path，'›' 连接）。文件夹无 url，路径键在同构树里足够稳定。

const BM_TIME_OVERRIDES_KEY = 'whBmTimeOverrides';
const BM_TIME_MAX = 8000;

async function loadBmTimeOverrides() {
  const got = await chrome.storage.local.get(BM_TIME_OVERRIDES_KEY);
  const m = got[BM_TIME_OVERRIDES_KEY];
  return (m && typeof m === 'object') ? m : {};
}

async function saveBmTimeOverrides(map) {
  // 上限裁剪：保留时间戳较大的（较可能是近期仍存在的原始数据）
  const entries = Object.entries(map).sort((a, b) => (b[1] || 0) - (a[1] || 0)).slice(0, BM_TIME_MAX);
  await chrome.storage.local.set({ [BM_TIME_OVERRIDES_KEY]: Object.fromEntries(entries) });
}

/** 从一棵树（云端快照的整树，节点带原始 dateAdded）记录原始时间映射。 */
export async function recordBookmarkTimeOverrides(tree) {
  try {
    const map = await loadBmTimeOverrides();
    const walk = (nodes, path) => {
      for (const n of nodes || []) {
        const p = path ? `${path} › ${n.title || ''}` : (n.title || '');
        if (n.url) map['u:' + n.url] = n.dateAdded || 0;
        else map['f:' + p] = n.dateAdded || 0;
        if (n.children) walk(n.children, p);
      }
    };
    walk(tree, '');
    await saveBmTimeOverrides(map);
  } catch { /* 记录失败只影响本扩展内的时间展示，不抛出 */ }
}

/** 把映射应用到一棵树（就地浅拷贝替换 dateAdded）。返回新数组。 */
export async function applyBookmarkTimeOverrides(nodes) {
  const map = await loadBmTimeOverrides();
  const walk = (list, path) => (list || []).map((n) => {
    const p = path ? `${path} › ${n.title || ''}` : (n.title || '');
    const ov = n.url ? map['u:' + n.url] : map['f:' + p];
    const out = ov ? { ...n, dateAdded: ov } : { ...n };
    if (n.children) out.children = walk(n.children, p);
    return out;
  });
  return walk(nodes, '');
}
