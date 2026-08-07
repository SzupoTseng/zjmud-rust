// 協議與樣式解析器的單元測試。
// 執行：node --test test/
//
// 這兩個模組是純函式，不需要 DOM 也不需要連線，是整個客戶端最該被測的部分。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseStyled, stripStyles, classifyLink, ESC } from '../src/js/ansi.js';
import {
  parseLine, takeLayout, decodeLine, parseDialog, expandDialogCommands,
  expandInputTemplate, __test__,
} from '../src/js/protocol.js';

const E = ESC;

// ══ ansi.js ═══════════════════════════════════════════

test('ansi: 純文字不含 ESC 時原樣輸出', () => {
  const { spans } = parseStyled('你好，江湖');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, '你好，江湖');
  assert.equal(spans[0].style.fg, null);
});

test('ansi: 標準前景色使用自訂調色盤', () => {
  const { spans } = parseStyled(`${E}[32m綠字${E}[0m`);
  assert.equal(spans[0].text, '綠字');
  assert.equal(spans[0].style.fg, '#00bb00');
});

test('ansi: 高亮前景色', () => {
  const { spans } = parseStyled(`${E}[1;31m亮紅${E}[0m`);
  assert.equal(spans[0].style.fg, '#ff3300');
});

test('ansi: [0m 重置全部樣式', () => {
  const { spans } = parseStyled(`${E}[1m${E}[31m紅粗${E}[0m普通`);
  assert.equal(spans[0].style.bold, true);
  assert.equal(spans[0].style.fg, '#aa3300');
  assert.equal(spans[1].text, '普通');
  assert.equal(spans[1].style.bold, false);
  assert.equal(spans[1].style.fg, null);
});

test('ansi: 樣式跨段延續直到重置', () => {
  const { spans } = parseStyled(`${E}[33m甲${E}[1m乙${E}[0m丙`);
  assert.equal(spans[0].style.fg, '#eeee00');
  assert.equal(spans[1].style.fg, '#eeee00', '乙 應延續前一段的黃色');
  assert.equal(spans[1].style.bold, true);
  assert.equal(spans[2].style.fg, null);
});

test('ansi: 白天模式把綠/黃/青/白改寫為藍', () => {
  const day = parseStyled(`${E}[32m綠`, { dayMode: true });
  assert.equal(day.spans[0].style.fg, '#0000aa', '綠應被改寫成藍');
  const night = parseStyled(`${E}[32m綠`, { dayMode: false });
  assert.equal(night.spans[0].style.fg, '#00bb00');
});

test('ansi: 自訂前景/背景色 [f# / [b#', () => {
  const fg = parseStyled(`${E}[f#ff8800m橙`);
  assert.equal(fg.spans[0].style.fg, '#ff8800');
  const bg = parseStyled(`${E}[b#112233m底`);
  assert.equal(bg.spans[0].style.bg, '#112233');
});

test('ansi: ARGB 色碼轉成 CSS 的 RGBA 順序', () => {
  const { spans } = parseStyled(`${E}[f#99aa3300m半透明`);
  assert.equal(spans[0].style.fg, '#aa330099', 'alpha 應從頭搬到尾');
});

test('ansi: [u:<url>] 超連結 —— 伺服器巨集 ZJURL 帶冒號', () => {
  // world/include/zjmud.h: #define ZJURL(w) ESA + "[u:" + w + "]"
  const { spans } = parseStyled(`${E}[u:cmds:look sword]寶劍${E}[0m`);
  assert.equal(spans[0].text, '寶劍');
  assert.equal(spans[0].style.link, 'cmds:look sword', '冒號應被剝除，不可留在 URL 前面');
});

test('ansi: [u<url>] 無冒號寫法也要相容', () => {
  const { spans } = parseStyled(`${E}[ucmds:look sword]寶劍`);
  assert.equal(spans[0].style.link, 'cmds:look sword');
});

test('ansi: [s:<n>] 字級 —— 伺服器巨集 ZJSIZE 帶冒號', () => {
  // world/adm/daemons/channeld.c 大量使用 ZJSIZE(27)
  const { spans } = parseStyled(`${E}[s:15]大字`);
  assert.equal(spans[0].text, '大字');
  assert.equal(spans[0].style.size, 2, '30/15；若冒號沒剝掉會 parseInt 失敗變 null');
});

