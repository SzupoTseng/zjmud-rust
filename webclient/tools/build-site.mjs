#!/usr/bin/env node
// 產生可直接放上 GitHub Pages 的靜態站台：客戶端 ＋ driver ＋ 每個 mud 的映像。
//
// 【WHY】目標是「點一下就玩」，而且要**可選 mud**。整站沒有任何伺服器端程式碼：
// 瀏覽器下載 driver（3.6 MB wasm）與選中 mud 的映像，在分頁裡把 FluffOS 跑起來。
//
// 【推理】目錄佈局照 fluffos/mudlibs 的作法：一份共用 driver（_driver/）＋
// 每個 mud 一個資料夾（libs/<slug>/）＋一份由建置產生的索引（libs/index.json）。
// 差別只在「點下去開的是誰」——那邊是 xterm 終端機，這邊是 zjmud 客戶端。
// 索引裡的 badge **不是人工標的**：每個 mud 都真的被 boot-test 跑過一次
// 「註冊→建角→進世界」，跑出什麼就寫什麼，所以清單不會隨時間變成謊言。
//
// 【證據】mudlibs.fluffos.info 的 play 頁載入順序：
//   _driver/vendor/xterm.js → _driver/telnet.js → fluffos-boot.js → mudlib.js
//   → _driver/fluffos.js，且 Module.locateFile 把 .wasm 指回 ../_driver/。
//   本站等價，只是把終端機換成 src/ 底下的客戶端。
//
// 用法：node tools/build-site.mjs [--out ../site] [--skip-boot-test] [--only <slug>]

import * as OpenCC from 'opencc-js';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildImage } from './pack-lib.mjs';
import { FIXUPS, loadImage, saveImage } from './fix-image.mjs';
import { bootTest } from './boot-test.mjs';
import { driverAvailable, DRIVER_DIR } from './wasm-node.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBCLIENT = path.resolve(HERE, '..');
const REPO = path.resolve(WEBCLIENT, '..');
const LIBS_DIR = path.join(REPO, 'libs');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * 讀 libs/<slug>/mud.json。
 *
 * 兩種形態，優先序固定：
 *   ① `mudlib.data` + `mudlib.json`（**版控裡的形態**）——匯入時就打包好了。
 *      理由是 9P 寫入只有 28 檔/分，把一萬個小檔放進版控不可行（見 import-all.mjs）。
 *   ② `work/` 檔案樹——上游本來就在這個倉庫裡的那一個（lpmudname），
 *      或開發者自己解開來改的。
 * 兩者都存在時以 ① 為準，因為那才是實際會被發佈的位元組。
 */
export function readLibs(only = null) {
  if (!fs.existsSync(LIBS_DIR)) return [];
  return fs.readdirSync(LIBS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    // ★ `--only` 支援逗號清單。
    // 【WHY】只比對單一 slug 時，`--only a,b,c` 會**一台都不中**——
    // 而建置會照樣「成功」地產出 0 台，畫面上看不出異常。
    // sweep-web.mjs 早就為同一個原因支援逗號清單（見那支的說明），
    // 這裡沒跟上。抽驗幾台是最常見的用法，不該只能一次一台。
    .filter((slug) => !only || only.split(',').map((x) => x.trim()).includes(slug))
    .map((slug) => {
      const dir = path.join(LIBS_DIR, slug);
      const metaPath = path.join(dir, 'mud.json');
      if (!fs.existsSync(metaPath)) return null;
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      // 【WHY 也接受只有 .gz】`mudlib.data` 與 `mudlib.data.gz` 是**同一份資料的
      // 兩種形式**，而瀏覽器只需要 `.gz`（載入端優先抓它，用 DecompressionStream
      // 串流解壓）。兩份都放進版控等於把同樣的位元組存兩次——
      // 實測 97 台的 `.data` 是 2.8 GB 而 `.gz` 只有 282 MB，
      // 多出來的 2.5 GB 純粹是重複。`.data` 可以隨時從 `.gz` 還原，
      // 所以版控只留 `.gz`，建站時直接複製。
      const prepacked = fs.existsSync(path.join(dir, 'mudlib.json'))
        && (fs.existsSync(path.join(dir, 'mudlib.data'))
            || fs.existsSync(path.join(dir, 'mudlib.data.gz')));
      const work = meta.work ? path.resolve(dir, meta.work) : path.join(dir, 'work');
      return { slug, dir, meta, work, prepacked };
    })
    .filter(Boolean)
    .filter((l) => {
      if (l.prepacked || fs.existsSync(l.work)) return true;
      console.warn(`  ⚠ ${l.slug}：既沒有 mudlib.data 也沒有 work/，略過`);
      return false;
    });
}

function copyDir(src, dst, filter = () => true) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (!filter(s)) continue;
    if (e.isDirectory()) copyDir(s, d, filter);
    else fs.copyFileSync(s, d);
  }
}

