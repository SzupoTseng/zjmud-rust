// UI 冒煙測試：真的載入 index.html、真的執行 main.js、真的模擬點擊「連線」。
//
// 【為什麼需要這支】
// 先前 98 個測試全綠、Rust 也編譯過，但實際開視窗按「連線」毫無反應。
// 原因是那些測試全都繞過了「HTML + main.js + 事件綁定」這一層 ——
// 也就是使用者唯一會碰到的那一層。這支測試補上那個缺口。
//
// 它不需要 Tauri，改用一個假的 window.__TAURI__ 來攔截 IPC 呼叫，
// 因此可以在 CI／WSL 裡直接跑。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { setDialect, getDialect } from '../src/js/dialects.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src');

/** 記錄前端對 Tauri 後端發出的所有呼叫。 */
let ipcCalls = [];
let listeners = new Map();
let dom;

/**
 * 建一個假的 Tauri IPC 橋接，行為與 Tauri v2 的 window.__TAURI__ 一致。
 *
 * ★ 測試替身**必須忠實模擬真實後端的副作用，包括不討喜的那些**。
 *
 * 【WHY】2026-07-29 事故：客戶端每秒對伺服器登入一次、累計 50,251 次，
 * 而當時 171 條測試全綠。
 *
 * 【推理】舊版這裡對 `mud_connect` 直接 `return undefined`「假裝連線成功」，
 * 但真 Rust 的 `MudState::connect()` 會**先關掉舊連線**，舊連線關閉時
 * emit `mud://state closed`。前端把它當成非預期斷線而重連 → 又取代 → 又 closed，
 * 形成 1 Hz 無限迴圈。測試裡的後端從不做那個動作，所以 bug 沒有機會出現。
 * 這不是「漏寫一條測試」，是**測試替身比真實寬容**——最難察覺的測試失效形態。
 *
 * 【證據】src-tauri/src/mud.rs `MudState::connect()` 開頭的 stop(Replaced)；
 * 伺服器 world/log/debug.log 每 8 秒 +4000 bytes（≈每秒一次 get_user）。
 */
function makeFakeTauri() {
  let socketOpen = false;
  return {
    core: {
      invoke: async (cmd, args) => {
        ipcCalls.push({ cmd, args });
        if (cmd === 'mud_connect') {
          // 真 Rust：已有連線時先斷開。這裡用 Replaced 語意 —— 不通知前端。
          // 若把下面這行改成 emitState({state:'closed'})，就會重現當年的重連風暴，
          // 而 test/net.test.mjs 正是用那個版本的替身在守著這條界線。
          socketOpen = true;
          return undefined;
        }
        if (cmd === 'mud_disconnect') { socketOpen = false; return undefined; }
        if (cmd === 'mud_is_connected') return socketOpen;
        return undefined;
      },
    },
    event: {
      listen: async (name, cb) => {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(cb);
        return async () => {
          const arr = listeners.get(name) ?? [];
          const i = arr.indexOf(cb);
          if (i >= 0) arr.splice(i, 1);
        };
      },
    },
  };
}

/** 模擬後端 emit 一行 MUD 資料給前端。 */
function emitLine(text) {
  for (const cb of listeners.get('mud://line') ?? []) cb({ payload: text });
}

before(async () => {
  ipcCalls = [];
  listeners = new Map();

  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

  dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });

  const { window } = dom;
  window.__TAURI__ = makeFakeTauri();

  // 把 jsdom 的 window 掛成全域，讓 main.js 的模組程式碼能用 document/localStorage
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.__TAURI__ = window.__TAURI__;
  globalThis.confirm = () => false;
  globalThis.prompt = () => null;

  // 真的 import main.js（等同瀏覽器載入 <script type="module">）
  await import(pathToFileURL(path.join(SRC, 'js', 'main.js')).href + '?t=' + Date.now());

  // main.js 是在 DOMContentLoaded 才 mount 的，這裡手動觸發
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 50));
});

after(() => {
  dom?.window?.close();
});

