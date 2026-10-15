// 数据工具（按栏目拆分）：
//   renderHistoryTools —— 「浏览历史」栏目：自动记录开关、导入 Chrome 历史、
//                          JSON 备份导出/导入、CSV 导出、存储用量与清空
//   renderStashTools   —— 「标签收纳」栏目：OneTab 兼容的 JSON/HTML 导出与 JSON 导入
// 书签栏目没有文件级导出导入（书签即 Chrome 原生书签，管理入口在浏览页的"书签"模式），
// 由 settings-view 直接渲染说明与跳转按钮。
// 所有操作的状态与错误都直接显示在页面上（不只 toast），失败信息保持可见。

import { queryVisits, counts, clearAllData, getSetting, setSetting } from '../../lib/db.js';
import { getBookmarkedUrlSet } from '../../lib/bookmarks.js';
import {
  importChromeHistory, buildJSONExport, downloadJSON, importJSON,
  buildCSV, downloadCSV,
} from '../../lib/io.js';
import { downloadStashJSON, downloadStashHtml, parseStashJSON } from '../../lib/stash-export.js';
import { buildFullBackup, importFullBackup } from '../../lib/full-backup.js';
import { setInnerHTML, downloadBlob, timestampForFilename } from '../../lib/util.js';
import { confirmDialog } from '../../lib/dialog.js';
import { toast } from '../dashboard.js';

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

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

// ---------------------------------------------------------------- 浏览历史
//
// 结构范式（对齐 settings-clutter-analysis.md B/C/D/E）：
// 每个操作一个 .set-row（标题+说明 …… 控件），一个操作只有一个 .set-status
// 状态位（进度并入状态文字）；文件选择统一为「点按钮 → 隐藏 file input →
// 选中即开始」，原生 file 框不再裸露。

/** 「总备份」独立栏目：四类数据（浏览历史/标签收纳/书签/意外关闭存档）
 *  打包为一个 JSON 文件导出，或从该文件整体恢复（合并/覆盖两种模式）。
 *  放在设置页独立分区（浏览历史上方），与各单类备份入口分开。 */
