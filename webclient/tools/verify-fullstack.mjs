#!/usr/bin/env node
// 全鏈路驗證：真 DOM ＋ 真 WASM driver ＋ 真 HTTP。
//
// 【WHY】其他測試各自只蓋住一段：jsdom 那條的 driver 是替身、node 那條沒有 DOM、
// HTTP 那條沒有前端。中間「使用者點一個 mud → 前端把真的 driver 跑起來 → 真的
// 連上 → 伺服器送出登入畫面」這條完整路徑沒有任何一條蓋到，而那正是使用者唯一
// 會走的路。第一次跑它就抓到一個只有走完整條路才會出現的 bug：
// 連線按鈕在啟動期間是 disabled，而 **disabled 的按鈕不會派發 click**，
// 於是 driver 起來了、backend 也選到 wasm，net 卻永遠停在 IDLE——
// 畫面上就是「載入完成卻沒有進遊戲」。
//
// 【推理】瀏覽器與 node 的差別只剩 `<script src>` 載入與 instantiateStreaming；
// WebAssembly 引擎、glue、映像、DOM 行為都可以是真的，所以這裡把能真的都真的。
// 剩下那一小段在 README 標成未驗，不假裝蓋到了。
//
// 【為什麼不是 node --test 的一條】driver 的 tick 與 emscripten runtime 會讓
// 測試框架的事件迴圈永遠不結束：測試會通過，程序卻不退出。所以它是一支
// 「跑完就 exit」的腳本，在 CI 裡當成獨立一步。
//
// 用法：node tools/verify-fullstack.mjs [site 目錄]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

import { createSiteServer } from './serve-site.mjs';
import { driverAvailable, DRIVER_DIR } from './wasm-node.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
// 位置參數要濾掉旗標，否則 `--mud <slug>` 會被當成 site 路徑
const positional = process.argv.slice(2).filter((a, i, all) =>
  !a.startsWith('--') && !(all[i - 1] === '--mud'));
const SITE = path.resolve(positional[0] || path.join(REPO, 'site'));
// 逐台掃描時每個子行程要各自佔一個埠，否則會撞埠（見 sweep-web.mjs）
const PORT = Number(process.env.ZJMUD_VERIFY_PORT) || 8199;
const DEADLINE_MS = 120000;

const require2 = createRequire(import.meta.url);

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

if (!driverAvailable()) fail(`找不到 driver（${DRIVER_DIR}）——先跑 node tools/fetch-driver.mjs`);
if (!fs.existsSync(path.join(SITE, 'libs', 'index.json'))) fail(`找不到建置產物（${SITE}）——先跑 node tools/build-site.mjs`);

const server = createSiteServer(SITE);
await new Promise((r) => server.listen(PORT, r));
const base = `http://127.0.0.1:${PORT}/`;

const cat = JSON.parse(fs.readFileSync(path.join(SITE, 'libs', 'index.json'), 'utf8'));
const candidates = cat.muds.filter((m) => m.badge !== 'noboot').sort((a, b) => a.sizeMB - b.sizeMB);
if (!candidates.length) fail('索引裡沒有任何可玩的 mud');

// --mud <slug> 指定要驗哪一台（給 sweep-web.mjs 逐台呼叫用）；
// 不指定就挑最小的那一台——單跑時測的是路徑，不是體積。
const wantSlug = (() => {
  const i = process.argv.indexOf('--mud');
  return i !== -1 ? process.argv[i + 1] : null;
})();
const skipSwitch = process.argv.includes('--no-switch');
const pick = wantSlug ? candidates.find((m) => m.slug === wantSlug) : candidates[0];
if (!pick) fail(`索引裡沒有可玩的 ${wantSlug}`);
console.log(`站台 ${SITE}\n選用 ${pick.slug}（${pick.sizeMB} MB，badge=${pick.badge}）`);

