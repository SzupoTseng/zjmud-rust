# zjmud 收藏站 —— Railway 部署用。
#
# 【WHY 用 Dockerfile 而不是靠自動偵測】倉庫根目錄有 `index.html`（設計書的
# 轉址頁）與 `designbook/`，Nixpacks 的靜態站偵測會挑到它們——實測 Railway
# 服務的是 `/designbook/`，而 `/play.html` 是 404。站台真正的內容在 `site/`，
# 而 `site/` 是 gitignore 的（要在部署端建）。Dockerfile 把「要跑什麼」寫死，
# 不留給偵測去猜。
#
# 【WHY 兩階段】建置階段需要整個倉庫（1.4 GB 的 libs/ ＋ node_modules ＋
# WASM driver），但**執行**只需要 site/ 與一支靜態伺服器。兩階段讓最終映像
# 不用背建置期的東西。
#
# 【WHY 這裡不用 --link-libs】那個旗標是讓映像留在 libs/ 由伺服器回退供應，
# 適合本機反覆建置（省掉每次複製 1.4 GB）。但在容器裡它會讓執行階段
# **同時**需要 site/ 與 libs/ 兩個目錄，反而更難推理。這裡讓 site/ 自足。

FROM node:20-slim AS build
WORKDIR /app

# 先只複製相依清單，讓 npm ci 這一層能被快取（原始碼改動不會讓它重跑）
COPY webclient/package.json webclient/package-lock.json ./webclient/
RUN cd webclient && npm ci --omit=dev --no-audit --no-fund

# 其餘原始碼與 mudlib 映像
COPY . .

# WASM driver 是從 GitHub Releases 抓的，不在版控裡
RUN cd webclient && node tools/fetch-driver.mjs

# 開機測試在轉換時就跑過了（結果寫在各台的 mud.json），這裡不重跑：
# 214 台逐一啟動 driver 要數小時，而 CI 早就是這個分工（見 pages.yml 的說明）。
RUN cd webclient && node tools/build-site.mjs --out ../site --skip-boot-test

FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production
# 只帶執行期需要的東西：站台內容 ＋ 那一支靜態伺服器
COPY --from=build /app/site ./site
COPY --from=build /app/webclient/tools/serve-site.mjs ./webclient/tools/serve-site.mjs
# serve-site 監聽 $PORT 並綁 0.0.0.0（Railway 會注入 PORT）
CMD ["node", "webclient/tools/serve-site.mjs", "--root", "site"]
