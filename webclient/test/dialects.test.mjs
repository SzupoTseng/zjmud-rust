// 擴充方言測試 —— 支援 zjmud-collection 裡的新協議 mudlib。
//
// 資料來源：zjmud-collection-master 內 16 份 include/zjmud.h 交叉比對，
// 並以各 mudlib 的 .c 實際使用情形過濾（定義了但沒用的不算）。
//
// 統計結果：
//   * 收藏中實際被使用的 opcode 共 83 個
//   * 其中 27 個是「經典核心」，14 個 mudlib 共用
//   * 另 61 個只出現在 `大梦江湖(新协议版)`（nt7 定義 102 個但一個都沒用）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeLine, parseLine, isChallenge, buildLoginLine, buildCharLine,
} from '../src/js/protocol.js';
import {
  PROFILES, PANEL_TITLE, lookupExtended, extendedCount, KIND,
  setDialect, getDialect, detectDialect, totalOpcodeCoverage, conflictingOpcodes,
} from '../src/js/dialects.js';

/** 目前 profile 的擴充表。 */
const EXTENDED = () => PROFILES[getDialect()].ext;

const E = '\u001b';

// ══ opcode 解析：非數字碼 ═════════════════════════════

test('★ 非數字 opcode 也要被辨識（10a / 11a / 2k1–2k4）', () => {
  // 原本寫成 /^\d{3}$/，這些碼會整段被當成一般訊息印出亂碼
  for (const op of ['10a', '11a', '2k1', '2k2', '2k3', '2k4']) {
    const r = parseLine(`${E}${op}內容`);
    assert.equal(r.op, op, `${op} 應被辨識為 opcode`);
    assert.equal(r.payload, '內容');
  }
});

test('三個字元以外的仍不算 opcode', () => {
  assert.equal(parseLine(`${E}[31m紅`).op, null, 'ANSI 樣式碼不可被誤判');
  assert.equal(parseLine(`${E}12`).op, null, '長度不足');
  assert.equal(parseLine(`${E}中文字`).op, null, '非英數字元');
});

// ══ 方言表本身 ═══════════════════════════════════════

test('方言表涵蓋分析出的擴充 opcode', () => {
  assert.ok(extendedCount() >= 60, `應涵蓋 60+ 個，實得 ${extendedCount()}`);
});

test('方言表每筆都有合法的 kind 與 panel', () => {
  const kinds = new Set(Object.values(KIND));
  const NO_PANEL = new Set([KIND.MESSAGE, KIND.CLEAR_MAIN, KIND.RELOGIN, KIND.NETSTAT,
                            KIND.HINT, KIND.DAMAGE, KIND.STORY, KIND.VIBRATE, KIND.IGNORE]);
  for (const p of Object.values(PROFILES)) {
   for (const [op, def] of Object.entries(p.ext)) {
    assert.ok(kinds.has(def.kind), `${op} 的 kind 不合法：${def.kind}`);
    assert.ok(def.name, `${op} 缺 macro 名`);
    if (!NO_PANEL.has(def.kind)) {
      assert.ok(def.panel, `${op} 缺 panel`);
      assert.ok(PANEL_TITLE[def.panel], `${op} 的 panel「${def.panel}」沒有中文標題`);
    }
   }
  }
});

test('核心 opcode 不可被方言表覆蓋', () => {
  const core = ['000','001','002','003','004','005','006','007','008','009','010','011',
                '012','013','014','015','016','017','020','021','022','023','100','999'];
  for (const op of core) {
    assert.equal(lookupExtended(op), null, `核心 opcode ${op} 不該出現在擴充表`);
  }
});

// ══ 各泛型結構的解析 ═════════════════════════════════

test('TITLE：XYRWNAME(417) → panel.title', () => {
  const ev = decodeLine(`${E}417${E}[1;33m王掌櫃${E}[0m`);
  assert.equal(ev.type, 'panel.title');
  assert.equal(ev.panel, 'person');
  assert.equal(ev.macro, 'XYRWNAME');
  assert.match(ev.text, /王掌櫃/);
});

