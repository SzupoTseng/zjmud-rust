# 📋 GitHub Pages 部署完成清單

## 架構（比照 mudlibs.fluffos.info）

`docs/` 是**完整站台**——目錄頁、客戶端、driver、以及每一台 mud 的映像
（`libs/<slug>/mudlib.json` + `mudlib.data.gz`）全部一起放在 GitHub Pages 上，
沒有另外的伺服器層，也不需要使用者本機另外跑東西。詳細說明見
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 已完成的工作

- [x] `scripts/prepare-pages.mjs`：把 `site/`（build-site.mjs 的完整產物，
      含每台的 `libs/<slug>/`）整份鏡射進 `docs/`
- [x] `.github/workflows/pages.yml`：跑完整條驗證管線（測試、憑證掃描、
      映像健檢、每台真開機測試、四個瀏覽器閘門）之後準備 `docs/`；
      **不在這裡部署**——部署由 GitHub 內建的「pages build and deployment」
      在 `docs/` 有新 commit 時自動觸發（見下）
- [x] Settings → Pages：Source = Deploy from a branch，Branch = `main`，Folder = `/docs`

## 部署方式

`docs/` 的內容是**版控的一部分**，不是 CI 產物。要更新線上站台：

```bash
cd webclient && npm ci
node tools/build-site.mjs --out ../site --skip-boot-test
cd .. && node scripts/prepare-pages.mjs
git add docs/
git commit -m "chore: update GitHub Pages"
git push origin main
```

Push 之後 GitHub 會自動重新部署，訪問：
**https://szupotseng.github.io/zjmud-rust/**

## ✅ 驗證清單

- [ ] 訪問 Pages URL，看到 214 台的目錄頁
- [ ] 點進任一台，選單能選、`play.html?mud=<slug>` 能正常開機進遊戲
- [ ] `curl` 線上 `libs/<slug>/mudlib.json` 確認回傳的是 JSON 不是 404 頁面

## 🔍 故障排除

### Pages 沒有上線？
1. 檢查 Settings → Pages 的 Source/Branch/Folder 設定
2. 確認 `docs/` 的變動真的 commit 且 push 到 `main`（GitHub 內建部署只認 `main` 上的
   `docs/` 內容，跟這個 repo 的 Actions workflow 是否綠燈無關）

### 點進遊戲後啟動失敗、錯誤訊息像 HTML（`Unexpected token '<'`）？
代表 `docs/libs/<slug>/mudlib.json` 不存在——通常是 `docs/` 沒有跟著
`site/` 一起重建。重新跑 `node scripts/prepare-pages.mjs` 並確認
`docs/libs/<slug>/` 底下真的有 `mudlib.json` 與 `mudlib.data.gz`。

### 新增/更新遊戲沒出現？
1. 確認 `libs/<slug>/mud.json` 存在
2. 重跑 build-site + prepare-pages，把新的 `docs/` commit 上去
3. 清瀏覽器快取（Ctrl+Shift+R）