// ══ 這幾條就是「按連線沒反應」會抓到的 ══════════════════

test('index.html 所有 main.js 要取用的元素都存在', () => {
  for (const id of ['connect-panel', 'connect-btn', 'host-input', 'port-input',
                    'cmd-input', 'cmd-send', 'msg-main', 'room-header',
                    'exit-pad-host', 'stat-bars', 'conn-badge']) {
    assert.ok(document.getElementById(id), `缺少元素 #${id}`);
  }
});

test('main.js 有成功 mount：連線欄位被填入預設值（不是只有 placeholder）', () => {
  // 若 main.js 因為任何原因沒執行，這兩個欄位會是空字串，而畫面上看起來
  // 仍有 placeholder 文字 —— 這正是「看起來正常但按鈕沒反應」的樣子。
  const host = document.getElementById('host-input');
  const port = document.getElementById('port-input');
  assert.equal(host.value, '127.0.0.1', 'main.js 未執行或 bindConnectForm 失敗');
  assert.equal(port.value, '5001', '預設埠應為 LPMud-Name 的 UTF-8 埠');
});

test('★ 點擊「連線」會真的送出 mud_connect IPC', async () => {
  ipcCalls.length = 0;
  document.getElementById('connect-btn').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true }),
  );
  await new Promise((r) => setTimeout(r, 80));

  const call = ipcCalls.find((c) => c.cmd === 'mud_connect');
  assert.ok(call, `按下連線後應呼叫 mud_connect，實際呼叫：${JSON.stringify(ipcCalls)}`);
  assert.equal(call.args.host, '127.0.0.1');
  assert.equal(call.args.port, 5001);
});

test('連線成功後連線面板會關閉', async () => {
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(document.getElementById('connect-panel').hidden, true,
    '連線成功應收起面板');
});

test('★ 收到伺服器封包會真的渲染到畫面上', async () => {
  const E = '\u001b';
  emitLine(`${E}002${E}[1;31m阎罗殿${E}[0m`);
  emitLine(`${E}004${E}[37m这里阴深恐怖。${E}[0m`);
  emitLine(`${E}003north:北$zj#east:東`);
  emitLine(`${E}005地藏王:look dizangwang`);
  emitLine('一般訊息一行');
  await new Promise((r) => setTimeout(r, 50));

  assert.match(document.getElementById('room-header').textContent, /阎罗殿/);
  assert.match(document.getElementById('room-desc').textContent, /阴深恐怖/);
  assert.match(document.getElementById('entity-list').textContent, /地藏王/);
  assert.match(document.getElementById('msg-main').textContent, /一般訊息一行/);

  // 出口按鈕：北與東應該可見
  const pad = document.getElementById('exit-pad-host');
  const visible = [...pad.querySelectorAll('.exit-cell')].filter((c) => !c.hidden);
  assert.ok(visible.length >= 2, `應至少兩個方向鍵可見，實得 ${visible.length}`);
});

test('★ 點擊出口按鈕會送出對應指令', async () => {
  ipcCalls.length = 0;
  const pad = document.getElementById('exit-pad-host');
  const cell = [...pad.querySelectorAll('.exit-cell')].find((c) => !c.hidden && c.onclick);
  assert.ok(cell, '應有可點擊的方向鍵');
  cell.onclick();
  await new Promise((r) => setTimeout(r, 50));

  const send = ipcCalls.find((c) => c.cmd === 'mud_send');
  assert.ok(send, '點方向鍵應送出指令');
  assert.match(send.args.line, /^(north|east)$/);
});

test('★ 輸入指令按送出會呼叫 mud_send', async () => {
  ipcCalls.length = 0;
  const input = document.getElementById('cmd-input');
  input.value = 'look';
  document.getElementById('cmd-send').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true }),
  );
  await new Promise((r) => setTimeout(r, 50));

  const send = ipcCalls.find((c) => c.cmd === 'mud_send');
  assert.ok(send, '按送出應呼叫 mud_send');
  assert.equal(send.args.line, 'look');
  assert.equal(input.value, '', '送出後輸入框應清空');
});

