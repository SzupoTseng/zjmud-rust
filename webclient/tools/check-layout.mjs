#!/usr/bin/env node
// 版面重疊的**自動**檢查 —— 用真正的排版引擎量，不是用眼睛看。
//
// 【WHY】使用者連續四次回報「介面互相覆蓋、根本點不到」，而每一次我的閘門
// 都是綠的。原因很單純也很致命：**jsdom 沒有排版引擎**——
// getBoundingClientRect() 一律回傳 0，元素疊不疊在它眼裡不存在。
// 所以「全鏈路通過」從頭到尾只證明了邏輯，沒證明過任何一個像素。
// 使用者問「你的測試方式是？為什麼一直測試失敗？」——這支工具就是回答：
// 以前沒有版面測試，現在有了。
//
// 【判準】兩件事，都是使用者原話的機械化版本：
//   ①「互相覆蓋」→ 關鍵區塊兩兩不得重疊
//   ②「根本點不到」→ 可點元素必須完整在視口內，且 elementFromPoint 命中自己
// 兩者都用 Playwright（真 Chromium）在多個手機視口實測。
//
// 【為什麼是 Playwright 不是 Chrome CLI】Chrome 150 拿掉了 --dump-dom，
// CLI 沒有「執行 JS 並取回數值」的通道；截圖只能靠人眼看，做不成自動閘門。
//
// 用法：node tools/check-layout.mjs <snapshot.html> [--only 390x900]

import fs from 'node:fs';
import { chromium } from 'playwright';

const snapshot = process.argv[2];
if (!snapshot || !fs.existsSync(snapshot)) {
  console.error('用法：node tools/check-layout.mjs <snapshot.html>');
  process.exit(2);
}

/** 要驗的視口。矮的那些對應 in-app 瀏覽器（Messenger/LINE 內開，上下都被吃掉）。 */
const VIEWPORTS = [
  { name: '手機直向', width: 390, height: 900 },
  { name: 'in-app 瀏覽器', width: 390, height: 660 },
  { name: '小螢幕', width: 360, height: 600 },
  { name: '平板直向', width: 768, height: 1024 },
];

const BLOCKS = [
  ['工作列', '#bottom-dock'],
  ['狀態/聊天', '.col-right'],
  // 量**捲動容器**不是內容：#msg-main 是 .scroll-pane 裡的內容，
  // 內容比容器高是捲動的正常狀態，拿它的 rect 比對會得到假的「重疊」。
  ['訊息區', '.center-body'],
  ['房間描述', '#room-desc'],
  ['現場/出口', '.col-left'],
];

const CLICKABLE = [
  ['送出鈕', '#cmd-send'],
  ['指令輸入', '#cmd-input'],
  ['第一個快捷鈕', '#quick-main .quick'],
  ['最後一排快捷鈕', '#quick-bottom .quick'],
];

const probe = ({ blocks, clickable }) => {
  const vis = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return null;
    return r;
  };
  const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

  const out = [];
  const rects = blocks.map(([n, s]) => [n, vis(document.querySelector(s))]).filter(([, r]) => r);
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = area(rects[i][1], rects[j][1]);
      // 400px² 門檻：邊框/圓角的一兩像素接觸不算重疊
      if (a > 400) out.push({ kind: 'OVERLAP', a: rects[i][0], b: rects[j][0], area: Math.round(a) });
    }
  }
  for (const [n, s] of clickable) {
    const el = document.querySelector(s);
    const r = vis(el);
    if (!r) { out.push({ kind: 'MISSING', a: n }); continue; }
    if (r.bottom > innerHeight + 1 || r.top < -1) {
      out.push({ kind: 'OFFSCREEN', a: n, note: `top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} vh=${innerHeight}` });
      continue;
    }
    const cx = Math.min(innerWidth - 2, Math.max(1, r.left + r.width / 2));
    const cy = Math.min(innerHeight - 2, Math.max(1, r.top + r.height / 2));
    const hit = document.elementFromPoint(cx, cy);
    if (hit !== el && !el.contains(hit) && !hit?.contains?.(el)) {
      out.push({ kind: 'BLOCKED', a: n, note: `被 ${hit ? (hit.id || hit.className || hit.tagName) : 'null'} 蓋住` });
    }
  }
  return out;
};

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const targets = only ? VIEWPORTS.filter((v) => `${v.width}x${v.height}` === only) : VIEWPORTS;

