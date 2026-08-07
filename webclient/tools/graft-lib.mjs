#!/usr/bin/env node
// 用同一款遊戲的另一份快照，補上封存缺件。
//
// 【WHY】nt7 的來源封存少了整個玩家層與整個世界：`clone/user/` 是空目錄
// （登入物件 `login.c` 與玩家物件 `user.c` 都不在），也沒有 `d/`（START_ROOM、
// BORN_ROOM、`/d/newbie/shijiezhishu` 這些 logind.c 第 2008-2044 行明確要用的房間），
// 連 `cmds/` 都沒有。master::connect() 的 `new(LOGIN_OB)` 因此必然失敗——
// 撥號直接被拒，任何相容性修正都救不回來，因為缺的是遊戲本體。
//
// 【推理】把另一款 mud 的世界搬過來會做出一個「不是 nt7 的 nt7」，那是偽造。
// 但如果來源是**同一款遊戲的另一份快照**，補齊就只是修復，不是創作。
// 判準要能量化：比對 kungfu/ 的檔名集合——武功目錄是一款 mud 最具指紋性的部分，
// 兩份不同遊戲不可能大量同名。實測 nt7 的 3,417 個 kungfu 檔與
// mudlibs-main 的 nitan170911 有 **3,314 個同名（99.7%）**，
// nitan6 95.5%、nitan_ceshi/nitan_san 87.3% —— 同一款遊戲的不同時間點快照，
// 而 nitan170911 是其中最接近的一份。
//
// 【規則只有一條】**目標 lib 自己有的檔一律不動**，只補它沒有的。
// 這樣 nt7 仍然是 nt7（它的 zjmud logind、它的 kungfu、它的 daemon 全部原封不動），
// 補進來的只有它遺失的那些檔。每一個補進來的檔都記在 mud.json 的 graft 欄位裡，
// 誰是外來的一查便知。
//
// 【證據】mudlibs-main 把原始碼副檔名改成 .lpc（見該倉庫 scripts/convert_lib.sh），
// 所以補進來時要改回 .c；該倉庫的檔案已經是 UTF-8（file(1) 實測），不需再轉碼。
//
// 用法：
//   node tools/graft-lib.mjs nt7 --from /mnt/g/.../libs/nitan170911/work
//   node tools/graft-lib.mjs nt7 --from <dir> --dry-run

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_FORMAT } from '../src/js/mudlibimage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIBS = path.resolve(HERE, '..', '..', 'libs');

/** mudlibs-main 用 .lpc 存原始碼；本專案的映像用 .c。 */
function normalizeName(rel) {
  return rel.replace(/\.lpc$/, '.c');
}

/**
 * 不該補進來的東西。
 *
 * 【WHY 要有這一條】第一次 dry-run 補出 51,380 檔／88 MB，其中 **32,777 個是
 * `data/` 底下的玩家存檔**——那是二十年前真實玩家的帳號資料，import-lib.mjs
 * 早就因為隱私把它們排除在外（`data/**\/*.o` 含明文 password 欄）。
 * 補齊缺件不能變成把隱私資料重新帶回來的後門，所以這裡沿用同一組規則，
 * 而且更嚴格：`data/` 整個不要（存檔本來就該由執行時產生）。
 *
 * 【推理】其餘排除的都是「執行時產物」而非遊戲內容：`temp/`（暫存）、
 * `log/`（別人伺服器的執行記錄）、`www/`（網站靜態檔，WASM 站台用不到）、
 * `mudos/`（driver 文件）。留下來的是真正缺的遊戲本體：
 * clone/、d/、cmds/ 這些。
 */
const SKIP_TOP = new Set(['data', 'temp', 'log', 'www', 'mudos', 'backup', 'node_modules']);
const SKIP_EXT = /\.(exe|dll|so|dylib|lib|obj|pdb|zip|rar|7z|gz|tgz|bz2|iso|mp3|wav|avi|mp4|psd|o)$/i;

function skip(rel) {
  const top = rel.split('/')[0];
  return SKIP_TOP.has(top)
    || /(^|\/)\.git(\/|$)/.test(rel)
    || /(^|\/)\.vscode(\/|$)/.test(rel)
    || SKIP_EXT.test(rel)
    || /\.(bak|orig|rej|swp)$/.test(rel)
    || /(^|\/)README\.md$/.test(rel)
    || /(^|\/)NOTES\.md$/.test(rel);
}

function walk(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (skip(r)) continue;
      if (e.isDirectory()) stack.push(r);
      else if (e.isFile()) out.push(r);
    }
  }
  return out;
}

function loadImage(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mudlib.json'), 'utf8'));
  const data = fs.readFileSync(path.join(dir, 'mudlib.data'));
  const files = new Map(manifest.files.map((f) => [f.path, data.subarray(f.at, f.at + f.size)]));
  return { manifest, files };
}

