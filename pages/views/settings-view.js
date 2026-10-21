// 设置页：两栏架构 —— 左侧锚点导航（一屏建立全页模型），右侧内容滚动。
// 分区：总备份 / 浏览历史 / 标签收纳（含云同步入口卡）/ 云同步。
// 设计原则（对齐 settings-clutter-analysis.md）：
// - 统一操作行范式：所有条目用 .set-row（标题+说明 …… 控件），不再各写各的（R3）
// - 备份三处同构：导出/导入/状态行结构完全一致，差异用参数表达（R2）
// - 反馈收敛：一个操作只有一个 .set-status，进度并入状态文字（R5）
// - 视觉降噪：emoji 小节图标/徽标胶囊删除，三色同步按钮改一主两次（R1/R6）
// - 云同步卡首屏：状态行 + 同步按钮（同步到本地为默认主按钮）+ 云端快照面板；
//   连接参数与断开同步收进「高级」。同步只手动触发，无任何自动同步。
// - 云同步 v4 语义：快照按设备名存储（同名覆盖/不同名新增）；手动上传遇同名冲突弹
//   「覆盖/合并/取消」；删除云端快照即最终删除（Worker 硬删）；Worker 旧版（无 api:v4）
//   时显性报错并提示重新部署

import { setInnerHTML, escapeHtml } from '../../lib/util.js';
import { confirmDialog, choiceDialog, formDialog } from '../../lib/dialog.js';
import {
  getBackupState, pickBackupDir, clearBackupDir,
  requestBackupPermission, runLocalBackup,
} from '../../lib/local-backup.js';
import { toast } from '../dashboard.js';

function sendD1(msg) {
  return new Promise((res) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        if (chrome.runtime.lastError) res({ ok: false, error: chrome.runtime.lastError.message });
        else res(r || { ok: false, error: '后台无响应' });
      });
    } catch (e) {
      res({ ok: false, error: String(e) });
    }
  });
}

// ---------------------------------------------------------------- 云同步

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString('zh-CN') : '从未';
}

/** 连接参数表单(未配置时首次填写 / 已配置时展开修改,共用)。
 *  设备名不在此表单：已移到快照列表上方（d1SnapDevice，改名紧挨快照归属，语义更近）。 */
function configFormHtml(cfg, prefix) {
  return `
    <div class="sync-form">
      <label>Worker 地址<input id="${prefix}Url" type="text" placeholder="https://xxx.workers.dev" value="${escapeHtml(cfg?.workerUrl || '')}"></label>
      <label>Access Token<input id="${prefix}Token" type="password" placeholder="${cfg ? '不修改请留空' : ''}" value=""></label>
      <label>加密口令<input id="${prefix}Key" type="password" placeholder="${cfg ? '不修改请留空' : ''}" value=""></label>
    </div>`;
}

/** 读取参数表单并保存(已配置时空白字段保留原值)。 */
async function saveConfigForm(host, prefix, cfg) {
  const config = {
    workerUrl: host.querySelector(`#${prefix}Url`).value.trim(),
    // 设备名已移出连接参数表单（快照列表上方独立保存）；这里保留原值
    deviceName: (cfg?.deviceName || '').trim(),
  };
  const token = host.querySelector(`#${prefix}Token`).value.trim();
  const passphrase = host.querySelector(`#${prefix}Key`).value;
  if (token) config.token = token;
  if (passphrase) config.passphrase = passphrase;
  if (!cfg) {
    if (!config.workerUrl || !config.token || !config.passphrase) {
      toast('请填写 Worker 地址、Access Token 和加密口令', true);
      return false;
    }
  } else if (!config.workerUrl) {
    toast('Worker 地址不能为空', true);
    return false;
  }
  const sr = await sendD1({ type: 'd1SyncSaveConfig', config });
  if (!sr.ok) { toast('保存失败：' + sr.error, true); return false; }
  // 防呆提示：改了设备名不会立刻改名云端快照——云端快照名只随"上传"更新
  // （同步到本地是纯下载，不改云端）。不说清楚，用户会以为改名没生效。
  const oldName = (cfg?.deviceName || '').trim();
  if (oldName !== config.deviceName && (oldName || config.deviceName)) {
    toast(cfg?.keepOldSnapshots
      ? `设备名已保存。云端快照名会在下次「同步到云」上传后更新；已开启"改名保留旧快照"，旧名快照会保留在云端列表里。`
      : `设备名已保存。云端快照名会在下次「同步到云」上传后更新，旧名快照会自动清理。`);
  }
  return true;
}

