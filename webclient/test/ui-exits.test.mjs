// 方向盤：非標準方向名要借用空格
//
// 【WHY】星戰英雄（mudlibs-main 轉換）的出口全是數字「1 2 3 4」，八個方向格
// 一個都沒用到，四個出口卻全被擠到「其他出口」列——手機版面板高度有限，
// 那一列看不到，玩家等於無路可走（§B3 人工複核時用截圖抓到的）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createStore } from '../src/js/store.js';
import { ExitPad } from '../src/js/ui.js';

function mount(exits) {
  const dom = new JSDOM('<div id="r"></div>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  const store = createStore();
  store.set('room.exits', exits);
  const sent = [];
  ExitPad(document.getElementById('r'), { store, ctx: { send: (c) => sent.push(c), requestMap() {} } });
  return { document, sent };
}

test('★ 數字出口借用方向盤空格，不被擠到看不見的那一列', () => {
  const { document } = mount([
    { dir: '1', label: '1', cmd: '1' }, { dir: '2', label: '2', cmd: '2' },
    { dir: '3', label: '3', cmd: '3' }, { dir: '4', label: '4', cmd: '4' },
  ]);
  const shown = [...document.querySelectorAll('.exit-cell')].filter((c) => !c.hidden && !c.className.includes('center'));
  assert.equal(shown.length, 4, '四個出口都要出現在方向盤上');
  assert.equal(document.querySelector('.exit-extra').children.length, 0, '不該再排到其他出口列');
  // 借來的格子不可以畫方向箭頭——出口叫「3」不是「往東北」
  assert.equal(shown[0].querySelector('.exit-glyph'), null);
});

test('標準方向照舊佔自己的格子，多出來的才借', () => {
  const { document } = mount([
    { dir: 'north', label: '北', cmd: 'north', slot: 'n' },
    { dir: 'x1', label: '密道', cmd: 'x1' },
  ]);
  const shown = [...document.querySelectorAll('.exit-cell')].filter((c) => !c.hidden && !c.className.includes('center'));
  assert.equal(shown.length, 2);
  assert.ok(shown.some((c) => c.querySelector('.exit-glyph')), '標準方向仍要有箭頭');
});