test('TEXT：XYRWMIAO(418) → panel.text，帶 slot', () => {
  const ev = decodeLine(`${E}418他捻著鬍鬚。$br#笑而不語。`);
  assert.equal(ev.type, 'panel.text');
  assert.equal(ev.panel, 'person');
  assert.equal(ev.slot, 'detail');
});

test('LIST：XYZFBLIE(272) → panel.list，label:cmd', () => {
  const ev = decodeLine(`${E}272新手副本:enter fb1$zj#進階副本:enter fb2`);
  assert.equal(ev.type, 'panel.list');
  assert.equal(ev.panel, 'instance');
  assert.equal(ev.items.length, 2);
  assert.deepEqual(ev.items[0], { label: '新手副本', cmd: 'enter fb1' });
});

test('ACTIONS：XYBEIBAO(347) → panel.actions，含版面前綴', () => {
  const ev = decodeLine(`${E}347$3,3,9,30#長劍|1把:li sword$zj#傷藥|5瓶:li yao`);
  assert.equal(ev.type, 'panel.actions');
  assert.equal(ev.panel, 'bag');
  assert.deepEqual(ev.layout, { cols: 3, widthDiv: 3, heightDiv: 9, fontDiv: 30 });
  assert.equal(ev.items[0].title, '長劍');
  assert.equal(ev.items[0].sub, '1把');
  assert.equal(ev.items[0].cmd, 'li sword');
});

test('BARS：XJTILI(521) → panel.bars，複用 ESC012 的解析', () => {
  const ev = decodeLine(`${E}521$2,0,22,35#體力:80/100/100:#99FF0000║內力:50/60/60:#990066FF`);
  assert.equal(ev.type, 'panel.bars');
  assert.equal(ev.panel, 'combat');
  assert.equal(ev.bars.length, 2);
  assert.equal(ev.bars[0].mode, 'dual');
  assert.equal(ev.bars[0].max, 100);
});

test('★ ENTITY_ADD：XYKILL(511) → 敵方實體，含血條', () => {
  // 實測形狀（大梦江湖）：`檔名$zj#名字$zj#氣:最大氣:上限`
  const ev = decodeLine(`${E}511/d/city/npc/wolf#12$zj#野狼$zj#80:100:100`);
  assert.equal(ev.type, 'panel.entityAdd');
  assert.equal(ev.side, 'enemy');
  assert.equal(ev.id, '/d/city/npc/wolf#12', '物件 id 含 / 與 # 不可被切壞');
  assert.equal(ev.label, '野狼');
  assert.deepEqual(ev.bar, { a: 80, b: 100, max: 100 });
});

test('ENTITY_ADD：XYKILLDY(513) 是我方', () => {
  const ev = decodeLine(`${E}513/u/player#3$zj#同伴$zj#50:60:60`);
  assert.equal(ev.side, 'ally');
});

test('ENTITY_DEL：XYKILLD(512) → 依 id 移除', () => {
  const ev = decodeLine(`${E}512/d/city/npc/wolf#12`);
  assert.equal(ev.type, 'panel.entityDel');
  assert.equal(ev.side, 'enemy');
  assert.equal(ev.id, '/d/city/npc/wolf#12');
});

test('CLOSE：KILLEND(516) → 關閉戰鬥面板', () => {
  const ev = decodeLine(`${E}516`);
  assert.equal(ev.type, 'panel.close');
  assert.equal(ev.panel, 'combat');
});

test('MESSAGE：XYKILLMIAO(515) 進戰鬥頻道、XYTISHI(130) 進系統頻道', () => {
  assert.equal(decodeLine(`${E}515你一劍刺出`).type, 'msg.combat');
  assert.equal(decodeLine(`${E}130提示訊息`).type, 'msg.toast');
  assert.equal(decodeLine(`${E}496某某上線了`).type, 'msg.chat');
});

test('非數字 opcode 走完整解析：2k1 → panel.text', () => {
  const ev = decodeLine(`${E}2k1樣式一的內容`);
  assert.equal(ev.type, 'panel.text');
  assert.equal(ev.panel, 'attr');
  assert.equal(ev.macro, 'XJYS1');
  assert.equal(ev.text, '樣式一的內容');
});

