#!/usr/bin/env node
// 每一台 mud 都開一次機、登入一次，把 driver log 裡的**例外與錯誤**全部撈出來分類。
//
// 【WHY】boot-test 的判準是「走不走得完登入」，走完就給 playable。但走得完不代表
// 過程中沒事：LPC 的 runtime error 會被 mudlib 自己的 error handler 吃掉，
// 載入失敗的物件也只是「那個功能不存在」。這些在分級上看不到，
// 卻正是玩下去之後會踩到的東西。
//
// 【推理】所以要分開看三類，而且**不要混為一談**：
//   ① 執行時例外（runtime error / *Xxx denied / error handler 攔截）→ 玩的時候會炸
//   ② 編譯錯誤（error: …）→ 那個檔的功能整個不存在
//   ③ WASM build 缺的 efun（socket_/db_/crypto 那些 package 被關掉）→ 已知且無解，
//      單獨列出來，不要淹沒前兩類
// 分類的意義在於：③ 是環境限制、① 才是真的要修的東西。
//
// 用法：node tools/sweep-logs.mjs [--only <slug>] [--json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootTest } from './boot-test.mjs';
import { driverAvailable, DRIVER_DIR } from './wasm-node.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIBS = path.resolve(HERE, '..', '..', 'libs');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (!driverAvailable()) {
  console.error(`找不到 driver（${DRIVER_DIR}）——先跑 node tools/fetch-driver.mjs`);
  process.exit(2);
}

/** WASM build 關掉的 package——這些 efun 缺席是環境限制，不是 mudlib 的錯。 */
const WASM_MISSING = /^(socket_|db_|external_|ffi_|pcre_|crypt_|async_|compress|uncompress)/;

const only = arg('only');
const slugs = fs.readdirSync(LIBS)
  .filter((d) => fs.existsSync(path.join(LIBS, d, 'mudlib.json')))
  .filter((d) => !only || d === only);

const report = [];
for (const slug of slugs) {
  const dir = path.join(LIBS, slug);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mudlib.json'), 'utf8'));
  let proto = {};
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'mud.json'), 'utf8'));
    if (meta.protocol) proto = { protocol: meta.protocol, loginProfile: meta.loginProfile };
  } catch { /* 沒有 mud.json 照舊 */ }
  const res = await bootTest({
    image: dir, config: manifest.config || 'config.ini', keepLog: true, ...proto,
  });

  const log = res.rawLog ?? [];
  const runtime = [];
  const compile = [];
  const missingEfun = new Set();

  for (const line of log) {
    // ① 執行時例外：driver 的英文訊息，以及 mudlib 自己翻譯過的中文訊息
    if (/执行时段错误|運行時錯誤|runtime error|错误讯息被拦截|Error in mudlib error handler|\*[A-Z][\w ]+ denied|No program in object/.test(line)) {
      runtime.push(line.trim());
      continue;
    }
    // ③ 先分流缺 efun，免得它們淹沒 ②
    const m = line.match(/Undefined function\s+(\w+)/);
    if (m) {
      if (WASM_MISSING.test(m[1])) { missingEfun.add(m[1]); continue; }
      compile.push(line.trim());
      continue;
    }
    if (/^\s*\S+:\d+(:\d+)?: error:/.test(line)) compile.push(line.trim());
  }

  const uniq = (a) => [...new Set(a)];
  const row = {
    slug,
    badge: res.badge,
    runtime: uniq(runtime),
    compile: uniq(compile),
    loadFailures: res.loadFailures ?? [],
    missingEfun: [...missingEfun],
  };
  report.push(row);

  const mark = row.runtime.length ? '⚠' : '✓';
  console.log(`${mark} ${slug.padEnd(20)} ${res.badge.padEnd(9)}`
    + ` 執行時例外 ${String(row.runtime.length).padStart(3)}`
    + ` / 編譯錯誤 ${String(row.compile.length).padStart(3)}`
    + ` / 載入失敗 ${String(row.loadFailures.length).padStart(2)}`
    + ` / 缺 efun ${row.missingEfun.length}`);
  for (const r of row.runtime.slice(0, 3)) console.log(`      ⚠ ${r.slice(0, 150)}`);
  if (row.runtime.length > 3) console.log(`      … 另有 ${row.runtime.length - 3} 筆`);
}

if (process.argv.includes('--json')) {
  fs.writeFileSync(path.join(HERE, '..', 'wasm', 'log-report.json'), JSON.stringify(report, null, 2));
}

const withRuntime = report.filter((r) => r.runtime.length);
console.log(`\n${report.length} 台：${withRuntime.length ? `${withRuntime.length} 台有執行時例外（${withRuntime.map((r) => r.slug).join(' ')}）` : '沒有任何執行時例外'}`);
// 執行時例外不擋發佈——多半是 mudlib 自己的舊 bug，不是我們造成的；
// 但一定要印出來，不能靜靜吞掉。真正擋發佈的是 check-badges。
process.exit(0);
