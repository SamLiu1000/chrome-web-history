// 标签页保险的存储层：实时镜像 + "未正常关闭"存档组。
// 必须用 chrome.storage.local（持久），不能用 storage.session——
// 镜像的价值恰恰在于浏览器崩溃后还能读到。
// service worker 与 dashboard 页面共用本模块。

export const MIRROR_KEY = 'whTabMirror';        // { synced, tabs: [{tabId, windowId, url, title, pinned, at}] }
export const CRASH_KEY = 'whCrashGroups';       // [{ id, at, tabs: [{url, title, pinned}] }]
export const SESSION_FLAG_KEY = 'whSessionOpen'; // true = 本次浏览器会话尚未正常收尾

export async function readMirror() {
  const got = await chrome.storage.local.get(MIRROR_KEY);
  const m = got[MIRROR_KEY];
  return (m && Array.isArray(m.tabs)) ? m : { synced: false, tabs: [] };
}

export async function writeMirror(mirror) {
  await chrome.storage.local.set({ [MIRROR_KEY]: mirror });
}

export async function readCrashGroups() {
  const got = await chrome.storage.local.get(CRASH_KEY);
  const g = got[CRASH_KEY];
  return Array.isArray(g) ? g : [];
}

export async function writeCrashGroups(groups) {
  await chrome.storage.local.set({ [CRASH_KEY]: groups });
}

export async function readSessionFlag() {
  const got = await chrome.storage.local.get(SESSION_FLAG_KEY);
  return got[SESSION_FLAG_KEY] === true;
}

export async function writeSessionFlag(v) {
  await chrome.storage.local.set({ [SESSION_FLAG_KEY]: v });
}