test('ansi: [s<n>] 無冒號寫法也要相容', () => {
  const { spans } = parseStyled(`${E}[s15]大字`);
  assert.equal(spans[0].style.size, 2);
});

test('ansi: [2J 回報 clearScreen', () => {
  const r = parseStyled(`${E}[2J新畫面`);
  assert.equal(r.clearScreen, true);
  assert.equal(r.spans[0].text, '新畫面');
});

test('ansi: [9m 全形模式轉換 ASCII', () => {
  const { spans } = parseStyled(`${E}[9mAB1`);
  assert.equal(spans[0].text, 'ＡＢ１');
});

test('ansi: 行首 ESC[2;37;0m 前綴被剝除且重置樣式', () => {
  const { spans } = parseStyled(`${E}[2;37;0m乾淨`);
  assert.equal(spans[0].text, '乾淨');
  assert.equal(spans[0].style.fg, null);
});

test('ansi: 無法辨識的樣式碼降級 —— 保留文字不丟棄', () => {
  const { spans } = parseStyled(`${E}[999m文字還在`);
  assert.equal(spans.map((s) => s.text).join(''), '文字還在');
});

test('ansi: stripStyles 取出純文字', () => {
  assert.equal(stripStyles(`${E}[1;32m你好${E}[0m世界`), '你好世界');
});

test('ansi: classifyLink 依 scheme 分類', () => {
  assert.deepEqual(classifyLink('cmds:kill wolf'), { kind: 'cmd', value: 'kill wolf' });
  assert.deepEqual(classifyLink('pops:a|b'), { kind: 'pop', value: 'a|b' });
  assert.deepEqual(classifyLink('voice:x.amr'), { kind: 'voice', value: 'x.amr' });
  assert.deepEqual(classifyLink('http://x'), { kind: 'external', value: 'http://x' });
});

// ══ protocol.js：分幀 ══════════════════════════════════

test('protocol: parseLine 擷取 opcode 與 payload', () => {
  assert.deepEqual(parseLine(`${E}003north:北`), { op: '003', payload: 'north:北', resetStyles: false });
});

test('protocol: 無 opcode 的行 op 為 null', () => {
  const r = parseLine('這是一般訊息');
  assert.equal(r.op, null);
  assert.equal(r.payload, '這是一般訊息');
});

test('protocol: 行首重置前綴不影響 opcode 擷取', () => {
  const r = parseLine(`${E}[2;37;0m${E}002客棧`);
  assert.equal(r.op, '002');
  assert.equal(r.payload, '客棧');
  assert.equal(r.resetStyles, true);
});

test('protocol: ESC 後非三位數字不算 opcode', () => {
  assert.equal(parseLine(`${E}[31m紅`).op, null);
});

// ══ protocol.js：版面前綴 ══════════════════════════════

test('protocol: takeLayout 解析 $a,b,c,d# 前綴', () => {
  const r = takeLayout('$3,4,9,30#內容', [1, 3, 9, 30]);
  assert.deepEqual(r.layout, [3, 4, 9, 30]);
  assert.equal(r.rest, '內容');
});

test('protocol: 無前綴時使用預設值', () => {
  const r = takeLayout('內容', [1, 3, 9, 30]);
  assert.deepEqual(r.layout, [1, 3, 9, 30]);
  assert.equal(r.rest, '內容');
});

// ══ protocol.js：各 opcode ════════════════════════════

test('opcode 003: 出口第 3 欄省略時指令等於方向鍵', () => {
  const ev = decodeLine(`${E}003north:北面$zj#enter:進入:enter inn`);
  assert.equal(ev.type, 'room.exits');
  assert.deepEqual(ev.exits[0], { dir: 'north', slot: 'n', label: '北面', cmd: 'north' });
  assert.deepEqual(ev.exits[1], { dir: 'enter', slot: null, label: '進入', cmd: 'enter inn' });
});

