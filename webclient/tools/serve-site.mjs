#!/usr/bin/env node
// 靜態伺服器 —— 只為了在本機預覽 site/（GitHub Pages 上不需要任何伺服器端程式）。
//
// 【WHY 不用 bridge/server.mjs】那支的職責是「代開 TCP 到真的 MUD」，
// 它服務的根目錄是 src/。WASM 站台沒有 TCP 可代開，需要的只是一個能正確
// 回 Content-Type 與 Content-Length 的靜態伺服器——後者對 mudlib.data 的
// 下載進度條是必要的（fetchImage 讀 content-length）。
//
// 用法：node tools/serve-site.mjs [--root ../site] [--port 8080]
//
// 【正式環境】倉庫轉為 private 之後 GitHub Pages 不再可用，站台改由 Railway 供應，
// 而 Railway 是「跑一個程序、把 $PORT 開起來」的模型——所以這支從純本機預覽
// 升格成正式伺服器。三件事因此變得重要（本機隨便，線上不行）：
//   ① 監聽 `process.env.PORT` 並綁 0.0.0.0（容器外部才連得進來）
//   ② `.gz` 一律當**原始位元組**送，絕對不可以設 Content-Encoding: gzip
//      —— 客戶端是自己用 DecompressionStream 解的（mudlibimage.js:110），
//      讓瀏覽器先解一次就會變成解兩次，映像直接壞掉
//   ③ 映像要能長期快取：整站 1.4 GB，其中 99.7% 是 mudlib 映像，
//      每次進站重抓的話沒有人受得了

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const ROOT = path.resolve(arg('root', path.join(HERE, '..', '..', 'site')));
// Railway 會用環境變數指定埠；本機仍可用 --port 覆蓋。
const PORT = Number(arg('port', process.env.PORT || 8080));
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  // 【WHY 明確列出 .gz】不列的話會落到 application/octet-stream——結果一樣，
  // 但寫出來是為了讓下一個人看到「這是刻意當成二進位送的，不是漏掉」。
  '.gz': 'application/octet-stream',
};

// ★ 映像的回退來源：`--link-libs` 建置時，site/libs/<slug>/ 底下不會有大檔，
// 由這裡直接從倉庫的 libs/ 供應。
//
// 【WHY】映像佔整站 1.4 GB 的 99.7%，而它在 libs/ 裡本來就有一份。
// GitHub Pages 時代必須複製（Pages 只吃一個目錄）；改由 Railway 供應之後，
// 程序讀得到 libs/，複製就只是讓容器多背 1.4 GB、每次部署多搬一次。
// 【判準】發佈的位元組必須完全一樣——所以是「同一個檔案換個路徑供應」，
// 不是重新產生。找不到才回退，site/ 裡有的優先（全量建置仍是自足的）。
const LIBS_FALLBACK = path.resolve(HERE, '..', '..', 'libs');

export function createSiteServer(root = ROOT) {
  return http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    const abs = path.resolve(root, rel);
    // 目錄穿越防護：解析後必須仍在 root 底下
    if (!abs.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
    const serve = (file, st) => {
      // ★ `.gz` 絕對不可以帶 Content-Encoding。
      // 客戶端拿到的必須是**壓縮後的原始位元組**，它自己 DecompressionStream。
      // 設了 Content-Encoding 的話瀏覽器會先解一次，JS 再解一次 → 映像壞掉，
      // 而症狀會是「globals.h 語法錯誤」這種完全指不到真因的東西。
      const isImage = /\.(data|data\.gz|wasm)$/.test(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': st.size,
        // 映像是不可變的（改了就會換一次建置），可以放心長快取。
        // 其餘（html/js/css）用 no-cache，讓每次部署立刻生效。
        'cache-control': isImage ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    };

    fs.stat(abs, (err, st) => {
      if (!err && st.isFile()) { serve(abs, st); return; }
      // 回退：/libs/<slug>/<檔> → <倉庫>/libs/<slug>/<檔>
      const m = /^libs\/([^/]+)\/(.+)$/.exec(rel);
      if (!m) { res.writeHead(404).end('not found'); return; }
      const alt = path.resolve(LIBS_FALLBACK, m[1], m[2]);
      if (!alt.startsWith(LIBS_FALLBACK)) { res.writeHead(403).end('forbidden'); return; }
      fs.stat(alt, (e2, s2) => {
        if (e2 || !s2.isFile()) { res.writeHead(404).end('not found'); return; }
        serve(alt, s2);
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!fs.existsSync(ROOT)) {
    console.error(`找不到 ${ROOT}——先跑 node tools/build-site.mjs`);
    process.exit(2);
  }
  createSiteServer().listen(PORT, HOST, () => {
    console.log(`站台服務中：http://${HOST}:${PORT}　（根目錄 ${ROOT}）`);
  });
}