async function renderSyncCard(host) {
  setInnerHTML(host, '<p class="muted" style="margin:0;">正在读取同步状态…</p>');
  const r = await sendD1({ type: 'd1SyncGetState' });
  const cfg = r.config;
  const st = r.state || {};
  // 本机当前云端名（与后台 resolveDeviceName 同一规则）：状态行与快照列表都用它
  // 标出"哪一行才是本机"，用户改了设备名还没上传时能直接看出差异
  const myName = (cfg?.deviceName || '').trim()
    || ('device-' + String(cfg?.deviceId || 'x').slice(0, 6));

  if (!cfg) {
    setInnerHTML(host, `
      <div class="set-sub">
        <h3>云同步（标签收纳 + 书签）</h3>
        <p class="set-row-desc" style="margin:0 0 10px;">
          需要自建 Cloudflare Worker + D1 服务端（部署见扩展目录 worker/README.md）。
          数据端到端加密上传，服务器只见密文；浏览历史不参与同步。
        </p>
        ${configFormHtml(null, 'd1New')}
        <div class="row" style="margin-top:10px;">
          <button class="btn primary" id="d1Save">保存并连接</button>
          <span class="muted">保存后先从云端下载数据到本地。</span>
        </div>
      </div>
    `);
    host.querySelector('#d1Save').addEventListener('click', async () => {
      if (!(await saveConfigForm(host, 'd1New', null))) return;
      // 仅保存连接参数，不自动下载——同步方向始终由用户手动触发（与"只手动同步"的
      // 总原则一致）：首次想取云端数据，请用户自己点「↓ 同步到本地」。
      toast('连接参数已保存。要拉取云端数据，请点「↓ 同步到本地」；要上传本机数据，请点「↑ 同步到云」。');
      await renderSyncCard(host);
    });
    return;
  }

  const errNote = st.lastError
    ? `<div class="sync-warn">上次同步失败：${escapeHtml(st.lastError)}</div>`
    : '';

  setInnerHTML(host, `
    <div class="set-sub">
      <h3>云同步（标签收纳 + 书签）</h3>

      ${errNote}

      <div class="sync-statline">
        上次上传 <b>${fmtTime(st.lastPush)}</b> · 上次下载 <b>${fmtTime(st.lastPull)}</b> ·
        云端设备 <b>${st.remoteDevices || 0} 台</b> · 上次合并 <b>${st.applied || 0} 条</b> ·
        本机名称 <b>${escapeHtml(cfg.deviceName || '（未设置，将显示为 device-xxx）')}</b> ·
        云端名 <b>${escapeHtml(st.lastPushName || '（还没上传过）')}</b>${st.lastPushName && st.lastPushName !== myName ? '（与当前设备名不同，上传后自动更新）' : ''}
        ${st.lastPullPulled === undefined ? '' : `<br>上次拉取诊断：云端快照 <b>${st.lastPullPulled}</b> 个 · 解密失败 <b>${st.lastPullDecryptFailed || 0}</b> 个${st.lastPullPulled === 0 ? '（云端没有快照：确认其它设备点过「同步到云」，且 Worker 已按 v4 重新部署）' : ''}${st.lastPullDecryptFailed ? '（口令与对方设备不一致，或快照损坏）' : ''}`}
      </div>

      <details class="sync-snap">
        <summary>连接参数（Worker 地址 / Token / 口令 / 设备名 / 断开）</summary>
        <div style="margin-top:10px;">
          ${configFormHtml(cfg, 'd1Edit')}
          <div class="row" style="margin-top:10px;">
            <button class="btn primary btn-sm" id="d1EditSave">保存参数</button>
            <span class="muted">Token / 口令留空表示不修改。</span>
          </div>
          <div class="row" style="margin-top:8px; align-items:center;">
            <span class="muted" style="font-size:12px;">设备 ID：<code style="user-select:all;">${escapeHtml(cfg.deviceId || '')}</code></span>
            <span style="flex:1;"></span>
            <button class="btn btn-sm" id="d1ResetId" title="云端快照按设备名归属；设备 ID 只是本地标识，一般无需重置">重置设备 ID</button>
          </div>
          <div class="setting-row" style="margin-top:10px; border-top: 1px solid var(--border); padding-top: 10px;">
            <div>
              <div>断开云同步</div>
              <div class="desc">仅清除本机同步配置，本机数据保留。</div>
            </div>
            <button class="btn danger btn-sm" id="d1Disconnect">断开</button>
          </div>
        </div>
      </details>

      <div class="setting-row">
        <div>
          <div>自动同步到云</div>
          <div class="desc">标签收纳有新增或改动后约 1 分钟自动上传为云端快照（只上传，不下载，不会覆盖本机）。云端始终保有一份较新的本机数据，换设备或「同步到本地」失误时不易丢。</div>
        </div>
        <label class="switch"><input type="checkbox" id="d1AutoPush" ${cfg.autoPush !== false ? 'checked' : ''}><span class="track"></span></label>
      </div>

      <div class="set-row">
        <div class="set-row-main">
          <div class="set-row-title">手动同步</div>
          <div class="set-row-desc">同步到本地 = 用云端最新快照整包覆盖本机（需确认）；同步到云 = 上传为新版本快照（同名冲突时询问覆盖/合并）。</div>
        </div>
        <div class="set-row-ctrl">
          <button class="btn primary" id="d1Pull" title="拉取云端最新的快照，整包替换本机标签收纳数据（本机未上传的改动会丢失，需确认）">↓ 同步到本地</button>
          <button class="btn" id="d1Push" title="把本机数据加密同步到云端（新版本快照，不下载）">↑ 同步到云</button>
        </div>
      </div>

      <div class="setting-row">
        <div>
          <div>改名保留旧快照</div>
          <div class="desc">开启后，修改设备名再上传会在云端保留旧名快照（在下方"快照列表"里手动删除）；默认关闭：上传后自动清理旧名快照，云端始终只有一个本机快照。</div>
        </div>
        <label class="switch"><input type="checkbox" id="d1KeepOldSnapshots" ${cfg.keepOldSnapshots ? 'checked' : ''}><span class="track"></span></label>
      </div>

      <details id="d1SnapBox" class="sync-snap snap-manage" open>
        <summary>快照列表（勾选可批量删除；选中多份可合并）</summary>
        <div class="snap-desc">每台设备的最近一次完整快照。勾选要删除的设备，点「删除选中」（删除即最终删除，本机数据不受影响）；或选中多份快照点「合并快照」，按名称合并为一份新快照，原有快照保留不动。</div>
        <div class="snap-devname" title="云端快照按此名称归属；修改在下次「同步到云」上传后生效">
          <span>快照名称</span>
          <input id="d1SnapDevice" type="text" placeholder="（未设置，将显示为 device-xxx）" value="${escapeHtml(cfg.deviceName || '')}">
          <button class="btn btn-sm" id="d1SnapDevSave">保存</button>
        </div>
        <div class="snap-toolbar">
          <label class="snap-selall"><input type="checkbox" id="d1SnapSelAll"> 全选</label>
          <button class="btn btn-sm danger" id="d1SnapDelSel" disabled>删除选中</button>
          <button class="btn btn-sm" id="d1SnapMerge" disabled title="把选中的 2 份以上快照合并为一份新快照">合并快照</button>
          <button class="btn btn-sm" id="d1Refresh">刷新</button>
          <span style="flex:1;"></span>
          <button class="btn btn-sm danger" id="d1DeleteAll">清空全部</button>
        </div>
        <div id="d1DeviceList"></div>
      </details>
    </div>
  `);

  // 三种同步方向（语义按方向命名：同步到云 = 上传到云端；同步到本地 = 下载到本机）
  // v4：手动上传撞到云端同名快照时不静默覆盖——弹「覆盖 / 合并 / 取消」，
  // 选择后由后台 d1SyncResolvePush 把同步跑完，结果仍走这里如实汇报。
  const reportSyncResult = (res, label, type) => {
    if (res.ok) {
      if (res.cancelled) { toast('已取消，云端快照未改动'); return; }
      if (res.restored) {
        // v5 同步到本地（覆盖语义）的结果
        const parts = [`已用云端「${res.deviceName || '?'}」的快照（更新于 ${fmtTime(res.updatedAt)}）恢复 ${res.count} 条记录`];
        if (res.bookmarksApplied) {
          parts.push('书签已整树替换为云端版本');
          // 部分旧节点删除失败时后端会带"重建完成…：原因"字样，剥掉前缀只显示原因
          if (res.bookmarkSkip) parts.push('注意：' + res.bookmarkSkip.replace(/^重建完成[^：]*：/, ''));
        } else if (res.bookmarkSkip) {
          parts.push('书签未替换：' + res.bookmarkSkip);
        }
        if (res.decryptFailed) parts.push(`${res.decryptFailed} 份快照解密失败未参与（口令不一致？）`);
        toast(`同步到本地完成：${parts.join(' · ')}`);
        return;
      }
      if (res.pushedOnly) {
        const extra = res.merged !== undefined ? `（先合并云端 ${res.merged} 条）` : '';
        // 书签回执：明确告知本次快照带没带书签（合并快照产物不含书签；
        // 读取失败也不含）——不让用户在加密快照里猜
        const bm = res.bookmarkNodes == null
          ? ' · 未含书签'
          : ` · 含书签 ${res.bookmarkNodes.toLocaleString()} 项`;
        toast(`同步到云完成：本机数据已上传为云端快照「${res.deviceName || 'device'}」${extra}${bm}`);
      } else {
        // 诊断式反馈：拉到几个快照 / 几个解密失败 / 合并几条——任何一种异常
        // 都不能再说一句干巴巴的"完成"（那正是"同步到本地是废的"的体验根源）
        const parts = [];
        if (res.pulled === 0) {
          parts.push('云端暂无任何设备快照');
        } else {
          parts.push(`拉到 ${res.pulled} 个设备快照`);
          if (res.decryptFailed) parts.push(`${res.decryptFailed} 个解密失败（口令与该设备不一致？）`);
          if (res.applied) parts.push(`合并 ${res.applied} 条`);
          else if (!res.decryptFailed) parts.push('本地已是最新，无新变化');
        }
        if (res.bookmarksApplied) parts.push('含书签整树');
        // 云端快照名和当前填写的设备名不一致（改过名但还没上传过）——
        // 这正是"快照名字和我填的设备名不一样"的成因，直接说明白
        if (res.nameMismatch) {
          parts.push('云端快照名与当前设备名不同：上传一次（同步到云）即会自动更新'
            + (cfg.keepOldSnapshots ? '，旧名快照会保留' : '，旧名快照会清理'));
        }
        toast(`${label}完成：${parts.join(' · ')}`);
      }
    } else if (res.error === 'name-exists') {
      // 同名冲突：问用户 覆盖 / 合并 / 取消（v4 冲突协议）
      const c = res.conflict || {};
      choiceDialog({
        title: '云端已存在同名快照',
        message: `云端已存在设备名「${c.deviceName || '本机'}」的快照（更新于 ${fmtTime(c.updatedAt)}）。\n\n· 覆盖：用本机当前数据替换云端快照；\n· 合并：先把云端快照合并进本机，再上传合并结果；\n· 取消：本次不上传，云端保持不变。`,
        choices: [
          { label: '覆盖', value: 'overwrite', primary: true },
          { label: '合并', value: 'merge' },
        ],
      }).then(async (resolution) => {
        if (!resolution) { toast('已取消上传，云端快照未改动'); await renderSyncCard(host); return; }
        toast(resolution === 'merge' ? '正在合并云端快照…' : '正在覆盖云端快照…');
        const r2 = await sendD1({ type: 'd1SyncResolvePush', resolution });
        reportSyncResult(r2, label, 'd1SyncResolvePush');
        await renderSyncCard(host);
      });
      return;
    } else {
      toast(`${label}未执行：${res.error || res.reason || '未知错误'}`, true);
    }
  };
  const runSyncBtn = async (type, label) => {
    toast(label + '…');
    const res = await sendD1({ type });
    reportSyncResult(res, label, type);
    await renderSyncCard(host);
  };
  host.querySelector('#d1Push').addEventListener('click', () => runSyncBtn('d1SyncPush', '同步到云'));
  host.querySelector('#d1Pull').addEventListener('click', async () => {
    // v5：同步到本地 = 云端最新快照整包覆盖本机——本机未上传的改动会丢，必须确认
    const ok = await confirmDialog({
      title: '同步到本地（覆盖本机）',
      message: '将拉取云端最新的一份快照，整包替换本机的标签收纳数据：\n· 本机自上次上传以来的全部改动会丢失，不可恢复；\n· 如本机有想保留的改动，先点「同步到云」备份；\n· 书签整树替换为云端版本（本机书签改动会丢失）。\n\n确定用云端最新快照覆盖本机？',
      confirmText: '覆盖本机', danger: true,
    });
    if (!ok) return;
    await runSyncBtn('d1SyncPull', '同步到本地');
  });

  // 设备名（快照列表上方独立项）：云端快照按设备名归属，改名紧挨着快照列表管理
  host.querySelector('#d1SnapDevSave').addEventListener('click', async () => {
    const deviceName = host.querySelector('#d1SnapDevice').value.trim();
    if (deviceName === (cfg.deviceName || '').trim()) return;
    const sr = await sendD1({ type: 'd1SyncSaveConfig', config: { deviceName } });
    if (!sr.ok) { toast('保存失败：' + sr.error, true); return; }
    toast(cfg.keepOldSnapshots
      ? '快照名称已保存。云端快照名会在下次「同步到云」上传后更新；已开启"改名保留旧快照"，旧名快照会保留在云端列表里。'
      : '快照名称已保存。云端快照名会在下次「同步到云」上传后更新，旧名快照会自动清理。');
    await renderSyncCard(host);
  });

  // 自动同步到云开关（autoPush，默认开）：变更后约 1 分钟自动上传（仅 push）
  host.querySelector('#d1AutoPush').addEventListener('change', async (e) => {
    const on = e.target.checked;
    const sr = await sendD1({ type: 'd1SyncSaveConfig', config: { autoPush: on } });
    if (sr.ok) toast(on
      ? '已开启：标签收纳变更后约 1 分钟自动上传到云（仅上传，不覆盖本机）'
      : '已关闭：只保留手动「同步到云」');
    else toast('保存失败：' + sr.error, true);
    await renderSyncCard(host);
  });

  // 改名保留旧快照开关（keepOldSnapshots）
  host.querySelector('#d1KeepOldSnapshots').addEventListener('change', async (e) => {
    const on = e.target.checked;
    const sr = await sendD1({ type: 'd1SyncSaveConfig', config: { keepOldSnapshots: on } });
    if (sr.ok) toast(on
      ? '已开启：改名后上传会保留云端旧名快照（云端快照里可手动删除）'
      : '已关闭：改名后上传会自动清理旧名快照');
    else toast('保存失败：' + sr.error, true);
    await renderSyncCard(host);
  });

  // 云端快照管理面板（多选批量删除 + 单条恢复）
  const snapBox = host.querySelector('#d1SnapBox');
  const list = host.querySelector('#d1DeviceList');
  const selAll = host.querySelector('#d1SnapSelAll');
  const delSelBtn = host.querySelector('#d1SnapDelSel');
  const mergeBtn = host.querySelector('#d1SnapMerge');
  const syncSelState = () => {
    const boxes = [...list.querySelectorAll('.snap-check')];
    const checked = boxes.filter((b) => b.checked).length;
    delSelBtn.disabled = !checked;
    mergeBtn.disabled = checked < 2;
    selAll.checked = boxes.length > 0 && boxes.every((b) => b.checked);
  };
  const loadSnapshots = async () => {
    const res = await sendD1({ type: 'd1SyncListSnapshots' });
    if (!res.ok) {
      // 读不到列表多半是 Worker 旧版/未部署——把原因直接显示出来，
      // 而不是一句"读取失败"让用户以为云端数据丢了
      setInnerHTML(list, `<div class="sync-warn">读取云端快照失败：${escapeHtml(res.error || '未知错误')}</div>`);
      syncSelState();
      return;
    }
    if (!res.devices.length) {
      setInnerHTML(list, '<div class="snap-empty">云端还没有任何设备快照。先在某台设备上点「同步到云」。</div>');
      syncSelState();
      return;
    }
    setInnerHTML(list, res.devices.map((d) => {
      const mine = d.device_name === myName;
      const meta = [
        d.device_id ? `设备ID: ${escapeHtml(d.device_id)}` : null,
        `更新: ${fmtTime(d.updated_at)}`,
        mine ? null : '与本机设备名不同',
      ].filter(Boolean).join(' · ');
      return `
      <div class="snap-item${mine ? ' snap-mine' : ''}">
        <input type="checkbox" class="snap-check" data-name="${escapeHtml(d.device_name)}" title="选中以批量删除 / 合并">
        <div class="snap-info">
          <div class="snap-name">${escapeHtml(d.device_name)}${mine ? ' <span class="sync-badge">本机</span>' : ''}</div>
          <div class="snap-meta">${meta}</div>
        </div>
        <button class="btn btn-sm" data-restore="${escapeHtml(d.device_name)}" title="用该设备最新快照整体替换本机标签收纳">恢复到本机</button>
      </div>`;
    }).join(''));
    list.querySelectorAll('.snap-check').forEach((b) => b.addEventListener('change', syncSelState));
    syncSelState();
    list.querySelectorAll('button[data-restore]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!(await confirmDialog({
          title: '从云端快照恢复',
          message: '将把云端该设备的最新快照整体替换到本机：\n· 本机标签收纳数据被覆盖，恢复之后的本机改动会丢失；\n· 书签整树同样被替换为该快照的版本（该快照未含书签时保持不变）；\n· 浏览历史不受影响。\n确定恢复？',
          confirmText: '恢复到本机', danger: true,
        }))) return;
        toast('正在从云端恢复…');
        const r = await sendD1({ type: 'd1SyncRestoreFromSnapshot', deviceName: b.dataset.restore });
        if (r.ok) {
          const parts = [`恢复完成：${r.count ?? '?'} 条记录（来自「${r.deviceName || '云端快照'}」）`];
          if (r.bookmarksApplied) parts.push('书签已整树替换');
          else if (r.bookmarkSkip) parts.push('书签未替换：' + r.bookmarkSkip);
          toast(parts.join(' · '));
        } else toast('恢复失败：' + (r.error || '未知错误'), true);
        await renderSyncCard(host);
      });
    });
  };
  // 合并快照：选中 ≥2 份 → 输入新名称 → 合并为一份新快照（原快照保留）
  mergeBtn.addEventListener('click', async () => {
    const names = [...list.querySelectorAll('.snap-check:checked')].map((b) => b.dataset.name);
    if (names.length < 2) { toast('合并快照需至少选中 2 份', true); return; }
    const res = await formDialog({
      title: '合并快照',
      note: `将把选中的 ${names.length} 份快照合并为一份新快照：\n${names.map((n) => '· ' + n).join('\n')}\n\n同一条记录取修改时间较新的版本；原有快照保留不动。`,
      fields: [{ key: 'name', label: '新快照名称', type: 'text', placeholder: '例如：合并备份' }],
      confirmText: '合并',
    });
    if (!res) return;
    const newName = (res.name || '').trim();
    if (!newName) { toast('请输入新快照名称', true); return; }
    toast('正在合并快照…');
    let r = await sendD1({ type: 'd1SyncMergeSnapshots', deviceNames: names, newName });
    if (!r.ok && r.conflict) {
      const over = await confirmDialog({
        title: '云端已存在同名快照',
        message: `云端已存在名为「${newName}」的快照。\n合并结果将覆盖它（选中的原快照保留不动）。确定覆盖？`,
        confirmText: '覆盖', danger: true,
      });
      if (!over) return;
      toast('正在覆盖为合并结果…');
      r = await sendD1({ type: 'd1SyncMergeSnapshots', deviceNames: names, newName, overwrite: true });
    }
    if (r.ok) toast(`合并完成：${r.count} 条记录已保存为新快照「${r.deviceName || newName}」`);
    else toast('合并失败：' + (r.error || '未知错误'), true);
    await loadSnapshots();
  });
  selAll.addEventListener('change', () => {
    list.querySelectorAll('.snap-check').forEach((b) => { b.checked = selAll.checked; });
    syncSelState();
  });
  delSelBtn.addEventListener('click', async () => {
    const names = [...list.querySelectorAll('.snap-check:checked')].map((b) => b.dataset.name);
    if (!names.length) return;
    if (!(await confirmDialog({
      title: '删除选中的云端快照',
      message: `删除 ${names.length} 台设备的云端快照？\n${names.map((n) => '· ' + n).join('\n')}\n\n删除即最终删除（不留备份）；本机数据不受影响。`,
      confirmText: '删除选中', danger: true,
    }))) return;
    let ok = 0, fail = 0;
    for (const name of names) {
      const r = await sendD1({ type: 'd1SyncDeleteSnapshot', deviceName: name });
      if (r.ok) ok++; else fail++;
    }
    toast(fail ? `删除完成：成功 ${ok} 台，失败 ${fail} 台（${names.length - ok - 0} 台未删）` : `已删除 ${ok} 台设备的云端快照`, fail > 0);
    await loadSnapshots();
  });
  host.querySelector('#d1Refresh').addEventListener('click', loadSnapshots);
  host.querySelector('#d1DeleteAll').addEventListener('click', async () => {
    if (!(await confirmDialog({
      title: '删除全部云端快照',
      message: '删除云端全部设备快照？所有设备将失去云端备份，需重新同步。',
      confirmText: '全部删除', danger: true,
    }))) return;
    await sendD1({ type: 'd1SyncDeleteAllSnapshots' });
    toast('已清空云端快照');
    await loadSnapshots();
  });
  snapBox.addEventListener('toggle', () => {
    if (snapBox.open && !list.textContent.trim()) loadSnapshots();
  });

  // 修改连接参数
  host.querySelector('#d1EditSave').addEventListener('click', async () => {
    if (!(await saveConfigForm(host, 'd1Edit', cfg))) return;
    toast('连接参数已保存。设备名在下次上传（同步到云）后显示在云端快照列表。');
    await renderSyncCard(host);
  });

  // 重置设备 ID：v3 起云端快照按设备名归属（同名覆盖），设备 ID 只作本地
  // 标识，不再影响云端存储。如两台设备设备名相同互相覆盖，改设备名即可
  // （连接参数里的"设备名"字段）；此按钮仅重置本地 ID。
  host.querySelector('#d1ResetId').addEventListener('click', async () => {
    if (!(await confirmDialog({
      title: '重置设备 ID',
      message: '云端快照按设备名归属（同名覆盖），设备 ID 只作本地标识。\n如果两台设备设备名相同、上传会互相覆盖，请改「设备名」而不是重置 ID。\n\n重置后：\n· 仅更换本机内部 ID，云端快照位置不变；\n· 如无特殊原因无需重置。\n\n确认重置？',
      confirmText: '重置设备 ID', danger: true,
    }))) return;
    const r = await sendD1({ type: 'd1SyncResetDeviceId' });
    if (r.ok) toast('设备 ID 已重置（云端仍按设备名归属，不受影响）');
    else toast('重置失败：' + (r.error || '未知错误'), true);
    await renderSyncCard(host);
  });

  // 断开
  host.querySelector('#d1Disconnect').addEventListener('click', async () => {
    if (!(await confirmDialog({
      title: '断开云同步',
      message: '断开云同步？本机数据保留，仅清除同步配置。',
      confirmText: '断开', danger: true,
    }))) return;
    await sendD1({ type: 'd1SyncDisconnect' });
    toast('已断开云同步');
    await renderSyncCard(host);
  });
}