export async function renderFullBackupTools(host) {
  setInnerHTML(host, `
    <div class="set-sub">
      <h3>总备份（全部数据 · 一个文件）</h3>
      <div class="set-row">
        <div class="set-row-main">
          <div class="set-row-title">导出总备份（JSON）</div>
          <div class="set-row-desc">标签收纳 + 浏览历史 + 书签 + 意外关闭存档，四类数据打进一个文件，随时整体搬移。</div>
        </div>
        <div class="set-row-ctrl">
          <button class="btn primary" id="btnFullExport">导出总备份</button>
        </div>
      </div>
      <div class="set-row">
        <div class="set-row-main">
          <div class="set-row-title">导入总备份</div>
          <div class="set-row-desc">合并：浏览历史去重合并、书签挂进新建文件夹、存档组取并集（标签收纳为整包替换）。覆盖：四类数据全部以备份文件为准，本机现有内容被替换——不可恢复。</div>
        </div>
        <div class="set-row-ctrl">
          <select id="fullMode" title="导入模式">
            <option value="merge">合并导入</option>
            <option value="overwrite">覆盖导入</option>
          </select>
          <input type="file" id="fullFile" accept=".json,application/json" hidden>
          <button class="btn" id="btnFullImport">选择文件导入…</button>
        </div>
      </div>
      <div class="set-status" id="fullStatus"></div>
    </div>
  `);

  const $ = (id) => host.querySelector('#' + id);
  const fullStatus = $('fullStatus');
  const setStatus = (el, text, cls = '') => {
    el.textContent = text;
    el.className = `set-status${cls ? ' ' + cls : ''}`;
  };

  $('btnFullExport').addEventListener('click', async () => {
    const btn = $('btnFullExport');
    btn.disabled = true;
    setStatus(fullStatus, '正在打包四类数据…');
    try {
      const dump = await buildFullBackup({
        onProgress: (step) => setStatus(fullStatus, `正在打包：${
          { history: '浏览历史', stash: '标签收纳', bookmarks: '书签', crash: '意外关闭存档' }[step] || step}…`),
      });
      const c = dump.counts || {};
      const text = JSON.stringify(dump, null, 1);
      downloadBlob(new Blob([text], { type: 'application/json' }),
        `浏览库总备份_${timestampForFilename()}.json`);
      setStatus(fullStatus,
        `导出完成：${(c.visits || 0).toLocaleString()} 条访问 · ${(c.stashTabs || 0).toLocaleString()} 个收纳标签 · `
        + `${(c.bookmarks || 0).toLocaleString()} 个书签 · ${c.crashGroups || 0} 组存档，共 ${fmtBytes(text.length)}。`, 'ok');
      toast('总备份导出完成');
    } catch (e) {
      setStatus(fullStatus, '导出失败：' + (e.message || e), 'err');
      toast('总备份导出失败：' + (e.message || e), true);
    } finally {
      btn.disabled = false;
    }
  });

  $('btnFullImport').addEventListener('click', () => $('fullFile').click());
  $('fullFile').addEventListener('change', async () => {
    const file = $('fullFile').files?.[0];
    $('fullFile').value = '';
    if (!file) return;
    const mode = $('fullMode').value;
    try {
      setStatus(fullStatus, `正在解析文件 ${file.name}…`);
      const dump = JSON.parse(await file.text());
      if (dump?.kind !== 'full-backup') throw new Error('这不是「总备份」文件——单类备份请用各自栏目的导入入口。');
      const c = dump.counts || {};
      if (!(await confirmDialog({
        title: mode === 'overwrite' ? '覆盖导入总备份' : '合并导入总备份',
        message: mode === 'overwrite'
          ? `以备份文件为准整体覆盖本机：\n· 浏览历史先清空再导入（${(c.visits || 0).toLocaleString()} 条）；\n· 标签收纳整包替换（${(c.stashTabs || 0).toLocaleString()} 个标签）；\n· 书签整树替换为备份版本（${(c.bookmarks || 0).toLocaleString()} 个）；\n· 意外关闭存档整包覆盖。\n本机现有内容会被替换且不可恢复。建议先"导出总备份"留存现状。\n\n确定覆盖？`
          : `把备份内容并入本机：\n· 浏览历史去重合并（新增不覆盖已有）；\n· 标签收纳整包替换为备份版本（${(c.stashTabs || 0).toLocaleString()} 个标签）；\n· 书签挂进书签栏下新建的"导入的书签"文件夹，现有书签不动；\n· 意外关闭存档组取并集。\n\n确定导入？`,
        confirmText: mode === 'overwrite' ? '覆盖导入' : '合并导入',
        danger: mode === 'overwrite',
      }))) { setStatus(fullStatus, '已取消导入。'); return; }

      setStatus(fullStatus, '正在导入…');
      const r = await importFullBackup(JSON.stringify(dump), {
        mode,
        sendD1,
        onProgress: (step, detail) => setStatus(fullStatus, detail || `正在导入：${step}…`),
      });
      const parts = [];
      if (r.history) parts.push(`浏览历史 +${r.history.added ?? '?'} 条`);
      if (r.stash) parts.push(`标签收纳 ${r.stash.count} 条已替换`);
      if (r.bookmarks) parts.push(r.bookmarks.mode === 'overwrite'
        ? `书签整树替换（新建 ${r.bookmarks.created}${r.bookmarks.failed ? `，${r.bookmarks.failed} 个旧节点删除失败` : ''}）`
        : `书签已挂入新文件夹（${r.bookmarks.created} 个节点）`);
      if (r.crash) parts.push(`存档组 ${r.crash.count} 组${r.crash.added ? `（新增 ${r.crash.added}）` : ''}`);
      setStatus(fullStatus, '导入完成：' + parts.join(' · '), 'ok');
      toast('总备份导入完成');
    } catch (e) {
      setStatus(fullStatus, '导入失败：' + (e.message || e), 'err');
      toast('总备份导入失败：' + (e.message || e), true);
    }
  });
}

