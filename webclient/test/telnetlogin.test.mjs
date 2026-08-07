// telnet 登入接應器 —— 以實錄回放驗證。
//
// 【WHY】每一條測試的輸入都是 driver 實跑東方故事Ⅱ收到的**原始行**（含 ANSI），
// 不是手寫的理想化提示。接應器的三次翻車全都是「真實輸出跟想像不一樣」：
// 種族選單讓 quiet 計數誤判完成、短密碼的拒絕提示沒對上規則、
// 密碼不一致後的第二次確認沒人答。回放實錄能把這一類問題釘死。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelnetLogin } from '../src/js/telnetlogin.js';

function run(profile, creds, serverLines) {
  const sent = [];
  // debounceMs: 0 讓測試維持同步；正式路徑用 60ms（見 createTelnetLogin 的 WHY）
  const tn = createTelnetLogin({ profile, creds, send: (l) => sent.push(l), debounceMs: 0 });
  for (const l of serverLines) tn.feed(l);
  return { sent, done: tn.done };
}

// 东方故事Ⅱ 實錄：正常流程（8 步 → `> `）
const HAPPY = [
  '您的英文名字：',
  '使用 wasmtest 这个名字将会创造一个新的人物，您确定吗(y/n)？',
  '请设定您的密码：',
  '请再输入一次您的密码，以确认您没记错：',
  '您的电子邮件地址：',
  '你现在共有 20 点业力，可以选择以下种族：',
  'jiaojao(jiaojao)          5 点业力',
  'human(human)              5 点业力',
  '你的选择：',
  '您要扮演男性(m)的角色或女性(f)的角色？',
  '您的中文名字：',
  '> ',
];

test('★ 东方故事Ⅱ：8 步全走完，種族選單不觸發假完成', () => {
  const { sent, done } = run('dongfanggushi2', { id: 'wasmtest01', pw: 'test1234' }, HAPPY);
  // 密碼會被補強成滿足「含大寫＋數字」的組合政策（書劍系要求），所以不比對字面值
  assert.deepEqual([sent[0], sent[1], sent[4], sent[5], sent[6], sent[7]],
    ['wasmtest', 'y', 'player@example.com', 'human', 'm', '秦风']);
  assert.equal(sent[2], sent[3], '兩次密碼要一致');
  assert.match(sent[2], /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, '密碼要含小寫、大寫、數字');
  assert.equal(done, true, '看到 > 提示符才算完成');
});

test('★ 種族選單中途不可誤判完成（第一版的假 playable）', () => {
  const upToMenu = HAPPY.slice(0, 8);   // 停在選單，還沒到「你的选择：」
  const { done } = run('dongfanggushi2', { id: 'a', pw: 'test1234' }, upToMenu);
  assert.equal(done, false, '必經步驟沒走完，再安靜也不算完成');
});

test('★ 短密碼被打回票：拒絕提示要接得住（使用者 tttt 實測卡死點）', () => {
  const { sent, done } = run('dongfanggushi2', { id: 'tttt', pw: 'tttt' }, [
    '您的英文名字：',
    '使用 tttt 这个名字将会创造一个新的人物，您确定吗(y/n)？',
    '请设定您的密码：',
    // 若密碼真的太短，伺服器會這樣打回票——接應器必須再答（而且答的是補長版）
    '密码的长度至少要五个字元，请重设您的密码：',
    '请再输入一次您的密码，以确认您没记错：',
    '您两次输入的密码　不一样，请重新设定一次密码：',
    '请再输入一次您的密码，以确认您没记错：',
    '您的电子邮件地址：',
    '你的选择：',
    '您要扮演男性(m)的角色或女性(f)的角色？',
    '您的中文名字：',
    '> ',
  ]);
  // 密碼被確定性補長到 ≥6，且每一次拒絕/重設/再確認都有人答
  const pw = sent[2];
  assert.ok(pw.length >= 6, `密碼要保底 6 字元，實際 ${pw.length}`);
  // 密碼與帳號同字時會被整個換掉（「密码太简单」政策），所以只驗政策不驗字面
  assert.match(pw, /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, '要含小寫、大寫、數字');
  assert.ok(!pw.toLowerCase().includes('tttt'), '不可包含帳號');
  const pwAnswers = sent.filter((x) => x === pw).length;
  assert.ok(pwAnswers >= 4, `4 個密碼提示都要有人答，實際 ${pwAnswers}`);
  assert.equal(done, true);
});

