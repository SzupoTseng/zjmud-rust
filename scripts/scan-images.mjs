#!/usr/bin/env node
// 掃**映像內部**的玩家存檔與憑證 —— privacy-scan.sh 的第 ⓪ 節。
//
// 【WHY 需要這一支】`privacy-scan.sh` 原本用 `find … -name '*.o'` 掃磁碟，
// 而 libs/ 底下每一台只有三個檔：mud.json / mudlib.json / mudlib.data.gz。
// 真正發佈出去的內容全部打包在那個 blob 裡——**閘門看的地方，跟產品發佈的
// 東西不是同一個**。實測：184 台的映像裡帶著 45,692 個真人玩家存檔
// （含 crypt 密碼雜湊、姓名、上線紀錄），而磁碟掃描一路回報「✓ 乾淨」。
//
// 【判準】與 fix-image.mjs 的 stripPlayerSaves 完全一致：路徑像登入／人物
// 存檔目錄，或內容有帶值的 password 欄。兩份判準必須同源，否則
// 「修的」與「驗的」會慢慢分岔（那正是這次缺口存在這麼久的原因）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { isPlayerSave } from '../webclient/tools/lib/player-saves.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIBS = path.resolve(HERE, '..', 'libs');
// 判準**不在這裡**——它與 stripPlayerSaves 共用同一份
// （webclient/tools/lib/player-saves.mjs）。本節之所以存在，就是因為
// 「修的」與「驗的」原本是兩份會漂移的程式碼（CLAUDE.md §52）。

let bad = 0;
for (const slug of fs.readdirSync(LIBS).sort()) {
  const dir = path.join(LIBS, slug);
  const mj = path.join(dir, 'mudlib.json');
  if (!fs.existsSync(mj)) continue;
  const manifest = JSON.parse(fs.readFileSync(mj, 'utf8'));
  const dat = path.join(dir, 'mudlib.data');
  const gz = path.join(dir, 'mudlib.data.gz');
  let blob;
  if (fs.existsSync(dat)) blob = fs.readFileSync(dat);
  else if (fs.existsSync(gz)) blob = zlib.gunzipSync(fs.readFileSync(gz));
  else continue;
  const hits = [];
  for (const f of manifest.files) {
    // ★ **不要**在這裡自己加前置過濾。
    //
    // 【WHY】原本這行是 `if (!f.path.endsWith('.o')) continue;`——區分大小寫，
    // 而 esI 的存檔是 `data/attic/user/ABEL.O`（大寫 .O，老 MudOS 的習慣）。
    // 於是約 190 筆真人存檔在進到判準之前就被跳過，掃描器回報「乾淨」，
    // 而 stripPlayerSaves 用 `/\.o$/i` 抓得到——**修的看得到、驗的看不到**。
    // 判準已經自己會判副檔名了；多這一行不是最佳化，是一個新的分岔點
    // （CLAUDE.md §60：發現第二份判準時要刪掉它，不是把它改成一樣）。
    if (isPlayerSave(f.path, blob.subarray(f.at, f.at + f.size))) hits.push(f.path);
  }
  if (hits.length) {
    bad += hits.length;
    console.log(`  ✗ ${slug}：映像裡有 ${hits.length} 個玩家存檔（例：${hits.slice(0, 2).join('、')}）`);
  }
}
if (bad) {
  console.log(`  → 共 ${bad} 筆。跑 \`node webclient/tools/fix-image.mjs <slug>\`（含 stripPlayerSaves）移除。`);
  process.exit(1);
}
console.log('  ✓ 映像內部沒有玩家存檔');
