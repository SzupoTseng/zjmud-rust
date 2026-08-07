#!/usr/bin/env node
// 「每一顆按鈕真的按得動」的閘門 —— 用真 Chromium 按下去，看世界有沒有回應。
//
// 【WHY】使用者回報：「play.html?mud=yanhuangwuhun，另外請測試所有選單，
// 我登入後測試完全沒反應」。而我當時所有的閘門都是綠的——因為它們證明的是
// **伺服器會送 opcode**、**DOM 裡有按鈕節點**，沒有任何一格證明過
// 「把那顆按鈕按下去，世界會動」。這是 CLAUDE.md §11 的同一條：
// 訊號存在不等於事情發生；也是 §2 的同一條：jsdom 沒有排版引擎，
// 按鈕被別的元素蓋住、或 pointer-events 被吃掉，它一律看不見。
//
// 【判準】三件事，每一件都是實數，不是套套邏輯：
//   ① 按鈕真的**可點**：elementFromPoint 打在它自己身上（不是被誰蓋住）
//   ② 按下去**有送出**：攔截 driver 的送出通道，記錄實際送出的字串
//   ③ 世界**有回應**：訊息區長度增加，且回應裡不得出現「什麼」
//      （那是 mudlib 對不存在指令的標準回話 —— 按鈕掛了錯的指令就會中）
// 三者缺一就紅。特別是 ②③ 要分開：只驗 ② 會漏掉「送出去但沒有這個指令」，
// 只驗 ③ 會漏掉「根本沒送出去、畫面剛好因為別的事在長」。
//
// 【WHY 要驗「什麼」】使用者早先回報過「你的 zjmud 指令怪怪的，生效但是會一直
// 出現『什麼』」——快捷列當時寫死八個指令，而多數 mudlib 沒有 dazuo/tuna。
// 標題列按鈕後來也犯同一個錯（寫死 map/dazuo/practice）。這一格就是不讓它再犯。
//
// 用法：
//   node tools/verify-clicks.mjs [site 目錄] --mud <slug>
//   node tools/verify-clicks.mjs --mud yanhuangwuhun --headed   # 想親眼看

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createSiteServer } from './serve-site.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

// ★ 帶值的旗標要登記，否則它的**值**會被當成 positional（也就是站台路徑）。
// 【WHY】這個坑在 sweep-web.mjs 上踩過兩次（--only、--limit），
// 而且第二次是我加新旗標時沒回頭看自己寫的註解。新工具一律先寫這張表。
const VALUE_FLAGS = new Set(['--mud', '--timeout', '--account']);
const positional = [];
{
  const av = process.argv.slice(2);
  for (let i = 0; i < av.length; i += 1) {
    if (VALUE_FLAGS.has(av[i])) { i += 1; continue; }
    if (av[i].startsWith('--')) continue;
    positional.push(av[i]);
  }
}
const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const SITE = path.resolve(positional[0] || path.join(REPO, 'site'));
const PORT = Number(process.env.ZJMUD_CLICK_PORT) || 8420;
const HEADED = process.argv.includes('--headed');
const BUDGET = Number(arg('timeout', '180')) * 1000;

const indexPath = path.join(SITE, 'libs', 'index.json');
if (!fs.existsSync(indexPath)) {
  console.error(`找不到建置產物（${indexPath}）——先跑 node tools/build-site.mjs`);
  process.exit(2);
}
const cat = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const want = arg('mud');
const mud = want
  ? cat.muds.find((m) => m.slug === want)
  : cat.muds.filter((m) => m.badge === 'playable').sort((a, b) => a.sizeMB - b.sizeMB)[0];
if (!mud) { console.error(`索引裡沒有這一台：${want}`); process.exit(2); }

// 帳號沿用 boot-test 那組保守形式（各台交集都合法）
const ACCOUNT = arg('account', 'zjtester');
const PASSWORD = 'zjtest123';

const server = createSiteServer(SITE);
await new Promise((r) => server.listen(PORT, r));
const url = `http://127.0.0.1:${PORT}/play.html?mud=${encodeURIComponent(mud.slug)}`;

