#!/usr/bin/env node
// 每一台 mud 都走一次**真正的網頁路徑**：選單 → 開機 → 連線 → 登入 → 建角 →
// 進世界，而且要真的看得到選單與內容。
//
// 【WHY】使用者的要求就是這一句：「請你每個都實際 web 測試，都要有選單和內容」。
// 在這之前，走完整條網頁路徑的驗證**只跑一台**（挑最小的那個），其餘 16 台只被
// node 端的 boot-test 驗過——那邊沒有 DOM，看不到「按鈕列是空的」這種症狀。
// 於是「17 台都 playable」這句話，其實只有一台被真的用瀏覽器的方式證明過。
//
// 【推理】既然要每一台都驗，就不能共用同一個 jsdom：模組層級的狀態（driver、
// store、login stage）會跨測試污染，一台的殘留會讓下一台的結論不可信。
// 所以每一台**開一個子行程**跑 verify-fullstack.mjs --mud <slug> --no-switch，
// 隔離由行程邊界保證——這比在同一個行程裡小心翼翼地重置可靠得多。
// （切換測試只需要跑一次，所以這裡用 --no-switch 關掉，由 verify-fullstack
// 自己那一趟負責。）
//
// 【判準】通過的定義是子行程 exit 0，而它內部斷言的是：
//   ① 連線面板列出全部的 mud（選單有東西）
//   ② 連上後面板收起、伺服器送出登入畫面
//   ③ 登入 → 建角 → 進世界之後，畫面上真的有東西
//      （房間標題／快捷按鈕至少一個非空 ← 這就是「有內容」）
//
// 用法：node tools/sweep-web.mjs [site 目錄] [--only <slug>]

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// ★ 旗標的**值**不算 positional。
//
// 【WHY】原本只濾掉 `--xxx` 本身，於是 `sweep-web.mjs --only huoying` 裡的
// `huoying` 被當成第一個 positional，也就是**站台路徑**——
// 程式跑去找 `webclient/huoying/libs/index.json`，報「找不到建置產物」。
// 而如果站台路徑剛好給對了，它又會匹配到 0 台，配上舊的結尾判斷
// 就印出「0 台，全部通過」——**錯誤的參數解析製造出假綠燈**。
// 【判準】帶值的旗標要先登記，解析時把它的值一起吃掉。
// 【WHY --limit 也要登記】上一輪加了 `--limit` 卻忘了把它列進來，
// 於是 `sweep-web.mjs --limit 12` 的 `12` 被當成第一個 positional
// ——也就是**站台路徑**，程式跑去找 `webclient/12/libs/index.json`。
// 這與當初 `--only` 踩過的坑一模一樣（見下面的說明），
// 而我加新旗標時沒回頭看那條註解。
// **帶值的旗標一律要登記**，這張表就是唯一的真相來源。
const VALUE_FLAGS = new Set(['--only', '--timeout', '--concurrency', '--limit']);
const positional = [];
{
  const av = process.argv.slice(2);
  for (let i = 0; i < av.length; i += 1) {
    if (VALUE_FLAGS.has(av[i])) { i += 1; continue; }
    if (av[i].startsWith('--')) continue;
    positional.push(av[i]);
  }
}
const SITE = path.resolve(positional[0] || path.join(REPO, 'site'));
const only = arg('only');

const indexPath = path.join(SITE, 'libs', 'index.json');
if (!fs.existsSync(indexPath)) {
  console.error(`找不到建置產物（${indexPath}）——先跑 node tools/build-site.mjs`);
  process.exit(2);
}
const cat = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
// 只掃 playable：limited 台（登入本來就走不完）拿「進世界有內容」的斷言
// 去驗必然紅，紅了又不代表退化——那是把已知狀態當新聞報。
let targets = cat.muds
  .filter((m) => m.badge === 'playable')
  // 【WHY 支援逗號清單】原本只比對單一 slug，傳 `--only a,b,c` 會一台都不中，
  // 而舊的結尾判斷把「0 台」印成「全部通過」——參數用法的小落差
  // 直接變成假綠燈。抽驗幾台是最常見的用法，不該只能一次一台。
  .filter((m) => !only || only.split(',').map((x) => x.trim()).includes(m.slug));