// ══ 相容性與降級 ═════════════════════════════════════

test('★ 經典 mudlib 行為完全不變（無退化）', () => {
  assert.equal(decodeLine(`${E}002客棧`).type, 'room.title');
  assert.equal(decodeLine(`${E}005店小二:look xiaoer`).type, 'room.objects');
  assert.equal(decodeLine(`${E}012氣血:1/2:#fff`).type, 'stat.bars');
  assert.equal(decodeLine(`${E}100聊天`).type, 'msg.chat');
});

test('真正未知的 opcode 仍降級為主訊息且內容完整', () => {
  const ev = decodeLine(`${E}zzz某些新東西`);
  assert.equal(ev.type, 'msg.main');
  assert.equal(ev.text, `${E}zzz某些新東西`);
  assert.equal(ev.unknownOpcode, 'zzz', '應標記出未知碼，方便日後補進方言表');
});

test('擴充 opcode 空 payload 不炸', () => {
  for (const op of Object.keys(EXTENDED())) {
    assert.doesNotThrow(() => decodeLine(E + op), `opcode ${op} 空 payload 應可處理`);
  }
});

test('擴充 opcode 畸形 payload 不炸', () => {
  for (const op of Object.keys(EXTENDED())) {
    assert.doesNotThrow(() => decodeLine(`${E}${op}$zj#$zj#:::|||`), `opcode ${op} 畸形輸入`);
  }
});

// ══ 方言 profile ═════════════════════════════════════

test('★ 402-605 在兩個方言中意義不同，必須被隔離', () => {
  const conflicts = conflictingOpcodes();
  const ops = conflicts.map((c) => c.op).sort();
  assert.deepEqual(ops, ['602', '603', '604', '605'],
    '已知衝突就是這四個；若多出來代表新加的方言撞號了');

  for (const c of conflicts) {
    const macros = c.defs.map((d) => d.macro);
    assert.equal(new Set(macros).size, macros.length, `${c.op} 的巨集名應各不相同`);
  }
});

test('★ 切換 profile 後同一個 opcode 解出不同語意', () => {
  const before = getDialect();
  try {
    setDialect('dmjh');
    const a = lookupExtended('605');
    assert.equal(a.name, 'DMZHUJIU', '大梦江湖的 605 是主頁公告');
    assert.equal(a.kind, KIND.TEXT);

    setDialect('zymud');
    const b = lookupExtended('605');
    assert.equal(b.name, 'ZYCLEARSCREEN', '指游的 605 是清空主畫面');
    assert.equal(b.kind, KIND.CLEAR_MAIN);
  } finally {
    setDialect(before);
  }
});

test('★ 依版本挑戰自動判別方言', () => {
  assert.equal(detectDialect('ver1.0:byz0rmpISExtQ'), 'dmjh', 'LPMud-Name 用冒號');
  assert.equal(detectDialect('ver1.0,abcdef'), 'dmjh', '官方文件用逗號');
  assert.equal(detectDialect('version 1.0 key::abcdef'), 'zymud', '指游用 version 1.0 key::');
});

test('三個 profile 合計涵蓋的 opcode', () => {
  assert.ok(totalOpcodeCoverage() >= 85, `合計應 85+，實得 ${totalOpcodeCoverage()}`);
});

// ══ 指游 ZY 方言 ═════════════════════════════════════

test('★ ZYMAP 是 4 字元 opcode（1085）', () => {
  const before = getDialect();
  try {
    setDialect('zymud');
    const r = parseLine(`${E}1085地圖內容`);
    assert.equal(r.op, '1085', '4 字元 opcode 必須被辨識');
    assert.equal(r.payload, '地圖內容');

    const ev = decodeLine(`${E}1085地圖內容`);
    assert.equal(ev.type, 'panel.text');
    assert.equal(ev.panel, 'map');
  } finally { setDialect(before); }
});

