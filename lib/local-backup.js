// 本地磁盘自动备份（File System Access API）。
//
// 背景：IndexedDB 是"可被清理"的存储——Chrome「清除 Cookie 及站点数据」、
// CCleaner 类清理工具、磁盘满自动驱逐都可能把它整库删掉（真实发生过）。
// 云同步是一层保险；本模块是第二层：把标签收纳数据定期写到用户指定的
// 本地文件夹（浏览器管理范围之外，任何清理都碰不到）。
//
// 浏览器限制与对策：
// - 扩展不能写任意磁盘路径：用 showDirectoryPicker 让用户选一次文件夹，
//   句柄（FileSystemDirectoryHandle）存进独立的小 IndexedDB（不动主库版本）。
// - 文件夹授权在浏览器重启后可能回到 prompt 态：状态接口暴露权限值，
//   设置页显示「重新授权」按钮（requestPermission 必须在用户手势中调用）。
//   Chrome 122+ 用户也可在地址栏权限图标选"每次访问时允许"长期授权。
// - "浏览器退出时询问"做不到（MV3 无退出拦截）：改为三路触发——
//   ① 变更后防抖 10 分钟（noteLocalChange，SW 里经 d1SyncChanged 调用）；
//   ② 每次打开插件页面补写（maybeBackupOnOpen，限流 1 小时一次）；
//   ③ 每日兜底（initD1Sync 时机设 alarm，距上次备份超 24h 才触发）。
//   最坏丢失窗口 = 10 分钟，且写入用 createWritable（临时文件写完才原子
//   替换旧备份，写一半断电也不损上一份）。

import { buildStashJSON } from './stash-export.js';
import { buildFullBackup } from './full-backup.js';

const HANDLE_DB = 'web-history-fs-backup';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'dir';
export const BACKUP_ALARM = 'localBackupAlarm';
export const FULL_BACKUP_ALARM = 'localFullBackupAlarm';
// 两个文件都是 kind:'full-backup' 格式——设置页「总备份 → 导入总备份」
// 选哪个都能直接恢复，无需专门的恢复入口：
//   web-history-backup.json       高频（收纳 + 书签，无历史，几秒内写完）
//   web-history-full-backup.json  完整（含浏览历史，大文件，每天/手动一次）
const BACKUP_FILENAME = 'web-history-backup.json';
const FULL_BACKUP_FILENAME = 'web-history-full-backup.json';
const STATE_KEY = 'localBackupState';
const DEBOUNCE_MINUTES = 10;   // 变更后防抖
const OPEN_THROTTLE_MS = 60 * 60 * 1000;  // 页面打开补写限流
const DAILY_FALLBACK_MS = 24 * 60 * 60 * 1000; // 完整备份兜底阈值

