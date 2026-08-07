# 📋 GitHub Pages 部署完成清單

## 已完成的工作

### ✅ 1. 前端代碼準備
- [x] 生成 `site/` 目錄（由 build-site.mjs）
- [x] 創建 `docs/` 用于 GitHub Pages（準備腳本已創建）
- [x] 排除大型 WebAssembly 映像（libs/ 不上傳）

### ✅ 2. GitHub Actions 工作流
- [x] 修改 `.github/workflows/pages.yml`
- [x] 在部署前自動調用 `prepare-pages.mjs`
- [x] 改為上傳 `docs/` 而不是 `site/`

### ✅ 3. 部署配置文件
- [x] `scripts/prepare-pages.mjs` - 複製前端到 docs/
- [x] `docs/DEPLOYMENT.md` - 部署說明文檔
- [x] `docs/README.md` - GitHub Pages 配置指南
- [x] `scripts/verify-github-pages.mjs` - 配置驗證腳本

### ✅ 4. Git 提交
- [x] 提交所有文件到 `main` 分支
- [x] 推送到 GitHub

## 🔧 下一步：啟用 GitHub Pages

### 必做（5 分鐘）

進入倉庫設置頁面：
**https://github.com/SzupoTseng/zjmud-rust/settings/pages**

選擇：
- **Source**: Deploy from a branch
- **Branch**: `main`
- **Folder**: `/docs`
- **按 Save**

完成後訪問：
**https://szupotseng.github.io/zjmud-rust/**

---

## 📊 部署結構

```
GitHub Pages (已上傳 ~0.9 MB)
  https://szupotseng.github.io/zjmud-rust/
  ├── index.html
  ├── js/ css/
  ├── _driver/
  └── libs/index.json

本地保留 (~1.3 GB，不上傳)
  libs/
  ├── 91shujian/mudlib.data.gz
  ├── aoxiangtianji/mudlib.data.gz
  └── ... 209 個遊戲
```

---

## 🚀 使用方式

### 方式 A：線上訪問（最簡單）
```
https://szupotseng.github.io/zjmud-rust/
```
- 無需本地伺服器
- 自動 CDN 加速
- WebAssembly 從本地或 GitHub Raw 加載

### 方式 B：本地開發
```bash
npm start
# 訪問 http://localhost:3000
# 同時供應前端與本地 libs/
```

---

## ✅ 驗證清單

部署完成後檢查：

- [ ] GitHub Pages 已啟用（Settings > Pages）
- [ ] Actions > Pages 工作流為 ✅（綠色）
- [ ] 訪問 Pages URL，看到遊戲列表
- [ ] 可以選擇並啟動遊戲
- [ ] 本機 `git log --oneline` 顯示最新提交

---

## 📚 相關文件

| 文件 | 用途 |
|---|---|
| `.github/workflows/pages.yml` | 自動部署工作流 |
| `scripts/prepare-pages.mjs` | 準備 docs/ 文件夾 |
| `docs/DEPLOYMENT.md` | 詳細部署說明 |
| `docs/README.md` | Pages 配置指南 |
| `scripts/verify-github-pages.mjs` | 配置驗證（此文件） |

---

## 🔍 故障排除

### Pages 沒有上線？
1. 檢查 Settings > Pages 配置
2. 查看 Actions 日誌
3. 確認 Branch 為 `main`，Folder 為 `/docs`

### 新遊戲沒出現？
1. 檢查 `libs/<slug>/mud.json` 存在
2. 等待 Pages workflow 完成
3. 清除瀏覽器快取（Ctrl+Shift+R）

### WebAssembly 加載失敗？
1. 檢查本地 `libs/` 目錄存在
2. 訪問本地伺服器而不是 GitHub Pages
3. 檢查瀏覽器控制台錯誤信息

---

## 📞 後續操作

### 新增遊戲
1. 放入 `libs/<slug>/` 目錄
2. 提交到 GitHub
3. 自動觸發部署

### 更新代碼
1. 修改 `webclient/` 中的代碼
2. Push 到 `main`
3. 自動部署

### 修改部署設置
1. 編輯 `.github/workflows/pages.yml`
2. 或在 `scripts/prepare-pages.mjs` 添加新邏輯
3. 推送並自動更新

---

## 💡 重要說明

- **libs/ 為什麼不上傳？**
  - 大小過大（~1.3 GB → ~4.5 GB 解壓）
  - GitHub Pages 免費額度有限
  - 用戶可本地運行，支持離線遊玩

- **為什麼用 docs/ 而不是 site/?**
  - `docs/` 是 GitHub Pages 的標準位置
  - 更清晰的版本控制（site/ 由構建產生）
  - 自動排除 libs/ 保持倉庫小

- **首次部署要多久？**
  - Pages workflow 完成：~15-30 分鐘
  - 上線訪問生效：通常立即（有時需清快取）

---

**✨ 完成！現在訪問 GitHub Pages 設置啟用部署。**
