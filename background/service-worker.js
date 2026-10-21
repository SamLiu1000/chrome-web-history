// 后台记录核心（MV3 service worker，随时休眠、事件唤醒）。
//
// 记录路径：chrome.history.onVisited —— Chrome 内核保证每次真实导航恰好触发一次，
//   提供 url / title / 精确 visitTime / transition(访问行为)。
// tab 归属：tabs.onUpdated 维护 tabId -> url 映射，onVisited 时按 url + 时间就近匹配
//   （后台预渲染等无 tab 场景记 tabId=null，属"尽力而为"的辅助信息）。

import { initSchema, getSetting, addVisit, applyObservedTitle } from '../lib/db.js';
import { extractDomain, isValidUrl, ensureStoragePersisted } from '../lib/util.js';
import { noteLocalChange, noteStartupBackup } from '../lib/local-backup.js';
import { stashWindowTabs } from '../lib/stash.js';
import {
  readMirror, writeMirror, readCrashGroups, writeCrashGroups,
  readSessionFlag, writeSessionFlag,
} from '../lib/tab-guard.js';
import { initD1Sync, handleD1Message, noteChange } from '../lib/d1-sync.js';

// ------------------------------------------------ 垂直标签栏（Side Panel 接管）
//
// 点击工具栏图标：打开历史记录浏览页。
// 右键图标菜单：单个开关切换垂直标签栏（开启 = 打开侧栏并接管，关闭 = 收起侧栏）、
//   打开历史记录。开关状态存 chrome.storage.local，跨浏览器重启保留。
// 侧栏也能用 Chrome 自带的 × 收起（这不算"关闭接管"，从菜单再开即可）。

// 主界面（含收纳标签页/历史记录/实时/设置四个页签），默认落在"收纳标签页"
const DASHBOARD_URL = chrome.runtime.getURL('pages/dashboard.html#stash');

// 点扩展图标 = 打开主界面（首屏落在收纳标签页，启动链路已按轻量页同款优化：
// 全量 modulepreload + 收纳快照并行预读，见 pages/dashboard.html）
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: DASHBOARD_URL });
});

const MENU_VTABS_TOGGLE = 'wh-vtabs-toggle';
const MENU_DASH = 'wh-open-dashboard';
const MENU_STASH_ACTIVE = 'wh-stash-active';
const MENU_STASH_LEFT = 'wh-stash-left';
const MENU_STASH_RIGHT = 'wh-stash-right';
const MENU_STASH_ALL = 'wh-stash-all';
const VTABS_KEY = 'vtabsOn';

let vtabsOn = true;

async function loadVtabsOn() {
  try {
    const got = await chrome.storage.local.get(VTABS_KEY);
    if (typeof got[VTABS_KEY] === 'boolean') vtabsOn = got[VTABS_KEY];
  } catch { /* 读不到时按默认开启 */ }
}

function toggleTitle() {
  return vtabsOn ? '关闭垂直标签栏' : '开启垂直标签栏';
}

function refreshToggleTitle() {
  chrome.contextMenus.update(MENU_VTABS_TOGGLE, { title: toggleTitle() },
    () => void chrome.runtime.lastError); // 菜单尚未创建时静默忽略
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    // 快捷收纳：以打开的插件标签页为基点，只收本窗口（含浏览器自带页面，收完自动关闭）
    chrome.contextMenus.create({ id: MENU_STASH_ACTIVE, title: '收纳当前标签页', contexts: ['action'] });
    chrome.contextMenus.create({ id: MENU_STASH_LEFT, title: '收纳左侧所有标签页', contexts: ['action'] });
    chrome.contextMenus.create({ id: MENU_STASH_RIGHT, title: '收纳右侧所有标签页', contexts: ['action'] });
    chrome.contextMenus.create({ id: MENU_STASH_ALL, title: '收纳全部标签页（本窗口）', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'wh-stash-sep', type: 'separator', contexts: ['action'] });
    chrome.contextMenus.create({ id: MENU_VTABS_TOGGLE, title: toggleTitle(), contexts: ['action'] });
    chrome.contextMenus.create({ id: MENU_DASH, title: '打开历史记录', contexts: ['action'] });
  });
}

