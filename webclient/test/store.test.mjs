// store 的訂閱通知與容量裁切測試。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/js/store.js';

test('store: set 會通知該 path 的訂閱者', () => {
  const s = createStore();
  let got = null;
  s.sub('room.title', (v) => { got = v; });
  s.set('room.title', '客棧');
  assert.equal(got, '客棧');
});

test('store: 通知會往上傳到祖先 path', () => {
  const s = createStore();
  let hits = 0;
  s.sub('room', () => { hits += 1; });
  s.set('room.title', '客棧');
  assert.equal(hits, 1, '訂閱 room 應收到 room.title 的變動');
});

test('store: 通知會往下傳到後代 path（回歸測試）', () => {
  // 這是實際踩到的 bug：resetRoom() 只 notify('room')，
  // 若不往下傳，訂閱 room.titleButtons 的元件不會重繪，換房間後舊按鈕殘留。
  const s = createStore();
  let seen = null;
  s.sub('room.titleButtons', (v) => { seen = v; });

  s.set('room.titleButtons', [{ label: '查看', cmd: 'look' }]);
  assert.equal(seen.length, 1);

  s.resetRoom();
  assert.ok(Array.isArray(seen), '訂閱者應在 resetRoom 後被再次呼叫');
  assert.equal(seen.length, 0, 'resetRoom 後標題按鈕應被清空並通知出去');
});

test('store: resetRoom 清空出口、物件、標題按鈕與戰鬥面板', () => {
  const s = createStore();
  s.set('room.exits', [{ dir: 'north' }]);
  s.set('room.objects', [{ label: 'a', cmd: 'a' }]);
  s.set('room.titleButtons', [{ label: 'b', cmd: 'b' }]);
  s.set('room.titleCmd', 'look here');
  s.set('ui.combatVisible', true);
  s.pushMessage('combat', 'x');

  s.resetRoom();

  assert.deepEqual(s.get('room.exits'), []);
  assert.deepEqual(s.get('room.objects'), []);
  assert.deepEqual(s.get('room.titleButtons'), []);
  assert.equal(s.get('room.titleCmd'), null);
  assert.equal(s.get('ui.combatVisible'), false);
  assert.equal(s.get('msgs.combat').length, 0);
});

test('store: 相同值不觸發通知', () => {
  const s = createStore();
  let hits = 0;
  s.sub('room.title', () => { hits += 1; });
  s.set('room.title', '甲');
  s.set('room.title', '甲');
  assert.equal(hits, 1);
});

test('store: 訊息容量上限會裁切最舊的', () => {
  const s = createStore({ main: 3, chat: 3, sys: 3, combat: 3 });
  for (const t of ['a', 'b', 'c', 'd', 'e']) s.pushMessage('main', t);
  assert.deepEqual(s.get('msgs.main'), ['c', 'd', 'e']);
});

test('store: 退訂後不再收到通知', () => {
  const s = createStore();
  let hits = 0;
  const off = s.sub('room.title', () => { hits += 1; });
  s.set('room.title', '甲');
  off();
  s.set('room.title', '乙');
  assert.equal(hits, 1);
});

test('store: patch 就地更新多個欄位並通知', () => {
  const s = createStore();
  let hits = 0;
  s.sub('overlay', () => { hits += 1; });
  s.patch('overlay', { kind: 'dialog', detail: '文字' });
  assert.equal(s.get('overlay.kind'), 'dialog');
  assert.equal(s.get('overlay.detail'), '文字');
  assert.equal(hits, 1);
});

test('★ 訂閱回呼若寫回同一份狀態，必須被擋下而不是無限遞迴', () => {
  // 2026-07-29 事故的同型防線：自己造成的事件再觸發自己。
  const s = createStore();
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let calls = 0;
  try {
    s.sub('ui.theme', () => { calls += 1; s.set('ui.theme', 'x' + calls); });
    s.set('ui.theme', 'day');
  } finally {
    console.error = orig;
  }
  assert.ok(calls < 50, `遞迴應被截斷，實際呼叫 ${calls} 次`);
  assert.ok(errors.some((e) => e.includes('notify 遞迴超過')),
    '中止時必須在 console 留下可診斷的訊息，不可靜默');
});
