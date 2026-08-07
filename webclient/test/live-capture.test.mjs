// 實機擷取回歸測試。
//
// 以下每一行都是 2026-07-28 從**真實 LPMud-Name 伺服器**
// （zjmud/lpc_mud-master/LPMud-Name/world，driver.exe，telnet :5001）
// 實際登入後擷取到的原始封包，一字未改。
//
// 這是整套測試裡最有價值的一組：它不是我對協議的理解，而是線路上真正跑的位元組。
// 任何一條在這裡失敗，就代表客戶端接真伺服器會出問題。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseStyled } from '../src/js/ansi.js';
import { decodeLine } from '../src/js/protocol.js';

const E = '\u001b';

// ── 真實擷取（原樣）────────────────────────────────────
const CAP = {
  title:  `${E}002${E}[2;37;0m${E}[1;31m阎罗殿${E}[2;37;0m${E}[2;37;0m`,
  desc:   `${E}004${E}[2;37;0m这里阴深恐怖，让人感觉到一阵阵的寒意，两旁列着牛头马面，冥府狱卒，各个威严肃穆。${E}[2;37;0m`,
  exits:  `${E}003update here:${E}[1;35m更新地图${E}[2;37;0m$zj#info here:查看本地地图资料$zj#`,
  npc:    `${E}005地藏王:look /d/register/npc/dizangwang#1686`,
  objs:   `${E}005天性:look 天性$zj#天赋:look 天赋$zj#设置邮箱:look 设置邮箱$zj#转生:look 转生`,
  bar:    `${E}022look /d/register/npc/dizangwang#1686$zj#850:850:850`,
  btns:   `${E}006b12:常用$br#指令${E}[2;37;0m:mycmds ofen$zj#b13:技能$br#相关${E}[2;37;0m:mycmds skill$zj#b14:战斗$br#相关${E}[2;37;0m:mycmds fight`,
  tt:     `${E}021飞行:help ditu$zj#客栈:recall$zj#门派:recalle$zj#回家:huijia$zj#附近:help ditus$zj#${E}[1;31m充值${E}[2;37;0m:paym_zh$zj#${E}[1;32m其${E}[1;36m他${E}[2;37;0m:help qt${E}[2;37;0m`,
  detail: `${E}007姓名：某某 (${E}[1;32mName${E}[2;37;0m) ${E}[2;37;0m${E}[1;33m\tLevel : ${E}[1;32m0${E}[u:cmds:uplv -l]${E}[s:26]${E}[1;33m【角色等级】${E}[2;37;0m$br#`,
  acts:   `${E}009$1,1,10,28#${E}[1;32m修改密码${E}[2;37;0m:changepasswd`,
  login7: `${E}0000007`,
  login8: `${E}0000008`,
  objRm:  `${E}905look 天性`,
};

// ── 房間 ──────────────────────────────────────────────

test('實機 ESC002：opcode 後面才接樣式重置碼', () => {
  // 注意順序是「opcode → ESC[2;37;0m」，不是文件裡假設的「ESC[2;37;0m → opcode」。
  // 兩種順序都必須能正確取出 opcode。
  const ev = decodeLine(CAP.title);
  assert.equal(ev.type, 'room.title');

  const { spans } = parseStyled(ev.text);
  assert.equal(spans.map((s) => s.text).join(''), '阎罗殿');
  assert.equal(spans[0].style.fg, '#ff3300', 'ESC[1;31m 應為高亮紅');
});

test('實機 ESC004：長描述含全形空白與尾端重置', () => {
  const ev = decodeLine(CAP.desc);
  assert.equal(ev.type, 'room.desc');
  const text = parseStyled(ev.text).spans.map((s) => s.text).join('');
  assert.match(text, /^这里阴深恐怖/);
  assert.match(text, /威严肃穆。$/, '尾端的 ESC[2;37;0m 應被吃掉不留殘字');
});

test('實機 ESC003：方向欄含空白、且尾端有空記錄', () => {
  const ev = decodeLine(CAP.exits);
  assert.equal(ev.type, 'room.exits');
  assert.equal(ev.exits.length, 2, '尾端的 $zj# 產生的空記錄必須被濾掉');

  // 「update here」不是羅盤方向 → 應歸到額外出口
  assert.equal(ev.exits[0].dir, 'update here');
  assert.equal(ev.exits[0].slot, null);
  assert.equal(ev.exits[0].cmd, 'update here', '第 3 欄省略時指令等於方向欄');

  const label = parseStyled(ev.exits[0].label).spans.map((s) => s.text).join('');
  assert.equal(label, '更新地图');
});

test('實機 ESC005：指令欄含 # 與 /，只能切第一個冒號', () => {
  const ev = decodeLine(CAP.npc);
  assert.equal(ev.type, 'room.objects');
  assert.equal(ev.objects.length, 1);
  assert.equal(ev.objects[0].label, '地藏王');
  assert.equal(ev.objects[0].cmd, 'look /d/register/npc/dizangwang#1686',
    'LPC 物件 id 帶 # 序號，不可被誤切');
});