// ---------------------------------------------------------------- 本地磁盘备份

async function renderLocalBackupCard(host) {
  const st = await getBackupState();
  const permLabel = !st.dirName ? '' : st.permission === 'granted'
    ? '<span style="color:var(--ok,#2e7d32);">已授权</span>'
    : st.permission === 'denied'
      ? '<span style="color:#c62828;">已拒绝（请在浏览器站点权限里恢复）</span>'
      : '<span style="color:#b26a00;">待重新授权（浏览器重启后失效，属正常）</span>';
  setInnerHTML(host, `
    <div class="set-row">
      <div class="set-row-main">
        <div class="set-row-title">本地磁盘备份</div>
        <div class="set-row-desc">选择一个文件夹，插件自动往里写两份「总备份」格式文件（恢复就用上方"导入总备份"选文件，无需其它入口）：web-history-backup.json 收纳+书签，变更后约 10 分钟更新；web-history-full-backup.json 完整版（含全部浏览历史，文件大），每天自动更新一次。本文件夹在浏览器管理范围之外，清理软件和"清除站点数据"都碰不到。</div>
      </div>
    </div>
    <div class="set-row">
      <div class="set-row-main">
        <div class="set-row-title">备份文件夹</div>
        <div class="set-row-desc">${st.dirName
          ? `已选择：${escapeHtml(st.dirName)} · 权限：${permLabel}<br>收纳+书签：${fmtTime(st.lastBackup)} · 完整（含历史）：${fmtTime(st.lastFullBackup)}${st.lastError ? `<br><span style="color:#c62828;">上次失败：${escapeHtml(st.lastError)}</span>` : ''}`
          : '尚未选择。选择后立即生成收纳+书签备份，完整版当天自动生成。'}</div>
      </div>
      <div class="set-row-ctrl">
        ${st.dirName && st.permission === 'prompt' ? '<button class="btn primary btn-sm" id="lbReauth">重新授权</button>' : ''}
        ${st.dirName ? '<button class="btn btn-sm" id="lbRun">立即备份</button>' : ''}
        <button class="btn ${st.dirName ? '' : 'primary'} btn-sm" id="lbPick">${st.dirName ? '更换文件夹…' : '选择备份文件夹…'}</button>
        ${st.dirName ? '<button class="btn danger btn-sm" id="lbClear">解除绑定</button>' : ''}
      </div>
    </div>
  `);
  host.querySelector('#lbPick').addEventListener('click', async () => {
    const r = await pickBackupDir(); // 必须在点击手势内调用
    if (r.cancelled) return;
    if (!r.ok) { toast('选择失败：' + r.error, true); return; }
    toast(`备份文件夹已设为「${r.dirName}」，开始首次备份…`);
    const b = await runLocalBackup();
    toast(b.ok ? '本地备份完成' : '首次备份失败：' + (b.error || b.reason), !b.ok);
    await renderLocalBackupCard(host);
  });
  const reauth = host.querySelector('#lbReauth');
  if (reauth) reauth.addEventListener('click', async () => {
    const r = await requestBackupPermission(); // 必须在点击手势内调用
    toast(r.ok ? '已重新授权' : '授权未通过：' + (r.error || r.permission), !r.ok);
    await renderLocalBackupCard(host);
  });
  const run = host.querySelector('#lbRun');
  if (run) run.addEventListener('click', async () => {
    toast('正在备份到本地…');
    const b = await runLocalBackup();
    toast(b.ok ? '本地备份完成（收纳+书签）' : '备份失败：' + (b.error || b.reason), !b.ok);
    await renderLocalBackupCard(host);
  });
  const clear = host.querySelector('#lbClear');
  if (clear) clear.addEventListener('click', async () => {
    if (!(await confirmDialog({
      title: '解除备份文件夹',
      message: '解除后插件不再往该文件夹写备份（已写入的文件保留不动）。确定解除？',
      confirmText: '解除', danger: true,
    }))) return;
    await clearBackupDir();
    toast('已解除备份文件夹');
    await renderLocalBackupCard(host);
  });
}

