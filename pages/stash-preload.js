// 收纳快照首屏预热（MV3 的 CSP 禁止内联脚本，故必须为外部文件）。
// 被两个页面共用：轻量页 pages/stash.html 与主界面 pages/dashboard.html
// （主界面默认就落在"收纳标签页"页签，走同一条 restoreSnapshot 链路）。
// 在模块链加载的同时并行预读页面快照，模块就绪时数据已备好，注入零等待。
// 复用 db.js 的 openDB() 单连接（与页面本体、initSchema 共享同一个 promise，
// 版本升级也走同一次 open）——不再自行 indexedDB.open：
//   1. 省掉同一页面的第二个连接；
//   2. 消除旧实现"无版本 open"与 db.js v4 升级之间的竞态（旧实现在空库上
//      会先建出一个没有任何 objectStore 的 v1 库，再等 db.js 升级到 v4）。
import('../lib/db.js')
  .then(({ getSetting }) => getSetting('stashSnapshotV1', null))
  .then((snap) => { window.__stashSnapData = snap; })
  .catch(() => { /* 读不到就回退：render 内部会自行 getSetting */ });