const STASH_MENU_MODES = {
  [MENU_STASH_ACTIVE]: 'active',
  [MENU_STASH_LEFT]: 'left',
  [MENU_STASH_RIGHT]: 'right',
  [MENU_STASH_ALL]: 'all',
};

/** 收纳基点：已打开的历史记录标签页（优先点击菜单所在窗口里的那个）；没开插件页则用点击所在窗口的活动标签。 */
async function stashPivot(tab, clickWindowId) {
  const dashUrl = chrome.runtime.getURL('pages/dashboard.html');
  let extTabs = [];
  try { extTabs = await chrome.tabs.query({ url: dashUrl + '*' }); } catch { /* 忽略 */ }
  if (extTabs.length) {
    const pivotTab = extTabs.find((t) => t.windowId === clickWindowId) || extTabs[0];
    return { windowId: pivotTab.windowId, pivotIndex: pivotTab.index };
  }
  if (tab?.windowId != null) {
    return { windowId: tab.windowId, pivotIndex: tab.index ?? -1 };
  }
  try {
    const w = await chrome.windows.getLastFocused();
    const act = await chrome.tabs.query({ windowId: w.id, active: true });
    return { windowId: w.id, pivotIndex: act[0]?.index ?? -1 };
  } catch { return null; }
}

async function stashFromMenu(menuId, tab) {
  const mode = STASH_MENU_MODES[menuId];
  let opts = null;
  if (mode === 'all') {
    // 收纳全部不分左右：不需要插件页基点，直接收右键所在窗口的全部标签页
    let windowId = tab?.windowId;
    if (windowId == null) {
      try { windowId = (await chrome.windows.getLastFocused()).id; } catch { windowId = null; }
    }
    if (windowId != null) opts = { windowId, mode };
  } else {
    const pivot = await stashPivot(tab, tab?.windowId);
    if (pivot) opts = { ...pivot, mode };
  }
  if (!opts) return;
  await stashWindowTabs(opts);
  // 已打开的标签收纳页即时刷新（页面监听 d1SyncUpdated 重绘）
  chrome.runtime.sendMessage({ type: 'd1SyncUpdated' }, () => void chrome.runtime.lastError);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (STASH_MENU_MODES[info.menuItemId]) {
    stashFromMenu(info.menuItemId, tab)
      .catch((e) => console.warn('[历史记录] 快捷收纳失败', e));
  } else if (info.menuItemId === MENU_VTABS_TOGGLE) {
    vtabsOn = !vtabsOn;
    chrome.storage.local.set({ [VTABS_KEY]: vtabsOn }).catch(() => {});
    refreshToggleTitle();
    if (vtabsOn) {
      if (tab && tab.windowId != null) {
        // sidePanel.open 必须在用户手势的同步调用栈内发起：前面不能 await
        // 其他 API，否则手势失效、open 报错。setOptions 只发起不等待。
        chrome.sidePanel.setOptions({ enabled: true }).catch(() => {});
        chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => {
          console.warn('[历史记录] 打开垂直标签栏失败', e);
        });
      }
    } else {
      chrome.sidePanel.setOptions({ enabled: false })
        .catch((e) => console.warn('[历史记录] 关闭垂直标签栏失败', e));
    }
  } else if (info.menuItemId === MENU_DASH) {
    chrome.tabs.create({ url: DASHBOARD_URL });
  }
});

// SW 冷启动：菜单是持久注册的，只需按存储里的状态校正标题
loadVtabsOn().then(refreshToggleTitle).catch(() => {});

const SESSION_KEY = 'whTrackerState';

let state = {
  tabMeta: {}, // tabId -> { url, windowId, at }（访问归属用的最近导航信息）
};
let stateLoaded = false;
let prefs = { recordEnabled: true };

// ---------------------------------------------------------------- session 状态

async function ensureLoaded() {
  if (stateLoaded) return;
  try {
    const got = await chrome.storage.session.get(SESSION_KEY);
    if (got[SESSION_KEY] && typeof got[SESSION_KEY] === 'object') state = got[SESSION_KEY];
  } catch (e) {
    console.warn('[历史记录] 读取 session 状态失败，使用空状态', e);
  }
  stateLoaded = true;
}

async function saveState() {
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: state });
  } catch (e) {
    console.warn('[历史记录] 写入 session 状态失败', e);
  }
}