test('可點擊連結（[u:cmds:…]）點下去會送出指令', async () => {
  const E = '\u001b';
  ipcCalls.length = 0;
  emitLine(`${E}007等級 ${E}[u:cmds:uplv -l]【角色等級】${E}[0m`);
  await new Promise((r) => setTimeout(r, 50));

  const link = document.querySelector('#overlay-interact .lnk');
  assert.ok(link, '應渲染出連結元素');
  assert.equal(link.dataset.linkValue, 'uplv -l', '冒號必須已剝除');

  link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 50));
  const send = ipcCalls.find((c) => c.cmd === 'mud_send');
  assert.ok(send, '點連結應送出指令');
  assert.equal(send.args.line, 'uplv -l');
});

test('環境診斷列會顯示 IPC 狀態', () => {
  const env = document.getElementById('connect-env');
  assert.ok(env, '應有環境診斷列');
  assert.match(env.textContent, /桌面版（Tauri 直連 TCP/);
});

test('啟動時自動連線：勾選框存在且預設開啟', () => {
  const box = document.getElementById('autoconnect-check');
  assert.ok(box, '應有自動連線勾選框');
  assert.equal(box.checked, true, '預設應開啟，讓啟動即連線可被外部觀測驗證');
});

// ══ 登入流程 ══════════════════════════════════════════

test('★ 收到版本挑戰會跳出登入視窗（而不是要使用者自己打指令）', async () => {
  emitLine('ver1.0:byz0rmpISExtQ');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(document.getElementById('login-modal').hidden, false,
    '偵測到 ver1.0: 應開啟登入視窗');
});

test('★ 登入視窗已開著時，再收到挑戰不可搶走 focus（否則密碼打不進去）', async () => {
  // 伺服器在等待輸入期間會反覆重送 ver1.0: 挑戰行。
  // 先前每收到一行就無條件 focus('login-id')，使用者一點密碼欄就被彈回帳號欄。
  emitLine('ver1.0:byz0rmpISExtQ');
  await new Promise((r) => setTimeout(r, 30));

  const pw = document.getElementById('login-pw');
  pw.focus();
  assert.equal(document.activeElement.id, 'login-pw', '前置條件：focus 應在密碼欄');

  emitLine('ver1.0:byz0rmpISExtQ');   // 伺服器重送
  emitLine('ver1.0:byz0rmpISExtQ');
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(document.activeElement.id, 'login-pw',
    '重送挑戰不可把 focus 搶回帳號欄');
  assert.equal(document.getElementById('login-modal').hidden, false,
    '視窗仍應開著');
});

test('★ 送出登入表單會一次送完版本回覆與帳號行', async () => {
  ipcCalls.length = 0;
  document.getElementById('login-id').value = 'test001';
  document.getElementById('login-pw').value = 'abc123';
  document.getElementById('login-email').value = 'a@b.com';
  document.getElementById('login-submit').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));

  const sends = ipcCalls.filter((c) => c.cmd === 'mud_send').map((c) => c.args.line);
  assert.equal(sends.length, 2, `應連續送兩行，實得 ${JSON.stringify(sends)}`);
  // 版本挑戰的回覆是 mudlib 自己為網頁客戶端保留的通行字串（見 protocol.js LOGIN.ANY）。
  // 曾經送 'x'，在「谁与争锋」那一系會被判「客户端非法」直接斷線。
  assert.equal(sends[0], 'zjmDMaIpOvxdb', '第一行是版本挑戰的回覆');
  assert.equal(sends[1], 'test001\u2551abc123\u2551byname666\u2551a@b.com',
    '第二行是帳號║密碼║密文║email');
  assert.equal(document.getElementById('login-modal').hidden, true, '送出後應關閉');
});

