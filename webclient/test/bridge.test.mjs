// 橋接整合測試：瀏覽器版的完整鏈路。
//
//   WebSocket client → bridge/server.mjs → TCP → 假 MUD 伺服器
//
// 驗證橋接有沒有把 telnet IAC 剝乾淨、行有沒有正確切、指令有沒有送到。
// 這是瀏覽器版唯一的新增元件，桌面版的對應邏輯在 src-tauri/src/telnet.rs。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket } from 'ws';

import { filter, IAC, DO, WILL, WONT, DONT, SB, SE } from '../bridge/telnet.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(here, '..', 'bridge', 'server.mjs');
const MUD_PORT = 47421;
const WEB_PORT = 47422;

// ══ telnet 過濾（純函式）══════════════════════════════

/** 實機從 LPMud-Name 收到的開場位元組。 */
const REAL_GREETING = Buffer.from([
  0xff, 0xfd, 0x18, 0xff, 0xfd, 0x1f, 0xff, 0xfd, 0x27,
  0xff, 0xfb, 0x56, 0xff, 0xfb, 0x46, 0xff, 0xfb, 0x2a,
  0x0d, 0x0a, ...Buffer.from('ver1.0:abc'), 0x0d, 0x0a,
]);

test('telnet: 剝除實機開場的 6 組 IAC', () => {
  const { data } = filter(REAL_GREETING);
  assert.equal(data.toString('utf8'), '\r\nver1.0:abc\r\n');
});

test('telnet: 協商一律拒絕（尤其 MCCP2）', () => {
  const { reply } = filter(REAL_GREETING);
  assert.deepEqual([...reply], [
    IAC, WONT, 0x18, IAC, WONT, 0x1f, IAC, WONT, 0x27,
    IAC, DONT, 0x56,   // MCCP2 必須拒絕，否則之後全是 zlib
    IAC, DONT, 0x46, IAC, DONT, 0x2a,
  ]);
});

test('telnet: 純文字原樣通過', () => {
  const { data, reply } = filter(Buffer.from('客棧大廳\n', 'utf8'));
  assert.equal(data.toString('utf8'), '客棧大廳\n');
  assert.equal(reply.length, 0);
});

test('telnet: IAC IAC 還原成單一 0xFF', () => {
  const { data } = filter(Buffer.from([0x61, IAC, IAC, 0x62]));
  assert.deepEqual([...data], [0x61, 0xff, 0x62]);
});

test('telnet: 子協商整段丟棄', () => {
  const { data } = filter(Buffer.from([0x61, IAC, SB, 0x18, 0x01, IAC, SE, 0x62]));
  assert.deepEqual([...data], [0x61, 0x62]);
});

test('telnet: 不完整的序列不外洩成資料', () => {
  const { data } = filter(Buffer.from([0x61, IAC, WILL]));
  assert.deepEqual([...data], [0x61]);
});

// ══ 端到端 ═══════════════════════════════════════════

let mud, bridge, mudSock;
const received = [];

function startFakeMud() {
  return new Promise((resolve) => {
    mud = net.createServer((sock) => {
      mudSock = sock;
      sock.setEncoding('utf8');
      // 橋接會先回送「拒絕協商」的 IAC 位元組，那不是指令，要濾掉
      sock.on('data', (d) => {
        for (const line of d.split('\n')) {
          if (line && !line.includes('\u00ff') && !/[\u0000-\u0008]/.test(line)) {
            received.push(line);
          }
        }
      });
      // 一連上就送 IAC 協商 + 版本挑戰，模仿真實 FluffOS
      sock.write(REAL_GREETING);
    });
    mud.listen(MUD_PORT, '127.0.0.1', resolve);
  });
}

function startBridge() {
  return new Promise((resolve, reject) => {
    bridge = spawn(process.execPath, [
      BRIDGE, '--port', String(WEB_PORT),
      '--mud-host', '127.0.0.1', '--mud-port', String(MUD_PORT),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => reject(new Error('橋接啟動逾時')), 5000);
    bridge.stdout.on('data', (d) => {
      if (String(d).includes('已啟動')) { clearTimeout(t); setTimeout(resolve, 200); }
    });
    bridge.on('error', reject);
  });
}

function get(pathname) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: WEB_PORT, path: pathname }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }));
    });
  });
}

test('橋接端到端', async (t) => {
  await startFakeMud();
  await startBridge();
  t.after(() => { bridge?.kill(); mud?.close(); });

  await t.test('供應前端靜態檔', async () => {
    const idx = await get('/');
    assert.equal(idx.status, 200);
    assert.match(idx.body, /<title>ZJMUD<\/title>/);

    const js = await get('/js/main.js');
    assert.equal(js.status, 200);
    assert.match(js.type, /javascript/);
  });

  await t.test('擋掉目錄穿越', async () => {
    const r = await get('/../package.json');
    assert.notEqual(r.status, 200, '不可讀到 src/ 以外的檔案');
  });

  await t.test('★ WebSocket → TCP：IAC 被剝乾淨、逐行送達瀏覽器', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${WEB_PORT}/mud`);
    const lines = [];
    let opened = false;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('逾時')), 4000);
      ws.on('open', () => ws.send(JSON.stringify({ host: '127.0.0.1', port: MUD_PORT })));
      ws.on('message', (raw) => {
        const text = raw.toString('utf8');
        if (text.startsWith('{"__state"')) {
          if (JSON.parse(text).__state.state === 'open') opened = true;
          return;
        }
        lines.push(text);
        if (lines.some((l) => l.startsWith('ver1.0:'))) { clearTimeout(timer); resolve(); }
      });
      ws.on('error', reject);
    });

    assert.equal(opened, true, '橋接應回報 open 狀態');
    const ver = lines.find((l) => l.startsWith('ver1.0:'));
    assert.ok(ver, `應收到版本挑戰，實得 ${JSON.stringify(lines)}`);
    assert.ok(!ver.includes('�'), 'IAC 沒剝乾淨會出現替換字元');
    assert.ok(!lines.some((l) => l.includes('\xFF')), '不應有裸 0xFF');

    // ★ 送指令：瀏覽器 → 橋接 → MUD
    received.length = 0;
    ws.send('test001║abc123║byname666║a@b.com');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(received.includes('test001║abc123║byname666║a@b.com'),
      `指令應原樣送達 MUD、║(U+2551) 不可被破壞，實得 ${JSON.stringify(received)}`);

    ws.close();
  });

  await t.test('拒絕連到未授權的位址（不是開放代理）', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${WEB_PORT}/mud`);
    const msg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('逾時')), 4000);
      ws.on('open', () => ws.send(JSON.stringify({ host: '1.2.3.4', port: 9999 })));
      ws.on('message', (raw) => {
        const text = raw.toString('utf8');
        if (text.startsWith('{"__state"')) { clearTimeout(timer); resolve(JSON.parse(text).__state); }
      });
      ws.on('error', reject);
    });
    assert.equal(msg.state, 'error');
    assert.match(msg.message, /只允許連到/);
  });
});
