#!/usr/bin/env node
// 在**真瀏覽器**裡登入某一台，逐一送指令並印出世界的原話。
//
// 【WHY 要有這支】診斷「這顆按鈕為什麼回什麼？」時，需要的是
// 「送 X 之後世界說了什麼」這個最小事實。boot-test 給的是 opcode 統計、
// verify-clicks 給的是判定結果，兩者都不會把原話端到你面前。
// 這個需求在同一輪裡出現三次（sj 的 skills、moniHuafu 的忙碌狀態、
// sjecl 的 look），每次都現寫一個一次性腳本——現在做成常駐的。
//
// 【WHY 用瀏覽器而不是 boot-test】兩邊會不一致，而**使用者走的是瀏覽器那條**。
// 實測 sjecl：boot-test 裡搜尋路徑完整、面板齊全；瀏覽器裡連 look 都回「什麼？」。
// 不一致本身就是線索，而只有在使用者實際走的路徑上量，結論才算數。
//
// 用法：
//   node tools/probe-commands.mjs --mud sjecl look hp skills
//   node tools/probe-commands.mjs <site 目錄> --mud sj skills practice

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createSiteServer } from './serve-site.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

// 帶值的旗標要登記，否則它的值會被當成站台路徑（見 sweep-web.mjs 的說明）
const VALUE_FLAGS = new Set(['--mud', '--account', '--name']);
const positional = [];
{
  const av = process.argv.slice(2);
  for (let i = 0; i < av.length; i += 1) {
    if (VALUE_FLAGS.has(av[i])) { i += 1; continue; }
    if (av[i].startsWith('--')) continue;
    positional.push(av[i]);
  }
}
const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const mud = arg('mud');
if (!mud) { console.error('需要 --mud <slug>'); process.exit(2); }
// 第一個 positional 若是既有目錄就當站台，其餘都是要送的指令
const maybeSite = positional[0] && fs.existsSync(path.join(positional[0], 'libs', 'index.json'))
  ? positional.shift() : null;
const SITE = path.resolve(maybeSite || path.join(REPO, 'site'));
const CMDS = positional.length ? positional : ['look'];
const PORT = Number(process.env.ZJMUD_PROBE_PORT) || 8740;

if (!fs.existsSync(path.join(SITE, 'libs', 'index.json'))) {
  console.error(`找不到建置產物（${SITE}）——先跑 node tools/build-site.mjs`);
  process.exit(2);
}

const server = createSiteServer(SITE);
await new Promise((r) => server.listen(PORT, r));
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  await page.goto(`http://127.0.0.1:${PORT}/play.html?mud=${encodeURIComponent(mud)}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('login-modal')?.hidden === false
      || document.getElementById('char-modal')?.hidden === false,
    null, { timeout: 150000 });
  if (await page.evaluate(() => document.getElementById('login-modal')?.hidden === false)) {
    await page.fill('#login-id', arg('account', 'zjtester'));
    await page.fill('#login-pw', 'zjtest123');
    await page.click('#login-submit');
  }
  await page.waitForFunction(() => document.getElementById('char-modal')?.hidden === false,
    null, { timeout: 60000 }).catch(() => {});
  await page.fill('#char-name', arg('name', '青風')).catch(() => {});
  await page.click('#char-submit').catch(() => {});

  // 等到有**掛了指令**的快捷鈕（「＋」是空槽，不算面板已到達）
  await page.waitForFunction(
    () => document.querySelectorAll(
      '#quick-main .quick:not(.quick-empty), #quick-bottom .quick:not(.quick-empty)').length > 0,
    null, { timeout: 150000 });
  await page.waitForTimeout(3000);

  const txt = () => page.evaluate(() => (document.getElementById('msg-main')?.innerText ?? ''));
  for (const c of CMDS) {
    const before = await txt();
    await page.evaluate((x) => globalThis.__zjmud.sendCommand(x), c);
    // 輪詢等回應，不要固定睡（慢的正常回應不該被讀成沒有回應）
    await page.waitForFunction(([n]) => (document.getElementById('msg-main')?.innerText ?? '').length > n,
      [before.length], { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    const fresh = (await txt()).slice(before.length).replace(/^[\s>]+/, '').trim();
    console.log(`>>> ${c}\n${fresh ? fresh.slice(0, 400) : '（世界沒有說任何話）'}\n`);
  }
} finally {
  await browser.close();
  server.close();
}