test('opcode 003: northup/northdown 共用北鍵位置', () => {
  const ev = decodeLine(`${E}003northup:上坡$zj#eastdown:下坡`);
  assert.equal(ev.exits[0].slot, 'n');
  assert.equal(ev.exits[1].slot, 'e');
});

test('opcode 005: 物件標籤可含冒號（只切第一個）', () => {
  const ev = decodeLine(`${E}005店小二:look xiaoer$zj#告示:read sign:2`);
  assert.equal(ev.type, 'room.objects');
  assert.deepEqual(ev.objects[0], { label: '店小二', cmd: 'look xiaoer' });
  assert.deepEqual(ev.objects[1], { label: '告示', cmd: 'read sign:2' });
});

test('opcode 006: 自訂按鈕含 bs 槽位', () => {
  const ev = decodeLine(`${E}006bs::look here$zj#b1:查看$br#屬性:score`);
  assert.equal(ev.type, 'ui.quickButtons');
  assert.deepEqual(ev.buttons[0], { slot: 'bs', label: '', cmd: 'look here' });
  assert.deepEqual(ev.buttons[1], { slot: 'b1', label: '查看\n屬性', cmd: 'score' });
});

test('opcode 012: 三段式數值產生雙層條', () => {
  const ev = decodeLine(`${E}012$2,0,22,35#氣血:180/190/200:#ff0000:hp║內力:95/120:#0000ff`);
  assert.equal(ev.type, 'stat.bars');
  assert.equal(ev.layout.cols, 2);
  assert.deepEqual(ev.bars[0], {
    label: '氣血', a: 180, b: 190, max: 200, color: '#ff0000', cmd: 'hp', mode: 'dual',
  });
  assert.equal(ev.bars[1].mode, 'single');
  assert.equal(ev.bars[1].max, 120);
});

test('opcode 012: 單一數值不畫條', () => {
  const ev = decodeLine(`${E}012等級:85:#ffffff`);
  assert.equal(ev.bars[0].mode, 'text');
  assert.equal(ev.bars[0].text, '85');
});

test('opcode 012: 未指定欄數時預設兩列', () => {
  const ev = decodeLine(`${E}012a:1/2:#fff║b:1/2:#fff║c:1/2:#fff║d:1/2:#fff`);
  assert.equal(ev.layout.cols, 2, '4 筆資料應排成 2 欄（即 2 列）');
});

test('opcode 020: 彈出選單用 $z2# 而非 $zj#', () => {
  const ev = decodeLine(`${E}020$2,2,8,25#買酒|buy wine$z2#賣酒|sell wine`);
  assert.equal(ev.type, 'overlay.popMenu');
  assert.equal(ev.items.length, 2);
  assert.deepEqual(ev.items[0], { label: '買酒', cmd: 'buy wine' });
});

test('opcode 008: 動作列副標題與 keepOpen 旗標', () => {
  const ev = decodeLine(`${E}008$3,3,9,30#買酒|10兩:buy wine$txt#$zj#離開:leave`);
  assert.equal(ev.type, 'overlay.actions');
  assert.equal(ev.column, 1);
  assert.equal(ev.items[0].title, '買酒');
  assert.equal(ev.items[0].sub, '10兩');
  assert.equal(ev.items[0].keepOpen, true);
  assert.equal(ev.items[1].keepOpen, false);
});

test('opcode 008: 指令欄含 ESC020 時轉為彈出選單', () => {
  const ev = decodeLine(`${E}008選單:${E}020甲|a$z2#乙|b`);
  assert.equal(ev.items[0].popup, '甲|a$z2#乙|b');
});

test('opcode 022: 血條更新', () => {
  const ev = decodeLine(`${E}022kill wolf$zj#30:50:100`);
  assert.deepEqual(ev, { type: 'room.objectBar', tag: 'kill wolf', a: 30, b: 50, max: 100 });
});

test('opcode 000: 重连完毕 觸發自動 look', () => {
  const ev = decodeLine(`${E}000重连完毕`);
  assert.equal(ev.reloginLook, true);
  assert.equal(decodeLine(`${E}000其他`).reloginLook, false);
});

