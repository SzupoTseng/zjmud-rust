#!/usr/bin/env node
// 只套**指定的一個** fixup 到既有映像。
//
// 【WHY】`fix-image.mjs` 是設計在**轉換之前**跑的（batch-convert 的第 ② 步：
// import → fix → convert）。我在已經轉換完的映像上跑了全部 23 個修正，
// 結果 `fixMissingQuerySimulEfun` 又補了一次 simul_efun，
// tianya2 與 xiaoaojianghu 當場從 playable 掉成 noboot（`fluffos_connect 失敗`）。
// 兩台都已從 git 還原。
//
// 【推理】「補一個新發現的缺陷到既有收藏」是常態需求，而它跟
// 「從零轉換一台」是**不同的操作**：前者必須是最小手術，
// 只動那一處；後者才適合把整組修正跑一遍。工具要把這兩件事分開，
// 否則下一次還會犯同一個錯（CLAUDE.md §16：批次操作前先確認
// 「這個東西該不該被動」）。
//
// 用法：
//   node tools/apply-fixup.mjs fixCommandDirExt <slug> [<slug>…]
//   node tools/apply-fixup.mjs --list
//   node tools/apply-fixup.mjs --dry-run --all <fixup>   ← 這條會動到哪幾台？
//
// ★ 新增 fixup 一律先跑 `--dry-run --all`。
//
// 【WHY】新規則的第一版通常太貪心，而**乾跑名單是唯一能事先看到的證據**。
// 實測兩次：`fixMudPortMismatch` 第一版取 switch 的第一個 case，
// 名單裡有 5 台現役可玩的台會被改成 HTTP 埠（4015）或錯誤碼（1）——
// 直接套用就是「用一條修好一台的規則弄壞五台」；
// `fixVoidReturnValue` 命中 156 個檔、語意也正確，套下去 nitan7 卻退化。
// 【判準】名單長不代表要全部套用（CLAUDE.md §34：範圍由症狀決定，
// 不是由樣式決定）。這支工具只負責讓你**看得到**名單。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as FI from './fix-image.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIBS = path.resolve(HERE, '..', '..', 'libs');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dryRun = process.argv.includes('--dry-run');
const allLibs = process.argv.includes('--all');
if (process.argv.includes('--list')) {
  console.log(FI.FIXUPS.map((f) => f.name).join('\n'));
  process.exit(0);
}
const [name, ...rest] = args;
const fix = FI.FIXUPS.find((f) => f.name === name);
if (!fix) {
  console.error(`不認得的 fixup：${name}\n可用的：\n  ${FI.FIXUPS.map((f) => f.name).join('\n  ')}`);
  process.exit(2);
}
// `--all` 時掃全部映像；否則要指名。
const slugs = allLibs
  ? fs.readdirSync(LIBS).filter((d) => fs.existsSync(path.join(LIBS, d, 'mudlib.json'))).sort()
  : rest;
if (!slugs.length) { console.error('需要至少一個 slug（或用 --all）'); process.exit(2); }
if (allLibs && !dryRun) {
  // 【WHY 擋住】`--all` 而且真的寫入 ＝ 一次改幾百台映像，
  // 那既是 §34 的反面（範圍由樣式決定），也會讓 .git 一次長好幾 GB
  // （`.gz` 對 delta 壓縮免疫，重建一台就多一份全尺寸副本）。
  // 要真的批次套用時，請把乾跑名單看過，再逐台指名。
  console.error('--all 只能配 --dry-run。看過名單之後請逐台指名（CLAUDE.md §34）。');
  process.exit(2);
}

let changed = 0;
const hits = [];
for (const slug of slugs) {
  const dir = path.join(LIBS, slug);
  if (!fs.existsSync(path.join(dir, 'mudlib.json'))) { console.log(`[skip] ${slug}：沒有映像`); continue; }
  let img;
  try { img = FI.loadImage(dir); } catch (e) { console.log(`[err ] ${slug}：${e.message}`); continue; }
  const note = fix(img.manifest, img.files);
  if (!note) { if (!allLibs) console.log(`[ok  ] ${slug}：不需要`); continue; }
  hits.push(slug);
  if (dryRun) { console.log(`[乾跑] ${slug}：${note}`); continue; }
  FI.saveImage(dir, img.manifest, img.files);
  changed += 1;
  console.log(`[fix ] ${slug}：${note}`);
}
// ★ 影響面要用數字說，不要用感覺說（CLAUDE.md §37）。
// 這兩個數字可以直接抄進 commit message。
console.log(`\n${name}：掃了 ${slugs.length} 台，`
  + `**${hits.length} 台會被動到**，${slugs.length - hits.length} 台不受影響`
  + (dryRun ? '（乾跑，沒有寫入）' : `，實際寫入 ${changed} 台`));
if (dryRun && hits.length) console.log(`受影響：${hits.join(' ')}`);