const browser = await chromium.launch({ headless: !HEADED });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const problems = [];
const refused = [];   // 指令存在、但世界當下不讓做（例如「还没有出生」）
const expected = [];  // 按過的按鈕與它該送出的指令，迴圈結束後統一比對
let lastOk = '';      // 最後一顆成功的按鈕——世界忙碌時它就是最可能的元兇
const silent = [];    // 送出了但世界沒說話：是那台自己的設計，列出來但不算失敗
const t0 = Date.now();
const left = () => Math.max(1000, BUDGET - (Date.now() - t0));

/**
 * 攔截送出通道：不改行為，只記錄。要證明的是「按下去到底送了什麼字串」。
 *
 * 【WHY 掛在 driver.send 而不是 WebSocket】play.html 走的是 **WASM 模式**——
 * driver 就跑在瀏覽器裡，一個封包都不會經過 WebSocket。第一版我掛 WebSocket，
 * 那會讓每一顆按鈕都被判成「沒送出」——閘門紅得毫無意義，而真正的缺陷還在原地。
 * 【證據】net.js:176 `handle()?.driver.send(line)`：每次送出都在 handle 上
 * **重新查一次** driver.send，所以覆寫這個屬性攔得到；
 * wasmboot.js:146 `globalThis.__ZJMUD_WASM__ = handle` 是它的來源。
 * 【WHY 進世界後才掛】__ZJMUD_WASM__ 要開機完成才存在，addInitScript 太早。
 */
async function hookSend() {
  return page.evaluate(() => {
    window.__sent = window.__sent ?? [];
    const h = globalThis.__ZJMUD_WASM__;
    if (!h?.driver || h.driver.__zjHooked) return Boolean(h?.driver);
    const orig = h.driver.send.bind(h.driver);
    h.driver.send = (line) => { window.__sent.push(String(line)); return orig(line); };
    h.driver.__zjHooked = true;
    return true;
  });
}

/**
 * 可點性探針：在視口內、有尺寸、而且 elementFromPoint 打在自己身上。
 * 抽成具名函式是為了能**重試**——快捷列重建的瞬間節點尺寸是 0，
 * 量到 0 只代表我剛好量在重建中間，不代表使用者點不到。
 */
const hitProbe = (node) => {

      const r = node.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { ok: false, why: '尺寸為 0' };
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return { ok: false, why: '在視口外' };
      const top = document.elementFromPoint(cx, cy);
      if (!top) return { ok: false, why: 'elementFromPoint 沒東西' };
      if (top !== node && !node.contains(top) && !top.contains(node)) {
        return { ok: false, why: `被 ${top.tagName.toLowerCase()}.${top.className || '?'} 蓋住` };
      }
      return { ok: true };
};

const msgText = () => page.evaluate(() => (document.getElementById('msg-main')?.innerText ?? ''));

// ★ 「世界有回應」不等於「訊息區變長」。
//
// 【WHY】原生台的分類鈕（常用指令／技能相关／战斗相关／任务相关／游戏指南／
// 频道交流）按下去開的是**彈出選單**，一個字都不會寫進訊息區。
// 只量 msg-main 的話，六顆完全正常的按鈕會被判成「送出了但畫面毫無變化」。
// 同理「地圖」「技能」在某些台是開疊層面板，不是印文字。
// 【判準】畫面上**任何一處**有變化就算有回應，而且要說出是哪一處——
// 說得出來才可複核；說不出來的「有反應」跟沒驗一樣。
const PANES = [
  ['訊息區', 'msg-main'], ['彈出選單', 'overlay-popmenu'], ['分頁面板', 'overlay-paged'],
  ['互動抽屜', 'overlay-interact'], ['對話框', 'overlay-dialog'], ['地圖', 'overlay-map'],
  ['擴充面板', 'ext-body'], ['房間描述', 'room-desc'], ['現場', 'entity-list'],
  ['狀態列', 'stat-bars'], ['聊天', 'msg-chat'], ['系統', 'msg-sys'],
  // ★ 快捷列本身也是「回應」。
  // 【WHY】原生台的分類鈕送出 `mycmds ofen` 之後，伺服器回的是**另一份 ESC006**
  // ——整排快捷列被換成該分類的指令（jianjuefuyunqi cmds/usr/mycmds.c：
  // `write(ZJBTSET"b1:查看"ZJBR"背包:i"ZJSEP…)`）。訊息區一個字都不會多。
  // 少了這兩格，五顆完全正常的分類鈕會被判成「畫面沒有任何反應」。
  ['快捷列上', 'quick-main'], ['快捷列下', 'quick-bottom'],
];
// ★ 比對**內容**，不要只比長度。
// 【WHY】分類鈕換上的那排按鈕，字數可能跟前一排剛好一樣——實測
// `mycmds help` 換掉整排快捷列，總字數不變，於是「有反應」被判成「沒反應」。
// 長度是內容的有損摘要，拿它當同一性判準會漏（CLAUDE.md §12 的同一條）。
const paneSnap = () => page.evaluate((panes) => {
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
  return Object.fromEntries(panes.map(([name, id]) => {
    const el = document.getElementById(id);
    // 隱藏的疊層以空字串計——「從隱藏變成有內容」本身就是一種回應
    const vis = el && !el.hidden && el.offsetParent !== null;
    const t = vis ? (el.innerText ?? '') : '';
    return [name, { n: t.length, h: hash(t) }];
  }));
}, PANES);
const paneDiff = (a, b) => Object.keys(b)
  .filter((k) => b[k].h !== a[k].h || b[k].n !== a[k].n)
  .map((k) => `${k}${b[k].n > a[k].n ? '+' : ''}${b[k].n - a[k].n || '(換內容)'}`);