// ★ 客戶端頁面是 `play.html`，`index.html` 已讓給目錄頁。
//
// 【WHY】站台改成「一台一個連結」之後，index.html 是列出所有 mud 的
// 目錄頁，裡面沒有客戶端的 DOM。驗證若照舊讀 index.html，
// 會在一張純表格上找登入視窗與快捷列——**全部找不到，而失敗訊息會說
// 「進世界沒有內容」**，指向 mud 而不是指向「讀錯了檔案」。
// 【相容】舊站台沒有 play.html，退回 index.html，行為不變。
const CLIENT_PAGE = fs.existsSync(path.join(SITE, 'play.html')) ? 'play.html' : 'index.html';
const html = fs.readFileSync(path.join(SITE, CLIENT_PAGE), 'utf8');
const dom = new JSDOM(html, { url: base, runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
delete globalThis.__TAURI__;
delete globalThis.__ZJMUD_WASM__;

// 相對網址補成絕對（瀏覽器會自己做，node 的 fetch 不會）
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(new URL(String(u), base).href, o);

// driver glue 在瀏覽器是 <script src>；這裡直接提供同一個模組，
// 並把 .wasm 指到磁碟（node 的 fetch 不吃相對路徑）
const createFluffOS = require2(path.join(DRIVER_DIR, 'fluffos.js'));
globalThis.createFluffOS = (opts = {}) => createFluffOS({
  ...opts,
  locateFile: (f) => path.join(DRIVER_DIR, f),
});

await import(pathToFileURL(path.join(SITE, 'js', 'main.js')).href + '?t=' + Date.now());
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

// 等清單真的長出來，而不是睡固定的時間。
// 【WHY】原本是 `setTimeout(400)`：本機大多會過，但在剛跑完一輪測試、機器還忙著的
// 時候就會抓到空清單，報「應該列出 17 個 mud，實際 0」——那是**驗證器自己的競態**，
// 不是被驗證的東西壞了。這種假紅燈比沒有測試更糟：它會訓練人忽略失敗。
// 清單是 fetch libs/index.json 之後才渲染的，所以正確的等待條件是「清單非空」。
const LIST_DEADLINE_MS = 15000;
const t1 = Date.now();
let items = [];
while (Date.now() - t1 < LIST_DEADLINE_MS) {
  items = [...document.querySelectorAll('#mud-list .mud-item')];
  if (items.length) break;
  await new Promise((r) => setTimeout(r, 100));
}
if (items.length !== cat.muds.length) fail(`清單應該列出 ${cat.muds.length} 個 mud，實際 ${items.length}`);
if (document.getElementById('direct-fields')?.hidden !== true) fail('WASM 模式不該顯示位址／埠號欄位');
console.log(`✓ 連線面板列出 ${items.length} 個 mud`);

const target = items.find((el) => el.textContent.includes(pick.title)) ?? items[0];
target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
document.getElementById('connect-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

const t0 = Date.now();
let state = {};
while (Date.now() - t0 < DEADLINE_MS) {
  await new Promise((r) => setTimeout(r, 500));
  state = {
    wasm: !!globalThis.__ZJMUD_WASM__,
    net: globalThis.__zjmud?.net?.state,
    backend: globalThis.__zjmud?.net?.backend,
    panelHidden: document.getElementById('connect-panel')?.hidden,
    loginOpen: document.getElementById('login-modal')?.hidden === false,
    error: document.getElementById('connect-error')?.textContent,
  };
  // 「登入視窗開了」不是唯一的正確結果：有些伺服器送完挑戰就直接回
  // ESC000 0007（自動登入），客戶端會**開了又立刻關**，500ms 的輪詢根本看不到。
  // 所以通過條件是「客戶端對握手做出了反應」——開登入視窗、開建角視窗，
  // 或已經在世界裡，三者有一即可。
  state.charOpen = document.getElementById('char-modal')?.hidden === false;
  // 「已在世界」不能拿快捷槽位數當證據——17 個槽位（含空槽的＋）**永遠**渲染，
  // 那是套套邏輯（同一個坑在登入階段踩過一次）。改看有內容的槽或訊息量。
  state.inWorld = [...document.querySelectorAll('#quick-main .quick, #quick-bottom .quick')]
    .some((b) => !b.className.includes('quick-empty'))
    || (document.getElementById('msg-main')?.textContent || '').length > 800;
  if (state.wasm && state.net === 'OPEN'
      && (state.loginOpen || state.charOpen || state.inWorld)) break;
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`狀態（${elapsed}s）：${JSON.stringify(state)}`);

if (!state.wasm) fail('driver 沒有跑起來');
if (state.backend !== 'wasm') fail(`傳輸層應該選 wasm，實際 ${state.backend}`);
if (state.net !== 'OPEN') fail(`連線狀態應該是 OPEN，實際 ${state.net}（${state.error || '無錯誤訊息'}）`);
if (state.panelHidden !== true) fail('連上之後連線面板應該收起來');
if (!state.loginOpen && !state.charOpen && !state.inWorld) {
  // 失敗時把伺服器實際送來的東西印出來——「登入視窗沒開」有兩種完全不同的
  // 原因（沒收到挑戰 vs 收到了但沒被辨識），不看內容分不出來。
  const seen = (document.getElementById('msg-main')?.textContent || '').trim();
  console.error('主訊息區收到的內容（前 400 字）：' + JSON.stringify(seen.slice(0, 400)));
  fail('伺服器送出版本挑戰後，客戶端應該有反應（登入視窗／建角視窗／進世界）');
}

console.log('✓ 連線階段通過：選 mud → 真 driver 開機 → 連線 → 伺服器送出登入畫面');

// ── ② 真的登入進去，並確認 in-world 的 UI 有東西 ────────────────
//
// 【WHY】使用者回報「下方 GUI 選單都沒有出來」。原本這支驗證停在「登入視窗開了」
// 就宣告通過——而按鈕列是 ESC006／ESC008 帶來的，那要**進到世界裡**才會送。
// 也就是說整條 in-world 的 UI 從來沒有被瀏覽器路徑驗過（只有 node 版的
// boot-test 驗過，那邊沒有 DOM）。停在登入畫面的驗證會讓人以為全都好了。
const $ = (id) => document.getElementById(id);
const click = (id) => $(id)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const typeIn = (id, v) => {
  const el = $(id);
  if (!el) return;
  el.value = v;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};

// 帳密要通過**最嚴**的欄位規格：telnet 台（东方故事）只收純小寫字母帳號、
// 密碼 ≥5——'wasmweb01' 含數字會被前移驗證正確地擋在視窗裡（那不是 bug，
// 是把關生效），所以測試身分要選各台交集都合法的。
const ACCOUNT = 'wasmweb';
const PASSWORD = 'wasmpass';
// 登入前先量基準：之後「有內容」的判準是訊息區**真的長大**，
// 不是「元素存在」——快捷列的 10+7 個槽位是**永遠**渲染的（空槽顯示＋），
// 拿它當進世界的證據是套套邏輯。這個弱斷言曾讓「登入階段通過」半真半假。
const msgBase = ($('msg-main')?.textContent || '').length;
typeIn('login-id', ACCOUNT);
typeIn('login-pw', PASSWORD);
click('login-submit');

/** 等某個條件成立；逾時回 false，讓呼叫端決定要不要當成失敗。 */
async function waitUntil(fn, ms = 90000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// 新帳號會走到建角視窗；老帳號直接進世界。兩條路都要能走完。
if (await waitUntil(() => $('char-modal')?.hidden === false, 60000)) {
  // 兩個字：長度檢查的下限，也是使用者最常打的長度（見 boot-test.mjs 的長註解）
  typeIn('char-name', '無名');
  click('char-submit');
  console.log('  建角視窗已填寫並送出');
}

// 進世界的判準（三個都要）：
//   ① 兩個視窗都關了（登入流程真的走完，不是卡在半路）
//   ② 主訊息區比登入前**長了至少 200 字**（伺服器真的送了世界內容）
//   ③ 沒有連線錯誤
const inWorld = await waitUntil(() =>
  $('login-modal')?.hidden !== false
  && $('char-modal')?.hidden !== false
  && (($('msg-main')?.textContent || '').length - msgBase) > 200);
// ESC006（自訂按鈕）常在進世界後幾秒才到，等一下再快照，別搶拍
await new Promise((r) => setTimeout(r, 4000));
const filledSlots = [...($('quick-main')?.children ?? []), ...($('quick-bottom')?.children ?? [])]
  .filter((b) => !b.className.includes('quick-empty')).length;
const ui = {
  roomHeader: $('room-header')?.textContent?.trim().slice(0, 30) || '',
  roomDesc: ($('room-desc')?.textContent || '').trim().length,
  msgGrew: (($('msg-main')?.textContent || '').length - msgBase),
  quickSlots: ($('quick-main')?.children.length ?? 0) + ($('quick-bottom')?.children.length ?? 0),
  quickFilled: filledSlots,
  charOpen: $('char-modal')?.hidden === false,
  loginOpen: $('login-modal')?.hidden === false,
};
console.log(`in-world UI：${JSON.stringify(ui)}`);
if (!inWorld) fail(`登入後沒有進世界（視窗未關或訊息區沒有內容，只長了 ${ui.msgGrew} 字）`);
console.log('✓ 登入階段通過：帳號 → 建角 → 進世界，畫面上真的有東西');

// ZJMUD_DUMP=<路徑>：把 in-world 當下的完整 DOM 落成靜態 HTML。
// 【WHY】jsdom 驗邏輯不驗版面——「介面互相覆蓋、根本點不到」這類 CSS 疊層
// 問題它一律看不到。落出來的快照連著真的 CSS，用無頭瀏覽器在手機視口截圖，
// 版面問題就能在本機看見、修到乾淨才推，不再拿使用者的手機當測試機。
if (process.env.ZJMUD_DUMP) {
  // 飄浮字是 2.5 秒自毀的暫態元素——靜態快照裡動畫/計時器不存在，
  // 不清掉的話每張截圖都掛著殘影，掩蓋真正的版面問題
  document.querySelectorAll('.float-text').forEach((n) => n.remove());
  // ★ 插入 <base>：快照可能被寫到站台以外的地方（CI 寫 /tmp/snap.html），
  // 裡面的 `css/app.css` 就會解析成 /tmp/css/app.css → **CSS 整份載不到**。
  // 沒有 CSS 就沒有任何版面約束，元素全部照文流往下堆——CI 因此量到
  // 「送出鈕 top=1331，視口高 900」並判定被擠出視口，看起來像版面壞了，
  // 其實是快照不完整。加上絕對路徑的 base，快照放哪裡都能正確渲染。
  const base = `<base href="file://${SITE}/">`;
  const html = ('<!doctype html>\n' + document.documentElement.outerHTML)
    .replace(/<head([^>]*)>/i, `<head$1>${base}`);
  fs.writeFileSync(process.env.ZJMUD_DUMP, html);
  console.log('DOM 快照 → ' + process.env.ZJMUD_DUMP);
}

// ── ③ 換一台 mud ──────────────────────────────────────
//
// 【WHY】使用者回報：斷線後選另一台再進入，跑的還是第一台。真因是
// main.js 的守衛寫成「只要 __ZJMUD_WASM__ 不是 null 就不開機」，
// 於是第二次點下去只是對**舊 driver** 再撥一次號。畫面上會一直疊出
// 新的握手行，看起來像「換了但沒反應」。這一段就是那個回報的迴歸測試。
const other = skipSwitch ? null : candidates.find((m) => m.slug !== pick.slug);
if (skipSwitch) {
  console.log('（--no-switch，略過切換測試）');
} else if (!other) {
  console.log('（只有一個可玩的 mud，略過切換測試）');
} else {
  click('disconnect-btn');
  if (!await waitUntil(() => $('connect-panel')?.hidden === false, 20000)) {
    fail('按了斷線之後連線面板沒有回來');
  }
  const items2 = [...document.querySelectorAll('#mud-list .mud-item')];
  const target2 = items2.find((el) => el.textContent.includes(other.title));
  if (!target2) fail(`清單裡找不到 ${other.title}`);
  target2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  click('connect-btn');

  const switched = await waitUntil(() => globalThis.__ZJMUD_WASM__?.entry?.slug === other.slug
    && globalThis.__zjmud?.net?.state === 'OPEN');
  const running = globalThis.__ZJMUD_WASM__?.entry?.slug;
  console.log(`切換後正在跑的是：${running}（期望 ${other.slug}）`);
  if (!switched) fail(`切換 mud 失敗：跑的還是 ${running}`);
  console.log(`✓ 切換階段通過：${pick.slug} → ${other.slug}，舊 driver 已關閉`);
}

console.log('✓ 全鏈路通過');

globalThis.__ZJMUD_WASM__?.driver?.shutdown?.();
server.close();
dom.window.close();
process.exit(0);
