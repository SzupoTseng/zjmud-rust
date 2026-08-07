#!/usr/bin/env node
/**
 * 為 GitHub Pages 準備 docs/ 文件夾
 *
 * 用途：把 site/（build-site.mjs 的完整產物，含每個 mud 的 libs/<slug>/
 * 映像）整份鏡射進 docs/，因為 Settings → Pages 的 Source 是
 * 「Deploy from a branch：main / docs」。
 *
 * 【WHY 整份複製，不排除 libs/】
 * 架構比照 mudlibs.fluffos.info：driver 與所有 mud 的映像都直接放在
 * 靜態站台上，瀏覽器點開 play.html 就地下載、就地開機，沒有另外的
 * 伺服器層。曾經試過把 libs/<slug>/ 排除、只留 index.json（想讓映像
 * 走「本地」），結果 play.html 的 fetchImage() 會去抓
 * `./libs/<slug>/mudlib.json`——404 頁面的 HTML 被當 JSON 解析，
 * 直接炸成「Unexpected token '<'」。不要再拆成兩份，整份複製最簡單也最對。
 *
 * 用法：
 *   node scripts/prepare-pages.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SITE_DIR = path.join(REPO, 'site');
const DOCS_DIR = path.join(REPO, 'docs');

console.log('📝 為 GitHub Pages 準備 docs/ 文件夾...\n');

if (!fs.existsSync(SITE_DIR)) {
  console.error(`找不到 ${SITE_DIR}——先跑 webclient/tools/build-site.mjs`);
  process.exit(1);
}

// 整份鏡射 site/ → docs/（刪掉舊的 docs/ 再重建，不留殘餘檔案）。
fs.rmSync(DOCS_DIR, { recursive: true, force: true });
fs.cpSync(SITE_DIR, DOCS_DIR, { recursive: true });
console.log('✅ 複製 site/ → docs/（含 libs/，完整映像一起上）');

// GitHub Pages 預設會用 Jekyll 處理內容，而 Jekyll 會忽略檔名以 `_` 開頭的
// 目錄／檔案——driver 剛好放在 `_driver/`，沒有這個檔會整批被吃掉。
fs.writeFileSync(path.join(DOCS_DIR, '.nojekyll'), '');
console.log('✅ 建立 docs/.nojekyll（避免 Jekyll 忽略 _driver/）');

const stats = { files: 0, bytes: 0 };
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) walk(full);
    else { stats.files += 1; stats.bytes += fs.statSync(full).size; }
  }
})(DOCS_DIR);

console.log('\n📊 統計：');
console.log(`  · docs/ 檔案數：${stats.files} 個`);
console.log(`  · docs/ 總大小：${(stats.bytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
console.log('\n✨ 完成！可以 push 到 GitHub 了。');
