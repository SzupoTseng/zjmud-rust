// 在 node 裡跑 WASM FluffOS —— 測試與打包管線共用的啟動器。
//
// 【WHY】瀏覽器版必須先把 mudlib 打包成 .data 映像才能載入；但驗證一個 mudlib
// 「能不能在 wasm driver 上開機」不該被打包工具綁住。node 端可以直接用
// Module.FS 把真實目錄灌進 MEMFS，於是不需要 emsdk 就能跑完整的開機測試。
//
// 【推理】release 的 driver 只帶 MEMFS（glue 裡沒有 NODEFS/NODERAWFS/IDBFS），
// 所以「掛載真實目錄」這條路不存在，只能複製。11,927 個檔 / 32 MB 實測 778 ms，
// 完全可接受——比起為了跑一次測試去裝 1 GB 的 emsdk 划算太多。
//
// 【證據】fluffos-v2026.0729.0-wasm.zip 的 fluffos.js：MEMFS 出現 47 次，
// NODEFS/IDBFS 零次；pack-mudlib.sh 的註解明講 file_packager 需要 emsdk on PATH。

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createWasmDriver } from '../src/js/wasmdriver.js';
import { unpackImage } from '../src/js/mudlibimage.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 驅動程式預設位置（由 tools/fetch-driver.mjs 取得，不進版控）。 */
export const DRIVER_DIR = path.resolve(HERE, '..', 'wasm', 'driver');

export function driverAvailable(dir = DRIVER_DIR) {
  // package.json 也算必要檔案：少了它 glue 會被上層的 type=module 當成 ESM
  // 解析，require 回傳空物件（見 loadGlue）。少檢查這一項的代價是「看起來有
  // driver、實際上載不起來」，在 CI 上就是白跑整個建置才在第一個 mud 掛掉。
  return ['fluffos.js', 'fluffos.wasm', 'package.json']
    .every((f) => fs.existsSync(path.join(dir, f)));
}

/**
 * 載入 emscripten glue，並在它不是函式時講清楚原因。
 *
 * 【WHY】這一行壞掉時原本的訊息是 `createFluffOS is not a function`，
 * 沒有任何線索指向真因（上層 package.json 的 type=module 傳染到 driver 目錄，
 * 讓 CJS glue 被當成 ESM 解析、require 回傳空命名空間）。CI 上為此白跑一次。
 *
 * 【推理】真正的修法在 fetch-driver.mjs（產生目錄的人負責讓它可載入），
 * 這裡只負責「壞掉時一眼看得出要做什麼」——所以是診斷訊息，不是 workaround。
 */
export function loadGlue(driverDir = DRIVER_DIR) {
  const glue = require(path.join(driverDir, 'fluffos.js'));
  const fn = typeof glue === 'function' ? glue : glue?.default;
  if (typeof fn !== 'function') {
    throw new Error(
      `${driverDir}/fluffos.js 沒有輸出可呼叫的工廠函式。`
      + `多半是缺少 ${driverDir}/package.json（內容 {"type":"commonjs"}）——`
      + '重跑 node tools/fetch-driver.mjs 會補上。',
    );
  }
  return fn;
}