test('帳號淨化：數字與大寫都去掉，空了就用預設', () => {
  const a = run('dongfanggushi2', { id: 'Wasm01Test', pw: 'test1234' }, ['您的英文名字：']);
  assert.deepEqual(a.sent, ['wasmtest']);
  const b = run('dongfanggushi2', { id: '123', pw: 'test1234' }, ['您的英文名字：']);
  assert.deepEqual(b.sent, ['wanderer']);
});

test('ANSI 包裹的提示照樣認得（nt7／xo 家族的寫法）', () => {
  const { sent } = run('nt7', { id: 'abc', pw: 'test1234' }, [
    '\x1b[1;36m请输入您的英文名字(\x1b[36m忘记密码请输入「pass」\x1b[2;37;0m)：',
  ]);
  assert.deepEqual(sent, ['abc']);
});

// ── 前移驗證：欄位規格 ─────────────────────────────
import { validateCreds, specSummary, FIELD_SPECS } from '../src/js/telnetlogin.js';

test('★ 前移驗證：使用者的 tttt/tttt 在送出前就被擋下並講明原因', () => {
  const v = validateCreds('dongfanggushi2', { id: 'tttt', pw: 'tttt' });
  assert.equal(v.ok, false);
  // id 4 個純字母合法；密碼 4 字元不合（这台要求 ≥5）
  assert.deepEqual(v.errors.map((e) => e.field), ['pw']);
  assert.match(v.errors[0].msg, /5 個字元/);
});

test('前移驗證：合法組合放行；中文名逐字檢查', () => {
  assert.equal(validateCreds('dongfanggushi2', { id: 'tester', pw: 'test1234', name: '無名' }).ok, true);
  const bad = validateCreds('dongfanggushi2', { id: 'tester', pw: 'test1234', name: 'abc名' });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].field, 'name');
});

test('前移驗證：帳號含數字在 dongfanggushi2 被擋（只收 a-z）', () => {
  const v = validateCreds('dongfanggushi2', { id: 'wasm01', pw: 'test1234' });
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].field, 'id');
});

test('specSummary 對每個 profile 都給得出一句話', () => {
  for (const key of Object.keys(FIELD_SPECS)) {
    assert.ok(specSummary(key).includes('密碼'), key);
  }
});

test('★ 超集取答：性別與角色名由使用者的選擇帶進接應器', () => {
  const { sent } = run('dongfanggushi2',
    { id: 'tester', pw: 'test1234', name: '劍心', gender: 'f' }, HAPPY);
  assert.ok(sent.includes('f'), '性別要用使用者選的 f');
  assert.ok(sent.includes('劍心'), '角色名要用使用者填的');
});

// ── metadata 往返：匯出 → 載入 → 行為一致 ─────────────────
import { exportMetadata, loadMetadata } from '../src/js/telnetlogin.js';

test('★ metadata 往返：JSON 化再載回，接應器行為與內建 profile 完全一致', () => {
  const meta = JSON.parse(JSON.stringify(exportMetadata('dongfanggushi2')));
  meta.name = 'dfgs2-roundtrip';
  const name = loadMetadata(meta);
  assert.equal(name, 'dfgs2-roundtrip');
  const a = run('dongfanggushi2', { id: 'tester', pw: 'test1234' }, HAPPY);
  const b = run('dfgs2-roundtrip', { id: 'tester', pw: 'test1234' }, HAPPY);
  assert.deepEqual(b.sent, a.sent);
  assert.equal(b.done, a.done);
});

