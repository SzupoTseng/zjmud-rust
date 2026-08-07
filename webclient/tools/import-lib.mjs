#!/usr/bin/env node
// 從 mudlib 收藏匯入一個 mud，整理成可以打包進瀏覽器的形狀。
//
// 【WHY】收藏裡的 mudlib 是「Windows 上直接開 driver.exe 就能跑」的形態：
// GBK 原始碼、隨附 32 位元執行檔、玩家存檔、營運者憑證、幾十 MB 的日誌與備份。
// 這三件事都不能就這樣放上 GitHub Pages：
//   ① 編碼——WASM build 只帶演算法式字集，GBK 這種表格式字集會 raise error
//   ② 隱私——老 mudlib 的 data/ 裡是真實玩家存檔，include/ 裡常有真憑證
//   ③ 體積——執行檔／備份／日誌佔的比例極高，而且對瀏覽器版完全無用
//
// 【推理】這三件事都必須**自動化**：17 個 mudlib 人工處理不可行，而且人工處理
// 的結果無法重跑、無法驗證。所以匯入是一支工具，輸出包含一份「改了什麼」的清單
// （NOTES.md），下次來源更新時整段重跑即可。
//
// 【證據】本倉庫 SECURITY_NOTES.md 記錄了上游同一批問題：
// `adm/etc/config` 的 SMTP 授權碼、`include/mysql.h` 的 root 密碼、
// `cmwhod.c` 的互聯密碼、`data/login/t/*.o` 的明文密碼存檔。
// 收藏裡的其他 mudlib 是同一個生態的產物，預設假定它們也有。
//
// 用法：
//   node tools/import-lib.mjs "<來源目錄>" --slug <slug> [--title "名字"] [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPlayerSave, SAVE_DIRS } from './lib/player-saves.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const LIBS = path.join(REPO, 'libs');

// ── 排除規則 ────────────────────────────────────────

/** 整個目錄不要。 */
const SKIP_DIRS = new Set([
  '.git', 'backup', 'OBJ_DUMP', 'PROG_DUMP', 'fluffos64', 'driver', 'binaries',
  '__MACOSX', 'node_modules',
  // 【WHY 補這三個】它們是營運中的傾印／備份目錄，內容全是玩家存檔
  // （`dump/2020-6-15/login/…`、`drop/login_bak/…`、`suicide/login/…`）。
  // 逐檔判斷也擋得住，但整個目錄跳過更省事，也少一次讀檔。
  ...SAVE_DIRS,
]);

/** 副檔名不要（執行檔、壓縮檔、大型媒體）。 */
const SKIP_EXT = /\.(exe|dll|so|dylib|lib|obj|pdb|zip|rar|7z|gz|tgz|bz2|iso|mp3|wav|avi|mp4|psd)$/i;

/** 這些目錄只保留目錄本身（driver 需要它存在），內容不要。 */
const EMPTY_DIRS = new Set(['log', 'tmp']);

/** 純二進位、不嘗試轉碼的副檔名。 */
const BINARY_EXT = /\.(png|jpg|jpeg|gif|bmp|ico|ttf|otf|woff2?|pdf|db|dat)$/i;

/** 可能藏憑證的檔案（會做遮蔽）。 */
const CREDENTIAL_FILES = [
  /(^|\/)include\/mysql\.h$/i,
  /(^|\/)adm\/etc\/config$/i,
  /(^|\/)adm\/daemons\/network\//i,
  /(^|\/)cmds\/usr\/api_/i,
];

/** 憑證特徵。與 SECURITY_NOTES.md §5 ④ 同一條：認得「密碼長什麼樣」而非特定值。 */
const SECRET_RE = /((?:password|passwd|pwd|secret|api_?key|token|授权码|授權碼)\s*[:=]\s*")([^"]{6,})"/gi;

// ── 工具 ────────────────────────────────────────────

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

function isValidUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * 找出 mudlib 根目錄：底下同時有 include/ 與 (adm/ 或 cmds/) 的那一層。
 * 收藏裡的目錄常常包了兩三層（`91书剑(zj)/91shujian/91shujian/`）。
 */
export function findMudlibRoot(start) {
  const queue = [[start, 0]];
  const found = [];
  while (queue.length) {
    const [dir, depth] = queue.shift();
    if (depth > 4) continue;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const names = new Set(ents.filter((e) => e.isDirectory()).map((e) => e.name));
    if (names.has('include') && (names.has('adm') || names.has('cmds'))) {
      const score = (fs.existsSync(path.join(dir, 'include', 'zjmud.h')) ? 10 : 0)
        + (names.has('adm') ? 1 : 0) + (names.has('d') ? 1 : 0);
      found.push({ dir, score });
    }
    for (const e of ents) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) queue.push([path.join(dir, e.name), depth + 1]);
    }
  }
  found.sort((a, b) => b.score - a.score);
  return found[0]?.dir ?? null;
}

