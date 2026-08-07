#!/usr/bin/env node
// 對已打包的映像套用相容性修正，不必重跑匯入。
//
// 【WHY】匯入一個 lib 要 2-7 分鐘（讀來源跨 9P），但發現的問題往往只需要改幾個位元組。
// 每發現一種新的不相容就整批重跑，等待時間會吃掉所有迭代速度。
//
// 【推理】修正必須是**冪等且可重跑**的：同一個規則跑兩次結果一樣，
// 而且規則本身寫在版控裡，任何人重跑都得到同一份映像。
// 所以這裡的每一條 fixup 都先檢查「需不需要改」，需要才動。
//
// 【證據】三條規則各自對應一次實測失敗：
//   ① config 檔名：`谁与争锋` 用 `config.hell`，舊的偵測只認 config.ini → boot exit(-1)
//   ② nosave/static：`include/globals.h` 只有 `#define nosave static`，
//      而 FluffOS 現在沒有 `static` 這個修飾詞 → master.c 的
//      `static void crash(...)` 直接是 syntax error，master 載入失敗即中止開機。
//      LPMud-Name 能跑是因為它的 globals.h 多一行 `#define static nosave`
//      （前處理器的 blue paint 讓這組互換定義自我終止）。
//   ③ external_port：WASM 版用 `external_port[0].port` 當連線的來源埠
//      （src/wasm/comm_wasm.cc:124-126），舊式設定只有 `port number` 就沒有第 0 個。
//
// 用法：node tools/fix-image.mjs [slug...] [--dry-run]

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_FORMAT } from '../src/js/mudlibimage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { isPlayerSave } from './lib/player-saves.mjs';

const LIBS = path.resolve(HERE, '..', '..', 'libs');

// 【WHY 要認 .lpc】mudlibs-main 的 lib 整棵樹（含原始碼裡的 #include）都用 .lpc，
// 而這些相容性規則（is_chinese 的碼點判斷、名字長度的 GBK 位元組換算…）
// **與副檔名無關**——它們修的是「轉 UTF-8 之後語意壞掉」這件事，
// telnet lib 一樣中招（星戰英雄實測：中文名字被判為非中文）。
// 只認 .c 等於讓 97 台 telnet lib 全部跳過這些修正。

// ── 映像的讀寫 ──────────────────────────────────────

export function loadImage(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mudlib.json'), 'utf8'));
  // ★ `.data` 沒有就從 `.gz` 解 —— 兩者是同一份位元組，`.gz` 才是版控裡的真相。
  //
  // 【WHY】`.data` 是 gitignore 的衍生檔（未壓縮，全收藏 5.1 GB，而 `.gz` 只有 1.2 GB）。
  // CI 的 checkout 本來就只有 `.gz`，本機也隨時可以刪掉 `.data` 省空間——
  // 而這支工具原本無條件讀 `.data`，於是「刪掉衍生檔」會讓 fix-image／apply-fixup
  // 全部 ENOENT，看起來像映像壞了。`bootMud`（wasm-node.mjs）早就是優先讀 `.gz`
  // 再退回 `.data`，這裡對齊它——同一個問題不該有兩種答案。
  const gzPath = path.join(dir, 'mudlib.data.gz');
  const dataPath = path.join(dir, 'mudlib.data');
  const data = fs.existsSync(dataPath)
    ? fs.readFileSync(dataPath)
    : zlib.gunzipSync(fs.readFileSync(gzPath));
  const files = new Map(manifest.files.map((f) => [f.path, data.subarray(f.at, f.at + f.size)]));
  return { manifest, files };
}

export function saveImage(dir, manifest, files) {
  const parts = [];
  const list = [];
  let at = 0;
  for (const [p, buf] of files) {
    list.push({ path: p, at, size: buf.length });
    parts.push(buf);
    at += buf.length;
  }
  const data = Buffer.concat(parts);
  const out = { ...manifest, format: IMAGE_FORMAT, totalBytes: data.length, files: list };
  // ★ 寫回前做一次自我檢查：manifest 與 blob 必須對得上。
  //
  // 【WHY】本 session 三度遇到「映像位元組錯位」——`include/globals.h` 的第一行
  // 變成別的檔案的片段，於是整台開不了機，而錯誤訊息只說某個 .h 語法錯誤，
  // 看起來像那台 mudlib 自己有問題。真因是重複執行時 offset 與內容不同步。
  // 【判準】隨機抽幾個檔，用 manifest 記的 (at, size) 從 blob 取回來，
  // 必須與 files 裡的那份逐位元組相同。這是打包的**不變式**，
  // 檢查成本是常數，而錯過它的代價是整台無聲損壞。
  {
    const paths = out.files.map((f) => f.path);
    const sample = paths.length <= 8 ? paths
      : Array.from({ length: 8 }, (_, i) => paths[Math.floor(i * paths.length / 8)]);
    for (const p of sample) {
      const rec = out.files.find((f) => f.path === p);
      const want = files.get(p);
      const got = data.subarray(rec.at, rec.at + rec.size);
      if (!want || Buffer.compare(Buffer.from(want), Buffer.from(got)) !== 0) {
        throw new Error(`映像自我檢查失敗：${p} 的內容與 manifest 記的位置對不上`
          + '——打包時 offset 與內容不同步，寫回會產生一個開不了機的映像。');
      }
    }
  }
  fs.writeFileSync(path.join(dir, 'mudlib.json'), JSON.stringify(out));
  // ★ `.data` **本來就在才更新**，不存在就不要憑空長回來。
  //
  // 【WHY】`.data` 是未壓縮的衍生檔（全收藏 5.1 GB，而 `.gz` 只有 1.2 GB），
  // 而且是 gitignore 的。為了省空間把它刪掉之後，如果這裡無條件寫回，
  // 每修一台就長回一份——省空間的動作會被工具默默抵銷。
  // 【判準】`.gz` 是版控裡的真相，一定要更新；`.data` 只是本機的快取，
  // 存在才維護它。（`loadImage` 已對齊：沒有 `.data` 就從 `.gz` 解。）
  const dataPath = path.join(dir, 'mudlib.data');
  const gzExists = fs.existsSync(path.join(dir, 'mudlib.data.gz'));
  if (fs.existsSync(dataPath) || !gzExists) fs.writeFileSync(dataPath, data);
  // ★ `.gz` 存在就必須一起更新。
  //
  // 【WHY】載入端（wasm-node、mudlibimage）**優先讀 `.gz`**，而這支工具原本
  // 只寫 `.data`。於是修正之後跑驗證，driver 拿到的是**改動前的舊映像**——
  // 而症狀更誤導：`.gz` 裡的 offset 對應的是舊內容，
  // 解出來的 `include/globals.h` 第一行變成別的檔案的片段，
  // 報「syntax error」，看起來像那台 mudlib 自己壞了。
  // 【證據】實測 zhongjidiyu／nt7：`.data` 的 mtime 比 `.gz` 新 1700 秒，
  // 兩台同時「開不了機」，而磁碟上的 globals.h 完全正常。
  // 【推理】`.gz` 是 `.data` 的衍生物，兩者只要不同步就是一顆定時炸彈。
  // 誰寫 `.data` 誰就有責任讓 `.gz` 跟上。
  const gzPath = path.join(dir, 'mudlib.data.gz');
  if (fs.existsSync(gzPath)) {
    fs.writeFileSync(gzPath, zlib.gzipSync(data, { level: 6 }));
  }
  return out;
}

// ── fixups ─────────────────────────────────────────

/** ① 設定檔名：先看啟動批次檔怎麼寫，再猜。 */
export function fixConfigName(manifest, files) {
  const rootFiles = [...files.keys()].filter((p) => !p.includes('/'));
  const current = manifest.config;
  if (current && files.has(current)) return null;

  for (const name of rootFiles.filter((n) => /\.(bat|cmd|sh)$/i.test(n))) {
    const text = files.get(name).toString('latin1');
    const m = text.match(/^[^\S\n]*(?:\.[\\/])?(?:[\w.-]*driver[\w.-]*|mudos[\w.-]*)(?:\.exe)?\s+([^\s%<>|&]+)/im);
    if (m && files.has(m[1])) { manifest.config = m[1]; return `config → ${m[1]}（依據 ${name}）`; }
  }
  const cands = rootFiles.filter((n) => /^config($|\.)/i.test(n) || /\.(cfg|ini)$/i.test(n));
  cands.sort((a, b) => {
    const rank = (n) => (/^config\.ini$/i.test(n) ? 0 : /^config\.cfg$/i.test(n) ? 1
      : /^config($|\.)/i.test(n) ? 2 : 3);
    return rank(a) - rank(b) || a.length - b.length;
  });
  if (cands.length) { manifest.config = cands[0]; return `config → ${cands[0]}（檔名猜測）`; }
  return null;
}

/**
 * ② `static` 修飾詞：改用上游 LPMud-Name 的 `__SENSIBLE_MODIFIERS__` 慣用寫法。
 *
 * 【WHY】收藏裡的 globals.h 多半只有一行 `#define nosave static`（舊 MudOS 慣例）。
 * FluffOS 已經移除 `static` 這個修飾詞，於是 master.c 的
 * `static void crash(...)` 是 syntax error，master 載不起來，整台開不了機。
 *
 * 【推理】第一次的修法是「再加一行 `#define static nosave`」，**無效**——
 * 兩個互換定義會被前處理器的 blue paint 抵銷成原樣（實測錯誤欄位從 43:8 移到 43:1，
 * 但仍是 error）。正解在上游自己的檔案裡：LPMud-Name 的 globals.h 用
 * `#ifndef __SENSIBLE_MODIFIERS__` 把兩組定義**分岔**，而 FluffOS 會定義
 * 這個巨集，所以現代 driver 走的是 `#define static nosave` 那一支，
 * `nosave` 則保持為真正的關鍵字。差別不是多一行，是**互斥而不是並存**。
 *
 * 【證據】LPMud-Name/world/include/globals.h:6-12（可跑）
 *   vs 谁与争锋 include/globals.h:6 只有 `#define nosave static`（開不了機）。
 */
