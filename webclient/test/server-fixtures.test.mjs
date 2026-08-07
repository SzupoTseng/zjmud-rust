// 伺服器真實輸出的 fixtures 測試。
//
// 這裡的每一筆資料都是從 LPMud-Name 伺服器原始碼
// (zjmud/lpc_mud-master/LPMud-Name/world/) 抄出來、把巨集展開後的**實際輸出**，
// 用來驗證客戶端解析器和伺服器真的對得上。
//
// 巨集定義出處：world/include/zjmud.h
//   ESA        = ESC (U+001B)
//   ZJSEP      = "$zj#"      ZJSP2 = "$z2#"      ZJBR = "$br#"
//   ZJURL(w)   = ESA + "[u:" + w + "]"
//   ZJSIZE(n)  = ESA + "[s:" + n + "]"
//   ZJMENUF(r,w,h,s) = "$" + r + "," + w + "," + h + "," + s + "#"

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseStyled } from '../src/js/ansi.js';
import { decodeLine, expandInputTemplate } from '../src/js/protocol.js';

const E = '\u001b';

// 伺服器巨集，照 zjmud.h 原樣展開
const ZJSEP = '$zj#';
const ZJSP2 = '$z2#';
const ZJBR = '$br#';
const ZJURL = (w) => `${E}[u:${w}]`;
const ZJSIZE = (n) => `${E}[s:${n}]`;
const ZJMENUF = (r, w, h, s) => `$${r},${w},${h},${s}#`;
const NOR = `${E}[0m`;
const HIY = `${E}[1;33m`;
const HIW = `${E}[1;37m`;

const ZJOBLONG = `${E}007`;
const ZJOBACTS = `${E}008`;
const ZJOBACTS2 = `${E}009`;
const ZJHPTXT = `${E}012`;
const ZJCHANNEL = `${E}100`;
const ZJFORCECMD = (c) => `${E}014${c}\n`;
const INPUTTXT = (a, b) => `${E}001${a}${ZJSEP}${b}`;

// ══ adm/daemons/saled.c:79 ════════════════════════════
// 寄售類型選單。這是伺服器最常見的「詳情 + 動作列」組合。

