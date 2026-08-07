#!/usr/bin/env node
// 把 libs/<slug>/mudlib.data 解回檔案樹。
//
// 【WHY】版控裡放的是映像而不是檔案樹（理由與實測數字見 libs/README.md）。
// 那個決定的前提是「任何人都能一行指令把它解開」——否則就是把別人的 mudlib
// 鎖進一個自訂格式裡，那對一個以「保存」為目的的收藏是不可接受的。
//
// 【推理】所以這支工具是那個取捨的**對價**，不是附屬品：只要它存在且能用，
// 映像就只是一種儲存形式；它不存在的話，映像就是一種鎖定。
//
// 用法：node tools/unpack-lib.mjs <libs/slug 目錄> --out <目錄>

import fs from 'node:fs';
import path from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const dir = process.argv[2];
const out = arg('out');
if (!dir || !out) {
  console.error('用法：node tools/unpack-lib.mjs <libs/slug 目錄> --out <目錄>');
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mudlib.json'), 'utf8'));
const data = fs.readFileSync(path.join(dir, 'mudlib.data'));

fs.mkdirSync(out, { recursive: true });
for (const d of manifest.dirs) fs.mkdirSync(path.join(out, d), { recursive: true });
for (const f of manifest.files) {
  const dst = path.join(out, f.path);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, data.subarray(f.at, f.at + f.size));
}
console.log(`解開 ${manifest.files.length} 個檔案 / ${manifest.dirs.length} 個目錄 → ${out}`);
console.log(`設定檔：${manifest.config}　掛載點：${manifest.mount}`);