// ---------------------------------------------------------------- 数据边界与同步语义（底部帮助）

function renderHelpPanel(host) {
  setInnerHTML(host, `
    <details class="help-panel">
      <summary>各数据存放在哪、能备份到哪、怎么同步（点击展开）</summary>
      <div class="help-body">
        <div class="help-group">各数据存放在哪、能备份到哪</div>
        <table class="help-table">
          <tr><th>数据</th><th>本机存储</th><th>总备份（JSON）</th><th>单类备份</th><th>云同步</th></tr>
          <tr><td>浏览历史</td><td>✅ IndexedDB</td><td>✅</td><td>JSON ✅ / CSV（只读）</td><td>— 不参与</td></tr>
          <tr><td>书签 / 收藏</td><td>Chrome 原生</td><td>✅（含原始添加时间）</td><td>HTML ✅（浏览 → 书签页「导出 HTML」，含原始添加时间）</td><td>✅ 整树同步</td></tr>
          <tr><td>标签收纳</td><td>✅ IndexedDB</td><td>✅</td><td>JSON ✅（OneTab 兼容）/ HTML（只读）</td><td>✅</td></tr>
          <tr><td>意外关闭存档</td><td>✅ chrome.storage</td><td>✅</td><td>—</td><td>✅ 随同步整包覆盖/合并</td></tr>
        </table>
        <div class="help-group">三种同步方向的语义</div>
        <div class="help-row"><span class="help-key">↓ 同步到本地</span><span class="help-val">用云端<b>最新的一份快照整包覆盖</b>本机标签收纳（需确认，本机未上传的改动会丢失）。</span></div>
        <div class="help-row"><span class="help-key">↑ 同步到云</span><span class="help-val">把本机标签收纳与书签上传为云端快照，<b>按设备名覆盖</b>（同名只保留最新一份，不产生历史版本）；不下载。只有这个按钮或「合并快照」才会更新云端快照。</span></div>
        <div class="help-row"><span class="help-key">合并快照</span><span class="help-val">在「快照列表」选中 2 份以上快照，输入名称后合并为一份<b>新快照</b>（同一条记录取修改时间较新的版本）；原有快照保留不动，不影响本机数据。</span></div>
        <div class="help-group">同名快照与删除（v4）</div>
        <div class="help-row"><span class="help-key">同名冲突</span><span class="help-val">手动上传时云端已有同名快照，会询问<b>覆盖</b>（本机替换云端）/ <b>合并</b>（先合并云端再上传）/ 取消，绝不静默覆盖。</span></div>
        <div class="help-row"><span class="help-key">删除云端快照</span><span class="help-val"><b>删除即最终删除</b>（Worker 上同步删掉，不留备份）。同名设备之后可随时重新上传（点「同步到云」）。</span></div>
        <div class="help-group">恢复</div>
        <div class="help-row"><span class="help-key">恢复到本机</span><span class="help-val">误删/误移动后的正规恢复途径：用云端该设备<b>最新快照整体替换</b>本机标签收纳与书签整树；浏览历史不受影响。</span></div>
        <div class="help-group">导入 / 覆盖的边界</div>
        <div class="help-row"><span class="help-key">总备份导入</span><span class="help-val">合并导入：浏览历史去重合并、书签挂入新建文件夹、存档组取并集（标签收纳固定整包替换）。覆盖导入：四类数据全部以备份文件为准。</span></div>
        <div class="help-row"><span class="help-key">单类导入</span><span class="help-val">浏览历史：合并保留现有、跳过重复，覆盖先清空再导入。<b>标签收纳导入固定为整体替换</b>。两者都只动各自的数据，互不影响。</span></div>
      </div>
    </details>
  `);
}