test('fixture saled.c:79 —— ZJOBLONG + ZJOBACTS2 + ZJMENUF', () => {
  const arg = 'sword';
  const line1 = `${ZJOBLONG}如果售出成功，市场将收取您一成手续费。${ZJBR}请您选择寄售剑的类型:`;
  const line2 = `${ZJOBACTS2}${ZJMENUF(3, 3, 10, 30)}金币寄售:jishou ${arg} value 金币${ZJSEP}元宝寄售:jishou ${arg} value 元宝`;

  const d1 = decodeLine(line1);
  assert.equal(d1.type, 'overlay.detail');
  assert.match(d1.text, /一成手续费/);
  assert.match(d1.text, /\$br#/, '$br# 由 UI 層轉換，解析階段應原樣保留');

  const d2 = decodeLine(line2);
  assert.equal(d2.type, 'overlay.actions');
  assert.equal(d2.column, 2, 'ZJOBACTS2 應對到第二欄');
  assert.deepEqual(d2.layout, { cols: 3, widthDiv: 3, heightDiv: 10, fontDiv: 30 });
  assert.equal(d2.items.length, 2);
  assert.equal(d2.items[0].title, '金币寄售');
  assert.equal(d2.items[0].cmd, 'jishou sword value 金币');
  assert.equal(d2.items[1].cmd, 'jishou sword value 元宝');
});

// ══ cmds/usr/hp1.c:48-56 ══════════════════════════════
// 戰鬥中的屬性條。這是全協議最複雜的 payload。

test('fixture hp1.c —— ZJHPTXT 六欄屬性條，含 ARGB 色與三段式數值', () => {
  let sp = `${ZJHPTXT}${ZJMENUF(6, 6, 25, 40)}我：張三:100/100:#333333`;
  sp += `║气血.180:180/190/200:#99FF0000`;
  sp += `║内力.95:95/120/150:#990066FF`;
  sp += `║精神.60:60/80/80:#99990000`;
  sp += `║精力.40:40/100/100:#990066CC`;
  sp += `║忙乱.0:0/1:#BB3F51B5`;

  const ev = decodeLine(sp);
  assert.equal(ev.type, 'stat.bars');
  assert.equal(ev.layout.cols, 6, 'ZJMENUF 第 1 參數是每列幾個');
  assert.equal(ev.layout.heightDiv, 25, '第 3 參數是條高除數');
  assert.equal(ev.layout.fontDiv, 40, '第 4 參數是字級除數');
  assert.equal(ev.bars.length, 6);

  // 第 1 筆：標籤含全形冒號，不應被 ASCII 冒號切壞
  assert.equal(ev.bars[0].label, '我：張三');
  assert.equal(ev.bars[0].mode, 'single');

  // 第 2 筆：三段式 → 雙層條
  assert.deepEqual(
    { ...ev.bars[1] },
    { label: '气血.180', a: 180, b: 190, max: 200, color: '#99FF0000', cmd: null, mode: 'dual' },
  );

  // 最後一筆：兩段式 max=1
  assert.equal(ev.bars[5].mode, 'single');
  assert.equal(ev.bars[5].max, 1);
});

test('fixture hp1.c —— 伺服器的 8 位色碼是 ARGB，需轉成 CSS 的 RGBA', () => {
  // #99FF0000 = alpha 0x99 + 紅。直接丟給 CSS 會被當成 RGBA 而變成錯的顏色。
  const { spans } = parseStyled(`${E}[f#99FF0000m半透明紅`);
  assert.equal(spans[0].style.fg, '#FF000099');
});

// ══ adm/daemons/autonpc.c:184 ═════════════════════════
// 頻道訊息內嵌可點擊指令 —— ZJURL 帶冒號，這是最容易解錯的地方。

test('fixture autonpc.c:184 —— ZJURL 內嵌 cmds: 連結', () => {
  const line = `${ZJCHANNEL}飞贼出现了。${ZJURL('cmds:goto /d/city/wumiao')}飞过去${NOR}。`;

  const ev = decodeLine(line);
  assert.equal(ev.type, 'msg.chat');

  const { spans } = parseStyled(ev.text);
  const link = spans.find((s) => s.style.link);
  assert.ok(link, '應解析出一個連結');
  assert.equal(link.text, '飞过去');
  assert.equal(link.style.link, 'cmds:goto /d/city/wumiao',
    'ZJURL 的冒號必須剝除，否則會變成 ":cmds:goto …" 而點擊失效');
});

// ══ adm/daemons/channeld.c:481-532 ════════════════════
// 頻道稱號用 ZJSIZE 放大字級。

test('fixture channeld.c —— ZJSIZE(27) 字級', () => {
  const line = `${ZJCHANNEL}${HIY}${ZJSIZE(27)}掌门 ${NOR}${HIW}張三${NOR}：大家好`;

  const ev = decodeLine(line);
  assert.equal(ev.type, 'msg.chat');

  const { spans } = parseStyled(ev.text);
  const sized = spans.find((s) => s.style.size != null);
  assert.ok(sized, 'ZJSIZE 應產生字級樣式；若冒號沒剝掉會 parseInt 失敗而變 null');
  assert.equal(sized.style.size, +(30 / 27).toFixed(3));
});

// ══ adm/npc/ganjiang.c:444 ════════════════════════════
// 文字輸入面板 —— 證實 ESC001 用 $txt#，不是 $N。

test('fixture ganjiang.c:444 —— INPUTTXT 文字輸入與 $txt# 替換', () => {
  const line = INPUTTXT('请输入想设定的【中文名字 英文名字】：', 'name $txt#');

  const ev = decodeLine(line);
  assert.equal(ev.type, 'overlay.prompt');
  assert.equal(ev.text, '请输入想设定的【中文名字 英文名字】：');
  assert.equal(ev.template, 'name $txt#');

  // 使用者輸入的是自由文字（含空格），不是數字
  assert.equal(expandInputTemplate(ev.template, '張三 zhangsan'), 'name 張三 zhangsan');
});

test('fixture edroom.c:187 —— INPUTTXT 樣板中段帶參數', () => {
  const line = INPUTTXT('注意：升级需要消耗 3 块木料！', 'edroom size $txt#');
  const ev = decodeLine(line);
  assert.equal(expandInputTemplate(ev.template, '5'), 'edroom size 5');
});

test('fixture liaotian.c:111 —— 頻道輸入', () => {
  const ev = decodeLine(INPUTTXT('请输入聊天内容：', 'chat $txt#'));
  assert.equal(expandInputTemplate(ev.template, '大家好 我是新來的'), 'chat 大家好 我是新來的');
});

// ══ ZJFORCECMD ════════════════════════════════════════
// 伺服器要求客戶端代送指令，巨集會在尾端補一個 \n。

test('fixture ZJFORCECMD —— 尾端換行由分幀吃掉，payload 是純指令', () => {
  const raw = ZJFORCECMD('look');
  // 傳輸層以 \n 分幀，所以客戶端實際收到的是不含換行的那一段
  const framed = raw.split('\n')[0];
  const ev = decodeLine(framed);
  assert.equal(ev.type, 'conn.echo');
  assert.equal(ev.cmd, 'look');
});

// ══ 彈出選單 ══════════════════════════════════════════

test('fixture ZJPOPMENU —— 用 $z2# 分隔，與動作列的 $zj# 不同', () => {
  const line = `${E}020${ZJMENUF(2, 2, 8, 25)}买酒|buy wine${ZJSP2}卖酒|sell wine`;
  const ev = decodeLine(line);
  assert.equal(ev.type, 'overlay.popMenu');
  assert.equal(ev.items.length, 2);
  assert.deepEqual(ev.items[0], { label: '买酒', cmd: 'buy wine' });
});

// ══ 覆蓋率檢查 ════════════════════════════════════════

test('伺服器 zjmud.h 中所有啟用的 opcode 都有對應處理', () => {
  // 取自 world/include/zjmud.h 未被註解的 #define
  const SERVER_OPCODES = {
    '000': 'conn.notice',
    '001': 'overlay.prompt',
    '002': 'room.title',
    '003': 'room.exits',
    '903': 'room.exitRemove',
    '913': 'room.exitClear',
    '004': 'room.desc',
    '005': 'room.objects',
    '905': 'room.objectRemove',
    '006': 'ui.quickButtons',
    '007': 'overlay.detail',
    '008': 'overlay.actions',
    '009': 'overlay.actions',
    '010': 'overlay.dialog',
    '011': 'overlay.map',
    '012': 'stat.bars',
    '013': 'overlay.pagedText',
    '014': 'conn.echo',
    '015': 'msg.toast',
    '016': 'msg.combat',
    '017': 'msg.combatClose',
    '020': 'overlay.popMenu',
    '021': 'ui.titleButtons',
    '022': 'room.objectBar',
    '023': 'room.descToggle',
    '100': 'msg.chat',
    '999': 'conn.quit',
  };

  for (const [op, expected] of Object.entries(SERVER_OPCODES)) {
    // 給一個最小可解析的 payload，只驗證分派結果
    const payload = op === '022' ? `x${ZJSEP}1:2:3`
      : op === '001' ? `問題${ZJSEP}cmd $txt#`
      : op === '012' ? 'a:1/2:#fff'
      : 'x';
    const ev = decodeLine(E + op + payload);
    assert.equal(ev.type, expected, `opcode ${op} 應分派到 ${expected}，實得 ${ev.type}`);
  }

  assert.equal(Object.keys(SERVER_OPCODES).length, 27, '伺服器啟用中的 opcode 共 27 個');
});