function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(HANDLE_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveHandle(handle) {
  const db = await openHandleDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getBackupDirHandle() {
  try {
    const db = await openHandleDB();
    const h = await new Promise((resolve, reject) => {
      const req = db.transaction(HANDLE_STORE).objectStore(HANDLE_STORE).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return h;
  } catch { return null; }
}

async function clearHandle() {
  const db = await openHandleDB();
  await new Promise((resolve) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).delete(HANDLE_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => resolve();
  });
  db.close();
}

function setState(patch) {
  return chrome.storage.local.get(STATE_KEY).then((s) =>
    chrome.storage.local.set({ [STATE_KEY]: Object.assign({}, s[STATE_KEY] || {}, patch) }));
}

async function getState() {
  const s = await chrome.storage.local.get(STATE_KEY);
  return s[STATE_KEY] || {};
}

/** 用户选择备份文件夹（必须在页面用户手势中调用，如按钮 click）。 */
export async function pickBackupDir() {
  if (typeof window === 'undefined' || !window.showDirectoryPicker) {
    return { ok: false, error: '当前环境不支持文件夹选择（showDirectoryPicker 不可用）' };
  }
  try {
    const handle = await window.showDirectoryPicker({ id: 'whLocalBackup', mode: 'readwrite' });
    await saveHandle(handle);
    await setState({ lastError: null });
    return { ok: true, dirName: handle.name };
  } catch (e) {
    if (e && (e.name === 'AbortError')) return { ok: false, cancelled: true };
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 解除绑定的备份文件夹。 */
export async function clearBackupDir() {
  await clearHandle();
  await setState({ lastError: null });
}

/** 当前状态（设置页渲染用）。 */
export async function getBackupState() {
  const handle = await getBackupDirHandle();
  const st = await getState();
  let permission = null;
  if (handle) {
    try { permission = await handle.queryPermission({ mode: 'readwrite' }); }
    catch { permission = 'denied'; }
  }
  return {
    dirName: handle ? handle.name : null,
    permission,
    lastBackup: st.lastBackup || 0,
    lastFullBackup: st.lastFullBackup || 0,
    lastError: st.lastError || null,
  };
}

/** 重新授权（必须用户手势；浏览器重启后权限回到 prompt 时用）。 */
export async function requestBackupPermission() {
  const handle = await getBackupDirHandle();
  if (!handle) return { ok: false, error: '尚未选择备份文件夹' };
  try {
    const p = await handle.requestPermission({ mode: 'readwrite' });
    return { ok: p === 'granted', permission: p };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 通用写盘：在备份文件夹内原子替换写入一个 JSON 文件。 */
async function writeFile(handle, filename, payload) {
  const fileHandle = await handle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable(); // 写临时文件，close 时原子替换
  await writable.write(new Blob([JSON.stringify(payload)]));
  await writable.close();
}

/** 高频备份（收纳 + 书签，无浏览历史）：kind:'full-backup' 子集格式，
 *  「导入总备份」可直接恢复（history 段缺失时自动跳过）。 */
export async function runLocalBackup() {
  try {
    const handle = await getBackupDirHandle();
    if (!handle) return { skipped: true, reason: 'no-dir' };
    const perm = await ensurePermission(handle);
    if (perm !== 'granted') return { skipped: true, reason: 'no-permission' };
    // 标签收纳（onetap-full-backup 格式，与总备份的 stash 段同构）
    const stash = JSON.parse(await buildStashJSON());
    // 书签整树（原始时间戳；恢复时 merge 挂新文件夹 / overwrite 整树替换）
    let bookmarks = null;
    try {
      const tree = (await chrome.bookmarks.getTree())[0]?.children || [];
      bookmarks = { version: 0, tree };
    } catch { /* 无书签权限时跳过 */ }
    await writeFile(handle, BACKUP_FILENAME, {
      app: 'web-history-archive',
      kind: 'full-backup',
      v: 1,
      exportedAt: new Date().toISOString(),
      counts: { stashTabs: (stash.items || []).filter((i) => i?.type === 'tab').length },
      stash,
      bookmarks,
    });
    await setState({ lastBackup: Date.now(), lastError: null });
    return { ok: true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.warn('[历史记录] 本地备份失败', e);
    setState({ lastError: msg }).catch(() => {});
    return { ok: false, error: msg };
  }
}

async function ensurePermission(handle) {
  try { return await handle.queryPermission({ mode: 'readwrite' }); }
  catch { return 'denied'; }
}

/** 完整备份（复用「总备份」打包：历史 + 收纳 + 书签 + 意外关闭存档）。
 *  大文件（含全部浏览历史），每天一次/手动触发，不做高频防抖。 */
export async function runFullLocalBackup() {
  try {
    const handle = await getBackupDirHandle();
    if (!handle) return { skipped: true, reason: 'no-dir' };
    const perm = await ensurePermission(handle);
    if (perm !== 'granted') {
      await setState({ lastError: '备份文件夹权限未授予，请在设置页点「重新授权」' });
      return { skipped: true, reason: 'no-permission' };
    }
    const dump = await buildFullBackup();
    await writeFile(handle, FULL_BACKUP_FILENAME, dump);
    await setState({ lastFullBackup: Date.now(), lastError: null });
    return { ok: true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.warn('[历史记录] 本地完整备份失败', e);
    setState({ lastError: msg }).catch(() => {});
    return { ok: false, error: msg };
  }
}

/** 变更防抖登记：有目录才设 alarm（alarm 同名自动重置，静止 10 分钟后写一次）。 */
export function noteLocalChange() {
  Promise.resolve().then(async () => {
    try {
      const handle = await getBackupDirHandle();
      if (!handle) return;
      chrome.alarms.create(BACKUP_ALARM, { delayInMinutes: DEBOUNCE_MINUTES });
    } catch { /* 无 alarms API 静默 */ }
  });
}

/** 每日兜底：距上次完整备份超 24h 才设 alarm（SW 冷启动很频繁，不能每次都写盘）。 */
export async function noteStartupBackup() {
  try {
    const handle = await getBackupDirHandle();
    if (!handle) return;
    const st = await getState();
    if (st.lastFullBackup && Date.now() - st.lastFullBackup < DAILY_FALLBACK_MS) return;
    chrome.alarms.create(FULL_BACKUP_ALARM, { delayInMinutes: 2 });
  } catch { /* 静默 */ }
}

/** 页面打开补写（限流：距上次成功备份超 1 小时才真的写）。 */
export async function maybeBackupOnOpen() {
  try {
    const handle = await getBackupDirHandle();
    if (!handle) return;
    const st = await getState();
    if (st.lastBackup && Date.now() - st.lastBackup < OPEN_THROTTLE_MS) return;
    await runLocalBackup();
  } catch { /* 静默 */ }
}

// alarm 监听必须在模块加载（SW 顶层同步执行）时注册，否则 SW 被唤醒后错过事件。
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKUP_ALARM) {
    runLocalBackup()
      .then((r) => { if (r && r.error) console.warn('[历史记录] 本地备份未成功:', r.error); })
      .catch(() => {});
  } else if (alarm.name === FULL_BACKUP_ALARM) {
    runFullLocalBackup()
      .then((r) => { if (r && r.error) console.warn('[历史记录] 本地完整备份未成功:', r.error); })
      .catch(() => {});
  }
});