async function main() {
  const out = path.resolve(arg('out', path.join(REPO, 'site')));
  const only = arg('only', null);
  const linkLibs = process.argv.includes('--link-libs');
  const skipBoot = process.argv.includes('--skip-boot-test');

  if (!driverAvailable()) {
    console.error(`找不到 driver（${DRIVER_DIR}）。先跑：node tools/fetch-driver.mjs`);
    process.exit(2);
  }

  console.log('輸出到', out);
  // ★ `--only` 時**不可以清空輸出目錄**。
  //
  // 【WHY】原本無條件 `rmSync(out)`：於是「只重建一台來驗證修正」會把
  // 其餘 213 台的映像檔連同索引一起刪光——而畫面上只寫「完成：1 個 mud」，
  // 看起來像成功了。我因此每次驗一台都得跑全量重建（214 台、一個多小時），
  // 而且中途一度把站台弄成只剩一台還沒立刻察覺。
  // 【判準】全量建置才清空（那時清空是對的，可以掃掉已移除的台）；
  // 指定台數時只覆寫那幾台，其餘一個位元組都不要動（CLAUDE.md §16）。
  if (!only) fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  // ① 客戶端本體（就是平常那份，沒有分支）
  copyDir(path.join(WEBCLIENT, 'src'), out);
  console.log('  客戶端 → site/');

  // ② 共用 driver
  const driverOut = path.join(out, '_driver');
  fs.mkdirSync(driverOut, { recursive: true });
  for (const f of ['fluffos.js', 'fluffos.wasm']) {
    fs.copyFileSync(path.join(DRIVER_DIR, f), path.join(driverOut, f));
  }
  const driverVersion = fs.existsSync(path.join(DRIVER_DIR, 'VERSION'))
    ? fs.readFileSync(path.join(DRIVER_DIR, 'VERSION'), 'utf8').trim() : 'unknown';
  console.log(`  driver ${driverVersion} → site/_driver/`);

  // ③ 每個 mud：打包 → 開機測試 → 記錄
  const libs = readLibs(only);
  if (!libs.length) console.warn('  ⚠ libs/ 底下沒有任何可用的 mud');
  const catalogue = [];

  for (const lib of libs) {
    const { slug, meta, work } = lib;
    const libOut = path.join(out, 'libs', slug);
    fs.mkdirSync(libOut, { recursive: true });

    const config = meta.config || 'config.ini';
    let manifest;
    let sizeMB;
    if (lib.prepacked) {
      // 版控裡已經是映像了，直接複製——不重新打包，發佈的位元組就是被測過的那份
      fs.copyFileSync(path.join(lib.dir, 'mudlib.json'), path.join(libOut, 'mudlib.json'));
      // ★ 發佈 gzip 版而不是原始映像。
      // 【WHY】GitHub Pages 上限 1 GB；98 台 telnet lib 的原始碼共 3.7 GB，
      // 不壓就收錄不了。LPC 實測壓到 23-24%，客戶端用原生 DecompressionStream
      // 串流解壓（見 mudlibimage.js fetchImage）。版控裡仍存未壓縮的原件——
      // 那是被 boot-test 測過的那份位元組，壓縮只是傳輸格式。
      const gzSrc = path.join(lib.dir, 'mudlib.data.gz');
      if (linkLibs && fs.existsSync(gzSrc)) {
        // ★ `--link-libs`：**不複製**大檔，由伺服器直接從 libs/ 供應。
        //
        // 【WHY】映像佔整站 1.4 GB 的 99.7%，而它在 libs/ 裡已經有一份了。
        // 複製一次等於容器裡放兩份、部署時搬兩份——GitHub Pages 時代
        // 那是必要的（Pages 只吃一個目錄），但倉庫轉 private 之後站台改由
        // Railway 供應，而 Railway 是「跑一個程序」的模型：程序讀得到 libs/，
        // 就沒有理由再複製一份。實測建置從 1.4 GB 降到 4 MB。
        // 【判準】serve-site 對 /libs/<slug>/… 找不到時回退到倉庫的 libs/
        //（見那支的說明）。發佈的位元組完全一樣，只是少搬一次。
        sizeMB = +(fs.statSync(gzSrc).size / 1e6).toFixed(1);
      } else if (fs.existsSync(gzSrc)) {
        fs.copyFileSync(gzSrc, path.join(libOut, 'mudlib.data.gz'));   // 版控裡就是 .gz
      } else {
        fs.writeFileSync(path.join(libOut, 'mudlib.data.gz'),
          zlib.gzipSync(fs.readFileSync(path.join(lib.dir, 'mudlib.data')), { level: 6 }));
      }
      // telnet 台的登入 metadata 跟映像一起發佈（見 extract-zjmud-metadata.mjs）
      const zm = `zjmud.metadata.${slug}.json`;
      if (fs.existsSync(path.join(lib.dir, zm))) {
        fs.copyFileSync(path.join(lib.dir, zm), path.join(libOut, zm));
      }
      manifest = JSON.parse(fs.readFileSync(path.join(libOut, 'mudlib.json'), 'utf8'));
      // 【WHY 要容許 .data 不存在】版控只留 `.gz`（見 README「版控與體積規則」），
      // CI checkout 出來的目錄裡沒有 `mudlib.data`。原本無條件 statSync
      // 會 ENOENT，而失敗訊息只說「建置站台失敗」——看不出是少了一個
      // **本來就不該進版控的衍生檔**。原始大小改從 manifest 的 totalBytes 取，
      // 那是打包時就記下來的事實，不必回頭去量檔案。
      const rawPath = path.join(lib.dir, 'mudlib.data');
      const rawMB = fs.existsSync(rawPath)
        ? +(fs.statSync(rawPath).size / 1e6).toFixed(1)
        : +((manifest.totalBytes || 0) / 1e6).toFixed(1);
      // `--link-libs` 時大檔留在 libs/，量原處那一份（同一個檔案，只是沒複製）
      sizeMB = +(fs.statSync(linkLibs && fs.existsSync(gzSrc)
        ? gzSrc : path.join(libOut, 'mudlib.data.gz')).size / 1e6).toFixed(1);
      console.log(`  ${slug}：${manifest.files.length} 檔 / ${sizeMB} MB gzip（原 ${rawMB} MB）`);
    } else {
      const built = buildImage(work, { mount: '/mudlib', config });
      manifest = built.manifest;
      fs.writeFileSync(path.join(libOut, 'mudlib.json'), JSON.stringify(manifest));
      fs.writeFileSync(path.join(libOut, 'mudlib.data'), built.data);

      // ★ 從原始碼直接打包的台**也要跑相容性修正**。
      //
      // 【WHY】收藏裡絕大多數的台是先經過 builder（mud2zjmud）轉換的，
      // 那條路會跑 fix-image 的整組修正；而 `work` 指向倉庫別處、
      // 建置時才打包的台走的是這一條——**完全沒有任何修正**。
      // 於是同一個已知缺陷，在別台早就修好，在這裡照樣發作。
      // 【證據】江湖論劍（lpmudname，本專案 fork 的上游）：
      // driver log 滿是 `执行时段错误：*Bad argument 4 to EFUN message()`，
      // 而 `fixMessageExclude` 這條規則**早就存在**（wxddym 等台都套過）。
      // 症狀是角色進不了房間：「你的四周灰蒙蒙地一片，什么也没有。」
      // ——看起來像起始房間設定錯了，其實是 message() 在進場路徑上一直拋錯。
      // 【判準】只要是**我們自己打包**的位元組，就該享有同一套修正。
      // 差別待遇會讓「已知缺陷」在某些台上永遠活著，而且沒有人會想到去那裡找。
      try {
        const img = loadImage(libOut);
        const notes = [];
        for (const fix of FIXUPS) {
          const n = fix(img.manifest, img.files);
          if (n) notes.push(n);
        }
        if (notes.length) {
          saveImage(libOut, img.manifest, img.files);
          manifest = img.manifest;
          console.log(`    相容性修正：${notes.length} 組`);
        }
      } catch (e) {
        console.warn(`    ⚠ 相容性修正失敗（照舊發佈未修正的映像）：${e.message}`);
      }

      sizeMB = +(fs.statSync(path.join(libOut, 'mudlib.data')).size / 1e6).toFixed(1);
      console.log(`  ${slug}：${manifest.files.length} 檔 / ${sizeMB} MB 已打包`);
    }

    // 【WHY 要認 convert.lastCheck】builder（mud2zjmud）每次轉換都會把
    // 開機驗證結果寫進 `mud.json` 的 `convert.lastCheck`。用
    // `--skip-boot-test` 建站時若只看頂層 `meta.badge`，那 75 台原生轉換的
    // 台全部變成 `unknown`——而 `sweep-web` 只掃 `playable`，
    // 於是**一台都不會被驗到**，再配上舊的空集合判斷就印出「全部通過」。
    // 證據明明已經有了，只是存在別的欄位；不該為此重跑 115 台開機測試。
    let badge = meta.badge || meta.convert?.lastCheck?.badge || 'unknown';
    let note = meta.note || '';
    let dialect = meta.dialect || null;
    if (!skipBoot) {
      // ★ 一台開機時拋例外，**不可以中斷整批**。
      //
      // 【WHY】實測 `sje` 的映像 dirs 與 files 不一致，unpackImage 直接拋
      // 「寫入 open/freeze_list 失敗（errno 31）」——整個 build-site 當場結束在
      // 第 106 台，前面 105 台的結果全部沒寫進索引，站台等於沒建成。
      // 一台壞掉的代價變成「其餘 108 台的狀態你都不知道」。
      // batch-convert.mjs 的開頭早就寫過這條紀律（「不可以因為一台壞掉就中斷整批」），
      // 但這支工具沒有套用——CLAUDE.md §17 的同一條：
      // 自己新寫的閘門越完整，越容易忘記別處已經寫過的紀律。
      // 【判準】例外＝這一台 noboot，理由記進報告，然後繼續下一台。
      // ★ 測的是**打包後的映像**，不是原始目錄——這樣才抓得到打包漏檔。
      let res;
      try {
        res = await bootTest({
          // `--link-libs` 時 libOut 底下沒有大檔（刻意不複製），測原處那一份——
          // 是同一個檔案，發佈的位元組也是它。
          // ★ 但只有**已打包**的台才有 lib.dir/mudlib.json。
          // 【WHY】江湖論劍（lpmudname）的映像是建置時才從 `LPMud-Name/world`
          // 打包出來的（mud.json 的 work 指過去，刻意不在 libs/ 複製一份）。
          // 對它傳 lib.dir 會 ENOENT，而那個例外被收斂成 noboot——
          // 於是本專案自己 fork 的上游伺服器在收藏裡一直標著「開不了機」，
          // 理由寫的是「映像缺件」。缺的不是件，是我這個判斷少了一個條件。
          image: (linkLibs && lib.prepacked) ? lib.dir : libOut,
          config: manifest.config || config,
          // telnet lib 走接應器測；zjmud lib 照舊
          ...(meta.protocol ? { protocol: meta.protocol, loginProfile: meta.loginProfile } : {}),
        });
      } catch (e) {
        res = {
          badge: 'noboot',
          reason: `開機時拋例外：${(e?.message ?? String(e)).slice(0, 160)}`,
          opcodes: [], loadFailures: [],
        };
      }
      badge = res.badge;
      dialect = res.dialect || dialect;
      note = res.badge === 'playable' ? '' : res.reason;
      console.log(`    → ${badge.toUpperCase()}：${res.reason}`);
      if (res.loadFailures.length) {
        console.log(`       載入失敗：${res.loadFailures.join(', ')}`);
      }
      fs.writeFileSync(path.join(libOut, 'boot-test.json'), JSON.stringify(res, null, 2));

      // ★ 量到的結果要**寫回 mud.json**，否則 badge 會過期。
      //
      // 【WHY】`--skip-boot-test` 建置是讀 mud.json 的 badge（那是刻意的：
      // 誰轉換誰負責驗證，CI 讀結果）。但 build-site 自己真的開機測過之後
      // **不寫回去**——於是量到的事實只活在那一次的 console 與 site 裡，
      // mud.json 繼續宣稱舊結論。
      // 【證據】wuhanzhan：site2 的完整建置明明測出 NOBOOT
      // （`fluffos_boot 回傳 -1`、「不發佈映像」），mud.json 卻一直寫著 playable。
      // 下一次 `--skip-boot-test` 建站就把它當可玩的收進索引，
      // 而 npm test 依索引逐台開機時當場紅——**紅得對，但線索指向錯的地方**：
      // 我一開始以為是自己這輪的改動弄壞的，花了好幾步做 A/B 才排除。
      // 【判準】測過就寫回去。量測與紀錄之間不該有落差，
      // 有落差的地方遲早會有人（包括三小時後的自己）相信錯的那一邊。
      const metaBack = path.join(lib.dir, 'mud.json');
      if (fs.existsSync(metaBack)) {
        try {
          const mm = JSON.parse(fs.readFileSync(metaBack, 'utf8'));
          mm.badge = res.badge;
          mm.note = res.badge === 'playable' ? '' : (res.reason ?? '');
          mm.convert = mm.convert ?? {};
          mm.convert.lastCheck = {
            ...(mm.convert.lastCheck ?? {}),
            badge: res.badge,
            reason: res.reason ?? '',
            opcodes: res.opcodes ?? [],
            acceptsCommands: res.acceptsCommands ?? null,
            by: 'build-site',
          };
          fs.writeFileSync(metaBack, JSON.stringify(mm, null, 2) + '\n');
        } catch { /* mud.json 壞了不該讓建站失敗，報告裡照樣有結果 */ }
      }

      // 開不了機的就不要把映像發出去。
      // 【WHY】三個 noboot 的 lib 加起來 220 MB，佔了整站資料的一半——
      // 發佈它們等於讓每個訪客的頻寬與 Pages 的空間都花在沒有人點得下去的東西上。
      // 但**仍然列在索引裡**（badge=noboot、卡片不可點），因為這個站台同時也是
      // 一份收藏清單：把失敗的項目藏起來會讓人以為我們沒收錄，而不是收錄了但開不起來。
      if (badge === 'noboot') {
        fs.rmSync(path.join(libOut, 'mudlib.data.gz'), { force: true });
        fs.rmSync(path.join(libOut, 'mudlib.data'), { force: true });
        fs.rmSync(path.join(libOut, 'mudlib.json'), { force: true });
        sizeMB = 0;
        console.log('       （不發佈映像：開不了機）');
      }
    }

    // ★ 分辨「原生 zjmud」與「由 telnet 轉換而來」。
    //
    // 【WHY】收藏裡有兩種東西，而它們的性質完全不同：
    //   · **原生 zjmud**——本專案原本就收的 19 台，mudlib 自己就會說 zjmud
    //     協議（作者當年就是為 zjmud 客戶端寫的），我們一個位元組都沒改。
    //   · **轉換而來**——上游 fluffos/mudlibs 的 telnet mudlib，由 mud2zjmud
    //     注入登入與面板之後才會說 zjmud。
    // 不標示的話，使用者會以為 195 台都是「原本就這樣」——
    // 而那 19 台的**歷史價值**（真正的 zjmud 時代遺物）就被淹沒了。
    // 反過來說，轉換台若出現原作沒有的行為，也該讓人知道那是我們加的。
    const origin = (meta.convert && (meta.convert.family || meta.convert.by === 'mud2zjmud'))
      ? 'converted' : 'native';
    catalogue.push({
      origin,
      slug,
      title: meta.title || slug,
      subtitle: meta.subtitle || '',
      source: meta.source || '',
      dialect,
      badge,
      note,
      sizeMB,
      base: './libs/' + slug,
      // telnet lib（非 zjmud）才有這兩個欄位：客戶端據此改走登入接應器
      ...(meta.protocol ? { protocol: meta.protocol } : {}),
      ...(meta.loginProfile ? { loginProfile: meta.loginProfile } : {}),
    });
  }

  // ★ `--only` 要**併回**既有索引，不是把它換掉。
  //
  // 【WHY】原本只建一台就把 index.json 整份覆寫成那一台——於是「重建某一台
  // 來驗證修正」這個最常見的動作，代價是整個站台索引只剩一筆，
  // 而任何逐台掃描工具都會跟著只看到一台（或報「找不到這一台」）。
  // 我因此被迫每次都跑全量重建（214 台，一個多小時），只為了驗一台。
  // 【判準】只有這次真的重建過的那幾台要更新，其餘照舊——
  // 這正是 CLAUDE.md §16：批次操作前先確認「這個東西該不該被動」。
  const idxPath = path.join(out, 'libs', 'index.json');
  let merged = catalogue;
  if (only && fs.existsSync(idxPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(idxPath, 'utf8')).muds ?? [];
      const built = new Set(catalogue.map((m) => m.slug));
      merged = [...prev.filter((m) => !built.has(m.slug)), ...catalogue];
      console.log(`（--only：${catalogue.length} 台更新，沿用既有索引裡的 ${merged.length - catalogue.length} 台）`);
    } catch {
      /* 舊索引壞了就照舊全寫，讓這次的結果至少留下來 */
    }
  }

  fs.writeFileSync(idxPath, JSON.stringify({
    generated: new Date().toISOString(),
    driver: driverVersion,
    // * 記下這次是不是 --link-libs 建的。
    // WHY: 那個旗標讓大檔留在 libs/ 由伺服器回退供應——產物 1.4 GB -> 189 MB，
    // 代價是 site/ 不再自足。而「site/libs/<slug> 是完整的映像目錄」是別處
    // 一直依賴的不變式：wasm.test.mjs 直接拿它去開機，改用 --link-libs 之後
    // 當場 ENOENT。改變不變式的人要負責讓依賴它的地方知道，不是等它們壞掉。
    linkedLibs: Boolean(linkLibs),
    // 【WHY 索引也要轉】客戶端的 mud 清單、登入視窗標題都讀這份 index.json。
    // 只轉目錄頁的話，點進去又變回簡體——同一個名字在兩個畫面長得不一樣。
    // 一樣只轉顯示用的欄位（title/subtitle/note），slug 與 base 是識別碼不能動。
    muds: merged.map((m) => ({
      ...m,
      title: m.title ? OpenCC.Converter({ from: 'cn', to: 'twp' })(m.title) : m.title,
      subtitle: m.subtitle ? OpenCC.Converter({ from: 'cn', to: 'twp' })(m.subtitle) : m.subtitle,
      note: m.note ? OpenCC.Converter({ from: 'cn', to: 'twp' })(m.note) : m.note,
    })),
  }, null, 2));

  // ★ 讓「線上現在是哪個 commit」可以**直接 curl 得到**。
  //
  // 【WHY】CLAUDE.md §1 說「看線上產物，不要看 CI 綠燈」，但一直缺一格：
  // 線上唯一能看的時間戳是 `index.json` 的 `generated`，而它只回答
  // 「什麼時候建的」，不回答「**建的是哪一版**」。於是站台停更 11 個 commit 時，
  // 我只能靠比對各台 badge 去猜，還一度往「CI 壞了」的方向查了整整一輪
  // （真因是推送太密把 run 一直取消掉，見 pages.yml 的 concurrency 說明）。
  // 【判準】有了 sha，守成檢查就從「感覺有沒有更新」變成**實數比對**：
  //   curl .../_build-info.json | jq -r .sha   vs   git rev-parse HEAD
  // 【WHY 不放進 index.json】那份是客戶端每次都要載的清單，
  // 而這是診斷用的中繼資料；分開才不會為了看一個 sha 去下載整份索引。
  const sha = process.env.GITHUB_SHA
    || (() => { try { return execSync('git rev-parse HEAD', { cwd: HERE }).toString().trim(); }
                catch { return null; } })();
  fs.writeFileSync(path.join(out, '_build-info.json'), JSON.stringify({
    sha,
    shortSha: sha ? sha.slice(0, 7) : null,
    ref: process.env.GITHUB_REF ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    generated: new Date().toISOString(),
    muds: merged.length,
    playable: merged.filter((m) => m.badge === 'playable').length,
    linkedLibs: Boolean(linkLibs),
  }, null, 2));

  // ★ 索引不可以比站台**樂觀**：它列的每一台，站台裡都要真的有映像。
  //
  // 【WHY】`--only` 建置會把索引與前一次合併（否則點進其他台會 404），
  // 但只有這次建的那幾台會寫出映像。於是索引宣稱 `linkedLibs: false`
  // （＝站台自足）卻列著 214 台，而 site/libs 底下只有 9 台有 .data/.gz。
  // 本機看不出來——`serve-site` 有回退，缺的會從倉庫 libs/ 補上；
  // 但**部署到 GitHub Pages 沒有那條回退**，其餘 205 台當場 404。
  // 症狀出現的地方也離真因很遠：先壞的是 wasm.test.mjs（ENOENT），
  // 看起來像測試環境問題。
  // 【判準】索引列的台數 vs 站台裡真的有映像的台數，兩個數字要相等。
  if (!linkLibs) {
    const missing = merged.filter((m) => {
      const d = path.join(out, 'libs', m.slug);
      return !fs.existsSync(path.join(d, 'mudlib.data.gz')) && !fs.existsSync(path.join(d, 'mudlib.data'));
    }).map((m) => m.slug);
    if (missing.length) {
      const msg = `索引列了 ${merged.length} 台，但站台裡只有 ${merged.length - missing.length} 台有映像`
        + `（缺 ${missing.length} 台，如 ${missing.slice(0, 3).join('、')}）`;
      // --only 是局部建置，站台本來就不完整——警告即可，不要擋住開發流程。
      // 但**全量建置**產出不完整的站台是會部署出去的，那必須是硬錯誤。
      if (only) console.warn(`  ⚠ ${msg}；這是 --only 的局部站台，部署前要跑一次全量建置`);
      else throw new Error(msg);
    }
  }

  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  // ★ 目錄頁：一台一列，每列一個直達連結。
  //
  // 【WHY】站台收了上百台 mud，開場選單在十幾台時還算合理，
  // 上百台時它變成一道多餘的門——使用者是帶著意圖進來的
  // （他想玩「火影忍者」），不該再被問一次要玩哪一台。
  // 【參考】mudlibs.fluffos.info 的做法：目錄頁列出全部，每列一個連結。
  // 【WHY 用 `?mud=<slug>` 而不是各自一個資料夾】站台是靜態的，
  // 每台複製一份客戶端會多出上百份完全相同的 JS/CSS；
  // 查詢參數同時也是**儲存命名空間**的來源（見 prefs.js），一舉兩得。
  {
    // ★ 顯示一律轉繁體。
    //
    // 【WHY】上游的 meta.json 與 README.md 都是簡體（來源本來就是簡體社群），
    // 而這個站台的介面、CLAUDE.md、所有文件都是繁體——同一頁上混著
    // 「江湖论剑」與「連線」看起來像沒做完。
    // 【WHY 只轉顯示不動資料】`mud.json` 保留來源原文，那是**封存的一部分**；
    // 轉換只發生在產生 HTML 的這一刻。要對照上游時仍然對得起來。
    // 【WHY 用 twp 而不是 tw】twp 連詞彙也在地化（如「软件→軟體」），
    // 對遊戲名稱與說明文字比逐字轉換自然。
    const s2t = OpenCC.Converter({ from: 'cn', to: 'twp' });
    const esc = (x) => s2t(String(x ?? '')).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rows = catalogue
      .slice()
      // 排序：可玩的在前 → **原生的在前** → 中文名。
      //
      // 【WHY 原生優先】原生台是本專案原本就收的 zjmud mudlib——作者當年就是
      // 為 zjmud 客戶端寫的，一個位元組都沒改，面板與選單是他們自己設計的。
      // 轉換台是我們注入登入與面板之後才會說這個協議，忠實度天生低一階。
      // 想看「這個協議原本長什麼樣子」的人，應該第一眼就看到原生的那幾台。
      // 【WHY 可玩仍是第一順位】開不了機的台放在最上面只會擋路——
      // 排序要服務「想找一台來玩」這個最常見的意圖。
      .sort((a, b) => (a.badge === b.badge ? 0 : a.badge === 'playable' ? -1 : 1)
        || (a.origin === b.origin ? 0 : a.origin === 'native' ? -1 : 1)
        || String(a.title).localeCompare(String(b.title), 'zh-Hant'))
      .map((m, i) => {
        const no = String(i + 1).padStart(3, '0');
        const ok = m.badge === 'playable';
        const href = `./play.html?mud=${encodeURIComponent(m.slug)}`;
        const tag = ok ? '<span class="ok">可玩</span>'
          : m.badge === 'limited' ? '<span class="lim">受限</span>'
          : '<span class="no-b">開不了機</span>';
        // 【WHY 把搜尋鍵放進 data 屬性】搜尋時比對這個字串就好，
        // 不必每次去拼 DOM 的文字節點；而且可以把「代號」「來源」「狀態」
        // 這些不一定顯示在同一格的資訊一起塞進來，讓一個輸入框就能全找。
        const key = [m.title, m.slug, m.subtitle || m.note || '',
          m.origin === 'native' ? '原生 native' : '轉換 converted',
          ok ? '可玩 playable' : m.badge === 'limited' ? '受限 limited' : '開不了機 noboot',
        ].join(' ').toLowerCase();
        return `<tr class="${ok ? '' : 'dim'}" data-k="${esc(key)}" data-b="${esc(m.badge || '')}" data-o="${esc(m.origin || '')}">`
          + `<td class="no">${no}</td>`
          + `<td>${ok ? `<a href="${href}">${esc(m.title || m.slug)}</a>`
                      : esc(m.title || m.slug)}</td>`
          + `<td class="og">${m.origin === 'native'
                ? '<span class="nat" title="本專案原本就收的 zjmud mudlib，作者當年就是為 zjmud 客戶端寫的，我們一個位元組都沒改">原生</span>'
                : '<span class="cvt" title="上游 fluffos/mudlibs 的 telnet mudlib，由 mud2zjmud 注入 zjmud 登入與面板後才會說這個協議">轉換</span>'}</td>`
          + `<td class="s">${esc(m.slug)}</td>`
          + `<td>${tag}</td>`
          + `<td class="s">${m.sizeMB ? m.sizeMB.toFixed(1) + ' MB' : ''}</td>`
          // 【WHY 要處理 Markdown 標記】上游的說明是 Markdown，直接輸出會看到
          // 生的 `**火影**` 與反引號——那是給人讀的文字不是原始碼。
          // 只做最小處理：粗體與行內程式碼轉成純文字，其餘照舊。
          + `<td class="n">${esc(m.subtitle || m.note || '')
              .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')}</td></tr>`;
      }).join('\n');
    const playable = catalogue.filter((m) => m.badge === 'playable').length;
    const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>zjmud 收藏 —— ${catalogue.length} 台可在瀏覽器裡玩的中文 MUD</title>
<style>
/* ★ 配色沿用客戶端的「竹簡夜」主題（src/css/tokens.css）。
   【WHY】目錄頁原本用瀏覽器預設的 light/dark，文字在深色底上偏暗、
   對比不足；而使用者從這裡點進客戶端，兩邊的色系應該是同一套——
   換了頁面卻換了視覺語言，會讓人以為是不同的網站。 */
:root{
  --bg-0:#12100e; --bg-1:#1a1714; --bg-2:#241f1a;
  --line:#3a322a; --line-soft:#2a241f;
  --fg-0:#e8e0d4; --fg-1:#a89e90; --fg-2:#6e665c;
  --accent:#d9a441; --good:#6fbf5f; --warn:#d9a441; --bad:#c94f4f;
  color-scheme:dark;
}
body{
  font:15px/1.7 system-ui,"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;
  margin:0;padding:1.6rem 1.2rem;max-width:62rem;margin-inline:auto;
  background:var(--bg-0);color:var(--fg-0);
}
h1{font-size:1.4rem;margin:0 0 .35rem;color:var(--accent);letter-spacing:.02em}
p.lead{margin:.2rem 0 1.3rem;color:var(--fg-1);font-size:.93rem}
p.lead strong{color:var(--fg-0)}
table{width:100%;border-collapse:collapse;background:var(--bg-1);
  border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--line-soft)}