// ★ `--limit N`：只抽驗 N 台（平均取樣）。
//
// 【WHY】這一關**每台開一個瀏覽器子行程**，載入映像、走完整登入、進世界。
// 收藏從 17 台長到 109 台之後，CI 必然逾時——而**沒有任何一台真的壞掉**
// （本機全量跑過 109/109 通過）。閘門成本隨收藏規模等比成長，
// 這是規模問題不是正確性問題（CLAUDE.md §15 的同一條）。
// 【WHY 平均取樣】取前 N 個會集中在字母序開頭的同一批家族，
// 而這一關要抓的是「客戶端與映像的搭配」——每個家族都要有代表。
// 【WHY 不預設開啟】本機要能跑完整版，CI 才傳 --limit。
const webLimit = Number(arg('limit', '0'));
if (webLimit > 0 && targets.length > webLimit) {
  const all = targets.length;
  const step = all / webLimit;
  targets = Array.from({ length: webLimit }, (_, i) => targets[Math.floor(i * step)]);
  console.log(`（抽驗 ${webLimit}/${all} 台，平均取樣）`);
}

// 每一台各自佔一個埠：子行程各自起一台靜態伺服器，撞埠會讓後面的整批失敗。
const BASE_PORT = 8300;

/** 跑一台，回傳 { ok, tail }。 */
function runOne(slug, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(HERE, 'verify-fullstack.mjs'), SITE, '--mud', slug, '--no-switch',
    ], { env: { ...process.env, ZJMUD_VERIFY_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      const lines = out.trim().split('\n');
      resolve({ ok: code === 0, tail: lines.slice(-3).join(' | '), out });
    });
  });
}

console.log(`站台 ${SITE}\n逐台驗證 ${targets.length} 個 mud（每台一個子行程）\n`);
const failures = [];
let i = 0;
for (const m of targets) {
  i += 1;
  const port = BASE_PORT + i;
  process.stdout.write(`[${String(i).padStart(2)}/${targets.length}] ${m.slug.padEnd(20)} `);
  const r = await runOne(m.slug, port);
  if (r.ok) {
    // 從輸出裡把 in-world 的實測數字撈出來，讓「有內容」是看得見的數字
    const ui = r.out.match(/in-world UI：(\{[^}]*\})/);
    console.log(`✓ ${ui ? ui[1] : ''}`);
  } else {
    console.log('✗');
    console.log(`      ${r.tail}`);
    failures.push(m.slug);
  }
}

// ★ 一台都沒跑到＝**失敗**，不是通過。
//
// 【WHY】原本的結尾一律印「全部通過」，即使 targets 是空的——
// 實測 `--only huoying,...` 因為參數被當成站台路徑而匹配到 0 台，
// 畫面照樣印出「0 台，全部通過（選單有清單、進世界有內容）」。
// 那是 CLAUDE.md §5 明文禁止的**套套邏輯斷言**：條件永遠成立，
// 所以永遠不會抓到任何東西。這種綠燈比紅燈危險。
// 【判準】驗證要能證明「某些台真的被驗過」，數量本身就是實數證據。
if (!targets.length) {
  console.error('\n✗ 沒有任何 mud 被驗證——過濾條件沒有命中，或站台索引是空的。'
    + '\n  這不是通過：請檢查 --only 的值與站台路徑（用法：sweep-web.mjs <站台> --only a,b）。');
  process.exit(2);
}
console.log(`\n${targets.length} 台，${failures.length ? `**${failures.length} 台失敗**：${failures.join(' ')}` : '全部通過（選單有清單、進世界有內容）'}`);
process.exit(failures.length ? 1 : 0);