// ---------------------------------------------------------------- 访问记录

function findTabForUrl(url, now) {
  let best = null;
  for (const [tabId, meta] of Object.entries(state.tabMeta)) {
    if (meta.url !== url) continue;
    const age = now - (meta.at || 0);
    if (age > 10_000) continue; // 太久之前的匹配不可信
    if (!best || age < best.age) best = { tabId: Number(tabId), ...meta, age };
  }
  return best;
}

async function handleVisited(item) {
  await ensureLoaded();
  if (!prefs.recordEnabled) return;
  if (!item || !isValidUrl(item.url)) return;

  const now = Date.now();
  const meta = findTabForUrl(item.url, now);
  const r = await addVisit({
    urlId: item.url,
    websiteId: extractDomain(item.url),
    title: item.title || '',
    visitedAt: item.lastVisitTime,
    transition: item.transition || 'link',
    tabId: meta ? meta.tabId : null,
    windowId: meta ? meta.windowId : null,
    source: 'extension',
  });

  if (r.added && r.id && meta) {
    await saveState();
  }
}

// ---------------------------------------------------------------- 标签页保险：实时镜像 + 崩溃存档
//
// 实时镜像：持久镜像当前打开的全部标签页（含固定标签），随开随记、随关随删。
//   存 chrome.storage.local（区别于上方 storage.session 的会话态：镜像必须跨浏览器
//   重启存活）。会话首次同步用 tabs.query 全量校正，之后由 tab 事件增量维护。
// 崩溃判定：chrome.runtime.onStartup（浏览器启动）时若"会话未收尾"标记还在，
//   说明上次没有走到"最后一个窗口关闭"的收尾（崩溃/断电/被强杀），把镜像冻结成
//   一组存入"未正常关闭"存档；存档只在用户手动删除时才会消失。
// 正常收尾：正常退出时每个标签逐一 tabs.onRemoved（镜像自然清空），最后一个
//   窗口关闭时撤销标记。下次启动标记不在 → 不产生存档，镜像被全量同步覆盖。

let mirror = { synced: false, tabs: [] };
let mirrorLoaded = false;
let sessionOpen = null; // null = 尚未从 storage 读过
// SW 本次醒来首次读到的镜像/标记快照。崩溃重启时 Chrome 的恢复流程会在
// onStartup 派发之前产生一小波标签/窗口事件（占位窗口替换），它们会改写
// mirror 甚至把"未收尾"标记抹成 false——崩溃判定必须看这个不受污染的快照。
let bootSnapshot = null;

async function ensureMirrorLoaded() {
  if (mirrorLoaded) return;
  try {
    mirror = await readMirror();
    sessionOpen = await readSessionFlag();
  } catch (e) {
    console.warn('[历史记录] 读取标签页镜像失败', e);
  }
  mirrorLoaded = true;
  if (!bootSnapshot) {
    bootSnapshot = { tabs: (mirror.tabs || []).slice(), sessionOpen, at: Date.now() };
  }
}

async function persistMirror() {
  try {
    await writeMirror(mirror);
  } catch (e) {
    console.warn('[历史记录] 写入标签页镜像失败', e);
  }
}

async function ensureSessionMarkedOpen() {
  // "后台运行"模式下重开窗口不会触发 onStartup，这里兜底补标记
  if (sessionOpen !== true) {
    sessionOpen = true;
    await writeSessionFlag(true);
  }
}

async function upsertMirrorTab(tab) {
  await ensureMirrorLoaded();
  if (!tab || tab.id == null) return;
  const i = mirror.tabs.findIndex((t) => t.tabId === tab.id);
  const entry = {
    tabId: tab.id,
    windowId: tab.windowId ?? null,
    url: tab.url || tab.pendingUrl || (i >= 0 ? mirror.tabs[i].url : '') || '',
    title: tab.title || (i >= 0 ? mirror.tabs[i].title : '') || '',
    pinned: !!tab.pinned,
    at: Date.now(),
  };
  if (i >= 0) mirror.tabs[i] = entry; else mirror.tabs.push(entry);
  await ensureSessionMarkedOpen();
  await persistMirror();
}

