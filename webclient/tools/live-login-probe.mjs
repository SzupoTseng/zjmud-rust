// 實機登入探針：走完真實登入流程後擷取 in-world 封包，
// 逐行餵進客戶端解析器，驗證協議規格。
//
// 登入流程（出處 world/adm/daemons/logind.c:72-100）：
//   1. 伺服器送 telnet IAC 協商 + "ver1.0:<crypt>"
//   2. 客戶端回任意非 "//" 字串 → "版本验证成功"
//      （回 "//" 會走伺服器內建的除錯登入，直接以測試帳號進入）
//   3. 客戶端送 "帳號║密碼║密文║email"（║ = U+2551）
//
// 用法：node tools/live-login-probe.mjs <host> [port] [秒數]

import net from 'node:net';
import { decodeLine, parseLine } from '../src/js/protocol.js';
import { parseStyled } from '../src/js/ansi.js';

const HOST = process.argv[2] || '127.0.0.1';
const PORT = Number(process.argv[3]) || 5001;
const SECS = Number(process.argv[4]) || 20;
const CHAR_NAME = process.argv[5] || '測試甲';

const IAC = 255, DO = 253, DONT = 254, WILL = 251, WONT = 252, SB = 250, SE = 240;

const stats = {
  raw: 0, lines: 0, iacStripped: 0,
  byOpcode: new Map(), byType: new Map(), failures: [],
  links: [], sizes: 0, invalidUtf8: 0,
};
const samples = [];

/**
 * 剝除 telnet IAC 序列，並對協商一律拒絕（WILL→DONT、DO→WONT）。
 * 真實伺服器開場就送 6 組 IAC（含 MCCP2 壓縮），不處理的話：
 *   * 0xFF 不是合法 UTF-8 → 嚴格解碼器會直接報錯斷線
 *   * 若誤答應 MCCP2，後續資料會變成 zlib 串流而完全無法解讀
 */
function stripIAC(buf, replyTo) {
  const out = [];
  const replies = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== IAC) { out.push(buf[i]); i += 1; continue; }
    const cmd = buf[i + 1];
    if (cmd === undefined) break;
    if (cmd === IAC) { out.push(IAC); i += 2; continue; } // 跳脫的 0xFF
    if (cmd === SB) {
      // 子協商：吃到 IAC SE
      let j = i + 2;
      while (j < buf.length && !(buf[j] === IAC && buf[j + 1] === SE)) j += 1;
      stats.iacStripped += 1;
      i = j + 2;
      continue;
    }
    if (cmd === WILL) { replies.push(IAC, DONT, buf[i + 2]); stats.iacStripped += 1; i += 3; continue; }
    if (cmd === DO)   { replies.push(IAC, WONT, buf[i + 2]); stats.iacStripped += 1; i += 3; continue; }
    if (cmd === WONT || cmd === DONT) { stats.iacStripped += 1; i += 3; continue; }
    i += 2;
  }
  if (replies.length && replyTo) replyTo(Buffer.from(replies));
  return Buffer.from(out);
}

const sock = net.createConnection(PORT, HOST);
let pending = Buffer.alloc(0);
let stage = 'ver';

sock.on('data', (chunk) => {
  stats.raw += chunk.length;
  const clean = stripIAC(chunk, (b) => sock.write(b));
  pending = Buffer.concat([pending, clean]);

  let idx;
  while ((idx = pending.indexOf(0x0a)) !== -1) {
    const lineBuf = pending.subarray(0, idx);
    pending = pending.subarray(idx + 1);
    const text = lineBuf.toString('utf8').replace(/\r$/, '');
    if (text.includes('�')) stats.invalidUtf8 += 1;
    handle(text);
  }
});

