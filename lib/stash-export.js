// 标签收纳的导出/导入 —— 与 OneTab 2.21 完全兼容。
//
// JSON：onetap-full-backup v2 格式（format/v/exportedAt/itemCount/items），
//       可直接导入回 OneTab 2.21（其"备份与同步"页的完整导入），反之亦然。
// HTML：复刻 OneTab "保存为 HTML 文件" 的页面模板与样式（模板与 CSS 原样保留，
//       方便与 OneTab 导出文件对照或再导入其它工具）。

import { readAllStashItems, readStashSubtree } from './stash.js';
import { downloadBlob, timestampForFilename } from './util.js';

const NL = String.fromCharCode(10);

function escHtml(t) {
  return String(t == null ? '' : String(t))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(t) {
  return String(t == null ? '' : String(t))
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** notes 兼容 OneTab 的 {text:[...]} 数组结构。 */
function notesOf(item) {
  const t = item?.notes?.text;
  if (!t) return '';
  return Array.isArray(t) ? t.join('\n') : String(t);
}

// ---------------------------------------------------------------- JSON 导出

/** 构建与 OneTab 互相兼容的完整备份 JSON 字符串。 */
export async function buildStashJSON() {
  const byId = await readAllStashItems();
  const items = [...byId.values()];
  return JSON.stringify({
    format: 'onetap-full-backup',
    v: 2,
    exportedAt: Date.now(),
    itemCount: items.filter((i) => i && i.type === 'tab').length,
    items,
  }, null, 1);
}

export async function downloadStashJSON() {
  const json = await buildStashJSON();
  downloadBlob(new Blob([json], { type: 'application/json' }), `标签收纳备份_${timestampForFilename()}.json`);
  return json.length;
}

// ---------------------------------------------------------------- HTML 导出

// 与 OneTab 2.21 导出文件同一套模板（d1-sync.js exportHtmlAll 的结构逐行对应）。
function countOf(byId, it) {
  if (!it) return 0;
  if (it.type === 'tab') return 1;
  let n = 0;
  for (const cid of it.childIds || []) {
    const c = byId.get(cid);
    if (c && c.type === 'tab') n++;
    else if (c && c.type === 'group') n += countOf(byId, c);
  }
  return n;
}

function renderChildren(byId, it, level) {
  const step = 20;
  let out = '';
  let idx = 0;
  for (const cid of it.childIds || []) {
    const c = byId.get(cid);
    if (!c) continue;
    const padA = level ? level * step : 0;
    const padB = (level + 1) * step;
    if (c.type === 'tab') {
      const url = escAttr(c.url || '');
      const title = escHtml(c.title || c.url || '');
      const notes = notesOf(c) ? '<div class="tabNotes">' + escHtml(notesOf(c)) + '</div>' : '';
      out += '<div class="tab" style="padding-inline-start: ' + padA + 'px;"><a class="tabLink" dir="auto" href="' + url + '">' + title + '</a>' + notes + '</div>';
      idx++;
    } else if (c.type === 'group') {
      const gtitle = escHtml(c.label || '');
      out += '<div class="innerGroupBlock" style="margin-top: ' + (idx ? 8 : 2) + 'px;">' + NL +
        '        <div class="innerGroupTitleText" style="padding-inline-start: ' + padB + 'px;"><span dir="auto">' + gtitle + '</span></div>';
      if (notesOf(c)) out += '<div class="innerGroupNotes" style="padding-inline-start: ' + padB + 'px;">' + escHtml(notesOf(c)) + '</div>';
      out += renderChildren(byId, c, level + 1);
      out += '</div>';
      idx++;
    }
  }
  return out;
}

function renderGroup(byId, it) {
  const n = countOf(byId, it);
  const gtitle = escHtml(it.label || '');
  const countText = n + ' 个标签';
  const created = it.createDate
    ? '<div class="createdDate">' + escHtml('创建于 ' + new Date(it.createDate).toLocaleDateString('zh-CN')) + '</div>'
    : '';
  return '<div class="tabGroup">' + NL +
    '      <div class="tabGroupHeader">' + NL +
    '        <div class="tabGroupHeaderRow">' + NL +
    '          <div class="tabGroupTitleText"><span dir="auto">' + (gtitle || countText) + '</span></div>' + NL +
    (gtitle ? '          <div class="tabCountInline">' + countText + '</div>' + NL : '') +
    '        </div>' + NL +
    (created ? '        ' + created + NL : '') +
    '      </div>' + NL +
    '      <div class="tabList">' + renderChildren(byId, it, 0) + '</div>' + NL +
    '    </div>';
}

/** 生成与 OneTab 导出文件同款的 HTML（含内嵌 CSS）。groupId 时只导出该组；groupIds 导出多组（编辑模式批量导出）。
 *  百万级数据：单组/多组导出只读目标组的子树（readStashSubtree，按层批查），
 *  不再全表扫描；只有"导出全部"才走 readAllStashItems（本就该全量）。 */
export async function buildStashHtml({ groupId = null, groupIds = null } = {}) {
  let byId;
  let topIds;
  let headerTitle;
  if (Array.isArray(groupIds) && groupIds.length) {
    const maps = await Promise.all(groupIds.map((gid) => readStashSubtree(gid)));
    byId = new Map();
    for (const m of maps) for (const [id, n] of m) byId.set(id, n);
    topIds = groupIds;
    headerTitle = `选中 ${groupIds.length} 个分组`;
  } else if (groupId) {
    byId = await readStashSubtree(groupId);
    const g = byId.get(groupId);
    if (!g || g.type !== 'group') throw new Error('分组不存在');
    topIds = [groupId];
    headerTitle = (g.label || '未命名分组') + '（单组导出）';
  } else {
    byId = await readAllStashItems();
    const root = byId.get('root');
    topIds = root && Array.isArray(root.childIds)
      ? root.childIds
      : [...byId.values()].filter((i) => i && i.type === 'group' && i.parentIds?.includes('root')).map((i) => i.id);
    headerTitle = null;
  }
  const sections = [];
  let total = 0;
  for (const tid of topIds) {
    const g = byId.get(tid);
    if (!g || g.type !== 'group') continue;
    sections.push(renderGroup(byId, g));
    total += countOf(byId, g);
  }
  const bodyHtml = sections.length ? sections.join(NL) : '<div id="emptyState">暂无标签</div>';
  const headerHtml = headerTitle
    ? `<div id="headerText">${escHtml(headerTitle)} · 共 ${total} 个标签</div>`
    : `<div id="headerText">共 ${total} 个标签</div>`;
  const CSS = [
    ':root { --text-color: #222; --text-color-weak: #666; --link: #1a0dab; }',
    "body { margin: 0; font-family: 'Open Sans', 'Segoe UI', Arial, sans-serif; color: var(--text-color); background: #fff; line-height: 1.45; }",
    '#contentAreaDiv { max-width: 980px; margin: 0 auto; padding: 22px 28px 44px; }',
    '#headerText { font-size: 16px; color: var(--text-color-weak); font-weight: 300; margin-bottom: 8px; padding-bottom: 14px; }',
    '.tabGroup { margin-top: 16px; background: #fff; }',
    '.tabGroupHeader { padding: 14px 0 10px; }',
    '.tabGroupHeaderRow { display: flex; align-items: baseline; gap: 42px; flex-wrap: wrap; }',
    '.tabGroupTitleText { font-size: 24px; font-weight: 300; word-break: break-word; margin-bottom: 0; }',
    '.tabCountInline { display: inline-block; color: var(--text-color-weak); font-size: 24px; font-weight: 300; }',
    '.createdDate { display: block; color: var(--text-color-weak); font-size: 11px; margin-top: 2px; }',
    '.tabList { padding: 4px 0 8px; }',
    '.tab { padding: 2px 16px 2px 18px; font-size: 13px; word-break: break-word; }',
    '.innerGroupTitleText { padding: 4px 16px 1px 18px; font-size: 16px; font-weight: 300; color: var(--text-color); word-break: break-word; }',
    '.innerGroupBlock { margin-bottom: 10px; }',
    '.innerGroupBlock:last-child { margin-bottom: 0; }',
    '.innerGroupNotes { padding: 0 16px 2px 18px; font-size: 11px; color: var(--text-color-weak); white-space: pre-wrap; word-break: break-word; unicode-bidi: plaintext; }',
    '.tabLink { text-decoration: none; color: var(--link); }',
    '.tabLink:hover { text-decoration: underline; }',
    '.tabNotes { font-size: 11px; color: var(--text-color-weak); margin-top: 2px; white-space: pre-wrap; unicode-bidi: plaintext; }',
    '#emptyState { margin-top: 30px; color: var(--text-color-weak); font-size: 13px; }',
  ].join(NL);
  return {
    html: '<!DOCTYPE html>' + NL +
      '<html dir="ltr">' + NL +
      '<head>' + NL +
      '  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">' + NL +
      '  <title>OneTab 导出</title>' + NL +
      '  <style>' + NL + CSS + NL + '  </style>' + NL +
      '</head>' + NL +
      '<body>' + NL +
      '  <div id="contentAreaDiv">' + NL +
      headerHtml + NL +
      '    <div id="tabGroupsDiv">' + NL + bodyHtml + NL + '    </div>' + NL +
      '  </div>' + NL +
      '</body>' + NL +
      '</html>',
    count: total,
  };
}

export async function downloadStashHtml({ groupId = null, groupIds = null } = {}) {
  const { html, count } = await buildStashHtml({ groupId, groupIds });
  const name = Array.isArray(groupIds) && groupIds.length
    ? `标签分组_${groupIds.length}组_${timestampForFilename()}.html`
    : groupId ? `标签分组_${timestampForFilename()}.html` : `标签收纳_${timestampForFilename()}.html`;
  downloadBlob(new Blob([html], { type: 'text/html' }), name);
  return count;
}

// ---------------------------------------------------------------- 剪贴板导出

/** 递归收集组内全部标签（含子分组），按显示顺序。 */
function collectTabs(byId, g, out = []) {
  for (const cid of g.childIds || []) {
    const c = byId.get(cid);
    if (!c) continue;
    if (c.type === 'tab') out.push(c);
    else if (c.type === 'group') collectTabs(byId, c, out);
  }
  return out;
}

/**
 * 把一个分组的内容构建为剪贴板文本（对齐 OneTab 的复制格式）。
 * fmt: 'text'（"标题 网址"，每行一条）| 'markdown'（- [标题](网址)）
 * 百万级数据：只读该组的子树（按层批查），不再全表扫描。 */
export async function buildGroupClipboard(groupId, fmt = 'text') {
  const byId = await readStashSubtree(groupId);
  const g = byId.get(groupId);
  if (!g || g.type !== 'group') throw new Error('分组不存在');
  const lines = [];
  if (g.label) {
    lines.push(fmt === 'markdown' ? `# ${g.label}` : g.label, '');
  }
  for (const t of collectTabs(byId, g)) {
    const notes = (() => {
      const x = t.notes?.text;
      return x ? (Array.isArray(x) ? x.join(' ') : String(x)) : '';
    })();
    if (fmt === 'markdown') {
      lines.push(`- [${t.title || t.url}](${t.url})` + (notes ? ` — ${notes}` : ''));
    } else {
      lines.push((t.title || t.url) + ' ' + t.url + (notes ? ` （${notes}）` : ''));
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- JSON 导入

/**
 * 解析可导入的备份 JSON，返回 items 数组（校验格式）。
 * 兼容以下形状：
 *  - onetap-full-backup v2：{format, v, items:[...]}（当前「导出 JSON」的格式）
 *  - 旧版经同步通道导出的原始返回值：{ok:true, data:{...items}}（exportAll 的响应体直接存盘）
 *  - 旧版裸数组导出：[{...}, ...]
 * 防呆：浏览历史档案备份（app:'web-history-archive'，data:{visits,urls,websites}）
 * 与标签收纳是两套完全不同的数据结构，一律拒绝并指路正确入口——
 * 强行转换只会得到一堆按域名堆砌的怪分组，用户还以为导入了。
 * 解析失败时抛出带诊断信息的错误（报告文件实际顶层字段），便于判断文件来源。
 */
export function parseStashJSON(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON。若导出时选的是「保存为 HTML」，请改用「导出 JSON」重新备份（HTML 文件不可导入）。');
  }
  // 防呆：这是「浏览历史」的备份，不能导入标签收纳
  if (obj && typeof obj === 'object' && obj.app === 'web-history-archive') {
    const c = obj.counts || {};
    const detail = (c.urls || c.visits)
      ? `（含 ${c.urls || 0} 个网址 / ${c.visits || 0} 条访问记录）`
      : '';
    throw new Error(
      `这是「浏览历史」的备份文件${detail}，不能导入标签收纳——两者数据结构不同。\n` +
      '· 要导入浏览历史：请到「设置 ▸ 数据 ▸ 浏览历史」的「导入 JSON」；\n' +
      '· 要导入标签收纳：请用标签收纳自己「导出 JSON」生成的文件（格式 onetap-full-backup）。');
  }
  // 逐个候选包装层里找 items（顺序即优先级）
  for (const c of [obj, obj?.data, obj?.result, obj?.backup]) {
    if (c && Array.isArray(c.items) && c.items.length) return c.items;
  }
  // 旧版裸数组导出
  if (Array.isArray(obj) && obj.length) return obj;
  // 诊断：把文件实际顶层字段报出来，一眼看出是哪一代格式
  const wrap = obj?.data || obj?.result || obj?.backup || obj;
  if (wrap && typeof wrap === 'object' && Array.isArray(wrap.items)) {
    throw new Error('文件里 items 为空——这是导出时标签收纳本来就没有数据（或旧版导出了空库）。请确认文件来源后重试。');
  }
  const keys = obj && typeof obj === 'object'
    ? Object.keys(obj).slice(0, 10).join('、')
    : `（顶层是 ${Array.isArray(obj) ? '空数组' : typeof obj}）`;
  throw new Error(`文件里没有可导入的标签数据（应为 OneTab/标签收纳的完整备份 JSON）。文件顶层字段为：${keys || '（空对象）'}——与当前格式不符，请确认这是「导出 JSON」生成的文件。`);
}
