#!/usr/bin/env node
// 簡繁通吃驗證：每一台 mud 都用**簡體**與**繁體**的名字各建一次角。
//
// 【WHY】使用者建角被擋（「你的中文姓名不能太长或太短」），而我們的測試 17 台全過。
// 差別只在測試用的名字剛好是四個字，而這些 mudlib 的長度檢查數的是 GBK 位元組
// （`i < 4 || i > 8 || i%2`）——轉 UTF-8 之後只有**剛好四個字**的名字通得過。
// 一個 15/17 台都有的 bug，被一筆巧合的測試資料藏住了。
//
// 【推理】所以驗證要沿著**使用者真的會打什麼**展開，而不是沿著「哪個值會過」。
// 兩個維度各取最容易踩雷的一端：
//   長度 → 取下限的兩個字（不是四個字）
//   字集 → 簡體與繁體各一次（原本是 GBK，只認簡體；轉 UTF-8 後沒有理由擋繁體）
// 這支腳本把兩個維度乘起來跑，任何一格不過就是紅燈。
//
// 【證據】修正前跑這支：91书剑／大梦江湖 等 15 台在兩個字的名字上全部卡在
// creating；修正後（is_chinese 改碼點＋長度界限換算成字數）簡繁兩組全數進世界。
//
// 用法：node tools/sweep-names.mjs [--only <slug>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootTest } from './boot-test.mjs';
import { driverAvailable, DRIVER_DIR } from './wasm-node.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIBS = path.resolve(HERE, '..', '..', 'libs');

/** 同一個詞的兩種寫法，兩個字——長度與字集兩個維度的最容易踩雷點。 */
const NAMES = [
  { label: '簡體', name: '无名' },
  { label: '繁體', name: '無名' },
];

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (!driverAvailable()) {
  console.error(`找不到 driver（${DRIVER_DIR}）——先跑 node tools/fetch-driver.mjs`);
  process.exit(2);
}

const only = arg('only', null);
// ★ `--limit N`：只抽驗 N 台。
//
// 【WHY】這一關對**每一台**跑兩次開機測試（簡體名 × 繁體名）。
// 收藏從 17 台長到 114 台之後，它從 34 次開機變成 228 次——
// CI 跑十分鐘還沒完就被判失敗，而**沒有任何一台真的壞掉**。
// 閘門的成本隨收藏規模等比成長，這是規模問題不是正確性問題。
// 【WHY 抽驗仍然有效】這一關要抓的是「GBK 位元組長度假設」這類
// **家族層級**的缺陷（見 CLAUDE.md §3），同一家族的台會一起中招；
// 抽驗涵蓋到每個家族就抓得到，不需要每台都跑。
// 【WHY 不預設開啟】本機要能跑完整版——CI 才傳 --limit。
const limit = Number(arg('limit', '0'));
let slugs = fs.readdirSync(LIBS)
  .filter((d) => fs.existsSync(path.join(LIBS, d, 'mudlib.json')))
  // ★ 只掃已知可玩的台。
  //
  // 【WHY】拿「建角後要進得了世界」這個斷言去驗一台**已知 limited** 的 mud，
  // 必然紅——而紅了不代表退化，那是**把已知狀態當新聞報**。
  // 實測 nitan7（原生 zjmud 混血台，spec §D8 記錄「不該轉換」）因此讓
  // 整個 CI 失敗，而它從頭到尾都是 limited、沒有任何東西壞掉。
  // 【證據】sweep-web 早就有這條規則（badge === 'playable'），
  // 只是 sweep-names 沒跟上——**同一條紀律要在每個閘門重新確認一次**。
  .filter((d) => {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(LIBS, d, 'mud.json'), 'utf8'));
      return (meta.badge ?? meta.convert?.lastCheck?.badge ?? 'playable') === 'playable';
    } catch { return true; }      // 沒有 mud.json 就照舊掃
  })
  .filter((d) => !only || d === only);
if (limit > 0 && slugs.length > limit) {
  // 平均取樣而不是取前 N 個：前 N 個會集中在字母序開頭的同一批家族
  const step = slugs.length / limit;
  slugs = Array.from({ length: limit }, (_, i) => slugs[Math.floor(i * step)]);
  console.log(`（抽驗 ${limit}/${fs.readdirSync(LIBS).length} 台，平均取樣）`);
}

const rows = [];
let bad = 0;
for (const slug of slugs) {
  const dir = path.join(LIBS, slug);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mudlib.json'), 'utf8'));
  // telnet 台（mudlibs-main）沒有 zjmud 的 ║ 建角流程，名字掃描不適用
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'mud.json'), 'utf8'));
    if (meta.protocol === 'telnet') { console.log(slug.padEnd(20) + ' （telnet，略過）'); continue; }
  } catch { /* 沒有 mud.json 照舊 */ }
  const row = { slug, results: {} };
  for (const { label, name } of NAMES) {
    let res;
    try {
      res = await bootTest({ image: dir, config: manifest.config || 'config.ini', charName: name });
    } catch (e) {
      res = { badge: 'error', reason: e?.message ?? String(e) };
    }
    row.results[label] = res;
    if (res.badge !== 'playable') bad += 1;
  }
  const line = NAMES.map(({ label }) => {
    const r = row.results[label];
    return `${label} ${r.badge === 'playable' ? '✓' : '✗ ' + (r.reason ?? '')}`;
  }).join('   ');
  console.log(`${slug.padEnd(20)} ${line}`);
  rows.push(row);
}

console.log(`\n${slugs.length} 台 × ${NAMES.length} 種寫法 = ${slugs.length * NAMES.length} 組，`
  + `${bad ? `**${bad} 組沒進世界**` : '全部進世界'}`);
process.exit(bad ? 1 : 0);