// 沒有中文字型時直接說清楚，不要讓它偽裝成版面問題。
// 【WHY】CI 第一次跑這一格就紅：runner 沒有 CJK 字型，中文退回豆腐框，
// 字寬行高全變 → 量到的重疊是字型造成的，不是版面壞了。假警報比沒有警報糟。
const browser = await chromium.launch();
{
  const p0 = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await p0.setContent('<span id="t" style="font-size:100px">漢</span>');
  const w = await p0.evaluate(() => document.getElementById('t').getBoundingClientRect().width);
  await p0.close();
  if (w < 50) {
    console.error(`✗ 這台機器沒有中文字型（「漢」量到 ${Math.round(w)}px，應該接近 100px）——`
      + '量到的版面不會是使用者看到的版面。請先安裝：sudo apt-get install -y fonts-noto-cjk');
    await browser.close();
    process.exit(2);
  }
}
let bad = 0;
for (const vp of targets) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  await page.goto('file://' + fs.realpathSync(snapshot));
  await page.waitForTimeout(300);

  // CSS 真的生效了嗎？沒生效就不是版面問題，是快照不完整——要講清楚，
  // 不可以偽裝成「元素被擠出視口」（CI 為此白紅了三次）。
  // 【WHY 要允許沒有 .layout 的頁面】站台改版後多了一個**目錄頁**
  // （一台一列的表格），它不是客戶端、沒有 `.layout`。
  // 原本無條件 querySelector('.layout') 會拋
  // `getComputedStyle: parameter 1 is not of type 'Element'`——
  // 一個看起來像 Playwright 壞了的錯誤，而真相只是「這頁不是客戶端」。
  // 版面閘門該能驗**任何頁面**：重疊與可點性的檢查對目錄頁一樣有意義。
  const styled = await page.evaluate(() => {
    const el = document.querySelector('.layout');
    return el ? getComputedStyle(el).display : 'no-layout';
  });
  if (styled === 'no-layout') {
    // 不是客戶端頁：跳過「CSS 有沒有載到」的自我檢查，
    // 後面的重疊／可點性檢查照跑。
  } else
  if (styled !== 'flex' && styled !== 'grid') {
    console.error(`✗ 快照的 CSS 沒有生效（.layout 的 display=${styled}）——`
      + '量到的不是版面問題，是樣式沒載到。檢查快照裡的 <base> 或相對路徑。');
    await page.close();
    await browser.close();
    process.exit(2);
  }
  const issues = await page.evaluate(probe, { blocks: BLOCKS, clickable: CLICKABLE });
  await page.close();

  const tag = `${vp.name} ${vp.width}×${vp.height}`;
  if (!issues.length) { console.log(`✓ ${tag}`); continue; }
  bad += issues.length;
  console.log(`✗ ${tag}`);
  const LABEL = { OVERLAP: '重疊', BLOCKED: '被蓋住點不到', OFFSCREEN: '被擠出視口', MISSING: '找不到' };
  for (const i of issues) {
    console.log(`    ${LABEL[i.kind]}：${i.a}${i.b ? ' × ' + i.b : ''}${i.area ? ` (${i.area}px²)` : ''}${i.note ? ' ' + i.note : ''}`);
  }
}
await browser.close();

console.log(bad ? `\n共 ${bad} 個版面問題` : '\n所有視口：沒有重疊、關鍵元素都點得到');
process.exit(bad ? 1 : 0);
