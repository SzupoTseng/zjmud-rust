// WebSocket ↔ TCP 橋接 + 靜態檔案伺服器。
//
// 瀏覽器開不了 raw TCP，所以需要這一層。它只做三件事：
//   1. 供應 src/ 底下的前端靜態檔
//   2. 接受 WebSocket 連線，代為開一條 TCP 到 MUD 伺服器
//   3. 剝除 telnet IAC、逐行切分、UTF-8 解碼後轉發給瀏覽器
//
// 它**不解析 ZJMUD 協議**——opcode 與樣式解析仍然全在前端，
// 與 Tauri 版共用同一份 protocol.js / ansi.js。
//
// 用法：
//   node bridge/server.mjs                     # http :8080，MUD 預設 127.0.0.1:5001
//   node bridge/server.mjs --port 8080 --mud-host 127.0.0.1 --mud-port 5001
//   node bridge/server.mjs --allow-any         # 允許前端指定任意 MUD 位址（僅限本機開發）

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { filter } from './telnet.mjs';

// ── 參數 ────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const HTTP_PORT = Number(arg('port', 8080));
const MUD_HOST = arg('mud-host', '127.0.0.1');
const MUD_PORT = Number(arg('mud-port', 5001));
const ALLOW_ANY = process.argv.includes('--allow-any');
const BIND = arg('bind', '0.0.0.0');

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(here, '..', 'src');

/** 單行上限，避免異常伺服器把記憶體吃光。 */
const MAX_LINE_BYTES = 64 * 1024;

// ── 靜態檔案 ────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  // 防目錄穿越：解析後必須仍在 WEB_ROOT 底下
  const file = path.resolve(WEB_ROOT, '.' + rel);
  if (!file.startsWith(WEB_ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('找不到 ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
});

// ── WebSocket ↔ TCP ─────────────────────────────────

const wss = new WebSocketServer({ server, path: '/mud' });

wss.on('connection', (ws, req) => {
  const who = req.socket.remoteAddress;
  let tcp = null;
  let pending = Buffer.alloc(0);

  const sendState = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ __state: obj }));
  };

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const text = raw.toString('utf8');

    // 第一則訊息是連線請求，其餘都是要送給 MUD 的指令
    if (!tcp) {
      let want;
      try { want = JSON.parse(text); } catch { want = {}; }

      const host = ALLOW_ANY && want.host ? String(want.host) : MUD_HOST;
      const port = ALLOW_ANY && want.port ? Number(want.port) : MUD_PORT;

      if (!ALLOW_ANY && want.host && (want.host !== MUD_HOST || Number(want.port) !== MUD_PORT)) {
        // 不是開放代理：預設只允許連到橋接自己設定的目標
        sendState({ state: 'error', message:
          `此橋接只允許連到 ${MUD_HOST}:${MUD_PORT}（要放寬請以 --allow-any 啟動）` });
        ws.close();
        return;
      }

      console.log(`[+] ${who} → ${host}:${port}`);
      tcp = net.createConnection({ host, port }, () => {
        tcp.setNoDelay(true);
        sendState({ state: 'open', host, port });
      });

      tcp.on('data', (chunk) => {
        // 剝 IAC，並把「拒絕協商」回覆送回 MUD
        const { data, reply } = filter(chunk);
        if (reply.length) tcp.write(reply);
        pending = Buffer.concat([pending, data]);

        let idx;
        while ((idx = pending.indexOf(0x0a)) !== -1) {
          let line = pending.subarray(0, idx);
          pending = pending.subarray(idx + 1);
          if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
          if (line.length > MAX_LINE_BYTES) line = line.subarray(0, MAX_LINE_BYTES);
          if (ws.readyState === ws.OPEN) ws.send(line.toString('utf8'));
        }
        if (pending.length > MAX_LINE_BYTES) pending = Buffer.alloc(0);
      });

      tcp.on('error', (e) => {
        sendState({ state: 'error', message: e.message });
        ws.close();
      });
      tcp.on('close', () => {
        sendState({ state: 'closed', reason: '伺服器關閉連線' });
        ws.close();
      });
      return;
    }

    // 之後的每一則訊息 = 一行指令
    if (process.env.BRIDGE_DEBUG) console.log(`[>] ${who} 送出: ${JSON.stringify(text)}`);
    if (!tcp.destroyed) tcp.write(text + '\n');
  });

  ws.on('close', () => {
    console.log(`[-] ${who} 離線`);
    if (tcp && !tcp.destroyed) tcp.destroy();
  });
  ws.on('error', () => { if (tcp && !tcp.destroyed) tcp.destroy(); });
});

server.listen(HTTP_PORT, BIND, () => {
  console.log('ZJMUD Web 橋接已啟動');
  console.log(`  網頁：   http://localhost:${HTTP_PORT}`);
  console.log(`  轉發至： ${MUD_HOST}:${MUD_PORT}${ALLOW_ANY ? '（--allow-any：允許前端指定其他位址）' : ''}`);
  console.log(`  手機連線：把 localhost 換成這台電腦的區域網路 IP`);
});