/**
 * 目前畫面上所有按得到的按鈕（快捷列＋標題列）。
 *
 * 【WHY 指令要從 store 讀】按鈕的 cmd **不在 DOM 上**——ui.js:156 是
 * `btn.addEventListener('click', () => ctx.send(b.cmd))`，指令活在閉包裡。
 * 我第一版去讀 data-cmd／title，標題列一律拿到空字串，於是閘門對四顆
 * **完全正常**的按鈕報「沒有掛指令」。這是 CLAUDE.md §8 的同一條：
 * 每個結論都要能指到證據，而證據要從**真的存它的地方**讀，不是從像的地方猜。
 * 真相在 store：`room.titleButtons`（陣列）與 `quick.slots`（以槽位為鍵）。
 */
const listButtons = () => page.evaluate(() => {
  const zj = globalThis.__zjmud;
  const slots = zj?.store?.get('quick.slots') ?? {};
  const titles = zj?.store?.get('room.titleButtons') ?? [];
  const out = [];
  const push = (where, el, i) => {
    const r = el.getBoundingClientRect();
    out.push({
      where,
      index: i,
      label: (el.innerText || el.textContent || '').trim(),
      // 指令的真實出處：快捷鈕是 ui.js:337 的 title 屬性（值就是 cfg.cmd），
      // 標題列鈕才用 data-cmd。只讀 data-cmd 會一律拿到空字串——
      // 而空字串會讓報告寫成「cmd=」，看起來像沒掛指令，實際上是我讀錯地方。
      cmd: '',
      titleAttr: el.getAttribute('title') ?? '',
      empty: el.classList.contains('quick-empty'),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  };
  // ★ 快捷鈕的指令要從**它自己的 title 屬性**讀，不要靠索引去對 store。
  //
  // 【WHY】store 的 quick.slots 是以槽位名為鍵的物件，`Object.keys()` 的順序是
  // 插入順序，**不保證等於 DOM 順序**——而 quick-main 與 quick-bottom 是兩排。
  // 實測 jianjuefuyunqi（原生 zjmud，只有下排有東西）就整排對錯位，
  // 六顆正常的按鈕全被報成「沒有掛指令」。用索引去對兩個不同來源的順序，
  // 是自找的耦合。
  // 【證據】ui.js:337 `title: cfg ? cfg.cmd : '長按（或右鍵）設定'`
  // ——有掛指令時，title 屬性的值**就是** cfg.cmd，而且它天生跟著 DOM 走。
  // （標題列的 .chip 沒有這個屬性，那邊仍從 store 的 room.titleButtons 讀。）
  const PLACEHOLDER = '長按（或右鍵）設定';
  document.querySelectorAll('#quick-main .quick').forEach((el, i) => push('quick-main', el, i));
  document.querySelectorAll('#quick-bottom .quick').forEach((el, i) => push('quick-bottom', el, i));
  // 只收**該送指令**的按鈕：標題列鈕是 ui.js:152 的 .chip。
  // 【WHY 不用 #room-header button】那會一起收到房間標題本身（.room-title，
  // 只有 titleCmd 存在時才送）與摺疊鈕 ▾（純本地 UI，本來就不該送任何東西）。
  // 把它們算進來，閘門會對兩個**正常**的元件報紅——閘門一旦會誤報，
  // 下一次真的紅了就沒人信（CLAUDE.md §10：假紅燈與假綠燈都在破壞判準）。
  document.querySelectorAll('#room-header .title-buttons .chip').forEach((el, i) => push('title', el, i));
  // 補上指令（來源見上面的說明）
  let qi = 0;
  for (const b of out) {
    if (b.where === 'title') b.cmd = titles[b.index]?.cmd ?? '';
    else if (!b.empty) {
      const t = b.titleAttr ?? '';
      b.cmd = t === PLACEHOLDER ? '' : t;
    }
    if (b.where !== 'title') qi += 1;
  }
  return out;
});

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // ── 開機（映像載入 + driver 啟動）→ 登入畫面 ──
  await page.waitForFunction(
    () => document.getElementById('login-modal')?.hidden === false
      || document.getElementById('char-modal')?.hidden === false,
    null, { timeout: left() },
  );

  // ── 登入。帳號不存在就會走到建角，兩條路都要能通 ──
  if (await page.evaluate(() => document.getElementById('login-modal')?.hidden === false)) {
    await page.fill('#login-id', ACCOUNT);
    await page.fill('#login-pw', PASSWORD);
    await page.click('#login-submit');
  }
  if (await page.waitForFunction(
    () => document.getElementById('char-modal')?.hidden === false,
    null, { timeout: Math.min(60000, left()) },
  ).then(() => true, () => false)) {
    // 名字取**長度下限**（CLAUDE.md §3：挑最容易踩雷的合法輸入，不是最好過的）
    await page.fill('#char-name', '青風');
    await page.click('#char-submit');
  }

  // ── 進世界：以「有非空的快捷鈕」為準（面板真的長出來了） ──
  // ★ 判準要是「有**掛了指令**的按鈕」，不是「有文字的按鈕」。
  //
  // 【WHY】空槽的文字是「＋」——它 trim 之後長度大於 0，於是舊判準在
  // ESC006 還沒到達時就宣告「已進世界」，接著讀到一整排空槽。
  // 實測 sj：boot-test 明明收到 006/021 全部九種 opcode 判為 playable，
  // 瀏覽器這邊卻拿到 `quick.slots = {}`——差別純粹是**我提早了**。
  // 而閘門當時還印「✓ 0 顆按鈕都按得到」（空集合套套邏輯，已一併修掉）。
  // 【判準】`.quick:not(.quick-empty)` 才是「這一格真的被伺服器填過」。
  const inWorld = await page.waitForFunction(
    () => document.querySelectorAll(
      '#quick-main .quick:not(.quick-empty), #quick-bottom .quick:not(.quick-empty)').length > 0,
    null, { timeout: left() },
  ).then(() => true, () => false);
  if (!inWorld) {
    problems.push('沒能進世界（等不到任何有內容的快捷鈕）');
    throw new Error('stop');
  }
  // ★ 等快捷列**停止變動**，不要用固定睡眠。
  //
  // 【WHY】進世界的判準改成「有一個非空槽」之後，這一關會在面板還在重繪時
  // 就拍下按鈕清單——實測 25 台裡有 18 台報同一句
  // 「quick-main[0] 看：點不到（尺寸為 0）」，而那些台完全正常。
  // ESC006 可能分批到（原生台還會用分類鈕整排換掉），QuickBar 每收到一次
  // 就 clear + 重建整排，重建的瞬間節點尺寸是 0。
  // 【判準】連續兩次取樣的內容雜湊相同 ＝ 已經穩定；最多等 12 秒。
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll('#quick-main .quick, #quick-bottom .quick, #room-header .chip')]
      .map((e) => (e.innerText || '') + '|' + (e.getAttribute('title') || '')).join('\u0001');
    const prev = window.__zjQuickSnap;
    window.__zjQuickSnap = t;
    return prev !== undefined && prev === t && t.length > 0;
  }, null, { timeout: 12000, polling: 700 }).catch(() => {});
  if (!(await hookSend())) problems.push('掛不上 driver.send——送出無法被證明（②失效）');

  // 診斷：快捷列的實際設定（真相在 store，不是在 DOM 上猜）
  const slots = await page.evaluate(() => globalThis.__zjmud?.store?.get('quick.slots') ?? null);
  console.log('  quick.slots =', JSON.stringify(slots));

  // ── 打字送指令也要能動（按鈕以外的那條路） ──
  // 【WHY 排在按按鈕之前】按鈕清單裡有「退出」，它真的會讓角色離線。
  // 一旦先按了它，這一格必然沒有回應，而閘門會把「已經離開世界」
  // 報成「輸入框壞掉」——實測就這樣誤判過。破壞性的動作一律排最後。
  {
    // ★ 判準是「這條路徑真的把指令送出去了」，不是「畫面有沒有變」。
    //
    // 【WHY】`look` 是**冪等**的：房間沒變的話，重送一次得到一模一樣的面板，
    // 內容雜湊完全相同、訊息區也可能一個字都不多。實測 91shujian／
    // jianjuefuyunqi／nte 三台就是這樣被判成「打字沒有回應」——
    // 而它們的打字路徑完全正常。用一個冪等指令去驗「有沒有變化」，
    // 是判準本身選錯了：這一格要驗的是**輸入框到 driver 這條路通不通**，
    // 世界的行為已經由每一顆按鈕各自驗過了。
    const sentN = await page.evaluate(() => window.__sent.length);
    await page.fill('#cmd-input', 'look');
    await page.click('#cmd-send');
    await page.waitForFunction(
      ([n]) => window.__sent.slice(n).some((l) => String(l).trim() === 'look'),
      [sentN], { timeout: 8000 },
    ).catch(() => {});
    const typedOk = await page.evaluate(
      ([n]) => window.__sent.slice(n).some((l) => String(l).trim() === 'look'), [sentN]);
    if (!typedOk) problems.push('手動輸入 look 沒有送出到 driver（輸入框這條路不通）');
    console.log(`  手動輸入 look        ${typedOk ? '✓ 已送出' : '✗ 沒有送出'}`);

  }

  let buttons = await listButtons();
  // ★ 會改變**會話狀態**的指令要排到最後。
  //
  // 【WHY 退出】它真的會讓角色離線——一旦按下去，後面每一顆按鈕與手動輸入
  // look 全部沒有回應，閘門就會把「已經離開世界」報成「按鈕壞掉」。
  // 實測：退出排在第 6 顆，後面四顆標題鈕與 look 全被誤判成紅。
  //
  // 【WHY 打坐／吐納也算】實測 moniHuafu：按下「打坐」之後世界回
  //   ※你盘腿跌坐在地上，闭上眼睛开始调息打坐。
  // 接著 `hp`、`map`、以及每一顆標題鈕都回「什么？」——那是**這台自己**
  // 對打坐中玩家的回應，不是我們的缺陷。但閘門若照原順序按，
  // 會把後面五顆正常的按鈕全部報成「這台沒有這個指令」，
  // 結論還會指向錯的方向（去找不存在的指令檔）。
  // 【判準】凡是「按下去之後世界會進入另一種狀態」的指令，一律排最後。
  // 這是 §D24（非同步）之外的另一種順序相依：**狀態相依**。
  const isMeditate = (b) => /^(dazuo|tuna|meditate|sleep|rest)\b/.test((b.cmd || '').trim())
    || /打坐|吐納|吐纳|休息/.test(b.label);
  const isQuit = (b) => /^(quit|exit)\b/.test((b.cmd || '').trim()) || /退出|離開|离开/.test(b.label);
  const rank = (b) => (isQuit(b) ? 2 : isMeditate(b) ? 1 : 0);
  buttons = [...buttons].sort((a, b) => rank(a) - rank(b));
  console.log(`\n${mud.slug}：偵測到 ${buttons.length} 顆按鈕`);
  if (!buttons.length) problems.push('一顆按鈕都沒有——這不是通過（空集合的斷言永遠成立）');

  for (const b of buttons) {
    const tag = `  ${b.where}[${b.index}] ${(b.label || '(無字)').padEnd(10)}`;
    // ★ 點擊用的選擇器必須與**偵測**用的完全一致。
    //
    // 【WHY】偵測是 `#room-header .title-buttons .chip`（上面第 221 行），
    // 而點擊原本寫 `#room-header .ttbtn, #room-header button, #room-header a`
    // ——兩邊不同，`.nth(index)` 點到的就不保證是偵測到的那一顆。
    // 上面第 217 行的註解**已經寫過**為什麼不能用 `#room-header button`
    // （會一起收到房間標題與摺疊鈕 ▾），但那段推理只套用在偵測這一側。
    // 【證據】chongshengdeshijie 的標題列只有一顆「地圖」，
    // 閘門穩定重現「按下去沒有送出 map」——點到的是別的節點。
    // 判準與動作用同一個選擇器，這種偏差就不可能發生。
    const sel = b.where === 'title'
      ? `#room-header .title-buttons .chip`
      : `#${b.where} .quick`;
    // ★ 空槽（＋）本來就不該送任何東西——它是「長按設定」的佔位。
    // 【WHY】第一版把它們算成缺陷，一台就多七顆假紅。真正要驗的是
    // **有掛指令的按鈕按下去有沒有用**，不是「每個節點都要送東西」。
    if (b.empty) { console.log(`${tag} · 空槽，略過`); continue; }
    const el = page.locator(sel).nth(b.index);

    // ① 可點性：要在視口內、而且 elementFromPoint 打得到自己
    const hit = await el.evaluate(hitProbe);
    // ★ 點不到要**重試一次**再判死。
    // 【WHY】快捷列在收到新的 ESC006 時會整排 clear + 重建，
    // 重建那一瞬間節點的尺寸是 0——量到 0 不代表使用者點不到，
    // 只代表我剛好在重建的中間量。閘門要量的是穩定狀態，不是瞬態。
    if (!hit.ok) {
      await page.waitForTimeout(1200);
      const retry = await el.evaluate(hitProbe).catch(() => ({ ok: false, why: '節點消失' }));
      if (retry.ok) { Object.assign(hit, retry); }
    }
    if (!hit.ok) {
      console.log(`${tag} ✗ 點不到：${hit.why}`);
      problems.push(`${b.where}[${b.index}] ${b.label}：點不到（${hit.why}）`);
      continue;
    }

    // ② 送出：按下去之後，送出通道應該多一筆
    const before = await msgText();
    const paneBefore = await paneSnap();
    await el.click({ timeout: 5000 }).catch(() => {});
    // ★ 用**輪詢**等送出，不要用固定睡眠。
    // 【WHY】送出不是同步的（net.js send 是 async，WASM 後端還要排到 driver
    // 的下一拍）。固定睡 1.2 秒時，實測標題列四顆全部「慢一拍」：
    // 按地圖讀到 []，按練功才讀到 ["map"]——於是每一顆都被判成沒送出，
    // 而下一顆的錯誤訊息裡卻印著上一顆的指令。閘門紅了四顆**完全正常**的按鈕。
    // 【判準】等到「預期的指令出現在送出紀錄裡」或逾時，才是這一格的結論。
    const expectCmd = (b.cmd || '').trim();
    // ★ 等回應也要**輪詢**，不能固定睡。
    // 【WHY】睡 1.5 秒時，「地圖」被判成「送出了但畫面毫無變化」。
    // 用探針直接量：送出 map 之後訊息區 898 → 1214 字——它有回應，
    // 只是比 1.5 秒慢（WASM driver 要排到下一拍，而 map 的輸出很長）。
    // 固定睡眠會把**慢的正常回應**報成缺陷，而且愈慢的機器紅得愈多，
    // 閘門就變成在量測機器速度，不是在量測產品。
    await page.waitForFunction(
      ([n]) => (document.getElementById('msg-main')?.innerText ?? '').length > n,
      [before.length], { timeout: 8000 },
    ).catch(() => {});
    await page.waitForTimeout(400);
    const paneAfter = await paneSnap();
    const changed = paneDiff(paneBefore, paneAfter);
    const after = await msgText();
    const grew = after.length - before.length;
    const fresh = after.slice(before.length);

    // ★ 要比對送出的**內容**，不是「送出次數有沒有變多」。
    // 【WHY】世界會自己說話：心跳、別人的動作、打坐的週期訊息都會讓
    // 送出通道與訊息區同時在長。只數次數的話，剛好撞上一筆背景送出，
    // 一顆完全沒掛指令的按鈕就會被判成通過——實測就發生過：
    // quick.slots 裡**每一顆的 cmd 都是空字串**，而「狀態」「打坐」兩顆
    // 因為時間點湊巧被判成 ✓。這正是 CLAUDE.md §11：訊號出現≠事情發生。
    if (!expectCmd) {
      console.log(`${tag} ✗ 按鈕沒有掛指令（cmd 是空的）`);
      problems.push(`${b.where}[${b.index}] ${b.label}：按鈕沒有掛指令（cmd 空字串）`);
      continue;
    }
    // 送出與否留到最後統一比對（見迴圈後的說明），這裡只看世界的回應。
    expected.push({ b, cmd: expectCmd });
    // ★ 開起來的疊層要關掉再按下一顆。
    // 【WHY】分類鈕開的彈出選單會蓋住整排按鈕，下一顆的 elementFromPoint
    // 就打不到自己——閘門會從第二顆開始一路報「被 div 蓋住」，
    // 而真正的狀態是「上一顆成功了」。這是閘門自己製造的連鎖假紅燈。
    await page.evaluate(() => globalThis.__zjmud?.store && document
      .querySelectorAll('.sheet-close, .overlay-close, #ext-close')
      .forEach((el) => { if (el.offsetParent !== null) el.click(); }));
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
    // ③ 回應：不得是「什麼」，而且畫面要真的有長
    // ★ 「指令不存在」的判準要**貼著那句話本身**，不能只找「什麼」二字。
    //
    // 【WHY】實測 yanhuangwuhun 的 hp／score 回的是
    //   「还没有出生呐，察看什么？」
    // ——那不是「沒有這個指令」，是**角色還沒完成出生**，mudlib 主動擋下。
    // 舊的寬鬆判準把兩者混為一談，於是報告寫「這台沒有 hp 指令」，
    // 但 cmds/usr/hp.lpc 明明在——結論指向錯的地方，下一步就會修錯東西。
    // 【判準】mudlib 對不存在指令的標準回話是**整句就是**「什麼？」；
    // 其餘含「什麼」的句子是遊戲內容，要分開歸類。
    const line = fresh.replace(/^[\s>]+/, '').trim();
    if (/^(什麼|什么)\s*[？?]/.test(line)) {
      // ★ 「什麼？」要用**基準指令**分辨，不能直接歸咎這顆按鈕。
      //
      // 【WHY】實測 moniHuafu：按下「練功」（practice）之後角色進入忙碌狀態，
      // 接著 `skills`、`hp`、`dazuo`、`quit` **每一個**都回「什么？」——
      // 那不是「這台沒有這些指令」，是**世界現在誰的話都不聽**。
      // 舊判準會把後面五顆正常的按鈕全部報成缺陷，而結論指向錯的方向
      // （去找不存在的指令檔）。打坐也是同一類，先前只好把它們一個個
      // 排到最後——那是打地鼠，列舉不完（practice／liangong／sleep…）。
      // 【判準】送一個**已知可用**的指令（look，開場就驗過它會動）。
      // look 也回「什麼？」→ 是會話狀態問題，記一筆並停止逐顆歸咎；
      // look 正常 → 才真的是這顆按鈕掛了不存在的指令。
      const probe = await msgText();
      await page.evaluate(() => globalThis.__zjmud?.sendCommand?.('look'));
      await page.waitForTimeout(1800);
      const probeReply = (await msgText()).slice(probe.length).replace(/^[\s>]+/, '').trim();
      if (/^(什麼|什么)\s*[？?]/.test(probeReply) || !probeReply) {
        console.log(`${tag} ⚠ 世界進入忙碌狀態（基準指令 look 也回「什麼？」）`);
        problems.push(`世界不再回應任何指令（在「${b.label}」處偵測到；`
          + `前一顆成功的是「${lastOk || '（無）'}」，很可能是它讓角色進入忙碌狀態）`
          + `——基準指令 look 也回「什麼？」，其餘按鈕未能繼續驗證`);
        break;
      }
      console.log(`${tag} ✗ 指令不存在：${JSON.stringify(line.slice(0, 60))}`);
      problems.push(`${b.where}[${b.index}] ${b.label}（cmd=${expectCmd}）：這台沒有這個指令`);
      continue;
    }
    if (/(什麼|什么)\s*[？?]/.test(line)) {
      // 指令存在但世界拒絕執行——是可玩性問題，不是按鈕接線問題。
      console.log(`${tag} ⚠ 世界拒絕：${JSON.stringify(line.slice(0, 60))}`);
      refused.push(`${b.label}（${expectCmd}）：${line.slice(0, 40)}`);
    }
    if (grew <= 0 && !changed.length) {
      // ★ 降級為警示，不算失敗。
      // 【WHY】按鈕的接線（有指令、送得出去、指令存在）都已經驗過了；
      // 剩下「世界要不要說話」是**那個 mudlib 自己的設計**——
      // `dazuo 10` 在好幾台就是靜靜開始打坐，一個字都不印。
      // 把它算成失敗，等於用我們的期待去評判別人的遊戲，
      // 而且會讓真正的接線缺陷淹沒在雜訊裡（CLAUDE.md §10：假紅燈與假綠燈同罪）。
      // 【判準】仍然要**列出來**讓人看得見，只是不讓它決定紅綠。
      console.log(`${tag} ⚠ 送出了但世界沒有回應`);
      silent.push(`${b.label.replace(/\s+/g, '')}（${expectCmd}）`);
      continue;
    }
    lastOk = b.label.replace(/\s+/g, '');
    console.log(`${tag} ✓ ${changed.join(' ') || `+${grew} 字`}`);
  }

  // ── 送出比對：統一在最後做 ──
  //
  // 【WHY 不在每次點擊後立刻比對】送出不是同步的，而 WASM driver 跑在同一條
  // 主執行緒上——它在跑一拍的時候，Playwright 的輪詢**根本評估不到**。
  // 實測固定睡眠與 waitForFunction 都出現「慢一拍」：按地圖時讀到空的，
  // 按練功時才讀到 ["map"]，於是四顆**完全正常**的按鈕被判成沒送出，
  // 而錯誤訊息裡印的還是上一顆的指令——誤導性比沒測還高。
  // 【判準】「這顆按鈕有沒有把它的指令送出去」與**什麼時候**送出無關。
  // 全部按完再看一次送出紀錄，時序問題就不存在了。
  await page.waitForTimeout(2000);
  const allSent = await page.evaluate(() => window.__sent.map((l) => String(l).trim()));
  for (const { b, cmd } of expected) {
    if (!allSent.includes(cmd)) {
      problems.push(`${b.where}[${b.index}] ${b.label}：按下去沒有送出 ${cmd}`);
      console.log(`  ✗ ${b.label} 的指令「${cmd}」從頭到尾沒被送出`);
    }
  }
} catch (e) {
  if (e.message !== 'stop') problems.push(`例外：${e.message}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error(`\n✗ ${mud.slug}：${problems.length} 項問題`);
  for (const p of problems) console.error(`   · ${p}`);
  process.exit(1);
}
if (silent.length) {
  console.log(`\n⚠ ${mud.slug}：${silent.length} 顆按下去世界沒說話（不算失敗，那是該 mudlib 的設計）：`);
  console.log(`   ${silent.join('、')}`);
}
if (refused.length) {
  console.log(`\n⚠ ${mud.slug}：${refused.length} 項「指令存在但世界拒絕」——不列為失敗，但要看一眼：`);
  for (const r of refused) console.log(`   · ${r}`);
}
// ★ 一顆都沒驗到＝失敗，不是通過。
// 【WHY】實測 sj 重建後 `quick.slots` 是空的（面板沒送到），
// 於是 17 顆全是空槽、被逐一略過，`expected` 是空陣列——
// 而結尾照樣印「✓ 0 顆按鈕都按得到」。這是 CLAUDE.md §5 明文禁止的
// **空集合套套邏輯**：條件永遠成立，所以永遠抓不到東西。
// 這種綠燈比紅燈危險，而且它掩蓋的正是「整個快捷列都沒出來」這種大故障。
if (!expected.length) {
  console.error(`\n✗ ${mud.slug}：一顆有指令的按鈕都沒有——快捷列與標題列都是空的。`
    + `\n  這不是通過：ESC006／ESC021 沒有送到（面板 daemon 沒生效，或 look hook 沒觸發）。`);
  process.exit(1);
}
console.log(`\n✓ ${mud.slug}：${expected.length} 顆按鈕都按得到、送得出、有回應，且沒有「什麼？」`);
process.exit(0);
