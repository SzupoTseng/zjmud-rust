#!/usr/bin/env node
// 規則覆蓋圖 —— 哪幾台缺哪一條修正？
//
// 【WHY 不用 `apply-fixup --dry-run --all`】那支一次只看一條規則，
// 而每條都要把 213 台的映像重新解壓一次。29 條就是 6177 次解壓。
// 這支反過來：**一台載入一次，把 29 條全部跑過**，總共 213 次解壓。
//
// 【WHY 需要這張圖】規則是一條一條長出來的，而映像是在不同時間點產生的。
// 於是「這台有沒有套到某條後來才寫的修正」沒有人知道——直到它出問題。
// 這張圖把那件事變成可以查的表。
//
// ★★ 判讀的鐵則：**「會觸發」不等於「這台壞了」**。
//
// 絕大多數規則是「遇到某種寫法就放寬它」，而那種寫法本來就不一定會造成症狀。
// 實測：`fixValidReadOwnData` 對 194 台會觸發，而那 194 台**全部是 playable**。
// 這條規則當初是為了修 `hy`（valid_read 擋住 mudlib 讀自己的天氣表 →
// daemon 建不起來 → look 失敗 → 玩家看到「什麼？」）——但同樣的寫法在
// 別台身上沒有造成任何症狀。
//
// 所以這張表的正確用法是：
//   ① 某台出現症狀時，查它缺哪幾條 → 有候選就**只重建那一台**，量結果
//   ② 想知道某條新規則的影響面 → 看數字（§37：影響面要用數字說）
// **不是**「把所有會觸發的都套用一遍」——那是 §34 的反面
// （範圍該由症狀決定，不是由樣式決定），而且一次改幾百台映像
// 會讓 .git 一次長好幾 GB（`.gz` 對 delta 壓縮免疫）。
//
// 用法：node tools/audit-fixups.mjs [--list-all]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as FI from './fix-image.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIBS = path.resolve(HERE, '..', '..', 'libs');
const listAll = process.argv.includes('--list-all');

const tally = new Map();
const slugs = fs.readdirSync(LIBS)
  .filter((d) => fs.existsSync(path.join(LIBS, d, 'mudlib.json'))).sort();

let scanned = 0;
for (const slug of slugs) {
  let img;
  try { img = FI.loadImage(path.join(LIBS, slug)); } catch { continue; }
  scanned += 1;
  for (const fix of FI.FIXUPS) {
    let note = null;
    // 【WHY 要接住例外】一條規則對某台丟例外不該讓整張圖產不出來——
    // 那正是這張圖最該告訴我們的事情之一。
    try { note = fix(img.manifest, img.files); } catch (e) { note = 'ERR ' + e.message.slice(0, 60); }
    if (!note) continue;
    if (!tally.has(fix.name)) tally.set(fix.name, []);
    tally.get(fix.name).push(slug);
  }
}

console.log(`掃了 ${scanned} 台，${FI.FIXUPS.length} 條修正`);
console.log('（「會觸發」＝這台還沒套過這條，**不等於這台壞了**——見檔案開頭）\n');
const rows = [...tally].sort((a, b) => b[1].length - a[1].length);
for (const [name, list] of rows) {
  console.log(`${String(list.length).padStart(4)} 台  ${name}`);
  if (listAll || list.length <= 8) console.log(`        ${list.join(' ')}`);
}
if (!rows.length) console.log('沒有任何一條會動到任何一台（全部映像都是最新規則產生的）');
