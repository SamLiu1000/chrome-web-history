// 顶栏云同步快捷条（sync-quick）：把设置页「云同步」的高频操作压缩到顶栏，
// 免去"每次同步都要跑设置页"的来回。与设置页共用同一组后台消息（d1Sync*），
// 两处 UI 是同一状态的两种视图；这里只保留高频项：
//   常驻：↓ 同步到本地 / ↑ 同步到云 / 上传·下载时间缩写
//   下拉面板：快照命名（设备名）+ 快照列表（勾选删除 / 合并 / 恢复到本机）
// 低频项（连接参数、断开、诊断、keepOldSnapshots 开关）仍在设置页，不在这里复制。
// 视觉约束：顶栏空间有限——按钮 12px 紧凑款，面板用绝对定位下拉浮层，
// 不撑高 topbar（topbar 是 sticky 的，撑高会把整个页面内容往下顶）。

import { escapeHtml, setInnerHTML } from '../../lib/util.js';
import { confirmDialog, choiceDialog, formDialog } from '../../lib/dialog.js';
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

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '从未';
}

let host = null;          // 挂载点（模块级：d1SyncUpdated 推送过来时重渲染）
let expanded = false;     // 下拉面板展开状态（重渲染后保持）
let listLoaded = false;   // 快照列表是否已读取过：懒加载——只在用户首次点开「快照」时读一次，
                          // 之后用缓存（点「刷新」或增删合并操作后强制重读）。页面打开不读取。
let myName = '';
let cfgCache = null;

/** 恢复/推送等结果的提示文案与设置页同一口径，这里只取要害，说短话。 */
function reportResult(res, label) {
  if (!res.ok) {
    if (res.error === 'name-exists') {
      const c = res.conflict || {};
      choiceDialog({
        title: '云端已存在同名快照',
        message: `云端已存在设备名「${c.deviceName || '本机'}」的快照（更新于 ${fmtTime(c.updatedAt)}）。\n\n· 覆盖：用本机当前数据替换云端快照；\n· 合并：先把云端快照合并进本机，再上传合并结果；\n· 取消：本次不上传。`,
        choices: [
          { label: '覆盖', value: 'overwrite', primary: true },
          { label: '合并', value: 'merge' },
        ],
      }).then(async (resolution) => {
        if (!resolution) { toast('已取消上传'); return; }
        const r2 = await sendD1({ type: 'd1SyncResolvePush', resolution });
        reportResult(r2, label);
      });
      return;
    }
    toast(`${label}未执行：${res.error || '未知错误'}`, true);
    return;
  }
  if (res.cancelled) { toast('已取消，云端快照未改动'); return; }
  if (res.restored) {
    const parts = [`已恢复 ${res.count} 条记录`];
    if (res.bookmarksApplied) parts.push('书签已整树替换');
    else if (res.bookmarkSkip) parts.push('书签未替换：' + res.bookmarkSkip);
    toast(`同步到本地完成：${parts.join(' · ')}`);
    return;
  }
  if (res.pushedOnly) {
    toast(`同步到云完成：已上传为快照「${res.deviceName || 'device'}」`);
    return;
  }
  const parts = [];
  if (res.pulled === 0) parts.push('云端暂无任何设备快照');
  else {
    parts.push(`拉到 ${res.pulled} 个快照`);
    if (res.decryptFailed) parts.push(`${res.decryptFailed} 个解密失败`);
    if (res.applied) parts.push(`合并 ${res.applied} 条`);
    else if (!res.decryptFailed) parts.push('本地已是最新');
  }
  toast(`${label}完成：${parts.join(' · ')}`);
}

function sleep(ms) { return new Promise((r2) => setTimeout(r2, ms)); }

/** 读取同步状态，带重试：SW 冷启动时第一条消息可能丢失/超时（设置页是用户
 *  点进去时 SW 已被唤醒，顶栏条是页面一打开就请求，更容易撞上冷启动）。 */
async function getStateWithRetry() {
  let last = null;
  for (let i = 0; i < 4; i++) {
    if (i) await sleep(300 * i); // 0 / 300 / 600 / 900ms
    const r = await sendD1({ type: 'd1SyncGetState' });
    // 注意：d1SyncGetState 的正常返回是 {config, state, tombstoneCount}，
    // 不带 ok 字段（设置页也从不检查 r.ok）——这里以是否有 config 字段判定成功。
    if (r && ('config' in r)) return r;
    last = r;
    console.warn(`[历史记录] 快捷条读取状态失败(第${i + 1}次)`, r && r.error);
  }
  return last;
}

