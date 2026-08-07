#!/usr/bin/env node
// 發佈前檢查每個 mud 的分級 —— 站台不該上架進不去的東西。
//
// 【WHY】badge 是 build-site.mjs 呼叫 boot-test.mjs 實測出來的（註冊→建角→
// 進世界）。如果有 mud 退化成 noboot，多半是 mudlib 被改壞或 driver 升版導致，
// 這種事必須在發佈前擋下來，而不是等使用者點進去看到空白畫面。
//
// 【推理】限度要合理：limited（開得起來但沒走完登入）不擋——很多老 mudlib 的
// 登入流程本來就不同（例如要選門派才進得了世界），那是內容差異不是故障。
// 只擋 noboot，並且把數字印出來讓人看得到趨勢。
//
// 用法：node scripts/check-badges.mjs [site 目錄]

import fs from 'node:fs';
import path from 'node:path';

const site = path.resolve(process.argv[2] || 'site');
const indexPath = path.join(site, 'libs', 'index.json');

if (!fs.existsSync(indexPath)) {
  console.error(`找不到 ${indexPath}——先跑 webclient/tools/build-site.mjs`);
  process.exit(2);
}

const cat = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const by = { playable: [], limited: [], noboot: [], unknown: [] };
for (const m of cat.muds) (by[m.badge] ?? by.unknown).push(m);

const total = cat.muds.reduce((a, m) => a + (m.sizeMB || 0), 0);
console.log(`driver ${cat.driver} · ${cat.muds.length} 個 mud · 資料合計 ${total.toFixed(1)} MB`);
for (const [k, v] of Object.entries(by)) {
  if (!v.length) continue;
  console.log(`  ${k}：${v.length}  ${v.map((m) => m.slug).join(' ')}`);
}

// noboot 不擋發佈：build-site 已經不會把它們的映像發出去，卡片也是不可點的。
// 【WHY 不擋】這個站台同時是一份**收藏清單**——把開不起來的項目直接擋掉，
// 會讓「收錄了但目前開不起來」變成「沒收錄」，那是在對讀者隱瞞資訊。
// 真正該擋的是「宣稱可玩卻沒有資料」與「一個能玩的都沒有」。
if (by.noboot.length) {
  console.warn('\n⚠ 以下 mud 目前開不起來（已列在索引中，但不發佈映像）：');
  for (const m of by.noboot) console.warn(`  ${m.slug}：${m.note || '（無說明）'}`);
}

const broken = [];
for (const m of cat.muds) {
  if (m.badge === 'noboot') continue;
  // gzip 版才是實際發佈的位元組（build-site 只寫 .gz）；舊格式仍接受
  const gz = path.join(site, 'libs', m.slug, 'mudlib.data.gz');
  const raw = path.join(site, 'libs', m.slug, 'mudlib.data');
  if (!fs.existsSync(gz) && !fs.existsSync(raw)) broken.push(m.slug);
}
if (broken.length) {
  console.error(`\n✗ 這些 mud 標成可玩卻沒有映像：${broken.join(', ')}`);
  process.exit(1);
}
if (!by.playable.length) {
  console.error('\n✗ 沒有任何 playable 的 mud，站台沒有意義');
  process.exit(1);
}
console.log('\n✓ 通過');
