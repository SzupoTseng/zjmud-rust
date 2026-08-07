// 整合測試：假伺服器 → TCP → decodeLine → reducer 語意。
//
// 這條路徑涵蓋了「Rust 端會做的事」以外的全部流程：
// 分行、UTF-8、opcode 分派、欄位解析。Rust 端另以 cargo test 驗證。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { decodeLine } from '../src/js/protocol.js';
import { createStore } from '../src/js/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'tools', 'fake-server.mjs');
const PORT = 47311; // 避開常用埠

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => reject(new Error('假伺服器啟動逾時')), 5000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('已啟動')) { clearTimeout(timer); resolve(proc); }
    });
    proc.on('error', reject);
  });
}

/** 開場腳本的總長度。指令必須等它播完再送，否則回應會和開場交錯。 */
const INTRO_MS = 1700;

/**
 * 連線 → 等 startDelay → 送出指令 → 再收集 ms 毫秒。
 * 回傳「startDelay 之後」收到的行，確保不混入開場腳本。
 */
function collect(commands, ms, startDelay = 0) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let capturing = startDelay === 0;
    const sock = net.createConnection(PORT, '127.0.0.1');
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (capturing) lines.push(line);
      }
    });
    sock.on('error', reject);
    sock.on('connect', () => {
      setTimeout(() => {
        capturing = true;
        for (const c of commands) sock.write(c + '\n');
        setTimeout(() => { sock.end(); resolve(lines); }, ms);
      }, startDelay);
    });
  });
}

let server;

test('整合測試', async (t) => {
  server = await startServer();
  t.after(() => server.kill());

  await t.test('開場序列可完整解析且無未知事件', async () => {
    const lines = await collect([], 1600);
    assert.ok(lines.length >= 12, `開場應有多行，實得 ${lines.length}`);

    const events = lines.map((l) => decodeLine(l));
    const types = new Set(events.map((e) => e.type));

    assert.ok(types.has('room.title'), '應收到房間標題');
    assert.ok(types.has('room.desc'), '應收到房間描述');
    assert.ok(types.has('room.exits'), '應收到出口');
    assert.ok(types.has('room.objects'), '應收到物件');
    assert.ok(types.has('stat.bars'), '應收到屬性條');
    assert.ok(types.has('ui.quickButtons'), '應收到快捷鈕');
    assert.ok(types.has('msg.chat'), '應收到聊天');
  });

  await t.test('reducer 套用後 store 反映正確的房間狀態', async () => {
    const lines = await collect([], 1200);
    const store = createStore();

    for (const line of lines) {
      const ev = decodeLine(line);
      if (ev.type === 'room.title') { store.resetRoom(); store.set('room.title', ev.text); }
      else if (ev.type === 'room.desc') store.set('room.desc', ev.text);
      else if (ev.type === 'room.exits') store.set('room.exits', ev.exits);
      else if (ev.type === 'room.objects') store.set('room.objects', ev.objects);
      else if (ev.type === 'stat.bars') store.set('stats', { bars: ev.bars, layout: ev.layout });
      else if (ev.type === 'msg.chat') store.pushMessage('chat', ev.text);
    }

    assert.match(store.get('room.title'), /客棧大廳/);
    assert.match(store.get('room.desc'), /八仙桌/);
    assert.equal(store.get('room.exits').length, 4);
    assert.equal(store.get('room.objects').length, 3);
    assert.equal(store.get('stats').bars.length, 4);
    assert.ok(store.get('msgs.chat').length >= 1);

    // 出口方向盤位置對應
    const slots = store.get('room.exits').map((e) => e.slot);
    assert.ok(slots.includes('n'), 'north 應對到北鍵');
    assert.ok(slots.includes('e'), 'east 應對到東鍵');
    assert.ok(slots.includes(null), 'out/up 應成為額外出口');
  });

  await t.test('互動流程：look → 詳情 + 兩組動作列', async () => {
    const lines = await collect(['look xiaoer'], 400, INTRO_MS);
    const evs = lines.map(decodeLine);

    const detail = evs.find((e) => e.type === 'overlay.detail');
    assert.ok(detail, '應收到 ESC007 詳情');
    assert.match(detail.text, /粗布衣裳/);

    const actions = evs.filter((e) => e.type === 'overlay.actions');
    assert.equal(actions.length, 2, '應收到兩組動作列');
    assert.equal(actions[0].column, 1);
    assert.equal(actions[1].column, 2);

    // 「點菜」帶 $txt#，點擊後應保持面板開啟
    const keep = actions[0].items.find((i) => i.title === '點菜');
    assert.ok(keep, '應有點菜動作');
    assert.equal(keep.keepOpen, true);
    assert.equal(keep.sub, '10兩');

    // 「更多…」的指令欄內嵌 ESC020，應轉為彈出選單
    const popup = actions[1].items.find((i) => i.popup != null);
    assert.ok(popup, '應有內嵌彈出選單的動作');
    assert.match(popup.popup, /買酒\|buy wine/);
  });

  await t.test('對話框流程：數量輸入 + $N 替換', async () => {
    const lines = await collect(['menu'], 300, INTRO_MS);
    const ev = lines.map(decodeLine).find((e) => e.type === 'overlay.dialog');
    assert.ok(ev, '應收到 ESC010 對話框');

    const d = ev.dialog;
    assert.equal(d.needNumber, true);
    assert.deepEqual(d.okCmds, ['buy $N wine']);
    assert.equal(d.cancelCmd, 'say 算了');
    assert.ok(d.blocks.some((b) => b.kind === 'money'), '應有 $god# 金錢區塊');
  });

  await t.test('移動觸發換房間並清空舊狀態', async () => {
    const lines = await collect(['north'], 400, INTRO_MS);
    const evs = lines.map(decodeLine);
    const title = evs.filter((e) => e.type === 'room.title').pop();
    assert.ok(title, '應收到新房間標題');
    assert.match(title.text, /大街/);
  });

  await t.test('畸形輸入全部降級、無一拋錯', async () => {
    const lines = await collect(['malformed'], 500, INTRO_MS);
    assert.ok(lines.length >= 5, '應收到畸形測試各行');

    for (const line of lines) {
      assert.doesNotThrow(() => decodeLine(line), `此行不應拋錯：${JSON.stringify(line)}`);
    }
    // 未知 opcode 應降級成主訊息且內容完整保留
    const unknown = lines.find((l) => l.includes('未知的 opcode'));
    assert.ok(unknown);
    const ev = decodeLine(unknown);
    assert.equal(ev.type, 'msg.main');
    assert.match(ev.text, /未知的 opcode/);
  });

  await t.test('中文在 TCP 分段下不會被切壞', async () => {
    const lines = await collect(['colors'], 500, INTRO_MS);
    const joined = lines.join('\n');
    assert.ok(!joined.includes('�'), '不應出現替換字元（UTF-8 邊界被切壞的徵兆）');
    assert.ok(joined.includes('自訂橙'), '多位元組中文應完整');
  });
});