async function render() {
  if (!host) return;
  // 立即显示占位：让"快捷条到底有没有跑起来"肉眼可判（而不是静默空白）
  setInnerHTML(host, '<span class="syncq-muted" style="font-size:11px;">云同步…</span>');
  const r = await getStateWithRetry();
  if (!r || !('config' in r)) {
    const msg = (r && r.error) || '未知错误';
    setInnerHTML(host, '<span class="syncq-err syncq-err-text" title="' + escapeHtml(msg) + '">云同步条加载失败：' + escapeHtml(msg) + '</span>');
    return;
  }
  if (!r.config) {
    // 未配置云同步：快捷条隐藏（去设置页「云同步」配置后自动出现）
    setInnerHTML(host, '');
    console.info('[历史记录] 云同步未配置，顶栏快捷条隐藏');
    return;
  }
  cfgCache = r.config;
  const st = r.state || {};
  myName = (cfgCache.deviceName || '').trim() || ('device-' + String(cfgCache.deviceId || 'x').slice(0, 6));

  setInnerHTML(host, `
    <div class="syncq-bar">
      <button class="syncq-btn" id="sqPull" title="用云端最新快照整包覆盖本机（需确认）">↓ 同步到本地</button>
      <button class="syncq-btn syncq-btn-primary" id="sqPush" title="把本机数据加密上传为云端快照">↑ 同步到云</button>
      <span class="syncq-times" title="上次上传 / 上次下载">↑${fmtTime(st.lastPush)} · ↓${fmtTime(st.lastPull)}</span>
      <button class="syncq-btn syncq-btn-ghost" id="sqToggle" title="快照命名与快照列表">快照 ${expanded ? '▴' : '▾'}</button>
      ${st.lastError ? '<span class="syncq-err" title="' + escapeHtml(st.lastError) + '">同步异常</span>' : ''}
    </div>
    <div class="syncq-panel" id="sqPanel" ${expanded ? '' : 'hidden'}>
      <div class="syncq-row" title="云端快照按此名称归属；修改在下次「同步到云」上传后生效">
        <label class="syncq-lab">快照名称</label>
        <input id="sqName" class="syncq-input" type="text" placeholder="（未设置将显示为 device-xxx）" value="${escapeHtml(cfgCache.deviceName || '')}">
        <button class="syncq-btn" id="sqNameSave">保存</button>
      </div>
      <div class="syncq-toolbar">
        <label class="syncq-lab"><input type="checkbox" id="sqSelAll"> 全选</label>
        <button class="syncq-btn syncq-btn-danger" id="sqDelSel" disabled>删除选中</button>
        <button class="syncq-btn" id="sqMerge" disabled title="把选中的 2 份以上快照合并为一份新快照">合并</button>
        <button class="syncq-btn" id="sqRefresh">刷新</button>
      </div>
      <div id="sqList" class="syncq-list"><div class="syncq-muted">展开时自动加载云端快照列表。</div></div>
    </div>
  `);

  host.querySelector('#sqPush').addEventListener('click', async () => {
    toast('同步到云…');
    const res = await sendD1({ type: 'd1SyncPush' });
    reportResult(res, '同步到云');
    render();
  });
  host.querySelector('#sqPull').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '同步到本地（覆盖本机）',
      message: '将拉取云端最新的一份快照，整包替换本机的标签收纳数据：\n· 本机自上次上传以来的全部改动会丢失，不可恢复；\n· 如本机有想保留的改动，先点「同步到云」备份。\n\n确定用云端最新快照覆盖本机？',
      confirmText: '覆盖本机', danger: true,
    });
    if (!ok) return;
    toast('同步到本地…');
    const res = await sendD1({ type: 'd1SyncPull' });
    reportResult(res, '同步到本地');
    render();
  });
  host.querySelector('#sqToggle').addEventListener('click', async () => {
    expanded = !expanded;
    render();
    if (expanded && !listLoaded) loadList();
  });
  host.querySelector('#sqNameSave').addEventListener('click', async () => {
    const deviceName = host.querySelector('#sqName').value.trim();
    if (deviceName === (cfgCache.deviceName || '').trim()) return;
    const sr = await sendD1({ type: 'd1SyncSaveConfig', config: { deviceName } });
    if (!sr.ok) { toast('保存失败：' + sr.error, true); return; }
    toast(cfgCache.keepOldSnapshots
      ? '快照名称已保存，下次「同步到云」上传后生效（旧名快照保留）'
      : '快照名称已保存，下次「同步到云」上传后生效（旧名快照自动清理）');
    render();
  });
  host.querySelector('#sqRefresh').addEventListener('click', () => loadList());
  host.querySelector('#sqSelAll').addEventListener('change', (e) => {
    const list = host.querySelector('#sqList');
    list.querySelectorAll('.syncq-check').forEach((b) => { b.checked = e.target.checked; });
    syncSel();
  });
  host.querySelector('#sqDelSel').addEventListener('click', async () => {
    const names = [...host.querySelectorAll('.syncq-check:checked')].map((b) => b.dataset.name);
    if (!names.length) return;
    if (!(await confirmDialog({
      title: '删除选中的云端快照',
      message: `删除 ${names.length} 台设备的云端快照？\n${names.map((n) => '· ' + n).join('\n')}\n\n删除即最终删除；本机数据不受影响。`,
      confirmText: '删除选中', danger: true,
    }))) return;
    let ok = 0, fail = 0;
    for (const name of names) {
      const r2 = await sendD1({ type: 'd1SyncDeleteSnapshot', deviceName: name });
      if (r2.ok) ok++; else fail++;
    }
    toast(fail ? `删除完成：成功 ${ok}，失败 ${fail}` : `已删除 ${ok} 份云端快照`, fail > 0);
    loadList();
  });
  host.querySelector('#sqMerge').addEventListener('click', async () => {
    const names = [...host.querySelectorAll('.syncq-check:checked')].map((b) => b.dataset.name);
    if (names.length < 2) { toast('合并快照需至少选中 2 份', true); return; }
    const res = await formDialog({
      title: '合并快照',
      note: `将把选中的 ${names.length} 份快照合并为一份新快照（同一条记录取修改时间较新的版本，原有快照保留）：\n${names.map((n) => '· ' + n).join('\n')}`,
      fields: [{ key: 'name', label: '新快照名称', type: 'text', placeholder: '例如：合并备份' }],
      confirmText: '合并',
    });
    if (!res) return;
    const newName = (res.name || '').trim();
    if (!newName) { toast('请输入新快照名称', true); return; }
    toast('正在合并快照…');
    let r2 = await sendD1({ type: 'd1SyncMergeSnapshots', deviceNames: names, newName });
    if (!r2.ok && r2.conflict) {
      const over = await confirmDialog({
        title: '云端已存在同名快照',
        message: `云端已存在名为「${newName}」的快照。\n合并结果将覆盖它（选中的原快照保留不动）。确定覆盖？`,
        confirmText: '覆盖', danger: true,
      });
      if (!over) return;
      r2 = await sendD1({ type: 'd1SyncMergeSnapshots', deviceNames: names, newName, overwrite: true });
    }
    if (r2.ok) toast(`合并完成：${r2.count} 条记录已保存为新快照「${r2.deviceName || newName}」`);
    else toast('合并失败：' + (r2.error || '未知错误'), true);
    loadList();
  });

  if (expanded && !listLoaded) loadList({ force: false });
}

