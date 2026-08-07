#!/usr/bin/env node
// 目錄頁的搜尋／篩選，用真 Chromium 實際打字與點擊驗一次。
//
// 【WHY】這是 CLAUDE.md §11 的同一條：產生出正確的 HTML 不代表使用者用得到。
// 「有 input#q」「有 data-k」這種檢查是**訊號**；
// 「打了字之後真的只剩符合的列」才是**行為**。
// 而 jsdom 沒有排版引擎，`hidden` 造成的顯示變化它量不準（§2）。
//
// 【判準】三件事，都是實數：
//   ① 打字後可見列數**變少**，且剩下的每一列都真的含那個字
//   ② 點「受限」之後，可見列的 data-b 全部是 limited
//   ③ 打一個一定不存在的字串 → 0 列，且「沒有符合」的提示出現
//      （空結果要能被看見；靜默的空表格跟壞掉一樣）
//
// 用法：node tools/check-catalogue.mjs [site 目錄]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createSiteServer } from './serve-site.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SITE = path.resolve(process.argv[2] || path.join(REPO, 'site'));
const PORT = Number(process.env.ZJMUD_CAT_PORT) || 8520;

if (!fs.existsSync(path.join(SITE, 'index.html'))) {
  console.error(`找不到目錄頁（${SITE}/index.html）——先跑 node tools/build-site.mjs`);
  process.exit(2);
}

const server = createSiteServer(SITE);
await new Promise((r) => server.listen(PORT, r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const problems = [];

const visible = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('tbody tr')].filter((r) => !r.hidden);
  return { n: rows.length, badges: [...new Set(rows.map((r) => r.dataset.b))] };
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  const total = (await visible()).n;
  if (total < 1) {
    problems.push('目錄頁一列都沒有——這不是通過（空集合的斷言永遠成立）');
    throw new Error('stop');
  }
  console.log(`目錄頁共 ${total} 列`);

  // ① 搜尋：拿第一列的代號當關鍵字，它一定至少命中自己
  const slug = await page.evaluate(() => document.querySelector('tbody tr td.s')?.textContent?.trim() ?? '');
  await page.fill('#q', slug);
  await page.waitForTimeout(200);
  const after = await visible();
  const allMatch = await page.evaluate((t) => [...document.querySelectorAll('tbody tr')]
    .filter((r) => !r.hidden)
    .every((r) => (r.dataset.k || '').includes(t.toLowerCase())), slug);
  if (after.n < 1) problems.push(`搜尋「${slug}」得到 0 列——它至少該找到自己`);
  if (total > 1 && after.n >= total) problems.push(`搜尋「${slug}」沒有縮小範圍（${total} → ${after.n}）`);
  if (!allMatch) problems.push(`搜尋結果裡有不含「${slug}」的列`);
  console.log(`  搜尋「${slug}」→ ${after.n} 列 ${after.n < total || total === 1 ? '✓' : '✗'}`);

  // ② 篩選：點「受限」，剩下的每一列都必須是 limited
  await page.fill('#q', '');
  await page.click('.chip[data-f="limited"]');
  await page.waitForTimeout(200);
  const lim = await visible();
  if (lim.badges.some((b) => b !== 'limited')) {
    problems.push(`「受限」篩選後仍有其他狀態的列：${lim.badges.join(' ')}`);
  }
  console.log(`  篩選「受限」→ ${lim.n} 列（狀態：${lim.badges.join(' ') || '無'}）`
    + `${lim.badges.every((b) => b === 'limited') ? ' ✓' : ' ✗'}`);

  // ③ 空結果要看得見
  await page.click('.chip[data-f="all"]');
  await page.fill('#q', 'zzz-不存在的東西-zzz');
  await page.waitForTimeout(200);
  const none = await visible();
  const emptyShown = await page.evaluate(() => document.getElementById('empty')?.hidden === false);
  if (none.n !== 0) problems.push(`搜尋不存在的字串卻還有 ${none.n} 列`);
  if (!emptyShown) problems.push('空結果時沒有顯示「沒有符合的 MUD」——靜默的空表格跟壞掉一樣');
  console.log(`  空結果 → ${none.n} 列，提示${emptyShown ? '有顯示 ✓' : '沒顯示 ✗'}`);

  // ④ 清空之後要全部回來（篩選不可以是單向門）
  await page.fill('#q', '');
  await page.waitForTimeout(200);
  const back = (await visible()).n;
  if (back !== total) problems.push(`清空搜尋後只回來 ${back} 列，原本有 ${total} 列`);
  console.log(`  清空 → ${back} 列 ${back === total ? '✓' : '✗'}`);
} catch (e) {
  if (e.message !== 'stop') problems.push(`例外：${e.message}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error(`\n✗ 目錄頁篩選：${problems.length} 項問題`);
  for (const p of problems) console.error(`   · ${p}`);
  process.exit(1);
}
console.log('\n✓ 目錄頁：搜尋會縮小範圍、篩選只留該狀態、空結果看得見、清空能復原');
process.exit(0);
