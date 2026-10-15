// 标签收纳轻量页入口（pages/stash.html）。
// 目标：像 OneTab 一样"点开即内容"——只加载收纳视图所需的模块
// （views/stash.js + lib/stash.js + lib/db.js + lib/util.js + lib/toast.js），
// 不引入仪表盘的页签框架/历史记录/实时/设置等任何代码。
// 数据与仪表盘共用同一份 IndexedDB，两个入口的增删改实时一致。

import { initSchema } from '../lib/db.js';
import { render } from './views/stash.js';

const host = document.getElementById('stashHost');

// 首帧：render 内部先注入上次页面快照（毫秒级），再立即读库校对
// （范围读取：约 5~6 次索引查询，与库总量无关，复用同一个 openDB promise）
render(host);

// 建库/开库与首屏并行（范围读取复用同一个 openDB promise；v4→v5 升级也走这里）
initSchema().catch((e) => console.warn('[收纳页] 数据库初始化失败：', e));