test('4 字元判別不會誤傷正常的 3 字元 opcode', () => {
  // ESC004 後面接 "5..." 不可被誤讀成 ESC0045
  const ev = decodeLine(`${E}0045 個人站在這裡`);
  assert.equal(ev.type, 'room.desc', 'ESC004 + 內容「5 個人…」');
  assert.equal(ev.text, '5 個人站在這裡');
});

test('★ ZYATTACK(613)：目標$zj#訊息$zj#顏色$zj#持續ms', () => {
  const before = getDialect();
  try {
    setDialect('zymud');
    const ev = decodeLine(`${E}613look /d/npc/wolf#1$zj#-37$zj##ff4444$zj#1500`);
    assert.equal(ev.type, 'msg.float');
    assert.equal(ev.target, 'look /d/npc/wolf#1');
    assert.equal(ev.text, '-37');
    assert.equal(ev.color, '#ff4444');
    assert.equal(ev.durationMs, 1500);
  } finally { setDialect(before); }
});

test('★ ZYSTORYTEXT(615)：逐字劇情與關閉', () => {
  const before = getDialect();
  try {
    setDialect('zymud');
    const ev = decodeLine(`${E}615從前有座山$zj#120$zj##000000`);
    assert.equal(ev.type, 'overlay.story');
    assert.equal(ev.text, '從前有座山');
    assert.equal(ev.speedMs, 120);
    assert.equal(ev.background, '#000000');

    // 速度省略時用官方預設 80ms/字
    assert.equal(decodeLine(`${E}615只有文字`).speedMs, 80);
    // 單獨送 close 表示關閉
    assert.equal(decodeLine(`${E}615close`).type, 'overlay.storyClose');
  } finally { setDialect(before); }
});

test('ZY 客戶端能力類：清畫面／重登／震動／網路狀態', () => {
  const before = getDialect();
  try {
    setDialect('zymud');
    assert.equal(decodeLine(`${E}605`).type, 'ui.clearMain');
    assert.equal(decodeLine(`${E}6092000`).delayMs, 2000);
    assert.equal(decodeLine(`${E}616300`).durationMs, 300);
    assert.equal(decodeLine(`${E}611開啟`).enabled, true);
    assert.equal(decodeLine(`${E}611關閉`).enabled, false);
    assert.equal(decodeLine(`${E}607任何內容`).type, 'ui.ignored', '官方標為未實現');
  } finally { setDialect(before); }
});

test('ZYSELECT(612)：元件提示 `.選擇器|說明`', () => {
  const before = getDialect();
  try {
    setDialect('zymud');
    const ev = decodeLine(`${E}612.mainChannelView|聊天信息区域$zj#.exitPad|出口`);
    assert.equal(ev.type, 'ui.hint');
    assert.equal(ev.items.length, 2);
    assert.deepEqual(ev.items[0], { selector: '.mainChannelView', text: '聊天信息区域' });
  } finally { setDialect(before); }
});

// ══ 登入握手變體 ═════════════════════════════════════

test('★ 三種版本挑戰都要認得', () => {
  for (const c of ['ver1.0:abc', 'ver1.0,abc', 'version 1.0 key::abc']) {
    assert.equal(isChallenge(c), true, `應辨識：${c}`);
  }
  assert.equal(isChallenge('一般訊息'), false);
});

test('★ 登入行 3 欄／4 欄兩種格式', () => {
  const a = buildLoginLine({ id: 'u1', password: 'p1', email: 'a@b.c' });
  assert.equal(a, 'u1\u2551p1\u2551byname666\u2551a@b.c', '預設 4 欄');

  const b = buildLoginLine({ id: 'u1', password: 'p1', fields: 3 });
  assert.equal(b, 'u1\u2551p1\u2551byname666', '官方文件版是 3 欄');
});

test('★ 建角行 2 欄／3 欄兩種格式', () => {
  assert.equal(buildCharLine({ sex: '男', name: '大俠' }), '男\u2551\u2551大俠',
    '經典是 性別║頭像║暱稱');
  assert.equal(buildCharLine({ sex: '男', name: '大俠', fields: 2 }), '男\u2551大俠',
    '指游只送 性別║暱稱');
});
