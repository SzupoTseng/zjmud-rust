// 傳輸層測試：連線生命週期、重連、以及**重連風暴**。
//
// 【為什麼需要這支】
// 2026-07-29 事故：客戶端每秒對伺服器登入一次，累計 50,251 次寫進 debug.log。
// 當時 171 條測試全綠。原因是 ui-smoke 的假 Tauri 太寬容 ——
// 它的 mud_connect 直接「假裝連線成功」，從不模擬真 Rust 的關鍵行為：
// **connect() 會先關掉舊連線，而舊連線關閉時會 emit `mud://state closed`。**
// 測試裡的後端不會做出引發 bug 的那個動作，於是 bug 永遠不會出現。
//
// 這支測試的假後端**刻意模仿真 Rust 的副作用**，包括不討喜的那些。

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 假 Tauri：忠實模擬「新 connect 會取代舊連線並送出 closed」。 */
function installFakeTauri({ replaceEmitsClosed }) {
  const calls = [];
  const listeners = new Map();
  let open = false;

  function emitState(payload) {
    for (const cb of listeners.get('mud://state') ?? []) cb({ payload });
  }

  globalThis.__TAURI__ = {
    core: {
      invoke: async (cmd) => {
        calls.push(cmd);
        if (cmd === 'mud_connect') {
          // ★ 真 Rust 的行為：已有連線時先斷開。舊的斷開就會通知前端。
          if (open && replaceEmitsClosed) {
            emitState({ state: 'closed', reason: '被新的連線取代' });
          }
          open = true;
        }
        if (cmd === 'mud_disconnect') open = false;
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

  return {
    calls,
    connects: () => calls.filter((c) => c === 'mud_connect').length,
    serverClosed: () => { open = false; emitState({ state: 'closed', reason: '伺服器關閉連線' }); },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('★ 重複呼叫 connect 不可演變成每秒重連的風暴', async () => {
  const fake = installFakeTauri({ replaceEmitsClosed: true });
  const { createTransport } = await import('../src/js/net.js?case=storm');
  const t = createTransport({ onLine() {}, onState() {} });

  await t.connect('127.0.0.1', 5001);
  // 使用者按了第二次「連線」，或自動連線與手動連線撞在一起。
  // 這一次呼叫**不該**開啟任何迴圈。
  await t.connect('127.0.0.1', 5001);

  await wait(3500);   // 涵蓋退避序列的前三級（1s + 2s + …）

  assert.ok(fake.connects() <= 2,
    `重複 connect 造成連線風暴：3.5 秒內開了 ${fake.connects()} 條連線。\n`
    + '（真實事故中這是每秒一次、五萬次登入的成因）');
  assert.equal(t.state, 'OPEN', '狀態應停在 OPEN');
  await t.close();
});

test('★ 連線建立期間到達的 closed 不可觸發重連', async () => {
  const fake = installFakeTauri({ replaceEmitsClosed: true });
  const { createTransport } = await import('../src/js/net.js?case=during');
  const states = [];
  const t = createTransport({ onLine() {}, onState: (s) => states.push(s.state) });

  await t.connect('127.0.0.1', 5001);
  await t.connect('127.0.0.1', 5002);   // 換位址：這次會真的重開

  await wait(2500);
  assert.ok(fake.connects() <= 2,
    `換位址時的取代事件不該引發重連，實得 ${fake.connects()} 次連線`);
  assert.ok(!states.includes('RECONNECTING'),
    `不該進入 RECONNECTING，實際狀態序列：${states.join(' → ')}`);
  await t.close();
});

test('★ 但伺服器真的關閉連線時，仍然要自動重連（不可過度修正）', async () => {
  const fake = installFakeTauri({ replaceEmitsClosed: false });
  const { createTransport } = await import('../src/js/net.js?case=real');
  const states = [];
  const t = createTransport({ onLine() {}, onState: (s) => states.push(s.state) });

  await t.connect('127.0.0.1', 5001);
  assert.equal(fake.connects(), 1);

  fake.serverClosed();                  // 伺服器端斷線
  assert.ok(states.includes('RECONNECTING'), '真斷線應進入 RECONNECTING');

  await wait(1500);                     // 第一級退避是 1 秒
  assert.equal(fake.connects(), 2, '應該重連一次');
  await t.close();
});

test('使用者主動 close 之後不該再自動重連', async () => {
  const fake = installFakeTauri({ replaceEmitsClosed: false });
  const { createTransport } = await import('../src/js/net.js?case=manual');
  const t = createTransport({ onLine() {}, onState() {} });

  await t.connect('127.0.0.1', 5001);
  await t.close();
  await wait(1500);
  assert.equal(fake.connects(), 1, 'close() 之後不該再連');
  assert.equal(t.state, 'IDLE');
});
