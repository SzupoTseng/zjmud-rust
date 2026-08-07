#!/usr/bin/env node
// 匯入一個 mudlibs-main 的（非 zjmud）lib，打包成本站的映像。
//
// 【WHY】telnet 登入接應器要有實驗對象。mudlibs-main 的 lib 已經是 UTF-8、
// 已經修到能在現代 FluffOS（含 WASM）上開機——它們缺的只有 zjmud 協議，
// 而那正是接應器要補的。所以匯入工作比 zjmud 收藏簡單得多：
// 不轉碼、不跑 fix-image 的 zjmud 規則，只做打包與去識別化。
//
// 【和 import-lib.mjs 的差異】
//   ① 副檔名：mudlibs-main 整棵樹用 .lpc（含原始碼內的 include/inherit 引用），
//      自洽，照原樣打包。（graft-lib 的改名邏輯不適用——那是把單檔搬進 .c 的樹。）
//   ② 設定檔：他們每個 lib 都帶 config.fluffos，直接用，只加 external_port。
//   ③ mud.json 多兩個欄位：protocol: "telnet"、loginProfile —— 客戶端據此
//      改走登入接應器而不是送 `账号║密码║…`。
//
// 【隱私】與 import-lib 同一條線：data/**/*.o 含 password 欄的一律不收。
//
// 用法：node tools/import-telnet.mjs --from <work目錄> --slug <slug> \
//         [--title 標題] [--profile generic-cn] [--subtitle 說明]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_FORMAT } from '../src/js/mudlibimage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIBS = path.resolve(HERE, '..', '..', 'libs');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const from = arg('from');
const slug = arg('slug');
if (!from || !slug) {
  console.error('用法：node tools/import-telnet.mjs --from <work目錄> --slug <slug> [--title …] [--profile …]');
  process.exit(2);
}

const SKIP_DIRS = new Set(['.git', 'backup', 'OBJ_DUMP', 'PROG_DUMP', '__MACOSX', 'node_modules', '.vscode']);
const SKIP_EXT = /\.(exe|dll|so|dylib|lib|obj|pdb|zip|rar|7z|gz|tgz|bz2|iso|mp3|wav|avi|mp4|psd|bak|orig|swp)$/i;

const files = new Map();
const dropped = [];
(function walk(dirRel) {
  const abs = path.join(from, dirRel);
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = dirRel ? dirRel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(rel);
      continue;
    }
    if (!e.isFile() || SKIP_EXT.test(e.name)) continue;
    const buf = fs.readFileSync(path.join(from, rel));
    // 玩家存檔：含密碼欄的一律不收（同 import-lib.mjs ①）
    if (/\.o$/i.test(e.name) && /(^|\/)data\//.test(rel)) {
      const head = buf.subarray(0, 4096).toString('latin1');
      if (/\bpassword\b/i.test(head)) { dropped.push(rel); continue; }
    }
    // ★ 不改副檔名。mudlibs-main 不只把檔案改成 .lpc，連原始碼裡的
    // #include "/adm/simul_efun/atoi.lpc" 都一起改了——整棵樹是自洽的，
    // 上游也是以這個形態通過 WASM 開機驗證。改回 .c 反而讓所有 include 斷掉
    // （實測：simul_efun 六個 include 全數 Cannot #include → noboot）。
    files.set(rel, buf);
  }
}(''));