test('實機 ESC005：多筆物件', () => {
  const ev = decodeLine(CAP.objs);
  assert.equal(ev.objects.length, 4);
  assert.deepEqual(ev.objects[0], { label: '天性', cmd: 'look 天性' });
});

test('實機 ESC022：血條 tag 與 ESC005 的 cmd 完全一致', () => {
  const objects = decodeLine(CAP.npc).objects;
  const bar = decodeLine(CAP.bar);
  assert.equal(bar.type, 'room.objectBar');
  assert.equal(bar.tag, objects[0].cmd, '血條要靠這個 tag 對上物件，兩者必須相等');
  assert.deepEqual({ a: bar.a, b: bar.b, max: bar.max }, { a: 850, b: 850, max: 850 });
});

test('實機 ESC905：依 cmd 移除物件', () => {
  const ev = decodeLine(CAP.objRm);
  assert.equal(ev.type, 'room.objectRemove');
  assert.equal(ev.tag, 'look 天性');
});

// ── 按鈕 ──────────────────────────────────────────────

test('實機 ESC006：b12+ 槽位、$br# 兩行標籤、標籤尾帶樣式碼', () => {
  const ev = decodeLine(CAP.btns);
  assert.equal(ev.type, 'ui.quickButtons');
  assert.equal(ev.buttons.length, 3);
  assert.equal(ev.buttons[0].slot, 'b12');
  assert.equal(ev.buttons[0].cmd, 'mycmds ofen');
  // $br# 應已轉成換行，標籤尾端的 ESC[2;37;0m 由樣式層處理
  assert.match(ev.buttons[0].label, /^常用\n指令/);
});

test('實機 ESC021：標題按鈕標籤含多段顏色', () => {
  const ev = decodeLine(CAP.tt);
  assert.equal(ev.type, 'ui.titleButtons');
  assert.equal(ev.buttons.length, 7);
  assert.deepEqual(ev.buttons[0], { label: '飞行', cmd: 'help ditu' });

  const last = ev.buttons[6];
  assert.equal(last.cmd, `help qt${E}[2;37;0m`);
  const text = parseStyled(last.label).spans.map((s) => s.text).join('');
  assert.equal(text, '其他', '兩段不同顏色的字應合成一個標籤');
});

// ── 樣式：這是 v1.0 解錯的地方 ─────────────────────────

test('實機 ESC007：[u: 與 [s: 的冒號 —— v1.0 的 bug 由實機資料證實', () => {
  const ev = decodeLine(CAP.detail);
  assert.equal(ev.type, 'overlay.detail');

  const { spans } = parseStyled(ev.text);

  const link = spans.find((s) => s.style.link);
  assert.ok(link, '應解析出連結');
  assert.equal(link.style.link, 'cmds:uplv -l',
    '若只跳 2 個字元會變成 ":cmds:uplv -l"，點擊完全失效');
  assert.ok(!link.style.link.startsWith(':'), '冒號必須剝乾淨');

  const sized = spans.find((s) => s.style.size != null);
  assert.ok(sized, '[s:26] 應解析出字級；只跳 2 字元會 parseInt(":26") → NaN → null');
  assert.equal(sized.style.size, +(30 / 26).toFixed(3));
});

test('實機 ESC009：版面前綴 $1,1,10,28#', () => {
  const ev = decodeLine(CAP.acts);
  assert.equal(ev.type, 'overlay.actions');
  assert.equal(ev.column, 2);
  assert.deepEqual(ev.layout, { cols: 1, widthDiv: 1, heightDiv: 10, fontDiv: 28 });
  assert.equal(ev.items.length, 1);
  assert.equal(ev.items[0].cmd, 'changepasswd');
});

// ── 登入狀態碼 ────────────────────────────────────────

test('實機 ESC000：登入狀態碼 0007／0008', () => {
  // world/adm/daemons/logind.c:241 = 登入成功、:268 = 需建立角色
  const ok = decodeLine(CAP.login7);
  assert.equal(ok.type, 'conn.notice');
  assert.equal(ok.text, '0007');
  assert.equal(ok.reloginLook, false, '數字狀態碼不應觸發自動 look');

  const needChar = decodeLine(CAP.login8);
  assert.equal(needChar.text, '0008');
});

// ── 全量：整批擷取都不能拋錯 ───────────────────────────

test('實機擷取全量：每一行都能解析且不拋錯', () => {
  for (const [name, line] of Object.entries(CAP)) {
    assert.doesNotThrow(() => {
      const ev = decodeLine(line);
      const t = ev.text ?? ev.detail ?? '';
      if (typeof t === 'string') parseStyled(t);
    }, `實機封包 ${name} 解析失敗`);
  }
});

test('實機擷取全量：沒有任何連結殘留前綴冒號', () => {
  for (const [name, line] of Object.entries(CAP)) {
    const ev = decodeLine(line);
    const t = ev.text ?? ev.detail ?? '';
    if (typeof t !== 'string' || !t) continue;
    for (const s of parseStyled(t).spans) {
      if (s.style.link) {
        assert.ok(!s.style.link.startsWith(':'), `${name} 的連結殘留冒號：${s.style.link}`);
      }
    }
  }
});