export async function renderHistoryTools(host) {
  const recordEnabled = await getSetting('recordEnabled', true);

  setInnerHTML(host, `
    <div class="set-sub set-overview">
      <div class="set-row">
        <div class="set-row-main">
          <div class="set-row-title">自动记录</div>
          <div class="set-row-desc" id="storageInfo">正在统计本机档案…</div>
          <div class="set-row-desc">关闭后不再新增记录，已有档案与查询不受影响。</div>
        </div>
        <div class="set-row-ctrl">
          <label class="switch" title="记录新的浏览访问"><input type="checkbox" id="swRecord" ${recordEnabled ? 'checked' : ''}><span class="track"></span></label>
        </div>
      </div>
    </div>

    <div class="set-sub">
      <h3>备份与恢复</h3>
      <div class="set-row">
        <div class="set-row-main">
          <div class="set-row-title">导出备份（JSON）</div>
          <div class="set-row-desc">全部浏览历史与设置存为文件，不含标签收纳与书签。建议每 3~6 个月一次。</div>
        </div>
        <div class="set-row-ctrl">
          <button class="btn primary" id="btnJsonExport">导出 JSON</button>
        </div>
      </div>
      <div class="set-row">
        <div class="set-row-main">
          <div class="set-row-title">导入备份（JSON）</div>
          <div class="set-row-desc">合并导入保留现有、跳过重复；覆盖导入先清空浏览记录再导入。标签收纳与书签不受影响。</div>
        </div>
        <div class="set-row-ctrl">
          <select id="jsonMode" title="导入模式">
            <option value="merge">合并导入</option>
            <option value="overwrite">覆盖导入</option>
          </select>
          <input type="file" id="jsonFile" accept=".json,application/json" hidden>
          <button class="btn" id="btnJsonImport">选择文件导入…</button>
        </div>
      </div>
      <div class="set-row">
        <div class="set-row-main">
          <div class="set-row-title">导出 CSV</div>
          <div class="set-row-desc">全部访问记录逐条导出为表格（时间/标题/网址/域名/访问方式/收藏），适合 Excel 查看分析；不能用于导入恢复。</div>
        </div>
        <div class="set-row-ctrl">
          <button class="btn" id="btnCsvExport">导出 CSV</button>
        </div>
      </div>
      <div class="set-status" id="historyStatus"></div>
    </div>

    <div class="set-sub">
      <h3>迁移：导入 Chrome 历史</h3>
      <div class="set-row">
        <div class="set-row-main">
          <div class="set-row-title">从 Chrome 导入</div>
          <div class="set-row-desc">把 Chrome 自带历史（含访问时间与方式）并入本扩展；可反复执行，重复记录自动跳过。</div>
        </div>
        <div class="set-row-ctrl">
          <select id="chromeSince">
            <option value="0">全部时间</option>
            <option value="30">最近 30 天</option>
            <option value="90">最近 90 天</option>
            <option value="365">最近一年</option>
          </select>
          <button class="btn" id="btnChromeImport">导入</button>
        </div>
      </div>
      <div class="set-status" id="chromeStatus"></div>
    </div>

    <details class="set-sub danger-zone">
      <summary>危险操作（点击展开）</summary>
      <div class="set-row">
        <div class="set-row-main">
          <div class="set-row-title">清空全部浏览记录</div>
          <div class="set-row-desc">仅清空浏览历史；标签收纳与书签不受影响；不可恢复，请先备份。</div>
        </div>
        <div class="set-row-ctrl">
          <button class="btn danger" id="btnClear">清空全部浏览记录…</button>
        </div>
      </div>
    </details>
  `);

  const $ = (id) => host.querySelector('#' + id);
  const historyStatus = $('historyStatus'), chromeStatus = $('chromeStatus');
  /** 唯一反馈出口：进度并入状态文字，一个操作只有一个看结果的地方。 */
  const setStatus = (el, text, cls = '') => {
    el.textContent = text;
    el.className = `set-status${cls ? ' ' + cls : ''}`;
  };

  // ---- 总备份（handlers 已迁至 renderFullBackupTools，独立栏目） ----

  // ---- 自动记录开关 ----
  $('swRecord').addEventListener('change', async (e) => {
    await setSetting('recordEnabled', e.target.checked);
    try {
      chrome.runtime.sendMessage({ type: 'prefs-changed' }, () => void chrome.runtime.lastError);
    } catch { /* SW 不可用时忽略 */ }
    toast(e.target.checked ? '已恢复记录' : '已暂停记录');
  });

  // ---- 存储用量 ----
  (async () => {
    const withTimeout = (p, ms, tag) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(tag + '超时')), ms)),
    ]);
    try {
      const [est, c] = await Promise.all([
        withTimeout(navigator.storage.estimate?.() ?? Promise.resolve(null), 5000, '读取存储用量'),
        withTimeout(counts(), 8000, '读取档案统计'),
      ]);
      $('storageInfo').textContent = est
        ? `已用约 ${fmtBytes(est.usage)}（配额约 ${fmtBytes(est.quota)}）· ${c.visits.toLocaleString()} 次访问 / ${c.urls.toLocaleString()} 个网址 / ${c.websites.toLocaleString()} 个站点`
        : `${c.visits.toLocaleString()} 次访问 / ${c.urls.toLocaleString()} 个网址 / ${c.websites.toLocaleString()} 个站点`;
    } catch (e) {
      $('storageInfo').textContent = '读取失败：' + (e?.message || e);
    }
  })();

  // ---- Chrome 历史导入 ----
  $('btnChromeImport').addEventListener('click', async () => {
    const days = Number($('chromeSince').value);
    const startTime = days > 0 ? Date.now() - days * 86_400_000 : 0;
    $('btnChromeImport').disabled = true;
    setStatus(chromeStatus, '正在读取 Chrome 历史…');
    try {
      const r = await importChromeHistory({
        startTime,
        onProgress: (phase, done, total, extra) => {
          const label = phase === 'search' ? '读取 Chrome 历史'
            : phase === 'expand' ? '展开访问明细'
            : '写入历史记录';
          setStatus(chromeStatus, `${label}… ${done.toLocaleString()}${total ? ` / ${total.toLocaleString()}` : ''}`
            + (extra ? `（新增 ${extra.added.toLocaleString()}，重复 ${extra.skipped.toLocaleString()}${extra.failed ? `，失败 ${extra.failed.toLocaleString()}` : ''}）` : ''));
        },
      });
      setStatus(chromeStatus, r.total === 0
        ? 'Chrome 历史为空（或所选时间范围内没有记录），没有可导入的数据。'
        : `导入完成：共读取 ${r.total.toLocaleString()} 条，新增 ${r.added.toLocaleString()} 条，跳过重复 ${r.skipped.toLocaleString()} 条`
          + (r.failed ? `，失败跳过 ${r.failed.toLocaleString()} 条` : '') + '。', 'ok');
      toast('Chrome 历史导入完成');
    } catch (e) {
      setStatus(chromeStatus, '导入失败：' + (e.message || e), 'err');
      toast('导入失败，详情见页面上方说明', true);
    } finally {
      $('btnChromeImport').disabled = false;
    }
  });

  // ---- JSON 导出 ----
  $('btnJsonExport').addEventListener('click', async () => {
    $('btnJsonExport').disabled = true;
    try {
      setStatus(historyStatus, '正在收集数据…');
      const json = await buildJSONExport((store, n) => {
        setStatus(historyStatus, `正在收集 ${store}：${n.toLocaleString()} 条`);
      });
      downloadJSON(json);
      setStatus(historyStatus, `已生成并下载浏览历史备份文件（${fmtBytes(json.length)}），位于浏览器默认下载目录。`, 'ok');
      toast('浏览历史 JSON 备份已导出');
    } catch (e) {
      setStatus(historyStatus, '导出失败：' + (e.message || e), 'err');
      toast('导出失败：' + (e.message || e), true);
    } finally {
      $('btnJsonExport').disabled = false;
    }
  });

  // ---- JSON 导入（点按钮 → 隐藏 file input → 选中即开始；D：交互模型与标签收纳一致） ----
  $('btnJsonImport').addEventListener('click', () => $('jsonFile').click());
  $('jsonFile').addEventListener('change', async () => {
    const file = $('jsonFile').files?.[0];
    $('jsonFile').value = ''; // 允许连续导入同一个文件
    if (!file) return;
    const mode = $('jsonMode').value;
    if (mode === 'overwrite') {
      if (!(await confirmDialog({
        title: '覆盖导入',
        message: '覆盖模式将先清空现有全部浏览记录（保留设置，标签收纳与书签不受影响），然后导入备份。\n确定继续？',
        confirmText: '清空并导入', danger: true,
      }))) return;
    }
    $('btnJsonImport').disabled = true;
    setStatus(historyStatus, `正在解析文件 ${file.name}…`);
    try {
      const content = await file.text();
      const r = await importJSON(content, {
        mode,
        onProgress: (phase, done, total, extra) => {
          setStatus(historyStatus, `写入历史记录… ${done.toLocaleString()} / ${total.toLocaleString()}`
            + (extra ? `（新增 ${extra.added.toLocaleString()}，重复 ${extra.skipped.toLocaleString()}${extra.failed ? `，失败 ${extra.failed.toLocaleString()}` : ''}）` : ''));
        },
      });
      setStatus(historyStatus,
        `导入完成：共读取 ${r.total.toLocaleString()} 条，新增 ${r.added.toLocaleString()} 条，跳过重复 ${r.skipped.toLocaleString()} 条`
        + (r.failed ? `，失败跳过 ${r.failed.toLocaleString()} 条` : '')
        + (r.invalid ? `，忽略无效行 ${r.invalid} 条` : '') + '。', 'ok');
      toast('浏览历史 JSON 导入完成');
    } catch (e) {
      setStatus(historyStatus, '导入失败：' + (e.message || e), 'err');
      toast('导入失败，详情见页面说明', true);
    } finally {
      $('btnJsonImport').disabled = false;
    }
  });

  // ---- CSV 导出（全量分批游标） ----
  $('btnCsvExport').addEventListener('click', async () => {
    $('btnCsvExport').disabled = true;
    try {
      setStatus(historyStatus, '准备…');
      // 收藏状态取自浏览器书签
      const starredSet = await getBookmarkedUrlSet();
      const chunks = [];
      let total = 0;
      let cursor = null;
      let firstBatch = true;
      do {
        const r = await queryVisits({ startTime: 0, limit: 5000, cursor, maxScan: Infinity });
        const csv = buildCSV(r.items, starredSet); // "\uFEFF" + 表头行 + 数据行
        chunks.push(firstBatch ? csv : csv.slice(csv.indexOf('\r\n') + 2));
        firstBatch = false;
        total += r.items.length;
        setStatus(historyStatus, `已收集 ${total.toLocaleString()} 条…`);
        cursor = r.nextCursor;
      } while (cursor);
      downloadCSV('\uFEFF' + chunks.join('\r\n'));
      setStatus(historyStatus, `已导出 ${total.toLocaleString()} 条到浏览器默认下载目录。`, 'ok');
      toast('CSV 已导出');
    } catch (e) {
      setStatus(historyStatus, '导出失败：' + (e.message || e), 'err');
      toast('CSV 导出失败', true);
    } finally {
      $('btnCsvExport').disabled = false;
    }
  });

  // ---- 清空（对话框内确认，不再常驻输入解锁框：危险区不再常占一块，R10/F） ----
  $('btnClear').addEventListener('click', async () => {
    if (!(await confirmDialog({
      title: '清空全部浏览记录',
      message: '即将清空全部浏览记录。\n标签收纳与书签不受影响；此操作不可恢复，请确认已有备份。\n\n确定清空？',
      confirmText: '确认清空', danger: true,
    }))) return;
    try {
      await clearAllData({ keepSettings: true });
      toast('已清空全部浏览记录');
      renderHistoryTools(host);
    } catch (e) {
      toast('清空失败：' + (e.message || e), true);
    }
  });
}