/**
 * 重算 manifest.dirs。
 *
 * 【WHY】unpackImage() 是先照 `manifest.dirs` 把目錄一次建完，再逐檔
 * `FS.writeFile`——寫檔時**不會**補建父目錄（那是熱迴圈，一萬多個檔）。
 * 補進來的 13,329 個 `d/…` 全都在新目錄裡，而 dirs 還是原本那份，
 * 於是第一個 `d/` 底下的檔就 `ErrnoError errno 44`（ENOENT），
 * 整個開機測試直接中止，而且錯誤訊息裡連檔名都沒有。
 *
 * 【推理】原本的 dirs 由 pack-lib 產生，補件之後它就過期了——**改了檔案表
 * 就必須一起改目錄表**，兩者是同一份事實的兩種索引。順便保留原 dirs 裡
 * 那些「沒有檔案的空目錄」（例如 log/、tmp/，driver 要求它們存在）。
 */
function rebuildDirs(manifest, files) {
  const set = new Set(manifest.dirs ?? []);      // 保留空目錄
  for (const p of files.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i += 1) set.add(parts.slice(0, i).join('/'));
  }
  // 父目錄一定要排在子目錄前面：unpackImage 的 mkdirp 是逐段建的，
  // 但 dirs 本身也要有序，否則先建子目錄會失敗。
  return [...set].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

function saveImage(dir, manifest, files) {
  const parts = [];
  const list = [];
  let at = 0;
  for (const [p, buf] of files) {
    list.push({ path: p, at, size: buf.length });
    parts.push(buf);
    at += buf.length;
  }
  const data = Buffer.concat(parts);
  fs.writeFileSync(path.join(dir, 'mudlib.json'), JSON.stringify({
    ...manifest, format: IMAGE_FORMAT, totalBytes: data.length,
    dirs: rebuildDirs(manifest, files), files: list,
  }));
  fs.writeFileSync(path.join(dir, 'mudlib.data'), data);
}

/**
 * 補齊。回傳補了哪些頂層目錄、各幾個檔。
 *
 * @param {Map<string,Buffer>} files 目標映像的檔案表（就地修改）
 * @param {string} from 參考樹的根目錄
 */
export function graft(files, from) {
  const added = new Map();      // 頂層目錄 → 檔數
  let bytes = 0;
  for (const rel of walk(from)) {
    const target = normalizeName(rel);
    if (files.has(target)) continue;             // ★ 目標自己有的一律不動
    let buf;
    try { buf = fs.readFileSync(path.join(from, rel)); } catch { continue; }
    files.set(target, buf);
    bytes += buf.length;
    const top = target.split('/')[0];
    added.set(top, (added.get(top) ?? 0) + 1);
  }
  return { added, bytes };
}

// ── CLI ────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const slug = process.argv[2];
  const i = process.argv.indexOf('--from');
  const from = i !== -1 ? process.argv[i + 1] : null;
  const dryRun = process.argv.includes('--dry-run');
  if (!slug || !from) {
    console.error('用法：node tools/graft-lib.mjs <slug> --from <參考 mudlib 根目錄> [--dry-run]');
    process.exit(2);
  }
  const dir = path.join(LIBS, slug);
  if (!fs.existsSync(path.join(dir, 'mudlib.json'))) {
    console.error(`${slug} 沒有映像`);
    process.exit(2);
  }

  const { manifest, files } = loadImage(dir);
  const before = files.size;
  console.log(`${slug}：原有 ${before} 檔`);
  console.log(`參考：${from}`);

  const { added, bytes } = graft(files, from);
  const total = [...added.values()].reduce((a, b) => a + b, 0);
  if (!total) { console.log('沒有需要補的檔案'); process.exit(0); }

  console.log(`補上 ${total} 檔 / ${(bytes / 1e6).toFixed(1)} MB：`);
  for (const [top, n] of [...added].sort((a, b) => b[1] - a[1])) console.log(`  ${top}/  ${n}`);
  if (dryRun) { console.log('（--dry-run，未寫入）'); process.exit(0); }

  saveImage(dir, manifest, files);

  // 出處寫進 mud.json：哪些目錄是外來的，一查便知
  const metaPath = path.join(dir, 'mud.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.graft = {
    from,
    reason: '來源封存缺件（clone/user、d、cmds 等），從同一款遊戲的另一份快照補齊',
    rule: '只補目標映像沒有的檔；目標自己有的一律不覆蓋',
    files: total,
    dirs: Object.fromEntries([...added].sort((a, b) => b[1] - a[1])),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  console.log(`已寫入映像，出處記在 ${path.relative(process.cwd(), metaPath)}`);
}