async function removeMirrorTab(tabId) {
  await ensureMirrorLoaded();
  const n = mirror.tabs.length;
  mirror.tabs = mirror.tabs.filter((t) => t.tabId !== tabId);
  if (mirror.tabs.length !== n) await persistMirror();
}

async function removeMirrorWindow(windowId) {
  await ensureMirrorLoaded();
  const n = mirror.tabs.length;
  mirror.tabs = mirror.tabs.filter((t) => t.windowId !== windowId);
  if (mirror.tabs.length !== n) await persistMirror();
}

/** 全量同步：镜像 = 当前真实标签页（校正启动初期的遗漏）。 */
async function syncMirrorNow() {
  try {
    const tabs = await chrome.tabs.query({});
    await ensureMirrorLoaded();
    mirror.tabs = tabs.map((t) => ({
      tabId: t.id,
      windowId: t.windowId ?? null,
      url: t.url || t.pendingUrl || '',
      title: t.title || '',
      pinned: !!t.pinned,
      at: Date.now(),
    }));
    mirror.synced = true;
    await persistMirror();
  } catch (e) {
    console.warn('[历史记录] 标签页全量同步失败', e);
  }
}

async function ensureMirrorSynced() {
  await ensureMirrorLoaded();
  if (!mirror.synced) {
    mirror.synced = true; // 先置位防重入，失败时下次会话同步会再校正
    await persistMirror();
    await syncMirrorNow();
  }
}

/** 浏览器启动：判定上次会话是否异常关闭，是则把镜像冻结为存档组。
 *  判定与冻结都基于 bootSnapshot（SW 醒来首次读到的持久数据）——
 *  启动抖动事件（占位窗口关闭/新标签事件）只改 mirror 和 sessionOpen，
 *  碰不到快照，因此 onStartup 晚到 2~3 秒也不影响判定。 */
async function handleStartupSession() {
  await ensureMirrorLoaded();
  const snap = bootSnapshot || { tabs: (mirror.tabs || []).slice(), sessionOpen };
  const prevTabs = snap.tabs || [];
  if (snap.sessionOpen === true && prevTabs.length) {
    const seen = new Set();
    const frozen = [];
    for (const t of prevTabs) {
      if (!t.url || !isValidUrl(t.url) || seen.has(t.url)) continue;
      seen.add(t.url);
      frozen.push({ url: t.url, title: t.title || '', pinned: !!t.pinned });
    }
    if (frozen.length) {
      try {
        const groups = await readCrashGroups();
        groups.unshift({ id: Date.now(), at: Date.now(), tabs: frozen });
        await writeCrashGroups(groups);
      } catch (e) {
        console.warn('[历史记录] 写入未正常关闭存档失败', e);
      }
    }
  }
  // 新会话：清空镜像重新积累，等 3 秒（等会话恢复的标签页就位）后全量校正
  mirror = { synced: false, tabs: [] };
  await persistMirror();
  sessionOpen = true;
  await writeSessionFlag(true);
  setTimeout(() => { ensureMirrorSynced().catch(() => {}); }, 3000);
}

// 浏览器启动标志：onStartup 监听器同步置位，必须抢在冷启动兜底的
// 全量同步之前——否则同步会用当前标签页覆盖掉崩溃前的镜像，存档就丢了
let startupSeen = false;

chrome.tabs.onCreated.addListener((tab) => {
  upsertMirrorTab(tab).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title || changeInfo.pinned != null) {
    upsertMirrorTab(tab).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeMirrorTab(tabId).catch(() => {});
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  (async () => {
    await removeMirrorTab(removedTabId);
    try {
      const t = await chrome.tabs.get(addedTabId);
      await upsertMirrorTab(t);
    } catch { /* 新 tab 已关等场景，忽略 */ }
  })().catch(() => {});
});

// 设置页/标签页保险页请求即时校正镜像（打开保险页时全量同步一次）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'mirror-resync') {
    syncMirrorNow().catch(() => {});
  }
});


chrome.history.onVisited.addListener((item) => {
  handleVisited(item).catch((e) => console.error('[历史记录] 记录访问失败', e));
});