// 設定檔：mudlibs-main 的版面把 config.fluffos 放在 work/ 的**上一層**
// （libs/<slug>/config.fluffos，與 NOTES.md 同層），不在 mudlib 樹裡。
// ★ 上游的中文名稱與說明：`meta.json` ＋ `README.md`（work/ 的上一層）。
//
// 【WHY】沒有這一步，130 台裡有 113 台在目錄頁上顯示的是 **slug**
// （`aoxiangtianji`、`bixiecanyang`…）——使用者根本看不懂那是什麼遊戲。
// 而上游每一台都備好了：`meta.json` 有 `number`（編號）與 `name`（中文名），
// `README.md` 第一行是標題、後面是這一台的來歷與現況說明。
// 【WHY 連 number 一起帶】上游用編號排序（001–182），
// 帶著它才能和上游對照，也才知道自己收到第幾台。
let upstreamMeta = null;
{
  const mp = path.join(from, '..', 'meta.json');
  if (fs.existsSync(mp)) {
    try { upstreamMeta = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch { /* 格式壞了就當沒有 */ }
  }
  const rp = path.join(from, '..', 'README.md');
  if (fs.existsSync(rp)) {
    const md = fs.readFileSync(rp, 'utf8');
    upstreamMeta = upstreamMeta || {};
    // ★ 中文名以 README 的 H1 為準，**不要用 meta.json 的 name**。
    // 【WHY】那個欄位常常是**壓縮檔名**：火影的 `name` 是 "Naruto"
    // （來自 Naruto.rar），而 README 第一行寫的才是「火影」。
    // 目錄頁顯示 "Naruto" 等於沒有中文名——使用者看不出那是什麼遊戲。
    const h1 = md.match(/^#\s+(.+)$/m);
    if (h1) upstreamMeta.readmeTitle = h1[1].trim();
    // 說明取 H1 之後的第一段（跳過所有標題行）
    const paras = md.split(/\n\s*\n/).map((x) => x.trim())
      .filter((x) => x && !x.startsWith('#'));
    if (paras.length) upstreamMeta.readmeNote = paras[0].replace(/\s+/g, ' ').slice(0, 220);
  }
}

let config = ['config.fluffos', 'config.ini'].find((c) => files.has(c));
if (!config) {
  const sibling = path.join(from, '..', 'config.fluffos');
  if (fs.existsSync(sibling)) {
    files.set('config.fluffos', fs.readFileSync(sibling));
    config = 'config.fluffos';
  }
}
if (!config) {
  // ★ 退路：找不到就**合成**一份最小設定檔。
  //
  // 【WHY】上游（fluffos/mudlibs）有些台的 work/ 底下只有 mudlib 樹
  // （adm、cmds、d、kungfu…），沒有任何 config——而匯入直接 exit(1)，
  // 整台停在第一步，報「這不是 mudlibs-main 版面的 lib？」
  // 那句話把責任推給來源，但**設定檔本來就是可以從映像推出來的**：
  // master 與 simul_efun 的位置就在檔案樹裡，其餘欄位有通用預設值。
  // 【證據】hellxg：work/ 只有四個目錄，匯入失敗，後續五條規則全部
  // 連鎖報「映像不存在」。
  // 【WHY 這樣安全】合成的設定檔會再經過 fixSynthesizeConfig／
  // fixConfigPaths／fixExternalPort 等既有規則校正——它們本來就是為
  // 「設定檔不完整」寫的。合成只是給那些規則一個起點。
  const pick = (...cands) => cands.find((c) => files.has(c));
  const masterPath = pick('adm/obj/master.c', 'adm/obj/master.lpc',
    'adm/kernel/master.c', 'adm/kernel/master.lpc',
    'adm/single/master.c', 'adm/single/master.lpc', 'secure/master.c');
  const simulPath = pick('adm/obj/simul_efun.c', 'adm/obj/simul_efun.lpc',
    'adm/kernel/simul_efun.c', 'adm/kernel/simul_efun.lpc',
    'adm/single/simul_efun.c', 'adm/single/simul_efun.lpc', 'secure/simul_efun.c');
  if (!masterPath || !simulPath) {
    console.error('找不到設定檔，也推不出 master／simul_efun 的位置'
      + `（master=${masterPath ?? '無'} simul_efun=${simulPath ?? '無'}）——需要人工處理`);
    process.exit(1);
  }
  const strip = (p) => '/' + p.replace(/\.(c|lpc)$/, '');
  files.set('config.fluffos', Buffer.from(
    '# [zjmud] 由 import-telnet.mjs 合成：來源的 work/ 沒有設定檔。\n'
    + '# master 與 simul_efun 的位置是從檔案樹裡找出來的，其餘為通用預設值。\n'
    + `name : ${slug}\n`
    + 'mudlib directory : ./\n'
    + `master file : ${strip(masterPath)}\n`
    + `simulated efun file : ${strip(simulPath)}\n`
    + 'external_port_1 : telnet 5001\n'
    + 'log directory : /log\n'
    + 'include directories : /include\n'
    + 'swap file : /tmp/swap\n', 'utf8'));
  config = 'config.fluffos';
  console.log(`  · 合成設定檔（master=${strip(masterPath)}）`);
}
// external_port：WASM 的連線一律標成第一個 external_port（comm_wasm.cc:124-126）
let cfg = files.get(config).toString('utf8');
if (!/^\s*external_port_1\s*:/m.test(cfg)) {
  cfg = 'external_port_1 : telnet 5001\n' + cfg;
}
// 行尾註解與絕對路徑的既有教訓也適用（FluffOS 的值取冒號後整行）
// mudlibs-main 的 config 寫的是他們機器上的絕對路徑（/home/sunyc/…），
// 映像掛在 /mudlib 之後 chdir 進去，用相對路徑才對
cfg = cfg.replace(/^(\s*mudlib directory\s*:).*/m, '$1 ./');
files.set(config, Buffer.from(cfg, 'utf8'));

// 打包
const dirsSet = new Set();
for (const p of files.keys()) {
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i += 1) dirsSet.add(parts.slice(0, i).join('/'));
}
const parts = [];
const list = [];
let at = 0;
for (const [p, buf] of files) {
  list.push({ path: p, at, size: buf.length });
  parts.push(buf);
  at += buf.length;
}
const data = Buffer.concat(parts);
const manifest = {
  format: IMAGE_FORMAT,
  mount: '/mudlib',
  config,
  totalBytes: data.length,
  dirs: [...dirsSet].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)),
  files: list,
};