thead th{background:var(--bg-2);color:var(--fg-1);font-weight:600;
  font-size:.82rem;letter-spacing:.03em;border-bottom:1px solid var(--line)}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--bg-2)}
td.s{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.8rem;color:var(--fg-2)}
td.n{font-size:.82rem;color:var(--fg-1)}
td.og,th.og{font-size:.78rem;width:3.2rem}
.nat{color:var(--accent);border:1px solid var(--accent-soft,#7a5c26);border-radius:3px;padding:.05rem .3rem}
.cvt{color:var(--fg-2);border:1px solid var(--line);border-radius:3px;padding:.05rem .3rem}
td.no,th.no{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.8rem;
  color:var(--fg-2);width:3rem;text-align:right}
tr.dim{opacity:.55}
a{color:var(--accent);font-weight:600;text-decoration:none}
a:hover{text-decoration:underline}
.ok{color:var(--good)}.lim{color:var(--warn)}.no-b{color:var(--bad)}
/* 篩選列：214 台的表格需要搜尋，否則只能靠 Ctrl+F 一格一格找 */
.filters{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin:0 0 .8rem}
.filters input{flex:1 1 15rem;min-width:0;padding:.42rem .6rem;border-radius:6px;
  border:1px solid var(--line);background:var(--bg-1);color:var(--fg-0);font:inherit;font-size:.9rem}
.filters input:focus{outline:none;border-color:var(--accent)}
.chips{display:flex;flex-wrap:wrap;gap:.3rem}
.chip{padding:.32rem .62rem;border-radius:999px;border:1px solid var(--line);
  background:transparent;color:var(--fg-1);font:inherit;font-size:.82rem;cursor:pointer}
.chip:hover{border-color:var(--accent);color:var(--fg-0)}
.chip.on{background:var(--accent);border-color:var(--accent);color:var(--bg-0)}
.count{color:var(--fg-2);font-size:.82rem;white-space:nowrap}
.empty{color:var(--fg-2);font-size:.9rem;margin:1rem 0}
@media(max-width:680px){
  body{padding:1rem .7rem}
  td.s,th.s,td.n,th.n{display:none}
}
</style></head><body>
<h1>zjmud 收藏</h1>
<p class="lead">${catalogue.length} 台中文 MUD，其中 <strong>${playable}</strong> 台已驗證可在瀏覽器裡直接遊玩。
點名稱即進入該台，各台的帳號與角色資料分開儲存。<br>
<span class="nat">原生</span> ＝ 本專案原本就收的 zjmud mudlib（作者當年就是為 zjmud 客戶端寫的，未經改動）；
<span class="cvt">轉換</span> ＝ 上游 <a href="https://github.com/fluffos/mudlibs">fluffos/mudlibs</a> 的 telnet mudlib，
由 <code>mud2zjmud</code> 注入 zjmud 登入與面板後才會說這個協議。</p>
<div class="filters">
  <input id="q" type="search" placeholder="搜尋名稱、代號或說明…" autocomplete="off">
  <span class="chips">
    <button class="chip on" data-f="all">全部</button>
    <button class="chip" data-f="playable">可玩</button>
    <button class="chip" data-f="limited">受限</button>
    <button class="chip" data-f="noboot">開不了機</button>
    <button class="chip" data-f="native">原生</button>
    <button class="chip" data-f="converted">轉換</button>
  </span>
  <span id="count" class="count"></span>
</div>
<table><thead><tr><th class="no">#</th><th>MUD</th><th class="og">來源</th><th class="s">代號</th><th>狀態</th><th class="s">體積</th><th class="n">說明</th></tr></thead>
<tbody>
${rows}
</tbody></table>
<p id="empty" class="empty" hidden>沒有符合的 MUD。</p>
<script>
// 目錄篩選：214 台的表格太長，沒有搜尋就只能用瀏覽器的 Ctrl+F 一格一格找。
// 【WHY 純前端、無依賴】這是一個靜態頁，資料已經全部在 DOM 裡；
// 拉任何函式庫進來都只是為了做 indexOf。
(function () {
  var rows = [].slice.call(document.querySelectorAll('tbody tr'));
  var q = document.getElementById('q');
  var count = document.getElementById('count');
  var empty = document.getElementById('empty');
  var filter = 'all';

  function apply() {
    var t = (q.value || '').trim().toLowerCase();
    var n = 0;
    rows.forEach(function (r) {
      var okText = !t || (r.getAttribute('data-k') || '').indexOf(t) !== -1;
      var okTag = filter === 'all'
        || r.getAttribute('data-b') === filter
        || r.getAttribute('data-o') === filter;
      var show = okText && okTag;
      r.hidden = !show;
      if (show) n += 1;
    });
    // 顯示的是**實數**，不是「已篩選」這種永遠成立的字樣
    count.textContent = n + ' / ' + rows.length + ' 台';
    empty.hidden = n !== 0;
  }

  q.addEventListener('input', apply);
  [].slice.call(document.querySelectorAll('.chip')).forEach(function (b) {
    b.addEventListener('click', function () {
      [].slice.call(document.querySelectorAll('.chip')).forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      filter = b.getAttribute('data-f');
      apply();
    });
  });
  apply();
}());
</script>
</body></html>`;
    // 客戶端搬到 play.html，index.html 讓給目錄頁
    fs.copyFileSync(path.join(out, 'index.html'), path.join(out, 'play.html'));
    fs.writeFileSync(path.join(out, 'index.html'), html);
  }

  const total = catalogue.reduce((a, b) => a + b.sizeMB, 0);
  console.log(`\n完成：${catalogue.length} 個 mud，資料合計 ${total.toFixed(1)} MB`);
  console.log(`本機預覽：npx http-server ${path.relative(process.cwd(), out)} -p 8080`);
}

main().catch((e) => { console.error(e); process.exit(1); });
