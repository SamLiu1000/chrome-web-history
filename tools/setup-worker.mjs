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
const DB_NAME = process.env.DB_NAME || 'onetap-sync';
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
function banner(title) {
  step += 1;
  console.log(`\n${c.bold(c.cyan(`[步骤 ${step}] ${title}`))}`);
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', ...opts });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
/** 流式执行（实时回显 wrangler 输出），返回合并输出。 */
function runLive(cmd, args, { input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, shell: process.platform === 'win32' });
    let out = '';
    const collect = (d) => { const s = d.toString(); out += s; process.stdout.write(c.dim(s)); };
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

  // ---------- 1. 登录状态 ----------
  banner('检查 Cloudflare 登录状态');
  let who = run(...WRANGLER, ['whoami']);
  const loggedIn = who.code === 0 && /You are logged in|logged in with/i.test(who.stdout + who.stderr);
  if (!loggedIn) {
    console.log(c.yellow('尚未登录 Cloudflare，正在打开浏览器授权…（在浏览器里点击 Allow 即可）'));
    const login = await runLive(...WRANGLER, ['login']);
    if (login.code !== 0) { console.error(c.red('登录失败，请重跑本脚本。')); rl.close(); return; }
  } else {
    console.log(c.green('✔ 已登录'));
  }

  // ---------- 2. D1 数据库 ----------
  banner(`创建 D1 数据库「${DB_NAME}」`);
  let list = run(...WRANGLER, ['d1', 'list', '--json']);
  let dbs = [];
  try { dbs = JSON.parse(list.stdout); } catch { /* 解析失败按空处理 */ }
  let db = dbs.find((d) => d.name === DB_NAME || d.uuid === DB_NAME);
  if (db) {
    console.log(c.green(`✔ 数据库已存在，复用（id=${db.uuid}）`));
  } else {
    const created = await runLive(...WRANGLER, ['d1', 'create', DB_NAME]);
    list = run(...WRANGLER, ['d1', 'list', '--json']);
    try { dbs = JSON.parse(list.stdout); } catch { /* 同上 */ }
    db = dbs.find((d) => d.name === DB_NAME);
    if (!db) { console.error(c.red('创建数据库失败，请查看上方输出。')); rl.close(); return; }
    console.log(c.green(`✔ 创建成功（id=${db.uuid}）`));
  }
  const databaseId = db.uuid || db.database_id;

  // ---------- 3. 建表 ----------
  banner('初始化数据表（worker/schema.sql）');
  const schema = await runLive(...WRANGLER, ['d1', 'execute', DB_NAME, '--remote', '--file', 'worker/schema.sql', '-y']);
  if (schema.code !== 0) { console.error(c.red('建表失败，请查看上方输出。')); rl.close(); return; }
  console.log(c.green('✔ 数据表就绪'));

  // ---------- 4. Access Token ----------
  banner('生成并写入访问令牌 SYNC_TOKEN');
  const token = randomBytes(32).toString('hex');
  const secret = await runLive(...WRANGLER, ['secret', 'put', 'SYNC_TOKEN', '--name', WORKER_NAME], { input: token + '\n' });
  if (secret.code !== 0) { console.error(c.red('写入令牌失败（Worker 尚未部署时可能报错，部署后会重试）。')); }
  else console.log(c.green('✔ 令牌已写入'));

  // ---------- 5. private/wrangler.toml ----------
  banner('生成本地私有部署配置 private/wrangler.toml');
  const privDir = path.join(ROOT, 'private');
  const privToml = path.join(privDir, 'wrangler.toml');
  mkdirSync(privDir, { recursive: true });
  if (existsSync(privToml)) {
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
  let deploy = await runLive(...WRANGLER, ['deploy', '--config', 'private/wrangler.toml']);
  if (secret.code !== 0) {
    console.log(c.dim('补充写入 SYNC_TOKEN…'));
    await runLive(...WRANGLER, ['secret', 'put', 'SYNC_TOKEN', '--name', WORKER_NAME], { input: token + '\n' });
    deploy = await runLive(...WRANGLER, ['deploy', '--config', 'private/wrangler.toml']);
  }
  const urlMatch = deploy.out.match(/https:\/\/[a-z0-9-]+\.workers\.dev/i);
  if (deploy.code !== 0 || !urlMatch) {
    console.error(c.red('部署失败，请查看上方输出（常见原因：子域未创建——按提示访问 workers.dev 激活子域后重跑）。'));
    rl.close();
    return;
  }
  const workerUrl = urlMatch[0];
  console.log(c.green(`✔ 部署完成：${workerUrl}`));

  // ---------- 7. 汇总 ----------
  banner('完成！扩展设置所需信息如下');
  console.log(c.bold('在扩展「设置 → 云同步」中填写：\n'));
  console.log(`  Worker 地址  : ${c.cyan(workerUrl)}`);
  console.log(`  Access Token : ${c.cyan(token)}`);
  console.log(`  加密口令     : ${c.yellow('自定义（不要泄露；多台设备必须一致，丢失无法恢复）')}`);
  console.log(`\n${c.dim('提示：private/wrangler.toml 保存了真实配置（已被 .gitignore 排除）；')}`);
  console.log(c.dim('以后重新部署只需：wrangler deploy --config private/wrangler.toml'));
  console.log(c.dim('令牌也可随时查看本输出的 Access Token（或重跑脚本换新）。'));
  rl.close();
}

main().catch((e) => { console.error(c.red('脚本异常：'), e); rl.close(); process.exit(1); });
