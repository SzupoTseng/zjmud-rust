// 實機探針：連上真實 ZJMUD 伺服器，把收到的每一行餵進客戶端解析器，
// 統計 opcode 分佈與解析失敗，用來驗證協議規格是否符合實際線路資料。
//
// 用法：node tools/live-probe.mjs [host] [port] [秒數] [指令...]
// 例：  node tools/live-probe.mjs 127.0.0.1 5001 8

import net from 'node:net';
import { decodeLine, parseLine } from '../src/js/protocol.js';
import { parseStyled } from '../src/js/ansi.js';

const HOST = process.argv[2] || '127.0.0.1';
const PORT = Number(process.argv[3]) || 5001;
const SECS = Number(process.argv[4]) || 8;
const CMDS = process.argv.slice(5);

const stats = { lines: 0, byOpcode: new Map(), byType: new Map(), failures: [], links: 0, sizes: 0 };
const samples = [];

const sock = net.createConnection(PORT, HOST);
sock.setEncoding('utf8');

let buf = '';
sock.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).replace(/\r$/, '');
    buf = buf.slice(i + 1);
    handle(line);
  }
});

function handle(line) {
  stats.lines += 1;
  const { op } = parseLine(line);
  const key = op ?? '(無)';
  stats.byOpcode.set(key, (stats.byOpcode.get(key) ?? 0) + 1);

  try {
    const ev = decodeLine(line);
    stats.byType.set(ev.type, (stats.byType.get(ev.type) ?? 0) + 1);

    // 樣式層也要能解析
    const text = ev.text ?? ev.detail ?? '';
    if (typeof text === 'string' && text) {
      const { spans } = parseStyled(text);
      for (const s of spans) {
        if (s.style.link) {
          stats.links += 1;
          // 冒號沒剝乾淨的話會以 ':' 開頭 —— 這正是 v1.0 的 bug
          if (s.style.link.startsWith(':')) {
            stats.failures.push(`連結殘留冒號: ${JSON.stringify(s.style.link)}`);
          }
        }
        if (s.style.size != null) stats.sizes += 1;
      }
    }
    if (op && samples.length < 40) samples.push({ op, type: ev.type, raw: line.slice(0, 160) });
  } catch (err) {
    stats.failures.push(`${err.message} | ${JSON.stringify(line.slice(0, 120))}`);
  }
}

sock.on('connect', () => {
  console.log(`已連線 ${HOST}:${PORT}，擷取 ${SECS} 秒…\n`);
  let t = 800;
  for (const c of CMDS) {
    setTimeout(() => { sock.write(c + '\n'); console.log(`  → 送出 ${JSON.stringify(c)}`); }, t);
    t += 1200;
  }
  setTimeout(() => { sock.end(); report(); }, SECS * 1000);
});

sock.on('error', (e) => { console.error('連線錯誤：', e.message); process.exit(1); });

function report() {
  console.log('\n══════ 實機探針結果 ══════');
  console.log(`總行數：${stats.lines}`);

  console.log('\n── opcode 分佈 ──');
  for (const [op, n] of [...stats.byOpcode].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(op).padEnd(6)} × ${n}`);
  }

  console.log('\n── 分派事件 ──');
  for (const [t, n] of [...stats.byType].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(22)} × ${n}`);
  }

  console.log(`\n── 樣式 ──\n  連結 ${stats.links} 個，字級標記 ${stats.sizes} 個`);

  if (samples.length) {
    console.log('\n── 帶 opcode 的樣本 ──');
    for (const s of samples.slice(0, 12)) {
      console.log(`  [${s.op}] ${s.type}`);
      console.log(`        ${JSON.stringify(s.raw)}`);
    }
  }

  console.log(`\n── 解析失敗：${stats.failures.length} ──`);
  for (const f of stats.failures.slice(0, 10)) console.log('  ✖ ' + f);
  console.log(stats.failures.length === 0 ? '\n✅ 全部行皆成功解析\n' : '\n❌ 有解析問題\n');
  process.exit(stats.failures.length === 0 ? 0 : 1);
}