/** 把真實目錄整棵複製進 MEMFS。回傳 {files, bytes}。 */
export function mountTree(FS, src, dst) {
  let files = 0;
  let bytes = 0;
  try { FS.mkdir(dst); } catch { /* 已存在 */ }
  const stack = [[src, dst]];
  while (stack.length) {
    const [s, d] = stack.pop();
    let ents;
    try { ents = fs.readdirSync(s, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const sp = path.join(s, e.name);
      const dp = d + '/' + e.name;
      if (e.isDirectory()) {
        try { FS.mkdir(dp); } catch { /* 已存在 */ }
        stack.push([sp, dp]);
      } else if (e.isFile()) {
        let buf;
        try { buf = fs.readFileSync(sp); } catch { continue; }
        FS.writeFile(dp, new Uint8Array(buf));
        files += 1;
        bytes += buf.length;
      }
    }
  }
  return { files, bytes };
}

/**
 * 啟動一台 mud。回傳 { driver, log, module, mount }。
 *
 * @param {object} opts
 * @param {string} opts.lib        mudlib 目錄（真實檔案系統）
 * @param {string} [opts.config]   設定檔（相對於 mudlib 根目錄）
 * @param {string} [opts.mount]    MEMFS 掛載點
 * @param {(line:string)=>void} [opts.onLine]
 */
export async function bootMud({
  lib,
  image,
  config = 'config.ini',
  mount = '/mudlib',
  driverDir = DRIVER_DIR,
  onLine = () => {},
  onClosed = () => {},
  tickMs = 20,
  promptFlush = false,
} = {}) {
  const createFluffOS = loadGlue(driverDir);
  const log = [];

  const M = await createFluffOS({
    print: (s) => log.push(s),
    printErr: (s) => log.push(s),
    locateFile: (f) => path.join(driverDir, f),
    noInitialRun: true,
  });

  // 兩種來源：真實目錄（開發／CI 的品質閘門）或打包好的映像（瀏覽器實際載入的那份）。
  // 兩者都要能跑，才能證明「打包沒有把東西弄丟」——這是唯一能抓到打包 bug 的測法。
  let stats;
  let bootConfig = config;
  if (image) {
    const manifest = JSON.parse(fs.readFileSync(path.join(image, 'mudlib.json'), 'utf8'));
    // 站台發佈的是 gzip 版（見 build-site）；版控裡是未壓縮的原件。
    // 兩種都要能開——**開機測試測的必須是實際會被載入的那份位元組**，
    // 否則「測過的」與「發佈的」是兩個東西。
    const gzPath = path.join(image, 'mudlib.data.gz');
    const bytes = fs.existsSync(gzPath)
      ? new Uint8Array(zlib.gunzipSync(fs.readFileSync(gzPath)))
      : new Uint8Array(fs.readFileSync(path.join(image, 'mudlib.data')));
    const r = unpackImage(M.FS, manifest, bytes);
    stats = { files: r.files, bytes: bytes.length };
    mount = manifest.mount || mount;
    bootConfig = manifest.config || config;
  } else {
    stats = mountTree(M.FS, lib, mount);
  }
  M.FS.chdir(mount);

  const driver = createWasmDriver(M, { onLine, onClosed, tickMs, promptFlush });

  // boot 失敗時 driver 會呼叫 exit(-1)，emscripten 把它包成 ExitStatus 丟出來。
  // 【WHY 要接住】不接的話整個 node 行程掛掉，而真正的原因（例如「設定檔不存在」）
  // 就在我們自己收集的 log 裡卻永遠印不出來——第一次遇到時看到的只有
  // `ExitStatus { status: -1 }`，完全指不出方向。
  let rc;
  try {
    rc = driver.boot(bootConfig);
  } catch (e) {
    log.push(`*** driver abort：${e?.message ?? e}`);
    rc = -1;
  }

  return { driver, module: M, log, mount, stats, rc };
}

/** 等到 predicate 為真或逾時。driver 的 tick 是 setInterval，所以純等待即可。 */
export function waitFor(predicate, { timeoutMs = 15000, stepMs = 50 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let ok = false;
      try { ok = predicate(); } catch { ok = false; }
      if (ok) { clearInterval(iv); resolve(true); return; }
      if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error('等待逾時')); }
    }, stepMs);
  });
}

/** 從 driver log 抽出「這個 mudlib 在 wasm 上壞掉的地方」。 */
export function summarizeLog(log) {
  const text = log.join('\n');
  const noProgram = [...text.matchAll(/No program in object '([^']+)'/g)].map((m) => m[1]);
  const undefinedFuncs = [...text.matchAll(/Undefined function ([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]);
  const errors = text.split('\n').filter((l) => /: error: /.test(l));
  return {
    loadFailures: [...new Set(noProgram)],
    undefinedFuncs: [...new Set(undefinedFuncs)],
    compileErrors: errors.length,
  };
}