test('登入表單會擋掉不合法的 ID', async () => {
  emitLine('ver1.0:x');
  await new Promise((r) => setTimeout(r, 30));
  ipcCalls.length = 0;
  document.getElementById('login-id').value = '1abc';   // 數字開頭，不合法
  document.getElementById('login-pw').value = 'p';
  document.getElementById('login-submit').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(document.getElementById('login-error').hidden, false, '應顯示錯誤');
  assert.equal(ipcCalls.filter((c) => c.cmd === 'mud_send').length, 0, '不應送出');
  document.getElementById('login-modal').hidden = true;
});

test('★ ESC000 0008 會跳出建立角色視窗', async () => {
  emitLine('\u001b0000008');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(document.getElementById('char-modal').hidden, false);
});

test('★ 建立角色會送出 性別║頭像║暱稱', async () => {
  ipcCalls.length = 0;
  document.getElementById('char-name').value = '大俠';
  document.getElementById('char-submit').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));

  const send = ipcCalls.find((c) => c.cmd === 'mud_send');
  assert.ok(send, '應送出建角資料');
  assert.equal(send.args.line, '男\u2551\u2551大俠', '中間的頭像欄留空');
  assert.equal(document.getElementById('char-modal').hidden, true);
});

test('建角名字長度與中文檢查', async () => {
  emitLine('\u001b0000008');
  await new Promise((r) => setTimeout(r, 30));
  ipcCalls.length = 0;
  document.getElementById('char-name').value = 'ab';
  document.getElementById('char-submit').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(document.getElementById('char-error').hidden, false, '英文名字應被擋');
  assert.equal(ipcCalls.filter((c) => c.cmd === 'mud_send').length, 0);
  document.getElementById('char-modal').hidden = true;
});

test('★ ESC000 0007 會關閉登入與建角視窗', async () => {
  document.getElementById('login-modal').hidden = false;
  document.getElementById('char-modal').hidden = false;
  emitLine('\u001b0000007');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(document.getElementById('login-modal').hidden, true);
  assert.equal(document.getElementById('char-modal').hidden, true);
});

test('★ 帳號在別處登入會停止自動重連（避免兩端無限互踢）', async () => {
  document.getElementById('login-modal').hidden = true;
  emitLine('你的账号在别处登录，你被迫下线了！');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(document.getElementById('login-modal').hidden, false,
    '應跳回登入視窗並說明原因');
  assert.match(document.getElementById('login-error').textContent, /別處登入/);
});

// ══ 擴充方言面板（新協議 mudlib）══════════════════════

test('★ 擴充 opcode 會渲染成分頁面板（不是丟進訊息區）', async () => {
  emitLine('\u001b417\u001b[1;33m王掌櫃\u001b[0m');           // XYRWNAME → 人物標題
  emitLine('\u001b418他捻著鬍鬚，笑而不語。');                    // XYRWMIAO → 人物詳情
  emitLine('\u001b419$2,2,9,30#打聽:ask him$zj#交易:trade him'); // XYRWBUT1 → 動作
  await new Promise((r) => setTimeout(r, 60));

  const panels = document.getElementById('ext-panels');
  assert.equal(panels.hidden, false, '應開啟擴充面板');
  assert.match(document.getElementById('ext-tabs').textContent, /人物/, '分頁應顯示中文標題');

  const body = document.getElementById('ext-body');
  assert.match(body.textContent, /王掌櫃/);
  assert.match(body.textContent, /捻著鬍鬚/);
  assert.match(body.textContent, /打聽/);
});

test('★ 擴充面板的動作按鈕會送出指令', async () => {
  ipcCalls.length = 0;
  const btn = [...document.querySelectorAll('#ext-body .action')]
    .find((b) => b.textContent.includes('打聽'));
  assert.ok(btn, '應有「打聽」按鈕');
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));

  const send = ipcCalls.find((c) => c.cmd === 'mud_send');
  assert.ok(send, '點擊應送出指令');
  assert.equal(send.args.line, 'ask him');
});