function syncSel() {
  const boxes = [...host.querySelectorAll('.syncq-check')];
  const checked = boxes.filter((b) => b.checked).length;
  host.querySelector('#sqDelSel').disabled = !checked;
  host.querySelector('#sqMerge').disabled = checked < 2;
  const all = host.querySelector('#sqSelAll');
  if (all) all.checked = boxes.length > 0 && boxes.every((b) => b.checked);
}

async function loadList({ force = true } = {}) {
  const list = host?.querySelector('#sqList');
  if (!list) return;
  if (!force && listLoaded) return; // 懒加载：已读过且未强制时直接用缓存
  listLoaded = true;
  const res = await sendD1({ type: 'd1SyncListSnapshots' });
  if (!res.ok) {
    setInnerHTML(list, `<div class="syncq-err">读取失败：${escapeHtml(res.error || '未知错误')}</div>`);
    return;
  }
  if (!res.devices.length) {
    setInnerHTML(list, '<div class="syncq-muted">云端还没有任何快照。先点「↑ 同步到云」。</div>');
    return;
  }
  setInnerHTML(list, res.devices.map((d) => {
    const mine = d.device_name === myName;
    return `
    <div class="syncq-item${mine ? ' syncq-mine' : ''}">
      <input type="checkbox" class="syncq-check" data-name="${escapeHtml(d.device_name)}">
      <span class="syncq-item-name" title="${escapeHtml(d.device_name)}">${escapeHtml(d.device_name)}${mine ? ' <span class="syncq-badge">本机</span>' : ''}</span>
      <span class="syncq-item-time">${fmtTime(d.updated_at)}</span>
      <button class="syncq-btn" data-restore="${escapeHtml(d.device_name)}" title="用该快照整体替换本机标签收纳">恢复</button>
    </div>`;
  }).join(''));
  list.querySelectorAll('.syncq-check').forEach((b) => b.addEventListener('change', syncSel));
  syncSel();
  list.querySelectorAll('button[data-restore]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!(await confirmDialog({
        title: '从云端快照恢复',
        message: `将把云端「${b.dataset.restore}」的最新快照整体替换到本机：\n· 本机标签收纳数据被覆盖，恢复之后的本机改动会丢失；\n· 书签整树同样被替换（该快照未含书签时保持不变）。\n确定恢复？`,
        confirmText: '恢复到本机', danger: true,
      }))) return;
      toast('正在从云端恢复…');
      const r = await sendD1({ type: 'd1SyncRestoreFromSnapshot', deviceName: b.dataset.restore });
      if (r.ok) {
        const parts = [`恢复完成：${r.count ?? '?'} 条记录`];
        if (r.bookmarksApplied) parts.push('书签已整树替换');
        else if (r.bookmarkSkip) parts.push('书签未替换：' + r.bookmarkSkip);
        toast(parts.join(' · '));
      } else toast('恢复失败：' + (r.error || '未知错误'), true);
      render();
      if (expanded) loadList();
    });
  });
}

// 云端同步状态变化 → 重渲染快捷条（模块级只注册一次；未配置时渲染为空即可）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'd1SyncUpdated' && host) render();
});

export async function renderQuickBar(mount) {
  host = mount;
  await render();
}
