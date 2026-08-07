#!/usr/bin/env node
// 逐台跑「每顆按鈕真的按得動」——verify-clicks 的批次版。
//
// 【WHY】按鈕接線的錯誤是**產生器層級**的：daemon 產生器把 `$zj#` 當欄位分隔符，
// 一錯就是全部 195 台一起錯。只驗一台證明不了收藏的狀態——
// 這與 sweep-web 當初的理由完全一樣（CLAUDE.md §5：覆蓋率要沿著使用者走的路展開）。
//
// 【WHY 每台一個子行程】每台都要載入自己的映像、開自己的瀏覽器。
// 同一個行程裡跑會互相污染（driver 是模組層級的全域），
// 而且一台崩掉會拖垮整批——隔離由行程邊界保證。
//
// 用法：
//   node tools/sweep-clicks.mjs [site 目錄] [--only a,b] [--limit N]

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

// ★ 帶值的旗標要登記（見 sweep-web.mjs 的說明——這個坑踩過兩次）。
const VALUE_FLAGS = new Set(['--only', '--limit', '--timeout']);
const positional = [];
{
  const av = process.argv.slice(2);
  for (let i = 0; i < av.length; i += 1) {
    if (VALUE_FLAGS.has(av[i])) { i += 1; continue; }
    if (av[i].startsWith('--')) continue;
    positional.push(av[i]);
  }
}
const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const SITE = path.resolve(positional[0] || path.join(REPO, 'site'));
const indexPath = path.join(SITE, 'libs', 'index.json');
if (!fs.existsSync(indexPath)) {
  console.error(`找不到建置產物（${indexPath}）——先跑 node tools/build-site.mjs`);
  process.exit(2);
}
const only = arg('only');
const cat = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
let targets = cat.muds
  .filter((m) => m.badge === 'playable')
  .filter((m) => !only || only.split(',').map((x) => x.trim()).includes(m.slug));

// 平均取樣（理由同 sweep-web：每個家族都要有代表，取前 N 個會擠在字母序開頭）
const limit = Number(arg('limit', '0'));
if (limit > 0 && targets.length > limit) {
  const all = targets.length;
  const step = all / limit;
  targets = Array.from({ length: limit }, (_, i) => targets[Math.floor(i * step)]);
  console.log(`（抽驗 ${limit}/${all} 台，平均取樣）`);
}

const BASE_PORT = 8600;
function runOne(slug, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(HERE, 'verify-clicks.mjs'), SITE, '--mud', slug,
    ], { env: { ...process.env, ZJMUD_CLICK_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ ok: code === 0, out }));
  });
}

console.log(`站台 ${SITE}\n逐台按鈕測試 ${targets.length} 台（每台一個子行程）\n`);
const failures = [];
const warned = [];
let i = 0;
for (const m of targets) {
  i += 1;
  process.stdout.write(`[${String(i).padStart(3)}/${targets.length}] ${m.slug.padEnd(22)} `);
  const r = await runOne(m.slug, BASE_PORT + i);
  const n = (r.out.match(/偵測到 (\d+) 顆按鈕/) ?? [])[1] ?? '?';
  const refuse = (r.out.match(/⚠ .*?：(\d+) 項/) ?? [])[1];
  if (r.ok) {
    console.log(`✓ ${n} 顆${refuse ? `（${refuse} 項世界拒絕）` : ''}`);
    if (refuse) warned.push(m.slug);
  } else {
    const first = (r.out.match(/^ {3}· .*$/m) ?? ['(無細節)'])[0].trim();
    console.log(`✗ ${first}`);
    failures.push({ slug: m.slug, detail: r.out.split('\n').filter((l) => l.startsWith('   · ')).join('\n') });
  }
}

// ★ 一台都沒跑到＝失敗，不是通過（空集合的斷言永遠成立，見 CLAUDE.md §5）。
if (!targets.length) {
  console.error('\n✗ 沒有任何 mud 被驗證——過濾條件沒有命中，或站台索引是空的。');
  process.exit(2);
}
console.log(`\n${targets.length} 台，${failures.length ? `**${failures.length} 台有按鈕問題**` : '全部通過（每顆按鈕都按得到、送得出、有回應）'}`);
for (const f of failures) console.log(`\n${f.slug}：\n${f.detail}`);
if (warned.length) console.log(`\n⚠ ${warned.length} 台有「指令存在但世界拒絕」：${warned.join(' ')}`);
process.exit(failures.length ? 1 : 0);