function handle(line) {
  stats.lines += 1;

  // 登入狀態機
  if (stage === 'ver' && line.startsWith('ver1.0:')) {
    stage = 'auth';
    console.log(`  ← 版本挑戰：${JSON.stringify(line)}`);
    console.log('  → 回送 "//"（伺服器內建除錯登入）');
    sock.write('//\n');
    return;
  }

  const { op, payload } = parseLine(line);
  const key = op ?? '(無)';
  stats.byOpcode.set(key, (stats.byOpcode.get(key) ?? 0) + 1);

  // 登入狀態碼（出處 world/adm/daemons/logind.c:241,268）
  //   SYSY"0007" = 登入成功    SYSY"0008" = 帳號無角色，請建立
  if (op === '000' && payload.startsWith('0008') && stage !== 'char') {
    stage = 'char';
    // get_char 期待「性別║頭像║暱稱」三欄（logind.c:272-290）
    const line3 = ['男', '', CHAR_NAME].join('║');
    console.log(`  ← 0008 需建立角色 → 送出 ${JSON.stringify(line3)}`);
    sock.write(line3 + '\n');
    return;
  }
  if (op === '000' && payload.startsWith('0007')) {
    stage = 'world';
    console.log('  ← 0007 登入成功');
    return;
  }

  try {
    const ev = decodeLine(line);
    stats.byType.set(ev.type, (stats.byType.get(ev.type) ?? 0) + 1);

    for (const field of ['text', 'detail']) {
      const t = ev[field];
      if (typeof t !== 'string' || !t) continue;
      const { spans } = parseStyled(t);
      for (const s of spans) {
        if (s.style.link) {
          stats.links.push(s.style.link);
          if (s.style.link.startsWith(':')) {
            stats.failures.push(`連結殘留冒號：${JSON.stringify(s.style.link)}`);
          }
        }
        if (s.style.size != null) stats.sizes += 1;
      }
    }
    if (op && samples.length < 60) samples.push({ op, type: ev.type, raw: line.slice(0, 150) });
  } catch (err) {
    stats.failures.push(`${err.message} | ${JSON.stringify(line.slice(0, 120))}`);
  }
}

sock.on('connect', () => {
  console.log(`已連線 ${HOST}:${PORT}，擷取 ${SECS} 秒…\n`);
  // 登入後隨機探幾個指令，觸發不同 opcode
  const probes = [
    [7000, 'look'], [9000, 'hp'], [11000, 'i'],
    [13000, 'skills'], [15000, 'score'], [17000, 'map'], [19000, 'quit'],
  ];
  for (const [t, c] of probes) {
    setTimeout(() => {
      if (!sock.destroyed && stage === 'world') { sock.write(c + '\n'); console.log(`  → ${c}`); }
    }, t);
  }
  setTimeout(() => { sock.end(); report(); }, SECS * 1000);
});

sock.on('error', (e) => { console.error('連線錯誤：', e.message); process.exit(1); });

function report() {
  console.log('\n══════ 實機登入探針結果 ══════');
  console.log(`原始位元組 ${stats.raw}／解析行數 ${stats.lines}／剝除 IAC ${stats.iacStripped} 組`);
  console.log(`UTF-8 解碼異常行數：${stats.invalidUtf8}`);

  console.log('\n── opcode 分佈 ──');
  for (const [op, n] of [...stats.byOpcode].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(op).padEnd(6)} × ${n}`);
  }

  console.log('\n── 分派事件 ──');
  for (const [t, n] of [...stats.byType].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(22)} × ${n}`);
  }

  console.log(`\n── 樣式：連結 ${stats.links.length} 個、字級 ${stats.sizes} 個 ──`);
  for (const l of stats.links.slice(0, 8)) console.log(`  ${JSON.stringify(l)}`);

  if (samples.length) {
    console.log('\n── 帶 opcode 的實際封包樣本 ──');
    for (const s of samples.slice(0, 20)) {
      console.log(`  [${s.op}] → ${s.type}`);
      console.log(`        ${JSON.stringify(s.raw)}`);
    }
  }

  console.log(`\n── 解析失敗：${stats.failures.length} ──`);
  for (const f of stats.failures.slice(0, 10)) console.log('  ✖ ' + f);
  console.log(stats.failures.length === 0 ? '\n✅ 全部行皆成功解析\n' : '\n❌ 有解析問題\n');
  process.exit(0);
}
