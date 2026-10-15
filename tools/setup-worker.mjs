#!/usr/bin/env node
// web-history 云同步一键引导部署脚本
// 用途：新用户不熟悉 Cloudflare 也能完成 Worker + D1 部署。全流程分步执行、
// 每步有中文说明，最后输出扩展设置所需的「Worker 地址 + Access Token」。
//
// 用法（在仓库根目录）：
//   node tools/setup-worker.mjs
//
// 前提：本机已安装 Node.js（≥18，含 npm/npx）。无需预装 wrangler（用 npx 拉起）。
// 流程：
//   1. 检查 Cloudflare 登录状态，未登录则打开浏览器授权（wrangler login）
//   2. 创建 D1 数据库 onetap-sync（已存在则复用，自动取 database_id）
//   3. 执行 worker/schema.sql 建表
//   4. 生成 64 位随机 Access Token 并写入 Worker 密钥 SYNC_TOKEN
//   5. 生成/更新 private/wrangler.toml（真实 database_id，已被 .gitignore 排除）
//   6. wrangler deploy 部署 Worker，解析出 workers.dev 地址
//   7. 打印「扩展设置页要填的三样东西」，其中加密口令由用户自定

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_NAME = process.env.DB_NAME || 'd1-sync'; // 数据库名（与 Worker 同名；各账号名字空间独立，互不相干）
const WORKER_NAME = process.env.WORKER_NAME || 'd1-sync';
const WRANGLER = ['npx', '--yes', 'wrangler'];

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

let step = 0;
let accountId = process.env.CLOUDFLARE_ACCOUNT_ID || ''; // 选中的账号（多账号时注入子进程环境）
function banner(title) {
  step += 1;
  console.log(`\n${c.bold(c.cyan(`[步骤 ${step}] ${title}`))}`);
}
/** 子进程环境：多账号选择后把 CLOUDFLARE_ACCOUNT_ID 注入，让所有 wrangler 命令落在该账号。 */
function env() {
  return accountId ? { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId } : process.env;
}
/** 执行 wrangler 子命令（args = ['d1','list','--json']），返回 {code,stdout,stderr}。
 *  opts.input：写入子进程 stdin 的内容（如自动回答 logout 的 y/N 确认）。 */
