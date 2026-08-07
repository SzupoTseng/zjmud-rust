#!/usr/bin/env node
/**
 * GitHub Pages 配置驗證
 * 
 * 在部署到 GitHub Pages 前，確保倉庫設置正確。
 * 此腳本會指導用戶完成必要的 GitHub 網頁設置。
 */

console.log(`
╔════════════════════════════════════════════════════════════════╗
║     GitHub Pages 配置驗證與設置指南                             ║
╚════════════════════════════════════════════════════════════════╝

您已成功推送代碼到 GitHub！現在需要在倉庫設置中啟用 Pages。

【必做步驟】

1️⃣  進入倉庫設置
   https://github.com/SzupoTseng/zjmud-rust/settings

2️⃣  在左側菜單找到 "Pages"（或直接訪問）
   https://github.com/SzupoTseng/zjmud-rust/settings/pages

3️⃣  配置以下選項：

   ┌─────────────────────────────────────────────┐
   │ Source（來源）                              │
   │ ──────────────────────────────────────      │
   │ ☑ Deploy from a branch                      │
   │                                             │
   │ Branch（分支）                              │
   │ ──────────────────────────────────────      │
   │ [ main ] / [ /docs ]  ← 選擇 /docs 文件夾   │
   │                                             │
   │ [Save]                                      │
   └─────────────────────────────────────────────┘

4️⃣  等待部署完成
   - 進入 "Actions" 標籤觀看部署過程
   - 綠色 ✅ 表示成功
   - 紅色 ❌ 表示失敗（檢查日誌）

5️⃣  驗證上線

   訪問以下網址驗證：
   → https://szupotseng.github.io/zjmud-rust/

   應該看到：
   ✓ 遊戲列表頁面
   ✓ 可點擊選項卡
   ✓ WebAssembly 驅動程式已加載


【部署架構】

GitHub Pages（已上傳）
  docs/
  ├── index.html           ← 首頁
  ├── js/ css/             ← 客戶端代碼
  ├── _driver/fluffos.wasm ← WebAssembly 驅動
  └── libs/
      └── index.json       ← 遊戲清單（無映像數據）

本地保留（未上傳）
  libs/
  ├── 91shujian/mudlib.data.gz
  ├── aoxiangtianji/mudlib.data.gz
  └── ...（209 個遊戲 ~ 1.3 GB）


【自動更新】

此後每次推送到 main 分支時：
  1. GitHub Actions 自動執行 pages.yml
  2. 驗證所有測試通過
  3. 掃描隱私洩漏
  4. 生成 docs/ 並部署到 Pages

失敗時（紅燈）→ 不發佈（保持前一版本）


【本地開發】

開發時啟動本地伺服器：
  npm start

訪問 http://localhost:3000
  - 同時供應前端與本地 libs/
  - 支持所有 209 個遊戲


【常見問題】

Q: 部署為什麼沒有上線？
A: 檢查 Actions 標籤的 Pages workflow
   - 紅燈：檢查錯誤日誌（測試失敗、隱私掃描、等）
   - 黃燈：正在構建（等待完成）

Q: 可以從 GitHub Pages 下載 WebAssembly 嗎？
A: 可以，使用本地伺服器或配置 Service Worker
   （見 docs/DEPLOYMENT.md 的"方案 C"）

Q: 為什麼 libs/ 沒有上傳？
A: 這是設計的一部分：
   - libs/ 太大（~1.3 GB 原始 + ~4.5 GB 解壓後）
   - 放在 GitHub Pages 會超過免費額度
   - 用戶可本地運行或配置代理加載


【驗證命令】

查看已推送的提交：
  git log --oneline -3

驗證 docs/ 有正確文件：
  ls -la docs/
  ls -la docs/libs/index.json  # 應存在

驗證 libs/ 未上傳：
  git ls-files libs/mudlib.data
  # 應該無輸出（被 .gitignore 排除）

╔════════════════════════════════════════════════════════════════╗
║ ✨ 完成！訪問 GitHub Pages 設置並選擇 /docs 文件夾          ║
║ → https://github.com/SzupoTseng/zjmud-rust/settings/pages     ║
╚════════════════════════════════════════════════════════════════╝
`);
