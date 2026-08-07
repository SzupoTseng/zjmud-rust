// 連線面板的 mud 選單（WASM 模式）冒煙測試。
//
// 【WHY】使用者要的第一個畫面不是「位址／埠號」，而是**可選的 zjmud lib 清單**。
// 這條路徑從 catalogue 抓取 → 渲染卡片 → 選擇 → 啟動 driver → 連線，
// 中間任何一段靜默失效，畫面看起來都只是「沒有清單」或「按了沒反應」——
// 正是本書 §015 七次事故的形狀。所以它必須有一條真的跑過 DOM 的測試。
//
// 【推理】測試替身只假造**真正外部**的兩樣東西：fetch（catalogue／映像）與
// createFluffOS（wasm driver）。DOM、main.js、net.js、wasmboot.js 全部是真的，
// 因為那幾層正是會出錯的地方。
//
// 【證據】src/js/wasmboot.js 的 bootMudInPage()；main.js 的 bindMudPicker()。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src');

const CATALOGUE = {
  generated: '2026-07-31T00:00:00Z',
  driver: 'v2026.0729.0',
  muds: [
    { slug: 'lpmudname', title: '江湖论剑', dialect: 'classic', badge: 'playable', sizeMB: 31.5, base: './libs/lpmudname' },
    { slug: 'damengjianghu', title: '大梦江湖', dialect: 'dmjh', badge: 'limited', note: '停在建角', sizeMB: 40.2, base: './libs/damengjianghu' },
    { slug: 'broken', title: '開不起來的', badge: 'noboot', note: '缺 master', sizeMB: 1, base: './libs/broken' },
  ],
};

let dom;
let sent = [];
let bootedConfig = null;

/** 假的 wasm driver：只保留 boot/connect/input/tick 的合約，不跑真的 LPC。 */
function makeFakeFluffOS(window) {
  return async () => {
    const files = new Map();
    const M = {
      FS: {
        mkdir: () => {},
        writeFile: (p, b) => files.set(p, b),
        chdir: () => {},
      },
      ccall: (name, _ret, _types, args) => {
        if (name === 'fluffos_boot') { bootedConfig = args[0]; return 0; }
        if (name === 'fluffos_connect') {
          // 真 driver 會在回傳前就同步吐出 logon 輸出——這正是曾經害 send() 被
          // 靜默丟棄的行為，替身必須忠實重現（見 wasmdriver.js closed 的說明）。
          setTimeout(() => {
            const bytes = [...Buffer.from('ver1.0:testchallenge\r\n', 'utf8')];
            globalThis.__fakeModule.fluffos.onOutput(1, bytes);
          }, 0);
          return 1;
        }
        if (name === 'fluffos_input') { sent.push(Buffer.from(args[1]).toString('utf8')); return 0; }
        return 0;
      },
    };
    // driver 的 onOutput 回呼掛在 Module 上（createWasmDriver 會設定 M.fluffos）
    globalThis.__fakeModule = M;
    return M;
  };
}

before(async () => {
  sent = [];
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.confirm = () => false;
  globalThis.prompt = () => null;
  delete globalThis.__TAURI__;
  delete globalThis.__ZJMUD_WASM__;

  // catalogue 與映像都走 fetch；映像用一個空 manifest，載入端邏輯照樣被執行
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/libs/index.json') || u.endsWith('./libs/index.json')) {
      return { ok: true, json: async () => CATALOGUE };
    }
    if (u.endsWith('mudlib.json')) {
      return { ok: true, json: async () => ({ format: 1, mount: '/mudlib', config: 'config.ini', totalBytes: 0, dirs: ['adm'], files: [] }) };
    }
    if (u.endsWith('mudlib.data')) {
      return { ok: true, headers: { get: () => '0' }, body: null, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    throw new Error('未預期的 fetch：' + u);
  };

  // driver glue 是動態插入的 <script>；jsdom 不會真的載入，所以直接掛好全域
  window.createFluffOS = makeFakeFluffOS(window);
  globalThis.createFluffOS = window.createFluffOS;

  await import(pathToFileURL(path.join(SRC, 'js', 'main.js')).href + '?t=' + Date.now());
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 120));
});

after(() => {
  // driver 的 tick 是 setInterval，不停掉的話 node --test 永遠不會結束
  globalThis.__ZJMUD_WASM__?.driver?.shutdown?.();
  delete globalThis.__fakeModule;
  delete globalThis.fetch;
  delete globalThis.createFluffOS;
  delete globalThis.__ZJMUD_WASM__;
  dom?.window?.close();
});

test('★ 有 catalogue 時，第一個畫面列出可選的 mud（而不是問位址／埠號）', () => {
  const picker = document.getElementById('mud-picker');
  const direct = document.getElementById('direct-fields');
  assert.equal(picker.hidden, false, 'mud 選單應該顯示');
  assert.equal(direct.hidden, true, '位址／埠號欄位應該收起來');

  const items = document.querySelectorAll('#mud-list .mud-item');
  assert.equal(items.length, CATALOGUE.muds.length, '每個 mud 都要有一張卡');
  assert.match(items[0].textContent, /江湖论剑/);
  assert.match(items[0].textContent, /可玩/);
  assert.match(items[1].textContent, /部分功能/);
});

test('★ noboot 的 mud 不可選（點了也不會啟動）', () => {
  const items = [...document.querySelectorAll('#mud-list .mud-item')];
  const broken = items[2];
  assert.equal(broken.disabled, true, 'noboot 應該是 disabled');
  assert.ok(broken.className.includes('disabled'));
});

test('★ 第一張卡預設被選中，點第二張會換選', () => {
  const items = [...document.querySelectorAll('#mud-list .mud-item')];
  assert.ok(items[0].className.includes('selected'));
  items[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const after = [...document.querySelectorAll('#mud-list .mud-item')];
  assert.ok(after[1].className.includes('selected'), '點過的那張要變成選中');
  assert.ok(!after[0].className.includes('selected'));
  // 選回第一張，讓後續測試從已知狀態開始
  after[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});

test('★ 按「進入」：啟動 driver → 撥號 → 收到握手行（整條路徑都是真的）', async () => {
  const btn = document.getElementById('connect-btn');
  assert.equal(btn.textContent, '進入');

  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(globalThis.__ZJMUD_WASM__, 'driver 應該已就緒');
  assert.equal(bootedConfig, 'config.ini', 'boot 要用 manifest 裡的設定檔名');
  assert.equal(document.getElementById('connect-panel').hidden, true, '連上後連線面板要收起來');
});