/**
 * 找設定檔：driver 的第一個參數。
 *
 * 【WHY】收藏裡的檔名完全沒有共識：`config.ini`、`config.cfg`、**`config.hell`**、
 * `config.mud`… 第一版只認 `config.ini`／`*.cfg`，於是「谁与争锋」被記成
 * config.ini（不存在），driver 一開機就 `exit(-1)`，而錯誤訊息在 emscripten
 * 的 abort 裡，看起來像是打包壞掉。
 *
 * 【推理】最可靠的來源不是猜檔名，而是**原作者自己怎麼啟動的**——
 * mudlib 根目錄的啟動批次檔裡就寫著 `driver.exe <config>`。
 * 猜檔名只當備援。
 *
 * 【證據】`谁与争锋(原版zj)/hell/startlib-64.bat` → `driver config.hell`；
 * LPMud-Name 的 `startlib.bat` → `driver.exe config.ini`。
 */
export function findConfig(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => e.name);

  // ① 從啟動批次檔／腳本裡抓 driver 的第一個參數
  for (const name of entries.filter((n) => /\.(bat|cmd|sh)$/i.test(n))) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, name), 'latin1'); } catch { continue; }
    const m = text.match(/^[^\S\n]*(?:\.[\\/])?(?:[\w.-]*driver[\w.-]*|mudos[\w.-]*)(?:\.exe)?\s+([^\s%<>|&]+)/im);
    if (m && entries.includes(m[1])) return m[1];
  }

  // ② 檔名猜測：config 開頭的任何檔案
  const cands = entries.filter((n) => /^config($|\.)/i.test(n) || /\.(cfg|ini)$/i.test(n));
  cands.sort((a, b) => {
    const rank = (n) => (/^config\.ini$/i.test(n) ? 0 : /^config\.cfg$/i.test(n) ? 1
      : /^config($|\.)/i.test(n) ? 2 : 3);
    return rank(a) - rank(b) || a.length - b.length;
  });
  return cands[0] ?? null;
}

// ── 主流程 ──────────────────────────────────────────