// ---------------------------------------------------------------- 设置页主渲染

// 云端同步状态变化 → 重渲染同步卡（监听器模块级只注册一次，避免重复渲染累积）
let syncCardHost = null;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'd1SyncUpdated' && syncCardHost) renderSyncCard(syncCardHost);
});

export async function render(container) {
  setInnerHTML(container, `
    <div class="set-layout">
      <nav class="set-nav" id="setNav" title="点击跳转到对应分区">
        <button class="set-nav-item active" data-target="secFullBackup">总备份</button>
        <button class="set-nav-item" data-target="secHistory">浏览历史</button>
        <button class="set-nav-item" data-target="secStash">标签收纳</button>
        <button class="set-nav-item" data-target="secSync">云同步</button>
        <div class="set-nav-note">v${escapeHtml(chrome.runtime.getManifest().version)}</div>
      </nav>

      <div class="set-content">
        <section class="set-group" id="secFullBackup">
          <div class="set-head">总备份</div>
          <div class="card"><div id="fullBackupHost"></div></div>
          <div class="card"><div id="localBackupHost"></div></div>
        </section>

        <section class="set-group" id="secHistory">
          <div class="set-head">浏览历史</div>
          <div class="card"><div id="historyHost"></div></div>
        </section>

        <section class="set-group" id="secStash">
          <div class="set-head">标签收纳</div>
          <div class="card"><div id="stashSetHost"></div></div>
        </section>

        <section class="set-group" id="secSync">
          <div class="set-head">云同步</div>
          <div class="card"><div id="syncHost"></div></div>
        </section>

        <section class="set-group" id="secHelp">
          <div class="set-head">数据边界与同步语义</div>
          <div class="card"><div id="helpHost"></div></div>
        </section>

      </div>
    </div>
  `);

  // 锚点导航：点击滚动定位 + 高亮（一屏建立全页模型，R1/R7/A）
  const nav = container.querySelector('#setNav');
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.set-nav-item');
    if (!btn) return;
    nav.querySelectorAll('.set-nav-item').forEach((b) => b.classList.toggle('active', b === btn));
    container.querySelector(`#${btn.dataset.target}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const historyView = await import('./data.js');
  await historyView.renderFullBackupTools(container.querySelector('#fullBackupHost'));
  await historyView.renderHistoryTools(container.querySelector('#historyHost'));
  await historyView.renderStashTools(container.querySelector('#stashSetHost'));
  syncCardHost = container.querySelector('#syncHost');
  await renderSyncCard(syncCardHost);
  await renderLocalBackupCard(container.querySelector('#localBackupHost'));
  renderHelpPanel(container.querySelector('#helpHost'));
}