chrome.tabs.onCreated.addListener((tab) => {
  ensureLoaded().then(async () => {
    if (tab && tab.id != null) {
      state.tabMeta[tab.id] = { url: tab.url || tab.pendingUrl || '', windowId: tab.windowId, at: Date.now() };
      await saveState();
    }
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  ensureLoaded().then(async () => {
    if (!state.tabMeta[tabId]) {
      state.tabMeta[tabId] = { url: '', windowId: tab.windowId, at: 0 };
    }
    const meta = state.tabMeta[tabId];
    meta.windowId = tab.windowId;

    const newUrl = changeInfo.url || (tab.url && !meta.url ? tab.url : null);
    if (newUrl && newUrl !== meta.url) {
      meta.url = newUrl;
      meta.at = Date.now();
    }
    if (changeInfo.title && meta.url && isValidUrl(meta.url) && changeInfo.title.length <= 1024) {
      await applyObservedTitle(meta.url, null, changeInfo.title);
    }
    await saveState();
  }).catch((e) => console.warn('[历史记录] 处理 tab 更新失败', e));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ensureLoaded().then(async () => {
    delete state.tabMeta[tabId];
    await saveState();
  }).catch(() => {});
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  // 标签页保险：清掉该窗口的镜像条目；最后一个窗口关闭 = 正常收尾，撤销会话标记
  await removeMirrorWindow(windowId).catch(() => {});
  try {
    const wins = await chrome.windows.getAll();
    if (!wins.length) {
      sessionOpen = false;
      await writeSessionFlag(false);
      // 收尾时主动清空镜像：不再只靠各标签 tabs.onRemoved 碰巧都写盘成功。
      // 若只靠自然清空，退出瞬间写盘不完整会残留镜像——下次启动又碰上标记
      // 写丢，就会被误冻结成假存档。清空 + 写 false 是同一次持久化语义。
      mirror.tabs = [];
      mirror.synced = true;
      await persistMirror();
    }
  } catch { /* 查询失败不影响主流程 */ }
});

// ---------------------------------------------------------------- 初始化

async function reloadPrefs() {
  prefs.recordEnabled = await getSetting('recordEnabled', true);
}

async function init() {
  await initSchema();
  // 申请持久化存储：否则 IndexedDB 是 best-effort，磁盘紧张/定期维护时会被
  // Chrome 整库自动清除（"数据突然全部消失"的根因），unlimitedStorage 不豁免驱逐
  ensureStoragePersisted().catch(() => {});
  await reloadPrefs();
  await ensureLoaded();
  // D1 同步：注册 alarm 与启动定时器（未配置时 runSync 会自行跳过）
  await initD1Sync();
  // 本地磁盘备份每日兜底（未选择备份文件夹时静默跳过）
  noteStartupBackup().catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  loadVtabsOn().then(createMenus).catch(createMenus);
  init().then(() => syncMirrorNow()).catch((e) => console.error('[历史记录] 初始化失败', e));
});
chrome.runtime.onStartup.addListener(() => {
  startupSeen = true;
  init()
    .then(() => handleStartupSession())
    .catch((e) => console.error('[历史记录] 启动初始化失败', e));
});

// SW 冷启动兜底（onInstalled/onStartup 只在安装和浏览器启动时触发，
// 平时 SW 休眠后被事件唤醒需要自行完成初始化）。
// 浏览器启动场景下首次同步由 handleStartupSession 负责，这里跳过，
// 避免把崩溃前待冻结的镜像提前覆盖掉。
init().then(() => { if (!startupSeen) return ensureMirrorSynced(); })
  .catch((e) => console.error('[历史记录] 冷启动初始化失败', e));

// 设置页修改偏好后通知这里刷新缓存
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'prefs-changed') {
    init().catch(() => {});
  }
});

// ---------------------------------------------------------------- D1 云同步
//
// 标签收纳数据在页面上下文写库后会发 d1SyncChanged（历史版本曾借此自动同步，
// 现自动同步已移除，noteChange 为空实现，保留消息通道做兼容）。
// d1Sync* 开头的消息（配置/手动同步/快照管理/合并快照/完整导出导入）转给 d1-sync 模块处理。

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'd1SyncChanged') {
    noteChange();
    // 收纳数据变更 → 本地磁盘备份防抖（选了备份文件夹才生效）
    noteLocalChange();
    return;
  }
  if (String(msg.type).startsWith('d1Sync')) {
    handleD1Message(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步应答
  }
});