test('★ 戰鬥實體會進面板並帶血條，刪除也生效', async () => {
  emitLine('\u001b511/d/npc/wolf#1$zj#野狼$zj#80:100:100');   // XYKILL
  emitLine('\u001b513/u/me#1$zj#我$zj#90:100:100');           // XYKILLDY
  await new Promise((r) => setTimeout(r, 60));

  // 切到戰鬥分頁
  const tab = [...document.querySelectorAll('#ext-tabs .tab')]
    .find((t) => t.textContent.includes('戰鬥'));
  assert.ok(tab, '應有戰鬥分頁');
  tab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));

  const body = document.getElementById('ext-body');
  assert.match(body.textContent, /野狼/);
  assert.match(body.textContent, /我方/);
  assert.match(body.textContent, /敵方/);
  assert.ok(body.querySelector('.entity-bar'), '應畫出血條');

  emitLine('\u001b512/d/npc/wolf#1');   // XYKILLD 刪除敵人
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(!document.getElementById('ext-body').textContent.includes('野狼'),
    '刪除後不應再出現');
});

test('★ KILLEND 會關閉戰鬥面板', async () => {
  emitLine('\u001b516');
  await new Promise((r) => setTimeout(r, 60));
  const tabs = document.getElementById('ext-tabs').textContent;
  assert.ok(!tabs.includes('戰鬥'), '戰鬥分頁應被移除');
});

test('非數字 opcode（2k1）也能渲染', async () => {
  emitLine('\u001b2k1這是綜合屬性樣式一');
  await new Promise((r) => setTimeout(r, 60));
  const tab = [...document.querySelectorAll('#ext-tabs .tab')]
    .find((t) => t.textContent.includes('綜合屬性'));
  assert.ok(tab, '2k1 應建立「綜合屬性」分頁');
});

// ══ 指游 ZY 方言的客戶端能力 ══════════════════════════

test('★ ZY 客戶端能力事件會真的改變狀態', async () => {
  const before = getDialect();
  try {
    setDialect('zymud');

    // 用獨一無二的標記，避免受其他測試殘留的訊息影響
    const marker = 'ZY-CLEAR-MARKER-' + Math.floor(1e6 * 0.42);
    emitLine(marker);
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(document.getElementById('msg-main').textContent.includes(marker),
      '標記應先出現在主訊息區');

    emitLine('\u001b605');                  // ZYCLEARSCREEN
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(!document.getElementById('msg-main').textContent.includes(marker),
      'ZYCLEARSCREEN 應把主訊息區清掉');

    emitLine('\u001b611關閉');               // ZYCLIENTSTATUS
    emitLine('\u001b615從前有座山$zj#120');  // ZYSTORYTEXT
    emitLine('\u001b615close');
    emitLine('\u001b616300');               // ZYVIBRATE（jsdom 無此 API，應安靜略過）
    await new Promise((r) => setTimeout(r, 60));
    // 走到這裡沒拋錯就算通過 —— 這些事件的重點是「不可靜默失效、也不可炸掉」
  } finally { setDialect(before); }
});

// ══ 自動登入的來源（回歸測試）══════════════════════════

test('★ 相同的 toast 會合併成 ×N，不可疊成一整排蓋住畫面', async () => {
  // 使用者截圖：「登录成功，正在加载世界…」同時疊了五個。
  // 根因（重連迴圈）已修，但 Toast 本身也不該有能力洗版。
  const host = document.getElementById('toast-host');
  host.innerHTML = '';
  for (let i = 0; i < 6; i++) emitLine('\u001b015登录成功，正在加载世界。。。');
  await new Promise((r) => setTimeout(r, 60));

  assert.ok(host.childElementCount <= 3,
    `同時最多 3 則 toast，實得 ${host.childElementCount} 則`);
  const counts = [...host.children].map((n) => n.textContent);
  assert.ok(counts.some((t) => /×[2-9]/.test(t)),
    `重複訊息應合併並標示次數，實得：${JSON.stringify(counts)}`);
});

