# OneTab D1 Sync — 部署指南

用 Cloudflare D1(免费)替换 OneTab 自带的付费 one-tab.com 同步。快照式、端到端加密。

## 0. 一键引导部署（推荐新手）

在仓库根目录执行，脚本会分步引导：登录 Cloudflare → 建库建表 → 生成 Access Token → 部署 → 打印扩展设置所需的地址与令牌：

```bash
node tools/setup-worker.mjs
```

完成后把输出的 **Worker 地址 / Access Token** 填进扩展设置即可（加密口令自定）。以下手动步骤与脚本等效，供了解原理或手动排障。

## 1. 部署 Worker + D1

```bash
cd worker
npm install -g wrangler   # 已装可跳过
wrangler login

# 创建 D1 数据库,并把输出的 database_id 填入 wrangler.toml
wrangler d1 create onetap-sync

# 建表(远程)
wrangler d1 execute onetap-sync --remote --file=schema.sql

# 设置访问 token(自定义一个长随机串,例如: openssl rand -hex 32)
wrangler secret put SYNC_TOKEN

# 部署
# 公开仓库里 wrangler.toml 的 database_id 是占位符；本地真实配置放在根目录
# private/wrangler.toml（已 gitignore）。有私有配置时用它部署:
wrangler deploy --config ../private/wrangler.toml
# 没有则直接: wrangler deploy
```

记下输出的 `https://onetap-d1-sync.<你的子域>.workers.dev`。

## 2. 配置扩展

1. Chrome 打开 `chrome://extensions` → 加载已解压的扩展程序 → 选择本目录(已修改过,直接加载即可)。
2. 右键工具栏 OneTab 图标 → **D1 Sync settings**。
3. 填入:
   - **Worker URL**: 上面的 workers.dev 地址
   - **Access Token**: 与 `SYNC_TOKEN` 相同
   - **Encryption Passphrase**: 自定义口令,**所有设备必须一致**(端到端加密密钥,丢失无法恢复)
4. 点击 **Save**,然后 **Sync Now** 验证。

其他设备装同一份扩展,填相同配置(口令一致),即可互相同步。

## 3. 工作机制

- **触发时机**: 数据变更后约 5 秒(通过 patch `IDBObjectStore.prototype` 监听对 `item` store 的写入,含混淆核心代码发起的写入)、启动后 30 秒、每 15 分钟(alarm)。
- **上传**: 全量导出 IndexedDB `onetab` 库 `item` store → JSON → gzip → AES-GCM 加密(口令 PBKDF2 派生密钥)→ `POST /push` 存入 D1 `snapshots` 表(每设备一行)。
- **下载/合并**: `GET /pull` 拉取其他设备快照 → 解密 → 按 `id` + `modifyDate` 逐条 LWW 合并写回;删除通过 tombstone(chrome.storage.local)传播,避免"删除复活"。
- 合并完成后自动刷新 OneTab 页面;未产生变更则不动 UI。

## 4. Worker API

认证均为 `Authorization: Bearer <SYNC_TOKEN>`。**v4 起所有响应都带 `api` 版本号**,
扩展端据此识别旧 Worker(缺失或 `<4` 会直接报错并提示重新部署,而不是行为异常)。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 列出所有设备名快照及最后同步时间(`api:4`) |
| POST | `/push` | `{deviceName, blob:{iv,data}, mode?}`;已存在同名且未带 `mode:'overwrite'` 时返回 **409 name-exists**(由扩展端问用户覆盖/合并/取消) |
| GET | `/pull` | 返回全部设备名快照;`?name=<设备名>` 只取该设备名("合并"解法用) |
| DELETE | `/devices/<name>` | **硬删除**该设备名快照(不拉黑,之后可随时重新上传) |
| DELETE | `/devices` | 清空全部快照 |

## 5. 已知限制