test('opcode 900: 換伺服器解析 ip:port', () => {
  const ev = decodeLine(`${E}900192.168.1.10:6666`);
  assert.deepEqual(ev, { type: 'conn.relocate', host: '192.168.1.10', port: 6666 });
});

test('opcode 997/998: 單行/多行模式開關', () => {
  assert.deepEqual(decodeLine(`${E}997`), { type: 'conn.multiline', value: false });
  assert.deepEqual(decodeLine(`${E}998`), { type: 'conn.multiline', value: true });
});

test('opcode 023: 屏蔽描述', () => {
  assert.equal(decodeLine(`${E}023屏蔽描述`).hidden, true);
  assert.equal(decodeLine(`${E}023顯示`).hidden, false);
});

test('未知 opcode 降級為主訊息且不遺失內容', () => {
  const ev = decodeLine(`${E}555某些新東西`);
  assert.equal(ev.type, 'msg.main');
  assert.equal(ev.text, `${E}555某些新東西`, '原始內容應完整保留');
});

test('opcode 006 只實作自訂按鈕語意（原版第二定義是 dead code）', () => {
  const ev = decodeLine(`${E}006b1:標籤:cmd`);
  assert.equal(ev.type, 'ui.quickButtons');
});

// ══ protocol.js：對話框 ════════════════════════════════

test('dialog: 解析 ok/no/numb 與內容區塊', () => {
  const d = parseDialog('掌櫃問道：要幾壺？$dh#numb.$dh#ok11.buy $N tea$dh#no11.say 不用');
  assert.equal(d.needNumber, true);
  assert.deepEqual(d.okCmds, ['buy $N tea']);
  assert.equal(d.cancelCmd, 'say 不用');
  assert.equal(d.blocks[0].text, '掌櫃問道：要幾壺？');
});

test('dialog: numb. 單獨出現也要被辨識（原版長度判斷會漏掉）', () => {
  const d = parseDialog('內容$dh#numb.');
  assert.equal(d.needNumber, true);
  assert.ok(!d.blocks.some((b) => b.text === 'numb.'), 'numb. 不應被當成內容印出');
});

test('dialog: $exp# / $god# / $obj# 區塊', () => {
  const d = parseDialog('恭喜$br#$exp#經驗 +1000$br#$god#銀兩 -50$br#$obj#sword,jian,5');
  const kinds = d.blocks.map((b) => b.kind);
  assert.deepEqual(kinds, ['text', 'exp', 'money', 'item']);
  assert.deepEqual(d.blocks[3], { kind: 'item', tag: 'sword', image: 'jian', tier: 'gold' });
});

test('dialog: #RRGGBB 前綴的著色文字行', () => {
  const d = parseDialog('#ff0000危險！');
  assert.deepEqual(d.blocks[0], { kind: 'text', color: '#ff0000', text: '危險！' });
});

test('dialog: 多個 ok11. 累積成指令序列', () => {
  const d = parseDialog('內容$dh#ok11.cmd1$dh#ok11.cmd2');
  assert.deepEqual(expandDialogCommands(d.okCmds, null), ['cmd1', 'cmd2']);
});

test('dialog: $N 替換成數量後再拆指令', () => {
  const d = parseDialog('內容$dh#numb.$dh#ok11.buy $N tea');
  assert.deepEqual(expandDialogCommands(d.okCmds, 3), ['buy 3 tea']);
});

// ══ 健壯性 ════════════════════════════════════════════

test('健壯性: 空 payload 不炸', () => {
  for (const op of ['003', '005', '006', '012', '020', '021', '008']) {
    assert.doesNotThrow(() => decodeLine(E + op), `opcode ${op} 空 payload 應可處理`);
  }
});

test('健壯性: 畸形欄位不炸', () => {
  assert.doesNotThrow(() => decodeLine(`${E}012壞掉的:::::`));
  assert.doesNotThrow(() => decodeLine(`${E}003$zj#$zj#`));
  assert.doesNotThrow(() => decodeLine(`${E}022沒有分隔符`));
  assert.doesNotThrow(() => parseDialog(''));
});

test('健壯性: 非字串輸入不炸', () => {
  assert.doesNotThrow(() => parseLine(null));
  assert.doesNotThrow(() => parseStyled(undefined));
  assert.doesNotThrow(() => takeLayout(null, [1, 2, 3, 4]));
});