export function fixStaticModifier(manifest, files) {
  const targets = [...files.keys()].filter((p) => /^include\/globals?\.h$/i.test(p));
  const notes = [];
  for (const p of targets) {
    let text = files.get(p).toString('utf8');
    if (/__SENSIBLE_MODIFIERS__/.test(text)) continue;          // 已經是正確寫法

    // 第二種情況：globals.h 根本沒有任何 static/nosave 定義，但 .c 裡照用 `static`
    // （91书剑 的 adm/daemons/chinesed.c:15 就是這樣，整台開不了機）。
    // 這時沒有互斥問題，補一行對映即可。
    if (!/^\s*#define\s+nosave\s+static\b/m.test(text)) {
      if (/^\s*#define\s+static\b/m.test(text)) continue;      // 已經有了
      const anyStaticUse = [...files.keys()].some((q) => {
        if (!/\.c$/.test(q)) return false;
        return /^\s*static\s+(void|int|string|object|mixed|mapping|float|buffer)\s+\w+\s*\(/m
          .test(files.get(q).toString('utf8'));
      });
      if (!anyStaticUse) continue;
      files.set(p, Buffer.from(
        '// [wasm] FluffOS 已移除 `static` 修飾詞，但本 mudlib 的 .c 仍在用；\n'
        + '// 沒有這行對映會在編譯期直接 syntax error（實測：91书剑 chinesed.c:15）。\n'
        + '#define static nosave\n' + text, 'utf8'));
      notes.push(`${p}：補上 #define static nosave`);
      continue;
    }

    // 先清掉前一版修法留下的痕跡（可重跑）
    text = text.replace(/^\/\/ \[wasm\].*\n/gm, '')
      .replace(/^#define\s+static\s+nosave\s*$/gm, '');

    const block = [
      '// [wasm] 改用上游 LPMud-Name 的寫法：FluffOS 會定義 __SENSIBLE_MODIFIERS__，',
      '// 走下面那一支——`static` 對映到 nosave，而 `nosave` 保持為真正的關鍵字。',
      '// 兩組定義必須**互斥**；並存會被前處理器的 blue paint 抵銷回原樣，',
      '// 結果就是 `static void crash(...)` 依然是 syntax error、master 載不起來。',
      '#ifndef __SENSIBLE_MODIFIERS__',
      '#define nosave static',
      '#define protected static',
      '#else',
      '#define private protected',
      '#define static nosave',
      '#endif',
    ].join('\n');

    let replaced = false;
    text = text.replace(/^[^\S\n]*#define[^\S\n]+nosave[^\S\n]+static\b.*$/m, () => {
      replaced = true;
      return block;
    });
    // 舊寫法常常還有一行 `#define protected static`，已含在 block 裡，去重
    text = text.replace(/^[^\S\n]*#define[^\S\n]+protected[^\S\n]+static\b.*$\n?/gm, (m, off) =>
      (text.indexOf(block) !== -1 && off > text.indexOf(block) + block.length ? '' : m));
    if (!replaced) continue;

    files.set(p, Buffer.from(text, 'utf8'));
    notes.push(`${p}：改用 __SENSIBLE_MODIFIERS__ 分岔`);
  }
  return notes.length ? notes.join('；') : null;
}

/**
 * ③ external_port：WASM 版靠第一個 external_port 決定 master::connect(port) 收到什麼。
 *
 * 【WHY 埠號不能隨便給】nt7 補齊缺件之後開得起來、也收得到連線，但送出來的是
 * **經典 telnet 登入**（ANSI 大字招牌 ＋「请输入您的英文名字：」），不是 zjmud
 * 的 `ver1.0,` 握手——客戶端當然什麼都認不得。
 *
 * 【推理】不是登入物件錯了，是**模式沒被打開**：nt7 的 `adm/kernel/master.c`
 * 在 connect() 裡寫著
 *     if( port == 333 ) { set_temp("zjmud", 1, login_ob); set_encoding("UTF-8"); }
 *     if( port == 222 ) { set_temp("smud", 1, login_ob); }
 * 也就是同一個 mudlib 同時服務手機端與 zmud，**用埠號分流**。給 5001 就等於
 * 告訴它「這是普通 telnet」。而 WASM 版的連線一律被標成第一個 external_port
 * （comm_wasm.cc:124-126），所以那個埠號必須是 mudlib 認得的 zjmud 埠。
 *
 * 【證據】nt7 master.c connect() 的兩個 port 分支；改成 333 之後同一份映像
 * 才開始送 zjmud 握手。埠號用猜的不行——每個 lib 的值都可能不同，
 * 所以這裡是**從 master 的原始碼把它讀出來**。
 */
function manifestCfg(files) {
  // 設定檔的檔名沒有統一（config.ini / config.fluffos / config.wasm.ini），
  // 這裡只找得到就好——找不到時上面會退回路徑清單。
  return ['config.wasm.ini', 'config.fluffos', 'config.ini', 'config']
    .find((c) => files.has(c)) || null;
}

function zjmudPort(files) {
  // ★ master 的位置要從**設定檔**讀，不要用固定路徑清單。
  //
  // 【WHY】原本只認 `adm/kernel|single/master.c` 與 `secure/master.c`，
  // 而收藏裡至少還有 `adm/obj/master.lpc`（火影、三界神话…）。
  // 認不出來就直接 return null——這條規則對那些台**靜默失效**：
  // 不報錯、不警告，設定檔照舊開 5001，而如果那台真的用埠號判定 zjmud 模式，
  // 玩家就會進到一個沒有房間的世界（「你的四周灰蒙蒙地一片」）。
  // 【判準】driver 自己讀哪個檔就是哪個——`master file : /adm/obj/master`。
  // 【WHY 還要保留清單】舊式設定檔可能沒有寫 master file 這一行。
  let master = null;
  {
    const cfgName = manifestCfg(files);
    const cfgText = cfgName && files.has(cfgName) ? files.get(cfgName).toString('utf8') : '';
    const mm = cfgText.match(/^\s*master\s+file\s*:\s*(\S+)/im);
    if (mm) {
      const base = mm[1].replace(/^\/+/, '').replace(/\.(c|lpc)$/, '');
      master = [base + '.c', base + '.lpc', base].find((x) => files.has(x)) || null;
    }
  }
  if (!master) {
    master = [...files.keys()].find((p) => /(^|\/)adm\/(kernel|single|obj)\/master\.(c|lpc)$/.test(p)
      || /(^|\/)secure\/master\.(c|lpc)$/.test(p));
  }
  if (!master) return null;
  const text = files.get(master).toString('utf8');
  // 【WHY 要真的配對大括號】原本用 `[\s\S]*?\n\}` 抓函數本體——
  // 它遇到**第一個行首的 `}`** 就停，而那往往是內層 if 的結尾。
  // nt7 實測只抓到 692 字元，`port == 333` 與 `set_temp("zjmud"` 都在被截掉的
  // 後半段，於是這條規則判定「這台沒有 zjmud 埠」→ 設定檔開 5001 →
  // master::connect() 走不到 zjmud 分支 → 玩家進世界後沒有房間
  // （畫面只有「你的四周灰蒙蒙地一片」）。
  // 症狀看起來像面板壞了，真因是**一個埠號**。
  const sigAt = text.search(/object\s+connect\s*\([^)]*\)\s*\{/);
  if (sigAt === -1) return null;
  let depth = 0, end = -1;
  for (let j = text.indexOf('{', sigAt); j < text.length; j += 1) {
    if (text[j] === '{') depth += 1;
    else if (text[j] === '}') { depth -= 1; if (depth === 0) { end = j; break; } }
  }
  if (end === -1) return null;
  const m = [text.slice(sigAt, end + 1)];
  // 找「這個埠號會把連線標成 zjmud」的分支
  // 【WHY 放寬到 400 且允許換行縮排】各家的寫法差很多：有的 `set_temp` 緊接在
  // `if` 後面，有的隔著註解與空行。`[^}]{0,200}` 對 nt7 那種
  // 「if 換行、set_temp 縮排在下一行」的寫法太緊。
  const re = /if\s*\(\s*port\s*==\s*(\d+)\s*\)\s*\{?[\s\S]{0,400}?set_temp\s*\(\s*"zjmud"/g;
  const hit = re.exec(m[0]);
  return hit ? hit[1] : null;
}

export function fixExternalPort(manifest, files) {
  const cfg = manifest.config;
  if (!cfg || !files.has(cfg)) return null;
  let text = files.get(cfg).toString('utf8');
  const port = zjmudPort(files) || '5001';

  const existing = text.match(/^([^\S\n]*external_port_1[^\S\n]*:[^\S\n]*\S+[^\S\n]+)(\d+)[^\S\n]*$/m);
  if (existing) {
    if (existing[2] === port) return null;
    files.set(cfg, Buffer.from(text.replace(existing[0], existing[1] + port), 'utf8'));
    return `external_port_1 改為 ${port}（master::connect() 以此判定 zjmud 模式）`;
  }

  const header = '# [wasm] driver 把連線標成「來自第一個 external_port」\n'
    + '# （src/wasm/comm_wasm.cc:124-126）。舊式設定只有 `port number`，\n'
    + '# 沒有 external_port 就沒有第 0 個，連線的 local_port 會是 0。\n'
    + (port === '5001' ? ''
      : '# 這個埠號不是隨便挑的：master::connect() 用它判定要不要進 zjmud 模式。\n')
    + `external_port_1 : telnet ${port}\n`;
  files.set(cfg, Buffer.from(header + text, 'utf8'));
  return `補上 external_port_1 : telnet ${port}`;
}

/**
 * ④ `is_chinese()`：把 GBK 逐位元組的判斷換成碼點判斷。
 *
 * 【WHY】匯入時整個 mudlib 轉成了 UTF-8，但**判斷「這是不是中文」的程式碼沒有跟著轉**。
 * 舊寫法是 GBK 的雙位元組區間檢查：
 *   `if (strlen(str) % 2) return 0;  if (str[i] < 176 || str[i] >= 248) return 0;`
 * 在 UTF-8 的 driver 上，`str[i]` 是**碼點**（「令」= 0x4EE4），永遠大於 248，
 * 於是任何中文名字都被判成「不是中文」——建角卡在
 * 「对不起，请您用「中文」取名字。」，看起來像客戶端送錯格式。
 *
 * 【推理】不能只改 import 的轉碼（那只處理位元組），必須改**語意**。
 * 上游 LPMud-Name 早就遇過同一件事：它把 GBK 版整段註解掉，改用
 * `pcre_match(str, "^\\p{Han}+$")`。這裡採碼點區間而不是 pcre，理由是不依賴
 * 任何 package——WASM build 關掉了一批 package，少一個依賴少一個變數。
 *
 * 【證據】谁与争锋 `adm/simul_efun/chinese.c` 的 GBK 版（建角失敗）
 *   vs LPMud-Name 同名檔案：GBK 版被註解、改用 pcre（建角成功）。
 */
export function fixIsChinese(manifest, files) {
  const notes = [];

  /** 碼點版的函式本體。整段全部是漢字才算數；`whole=false` 只看第一個字。 */
  const body = (name, whole) => `int ${name}(string str)
{
    // [wasm] is_chinese：碼點版。原本是 GBK 逐位元組區間檢查（str[i] < 176 …），
    // 但整個 mudlib 已轉成 UTF-8，driver 以碼點索引字串，「令」= 0x4EE4 永遠
    // 大於 248，於是所有中文名字都被判為非中文、建角卡死。
    //
    // 範圍要**簡繁通吃**：這些 mudlib 原本是 GBK，只認得簡體；轉成 UTF-8 之後
    // 沒有理由再把繁體擋在外面（「無」U+7121 與「无」U+65E0 同樣是漢字）。
    //   0x3400-0x4DBF  擴充 A
    //   0x4E00-0x9FFF  統一表意文字（簡體、繁體、日韓漢字都在這裡）
    //   0xF900-0xFAFF  相容表意文字（多為繁體異體字）
    //   0x20000 以上   擴充 B 之後（罕用字、部分繁體異體）
    // 與原意「${whole ? '全部是漢字' : '開頭是漢字'}」一致，只是不再限定字集。
    int i, c;

    if (!str || strlen(str) < 1) return 0;
    for (i = 0; i < ${whole ? 'strlen(str)' : '1'}; i++) {
        c = str[i];
        if (!((c >= 0x3400 && c <= 0x9fff)
           || (c >= 0xf900 && c <= 0xfaff)
           || (c >= 0x20000 && c <= 0x3ffff))) return 0;
    }
    return 1;
}`;

  // 兩個名字都要改：is_chinese2 是「只看第一個字」的變體，同樣是位元組區間寫法。
  const TARGETS = [{ name: 'is_chinese', whole: true }, { name: 'is_chinese2', whole: false }];

  for (const [p, buf] of files) {
    if (!/\.(c|lpc)$/.test(p)) continue;
    let text = buf.toString('utf8');
    let touched = false;

    for (const { name, whole } of TARGETS) {
      const sig = new RegExp(`int\\s+${name}\\s*\\(\\s*string\\s+\\w+\\s*\\)[^{]*\\{[\\s\\S]*?\\n\\}`);
      const m = text.match(sig);
      if (!m) continue;
      const patchedAlready = /\[wasm\] is_chinese/.test(m[0]);
      // 已經改過的也要能再改一次——這一版把範圍放寬到簡繁通吃，
      // 若「看到標記就跳過」，舊的窄範圍會永遠留著（同樣的坑本檔已經踩過兩次）。
      if (patchedAlready && m[0] === body(name, whole)) continue;  // 已經是這一版

      // 判準是「這段程式碼在做位元組區間比較」，而不是某一種特定寫法。
      // 【WHY】前兩版的門檻寫成 `strlen(str) % 2`（谁与争锋）與 `% 3`（大梦江湖），
      // 於是泥潭七 這種用 `i % 2` 迴圈、開頭是 `strlen(str) < 2` 的第三種寫法
      // **靜默地沒被修到**——同一條規則連漏三次，因為每次都只把當下看到的那個
      // 樣式加進白名單。漏改比不改更難發現：報告上寫的是「已處理」。
      // 改成看 GBK 區間常數（176/161/247/248/254）出現幾個：正確的碼點版不會
      // 用到這些數字，位元組版一定會用到兩個以上，與迴圈怎麼寫無關。
      const magics = ['176', '161', '247', '248', '254'].filter((n) => m[0].includes(n));
      if (!patchedAlready && (magics.length < 2 || !/str\s*\[/.test(m[0]))) continue;

      text = text.replace(sig, body(name, whole));
      touched = true;
      notes.push(`${p}：${name} 改為碼點判斷`);
    }

    if (touched) files.set(p, Buffer.from(text, 'utf8'));
  }
  return notes.length ? notes.join('；') : null;
}

/**
 * ④-b 中文名字的**長度**檢查——與 ④ 同一個病根，另一個症狀。
 *
 * 【WHY】使用者建角時被擋下：「对不起，你的中文姓名不能太长或太短。」
 * 而他打的就是正常的兩三個字。同一份 lib 我們自己的測試卻過得去——
 * 因為測試用的名字剛好是**四個字**（令狐一郎）。
 *
 * 【推理】看 91书剑 的實作就清楚了：
 *     i = strlen(name);
 *     if (i < 4 || i > 8 || i%2) { write("…必须是 2 到 4 个中文字"); }
 * 訊息說的是「2 到 4 個**字**」，程式數的卻是 **GBK 位元組**（一個漢字 2 bytes，
 * 所以 4..8 且必須是偶數）。整個 mudlib 轉成 UTF-8、driver 又以碼點索引之後，
 * 兩個字的 strlen 是 2 → 撞上 `i < 4` 被拒；三個字是 3 → 撞上 `i%2` 被拒。
 * **只有剛好四個字的名字能通過**，而那正是我們測試用的名字——
 * 測試資料的巧合把一個必然的 bug 藏了起來。
 *
 * 【這不是在改遊戲規則】規則是 mudlib 自己在錯誤訊息裡寫明的「2 到 4 個中文字」；
 * 壞掉的是**實作**（它假設一個漢字佔兩個索引位）。所以修法是照著它自己的訊息
 * 把界限換算回「字數」，能換算就用訊息裡的數字，不能換算才退回「除以二」。
 *
 * 【證據】同一族的寫法在收藏裡到處都是：91书剑 logind.c:916、
 * uweapon.c:386（裝備改名）、zhao.c:189（NPC 改名）、大梦江湖 logind.c:554、
 * 夺宝江湖 logind.c:432、江湖风雨情 logind.c:532……全部是 `< 4 / > 8 / %2` 這組數字。
 */
export function fixChineseNameLength(manifest, files) {
  const notes = [];
  // 只認「這段訊息在講中文名字的長度」，不碰聊天室名、房屋名以外的其他檢查。
  const MSG = /中文(?:姓名|名字).{0,12}(?:不能太长或太短|必须是)|必须是\s*[一二三四五六七八九\d]+\s*到\s*[一二三四五六七八九\d]+\s*个中文字/;
  const RANGE = /(\d+)\s*到\s*(\d+)\s*个中文字/;

  for (const [p, buf] of files) {
    if (!/\.(c|lpc)$/.test(p)) continue;
    const text = buf.toString('utf8');
    if (!MSG.test(text)) continue;

    const L = text.split('\n');
    let changed = 0;
    for (let i = 0; i < L.length; i += 1) {
      if (!MSG.test(L[i])) continue;
      const range = L[i].match(RANGE);

      // 【WHY 判準要分成兩件事】第一版要求「條件那一行自己要有 strlen(」，
      // 結果漏掉最常見的寫法之一：
      //     i = strlen(name);
      //     if (i < 4 || i > 8 || i%2) {
      // strlen 在兩行以前，條件行上只有變數。91书剑 因此靜默沒被修到，
      // 而報告顯示「已處理 15 個 lib」——又是漏改比不改難發現。
      // 所以改成：附近有 strlen 就算數（證明這是長度檢查），
      // 條件行只要求「有數字比較或 %2」。
      const near = L.slice(Math.max(0, i - 8), i + 1).join('\n');
      if (!/strlen\s*\(/.test(near)) continue;

      // 訊息在後、條件在前：往上找最近的那個比較
      for (let j = i; j >= Math.max(0, i - 6); j -= 1) {
        if (!/[<>]=?\s*\d|%\s*2/.test(L[j])) continue;
        if (!/\bif\b|\|\||&&/.test(L[j])) continue;
        if (/\[wasm\] 名字長度/.test(L[j])) break;      // 這一處已經改過
        const before = L[j];
        let line = before;
        // ① 有明確字數就照它換；沒有就把位元組界限除以二
        line = line.replace(/([<>]=?)\s*(\d+)/g, (m, op, n) => {
          const bytes = parseInt(n, 10);
          if (range) return `${op} ${op.startsWith('<') ? range[1] : range[2]}`;
          return `${op} ${Math.max(1, Math.round(bytes / 2))}`;
        });
        // ② 拿掉「必須是偶數」——那是「整個漢字」的位元組檢查，碼點下無意義
        line = line.replace(/\s*(\|\||&&)\s*\w+\s*%\s*2\b/g, '')
          .replace(/\s*(\|\||&&)\s*strlen\s*\([^)]*\)\s*%\s*2\b/g, '');
        if (line === before) continue;
        L[j] = line + '\t// [wasm] 名字長度：原本數的是 GBK 位元組（一字 2 bytes），'
          + '轉 UTF-8 後 driver 以碼點索引，界限要換算成字數；同時拿掉「必須偶數」的位元組檢查';
        changed += 1;
        break;
      }
    }
    if (!changed) continue;
    files.set(p, Buffer.from(L.join('\n'), 'utf8'));
    notes.push(`${p}：${changed} 處名字長度改為字數`);
  }
  return notes.length ? notes.join('；') : null;
}

/**
 * ⑤ 日誌目錄：把 mudlib 會寫進去的 log 子目錄補進映像。
 *
 * 【WHY】兩個 lib 的失敗都在這裡，而症狀完全不同：
 *   `仙武奇缘` → `Unable to open log file: "log/debug.log"` → **開機直接 exit(-1)**
 *   `夺宝江湖` → 開機正常，但 `logon()` 裡的 `log_file("static/logon", ...)` 失敗，
 *                driver 判定 `logon() has failed, the user is disconnected`，
 *                於是 `fluffos_connect()` 回 -1——看起來像「撥號失敗」，
 *                完全看不出是一個資料夾不存在。
 *
 * 【推理】匯入時刻意不打包 log 內容（那是別人伺服器的執行記錄，又大又是隱私），
 * 但**只留了 `log/` 本身、沒有留子目錄**。MEMFS 不會自動建立中間目錄，
 * 於是 `log_file("static/logon")` 找不到 `/log/static/`。
 * 要補哪些子目錄不能用猜的——mudlib 自己的原始碼裡就寫著：把所有
 * `log_file("<path>", …)` 的第一個參數收集起來，取其目錄部分即可。
 *
 * 【證據】duobaojianghu `clone/user/login.c:25` 的 `log_file()` →
 *   `*Wrong permissions for opening file /log/static/logon for append.`
 */
export function fixLogDirs(manifest, files) {
  const cfgText = manifest.config && files.has(manifest.config)
    ? files.get(manifest.config).toString('utf8') : '';
  const m = cfgText.match(/^\s*log\s+directory\s*:\s*(\S+)/im);
  const logDir = (m ? m[1] : '/log').replace(/^\/+/, '').replace(/\/+$/, '') || 'log';

  const wanted = new Set([logDir]);
  for (const [p, buf] of files) {
    // ★ 副檔名要含 .lpc：mudlibs-main 的 telnet lib 整棵樹都是 `.lpc`，
    // 只掃 `.c|.h` 等於這條修正對它們**完全沒有作用**（靜默失效）。
    if (!/\.(c|h|lpc)$/.test(p)) continue;
    const text = buf.toString('utf8');
    if (!text.includes('log_file')) continue;
    for (const mm of text.matchAll(/log_file\s*\(\s*"([^"]+)"/g)) {
      const rel = mm[1].replace(/^\/+/, '');
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      if (dir) wanted.add(`${logDir}/${dir}`);
    }
  }

  const have = new Set(manifest.dirs);
  const missing = [...wanted].filter((d) => !have.has(d)).sort();
  if (!missing.length) return null;
  // 父目錄要排在子目錄前面（載入端是照順序 mkdir 的）
  manifest.dirs = [...new Set([...manifest.dirs, ...missing])]
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
  return `補上 ${missing.length} 個日誌目錄（${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}）`;
}

/**
 * ⑤-b 執行期寫入目錄：mudlib 會寫進去、但在原始樹裡是**空目錄**的那些。
 *
 * 【WHY】北美侠客行 實測：玩家跟著引路人到「侠客岛挂名处」，照著提示送
 * `register player@example.com`，畫面只回一句「你发现事情不大对了，可是
 * 又说不上来。」——那是 `adm/single/master.lpc` 的 **runtime error_handler**
 * 對非巫師的統一說詞，真正的錯誤被吃掉了。追下去是 `regid.lpc` 要寫
 * `REGDATA = QUEUEDIR + "register"`，而 `QUEUEDIR` 是 `/queue/`——
 * 那個目錄在原始樹裡是空的，打包時整個消失，MEMFS 又不會自動建中間目錄。
 *
 * 【推理】這不是單一 lib 的意外，而是一整類：`/queue`、`/tmp`、`/backup`、
 * `/data` 這些**執行期工作目錄**在版本庫裡本來就該是空的（內容是別人伺服器
 * 的執行狀態），於是每一台都少。症狀還特別難查——寫檔失敗被 error_handler
 * 包成一句無資訊的中文，看起來像「指令不支援」。
 *
 * 【證據】`adm/daemons/regid.lpc:5-7` `#define QUEUEDIR "/queue/"`；
 * `include/globals.h` `#define REGI_D "/adm/daemons/regid"`；
 * `adm/single/master.lpc` error_handler → 「你发现事情不大对了」。
 */
export function fixWriteDirs(manifest, files) {
  const wanted = new Set(['tmp', 'queue', 'backup']);
  for (const [p, buf] of files) {
    if (!/\.(c|h|lpc)$/.test(p)) continue;
    const text = buf.toString('utf8');
    // ① `#define XXXDIR "/queue/"` —— 工作目錄幾乎都是這樣宣告的
    for (const m of text.matchAll(/#define\s+\w*DIR\w*\s+"(\/[^"]*)"/g)) add(m[1]);
    // ② 直接寫死路徑的寫入呼叫
    for (const m of text.matchAll(/(?:write_file|save_object|rename|cp)\s*\(\s*"(\/[^"]+)"/g)) {
      const v = m[1];
      add(v.slice(0, v.lastIndexOf('/') + 1));
    }
  }
  function add(raw) {
    const d = String(raw).replace(/^\/+/, '').replace(/\/+$/, '');
    // 只收**第一層**：深層路徑多半是檔名的一部分，猜錯會塞一堆空目錄進映像
    if (d && !d.includes('..') && /^[a-z][a-z0-9_]*(\/[a-z0-9_]+)?$/i.test(d)) wanted.add(d);
  }

  const have = new Set(manifest.dirs);
  const missing = [...wanted].filter((d) => !have.has(d)).sort();
  if (!missing.length) return null;
  manifest.dirs = [...new Set([...manifest.dirs, ...missing])]
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
  return `補上 ${missing.length} 個執行期寫入目錄（${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}）`;
}

/**
 * ⑥ 設定檔裡的絕對路徑：`mudlib directory : c:\hell` → `./`。
 *
 * 【WHY】兩個 lib 的 config 直接寫著原營運者機器上的 Windows 路徑，
 * driver 於是回報 `Bad mudlib directory: 'c:\hell'` 並 exit(-1)。
 * 這種設定在原機器上能跑，換一台就壞——WASM 版的「那台機器」是瀏覽器分頁。
 *
 * 【推理】WASM 版的 mudlib 一律掛在 manifest.mount，driver 開機前已經
 * `FS.chdir(mount)`，所以相對路徑 `./` 永遠正確。順手把 log directory 也
 * 正規化成相對路徑，避免同一類問題換個欄位重演。
 *
 * 【證據】仙武奇缘／天涯二 boot log：`Execution root: c:\hell` →
 * `Bad mudlib directory: 'c:\hell'.` → exit(-1)。
 */
export function fixConfigPaths(manifest, files) {
  const cfg = manifest.config;
  if (!cfg || !files.has(cfg)) return null;
  let text = files.get(cfg).toString('utf8');
  const before = text;

  // 【踩過的坑】第一版把說明寫成**行尾註解**：`mudlib directory : ./  # 原本是 c:\hell`。
  // FluffOS 的設定檔沒有行尾註解——`#` 只有在行首才是註解，值取的是冒號後**整行**。
  // 結果 driver 直接回 `Error in config file. Missing line:` 而 exit(-1)，
  // 而且修正腳本重跑一次就再疊一層註解（實測疊成
  // `./  # 原本是 ./  # 原本是 c:\hell（…）（…）`）。
  // 所以：說明一律放在**上一行**，而且要能把先前疊上去的殘骸清掉（冪等）。
  const noteFor = (what) => `# [wasm] ${what}\n`;

  text = text.replace(/^([^\S\n]*mudlib\s+directory[^\S\n]*:[^\S\n]*)(.*)$/im, (m, head, val) => {
    const clean = val.replace(/\s*#.*$/, '').trim();
    if (clean === './' || clean === '.') {
      return `${head}./`;                       // 已經正確：順手把疊上去的註解清掉
    }
    return `${noteFor(`mudlib directory 原本是 ${clean}（原營運者機器上的絕對路徑）`)}${head}./`;
  });

  text = text.replace(/^([^\S\n]*log\s+directory[^\S\n]*:[^\S\n]*)(.*)$/im, (m, head, val) => {
    const clean = val.replace(/\s*#.*$/, '').trim();
    if (!/^[A-Za-z]:/.test(clean)) return `${head}${clean}`;
    return `${noteFor(`log directory 原本是 ${clean}`)}${head}/log`;
  });

  // 有些設定檔根本沒有這一行（泥潭七 的 config.cfg），driver 直接回
  // `Error in config file. Missing line: mudlib directory` 而 exit(-1)。
  // WASM 版的 mudlib 一律掛在 manifest.mount 且開機前已 chdir，所以答案永遠是 ./
  if (!/^[^\S\n]*mudlib\s+directory[^\S\n]*:/im.test(text)) {
    text = '# [wasm] 原設定檔沒有這一行；driver 沒有它就不啟動\nmudlib directory : ./\n' + text;
  }

  if (text === before) return null;
  files.set(cfg, Buffer.from(text, 'utf8'));
  return 'config 路徑正規化';
}

/**
 * ⑦ 完全沒有設定檔時，依映像的實際內容生一份。
 *
 * 【WHY】`nt7` 的收藏目錄裡根本沒有 config——原作者大概是用別處的設定啟動的。
 * 沒有設定檔 driver 連開機都不會開（`couldn't open config file`）。
 *
 * 【推理】設定檔的必要欄位可以從映像本身推出來：master 與 simul_efun 的路徑
 * 就是檔案樹裡那兩個檔，include 目錄看有沒有 /include。與其讓這個 lib 直接
 * 出局，不如生一份最小設定並在 NOTES 標明「這份 config 是我們生的」。
 *
 * 【證據】nt7 映像的 root 沒有任何檔案；boot log：
 * `Error: couldn't open config file: : No such file or directory`。
 */
export function fixSynthesizeConfig(manifest, files) {
  // 兩種情況要重生設定檔：① 根本沒有；② 有但 driver 讀不了。
  //
  // 【WHY ②】泥潭七 的 config.cfg 每個必要指令都在，driver 卻回
  // `Error in config file. Missing line: mudlib directory`。實驗證明
  // **FluffOS 的設定檔解析是有順序的**：把那一行搬到檔首，錯誤就往後移到
  // 下一個必要指令（log directory）。也就是說問題不在內容而在**排列**，
  // 而正確順序沒有文件、只能從能跑的設定檔反推。
  //
  // 【推理】與其猜順序，不如照一份**已知能跑**的設定檔（LPMud-Name 的 config.ini）
  // 重新產生一份，並把原檔的關鍵值（name / master / simul_efun / include）帶過來。
  // 原檔保留成 config.original，不丟資訊。
  const regenerate = manifest.regenerateConfig === true;
  if (!regenerate && manifest.config && files.has(manifest.config)) return null;

  let carried = {};
  if (regenerate && manifest.config && files.has(manifest.config)) {
    const old = files.get(manifest.config).toString('utf8');
    const grab = (key) => {
      const m = old.match(new RegExp(`^[^\\S\\n]*${key}[^\\S\\n]*:[^\\S\\n]*(\\S.*?)[^\\S\\n]*$`, 'im'));
      return m ? m[1].replace(/\s*#.*$/, '').trim() : null;
    };
    carried = {
      name: grab('name'),
      master: grab('master file'),
      simul: grab('simulated efun file'),
      include: grab('include directories'),
      globalInclude: grab('global include file'),
    };
    files.set('config.original', files.get(manifest.config));
  }
  const has = (p) => files.has(p);
  // 各家 mudlib 放的位置不同：adm/single（zjmud 系）、adm/kernel（nt 系）、secure（DW 系）
  const master = ['adm/single/master.c', 'adm/kernel/master.c', 'adm/master.c', 'secure/master.c']
    .find((p) => has(p));
  const simul = ['adm/single/simul_efun.c', 'adm/kernel/simul_efun.c', 'adm/simul_efun.c',
    'secure/simul_efun.c'].find((p) => has(p));
  if (!master || !simul) return null;

  const globals = ['include/globals.h', 'include/global.h'].find((p) => has(p));
  const lines = [
    '# [wasm] 這份設定檔是由 tools/fix-image.mjs 產生的——來源收藏裡沒有附。',
    '# 欄位取自映像的實際內容（master / simul_efun 的位置就是檔案樹裡那兩個檔）。',
    'name : ' + (carried.name || manifest.title || 'mud'),
    'external_port_1 : telnet 5001',
    'mudlib directory : ./',
    'log directory : /log',
    'master file : ' + (carried.master || '/' + master.replace(/\.c$/, '')),
    'simulated efun file : ' + (carried.simul || '/' + simul.replace(/\.c$/, '')),
    'include directories : ' + (carried.include || '/include'),
    carried.globalInclude ? 'global include file : ' + carried.globalInclude
      : (globals ? 'global include file : <' + globals.split('/').pop() + '>' : ''),
    'time to clean up : 600',
    'time to reset : 900',
    'maximum evaluation cost : 30000000',
    'inherit chain size : 30',
    'maximum array size : 95000',
    'maximum mapping size : 95000',
    'maximum string length : 200000',
    'maximum bits in a bitfield : 1200',
    'maximum byte transfer : 10000',
    'maximum read file size : 200000',
    'hash table size : 16387',
    'object table size : 8003',
    'living hash table size : 100',
    'evaluator stack size : 65536',
    'compiler stack size : 200',
    'maximum call depth : 30',
    'maximum local variables : 30',
    'maximum users : 200',
    '',
  ].filter((l) => l !== '');

  files.set('config.wasm.ini', Buffer.from(lines.join('\n'), 'utf8'));
  const why = regenerate ? '原設定檔 driver 讀不了（指令順序），已重生' : '沒有設定檔，已產生';
  manifest.config = 'config.wasm.ini';
  manifest.regenerateConfig = false;
  return `${why} config.wasm.ini`;
}

/**
 * ⑧ 憑證遮蔽：把寫死的密碼換成 CHANGE_ME。
 *
 * 【WHY】匯入時只掃了「高風險檔案」白名單（mysql.h、adm/etc/config、network/…），
 * 但 `scripts/privacy-scan.sh` 在 nitan7／nt7 掃到
 * `protected string mailname = "lonely-21", mailpasswd = "921121";`——
 * 那是原營運者真實的郵件帳號密碼，而它躺在一個誰也想不到的 .c 裡。
 *
 * 【推理】白名單的前提是「我知道憑證會出現在哪」，而這個前提對 17 個來源不同、
 * 十幾年歷史的 mudlib 根本不成立。所以改成**全檔掃描 + 泛用特徵**，
 * 與 SECURITY_NOTES.md §5 ④ 用的是同一條規則：認得「密碼長什麼樣」，
 * 不認得任何特定密碼——後者會讓這份程式碼自己變成洩漏來源。
 *
 * 誤傷的代價是遊戲裡某個謎題的密碼變成 CHANGE_ME；漏掉的代價是把別人的
 * 真實憑證公開在 GitHub 上。這個取捨沒有懸念。
 *
 * 【證據】privacy-scan 對 libs/nitan7、libs/nt7 的命中。
 */
export function fixRedactSecrets(manifest, files) {
  // 【WHY 要排除換行】`[^"]{6,}` 會**跨行**：遇到只有開引號沒有閉引號的行
  // （例如被註解掉的 `//#define PASSWORD_PROMPT "password: "`），
  // 它會一路吃到**下一行**的引號，把中間整段程式碼換成 CHANGE_ME——
  // 實測 es1_win／esI 兩台的 `include/login.h` 被吃掉一個完整的 `#define`，
  // 於是 `fluffos_boot 回傳 -1`，看起來像那兩台自己有語法錯誤。
  // 憑證不會跨行，加上 \n 排除即可，對真正的密碼沒有任何影響。
  const RE = /((?:password|passwd|pwd|mailpasswd|secret|api_?key|token)\s*[:=]\s*")([^"\n\r]{6,})"/gi;
  const touched = [];
  for (const [p, buf] of files) {
    // 副檔名不可靠：nt7 有一個 `adm/daemons/smtpd.cd`（打字錯誤留下來的），
    // 裡面就是真的郵件密碼。所以只排除明確的二進位，其餘一律掃。
    if (/\.(png|jpg|jpeg|gif|bmp|ico|ttf|otf|woff2?|pdf|o)$/i.test(p)) continue;
    const text = buf.toString('utf8');
    if (!RE.test(text)) { RE.lastIndex = 0; continue; }
    RE.lastIndex = 0;
    const patched = text.replace(RE, (m, head) => `${head}CHANGE_ME"`);
    if (patched === text) continue;
    files.set(p, Buffer.from(patched, 'utf8'));
    touched.push(p);
  }
  return touched.length ? `遮蔽 ${touched.length} 個檔案裡的憑證（${touched.slice(0, 3).join(', ')}${touched.length > 3 ? '…' : ''}）` : null;
}

/**
 * ⑨ 舊 MudOS 容忍、FluffOS 不容忍的參數型別不符。
 *
 * 【WHY】三個 lib（天涯二／仙武奇缘／笑傲江湖）都卡在同一行：
 *   `/clone/user/user.c: error: Bad type for argument 1 of is_killing ( string vs object )`
 * `feature/attack.c` 宣告 `varargs int is_killing(string id)`，而 `accept_kill(object ob)`
 * 直接 `is_killing(ob)`。舊 MudOS 的型別檢查放行，現代 FluffOS 不放行——
 * 於是 **user 物件編譯失敗**，玩家登入後生不出身體，流程卡在 authing。
 *
 * 【推理】兩種修法：改呼叫端或改宣告。改呼叫端等於替原作者決定語意
 * （要傳 `ob->query("id")` 還是本來就想比物件？沒有證據可判）；
 * 把參數放寬成 `mixed` 則是**最小且語意中立**的改法：原本傳字串的呼叫完全不變，
 * 傳物件的呼叫從「編譯失敗」變成「執行期 member_array 找不到就回 0」。
 * 差別只在一個 PK 判定的邊界情況，而代價是整個 lib 能不能玩。
 *
 * 【證據】三個 lib 的 boot-test 都停在 authing，log 都是同一行 is_killing 型別錯誤；
 * `feature/attack.c` 三份的宣告完全相同（同一份祖先程式碼）。
 */
export function fixLooseTypedArgs(manifest, files) {
  const notes = [];
  for (const [p, buf] of files) {
    if (!/\.(c|lpc)$/.test(p)) continue;
    const text = buf.toString('utf8');
    if (!/(?:varargs\s+)?int\s+(?:is_killing|is_want_kill)\s*\(\s*string\s+/.test(text)) continue;
    const patched = text.replace(
      /((?:varargs\s+)?int\s+(?:is_killing|is_want_kill)\s*\(\s*)string(\s+\w+\s*\))/g,
      '$1mixed$2');
    if (patched === text) continue;
    files.set(p, Buffer.from(
      patched.replace(/(^|\n)((?:varargs\s+)?int\s+is_killing\s*\()/,
        '$1// [wasm] 參數放寬為 mixed：呼叫端 clone/user/user.c 的 accept_kill(object ob)\n'
        + '// 直接傳物件，舊 MudOS 放行、FluffOS 不放行，會讓整個 user 物件編譯失敗。\n'
        + '$2'), 'utf8'));
    notes.push(`${p}：is_killing/is_want_kill 參數放寬為 mixed`);
  }
  return notes.length ? notes.join('；') : null;
}

/**
 * ⑩ `valid_write()` 在 SECURITY_D 還沒載入時 fail-open。
 *
 * 【WHY】天涯二／笑傲江湖建角時卡在
 *   `*Denied write permission in save_object().`（/feature/save.c:20），
 * 玩家存檔存不下去，建角流程中止，畫面上完全沒有訊息——只是「按了沒反應」。
 *
 * 【推理】master 的寫法是
 *   `if (ob = find_object(SECURITY_D)) return ob->valid_write(...); return 0;`
 * ——**找不到安全守護程序就一律拒絕**。同一個檔案的 `valid_read()` 反過來是
 * `return 1`（fail-open）。兩者不一致，而建角發生在守護程序尚未被載入的時間點上。
 * 谁与争锋 是同一份 master，只是那邊的載入順序剛好讓 securityd 先起來——
 * 也就是說這條路本來就靠運氣。
 *
 * 讓 valid_write 與同檔的 valid_read 一致（fail-open），是最小且有先例的改法。
 * 安全性影響：WASM 站台整台跑在訪客自己的分頁裡、重整即消失、沒有其他玩家，
 * 本來就沒有需要防禦的權限邊界。**這個修正只適用於 WASM 交付，不該套回真伺服器。**
 *
 * 【證據】tianya2 建角時的 runtime error 與 `/adm/single/master.c` 的
 * valid_write/valid_read 兩段對照。
 */
export function fixValidWriteFailOpen(manifest, files) {
  const notes = [];
  for (const p of ['adm/single/master.c', 'adm/kernel/master.c', 'secure/master.c']) {
    if (!files.has(p)) continue;
    const text = files.get(p).toString('utf8');
    if (/\[wasm\] valid_write/.test(text)) continue;
    const re = /(int\s+valid_write\s*\([^)]*\)\s*\{[\s\S]*?find_object\s*\(\s*SECURITY_D\s*\)[\s\S]*?)\breturn\s+0\s*;(\s*\})/;
    if (!re.test(text)) continue;
    const patched = text.replace(re,
      '$1// [wasm] valid_write：找不到 SECURITY_D 時改為放行（與同檔 valid_read 一致）。\n'
      + '\t// 原本 return 0 會讓建角時的 save_object() 被拒（Denied write permission），\n'
      + '\t// 而那個時間點守護程序還沒載入。WASM 站台是單人、記憶體內、重整即消失的沙箱，\n'
      + '\t// 沒有需要防禦的權限邊界；**這個修改不適用於真正對外的伺服器**。\n'
      + '\treturn 1;$2');
    if (patched === text) continue;
    files.set(p, Buffer.from(patched, 'utf8'));
    notes.push(`${p}：valid_write 在 SECURITY_D 未載入時放行`);
  }
  return notes.length ? notes.join('；') : null;
}

/**
 * ⑩-d 物件載入被當成「玩家在讀原始碼」而遭拒。
 *
 * 【WHY】91书剑 過了版本驗證與帳號檢查之後，畫面停在一個空行不再前進。
 * driver log：
 *   `执行时段错误：*Read access denied.  程式：/adm/daemons/logind.c 第 706 行`
 *   `呼叫来自：logind.c 的 make_body() 第 706 行`
 * 第 706 行是 `user = new(USER_OB);` —— 建立玩家物件時，driver 為了編譯
 * `/clone/user/user.c` 去讀檔，而 securityd 的 exclude_read 把 `clone`
 * 對「(player)」整個關掉，此刻的 this_player 正是還沒有身分的登入物件。
 *
 * 【推理】這條規則在原本的伺服器上不會擋到任何人，因為**那個 driver 不會
 * 為了載入物件去問 valid_read**（MudOS 走的是 valid_object／compile 那一路）。
 * FluffOS 則是把編譯期的讀檔一併送進 `valid_read(file, user, "load_object")`。
 * 也就是說被擋下的不是「玩家偷看原始碼」，而是「玩家走進一個房間」——
 * 真伺服器上每一個玩家每一步都在觸發物件載入，這條規則若真的擋得住，
 * 那台 mud 根本不能玩。所以正確的解讀是：`func == "load_object"` 這個情境
 * 不屬於原規則要防的事，放行它是把語意還原，而不是放寬。
 *
 * 【證據】securityd 自己的 valid_read 開頭就有一組同性質的豁免
 * （`case "file_size": case "stat": return 1;`）——作者本來就知道
 * 「不是真的在讀內容」的呼叫要放過；load_object 是同一類，只是那個 driver
 * 當年不會用這個名字問。
 */
export function fixValidReadLoadObject(manifest, files) {
  const notes = [];
  for (const [p, buf] of files) {
    if (!/\.(c|lpc)$/.test(p)) continue;
    let text = buf.toString('utf8');
    if (!/int\s+valid_read\s*\(/.test(text)) continue;

    // 先撕掉自己上一次補的區塊再重補。
    // 【WHY】第一版只放行 `load_object`，實測後才知道還要放行 include_file／inherit。
    // 若用「看到舊標記就跳過」，改良版永遠補不進去——而且報告會顯示「已處理」。
    // 這個坑 fixMissingQuerySimulEfun 已經踩過一次，規則相同：**冪等性必須
    // 包含「改變主意」**。
    // 縮排不能寫死：第一次插入時是接在 `switch (func) {` 後面，前面沒有換行也沒有
    // tab，第二次才有——用 [ \t]* 才吃得到兩種形狀（第一版寫死 \t\t，結果沒撕乾淨，
    // 留下重複的 case 標籤，那在 LPC 是編譯錯誤）。
    text = text.replace(
      /[ \t]*\/\/ \[wasm\][^\n]*\n(?:[ \t]*\/\/[^\n]*\n)*(?:[ \t]*case "(?:load_object|include|include_file|inherit|compile_object)":[ \t]*\n)+/g,
      '');

    // 只補在「有 file_size/stat 豁免」的那一種——那證明這個 valid_read 就是
    // 會被 driver 以 func 名稱問話的實作，補在同一組豁免裡語意最一致。
    const re = /(int\s+valid_read\s*\([^)]*\)\s*\{[\s\S]*?switch\s*\(\s*func\s*\)\s*\{\s*)/;
    if (!re.test(text)) continue;
    const patched = text.replace(re,
      '$1\t\t// [wasm] 編譯期的讀檔不是「玩家在讀原始碼」，一律放行。\n'
      + '\t\t// driver 為了載入物件會讀 .c、讀它 #include 的標頭、讀它 inherit 的檔案，\n'
      + '\t\t// 這三種讀取 FluffOS 都送進 valid_read（func 分別是 load_object /\n'
      + '\t\t// include_file / inherit）。而 exclude_read 把 clone/d/include 對 (player)\n'
      + '\t\t// 全關 —— 只放行 load_object 的話，下一步就會變成 `Cannot #include globals.h`\n'
      + '\t\t// （實測過）。真伺服器上每個玩家每一步都在觸發這三種讀取。\n'
      + '\t\tcase "load_object":\n'
      + '\t\tcase "include":\n'
      + '\t\tcase "include_file":\n'
      + '\t\tcase "inherit":\n'
      + '\t\tcase "compile_object":\n');
    if (patched === text) continue;
    files.set(p, Buffer.from(patched, 'utf8'));
    notes.push(`${p}：valid_read 放行 load_object`);
  }
  return notes.length ? notes.join('；') : null;
}

/**
 * ⑩-c 登入流程用到、卻沒有被 preload 的守護程序。
 *
 * 【WHY】91书剑 撥號直接失敗，driver log 是
 *   `执行时段错误：*Read access denied.  程式：/adm/daemons/logind.c 第 88 行`
 *   → `logon() on object clone/user/login#0 has failed, the user is disconnected.`
 * 第 88 行是 `BAN_D->is_banned(query_ip_name(ob))`。
 *
 * 【推理】被拒的不是 is_banned 本身，是**它第一次被呼叫時才載入 BAN_D**：
 * `/adm/daemons/band.c` 的 create() 會 `read_file("/log/banned_sites")`。
 * securityd 的 valid_read 開頭是 `if (this_player()) user = this_player();`，
 * 而此刻的 this_player 是剛 new 出來、狀態被判為「(player)」的登入物件；
 * exclude_read 又把 `log`／`adm` 對 (player) 全部關掉 → 讀取被拒 → logon() 拋錯。
 *
 * 關鍵在於**時機**：如果 BAN_D 在開機 preload 時就載入，create() 當下沒有
 * this_player，user 就是守護程序自己（`seteuid(getuid())` 後是 Root），
 * 讀取一路放行——那正是原伺服器上實際發生的情形。也就是說這不是安全模型的問題，
 * 是這份封存的 preload 清單漏了一個登入路徑會用到的守護程序。
 * 所以修法是把它補回 preload，而不是再去放寬一條權限規則。
 *
 * 【證據】91书剑 `adm/etc/preload` 共 18 行，logind／securityd／payd 都在，
 * 唯獨沒有 band；而 `adm/daemons/logind.c:88` 在 logon() 的第一行就用 BAN_D。
 */
export function fixPreloadLogonDaemons(manifest, files) {
  const preloadPath = [...files.keys()].find((p) => /(^|\/)adm\/etc\/preload$/.test(p));
  const logindPath = [...files.keys()].find((p) => /(^|\/)logind\.c$/.test(p));
  if (!preloadPath || !logindPath) return null;

  const logind = files.get(logindPath).toString('utf8');
  const logon = logind.match(/void\s+logon\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  if (!logon) return null;

  // logon() 裡呼叫到的守護程序巨集（FOO_D->bar()）
  const macros = [...new Set([...logon[0].matchAll(/\b([A-Z][A-Z0-9_]*_D)\s*->/g)].map((m) => m[1]))];
  if (!macros.length) return null;

  // 巨集 → 路徑。定義散在各個標頭檔，全部掃一遍最省事也最不會漏。
  const defs = new Map();
  for (const [p, buf] of files) {
    if (!/\.h$/.test(p)) continue;
    for (const m of buf.toString('utf8').matchAll(/#define\s+([A-Z][A-Z0-9_]*_D)\s+"([^"]+)"/g)) {
      if (!defs.has(m[1])) defs.set(m[1], m[2]);
    }
  }

  let text = files.get(preloadPath).toString('utf8');
  if (/\[wasm\]/.test(text)) return null;                    // 已經補過
  const added = [];
  for (const macro of macros) {
    const target = defs.get(macro);
    if (!target) continue;
    const base = target.replace(/\.c$/, '');
    if (new RegExp(`^\\s*${base.replace(/[/.]/g, '\\$&')}(\\.c)?\\s*$`, 'm').test(text)) continue;
    // 檔案真的在映像裡才補，免得 preload 指向不存在的物件反而讓開機更糟
    if (!files.has(base.replace(/^\//, '') + '.c')) continue;
    added.push(base);
  }
  if (!added.length) return null;

  // 註解用 `#`：master 的 update_file() 就是靠行首 `#` 過濾註解的，
  // 其他寫法會被當成檔名（雖然 preload() 有 file_size 檢查而無害，但仍是髒資料）。
  files.set(preloadPath, Buffer.from(
    text.replace(/\s*$/, '\n')
    + '# [wasm] 以下是補進來的：logon() 會用到它們，但原本不在清單裡。\n'
    + '# 第一次連線才載入的話，create() 裡的 read_file 會以「登入物件」的身分\n'
    + '# 通過 securityd，被判成 (player) 而遭拒，logon() 拋錯、連線直接被斷。\n'
    + added.join('\n') + '\n', 'utf8'));
  return `${preloadPath}：補上登入流程需要的 preload（${added.join('、')}）`;
}

/**
 * ⑩-b SECURITY_D 對「還沒有 euid 的連線」fail-closed。
 *
 * 【WHY】91书剑 撥號直接失敗（`fluffos_connect` 回 -1），完全連不上。
 * 真正的錯誤在 driver log 裡：
 *   `执行时段错误：*Read access denied.  程式：/adm/daemons/logind.c 第 88 行`
 *   `new_conn_handler: logon() on object clone/user/login#0 has failed, the user is disconnected.`
 * logind 的 `logon()` 第一件事就是 `BAN_D->is_banned(query_ip_name(ob))`，
 * 那會去讀封鎖名單檔——讀取被拒 → logon() 拋錯 → driver 直接斷線。
 *
 * 【推理】被拒的原因不是路徑規則，是**時間點**：securityd 的 valid_read 一開頭
 * 就把 `user` 換成 `this_player()`，而 logon() 當下的 this_player 是剛 new 出來、
 * 還沒 seteuid 的 `/clone/user/login#0`，於是 `geteuid`/`getuid` 都是空的，
 * 撞上 `if (!euid) return 0;` —— 「還沒有身分的人一律拒絕」。
 * 這條規則對真伺服器是對的，但它讓「尚未登入」這個必經狀態無法讀任何檔案，
 * 而登入流程本身就需要讀封鎖名單。⑩ 已經為 valid_write 做過同一個判斷
 * （fail-open），這裡是同一個問題的讀取端，處理方式保持一致。
 * 安全性影響同⑩：站台是單人、記憶體內、重整即消失的沙箱，
 * **這個修改不適用於真正對外的伺服器**。
 *
 * 【證據】91书剑 `adm/daemons/securityd.c:195` 的 valid_read 開頭三行
 * （`if (this_player()) user = this_player();` → `euid = geteuid(user);` →
 * `if (!euid) return 0;`）與上述 runtime error 的呼叫堆疊完全對得上：
 * `/clone/user/login.c 的 logon() 第 22 行` → `logind.c 第 88 行`。
 */
export function fixSecurityEuidFailOpen(manifest, files) {
  const notes = [];
  for (const [p, buf] of files) {
    if (!/\.(c|lpc)$/.test(p)) continue;
    const text = buf.toString('utf8');
    if (!/int\s+valid_(read|write)\s*\(/.test(text)) continue;
    if (/\[wasm\] 空 euid/.test(text)) continue;

    // 只認「取不到 euid 就拒絕」這個確切形狀，不動任何路徑規則。
    // ★ `getuid` 與 `geteuid` **兩種都要收**。
    // 【WHY】原本只寫 `getuid(user)`，而 hy 用的是 `geteuid(user)`——
    // 差一個字母，整條規則對它靜默失效：不報錯、不警告，報告上看起來一切正常。
    // 代價是 `/adm/etc/nature/*` 讀不到 → `read_file()` 回 0 →
    // `explode(0, "\n")` 執行期錯誤 → NATURE_D 建不起來 →
    // `look_room()` 依賴它而失敗 → `call_other(look,"main",…)` 回 0 →
    // command_hook 落到 notify_fail → 玩家看到的是「什麼？」。
    // 從症狀完全看不出是權限檢查的問題（CLAUDE.md §13：依樣式過濾的地方，
    // 都要對照實際資料確認涵蓋範圍）。
    const re = /(euid\s*=\s*gete?uid\s*\(\s*user\s*\)\s*;\s*if\s*\(\s*!\s*euid\s*\)\s*)return\s+0\s*;/g;
    const patched = text.replace(re,
      '$1// [wasm] 空 euid 改為放行：登入物件在 logon() 當下還沒 seteuid，\n'
      + '\t\t// 而 logon() 必須讀封鎖名單，於是「還沒有身分的人一律拒絕」\n'
      + '\t\t// 會讓連線在建立前就被斷掉（Read access denied → logon() failed）。\n'
      + '\t\t// 沙箱站台沒有需要防禦的權限邊界；不適用於對外伺服器。\n'
      + '\t\treturn 1;');
    if (patched === text) continue;
    files.set(p, Buffer.from(patched, 'utf8'));
    notes.push(`${p}：valid_read/write 對空 euid 放行`);
  }
  return notes.length ? notes.join('；') : null;
}

/**
 * ⑪ nt 家族缺件的 `query(idx, ob)` simul_efun。
 *
 * 【WHY】nt7／泥潭七 開機就死在
 *   `/adm/kernel/simul_efun/user.c:10: error: Undefined function query`。
 * 它們的 simul_efun 有 24 處呼叫 `query("gender", me)`、`query("id", this_player)`
 * 這種兩參數形式，但**整個收藏裡沒有任何一份定義了它**——封存缺件。
 *
 * 【推理】這不是「發明程式碼」，是把唯一可能的語意補回去：所有呼叫端都是
 * `query(<字串屬性路徑>, <物件>)`，而 LPC mudlib 的物件本來就有 `query(string)`。
 * 也就是說這個 simul_efun 只可能是 `ob->query(idx)` 的轉呼叫——
 * 24 個呼叫點沒有一個與這個解讀衝突。補進第一個被 #include 的部分檔（object.c），
 * 才會在 user.c 之前完成宣告。
 *
 * 【證據】nt7 `adm/kernel/simul_efun.c` 的 #include 順序（object.c 第 2、user.c 第 10）；
 * 呼叫點樣本見 NOTES.md。補上之後 driver 才走得完 simul_efun 的載入。
 */
export function fixMissingQuerySimulEfun(manifest, files) {
  // 補在哪一個檔案很重要：必須是 aggregator **最先 #include** 的那一個，
  // 否則宣告會晚於使用。泥潭七 的 simul_efun.c 把 object.c 排在第 5，
  // 而 chinese.c／gender.c（第 2、4）就已經在用 query() 了——補進 object.c 等於沒補。
  const aggregator = ['adm/kernel/simul_efun.c', 'adm/single/simul_efun.c', 'adm/simul_efun.c']
    .find((p) => files.has(p));
  let target = null;
  if (aggregator) {
    const inc = files.get(aggregator).toString('utf8')
      .match(/#include\s+"([^"]+\.c)"/);
    if (inc) {
      const cand = inc[1].replace(/^\/+/, '');
      if (files.has(cand)) target = cand;
    }
  }
  if (!target) {
    target = ['adm/kernel/simul_efun/object.c', 'adm/simul_efun/object.c'].find((p) => files.has(p));
  }
  if (!target) return null;

  const simulFiles = [...files.keys()].filter((p) => /simul_efun/.test(p) && /\.(c|lpc)$/.test(p));

  // 先把先前補過的區塊撕掉再重補。
  // 【WHY】第一版補在 object.c，後來才發現該補在「最先被 include 的那一個」。
  // 若不先撕掉，`defined` 檢查會看到舊的定義而判定「已經有了」，於是永遠補不到
  // 正確的位置——**修正工具的冪等性必須包含「改變主意」這種情況**。
  // 補的區塊一律附加在檔尾，所以撕到檔尾即可。用 lookahead 找「下一個 //」是錯的：
  // 區塊自己就有多行 // 註解，會只撕掉標題、留下函式定義（實測 nitan7 因此補不進去）。
  const BLOCK = /\n?\/\/ \[wasm\] 補回缺件的 simul_efun[\s\S]*$/;
  for (const p of simulFiles) {
    const t = files.get(p).toString('utf8');
    if (BLOCK.test(t)) files.set(p, Buffer.from(t.replace(BLOCK, '\n'), 'utf8'));
  }

  const allText = simulFiles.map((p) => files.get(p).toString('utf8')).join('\n');

  // 三個同一組慣例的缺件。呼叫形式在 nt7 全部一致：
  //   query("gender", me) / query_temp("big5", this_player()) / set_temp("notify_fail", msg, ob)
  const SHIMS = [
    {
      name: 'query',
      used: /(?<![>\w])query\s*\([^;)]*,[^;)]*\)/,
      defined: /^\s*(?:varargs\s+)?mixed\s+query\s*\(/m,
      code: `varargs mixed query(mixed idx, object ob)
{
    if (! objectp(ob)) ob = this_player();
    if (! objectp(ob)) return 0;
    return ob->query(idx);
}`,
    },
    {
      name: 'query_temp',
      used: /(?<![>\w])query_temp\s*\([^;)]*,[^;)]*\)/,
      defined: /^\s*(?:varargs\s+)?mixed\s+query_temp\s*\(/m,
      code: `varargs mixed query_temp(mixed idx, object ob)
{
    if (! objectp(ob)) ob = this_player();
    if (! objectp(ob)) return 0;
    return ob->query_temp(idx);
}`,
    },
    {
      name: 'set_temp',
      used: /(?<![>\w])set_temp\s*\([^;)]*,[^;)]*,[^;)]*\)/,
      defined: /^\s*(?:varargs\s+)?mixed\s+set_temp\s*\(/m,
      code: `varargs mixed set_temp(mixed idx, mixed value, object ob)
{
    if (! objectp(ob)) ob = this_player();
    if (! objectp(ob)) return 0;
    return ob->set_temp(idx, value);
}`,
    },
  ];

  SHIMS.push({
    name: 'set',
    used: /(?<![>\w])set\s*\([^;)]*,[^;)]*,[^;)]*\)/,
    defined: /^\s*(?:varargs\s+)?mixed\s+set\s*\(/m,
    code: `varargs mixed set(mixed idx, mixed value, object ob)
{
    // 回傳「剛設進去的值」。
    // 【證據】treemap.c 的檔頭註解寫著 “Changed to return current value in _set()”，
    // 也就是這一族的 set 語意就是回傳設定後的值；呼叫端也是這樣用的：
    //   if ((string)set("id", myinfo[0], ob) != myinfo[0]) → 報「ID错误」。
    // 先前回傳 ob->set() 或 ob->query() 都不行——這個 mudlib 的公開存取器
    // 藏在 F_DBASE/F_TREEMAP 的繼承鏈裡，從外部 call_other 拿不到值。
    if (! objectp(ob)) ob = this_player();
    if (! objectp(ob)) return 0;
    ob->set(idx, value);
    return value;
}`,
  }, {
    name: 'delete_temp',
    used: /(?<![>\w])delete_temp\s*\([^;)]*,[^;)]*\)/,
    defined: /^\s*(?:varargs\s+)?mixed\s+delete_temp\s*\(/m,
    code: `varargs mixed delete_temp(mixed idx, object ob)
{
    if (! objectp(ob)) ob = this_player();
    if (! objectp(ob)) return 0;
    return ob->delete_temp(idx);
}`,
  }, {
    name: 'addn',
    used: /(?<![>\w])addn\s*\([^;)]*,[^;)]*,[^;)]*\)/,
    defined: /^\s*(?:varargs\s+)?mixed\s+addn\s*\(/m,
    code: `varargs mixed addn(mixed idx, mixed n, object ob)
{
    if (! objectp(ob)) ob = this_player();
    if (! objectp(ob)) return 0;
    return ob->add(idx, n);
}`,
  }, {
    name: 'addn_temp',
    used: /(?<![>\w])addn_temp\s*\([^;)]*,[^;)]*,[^;)]*\)/,
    defined: /^\s*(?:varargs\s+)?mixed\s+addn_temp\s*\(/m,
    code: `varargs mixed addn_temp(mixed idx, mixed n, object ob)
{
    if (! objectp(ob)) ob = this_player();
    if (! objectp(ob)) return 0;
    return ob->add_temp(idx, n);
}`,
  }, {
    name: 'remove_ansi',
    used: /(?<![>\w])remove_ansi\s*\(/,
    defined: /^\s*(?:varargs\s+)?string\s+remove_ansi\s*\(/m,
    code: `string remove_ansi(string str)
{
    string head, tail;
    int i;

    if (! stringp(str)) return str;
    while (sscanf(str, "%s\\x1b[%s", head, tail) == 2)
    {
        i = 0;
        while (i < strlen(tail) && tail[i] != 'm') i++;
        str = head + (i < strlen(tail) ? tail[i + 1 ..] : "");
    }
    return str;
}`,
  }, {
    // nt 家族 driver 的另一個內建函式：算「扣掉 ANSI 控制碼之後的長度」，
    // channeld 用它來把頻道訊息對齊。缺了它，建角完成後 channeld 一編譯就失敗，
    // 連線在「進世界」的前一步被切掉——症狀是登入成功卻什麼都沒收到。
    name: 'noansi_strlen',
    used: /(?<![>\w])noansi_strlen\s*\(/,
    defined: /^\s*(?:varargs\s+)?int\s+noansi_strlen\s*\(/m,
    code: `int noansi_strlen(string str)
{
    if (! stringp(str)) return 0;
    return strlen(remove_ansi(str));
}`,
  }, {
    // 沒有 message() simul_efun 的 lib（91书剑）：直接補一個，語意與 ⑮ 相同。
    name: 'message',
    used: /(?<![>\w])message\s*\([^;)]*,[^;)]*,[^;)]*,[^;)]*\)/,
    defined: /^\s*(?:varargs\s+)?void\s+message\s*\(/m,
    code: `varargs void message(mixed type, mixed msg, mixed target, mixed exclude)
{
    // [wasm] message exclude：第 4 個參數舊 MudOS 收單一物件、也容忍補 0，
    // FluffOS 只收物件陣列，而且**不接受 0**。呼叫端常常只給三個參數
    // （如 message("write", str, this_player())），所以有排除對象才傳第 4 個。
    if (objectp(exclude)) efun::message(type, msg, target, ({ exclude }));
    else if (arrayp(exclude) && sizeof(exclude)) efun::message(type, msg, target, exclude);
    else efun::message(type, msg, target);
}`,
  }, {
    name: 'delete',
    used: /(?<![>\w])delete\s*\([^;)]*,[^;)]*\)/,
    defined: /^\s*(?:varargs\s+)?mixed\s+delete\s*\(/m,
    code: `varargs mixed delete(mixed idx, object ob)
{
    if (! objectp(ob)) ob = this_player();
    if (! objectp(ob)) return 0;
    return ob->delete(idx);
}`,
  });

  // 用到但沒定義的才補。判斷「有沒有人用」要看整個 mudlib，不只 simul_efun——
  // nt7 的 set/delete 是 /feature/save.c 在用（simul_efun 只是它們該住的地方）。
  const wholeLib = [...files.keys()]
    .filter((p) => /\.(c|lpc)$/.test(p))
    .map((p) => files.get(p).toString('utf8')).join('\n');
  const add = SHIMS.filter((sh) => (sh.used.test(allText) || sh.used.test(wholeLib))
    && !sh.defined.test(allText));
  if (!add.length) return null;

  const header = `
// [wasm] 補回缺件的 simul_efun：${add.map((a) => a.name).join(' / ')}
// nt 家族的 simul_efun 呼叫這幾個函式，但**整個收藏裡沒有任何一份定義了它們**
// （封存缺件），於是 simul_efun 一編譯就 Undefined function、整台開不了機。
// 這不是發明語意：所有呼叫端的形式一致（<屬性路徑>, <物件>[, 值]），
// 而 LPC 物件本來就有 query/query_temp/set_temp，所以只可能是轉呼叫。
// 補在 object.c 是因為 simul_efun.c 先 #include 它、後 #include 用到的那些檔。
`;
  files.set(target, Buffer.from(
    files.get(target).toString('utf8') + header + add.map((a) => a.code).join('\n\n') + '\n', 'utf8'));
  return `${target}：補回缺件的 ${add.map((a) => a.name).join('/')} simul_efun`;
}

/**
 * ⑮ `message()` 的第 4 個參數：舊 MudOS 收單一物件，FluffOS 只收陣列。
 *
 * 【WHY】把每一台的 driver log 撈出來分類之後，最常見的執行時例外就是它：
 * **18 次 `*Bad argument 4 to EFUN message()`，橫跨 14 台**。分級看不到這件事
 * （登入照樣走得完），但它發生在 `message("say", …, environment(po), po)` 這種
 * 呼叫上——也就是**說話、廣播、房間訊息**這些每分鐘都在跑的路徑。
 *
 * 【推理】呼叫端寫的是「排除這一個人」，傳的是單一物件；FluffOS 的 message()
 * 第 4 個參數規定是物件陣列（或 0）。這不是 mudlib 寫錯，是 driver 收緊了型別。
 * 而這一族 mudlib 幾乎都已經有一個 `message()` simul_efun 包在 efun 外面
 * （用來做全形標點替換），所以正規化只要加在那一層，一處生效、全部呼叫點受惠——
 * 不必去改散落在幾百個檔案裡的呼叫。
 *
 * 【證據】duobaojianghu `adm/simul_efun/message.c` 的 message() 直接
 * `efun::message(arg, message, target, exclude)` 原樣轉手；而同一份 lib 的
 * `message("shout", str, users(), this_player())`（同檔 329 行）第 4 個參數
 * 就是單一物件。15/16 台都有這個 simul_efun，91书剑 沒有（另以 shim 補）。
 */
export function fixMessageExclude(manifest, files) {
  const notes = [];
  for (const [p, buf] of files) {
    if (!/\.(c|lpc)$/.test(p) || !/simul_efun/.test(p)) continue;
    let text = buf.toString('utf8');

    // 撕掉自己上一版補的東西再重補（又一次「改變主意」——見下方 WHY）
    text = text.replace(/[ \t]*\/\/ \[wasm\] message exclude[\s\S]*?\n(?:[ \t]*(?:if|else)[^\n]*\n)+/g, '');

    const sig = text.match(/^[^\S\n]*(?:varargs\s+)?void\s+message\s*\(([^)]*)\)\s*\{/m);
    if (!sig) continue;
    const params = sig[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (params.length < 4) continue;
    const names = params.map((s) => s.split(/\s+/).pop().replace(/[^\w]/g, ''));
    const [ty, ms, tg, ex] = names;
    if (!ty || !ms || !tg || !ex) continue;

    // 找函式裡那一句 efun::message(...)，整句換掉
    const at = text.indexOf('efun::message', text.indexOf(sig[0]));
    if (at === -1) continue;
    const end = text.indexOf(';', at);
    if (end === -1) continue;
    const lineStart = text.lastIndexOf('\n', at) + 1;
    const indent = (text.slice(lineStart, at).match(/^\s*/) ?? [''])[0];

    // 【WHY 要分三支，而不是把 exclude 正規化成 0】
    // 第一版把非陣列的 exclude 一律設成 0，然後照樣傳四個參數——**沒有修好，
    // 而且在沒有 message() simul_efun 的那台（91书剑）把整台弄成開不了機**。
    // 真正的呼叫長相是 `message("write", str, this_player())`：**只有三個參數**。
    // FluffOS 的第 4 個參數可以省略，但不接受 0；補一個 0 上去等於自己製造
    // `*Bad argument 4`。原本那 18 次錯誤也正是這樣來的——mudlib 的 message()
    // 無條件把四個參數轉手出去，而呼叫端只給了三個。
    // 所以正確做法是：有東西要排除才傳第 4 個參數，沒有就不要傳。
    const call = `${indent}// [wasm] message exclude：第 4 個參數舊 MudOS 收單一物件、也容忍補 0，\n`
      + `${indent}// FluffOS 只收物件陣列，而且**不接受 0**。呼叫端常常只給三個參數\n`
      + `${indent}// （如 message("write", str, this_player())），無條件轉手四個就會\n`
      + `${indent}// *Bad argument 4 to EFUN message()。有排除對象才傳第 4 個。\n`
      + `${indent}if (objectp(${ex})) efun::message(${ty}, ${ms}, ${tg}, ({ ${ex} }));\n`
      + `${indent}else if (arrayp(${ex}) && sizeof(${ex})) efun::message(${ty}, ${ms}, ${tg}, ${ex});\n`
      + `${indent}else efun::message(${ty}, ${ms}, ${tg});`;

    files.set(p, Buffer.from(text.slice(0, lineStart) + call + text.slice(end + 1), 'utf8'));
    notes.push(`${p}：message() 依有無排除對象決定要不要傳第 4 個參數`);
  }
  return notes.length ? notes.join('；') : null;
}

/**
 * ⑫ 設定檔的行尾註解 —— 我自己種下的地雷，清乾淨。
 *
 * 【WHY】`import-lib.mjs` 寫 external_port 時把說明放在行尾：
 *   `external_port_1 : telnet 5001    # [wasm] 由 import-lib.mjs 統一：…`
 * FluffOS 的設定檔**沒有行尾註解**（`#` 只有在行首才是註解，值取冒號後整行），
 * 於是這一行的值變成 `telnet 5001    # [wasm] …`。多數 lib 竟然還是開得起來，
 * 但泥潭七 直接讓後面的 `mudlib directory` 找不到 → `Error in config file` → exit(-1)。
 *
 * 【推理】同樣的坑我在 fixConfigPaths 踩過一次並修好了，卻沒有回頭檢查
 * **另一支工具是不是也這樣寫**——這是典型的「修了症狀、沒修同類」。
 * 這條規則因此不針對某個欄位，而是把設定檔裡**所有** `key : value # [wasm] …`
 * 的行尾註解搬到上一行；import-lib.mjs 那邊也同步改掉，免得下次匯入又長回來。
 *
 * 【證據】泥潭七 boot log：`Missing '"' or '<' around global include file name`
 * 緊接著 `Error in config file. Missing line: mudlib directory`——而該檔
 * 第 28 行明明就有 `mudlib directory : ./`；問題出在第 19 行的行尾註解。
 */
export function fixConfigTrailingComments(manifest, files) {
  const cfg = manifest.config;
  if (!cfg || !files.has(cfg)) return null;
  const text = files.get(cfg).toString('utf8');
  let n = 0;
  const patched = text.split('\n').map((line) => {
    if (/^\s*#/.test(line)) return line;
    const m = line.match(/^([^#\n]*?\S)\s+(#.*)$/);
    if (!m || !/:/.test(m[1])) return line;
    n += 1;
    return `${m[2]}\n${m[1]}`;      // 註解移到上一行
  }).join('\n');
  if (!n) return null;
  files.set(cfg, Buffer.from(patched, 'utf8'));
  return `清掉 ${n} 處設定檔行尾註解（FluffOS 的值取冒號後整行）`;
}

/**
 * ⑬ mudlib 自帶的 driver 自檢（check_config）。
 *
 * 【WHY】泥潭七 的 simul_efun 繼承 `adm/kernel/check_config.c`，它會逐項比對
 * driver 的編譯選項並把不符的項目累積成錯誤訊息：
 *   `#ifdef __PRIVS__  need("需要: #undef PRIVS")`
 *   `#ifndef __PACKAGE_UIDS__  need("需要: #define PACKAGE_UIDS")` …
 * 對象是 **MudOS 0.9.x**（訊息裡直接寫「請修改 driver 原碼的 options.h 重新編譯」）。
 * 在 FluffOS 的 WASM build 上它必然全部不符 → simul_efun 載入失敗 → 整台開不了機。
 *
 * 【推理】這段檢查本身不是 mudlib 的功能，是**給 2000 年代的站長看的安裝提示**。
 * 真正的相容性問題已經由前面幾條規則逐一處理（而且是實測驅動的）；
 * 留著這段自檢只會用一個二十年前的清單否決一個實際上跑得起來的 driver。
 * 所以停用 create()，而不是去偽造那些 `__XXX__` 巨集。
 *
 * 【證據】boot log：`locals: ["需要: #undef PRIVS\n", "fluffos -e059c89"]`
 * → `The simul_efun and master objects must be loadable` → exit(-1)。
 */
export function fixDisableConfigSelfCheck(manifest, files) {
  const notes = [];
  for (const [p, buf] of files) {
    // ★ 副檔名一律 `.(c|lpc)` —— CLAUDE.md §13 記過同一條紀律。
    // 【WHY】原本只認 `.c`，而 sgzmudsgz（LIMA 基底）的檔案是
    // `secure/check_config.lpc`。這條規則對它**靜默失效**：不報錯、不警告，
    // 開機時 create() 在第 71 行 error("Bad driver configuration")，
    // 而症狀是「simul_efun 與 master 必須 loadable」——完全指不到這裡。
    if (!/check_config\.(c|lpc)$/.test(p)) continue;
    const text = buf.toString('utf8');
    if (/\[wasm\] 停用/.test(text)) continue;
    if (!/IMPOSSIBLE_TO_MISS_HEADER|need\s*\(/.test(text)) continue;
    const patched = text.replace(/(void\s+create\s*\(\s*\)\s*\{)/,
      '$1\n    // [wasm] 停用這段自檢：它比對的是 MudOS 0.9.x 的編譯選項\n'
      + '    // （訊息本身就寫著「請修改 driver 原碼的 options.h 重新編譯」），\n'
      + '    // 在 FluffOS 的 WASM build 上必然全部不符，於是 simul_efun 載入失敗、\n'
      + '    // 整台開不了機。真正的相容性問題由 tools/fix-image.mjs 的其他規則處理，\n'
      + '    // 而且每一條都是實測驅動的；這份二十年前的清單留著只會否決能跑的 driver。\n'
      + '    return;');
    if (patched === text) continue;
    files.set(p, Buffer.from(patched, 'utf8'));
    notes.push(`${p}：停用 driver 自檢`);
  }
  return notes.length ? notes.join('；') : null;
}

/**
 * ⑭ nt 家族的屬性系統 —— set/query/delete/addn 在它們的 driver 裡是 efun。
 *
 * 【WHY】泥潭七 走完版本驗證後連線就被切掉，畫面上什麼都沒有。boot log 顯示
 * `/clone/user/user.c:239: error: Unknown efun: set`（同檔 8 處，另有
 * `efun::delete`、`efun::addn`）——玩家物件根本編譯不出來，於是 logon 之後
 * 建不出 user 就 destruct 連線。這是「登入看似成功、其實沒有角色」的完整解釋。
 *
 * 【推理】`efun::` 前綴的意思是「跳過 simul_efun，呼叫 driver 的 efun」，
 * 所以把 set 補成 simul_efun 對 `efun::set` 一點幫助都沒有——這也是為什麼
 * 上一版把 shim 的回傳值改對之後，症狀從「ID错误」變成「什麼都沒有」：
 * 前面那一關過了，卡點往後移到 user.c 編譯失敗。真正的事實是**這一族的
 * mudlib 跑在一個把 set/query/delete/addn 內建成 efun 的改造 driver 上**，
 * 那些 efun 直接讀寫物件裡 F_DBASE 的 `dbase`/`tmp_dbase` mapping。
 *
 * 於是修法只有一種能成立：把那幾個 efun 補成 **F_DBASE 的物件端函式**
 * （用 F_TREEMAP 已經提供的 `_set/_query/_delete` 實作），再把 `efun::set(`
 * 改寫成 `::set(`——LPC 裡 `::name()` 正是「呼叫被我覆寫掉的繼承版本」，
 * 語意與原本的 `efun::set` 完全對應（user.c 覆寫 set 加了升級邏輯，
 * 最後仍要把值寫進 dbase）。改成不帶前綴的 `set(` 會呼叫到自己而無窮遞迴。
 *
 * 【證據】① `feature/treemap.c` 提供 `protected nomask _set/_query/_delete`，
 * 但整個 mudlib **沒有任何一處呼叫它們**——存取層被抽掉了，正是被 driver 取代的痕跡；
 * ② `feature/dbase.c` 有 `dbase`/`tmp_dbase` 兩個 mapping 與 add()/add_temp()，
 * 而 add() 的實作就是 `set(prop, old + data)`，可見 set 本來就該落在同一層；
 * ③ 泥潭七 全部 33 個 `efun::(set|query|delete|addn)` 呼叫點，所在的 6 個檔案
 * （examined.c / giftd.c / warcraft.h / baby.c / user.c / room.c）**每一個都
 * 繼承 F_DBASE**（baby.c 經 BABY、user.c 經 CHARACTER），沒有例外，
 * 所以改寫成 `::` 對每一個呼叫點都成立。
 */
export function fixDbaseEfuns(manifest, files) {
  const dbasePath = [...files.keys()].find((p) => /(^|\/)feature\/dbase\.c$/.test(p));
  if (!dbasePath) return null;
  const dbase = files.get(dbasePath).toString('utf8');
  if (!/inherit\s+F_TREEMAP/.test(dbase)) return null;

  const CALL = /efun::(set|query|delete|addn)\s*\(/g;
  const users = [...files.keys()].filter((p) => /\.(c|h)$/.test(p)
    && CALL.test(files.get(p).toString('utf8')));
  CALL.lastIndex = 0;
  if (!users.length) return null;

  const notes = [];

  // ① 物件端的存取器。已經補過就不再補（冪等）。
  if (!/\[wasm\] 屬性存取器/.test(dbase)) {
    files.set(dbasePath, Buffer.from(dbase + `
// ── [wasm] 屬性存取器 ──────────────────────────────────────────
// nt 家族的 driver 把 set/query/delete/addn 內建成 efun，直接讀寫這個檔案裡的
// dbase/tmp_dbase。FluffOS 沒有那些 efun，所以在這裡用 F_TREEMAP 已經提供的
// _set/_query/_delete 把同樣的語意補回來——存取層本來就該在這一層，
// 證據是同檔的 add() 實作就是 \`set(prop, old + data)\`。
// 帶 ob 參數時轉呼叫該物件自己的版本，這樣覆寫（user.c 的升級邏輯）不會被繞過。

private string *__wasm_parts(mixed idx)
{
    if (! stringp(idx)) idx = "" + idx;
    if (strsrch(idx, "/") == -1) return ({ idx });
    return explode(idx, "/");
}

varargs mixed set(mixed idx, mixed data, object ob)
{
    if (objectp(ob) && ob != this_object()) return ob->set(idx, data);
    if (! mapp(dbase)) dbase = ([ ]);
    return _set(dbase, __wasm_parts(idx), data);
}

varargs mixed query(mixed idx, object ob)
{
    mixed v;

    if (objectp(ob) && ob != this_object()) return ob->query(idx);
    if (! mapp(dbase)) return 0;
    v = _query(dbase, __wasm_parts(idx));
    return undefinedp(v) ? 0 : v;
}

varargs int delete(mixed idx, object ob)
{
    if (objectp(ob) && ob != this_object()) return ob->delete(idx);
    if (! mapp(dbase)) return 0;
    return _delete(dbase, __wasm_parts(idx));
}

varargs mixed set_temp(mixed idx, mixed data, object ob)
{
    if (objectp(ob) && ob != this_object()) return ob->set_temp(idx, data);
    if (! mapp(tmp_dbase)) tmp_dbase = ([ ]);
    return _set(tmp_dbase, __wasm_parts(idx), data);
}

varargs mixed query_temp(mixed idx, object ob)
{
    mixed v;

    if (objectp(ob) && ob != this_object()) return ob->query_temp(idx);
    if (! mapp(tmp_dbase)) return 0;
    v = _query(tmp_dbase, __wasm_parts(idx));
    return undefinedp(v) ? 0 : v;
}

varargs int delete_temp(mixed idx, object ob)
{
    if (objectp(ob) && ob != this_object()) return ob->delete_temp(idx);
    if (! mapp(tmp_dbase)) return 0;
    return _delete(tmp_dbase, __wasm_parts(idx));
}

// addn = 數值累加。與 add() 的差別只在「舊值不是數字時當成 0」，
// 因為呼叫點全是經驗值／潛能這類計數器，遇到髒資料不該 error 掉整個指令。
varargs mixed addn(mixed idx, mixed n, object ob)
{
    mixed old;

    if (objectp(ob) && ob != this_object()) return ob->addn(idx, n);
    old = query(idx);
    if (! intp(old) && ! floatp(old)) old = 0;
    return set(idx, old + n);
}

varargs mixed addn_temp(mixed idx, mixed n, object ob)
{
    mixed old;

    if (objectp(ob) && ob != this_object()) return ob->addn_temp(idx, n);
    old = query_temp(idx);
    if (! intp(old) && ! floatp(old)) old = 0;
    return set_temp(idx, old + n);
}
`, 'utf8'));
    notes.push(`${dbasePath}：補上 set/query/delete/addn（＋temp）物件端存取器`);
  }

  // ② 呼叫點改寫。`efun::` 找的是 driver efun，補成 simul_efun 幫不上忙；
  //    `::` 才是「我覆寫掉的那個繼承版本」，正是原本的語意。
  let sites = 0;
  for (const p of users) {
    const t = files.get(p).toString('utf8');
    const patched = t.replace(/efun::(set|query|delete|addn)\s*\(/g, (_, fn) => {
      sites += 1;
      return `::${fn}(`;
    });
    if (patched !== t) files.set(p, Buffer.from(patched, 'utf8'));
  }
  if (sites) notes.push(`${users.length} 個檔案共 ${sites} 處 efun::→:: 改寫`);
  return notes.length ? notes.join('；') : null;
}

/**
 * ⑳ `enter_world()` 的 root 權限檢查擋掉 call_out 回呼。
 *
 * 【WHY】泥潭七的 logind 這樣寫：
 *   `call_out("enter_world", 1, ob, user);`
 * 而 `enter_world()` 的第一行是
 *   `if (!is_root(previous_object())) { destruct(user); return; }`
 * ——**call_out 的回呼裡 `previous_object()` 是 0**，不是 root，
 * 於是人物一建好就被 destruct。玩家進到世界時沒有身體也沒有房間，
 * 畫面只有「你的四周灰蒙蒙地一片，什么也没有。」
 *
 * 【推理】那個檢查的用意是「不讓外部物件亂呼叫 enter_world」，
 * 但 call_out 是 **logind 自己排程的**——它本來就該被信任。
 * `previous_object()` 為 0 代表「呼叫來自 driver 的排程」，
 * 那正是最安全的情況之一，不該被擋。
 *
 * 【證據】nitan7：登入成功（收到 ESC000）但沒有任何面板；
 * trace 顯示連續三行「你的四周灰蒙蒙地一片」。
 * logind.c 的 `enter_world()` 首段與 `call_out("enter_world",1,ob,user)` 並存。
 */
export function fixEnterWorldRootGuard(manifest, files) {
  const notes = [];
  for (const [p, buf] of files) {
    if (!/logind\.(c|lpc)$/.test(p)) continue;
    let text = buf.toString('utf8');
    if (!/call_out\s*\(\s*"enter_world"/.test(text)) continue;   // 沒排程就沒這問題

    // 只放行「previous_object() 為 0」這一種情況，其餘檢查照舊
    const re = /if\s*\(\s*!\s*is_root\s*\(\s*previous_object\s*\(\s*\)\s*\)\s*\)/g;
    if (!re.test(text)) continue;
    text = text.replace(re,
      'if (previous_object() && ! is_root(previous_object()))');
    files.set(p, Buffer.from(text, 'utf8'));
    notes.push(`${p}：enter_world 的 root 檢查放行 driver 排程（previous_object()==0）`);
  }
  return notes.length ? notes.join('；') : null;
}

/**
 * ㉑ `enter_world()` 的「按任意鍵繼續」倒數關卡。
 *
 * 【WHY】泥潭七的 enter_world 有這一段：
 *   `if (timer && --timer) {`
 *   `    write("请输入任意键继续或 " + timer + " 秒后自动进入游戏");`
 *   `    input_to((: enter_world, ob, user, silent, 1 :));`
 *   `    return;`
 *   `}`
 * 那是 telnet 時代的進場提示——**zjmud 客戶端不會送按鍵**，
 * 於是流程永遠停在 input_to，人物建好了卻進不了世界。
 * 客戶端收到 0008→0007 之後就再無下文，畫面只有
 * 「你的四周灰蒙蒙地一片，什么也没有。」
 *
 * 【WHY 直接讓 timer 失效而不是自動按鍵】按鍵要由客戶端送，
 * 而我們改不到客戶端的行為（那是使用者的瀏覽器）。
 * 伺服器端把倒數關掉最直接：`timer` 為 0 就跳過整段，直接往下進世界。
 * 【WHY 不影響 telnet 玩家】那段只是「等你按一下」，跳過它等於
 * 「不用按就直接進去」——沒有任何遊戲內容被略過。
 *
 * 【證據】nitan7：transcript 只有 ESC000 0008 與 0007，之後完全靜止；
 * logind.c 的 `enter_world(object ob, object user, int silent, int timer, string arg)`
 * 首段即為上述倒數。
 */
export function fixEnterWorldKeyPrompt(manifest, files) {
  const notes = [];
  for (const [p, buf] of files) {
    if (!/logind\.(c|lpc)$/.test(p)) continue;
    let text = buf.toString('utf8');
    const re = /if\s*\(\s*timer\s*&&\s*--\s*timer\s*\)/g;
    if (!re.test(text)) continue;
    // `if (0 && --timer)` —— 條件恆假，整段被跳過，其餘程式碼一字不動
    text = text.replace(re, 'if (0 && --timer)   /* [zjmud] 跳過「按任意鍵繼續」：客戶端不會送按鍵 */');
    files.set(p, Buffer.from(text, 'utf8'));
    notes.push(`${p}：跳過 enter_world 的「按任意鍵繼續」倒數`);
  }
  return notes.length ? notes.join('；') : null;
}

/**
 * ㉒ 啟用中的 zjmud 客戶端金鑰驗證。
 *
 * 【WHY】絕大多數原生 zjmud 台把這段檢查**註解掉**了
 * （終極地獄的原始碼就是 `else /*if (arg!=crypt(ZJKEY,str[2..3]))...*\/`），
 * 但指尖MUD（zjmudhell）是啟用的：
 *   `} else if (arg != crypt(ZJKEY, str[2..3])) { write("客户端非法\n"); ... }`
 * 我們的客戶端沒有實作那個回應，於是握手一送出就被拒——
 * 畫面只有 `ver1.0,...` 與「客户端非法」，看起來像協議不相容。
 *
 * 【WHY 放行是合理的】ZJKEY 是**寫死在公開標頭裡的常數**
 * （`#define ZJKEY "123456789abcd"`），任何人讀得到原始碼就算得出答案。
 * 它擋不住惡意客戶端，只會擋掉合法的——這也是為什麼其他台都把它註解掉。
 * 【WHY 不在客戶端實作 crypt】那要在瀏覽器裡重現 DES/SHA-512 crypt，
 * 而各台的 salt 規則還不一樣（有的 `str[2..3]`、有的 `0`）。
 * 伺服器端放行是一行的事，客戶端實作是一整包相依。
 */
/**
 * 這個位置是不是在 `/* … *\/` 區塊註解裡面？
 *
 * 【WHY】`fixZjmudKeyCheck` 把 ZJKEY 檢查換成 `if (0) /* 說明 *\/ {`——
 * 而 wxddym 的那段檢查**本來就被整段註解掉了**（該 lib 自己停用的）。
 * 在區塊註解裡插一個 `/* … *\/`，內層的結束符會提前關掉外層註解，
 * 於是原本那個 `*\/` 變成孤兒：
 *   logind.lpc:164:1: error: syntax error, unexpected '*'
 * logind 因此編譯失敗 → `No program in object '/adm/daemons/logind'`
 * → master 的 connect() 建不出登入物件 → `fluffos_connect 失敗`。
 * 而報告只寫「撥號失敗」，完全看不出是一個註解結構被破壞。
 *
 * 【推理】更根本的問題是：**我們修補了一段死程式碼**。已經被註解掉的檢查
 * 不需要放行，改它只有壞處。所以判準不是「怎麼安全地插註解」，
 * 而是「在註解裡的匹配一律跳過」。
 */
function inBlockComment(text, index) {
  const open = text.lastIndexOf('/*', index);
  if (open === -1) return false;
  const close = text.lastIndexOf('*\/', index);
  return close < open;
}

export function fixZjmudKeyCheck(manifest, files) {
  const notes = [];
  for (const [p, buf] of files) {
    if (!/logind\.(c|lpc)$/.test(p)) continue;
    let text = buf.toString('utf8');
    // ① 版本握手的金鑰回應：`else if (arg != crypt(ZJKEY, str[2..3]))`
    const re = /else\s+if\s*\(\s*arg\s*!=\s*crypt\s*\(\s*ZJKEY\s*,[^)]*\)\s*\)/g;
    // ② 帳號欄位的密文校驗：
    //    `if ((crypt(ZJKEY, myinfo[0]) + crypt(ZJKEY, myinfo[1])) != myinfo[2])`
    // 【WHY 同一類】兩者都用公開常數 ZJKEY 算校驗值，原生台也都是註解掉的。
    // 放行第一個之後會卡在第二個——實測 zjmudhell 從「客户端非法」
    // 變成「账号数据校验错误」，往前一步卻仍然進不去。
    const re2 = /if\s*\(\s*\(\s*crypt\s*\(\s*ZJKEY\s*,[^)]*\)\s*\+\s*crypt\s*\(\s*ZJKEY\s*,[^)]*\)\s*\)\s*!=\s*\w+\[\d+\]\s*\)/g;
    // ★ 在區塊註解裡的匹配一律跳過（見 inBlockComment 的說明）。
    // 已經被該 lib 自己註解掉的檢查不需要放行，改它只有壞處——
    // 而且會把註解結構弄壞，症狀變成「撥號失敗」。
    let touched = false;
    const swap = (rx, repl) => {
      text = text.replace(rx, (m, ...rest) => {
        const at = rest[rest.length - 2];
        if (inBlockComment(text, at)) return m;
        touched = true;
        return repl;
      });
    };
    swap(re, 'else if (0)   /* [zjmud] 放行客戶端金鑰驗證：ZJKEY 是公開常數 */');
    swap(re2, 'if (0)   /* [zjmud] 放行帳號密文校驗：同樣用公開常數 ZJKEY */');
    if (!touched) continue;
    files.set(p, Buffer.from(text, 'utf8'));
    notes.push(`${p}：放行 zjmud 客戶端金鑰驗證`);
  }
  return notes.length ? notes.join('；') : null;
}


/**
 * 指令目錄掃描只認 `.c`，而這些樹整棵都是 `.lpc` —— 世界因此收不到任何指令。
 *
 * 【WHY】使用者要求「測試所有選單」之後，新加的指令探針抓到 sjecl：
 * 面板齊全、`living=是 interactive=是`、搜尋路徑完整
 * （`/cmds/group/ /cmds/usr/ /cmds/std/ /cmds/skill/`），
 * 但真瀏覽器裡 `look` 與 `hp` **全部回「什麼？」**——玩家一個指令都下不了。
 *
 * 【推理】追到 `adm/daemons/commandd.lpc`：
 *
 *   void rehash(string dir) {
 *     cmds = get_dir(dir);
 *     while (i--)
 *       if (!sscanf(cmds[i] + "$", "%s.c$", cmds[i]))     // ← 只保留 .c
 *         cmds = cmds[0..i-1] + cmds[i+1..<1];
 *
 * 指令表因此建成空的，`find_command()` 一律回 0，`command_hook` 走到
 * `tell_object(me, query_notify_fail())` ——那句就是「什麼？」。
 * 這是 CLAUDE.md §13 的翻版，只是這次在 **mudlib 自己的程式碼**裡：
 * 依副檔名過濾的地方，都要對照實際資料確認涵蓋範圍。
 *
 * 【WHY 只放寬不改寫】把 `.c` 換成 `.lpc` 會弄壞真的用 `.c` 的台
 * （原生收藏裡有好幾台是）。改成「兩種都收」是純粹的放寬：
 * 原本會過的照樣過，原本被丟掉的 `.lpc` 現在留下來。
 *
 * 【證據】sjecl `adm/daemons/commandd.lpc`；全收藏 17 台有這個模式。
 */
export function fixCommandDirExt(manifest, files) {
  const notes = [];
  const MARK = '/* [zjmud] 指令目錄掃描放寬到 .lpc */';
  for (const [p, buf] of files) {
    if (!/\.(c|lpc)$/.test(p)) continue;
    let t = buf.toString('utf8');
    if (!t.includes('get_dir(')) continue;
    if (!/sscanf\s*\([^;]*?"%s\.c\$?"/.test(t)) continue;
    // ★ 冪等：先撕掉自己上一次補的，再重補（CLAUDE.md §6）
    t = t.split(MARK).join('');
    const before = t;
    t = t.replace(
      /(!?)sscanf\s*\(\s*([A-Za-z_][\w\[\]<>.+-]*)\s*\+\s*"\$"\s*,\s*"%s\.c\$"\s*,\s*([A-Za-z_][\w\[\]<>.+-]*)\s*\)/g,
      (mm, bang, a, b) => `${bang}(sscanf(${a} + "$", "%s.c$", ${b})`
        + ` || sscanf(${a} + "$", "%s.lpc$", ${b})) ${MARK}`);
    if (t !== before) {
      files.set(p, Buffer.from(t, 'utf8'));
      notes.push(`${p}：指令目錄掃描放寬到 .lpc`);
    }
  }
  return notes.length ? notes.join('；') : null;
}


/**
 * 登入流程裡的 MOTD **分頁器**會攔住輸入，等玩家按鍵——而 zjmud 客戶端沒有那一關。
 *
 * 【WHY】西游记451 卡了四輪。協議流停在 `0007` 之後，探針顯示
 * `init 之前` 印得出來、之後一片安靜，看起來像「執行緒死了」。
 * 真相是 `enter_world()` 裡：
 *
 *   if (file_size(MOTD) > 0)
 *     user->start_more(read_file(MOTD), 1);
 *
 * `start_more()` 是分頁器：它接管玩家的輸入，等你按空白或 q。
 * 上游的手動記錄裡那一步就寫著 `q (skip paginated MOTD)`——
 * 真人會按，我們的客戶端不會，於是整條流程停在那裡等一個永遠不會來的按鍵。
 * **沒有任何錯誤訊息**，因為根本沒有錯誤。
 *
 * 【WHY 換成直接輸出而不是清空 MOTD】清空檔案能讓守衛跳過（實測有效），
 * 但那是把公告內容丟掉——而玩家本來就該看到它。改成 `tell_object`
 * 是「同樣的內容、不要那個會等按鍵的殼」，資訊一個字都不少。
 * 【WHY 要 `|| ""`】`read_file()` 讀不到會回 0，`tell_object(u, 0)` 會拋錯。
 *
 * 【證據】xyj451 `adm/daemons/logind.lpc enter_world()`；
 * 全收藏 51 台的登入流程有 start_more(MOTD)。
 */
export function fixMotdPager(manifest, files) {
  const notes = [];
  const MARK = '/* [zjmud] MOTD 分頁器改為直接輸出 */';
  for (const [p, buf] of files) {
    if (!/(logind|login)[^/]*\.(c|lpc)$/i.test(p)) continue;
    let t = buf.toString('utf8');
    if (!t.includes('start_more')) continue;
    // ★ 冪等：先撕掉自己上一次補的，再重補（CLAUDE.md §6）
    t = t.split(MARK).join('');
    const before = t;
    // ★ 順序重要：`F_MORE->` 這條要**先**跑。
    // 【WHY】F_MORE 是巨集（指向 more 的功能檔），不是某個玩家物件。
    // 通用的 `<物件>->start_more` 樣式會先把它吃掉，產生
    // `tell_object(F_MORE, …)`——訊息送給一個 daemon，等於內容不見了，
    // 而且完全不會報錯。實測第一版就是這樣（tiexuejianghu）。
    t = t.replace(
      /\bF_MORE\s*->\s*start_more\s*\(\s*([^;]*?)\s*\)\s*;/g,
      (mm, arg) => {
        const first = arg.replace(/,\s*\d+\s*$/, '').trim();
        return `write((${first}) || ""); ${MARK}`;
      });
    // `<物件>->start_more(<內容>[, n]);` → tell_object(<物件>, <內容> || "");
    t = t.replace(
      /\b([A-Za-z_]\w*)\s*->\s*start_more\s*\(\s*([^;]*?)\s*\)\s*;/g,
      (mm, obj, arg) => {
        const first = arg.replace(/,\s*\d+\s*$/, '').trim();
        return `tell_object(${obj}, (${first}) || ""); ${MARK}`;
      });
    if (t !== before) {
      files.set(p, Buffer.from(t, 'utf8'));
      notes.push(`${p}：MOTD 分頁器改為直接輸出`);
    }
  }
  return notes.length ? notes.join('；') : null;
}



/**
 * `valid_read` 對「有 euid 但不在信任清單」的讀取一律拒絕——連 mudlib 自己的
 * 遊戲內容都讀不到，daemon 因此建不起來，而症狀出現在五層之外。
 *
 * 【WHY】hy／hy5：面板齊全、搜尋路徑完整、living／interactive 都正常，
 * 但玩家下任何指令都得到「什麼？」。從 driver 的執行期錯誤追出完整的鏈：
 *   valid_read 拒絕 `/adm/etc/nature/day_phase`
 *     → `read_file()` 回 0
 *     → `explode(0, "\n")` 執行期錯誤（natured.lpc:722 read_table，對讀取失敗無防護）
 *     → NATURE_D 的 create() 失敗，物件建不起來
 *     → `look_room()` 呼叫 `NATURE_D->outdoor_room_outcolor()` 跟著失敗
 *     → `call_other(look, "main", …)` 回 0
 *     → command_hook 落到 notify_fail —— 那句就是「什麼？」
 * 五層之外的一個權限檢查，長成「這台沒有這個指令」的樣子。
 *
 * 【WHY 用排除法而不是白名單】第一版只放行 `/adm/etc`，結果同一台的
 * `questd` 讀 `/quest/dynamic_quest` 又中同一個坑——逐個目錄加白名單
 * 就是打地鼠，而且每漏一個都長成完全不同的症狀。
 * 反過來想：**這個檢查真正要保護的是什麼**？玩家存檔（`/data/`）與
 * 巫師的家目錄（`/u/`）。其餘的整棵樹都是遊戲內容——房間、NPC、任務表、
 * 天氣表——mudlib 讀自己的內容本來就該被允許。所以規則寫成
 * 「除了那兩處，其餘放行」，範圍明確而且不會再漏。
 *
 * 【WHY 這仍是沙箱專用】站台是單人、記憶體內、重整即消失，沒有需要防禦的
 * 權限邊界。**這個修改不適用於真正對外的伺服器。**
 *
 * 【證據】hy `adm/daemons/securityd.lpc` valid_read；driver log
 * `执行时段错误：*Bad argument 1 to explode()` @ natured.lpc:722、questd.lpc:698。
 */
export function fixValidReadOwnData(manifest, files) {
  const notes = [];
  const MARK = '[wasm] valid_read：放行 mudlib 自己的遊戲內容';
  for (const [p, buf] of files) {
    if (!/\.(c|lpc)$/.test(p)) continue;
    const text = buf.toString('utf8');
    if (text.includes(MARK)) continue;
    const m = /int\s+valid_read\s*\(\s*string\s+(\w+)\s*,[^)]*\)\s*\{/.exec(text);
    if (!m) continue;
    const f = m[1];
    const inject = `\n  // ${MARK}。\n`
      + `  // daemon 在 create() 裡讀自己的資料表時，euid 還不在信任清單裡，\n`
      + `  // 被自己的權限檢查擋掉——read_file() 回 0，而呼叫端多半沒有防護\n`
      + `  // （explode(0,…) 直接執行期錯誤），daemon 就建不起來。影響會傳到很遠：\n`
      + `  // hy 的 look 因為 NATURE_D 沒建起來而失敗，玩家看到的是「什麼？」。\n`
      + `  // 真正要保護的是玩家存檔與巫師家目錄，那兩處的規則一個字都不動。\n`
      + `  if (! sscanf(${f}, "/data/%*s") && ! sscanf(${f}, "/u/%*s"))\n`
      + `    return 1;\n`;
    const at = m.index + m[0].length;
    files.set(p, Buffer.from(text.slice(0, at) + inject + text.slice(at), 'utf8'));
    notes.push(`${p}：valid_read 放行遊戲內容（/data 與 /u 除外）`);
  }
  return notes.length ? notes.join('；') : null;
}


/**
 * 把「刻意廢止的輸出 efun」轉回真正的 efun。
 *
 * 【WHY】重生的世界（chongshengdeshijie）撥號一律失敗，追了四輪：
 * 排除過 include、`private` 修飾字、埠號分派、master 的 create()。
 * 最後把 `login_ob::logon()` 裡**第三個** catch 的內容挖出來才看到真相：
 *   `*write() 已經廢止使用, 請改用 tell()`
 * 這個 lib 的 simul_efun 把 write/tell_object/say/tell_room/message
 * 全部做成「呼叫就 error()」的樁，強迫自家開發者改用新 API。
 * 而**我們注入的 zjmud 登入與面板程式碼整段都靠這些 efun**——
 * 於是 logon 一開口就 raise，被 catch 吞掉、destruct 自己、connect 回 0，
 * 症狀只剩下「fluffos_connect 失敗」，離真因五層遠。
 *
 * 【判準】這條守衛保護的是「原作者不要再用舊 API」，對轉換出來的映像
 * 只有破壞性——把它們轉發回 efun:: 就好，lib 自己的程式碼一行不用改。
 * 【WHY 不改我們的模板】改成 tell() 會讓其餘 200 多台一起變動，
 * 而它們的 write()/tell_object() 完全正常（CLAUDE.md §33／§34：
 * 範圍由症狀決定，不是由樣式決定）。
 */
export function fixDeprecatedOutputEfuns(manifest, files) {
  const notes = [];
  // 每個 efun 的實際參數個數不同，而且**它們都不是 varargs**——
  // 直接寫 `efun::write(args...)` 會編譯失敗
  // （Illegal to pass variable number of arguments to non-varargs efun），
  // 而那個失敗發生在 simul_efun，整台當場開不了機。所以逐個依 sizeof 展開。
  const BODY = {
    write: 'if (sizeof(a) > 0) efun::write(a[0]);',
    tell_object: 'if (sizeof(a) > 1) efun::tell_object(a[0], a[1]);',
    say: 'if (sizeof(a) > 1) efun::say(a[0], a[1]); else if (sizeof(a) > 0) efun::say(a[0]);',
    tell_room: 'if (sizeof(a) > 2) efun::tell_room(a[0], a[1], a[2]);'
      + ' else if (sizeof(a) > 1) efun::tell_room(a[0], a[1]);',
    message: 'if (sizeof(a) > 2) efun::message(a[0], a[1], a[2]);'
      + ' else if (sizeof(a) > 1) efun::message(a[0], a[1], this_player());',
  };
  for (const [p, buf] of files) {
    if (!/\.(c|h|lpc)$/.test(p)) continue;
    let text = buf.toString('utf8');
    const hit = [];
    for (const [name, body] of Object.entries(BODY)) {
      // 只認「整個函數體就是一句 error()，而且訊息在說它被廢止」這種樁。
      const re = new RegExp(
        `void\\s+${name}\\s*\\(\\s*mixed\\s+(\\w+)\\s*\\.\\.\\.\\s*\\)\\s*\\{`
        + `\\s*error\\(\\s*"[^"]*廢止[^"]*"\\s*\\)\\s*;\\s*\\}`, 'g');
      const next = text.replace(re, (_m, param) =>
        `void ${name}(mixed ${param}...) { /* [zjmud] 轉發廢止守衛 */ mixed *a; a = ${param}; ${body} }`);
      if (next !== text) { hit.push(name); text = next; }
    }
    if (!hit.length) continue;
    files.set(p, Buffer.from(text, 'utf8'));
    notes.push(`${p}：${hit.join('／')} 由「呼叫就報錯」改為轉發給 efun`);
  }
  return notes.length ? notes.join(' / ') : null;
}


/**
 * 把**玩家存檔**從映像裡拿掉。
 *
 * 【WHY】專案規則寫著「`data/**\/*.o`（含明文密碼的玩家存檔）永遠不收」，
 * 而匯入端的過濾是**照路徑**寫的。實際掃過映像內部才發現：這些存檔多半
 * **不在 `data/` 底下**——它們住在 `temp/login/…`、`dump/2020-6-15/login/…`、
 * `drop/login_bak/…`、`suicide/login/…`、`u/<巫師>/badplayer/login/…`。
 * 於是 41 台、9,373 個真人玩家的存檔（含 crypt 密碼雜湊、姓名、上線紀錄）
 * 一路被打包、發佈到公開站台。
 *
 * 【為什麼閘門沒攔】`scripts/privacy-scan.sh` 用 `find … -name '*.o'` 掃**磁碟**，
 * 而存檔是打包在 `mudlib.data` 這個 blob 裡的——磁碟上根本沒有那些檔案。
 * 閘門看的地方，跟產品發佈的東西不是同一個（CLAUDE.md 核心原則）。
 *
 * 【判準】兩條任一成立就移除：
 *   ① 路徑像登入／人物存檔目錄（login／user／player／char）
 *   ② 內容有 password 欄而且**有值**（巫師自己的物件也可能帶密碼）
 * 兩條都不成立的 `.o` 是遊戲資料（公告板、語言表、任務狀態），不動。
 */
export function stripPlayerSaves(manifest, files) {
  const gone = [];
  for (const [p, buf] of [...files]) {
    if (!isPlayerSave(p, buf)) continue;
    files.delete(p);
    gone.push(p);
  }
  if (!gone.length) return null;
  return `移除 ${gone.length} 個玩家存檔（例：${gone.slice(0, 2).join('、')}）`;
}


/**
 * 讓設定檔的 `port number` 對上 `master::connect()` 真正分派的那個埠。
 *
 * 【WHY】火影有兩份（huoying／hy2），上游說它們「567/569 個檔相同，
 * 差異只有排版」。huoying 可玩，hy2 撥號一律失敗。比對之後差別只有一個數字：
 *
 *     huoying   MUD_PORT = 40059   config port number = 40059   → 相符，可玩
 *     hy2       MUD_PORT =  8000   config port number = 40123   → 不符
 *
 * `connect(int port)` 是 `switch (port) { case MUD_PORT: … }`，
 * 對不上就沒有任何 case 命中 → 函數結束 → 回 0 → driver 報
 * 「Can not accept connection … due to error in connect()」。
 * 那個訊息完全看不出是**一個埠號**，而且這台看起來像「整份 mudlib 壞掉」。
 *
 * 【WHY 不是既有的 fixExternalPort】那條找的是 zjmud 專屬樣式
 * （`if (port == N) … set_temp("zjmud")`），抓不到 switch/case 這種分派。
 * 【判準】connect() 的 switch 第一個 case 是這個 lib 心目中的「玩家埠」；
 * 把 config 對齊它。常數要能解析（數字或 include 裡的 #define）才動手，
 * 解析不出來就不碰——寧可不改，也不要改成錯的。
 */
export function fixMudPortMismatch(manifest, files) {
  const cfg = manifest.config;
  if (!cfg || !files.has(cfg)) return null;
  const cfgText = files.get(cfg).toString('utf8');
  const cur = cfgText.match(/^([^\S\n]*port\s+number[^\S\n]*:[^\S\n]*)(\d+)[^\S\n]*$/im);
  if (!cur) return null;

  const mm = cfgText.match(/^\s*master\s+file\s*:\s*(\S+)/im);
  let master = null;
  if (mm) {
    const base = mm[1].replace(/^\/+/, '').replace(/\.(c|lpc)$/, '');
    master = [base + '.c', base + '.lpc', base].find((x) => files.has(x)) || null;
  }
  if (!master) return null;
  const text = files.get(master).toString('utf8');

  const sigAt = text.search(/connect\s*\(\s*int\s+\w+\s*\)/);
  if (sigAt === -1) return null;
  const body = text.slice(sigAt, sigAt + 4000);
  if (!/switch\s*\(\s*\w+\s*\)/.test(body)) return null;

  // ★ 要先把**所有** case 都解析出來，不能只看第一個。
  //
  // 【WHY】第一版只取 switch 的第一個 case，結果 5 台現役可玩的台被判定要改：
  //   dongfanggushi2／kxkjii2／xinkuangxiangkongjian2 → HTTPD_PORT(4015)
  //   xiaoaojianghu2／xo_final                        → ERR_IS_NOT(1)
  // 那些 case 是 http 埠與錯誤碼，改下去等於把好的台弄壞。
  // 【判準】現在的 port number **命中任何一個 case 就不要動**——
  // 這台本來就分派得到，沒有問題要修。真正要修的只有「一個都命中不了」的台
  // （hy2：MUD_PORT=8000，而 config 寫 40123，switch 沒有 case 接得住）。
  const resolve = (tok) => {
    if (/^\d+$/.test(tok)) return tok;
    const re = new RegExp('^\\s*#define\\s+' + tok + '\\s+(\\d+)', 'm');
    for (const [p2, buf] of files) {
      if (!/\.(h|lpc|c)$/.test(p2)) continue;
      const hit = re.exec(buf.toString('utf8'));
      if (hit) return hit[1];
    }
    return null;
  };
  const cases = [];
  for (const m2 of body.matchAll(/case\s+([A-Za-z_]\w*|\d+)\s*:/g)) {
    const v = resolve(m2[1]);
    if (v) cases.push([m2[1], v]);
  }
  if (!cases.length) return null;
  if (cases.some(([, v]) => v === cur[2])) return null;   // 已經接得住，不要動

  // 挑「玩家埠」：名字帶 MUD／LOGIN／PLAYER 的優先；都沒有就不猜。
  const pick = cases.find(([n]) => /MUD|LOGIN|PLAYER/i.test(n) && !/HTTP|FTP|ERR/i.test(n));
  if (!pick) return null;
  const want = pick[1];
  if (want === cur[2]) return null;

  files.set(cfg, Buffer.from(cfgText.replace(cur[0], cur[1] + want), 'utf8'));
  return `port number ${cur[2]} → ${want}（master::connect() 的 switch 分派用 ${pick[0]}）`;
}

export const FIXUPS = [fixConfigName, fixSynthesizeConfig, fixConfigTrailingComments, fixConfigPaths, fixStaticModifier,
  fixExternalPort, fixMudPortMismatch, fixIsChinese, fixChineseNameLength, fixLogDirs, fixWriteDirs, fixLooseTypedArgs, fixValidWriteFailOpen,
  fixSecurityEuidFailOpen, fixValidReadLoadObject, fixValidReadOwnData, fixMessageExclude, fixPreloadLogonDaemons, fixMissingQuerySimulEfun, fixDbaseEfuns,
  fixDisableConfigSelfCheck, fixEnterWorldRootGuard, fixEnterWorldKeyPrompt, fixZjmudKeyCheck, fixCommandDirExt, fixMotdPager, fixDeprecatedOutputEfuns, stripPlayerSaves, fixRedactSecrets];

// ── CLI ────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run');
  const slugs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const targets = slugs.length ? slugs
    : fs.readdirSync(LIBS).filter((d) => fs.existsSync(path.join(LIBS, d, 'mudlib.json')));

  for (const slug of targets) {
    const dir = path.join(LIBS, slug);
    if (!fs.existsSync(path.join(dir, 'mudlib.json'))) { console.log(`[skip] ${slug}：沒有映像`); continue; }
    const { manifest, files } = loadImage(dir);
    const notes = [];
    for (const fix of FIXUPS) {
      const n = fix(manifest, files);
      if (n) notes.push(n);
    }
    if (!notes.length) { console.log(`[ok  ] ${slug}`); continue; }
    if (!dryRun) {
      saveImage(dir, manifest, files);
      const metaPath = path.join(dir, 'mud.json');
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.config = manifest.config;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
      }
    }
    console.log(`[fix ] ${slug}：${notes.join(' / ')}`);
  }
}
