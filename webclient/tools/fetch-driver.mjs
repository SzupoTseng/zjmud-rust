#!/usr/bin/env node
// 取得 WASM FluffOS driver（fluffos.js / fluffos.wasm）。
//
// 【WHY】driver 是 3.6 MB 的 wasm + 85 KB glue，可重新取得，不該進版控
// （倉庫已經因為 55 MB 的 driver.exe 被 README 特別解釋過一次了）。
//
// 【推理】官方 release 直接提供 `fluffos-<ver>-wasm.zip`（2.4 MB），
// 內含 driver、web 終端機範例與 pack-mudlib.sh，比自行 `cmake --preset wasm`
// （需要 emsdk 與數十分鐘）便宜好幾個量級。版本釘死在檔名裡，可重現。
//
// 【證據】https://github.com/fluffos/fluffos/releases 的 v2026.0729.0 資產清單：
// fluffos-v2026.0729.0-wasm.zip 2.4 MB（另兩個是 165 MB linux / 144 MB windows 原生版）。
//
// 用法：node tools/fetch-driver.mjs [版本]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'wasm', 'driver');

/** 釘死的版本。升級時改這一行，並重跑 wasm 測試。 */
export const DRIVER_VERSION = 'v2026.0729.0';

const version = process.argv[2] || DRIVER_VERSION;
const url = `https://github.com/fluffos/fluffos/releases/download/${version}/fluffos-${version}-wasm.zip`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffwasm-'));
const zip = path.join(tmp, 'wasm.zip');

console.log('下載', url);
execFileSync('curl', ['-sL', '-o', zip, url], { stdio: 'inherit' });
const size = fs.statSync(zip).size;
if (size < 100_000) {
  console.error(`下載失敗：只拿到 ${size} bytes（版本 ${version} 存在嗎？）`);
  process.exit(1);
}

execFileSync('unzip', ['-o', '-q', zip, '-d', tmp], { stdio: 'inherit' });
fs.mkdirSync(OUT, { recursive: true });
for (const f of ['fluffos.js', 'fluffos.wasm']) {
  fs.copyFileSync(path.join(tmp, f), path.join(OUT, f));
  console.log('  →', path.relative(process.cwd(), path.join(OUT, f)),
    (fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2), 'MB');
}
fs.writeFileSync(path.join(OUT, 'VERSION'), version + '\n');

// ★ 把這個目錄標成 CommonJS。
//
// 【WHY】症狀是 CI 的「建置站台」整支掛掉，第一個 mud 就死在
// `TypeError: createFluffOS is not a function`——本機卻永遠是好的。
//
// 【推理】webclient/package.json 寫了 `"type": "module"`，這個設定會往下
// 傳染到子目錄。emscripten 產生的 glue 是 CommonJS（結尾 `module.exports =
// createFluffOS`），被當成 ESM 解析時 node 24 的 require(esm) 不會報錯，
// 只會回一個沒有具名輸出的空命名空間物件——於是它「不是一個函式」。
// 本機看不到是因為這個檔案曾經用手寫過一份，而 wasm/driver/ 在 .gitignore
// 裡：修好的是我的工作目錄，不是任何一次乾淨簽出。這正是「本機好、CI 壞」
// 的完整解釋，也是為什麼修在這裡而不是在載入端加 workaround——
// 產生 driver 目錄的人有責任讓它可被載入。
//
// 【證據】乾淨 worktree（8f6f52f）重跑 CI 步驟，逐字重現同一個
// TypeError，位置在 tools/wasm-node.mjs:82 的 require(fluffos.js)；
// 補上這個檔案之後同一份 worktree 建置通過。
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({
  type: 'commonjs',
  private: true,
  comment: '由 tools/fetch-driver.mjs 產生：讓 emscripten 的 CJS glue 不被上層的 type=module 傳染',
}, null, 2) + '\n');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('完成：driver', version);
