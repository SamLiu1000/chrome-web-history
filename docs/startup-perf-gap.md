# 收纳标签页启动速度对比分析：web-history vs onetab_2.21

> 方法说明：未使用浏览器测试、未参考任何已有脚本。全部结论来自两条路径的源码静态清点
> + 本机 Node/V8（与 Chromium 同引擎）实测解析耗时 + 快照链路 JS 开销模拟。
> 凡属浏览器侧开销（网络/fetch/IPC/DOM 解析）均已标注为估算。

## 一、双方启动关键路径清单

### 参考程序（onetap_2.21 → onetab.html）
| 资源 | 体积 | 性质 |
|---|---|---|
| onetab.css | 30.1 KB / 205 条规则 | 渲染阻塞 |
| d1-sync-entry.js | 30.1 KB | classic script，head 同步阻塞 |
| ext-onetab-concatenated-sources-onetab.js | 414.3 KB（已压缩） | classic script，head 同步阻塞 |
| 合计 | **444.4 KB / 2 个文件** | 并行下载、依次执行，**无依赖图** |

首屏序列：CSS + 2 个同步脚本执行完 → `Gl(Vu)` 在 DOMContentLoaded/load 触发 →
`Vu()` 先 `await corePing()`（**给后台 SW 发消息，SW 休眠时需唤醒，失败重试 1s/5s**）→
`chrome.tabs.getCurrent()` → 约 12 步 await（主题/权限/设置/迁移检查/各种提示）→
全部完成后才 `loadingSpinner.remove()` 出内容。
favicon：每行一个 `t2.gstatic.com` **网络请求**（32px），无 `loading="lazy"`。

### 当前程序（web-history → pages/stash.html）
| 资源 | 体积 | 性质 |
|---|---|---|
| dashboard.css | 37.9 KB / 354 条规则 | 渲染阻塞 |
| stash-preload.js | 0.8 KB | classic script，开 IDB 预读快照 |
| stash-page.js（入口）+ 9 个 import 模块 | 201.1 KB / 10 个文件 | ES module，图深度 4 层串行 |
| 合计 | **~240 KB / 11 个文件** | 见下方模块图 |

模块依赖图（DFS 深度）：
```
pages/stash-page.js            depth=0
├─ lib/db.js                    depth=1
│  └─ lib/util.js               depth=2
└─ pages/views/stash.js         depth=1
   ├─ lib/stash.js              depth=2
   │  └─ lib/d1-sync.js         depth=3   ← 25.1KB，仅被 noteChange 引用
   ├─ lib/stash-export.js       depth=2   ← 10.3KB，仅导出/导入时用
   ├─ lib/dialog.js             depth=2   ← 4.9KB，仅弹窗用
   └─ lib/toast.js              depth=2   ← 0.9KB
```
`stash.html` 的 `modulepreload` 只提示了 4/10 个模块（views/stash.js、lib/stash.js、
lib/db.js、lib/util.js），**最深层 d1-sync.js 和另外 3 个模块没有预取提示**，
依赖图解析到时才发请求 → 关键路径上约 3 轮串行 fetch。

## 二、实测数据（Node 22 / V8 12.4，冷解析绕过编译缓存）

| 指标 | 参考程序 | 当前程序 |
|---|---|---|
| JS 关键路径体积 | 444.4 KB | 201.9 KB（去注释空白后 **123.9 KB**，未压缩） |
| JS 文件数 | 2 | 10 |
| **冷解析总耗时** | **8.45 ms**（其中主 bundle 8.11 ms） | **1.83 ms** |
| CSS 渲染阻塞 | 30.1 KB / 205 规则 | 37.9 KB / 354 规则（全仪表盘 7 个视图） |

**解析这一项当前程序快约 4.6 倍**，字节量只有参考的 45%。参考程序 414KB 的压缩包是
同步阻塞脚本，冷启动光解析就要 ~8ms——它的"快"不体现在这里。

## 三、快照链路开销模拟（主线程 JS 实测，innerHTML 解析另计）