test('健壯性: 方向表與品階表齊全', () => {
  assert.equal(Object.keys(__test__.DIR_SLOT).length, 16);
  assert.equal(Object.keys(__test__.ITEM_TIER).length, 7);
});

// ══ ESC001 輸入樣板（伺服器 INPUTTXT 語意）════════════

test('input: template 含 $txt# 時就地替換', () => {
  // world/adm/npc/ganjiang.c: INPUTTXT("請輸入…","name $txt#")
  assert.equal(expandInputTemplate('name $txt#', '張三 zhangsan'), 'name 張三 zhangsan');
});

test('input: template 不含 $txt# 時以空格接在後面', () => {
  assert.equal(expandInputTemplate('deposit', '500'), 'deposit 500');
});

test('input: $txt# 在中間也能正確替換', () => {
  // world/cmds/usr/liaotian.c: 頻道 id + " $txt#"
  assert.equal(expandInputTemplate('chat $txt# end', '你好'), 'chat 你好 end');
});

test('input: 空輸入不產生尾隨垃圾', () => {
  assert.equal(expandInputTemplate('name $txt#', ''), 'name ');
  assert.equal(expandInputTemplate('', 'abc'), 'abc');
});

test('input: 不可誤用對話框的 $N（兩者語意不同）', () => {
  assert.equal(expandInputTemplate('buy $N tea', '3'), 'buy $N tea 3',
    '$N 只屬於 ESC010 對話框，ESC001 不應處理它');
});

test('opcode 001: payload 切成 說明 + 指令樣板', () => {
  const ev = decodeLine(`${E}001你想寄售多少？$zj#jishou sword $txt#`);
  assert.equal(ev.type, 'overlay.prompt');
  assert.equal(ev.text, '你想寄售多少？');
  assert.equal(ev.template, 'jishou sword $txt#');
});

test('★ 游標控制 CSI 不得漏成字面亂碼（yanhuangwuhun 截圖）', () => {
  const E = '\u001b';
  // 使用者截圖的原形：伺服器抹掉回顯，網頁不該把控制碼印出來
  assert.equal(stripStyles(`${E}[256D${E}[K你好`), '你好');
  assert.equal(stripStyles(`${E}[K`), '');
  assert.equal(stripStyles(`${E}[2K清乾淨`), '清乾淨');
  assert.equal(stripStyles(`${E}[A${E}[B${E}[C${E}[D邊`), '邊');
  // ★ 後文含英文 m 時，舊碼會把 `[256D…m` 誤當 SGR，連正文一起吞掉
  assert.equal(stripStyles(`${E}[256Dmap 指令`), 'map 指令');
  // 不可誤傷：自訂色、SGR、連結、字級
  assert.equal(stripStyles(`${E}[f#00ff00m綠`), '綠');
  assert.equal(stripStyles(`${E}[b#000000m底`), '底');
  assert.equal(stripStyles(`${E}[1;33m黃${E}[0m`), '黃');
  assert.equal(stripStyles(`${E}[u:cmds:look]看`), '看');
  assert.equal(stripStyles(`${E}[s:15]大`), '大');
});

test('★ 游標定位 CSI（小寫 f）與存/復原游標不得漏出（sj 的地圖繪製）', () => {
  const E = '\u001b';
  // 實測 sj：dazuo 的回應裡整串游標定位原樣漏到畫面上
  assert.equal(stripStyles(`${E}[s${E}[7;0f${E}[1;0f天狼中心`), '天狼中心');
  assert.equal(stripStyles(`${E}[4;70f天狼大街`), '天狼大街');
  assert.equal(stripStyles(`${E}[u還原`), '還原');
  // 不可誤傷自訂碼：`[s:n]` 字級、`[u:url]` 連結、`[f#RRGGBBm` 前景色
  assert.equal(stripStyles(`${E}[s:15]大`), '大');
  assert.equal(stripStyles(`${E}[u:cmds:look]看`), '看');
  assert.equal(stripStyles(`${E}[f#00ff00m綠`), '綠');
});
