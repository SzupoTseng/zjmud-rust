#!/usr/bin/env node
// 把一個 mudlib 目錄打包成瀏覽器可載入的映像（mudlib.json + mudlib.data）。
//
// 【WHY 不用官方 pack-mudlib.sh】見 src/js/mudlibimage.js 的檔頭：
// 那支需要 emsdk 在 PATH 上；本專案要打包十幾個 mudlib、還要在 CI 跑，
// 為此背一整套 emscripten 工具鏈不划算，而我們需要的只是「檔案樹 → blob + 索引」。
//
// 【推理】打包端與載入端必須共用同一份格式定義，否則會出現「打包時對、載入時錯」
// 這種最難查的問題。所以格式版本號放在 mudlibimage.js（載入端），打包端 import 它。
//
// 【證據】fluffos_boot 是明確呼叫而非 main()，所以不需要 emscripten preRun
// 生命週期（src/wasm/main_wasm.cc）；driver glue 只帶 MEMFS，沒有 NODEFS。
//
// 用法：node tools/pack-lib.mjs <mudlib-dir> --out <dir> [--mount /mudlib] [--config config.ini]

import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_FORMAT } from '../src/js/mudlibimage.js';

/** 一律不打包的東西：執行檔、備份、日誌、版控與執行期產物。 */
export const DEFAULT_EXCLUDES = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)backup(\/|$)/,
  /(^|\/)OBJ_DUMP(\/|$)/,
  /(^|\/)PROG_DUMP(\/|$)/,
  /\.(exe|dll|so|dylib|zip|rar|7z|psd)$/i,
  /(^|\/)log\/.+/,          // log/ 目錄要留著（driver 會寫），但內容不打包
  /(^|\/)fluffos64(\/|$)/,
  /(^|\/)driver(\/|$)/,
];

export function shouldExclude(rel, extra = []) {
  return [...DEFAULT_EXCLUDES, ...extra].some((re) => re.test(rel));
}

/**
 * @returns {{manifest: object, data: Buffer}}
 */
export function buildImage(libDir, { mount = '/mudlib', config = 'config.ini', excludes = [] } = {}) {
  const dirs = [];
  const files = [];
  const parts = [];
  let at = 0;

  const walk = (absDir, rel) => {
    let ents;
    try { ents = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of ents) {
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (shouldExclude(childRel, excludes)) continue;
      const abs = path.join(absDir, e.name);
      if (e.isDirectory()) {
        dirs.push(childRel);          // 父目錄必然先被 push（深度優先、由上而下）
        walk(abs, childRel);
      } else if (e.isFile()) {
        let buf;
        try { buf = fs.readFileSync(abs); } catch { continue; }
        files.push({ path: childRel, at, size: buf.length });
        parts.push(buf);
        at += buf.length;
      }
    }
  };
  walk(libDir, '');

  const data = Buffer.concat(parts);
  const manifest = {
    format: IMAGE_FORMAT,
    mount,
    config,
    totalBytes: data.length,
    dirs,
    files,
  };
  return { manifest, data };
}

// ── CLI ────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => {
    const i = process.argv.indexOf('--' + n);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
  };
  const lib = process.argv[2];
  const out = arg('out');
  if (!lib || !out) {
    console.error('用法：node tools/pack-lib.mjs <mudlib-dir> --out <dir> [--mount /mudlib] [--config config.ini]');
    process.exit(2);
  }
  const { manifest, data } = buildImage(path.resolve(lib), {
    mount: arg('mount', '/mudlib'),
    config: arg('config', 'config.ini'),
  });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'mudlib.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(out, 'mudlib.data'), data);
  console.log(`打包完成：${manifest.files.length} 檔 / ${manifest.dirs.length} 目錄 / `
    + `${(data.length / 1e6).toFixed(1)} MB → ${out}`);
}