test('★ 瀏覽器自動填入的帳密，不可被當成「同意自動登入」', async () => {
  // 實機 bug：輸入框帶 autocomplete="username"/"current-password"，
  // Edge 的密碼管理員會自動填值。先前 bindLoginForms 直接讀輸入框，
  // 於是連全新的瀏覽器設定檔都會跳過登入表單直接進遊戲。
  // 先登出，清掉先前測試留在記憶體的登入狀態
  //（成功登入後保留帳密是刻意的 —— 斷線重連時不該再問一次）
  document.getElementById('logout-btn').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true }));
  // 登出會 net.close()（解除事件監聽），再於 200ms 後自動重連並重新綁定。
  // 等它綁回來，否則後面 emitLine 送出的挑戰根本沒人收。
  await new Promise((r) => setTimeout(r, 500));
  localStorage.removeItem('zjmud.prefs.v1');   // 沒有任何我們自己存的偏好

  // 模擬瀏覽器自動填入
  document.getElementById('login-id').value = 'autofilled';
  document.getElementById('login-pw').value = 'secret';
  document.getElementById('login-remember').checked = false;

  ipcCalls.length = 0;
  document.getElementById('login-modal').hidden = true;
  emitLine('ver1.0:byz0rmpISExtQ');
  await new Promise((r) => setTimeout(r, 60));

  const sends = ipcCalls.filter((c) => c.cmd === 'mud_send');
  assert.equal(sends.length, 0,
    `不可自動送出登入；實際送了 ${JSON.stringify(sends.map((s) => s.args.line))}`);
  assert.equal(document.getElementById('login-modal').hidden, false,
    '應改為跳出登入表單讓使用者自己決定');
});

test('★ 有「登出」按鈕，且會清掉記住的帳密', async () => {
  const btn = document.getElementById('logout-btn');
  assert.ok(btn, '頂列應有登出按鈕');

  // 先假裝記住了帳密
  localStorage.setItem('zjmud.prefs.v1', JSON.stringify({
    rememberAccount: true, accountId: 'someone', accountPw: 'pw',
  }));

  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));

  const saved = JSON.parse(localStorage.getItem('zjmud.prefs.v1') || '{}');
  assert.equal(saved.rememberAccount, false, '登出後不應再記住');
  assert.equal(saved.accountId, '', '帳號應被清除');
  assert.equal(saved.accountPw, '', '密碼應被清除');
  assert.equal(document.getElementById('login-modal').hidden, false, '應回到登入畫面');
});

test('頂列有目前帳號顯示欄位', () => {
  assert.ok(document.getElementById('who-label'), '應有帳號顯示欄位');
});

// ══ 不變式：解碼器產生的事件，reducer 必須全部處理 ══════

test('★ decodeLine 產生的每一種事件型別，reducer 都要有對應處理', async () => {
  // 這條守的是一個真實缺口：ZY 方言的 7 種「客戶端能力」事件曾經被
  // decodeLine 正確解出，但 reducer 沒有任何 case，全部靜默掉進 default。
  // 症狀是「伺服器叫客戶端做某件事，客戶端什麼都沒做」，且不會報錯。
  const fs = await import('node:fs');
  const path = await import('node:path');
  const here2 = path.dirname(fileURLToPath(import.meta.url));

  const proto = fs.readFileSync(path.join(here2, '..', 'src', 'js', 'protocol.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(here2, '..', 'src', 'js', 'main.js'), 'utf8');

  const produced = new Set(
    [...proto.matchAll(/type: '([a-zA-Z.]+)'/g)].map((m) => m[1])
      // 'msg.' 是動態拼接的前綴（'msg.' + channel），不是真的事件型別
      .filter((t) => t.includes('.') && !t.endsWith('.')),
  );
  const handled = new Set(
    [...mainSrc.matchAll(/case '([a-zA-Z.]+)':/g)].map((m) => m[1]),
  );

  const missing = [...produced].filter((t) => !handled.has(t)).sort();
  assert.deepEqual(missing, [],
    `這些事件被解出來卻沒人處理，會靜默失效：${missing.join(', ')}`);
});