- 服务器只见密文,`deviceName` 除外(明文)。
- 合并为整条记录级 LWW,分组内条目顺序冲突时取修改时间较新的一方,不做细粒度排序合并。
- 快照上限 4MB(压缩后),几千个标签完全够用。
- 原 one-tab.com 的 license/共享分组功能与本模块无关,未改动(也不再依赖)。

---

## web-history 版说明

本目录移植自 onetap_2.21(OneTab 2.21 + D1 Sync),Worker API、加密方案(盐值
`onetap-d1-sync-v1`)、`schema.sql` 与原版完全一致——**可复用已部署的 onetap D1 Sync
Worker 与同一个 D1 数据库**,两边的设备快照互通(加密口令一致即可互相合并)。

与原版的差异:

- 快照额外携带 `bookmarks` 字段(Chrome 书签整树快照 + version),原版 Worker/查看页会
  忽略该字段,不受影响;本版 `/view` 页在标签列表之后追加渲染书签区块。
- 扩展端(lib/d1-sync.js)只同步标签收纳(`stashItems`)与书签,不同步浏览历史。

维护提示:`src/view.html` 是 `/view` 页面的源文件,改动后运行
`node tools/view-html.mjs encode` 重新内嵌进 `src/worker.js`,再 `wrangler deploy`。

## v4:删除即最终删除 + 覆盖/合并冲突协议(2026-10)

v3 的"删除后拉黑(`revoked_names`)、同名上传 403"被废除——**同名设备没有道理要改名才能
再上传**。v4 规则:

1. **删除 = 硬删除**:`DELETE /devices/<name>` 只删行,不留任何黑名单。
2. **同名冲突由用户决定**:`/push` 发现已存在同名快照且请求未带 `mode:'overwrite'` 时返回
   `409 {error:'name-exists', updatedAt}`;扩展端弹「覆盖 / 合并 / 取消」:
   - 覆盖 → 带 `mode:'overwrite'` 重推(本机数据替换云端);
   - 合并 → 先 `/pull?name=<同名>` 把云端快照合并进本机,再带 `mode:'overwrite'` 推合并结果;
   - 取消 → 本次不上传,云端不动。
3. **自动同步不弹窗**(无 UI),规则:冲突行的 `updatedAt` 旧于本机上次上传时间 → 视为本机
   自己的旧行,允许覆盖;否则(同名其它设备写了更新的数据)→ 只合并到本机、不上传。
4. **本地删除记忆**:用户在设置页删掉某设备名快照后,扩展端记下该名;**自动同步不再上传
   该名**(杜绝"删掉又被自动同步传回来"),手动点「同步云 / 双向同步」才允许重新上传。
5. 所有响应带 `api:4`;旧 Worker(v2/v3)缺失该字段,扩展端直接报错并提示重新部署——
   这正是"删除快照没反应/删掉又重现"最常见的真实原因(Worker 没跟着升级)。

老库升级(在已部署过 v3 的 Worker 上执行一次):

```bash
wrangler d1 execute onetap-sync --remote --file=schema.sql   # 建 snapshots_by_name 表(如缺)
wrangler d1 execute onetap-sync --remote --command "DROP TABLE IF EXISTS revoked_names"  # v3 拉黑表,废弃
wrangler deploy
```

(`snapshots_by_name` 表结构 v3/v4 相同,已有数据无需迁移;关键是 `wrangler deploy` 让
409 协议与 `api:4` 生效。)

## v3:快照按设备名归属(2026-10,拉黑机制已被 v4 废除)

快照表改为 `snapshots_by_name`(**device_name 主键,同名覆盖、不同名新增**),取代 v2 的
`(device_id, seq)` 多版本模型:一台设备在云端只有一条最新快照。v3 曾用 `revoked_names`
拉黑被删设备名(上传 403),因"同名设备需改名才能再上传"不符合预期,v4 已移除。

## v2:多版本快照(2026-10,已被 v3 取代)

快照表曾改为 `snapshots2`(device_id + seq 复合主键):每次上传插入新版本,每设备自动保留
最近 10 版。v3 起废弃该模型,此处仅作历史记录。
