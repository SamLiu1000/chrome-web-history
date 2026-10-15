-- v4:快照按设备名归属 —— device_name 主键，同名覆盖、不同名新增。
--    一台设备在云端只保留一条最新快照（v2 的 (device_id, seq) 多版本模型废弃）。
--    删除 = 硬删除，不拉黑：同名设备之后随时可重新上传；已存在同名时
--    /push 返回 409，由扩展端问用户"覆盖 / 合并 / 取消"。
--    旧表 snapshots2 保留不动，数据一次性迁移到本表（见文件末尾迁移命令）。

CREATE TABLE IF NOT EXISTS snapshots_by_name (
  device_name TEXT PRIMARY KEY,
  data        TEXT NOT NULL,          -- JSON: {iv, data} AES-GCM 密文(base64)
  updated_at  INTEGER NOT NULL
);

-- v3 曾用 revoked_names 做"删除后拉黑"，v4 已废弃（删除不再阻止重新上传）。
-- 老库若已建过该表，确认无人使用后手动 DROP 即可：
--   wrangler d1 execute onetap-sync --remote --command "DROP TABLE IF EXISTS revoked_names"

-- ---------------------------------------------------------------
-- 一次性迁移（把 v2 各设备最新版本按设备名导入；已在老库执行过一次）：
--   wrangler d1 execute onetap-sync --remote --command \
--     "INSERT OR REPLACE INTO snapshots_by_name (device_name, data, updated_at)
--      SELECT device_name, data, MAX(updated_at) FROM snapshots2 GROUP BY device_name"
-- 旧 snapshots2 表确认无人使用后可手动 DROP。
-- 从 v1 升级(更老的库，先跑 v1→v2 的迁移命令，再跑上面这条)。
