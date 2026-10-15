// OneTab D1 Sync Worker
// 部署: wrangler d1 create onetap-sync && wrangler d1 execute onetap-sync --file=schema.sql --remote
//       wrangler secret put SYNC_TOKEN   (自定义一个长随机串,扩展端填同一个)
//       wrangler deploy
// 认证: 所有请求需 Authorization: Bearer <SYNC_TOKEN>。多设备共用一个 token。

// 云端标签浏览页(/view): 静态壳 + 浏览器端解密渲染, 源文件见 src/view.html。
// 用法: https://<worker>/view?token=...&key=...(口令与扩展端加密口令一致, 不经过 Worker)
const VIEW_HTML = "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>web-history 云端标签</title>\n<style>\n  :root { --text-color: #222; --text-color-weak: #666; --link: #1a0dab; }\n  body { margin: 0; font-family: 'Open Sans', 'Segoe UI', Arial, sans-serif; color: var(--text-color); background: #fff; line-height: 1.45; }\n  #contentAreaDiv { max-width: 980px; margin: 0 auto; padding: 22px 28px 44px; }\n  #headerText { font-size: 16px; color: var(--text-color-weak); font-weight: 300; margin-bottom: 8px; padding-bottom: 14px; }\n  .tabGroup { margin-top: 16px; background: #fff; }\n  .tabGroupHeader { padding: 14px 0 10px; }\n  .tabGroupHeaderRow { display: flex; align-items: baseline; gap: 42px; flex-wrap: wrap; }\n  .tabGroupTitleText { font-size: 24px; font-weight: 300; word-break: break-word; margin-bottom: 0; }\n  .tabCountInline { display: inline-block; color: var(--text-color-weak); font-size: 24px; font-weight: 300; }\n  .createdDate { display: block; color: var(--text-color-weak); font-size: 11px; margin-top: 2px; }\n  .tabList { padding: 4px 0 8px; }\n  .tab { padding: 2px 16px 2px 18px; font-size: 13px; word-break: break-word; }\n  .innerGroupTitleText { padding: 4px 16px 1px 18px; font-size: 16px; font-weight: 300; color: var(--text-color); word-break: break-word; }\n  .innerGroupBlock { margin-bottom: 10px; }\n  .innerGroupBlock:last-child { margin-bottom: 0; }\n  .innerGroupNotes { padding: 0 16px 2px 18px; font-size: 11px; color: var(--text-color-weak); white-space: pre-wrap; word-break: break-word; unicode-bidi: plaintext; }\n  .tabLink { text-decoration: none; color: var(--link); }\n  .tabLink:hover { text-decoration: underline; }\n  .tabNotes { font-size: 11px; color: var(--text-color-weak); margin-top: 2px; white-space: pre-wrap; unicode-bidi: plaintext; }\n  #emptyState { margin-top: 30px; color: var(--text-color-weak); font-size: 13px; }\n  #d1form { border: 1px solid #ddd; border-radius: 8px; padding: 12px 16px; margin-bottom: 18px; font-size: 13px; }\n  #d1form input, #d1form select { padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; font-size: 13px; margin: 4px 6px 4px 0; }\n  #d1form button { padding: 6px 14px; border: none; border-radius: 6px; background: #2b6cb0; color: #fff; cursor: pointer; font-size: 13px; }\n  #d1status { margin-top: 6px; color: var(--text-color-weak); white-space: pre-wrap; }\n  #d1err { color: #b03a2e; }\n</style>\n</head>\n<body>\n<div id=\"contentAreaDiv\">\n  <div id=\"d1form\">\n    Access Token: <input id=\"ftoken\" type=\"password\" size=\"28\">\n    加密口令: <input id=\"fkey\" type=\"password\" size=\"20\">\n    <button id=\"fgo\">载入云端标签</button>\n    <span id=\"fdev\"></span>\n    <div id=\"d1status\">数据在浏览器中用你的口令解密, 不经过服务器明文传输。</div>\n    <div id=\"d1err\"></div>\n  </div>\n  <div id=\"headerText\"></div>\n  <div id=\"tabGroupsDiv\"><div id=\"emptyState\">填写 Access Token 与加密口令后点击“载入云端标签”。也可以用 /view?token=...&amp;key=... 直接访问。</div></div>\n</div>\n<script>\n(function () {\n  var $ = function (id) { return document.getElementById(id); };\n  var enc = new TextEncoder();\n  var NL = String.fromCharCode(10);\n  function escHtml(t) { return String(t == null ? \"\" : t).replace(/&/g, \"&amp;\").replace(/</g, \"&lt;\").replace(/>/g, \"&gt;\").replace(/\"/g, \"&quot;\"); }\n  function escAttr(t) { return String(t == null ? \"\" : t).replace(/&/g, \"&amp;\").replace(/\"/g, \"&quot;\"); }\n  function b64ToBytes(b64) { var s = atob(b64); var b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }\n  async function deriveKey(pass) {\n    var salt = enc.encode(\"onetap-d1-sync-v1\");\n    var base = await crypto.subtle.importKey(\"raw\", enc.encode(pass), \"PBKDF2\", false, [\"deriveKey\"]);\n    return crypto.subtle.deriveKey({ name: \"PBKDF2\", salt: salt, iterations: 250000, hash: \"SHA-256\" }, base, { name: \"AES-GCM\", length: 256 }, false, [\"decrypt\"]);\n  }\n  async function gunzip(data) {\n    var ds = new DecompressionStream(\"gzip\");\n    var w = ds.writable.getWriter(); w.write(data); w.close();\n    var chunks = []; var r = ds.readable.getReader();\n    for (;;) { var o = await r.read(); if (o.done) break; chunks.push(o.value); }\n    var total = 0; for (var i = 0; i < chunks.length; i++) total += chunks[i].length;\n    var out = new Uint8Array(total); var off = 0;\n    for (var j = 0; j < chunks.length; j++) { out.set(chunks[j], off); off += chunks[j].length; }\n    return out;\n  }\n  var SNAPS = [];\n  async function load() {\n    var token = $(\"ftoken\").value.trim();\n    var pass = $(\"fkey\").value;\n    if (!token || !pass) { $(\"d1err\").textContent = \"请填写 Access Token 和加密口令。\"; return; }\n    localStorage.setItem(\"d1view_token\", token);\n    localStorage.setItem(\"d1view_key\", pass);\n    $(\"d1err\").textContent = \"\"; $(\"d1status\").textContent = \"正在下载并解密…\";\n    var res;\n    try {\n      res = await fetch(\"/pull\", { headers: { Authorization: \"Bearer \" + token } });\n    } catch (e) { $(\"d1err\").textContent = \"网络错误: \" + e.message; $(\"d1status\").textContent = \"\"; return; }\n    if (!res.ok) { $(\"d1err\").textContent = \"拉取失败: HTTP \" + res.status; $(\"d1status\").textContent = \"\"; return; }\n    var data = await res.json();\n    if (!data.ok || !data.snapshots) { $(\"d1err\").textContent = \"响应异常\"; $(\"d1status\").textContent = \"\"; return; }\n    var key = await deriveKey(pass);\n    SNAPS = [];\n    for (var i = 0; i < data.snapshots.length; i++) {\n      var sn = data.snapshots[i];\n      if (!sn.blob) continue;\n      try {\n        var iv = b64ToBytes(sn.blob.iv);\n        var pt = await crypto.subtle.decrypt({ name: \"AES-GCM\", iv: iv }, key, b64ToBytes(sn.blob.data));\n        var json = await gunzip(new Uint8Array(pt));\n        var obj = JSON.parse(new TextDecoder().decode(json));\n        SNAPS.push({ name: (sn.deviceName || sn.deviceId) + \" @ \" + new Date(sn.updatedAt).toLocaleString(\"zh-CN\"), items: obj.items || [], bookmarks: obj.bookmarks || null });\n      } catch (e) { console.warn(\"decrypt failed\", e); }\n    }\n    if (!SNAPS.length) { $(\"d1err\").textContent = \"没有可解密的快照(口令不对或云端为空)。\"; $(\"d1status\").textContent = \"\"; return; }\n    var sel = '<select id=\"fsnap\">';\n    for (var k = 0; k < SNAPS.length; k++) sel += '<option value=\"' + k + '\">' + escHtml(SNAPS[k].name) + '</option>';\n    sel += '</select>';\n    $(\"fdev\").innerHTML = sel;\n    $(\"fsnap\").addEventListener(\"change\", function () { render(parseInt(this.value, 10) || 0); });\n    render(0);\n    $(\"d1status\").textContent = \"共 \" + SNAPS.length + \" 个设备的快照。\";\n  }\n  function render(si) {\n    var snap = SNAPS[si];\n    if (!snap) return;\n    var byId = {};\n    var items = snap.items;\n    for (var i = 0; i < items.length; i++) if (items[i] && items[i].id) byId[items[i].id] = items[i];\n    var topIds = [];\n    if (byId[\"root\"] && byId[\"root\"].childIds) topIds = byId[\"root\"].childIds;\n    else for (var j = 0; j < items.length; j++) {\n      var it = items[j];\n      if (it && it.type === \"group\" && it.parentIds && it.parentIds.indexOf(\"root\") !== -1) topIds.push(it.id);\n    }\n    function countOf(it) {\n      if (!it) return 0;\n      if (it.type === \"tab\") return 1;\n      var n = 0;\n      var kids = it.childIds || [];\n      for (var k = 0; k < kids.length; k++) {\n        var c = byId[kids[k]];\n        if (c && c.type === \"tab\") n++;\n        else if (c && c.type === \"group\") n += countOf(c);\n      }\n      return n;\n    }\n    function renderChildren(it, level) {\n      var step = 20, out = \"\", idx = 0;\n      var kids = it.childIds || [];\n      for (var k = 0; k < kids.length; k++) {\n        var c = byId[kids[k]];\n        if (!c) continue;\n        var padA = level ? level * step : 0;\n        var padB = (level + 1) * step;\n        if (c.type === \"tab\") {\n          var notes = (c.notes && c.notes.text) ? '<div class=\"tabNotes\">' + escHtml(c.notes.text) + '</div>' : '';\n          out += '<div class=\"tab\" style=\"padding-inline-start: ' + padA + 'px;\"><a class=\"tabLink\" dir=\"auto\" href=\"' + escAttr(c.url || '') + '\">' + escHtml(c.title || c.url || '') + '</a>' + notes + '</div>';\n          idx++;\n        } else if (c.type === \"group\") {\n          out += '<div class=\"innerGroupBlock\" style=\"margin-top: ' + (idx ? 8 : 2) + 'px;\">' + NL +\n            '<div class=\"innerGroupTitleText\" style=\"padding-inline-start: ' + padB + 'px;\"><span dir=\"auto\">' + escHtml(c.label || '') + '</span></div>';\n          if (c.notes && c.notes.text) out += '<div class=\"innerGroupNotes\" style=\"padding-inline-start: ' + padB + 'px;\">' + escHtml(c.notes.text) + '</div>';\n          out += renderChildren(c, level + 1);\n          out += '</div>';\n          idx++;\n        }\n      }\n      return out;\n    }\n    function renderGroup(it) {\n      var n = countOf(it);\n      var gtitle = escHtml(it.label || \"\");\n      var countText = n + \" 个标签\";\n      var created = it.createDate ? '<div class=\"createdDate\">' + escHtml(\"创建于 \" + new Date(it.createDate).toLocaleDateString(\"zh-CN\")) + '</div>' : '';\n      return '<div class=\"tabGroup\">' + NL +\n        '<div class=\"tabGroupHeader\">' + NL +\n        '<div class=\"tabGroupHeaderRow\">' + NL +\n        '<div class=\"tabGroupTitleText\"><span dir=\"auto\">' + (gtitle || countText) + '</span></div>' + NL +\n        (gtitle ? '<div class=\"tabCountInline\">' + countText + '</div>' + NL : \"\") +\n        '</div>' + NL +\n        (created ? created + NL : \"\") +\n        '</div>' + NL +\n        '<div class=\"tabList\">' + renderChildren(it, 0) + '</div>' + NL +\n        '</div>';\n    }\n    var blocks = [], total = 0;\n    for (var t = 0; t < topIds.length; t++) {\n      var g = byId[topIds[t]];\n      if (!g || g.type !== \"group\") continue;\n      blocks.push(renderGroup(g));\n      total += countOf(g);\n    }\n    var bodyHtml = blocks.length ? blocks.join(NL) : '<div id=\"emptyState\">该快照暂无标签</div>';\n    // 书签整树快照（web-history 扩展同步的内容之一）\n    function countBookmarkNodes(nodes) {\n      var n = 0;\n      for (var i = 0; i < nodes.length; i++) {\n        if (nodes[i].url) n++;\n        if (nodes[i].children) n += countBookmarkNodes(nodes[i].children);\n      }\n      return n;\n    }\n    function renderBookmarkNodes(nodes, level) {\n      var step = 20, out = \"\";\n      for (var i = 0; i < nodes.length; i++) {\n        var n2 = nodes[i];\n        var padA = level * step;\n        if (n2.url) {\n          out += '<div class=\"tab\" style=\"padding-inline-start: ' + padA + 'px;\"><a class=\"tabLink\" dir=\"auto\" href=\"' + escAttr(n2.url) + '\">' + escHtml(n2.title || n2.url) + '</a></div>';\n        } else if (n2.children) {\n          var padB = (level + 1) * step;\n          out += '<div class=\"innerGroupBlock\" style=\"margin-top: ' + (i ? 8 : 2) + 'px;\">' + NL +\n            '<div class=\"innerGroupTitleText\" style=\"padding-inline-start: ' + padB + 'px;\"><span dir=\"auto\">' + escHtml(n2.title || \"未命名文件夹\") + '</span></div>' +\n            renderBookmarkNodes(n2.children, level + 1) + '</div>';\n        }\n      }\n      return out;\n    }\n    if (snap.bookmarks && snap.bookmarks.tree && snap.bookmarks.tree.length) {\n      var bmCount = countBookmarkNodes(snap.bookmarks.tree);\n      bodyHtml += '<div class=\"tabGroup\">' + NL +\n        '<div class=\"tabGroupHeader\">' + NL +\n        '<div class=\"tabGroupHeaderRow\">' + NL +\n        '<div class=\"tabGroupTitleText\"><span dir=\"auto\">书签</span></div>' + NL +\n        '<div class=\"tabCountInline\">' + bmCount + ' 个书签</div>' + NL +\n        '</div>' + NL +\n        '</div>' + NL +\n        '<div class=\"tabList\">' + renderBookmarkNodes(snap.bookmarks.tree, 0) + '</div>' + NL +\n        '</div>';\n    }\n    $(\"headerText\").textContent = \"共 \" + total + \" 个标签 · \" + snap.name;\n    $(\"tabGroupsDiv\").innerHTML = bodyHtml;\n  }\n  var q = new URLSearchParams(location.search);\n  var qt = q.get(\"token\"), qk = q.get(\"key\");\n  if (qt) $(\"ftoken\").value = qt;\n  if (qk) $(\"fkey\").value = qk;\n  $(\"ftoken\").value = $(\"ftoken\").value || localStorage.getItem(\"d1view_token\") || \"\";\n  $(\"fkey\").value = $(\"fkey\").value || localStorage.getItem(\"d1view_key\") || \"\";\n  $(\"fgo\").addEventListener(\"click\", load);\n  if ($(\"ftoken\").value && $(\"fkey\").value) load();\n})();\n</script>\n</body>\n</html>\n";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// API 版本号：所有响应(含认证失败)都带，扩展端据此识别旧 Worker(v2/v3 不返回该字段)。
const API = 4;

function checkAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return auth === "Bearer " + env.SYNC_TOKEN;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!env.SYNC_TOKEN) return json({ error: "SYNC_TOKEN secret not set", api: API }, 500);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    // /view 页面壳不含任何数据, 放在认证之前; 数据仍需凭 token 走 /pull
    if (request.method === "GET" && path === "/view") {
      return new Response(VIEW_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...CORS },
      });
    }
    if (!checkAuth(request, env)) return json({ error: "unauthorized", api: API }, 401);

    try {
      // api 版本号：扩展端据此识别旧 Worker（v2/v3 不返回该字段）。
      // 旧 Worker 缺少 409 冲突协议、按名删除语义，会让"删除快照/同步"行为异常，
      // 扩展端见到缺失或 <4 的 api 会直接报错并提示重新部署，而不是静默出错。
      if (request.method === "GET" && path === "/health") {
        // 每个设备名一行快照(v4: 同名覆盖, 不再有版本概念)。
        const { results } = await env.DB.prepare(
          `SELECT device_name, updated_at FROM snapshots_by_name
           ORDER BY updated_at DESC`
        ).all();
        return json({ ok: true, api: API, devices: results });
      }

      if (request.method === "POST" && path === "/push") {
        // v4: 以设备名为主键——同名覆盖、不同名新增。
        // 冲突协议：已存在同名快照且未显式带 mode=overwrite 时返回 409，
        // 由扩展端询问用户"覆盖 / 合并 / 取消"后再决定，绝不静默覆盖。
        // 删除即最终删除：不再有拉黑表，删掉的名可以随时重新上传。
        const body = await request.json();
        const { deviceName, blob, mode } = body;
        if (!deviceName || typeof deviceName !== "string" || !blob || !blob.iv || !blob.data) {
          return json({ error: "bad request: deviceName/blob required", api: API }, 400);
        }
        const existing = await env.DB.prepare(
          "SELECT updated_at FROM snapshots_by_name WHERE device_name = ?"
        ).bind(deviceName).first();
        if (existing && mode !== "overwrite") {
          return json({
            error: "name-exists",
            deviceName,
            updatedAt: existing.updated_at,
            api: API,
          }, 409);
        }
        // 限制 blob 大小,防止滥用(D1 单行留出余量)。
        const size = blob.data.length + blob.iv.length;
        if (size > 4_000_000) return json({ error: "blob too large: " + size, api: API }, 413);
        // 同名覆盖(或首次插入): 一台设备只保留一条最新快照
        await env.DB.prepare(
          `INSERT INTO snapshots_by_name (device_name, data, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(device_name) DO UPDATE SET
             data = excluded.data,
             updated_at = excluded.updated_at`
        )
          .bind(deviceName, JSON.stringify(blob), Date.now())
          .run();
        return json({ ok: true, api: API });
      }

      if (request.method === "GET" && path === "/pull") {
        // 返回快照列表。?name=<设备名> 只取该设备名的快照（扩展端"合并"解法用：
        // 先把云端同名快照合并进本机，再上传合并结果）。
        // 不带 name 时返回全部（本机旧快照也返回：LWW + tombstone 保证幂等，
        // 且同名覆盖语义下拉回的同名快照正是最新合并源）。
        const name = url.searchParams.get("name");
        const { results } = name
          ? await env.DB.prepare(
              `SELECT device_name, data, updated_at FROM snapshots_by_name
               WHERE device_name = ?`
            ).bind(name).all()
          : await env.DB.prepare(
              `SELECT device_name, data, updated_at FROM snapshots_by_name
               ORDER BY updated_at DESC`
            ).all();
        const snapshots = results.map((r) => {
          let blob = null;
          try {
            blob = JSON.parse(r.data);
          } catch (e) {}
          return {
            deviceName: r.device_name,
            updatedAt: r.updated_at,
            blob,
          };
        });
        return json({ ok: true, api: API, snapshots });
      }

      if (request.method === "DELETE" && path === "/devices") {
        // 清空所有快照(重置同步)。
        await env.DB.prepare("DELETE FROM snapshots_by_name").run();
        return json({ ok: true, api: API });
      }

      if (request.method === "DELETE" && path.startsWith("/devices/")) {
        // v4: 按设备名硬删除——删掉就是删掉，不拉黑、不禁用；
        // 同名设备之后随时可以重新上传（存在同名时按 /push 冲突协议由用户决定）。
        const name = decodeURIComponent(path.slice("/devices/".length));
        if (!name) return json({ error: "bad request: device name required", api: API }, 400);
        await env.DB.prepare("DELETE FROM snapshots_by_name WHERE device_name = ?").bind(name).run();
        return json({ ok: true, deleted: name, api: API });
      }

      return json({ error: "not found", api: API }, 404);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};