export function importLib(srcRoot, { slug, title, dryRun = false, stageDir = null } = {}) {
  const root = findMudlibRoot(srcRoot);
  if (!root) throw new Error(`在 ${srcRoot} 底下找不到 mudlib 根目錄（要同時有 include/ 與 adm/ 或 cmds/）`);

  const configName = findConfig(root);
  const dstLib = path.join(LIBS, slug);
  // 整理後的檔案樹寫到哪裡：
  //   stageDir 有值 → 本機暫存區（之後由 import-all 打包成單一映像進版控）
  //   沒有         → libs/<slug>/work（開發時想直接看檔案樹用）
  // 【WHY】9P 寫入實測只有 28 檔/分，一個 mudlib 一萬個小檔要五小時；
  // 打包成一個 30 MB 的映像只要寫兩個檔。差別不是優化，是可行與不可行。
  const dstWork = stageDir ? path.join(stageDir, 'work') : path.join(dstLib, 'work');

  const report = {
    slug,
    source: srcRoot,
    root,
    config: configName,
    files: 0,
    bytes: 0,
    skipped: 0,
    converted: [],          // GBK → UTF-8
    redacted: [],           // 遮蔽掉的憑證
    droppedSaves: [],       // 含密碼的玩家存檔
    encodingCalls: [],      // set_encoding("GBK") 出現處
    warnings: [],
  };

  if (!dryRun) {
    fs.rmSync(dstWork, { recursive: true, force: true });
    fs.mkdirSync(dstWork, { recursive: true });
    fs.mkdirSync(dstLib, { recursive: true });
  }

  const walk = (absDir, rel, inEmptyDir = false) => {
    let ents;
    try { ents = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const childRel = rel ? rel + '/' + e.name : e.name;
      const abs = path.join(absDir, e.name);

      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) { report.skipped += 1; continue; }
        if (!dryRun) fs.mkdirSync(path.join(dstWork, childRel), { recursive: true });
        if (EMPTY_DIRS.has(e.name) || inEmptyDir) {
          // 【WHY 仍然要往下走】log/ 的**內容**不要（是別人伺服器的執行記錄，
          // 又大又是隱私），但**子目錄結構要留**：mudlib 會 log_file("static/logon"…)，
          // 而 MEMFS 不會自動建中間目錄，缺一個資料夾就會讓 logon() 失敗、
          // driver 直接把連線踢掉（實測：夺宝江湖 fluffos_connect 回 -1）。
          report.skipped += 1;
          walk(abs, childRel, true);
          continue;
        }
        walk(abs, childRel);
        continue;
      }
      if (!e.isFile()) continue;
      if (inEmptyDir) { report.skipped += 1; continue; }   // log/ 底下只要目錄
      if (SKIP_EXT.test(e.name)) { report.skipped += 1; continue; }

      let buf;
      try { buf = fs.readFileSync(abs); } catch { report.skipped += 1; continue; }

      // ① 玩家存檔：一律不要（隱私，且對展示站毫無用處）
      //
      // ★ 判準來自共用模組，**不要在這裡自己寫一份**。
      // 【WHY】原本這裡的條件是「路徑含 `data/`」＋「前 4096 bytes 有 password」，
      // 而真實世界的存檔多半不在 `data/` 底下：`temp/login/`、
      // `dump/2020-6-15/login/`、`drop/login_bak/`、`suicide/login/`、
      // `u/<巫師>/badplayer/login/`。實測 184 台映像裡因此夾帶了
      // **45,692 個**真人玩家存檔（含 crypt 密碼雜湊、姓名），一路發佈到公開站台，
      // 而 `privacy-scan.sh` 每輪都回報「✓ 沒有含密碼欄的存檔」——
      // 因為它掃的是磁碟，而存檔在打包後的 blob 裡（CLAUDE.md §52）。
      // 【判準同源】修的（fix-image 的 stripPlayerSaves）、驗的（scan-images）、
      // 擋的（這裡）現在共用 `lib/player-saves.mjs` 的 `isPlayerSave()`。
      if (isPlayerSave(childRel, buf)) {
        report.droppedSaves.push(childRel);
        continue;
      }

      // ② 編碼：非 UTF-8 的文字檔轉成 UTF-8（WASM 版沒有 GBK）
      if (!BINARY_EXT.test(e.name) && !isProbablyBinary(buf) && !isValidUtf8(buf)) {
        try {
          const text = new TextDecoder('gbk', { fatal: false }).decode(buf);
          buf = Buffer.from(text, 'utf8');
          report.converted.push(childRel);
        } catch {
          report.warnings.push(`無法轉碼：${childRel}`);
        }
      }

      // ③ 憑證遮蔽 + set_encoding 標記（只對文字檔）
      if (!isProbablyBinary(buf)) {
        let text = buf.toString('utf8');
        let touched = false;

        if (CREDENTIAL_FILES.some((re) => re.test(childRel))) {
          const replaced = text.replace(SECRET_RE, (m, head) => `${head}CHANGE_ME"`);
          if (replaced !== text) { text = replaced; touched = true; report.redacted.push(childRel); }
        }
        if (/set_encoding\s*\(\s*"(?!UTF|utf)/.test(text)) {
          report.encodingCalls.push(childRel);
          // WASM build 只有演算法式字集：GBK/BIG5 這類呼叫會 raise error。
          // 整個 lib 已轉成 UTF-8，所以直接改成 UTF-8 是語意正確的，不是掩蓋。
          text = text.replace(/set_encoding\s*\(\s*"[^"]*"\s*\)/g, 'set_encoding("UTF-8")');
          touched = true;
        }
        if (touched) buf = Buffer.from(text, 'utf8');
      }

      if (!dryRun) fs.writeFileSync(path.join(dstWork, childRel), buf);
      report.files += 1;
      report.bytes += buf.length;
    }
  };
  walk(root, '');

  // ④ 設定檔：第一個 external_port 必須是 UTF-8 的 telnet 埠
  if (configName && !dryRun) {
    const cfgPath = path.join(dstWork, configName);
    if (fs.existsSync(cfgPath)) {
      let cfg = fs.readFileSync(cfgPath, 'utf8');
      const before = cfg;
      // ★ 註解一律放在**上一行**。FluffOS 的設定檔沒有行尾註解——值取的是冒號後
      // 整行，寫在行尾會讓那個指令的值變成 `telnet 5001 # …`，而且會連累後面的
      // 指令解析（泥潭七 因此整台開不了機，詳見 fix-image.mjs 的 fixConfigTrailingComments）。
      cfg = cfg.replace(/^external_port_\d+\s*:.*$/gim, (line) => '# [wasm] ' + line);
      cfg = cfg.replace(/^(#\s*\[wasm\].*)$/im,
        '# [wasm] driver 把連線標成「來自第一個 external_port」，指到 GBK 埠會 raise error\n'
        + 'external_port_1 : telnet 5001\n$1');
      if (cfg !== before) fs.writeFileSync(cfgPath, cfg);
    }
  }

  if (!dryRun) {
    fs.writeFileSync(path.join(dstLib, 'mud.json'), JSON.stringify({
      title: title || slug,
      subtitle: path.basename(srcRoot),
      source: 'zjmud-collection',
      work: stageDir ? undefined : 'work',
      config: configName || 'config.ini',
      encoding: 'UTF-8（由 import-lib.mjs 轉換）',
    }, null, 2) + '\n');
  }
  report.stageWork = dstWork;
  return report;
}

/** 把匯入結果寫成 NOTES.md（人看的那份紀錄）。 */
export function renderNotes(report, bootResult = null) {
  const L = [];
  L.push(`# 匯入與 WASM 落差紀錄 — ${report.slug}`, '');
  L.push('> 由 `node webclient/tools/import-lib.mjs` 自動產生，改動皆可重跑複現。', '');
  L.push('## 來源', '');
  L.push(`| 項目 | 值 |`, `|------|-----|`);
  L.push(`| 收藏目錄 | \`${report.source}\` |`);
  L.push(`| mudlib 根 | \`${path.relative(report.source, report.root) || '.'}\` |`);
  L.push(`| 設定檔 | \`${report.config ?? '（找不到）'}\` |`);
  L.push(`| 匯入檔數 | ${report.files}（${(report.bytes / 1e6).toFixed(1)} MB） |`);
  L.push(`| 略過 | ${report.skipped} 個檔案／目錄（執行檔、備份、日誌、OBJ_DUMP…） |`, '');

  L.push('## 編碼', '');
  L.push(report.converted.length
    ? `GBK → UTF-8 轉換 **${report.converted.length}** 個檔案。WASM build 只帶演算法式字集，`
      + '表格式字集（GBK/BIG5）會 raise error，所以整個 lib 必須是 UTF-8。'
    : '來源已是 UTF-8，未轉碼。');
  if (report.encodingCalls.length) {
    L.push('', `另有 ${report.encodingCalls.length} 處 \`set_encoding("非UTF")\` 已改成 \`set_encoding("UTF-8")\`：`, '');
    for (const f of report.encodingCalls.slice(0, 20)) L.push(`- \`${f}\``);
  }
  L.push('');

  L.push('## 隱私與憑證', '');
  if (report.droppedSaves.length) {
    L.push(`**移除 ${report.droppedSaves.length} 個含密碼欄的玩家存檔**（\`data/**/*.o\`）。`,
      '這些是原營運者的真實玩家資料，對展示站沒有用途，留著只是外洩風險。', '');
    for (const f of report.droppedSaves.slice(0, 10)) L.push(`- \`${f}\``);
    if (report.droppedSaves.length > 10) L.push(`- …共 ${report.droppedSaves.length} 個`);
  } else {
    L.push('未發現含密碼欄的玩家存檔。');
  }
  L.push('');
  if (report.redacted.length) {
    L.push(`憑證遮蔽為 \`CHANGE_ME\` 的檔案（${report.redacted.length}）：`, '');
    for (const f of report.redacted) L.push(`- \`${f}\``);
    L.push('', '> 要啟用相關功能請填**你自己的**憑證，不要沿用來源裡的值。');
  } else {
    L.push('掃描的憑證高風險檔案中未命中特徵。');
  }
  L.push('');

  if (bootResult) {
    L.push('## WASM 開機測試', '');
    L.push(`**分級：${bootResult.badge}** — ${bootResult.reason}`, '');
    L.push(`- 握手：\`${bootResult.handshake ?? '（無）'}\`　方言：\`${bootResult.dialect ?? '-'}\``);
    L.push(`- 收到 opcode：${bootResult.opcodes.join(' ') || '（無）'}`);
    if (bootResult.loadFailures?.length) {
      L.push('', '載入失敗的物件（多半用到 WASM 版沒有的 package）：', '');
      for (const f of bootResult.loadFailures) L.push(`- \`${f}\``);
    }
    if (bootResult.undefinedFuncs?.length) {
      L.push('', `缺少的 efun：${bootResult.undefinedFuncs.map((f) => '`' + f + '`').join('、')}`);
    }
  }
  if (report.warnings.length) {
    L.push('', '## 警告', '');
    for (const w of report.warnings.slice(0, 20)) L.push(`- ${w}`);
  }
  return L.join('\n') + '\n';
}

// ── CLI ────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const src = process.argv[2];
  const arg = (n, d) => {
    const i = process.argv.indexOf('--' + n);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
  };
  if (!src) {
    console.error('用法：node tools/import-lib.mjs "<來源目錄>" --slug <slug> [--title "名字"] [--dry-run]');
    process.exit(2);
  }
  const slug = arg('slug');
  if (!slug) { console.error('缺少 --slug'); process.exit(2); }

  const report = importLib(path.resolve(src), {
    slug,
    title: arg('title', slug),
    dryRun: process.argv.includes('--dry-run'),
  });
  console.log(JSON.stringify({
    ...report,
    converted: report.converted.length,
    redacted: report.redacted,
    droppedSaves: report.droppedSaves.length,
    encodingCalls: report.encodingCalls.length,
  }, null, 2));
}