按 `tabRowHtml`/`groupHtml` 真实模板生成（每组 10 标签）：

| 标签行数 | 建 HTML | 剥离属性(snapHtml) | 自检扫描(setInnerHTML) | 快照载荷(写 IDB) |
|---|---|---|---|---|
| 200 | 1.1 ms | 0.3 ms | 0.14 ms | 167 KB |
| 1,000 | 5.6 ms | 1.0 ms | 0.56 ms | 837 KB |
| 5,000 | 19.1 ms | 8.4 ms | 2.81 ms | **4.2 MB** |

每次打开的固定动作：读 settings 快照（1 次大值读）→ innerHTML 注入（浏览器侧解析，
与字节数成正比）→ 空闲时 `saveSnapshot` 把整页 HTML 序列化写回（4.2MB @5000 行）→
`verifyFreshness` **仍然全量读一遍 stashItems**（快照只省了 DOM 重建，没省读库）。

## 四、差距结论（按影响排序）

1. **模块图形态（最大结构差距）**：10 个 ES module、4 层串行依赖；41.2KB（占 JS 载荷
   20%）的首屏无关模块（d1-sync / stash-export / dialog / toast）被静态 import 拖进
   关键路径；modulepreload 缺 4 个模块。参考程序是 2 个并行下载的 classic script、
   零依赖图。估算多付出 2 轮串行请求（热缓存 ~5–15ms，冷缓存更高）。
2. **快照机制的双刃剑**：换来"打开即完整内容"，但每次打开多一次 settings 大值读 +
   一次整页 HTML 序列化写回（大规模时 4MB 级）+ verifyFreshness 仍全量读库。
   参考程序每次打开只读一次全量数据、直接建 DOM，无字符串往返。
3. **双开 IndexedDB**：`stash-preload.js` 无版本 `open` + `db.js` 的 `openDB(v4)`，
   两个连接两次异步打开。
4. **CSS**：37.9KB/354 规则（含仪表盘其余 6 个视图的样式）vs 参考 30.1KB/205 规则，
   渲染阻塞多约 26%，样式重算的候选规则也多 73%。

## 五、当前程序占优的方面（参考程序的真实启动成本）

- 冷解析 1.83ms vs 8.45ms；字节量 45%。
- 首屏不走后台 SW（参考程序 corePing 可能要唤醒 SW，失败还要重试 1s/5s）。
- favicon 走本地 `chrome-extension://_favicon/` 且 `loading="lazy"`；
  参考每行走 t2.gstatic.com 网络请求、无 lazy。
- 快照注入使首屏不等全量读库；参考程序要等十余步 await 全完成才移除 spinner。
- 无 web font 请求（参考的 Open Sans 在系统没装时会拉 5 个 woff）。

## 六、可执行的消除项（按性价比排序）

1. `stash.html` 的 modulepreload 补齐全部 5 个未提示模块（含入口自身与最深层
   d1-sync.js）→ 依赖图从 4 层串行压到 2 层，零风险。
2. 首屏无关模块改动态 `import()`：dialog / toast / stash-export 用时才加载；
   d1-sync 只被 `noteChange` 引用，把该函数拆出或懒加载 → 关键路径 -41KB（-20%）。
3. preload 与 db.js 共用同一次 open（preload 直接复用 openDB promise）→ 少一次
   IDB open；或干脆去掉 preload，由模块内 `getSetting` 读快照。
4. 快照瘦身：只序列化当前文件夹可见部分，或改存数据而非 HTML；`saveSnapshot`
   增加"数据未变不写"判断，避免大规模时 4MB 级的空闲写。
5. CSS 按视图拆包，收纳页只加载收纳相关规则（或从 dashboard.css 抽出 stash 段）。
6. `verifyFreshness` 的全量读可降低频率或改读聚合信息，避免每次打开都 O(N) 反序列化。

---
*测量环境：Windows / Node v22.22.2 / V8 12.4.254.21；解析耗时为 25 次迭代均值。*