test('metadata 載入失敗不可拖垮啟動：壞資料退回 fallback', () => {
  assert.equal(loadMetadata(null, 'generic-cn'), 'generic-cn');
  assert.equal(loadMetadata({ rules: [{ match: '([' }] }, 'generic-cn'), 'generic-cn');
});

// ── 沖洗開關：zjmud 台不可切碎挑戰行（手機實錄回歸） ──────
import { createWasmDriver } from '../src/js/wasmdriver.js';

async function driverHarness(promptFlush) {
  const lines = [];
  const M = { FS: {}, ccall: (fn) => (fn === 'fluffos_connect' ? 1 : 0) };
  const d = createWasmDriver(M, { onLine: (l) => lines.push(l), onClosed() {}, promptFlush });
  d.boot('config.ini');
  d.connect();
  // 模擬慢速輸出：挑戰行分兩段抵達，中間隔超過沖洗窗口
  M.fluffos.onOutput(1, Array.from(Buffer.from('ver1.0,$6$abcdefg')));
  await new Promise((r) => setTimeout(r, 400));
  M.fluffos.onOutput(1, Array.from(Buffer.from('hij.klm\n')));
  await new Promise((r) => setTimeout(r, 100));
  d.shutdown();
  return lines;
}

test('★ zjmud 台（promptFlush 關）：分段抵達的挑戰行必須完整成一行', async () => {
  const lines = await driverHarness(false);
  assert.deepEqual(lines, ['ver1.0,$6$abcdefghij.klm'],
    '手機上輸出分段抵達時，挑戰行不可被切碎——切碎就是使用者截圖裡的卡死');
});

test('telnet 台（promptFlush 開）：靜置後半行要被當提示吐出', async () => {
  const lines = await driverHarness(true);
  assert.equal(lines[0], 'ver1.0,$6$abcdefg', '第一段在靜置後先出來（telnet 提示行為）');
});

// ── 一行多提示：挑哪一個 ──────────────────────────
test('★ 同一行有兩個提示時，答**後面**那個（星戰英雄實錄）', () => {
  // 伺服器把上一題與新的一題印在同一行；答成前面那題會卡在原地
  const { sent } = run('generic-cn', { id: 'wasmtest', pw: 'test1234' }, [
    '\x1b[1;35m您的英文名字：\x1b[2;37;0m\x1b[1;37m使用 wasmtest 这个名字将会创造一个新的人物，您确定吗(y/n)？',
  ]);
  assert.deepEqual(sent, ['y'], '要回答 (y/n)，不是再送一次名字');
});

test('★ 括號裡的關鍵字是說明不是提問（nt7 實錄）', () => {
  // 「忘记密码请输入 pass」的「密码」位置更後面，但它在括號裡
  const { sent } = run('nt7', { id: 'abc', pw: 'test1234' }, [
    '\x1b[1;36m请输入您的英文名字(\x1b[36m忘记密码请输入「pass」\x1b[2;37;0m)：',
  ]);
  assert.deepEqual(sent, ['abc'], '要回答英文名字，不是密碼');
});

test('★ 一個 burst 只回答最後一個提示（炎黃英雄史實錄：多送一行會被當成下一題的答案）', async () => {
  const sent = [];
  const tn = createTelnetLogin({
    profile: 'generic-cn', creds: { id: 'wasmtest', pw: 'test1234' },
    send: (l) => sent.push(l), debounceMs: 30,
  });
  // 伺服器一次送出「拒絕 + 重新提問」與「確認題」——逐行作答會多送一次名字，
  // 那一行會被當成 (y/n) 的回答，於是走進「好吧，请重新输入」的死循環
  tn.feed('对不起，你的英文名字必须是 3 到 10 个英文字母。');
  tn.feed('您的英文名字(新玩家可以选择一喜欢的名字)：');
  tn.feed('使用[wasmtest]这个名字将会创造一个新的人物，您确定吗(y/n)？');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(sent, ['y'], '只答最後那一題');
});
