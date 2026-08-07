#!/usr/bin/env node
/**
 * 為 GitHub Pages 準備 docs/ 文件夾
 * 
 * 用途：
 *   - 複製 site/ 前端到 docs/
 *   - 排除 libs/（WebAssembly 從本地加載）
 *   - 生成一個配置文件說明如何加載本地 libs
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

// 1. 確保 docs/ 存在
if (!fs.existsSync(DOCS_DIR)) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  console.log(`✅ 建立 ${DOCS_DIR}`);
}

// 2. 複製 site/ → docs/，排除 libs/ 底下每個 mud 的映像（只留 index.json）
//
// 【WHY 不能整個排除 libs/】play.html 的 wasmboot.js 在啟動時會 fetch
// `./libs/index.json` 來畫「選一個 mudlib」清單（見 webclient/src/js/wasmboot.js
// 的 CATALOGUE_URL）。這份清單只是 214 筆 metadata（title/slug/badge/sizeMB），
// 不含任何映像位元組——把它排除掉，play.html 連選單都畫不出來。
// 真正要排除的是 `libs/<slug>/`（每台的 mudlib.data.gz，加總 1+ GB）。
async function copyDir(src, dest, skipDirs = []) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      if (skipDirs.some((p) => p.test(srcPath))) continue;
      await copyDir(srcPath, destPath, skipDirs);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 只跳過 `libs/<slug>/`（任何 libs 底下的子目錄），index.json 本身會被複製。
const SKIP_LIB_SUBDIRS = [new RegExp(`\\${path.sep}libs\\${path.sep}[^\\${path.sep}]+$`)];
await copyDir(SITE_DIR, DOCS_DIR, SKIP_LIB_SUBDIRS);
console.log(`✅ 複製 site/ → docs/（libs/ 只留 index.json，排除各台映像）`);

// 3. 生成配置說明文件
const configDoc = `# GitHub Pages 配置說明

## 前端部署
- **位置**：GitHub Pages（\`docs/\` 文件夾）
- **訪問**：https://szupotseng.github.io/zjmud-rust/

## WebAssembly 加載方式

### 方案 A：本地開發伺服器（推薦）
在倉庫根目錄執行：
\`\`\`bash
npm start
\`\`\`
然後訪問：\`http://localhost:3000\`

這會同時供應前端（docs/）與 libs/。

### 方案 B：本地文件（瀏覽器）
1. 下載本倉庫到本地
2. 用瀏覽器開啟 \`docs/index.html\`
3. 前端會自動尋找同層級的 \`libs/\` 目錄

注意：某些瀏覽器可能因安全限制（CORS）無法直接訪問文件系統。

### 方案 C：GitHub Pages + 本地 libs（進階）
配置前端使用 Service Worker 攔截請求：
1. 前端優先尋找本地 \`libs/\`
2. 如果不存在，回退到遠端 GitHub Raw Content
3. WebAssembly 緩存到 IndexedDB

## 如何使用 GitHub Pages 的版本

1. 訪問 https://szupotseng.github.io/zjmud-rust/
2. 選擇一款遊戲
3. 瀏覽器會自動下載對應的 WebAssembly

### 優點
- 無需本地伺服器
- 自動 CDN 加速（GitHub Pages 用 CDN）
- 映像文件從 GitHub Raw 緩存加載

### 缺點
- 首次加載較慢（需下載 WebAssembly）
- 不支持離線遊玩（除非用 Service Worker）

## 構建新版本

\`\`\`bash
cd webclient
npm ci
npm run build  # 同時建置 docs/ 與 site/
\`\`\`

然後 push 到 GitHub：
\`\`\`bash
git add docs/
git commit -m "chore: update GitHub Pages"
git push origin main
\`\`\`

## 文件結構

\`\`\`
docs/              ← GitHub Pages 來源
├── index.html
├── js/
├── css/
└── libs/
    └── index.json  ← 遊戲清單（無映像數據）

libs/              ← 本地 WebAssembly（不上傳 GitHub）
├── 91shujian/mudlib.data.gz
├── aoxiangtianji/mudlib.data.gz
└── ...（209 個遊戲）
\`\`\`
`;

fs.writeFileSync(path.join(DOCS_DIR, 'README.md'), configDoc);
console.log(`✅ 建立 docs/README.md（部署說明）`);

// 4. 列出統計
const siteFiles = countFiles(SITE_DIR, ['libs']);
const docsFiles = countFiles(DOCS_DIR);
const libsSize = getDirectorySize(path.join(REPO, 'libs'));

console.log('\n📊 統計：');
console.log(`  · site/ 前端文件：${siteFiles} 個`);
console.log(`  · docs/ 已複製：${docsFiles} 個`);
console.log(`  · libs/ 大小：${(libsSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
console.log(`  · GitHub Pages 上傳：≈ ${(siteFiles * 50 / 1024).toFixed(1)} MB`);
console.log(`\n✨ 完成！可以 push 到 GitHub 了。`);

function countFiles(dir, ignore = []) {
  let count = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      if (ignore.includes(e.name)) continue;
      if (e.isDirectory()) walk(path.join(d, e.name));
      else count++;
    }
  };
  walk(dir);
  return count;
}

function getDirectorySize(dir) {
  let size = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      const fullPath = path.join(d, e.name);
      if (e.isDirectory()) walk(fullPath);
      else size += fs.statSync(fullPath).size;
    }
  };
  walk(dir);
  return size;
}