// ---------------------------------------------------------------- 标签收纳

export async function renderStashTools(host) {
  const deleteForever = await getSetting('stashOpenDeleteForever', false);
  setInnerHTML(host, `
    <div class="set-sub">
      <div class="set-row">
        <div class="set-row-main">
          <div class="set-row-title">「打开后消除」行为</div>
          <div class="set-row-desc">勾选「打开后消除」的分组，打开标签后记录移入<b>回收站</b>（可在回收站「消除回收」区移回）。开启开关后改为直接彻底删除，不经过回收站。</div>
        </div>
        <div class="set-row-ctrl">
          <label class="switch" title="打开后直接彻底删除记录"><input type="checkbox" id="swStashDeleteForever" ${deleteForever ? 'checked' : ''}><span class="track"></span></label>
        </div>
      </div>
    </div>

    <div class="set-sub">
      <h3>备份与迁移</h3>
      <div class="set-row">
        <div class="set-row-main">
          <div class="set-row-title">导出</div>
          <div class="set-row-desc">完整备份标签收纳（分组/文件夹/标签/备注/回收站），OneTab 兼容格式；HTML 为静态查看文件，不能用于导入。</div>
        </div>
        <div class="set-row-ctrl">
          <button class="btn primary" id="btnStashJsonExport">导出 JSON</button>
          <button class="btn" id="btnStashHtmlExport">导出 HTML</button>
        </div>
      </div>
      <div class="set-row">
        <div class="set-row-main">
          <div class="set-row-title">导入（JSON）</div>
          <div class="set-row-desc">导入 OneTab 或本扩展导出的备份，整体替换本机标签收纳；浏览历史与书签不受影响；导入后自动同步暂停。</div>
        </div>
        <div class="set-row-ctrl">
          <input type="file" id="stashFile" accept=".json,application/json" hidden>
          <button class="btn" id="btnStashImport" title="选择 OneTab 或本扩展导出的 JSON 文件">选择文件导入…</button>
        </div>
      </div>
      <div class="set-status" id="stashStatus"></div>
    </div>
  `);

  const $ = (id) => host.querySelector('#' + id);
  const stashStatus = $('stashStatus');
  const setStatus = (text, cls = '') => {
    stashStatus.textContent = text;
    stashStatus.className = `set-status${cls ? ' ' + cls : ''}`;
  };

  $('swStashDeleteForever').addEventListener('change', async (e) => {
    try {
      await setSetting('stashOpenDeleteForever', e.target.checked);
      toast(e.target.checked
        ? '「打开后消除」已改为直接彻底删除'
        : '「打开后消除」已改为移入回收站');
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast('保存设置失败：' + (err.message || err), true);
    }
  });

  $('btnStashJsonExport').addEventListener('click', async () => {
    try {
      const size = await downloadStashJSON();
      setStatus(`已导出标签收纳 JSON（OneTab 兼容格式，${fmtBytes(size)}），不含浏览历史与书签。`, 'ok');
      toast('标签收纳 JSON 已导出');
    } catch (e) {
      setStatus('导出失败：' + (e.message || e), 'err');
    }
  });
  $('btnStashHtmlExport').addEventListener('click', async () => {
    try {
      const n = await downloadStashHtml();
      setStatus(`已导出标签收纳 HTML（静态查看文件，共 ${n} 个标签），不可用于导入。`, 'ok');
      toast('标签收纳 HTML 已导出');
    } catch (e) {
      setStatus('导出失败：' + (e.message || e), 'err');
    }
  });
  // 与浏览历史一致的交互模型：点按钮 → 选文件 → 确认替换 → 开始（D）
  $('btnStashImport').addEventListener('click', () => $('stashFile').click());
  $('stashFile').addEventListener('change', async () => {
    const file = $('stashFile').files?.[0];
    $('stashFile').value = ''; // 允许连续导入同一个文件
    if (!file) return;
    try {
      setStatus(`正在解析文件 ${file.name}…`);
      const items = parseStashJSON(await file.text());
      if (!(await confirmDialog({
        title: '导入标签收纳',
        message: `导入将替换本机全部标签收纳数据（${items.length} 条记录，含分组/文件夹/回收站）。\n浏览历史与书签不受影响。\n确定继续？建议先"导出标签收纳 (JSON)"备份。`,
        confirmText: '导入并替换', danger: true,
      }))) { setStatus('已取消导入。'); return; }
      const r = await sendD1({ type: 'd1SyncImport', items });
      if (!r.ok) throw new Error(r.error || '导入失败');
      setStatus(`导入完成：${items.length} 条记录已替换本机标签收纳数据。自动同步已暂停，确认无误后请在云同步区手动同步。`, 'ok');
      toast('标签收纳导入完成');
    } catch (e) {
      setStatus('导入失败：' + (e.message || e), 'err');
      toast('导入失败：' + (e.message || e), true);
    }
  });
}
