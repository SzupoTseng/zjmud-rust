# GitHub Pages 部署說明

## 架構

比照 [mudlibs.fluffos.info](https://mudlibs.fluffos.info/)：
**docs/ 是完整站台**，driver 與每一台 mud 的映像（`libs/<slug>/mudlib.json` +
`mudlib.data.gz`）都直接放在這裡，靠 GitHub Pages 的靜態 CDN 供應。
瀏覽器點開 `play.html?mud=<slug>` 就地下載映像、就地在 WASM 裡開機，
沒有另外的伺服器層、也不需要使用者在本機另外跑什麼。

```
docs/                    ← GitHub Pages 來源（Settings → Pages → main / docs）
├── index.html           ← 目錄頁（214 台可搜尋/篩選的清單）
├── play.html             ← 遊戲客戶端殼
├── js/ css/
├── _driver/              ← FluffOS WASM driver
└── libs/
    ├── index.json        ← 目錄頁用的清單 metadata
    └── <slug>/
        ├── mudlib.json    ← 該台的映像 manifest
        └── mudlib.data.gz ← 該台的壓縮映像
```

## 產生／更新 docs/

```bash
cd webclient
npm ci
node tools/build-site.mjs --out ../site --skip-boot-test   # 產生 site/
cd ..
node scripts/prepare-pages.mjs                              # site/ → docs/（整份鏡射）
git add docs/
git commit -m "chore: update GitHub Pages"
git push origin main
```

推上 `main` 之後，GitHub 內建的「pages build and deployment」
（Settings → Pages → Source = Deploy from a branch）會自動把 `docs/` 發佈上線。

## 為什麼不是「本地 WASM + Pages 只當前端」

早期版本把 `libs/<slug>/` 排除在 `docs/` 之外，只留 `libs/index.json`，
想法是映像留在使用者「本地」。但 `play.html` 目前的實作
（`webclient/src/js/mudlibimage.js` 的 `fetchImage()`）本來就是用
`fetch(base + '/mudlib.json')` 直接向目前網址抓資料，並沒有「本地」這個概念——
排除的結果只是讓每一台都 404（GitHub 的 404 頁面是 HTML，被當 JSON 解析就炸掉）。
改成整份鏡射之後這個路徑就直接對得上。

## 檔案大小

- 個別檔案最大 ~56 MB（`jym/mudlib.data.gz`），遠低於 GitHub 100 MB 的硬性上限。
- `docs/` 總大小 ~1.37 GB，超過 GitHub「建議」的 1 GB，但不是硬性阻擋門檻，
  公開倉庫超過這個數字很常見。

## 本機開發／不透過 Pages 執行

```bash
npm start   # 啟動本機伺服器，同時供應前端與 libs/
```