const dir = path.join(LIBS, slug);

// ★ 撞名保護：**絕不覆蓋既有的、來源不同的 lib**。
//
// 【WHY】mudlibs-main 與 zjmud 收藏有同名的 mud（zhongjidiyu＝終極地獄、
// xiaoaojianghu＝笑傲江湖…）。批次匯入時 `--slug zhongjidiyu` 直接把**原生
// zjmud 版**整個蓋掉了——原生版有完整的 zjmud 協議（實測 opcode
// 000/002/003/004/005/006/012/021/022），換成 telnet 版之後反而退步。
// 而且這是**靜默**發生的：報告上只會看到「匯入成功」。
//
// 【推理】同名不是錯誤，是兩份不同的東西——所以要保留兩份，
// telnet 版加後綴。真正該擋的是「無聲取代」。
const existingMeta = path.join(dir, 'mud.json');
if (fs.existsSync(existingMeta)) {
  const prev = JSON.parse(fs.readFileSync(existingMeta, 'utf8'));
  const prevSrc = prev.source || '';
  if (prevSrc && !prevSrc.includes('mudlibs')) {
    console.error(`✗ ${slug} 已存在且來源不同（${prevSrc}）——不覆蓋。`
      + `\n  這兩個是不同的 mud，請用不同的 slug，例如 --slug ${slug}-telnet`);
    process.exit(1);
  }
}
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'mudlib.json'), JSON.stringify(manifest));
fs.writeFileSync(path.join(dir, 'mudlib.data'), data);
fs.writeFileSync(path.join(dir, 'mud.json'), JSON.stringify({
  // 【WHY 上游的名字優先】命令列的 --title 多半就是 slug（批次轉換時
  // 沒人一台一台去查中文名），而上游的 meta.json 有正確的中文名。
  // 顯示 slug 等於沒有標題——使用者看到 `bixiecanyang` 不會知道那是什麼。
  title: (upstreamMeta && (upstreamMeta.readmeTitle || upstreamMeta.name)) || arg('title', slug),
  number: (upstreamMeta && upstreamMeta.number) || undefined,
  subtitle: (upstreamMeta && upstreamMeta.readmeNote)
    || arg('subtitle', 'mudlibs-main（telnet，經登入接應器）'),
  source: 'fluffos/mudlibs（mudlibs-main）',
  config,
  protocol: 'telnet',                       // ③ 客戶端據此改走接應器
  loginProfile: arg('profile', 'generic-cn'),
  encoding: 'UTF-8（上游已轉）',
  image: 'mudlib.data',
}, null, 2) + '\n');

console.log(`${slug}：${files.size} 檔 / ${(data.length / 1e6).toFixed(1)} MB（config=${config}）`);
if (dropped.length) console.log(`  隱私：略過 ${dropped.length} 個含密碼欄的玩家存檔`);