function run(args, opts = {}) {
  const { input, ...rest } = opts;
  const r = spawnSync(WRANGLER[0], [...WRANGLER.slice(1), ...args], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', env: env(), input, ...rest });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
/** 流式执行 wrangler 子命令（实时回显），返回合并输出。 */
function runLive(args, { input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(WRANGLER[0], [...WRANGLER.slice(1), ...args], { cwd: ROOT, shell: process.platform === 'win32', env: env() });
    let out = '';
    // wrangler 输出带 ANSI 颜色/OSC8 超链接转义码，会把 URL 匹配搞坏——
    // 回显用原文，解析用剥离后的纯文本
    const strip = (s) => s
      .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC 8 超链接包裹
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');               // SGR 颜色/光标
    const collect = (d) => { const s = d.toString(); out += strip(s); process.stdout.write(c.dim(s)); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
    child.on('close', (code) => resolve({ code, out }));
  });
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q) => rl.question(c.bold(q));

async function main() {
  console.log(c.bold('\n════════ web-history 云同步 · 一键部署引导 ════════'));
  console.log(c.dim('本脚本将引导你完成 Cloudflare Worker + D1 数据库的部署，'));
  console.log(c.dim('全部使用免费额度；完成后自动得到扩展设置所需的连接信息。\n'));

  const ok0 = await ask('已了解并继续？(回车继续 / Ctrl+C 退出)');
  if (ok0 === undefined) return;

  // ---------- 1. 登录状态 / 账号选择 ----------
  banner('Cloudflare 账号（登录 / 选择 / 注销）');
  const whoamiAccounts = () => {
    const w = run(['whoami']);
    const text = w.stdout + w.stderr;
    const ok = w.code === 0 && /You are logged in|logged in with/i.test(text);
    // 解析 whoami 的账号表（Account Name | Account ID），支持一个 OAuth 账号下多个 Cloudflare 账号；
    // 行尾允许封闭竖线（表格边框）
    const accounts = [...text.matchAll(/^\s*(.+?)\s+[│|]\s+([0-9a-f]{32})\s*[│|]?\s*$/gim)]
      .map((m) => ({ name: m[1].replace(/^[│|]\s*/, '').trim(), id: m[2] }));
    return { ok, text, accounts };
  };
  const doLogin = async () => {
    console.log(c.yellow('正在打开浏览器授权…（在浏览器里登录并点击 Allow）'));
    const login = await runLive(['login']);
    if (login.code !== 0) { console.error(c.red('登录失败，请重跑本脚本。')); rl.close(); return false; }
    return true;
  };

  let state = whoamiAccounts();
  if (!state.ok) {
    console.log(c.yellow('尚未登录 Cloudflare。'));
    if (!(await doLogin())) return;
    state = whoamiAccounts();
  } else {
    console.log(c.green('✔ 已登录'));
    console.log('  1) 继续使用当前账号');
    console.log('  2) 注销并登录其他账号（多账号测试用）');
    const op = (await ask('选择操作（回车 = 1）：')).trim();
    if (op === '2') {
      // logout 会弹 y/N 确认：管道模式下提示不可见且 stdin 关闭会卡死，自动回答 y
      const out = run(['logout'], { input: 'y\n' });
      if (out.code !== 0) console.log(c.dim('注销输出：' + (out.stdout + out.stderr).trim()));
      console.log(c.green('✔ 已注销本机凭据'));
      if (!(await doLogin())) return;
      state = whoamiAccounts();
    }
  }

  // OAuth 登录可能关联多个 Cloudflare 账号（个人 / 工作区…）：选一个作为本次部署目标
  if (state.accounts.length > 1) {
    console.log(c.bold('当前凭据关联多个 Cloudflare 账号：'));
    state.accounts.forEach((a, i) => console.log(`  ${i + 1}) ${a.name}  ${c.dim(a.id)}`));
    const pick = (await ask('选择本次部署使用的账号（回车 = 1）：')).trim();
    const idx = parseInt(pick, 10);
    const chosen = state.accounts[Number.isInteger(idx) && idx >= 1 && idx <= state.accounts.length ? idx - 1 : 0];
    accountId = chosen.id;
    console.log(c.green(`✔ 本次部署使用账号：${chosen.name}`));
  } else if (state.accounts.length === 1) {
    accountId = state.accounts[0].id;
  }
  // 注：选定的 accountId 会注入后续所有 wrangler 命令（建库/部署都落在该账号）

  // ---------- 2. D1 数据库 ----------
  banner(`创建 D1 数据库「${DB_NAME}」`);
  // 保护：本地 private/wrangler.toml 已有绑定时先询问——重跑脚本（换账号/换库名）
  // 不能悄悄覆盖掉已经在用的正确绑定，否则 Worker 会指到另一个（空）库
  const privDir = path.join(ROOT, 'private');
  const privToml = path.join(privDir, 'wrangler.toml');
  const existingId = existsSync(privToml)
    ? (readFileSync(privToml, 'utf8').match(/database_id\s*=\s*"([0-9a-f-]{36})"/) || [])[1]
    : undefined;
  let keepExisting = false;
  if (existingId) {
    console.log(`检测到本地已有数据库绑定：${c.cyan(existingId)}`);
    const ans = (await ask('保留该绑定（推荐，回车）？还是按库名重建/切换（输入 n）：')).trim().toLowerCase();
    keepExisting = ans !== 'n';
  }

  let db;
  if (keepExisting) {
    const list0 = run(['d1', 'list', '--json']);
    let dbs0 = [];
    try { dbs0 = JSON.parse(list0.stdout); } catch { /* 解析失败按空处理 */ }
    db = dbs0.find((d) => d.uuid === existingId);
    if (!db) { console.error(c.red(`本地绑定的数据库 ${existingId} 在当前账号下找不到（换过账号？）。请选择"重建/切换"或登录正确账号。`)); rl.close(); return; }
    console.log(c.green(`✔ 继续使用已有数据库「${db.name}」`));
  } else {
    let list = run(['d1', 'list', '--json']);
    let dbs = [];
    try { dbs = JSON.parse(list.stdout); } catch { /* 解析失败按空处理 */ }
    db = dbs.find((d) => d.name === DB_NAME || d.uuid === DB_NAME);
    if (db) {
      console.log(c.green(`✔ 数据库已存在，复用（id=${db.uuid}）`));
    } else {
      const created = await runLive(['d1', 'create', DB_NAME]);
      list = run(['d1', 'list', '--json']);
      try { dbs = JSON.parse(list.stdout); } catch { /* 同上 */ }
      db = dbs.find((d) => d.name === DB_NAME);
      if (!db) { console.error(c.red('创建数据库失败，请查看上方输出。')); rl.close(); return; }
      console.log(c.green(`✔ 创建成功（id=${db.uuid}）`));
    }
  }
  const databaseId = db.uuid || db.database_id;

  // ---------- 3. 建表 ----------
  banner('初始化数据表（worker/schema.sql）');
  const schema = await runLive(['d1', 'execute', DB_NAME, '--remote', '--file', 'worker/schema.sql', '-y']);
  if (schema.code !== 0) { console.error(c.red('建表失败，请查看上方输出。')); rl.close(); return; }
  console.log(c.green('✔ 数据表就绪'));

  // ---------- 4. Access Token ----------
  banner('生成并写入访问令牌 SYNC_TOKEN');
  const token = randomBytes(32).toString('hex');
  const secret = await runLive(['secret', 'put', 'SYNC_TOKEN', '--name', WORKER_NAME], { input: token + '\n' });
  if (secret.code !== 0) { console.error(c.red('写入令牌失败（Worker 尚未部署时可能报错，部署后会重试）。')); }
  else console.log(c.green('✔ 令牌已写入'));

  // ---------- 5. private/wrangler.toml ----------
  banner('生成本地私有部署配置 private/wrangler.toml');
  // privDir/privToml 已在步骤 2 解析过；这里直接使用
  mkdirSync(privDir, { recursive: true });
  // 绑定保护通过时（keepExisting），database_id 本就一致，不会触发改写
  if (!keepExisting && existsSync(privToml)) {
    let cur = readFileSync(privToml, 'utf8');
    if (!cur.includes(databaseId)) {
      cur = cur.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${databaseId}"`);
      writeFileSync(privToml, cur);
      console.log(c.green('✔ 已更新 database_id'));
    } else {
      console.log(c.green('✔ 已包含正确的 database_id，未改动'));
    }
  } else {
    writeFileSync(privToml, `# 由 tools/setup-worker.mjs 自动生成（已被 .gitignore 排除，勿提交）
name = "${WORKER_NAME}"
main = "../worker/src/worker.js"
compatibility_date = "2024-09-01"

[[d1_databases]]
binding = "DB"
database_name = "${DB_NAME}"
database_id = "${databaseId}"
`);
    console.log(c.green('✔ 已生成 private/wrangler.toml'));
  }

  // ---------- 6. 部署 ----------
  banner(`部署 Worker「${WORKER_NAME}」`);
  // Worker 未首次部署时 secret put 会失败——这里补写一次
  let deploy = await runLive(['deploy', '--config', 'private/wrangler.toml']);
  if (secret.code !== 0) {
    console.log(c.dim('补充写入 SYNC_TOKEN…'));
    await runLive(['secret', 'put', 'SYNC_TOKEN', '--name', WORKER_NAME], { input: token + '\n' });
    deploy = await runLive(['deploy', '--config', 'private/wrangler.toml']);
  }
  // 注意子域可有多段标签（<worker名>.<账户子域>.workers.dev），要用 [a-z0-9.-]+
  const urlMatch = deploy.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i);
  if (deploy.code !== 0 || !urlMatch) {
    console.error(c.red('部署失败，请查看上方输出（常见原因：子域未创建——按提示访问 workers.dev 激活子域后重跑）。'));
    rl.close();
    return;
  }
  const workerUrl = urlMatch[0];
  console.log(c.green(`✔ 部署完成：${workerUrl}`));

  // ---------- 7. 汇总 ----------
  banner('完成！扩展设置所需信息如下');
  console.log(c.bold('打开扩展 → 设置 → 云同步，按下面填写：\n'));
  console.log(`  ① Worker 地址  : ${c.cyan(workerUrl)}`);
  console.log(`  ② Access Token : ${c.cyan(token)}`);
  console.log('  ③ 加密口令     : ' + c.yellow('自定义一个密码（现在想好，直接填进扩展）'));
  console.log(`
    在扩展「设置 → 云同步」的第③栏填入。注意：
    · 多台设备必须填同一个口令，否则无法同步；
    · 口令丢失无法找回，请务必记牢。`);
  console.log(`\n${c.dim('提示：private/wrangler.toml 保存了真实配置（已被 .gitignore 排除）；')}`);
  console.log(c.dim('以后重新部署只需：wrangler deploy --config private/wrangler.toml'));
  rl.close();
}

main().catch((e) => { console.error(c.red('脚本异常：'), e); rl.close(); process.exit(1); });
