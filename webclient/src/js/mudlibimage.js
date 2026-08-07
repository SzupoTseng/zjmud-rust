// mudlib 映像的載入端 —— 把打包好的 .data 灌進 driver 的 MEMFS。
//
// 【WHY 自己定映像格式，而不是用 emscripten 的 file_packager】
// 官方 pack-mudlib.sh 要求 emsdk 在 PATH 上（file_packager 是 emscripten 工具鏈的一部分）。
// 為了打包 20 個 mudlib 而要求每個貢獻者、每條 CI 都先裝一整套 emsdk（~1 GB），
// 成本與收益完全不成比例——我們需要的功能只是「一堆檔案 → 一個 blob + 一張表」。
//
// 【推理】file_packager 產出的 mudlib.js 是一段自帶 fetch/進度/相依計數的膠水，
// 綁定 emscripten 的 preRun 生命週期；而本專案的 driver 是**手動 boot** 的
// （fluffos_boot 是明確呼叫，不是 main()），根本不需要那套生命週期。
// 拆成「manifest.json + data blob + 這支載入器」之後：
//   * 打包端只是走訪目錄與串接位元組（tools/pack-lib.mjs，零相依）
//   * 載入端 node 與瀏覽器共用同一份（本檔），所以打包格式只有一個實作
//   * 進度條拿得到真實的 Content-Length 與已讀位元組
//
// 【證據】fluffos-v2026.0729.0-wasm.zip 的 pack-mudlib.sh 註解：
// “Emscripten's file_packager must be reachable (emsdk on PATH)”。

/** 映像格式版本。改變 manifest 欄位語意時要進版。 */
export const IMAGE_FORMAT = 1;

/**
 * 依 manifest 把 blob 內容還原成 MEMFS 裡的檔案樹。
 *
 * @param {object} FS          Module.FS
 * @param {object} manifest    pack-lib.mjs 產出的 manifest
 * @param {Uint8Array} bytes   mudlib.data 的內容
 * @param {(done:number,total:number)=>void} [onProgress]
 */
export function unpackImage(FS, manifest, bytes, onProgress = () => {}) {
  if (manifest.format !== IMAGE_FORMAT) {
    throw new Error(`不認得的映像格式 ${manifest.format}（本程式支援 ${IMAGE_FORMAT}）`);
  }
  const mount = manifest.mount || '/mudlib';

  // 先建目錄。manifest.dirs 已由打包端排序成「父目錄在前」。
  mkdirp(FS, mount);
  for (const d of manifest.dirs) mkdirp(FS, mount + '/' + d);

  let done = 0;
  for (const f of manifest.files) {
    const view = bytes.subarray(f.at, f.at + f.size);
    const full = mount + '/' + f.path;
    try {
      FS.writeFile(full, view);
    } catch (e) {
      // 父目錄不在 manifest.dirs 裡：補建一次再寫。
      //
      // 【WHY】寫檔不補目錄是刻意的——這是一萬多個檔的熱迴圈，每個檔都
      // mkdirp 會白白多做幾萬次 syscall。代價是 dirs 一旦過期（例如映像被
      // 補件工具改過而沒重算），就會拋 `ErrnoError errno 44`，訊息裡連是哪
      // 一個檔都沒有，看起來像 driver 壞了。實測 nt7 補件後就是這樣掛掉的。
      //
      // 【推理】所以快路徑保留，但失敗時不要直接死：補目錄重試一次，
      // 真的還不行才拋——而且要把**檔名**帶進錯誤訊息裡，讓下一個人
      // 五秒內就知道問題在映像不在 driver。
      mkdirp(FS, full.slice(0, full.lastIndexOf('/')));
      try {
        FS.writeFile(full, view);
      } catch (e2) {
        throw new Error(`寫入 ${f.path} 失敗（errno ${e2?.errno ?? e?.errno}）`
          + '——映像的 dirs 與 files 不一致，重新打包即可');
      }
    }
    done += 1;
    if ((done & 0x3ff) === 0) onProgress(done, manifest.files.length);
  }
  onProgress(manifest.files.length, manifest.files.length);
  return { mount, files: manifest.files.length, bytes: bytes.length };
}

function mkdirp(FS, dir) {
  const parts = dir.split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur += '/' + p;
    try { FS.mkdir(cur); } catch { /* 已存在 */ }
  }
}

/**
 * 瀏覽器端：抓 manifest 與 data，回報下載進度。
 *
 * @param {string} base   例如 './libs/lpmudname'
 */
export async function fetchImage(base, onProgress = () => {}) {
  const manifest = await (await fetch(base + '/mudlib.json')).json();

  // ★ 優先抓 gzip 版（mudlib.data.gz）。
  //
  // 【WHY】兩件事同時解決：
  //   ① 空間——mudlibs-main 的 98 台原始碼共 3.7 GB，而 GitHub Pages 上限 1 GB。
  //      LPC 原始碼實測壓到 **23-24%**（夺宝江湖 4→1 MB、大梦江湖 14→3 MB），
  //      不壓縮就放不下，這是能不能收錄它們的先決條件。
  //   ② 手機體驗——85 MB 的映像在手機上是最痛的一環，壓到 20 MB 直接快四倍。
  //
  // 【推理】解壓交給瀏覽器原生的 DecompressionStream（Chrome/Safari/Firefox 都有，
  // node 22+ 也有），不引第三方壓縮函式庫；串流解壓所以記憶體不會多一份完整拷貝。
  // 舊映像（沒有 .gz）照走原路，兩種格式並存——不會因為換格式而讓任何一台掛掉。
  const gzUrl = base + '/mudlib.data.gz';
  const gzRes = typeof DecompressionStream === 'function'
    ? await fetch(gzUrl).catch(() => null) : null;
  if (gzRes?.ok) {
    const total = Number(gzRes.headers.get('content-length')) || 0;
    let loaded = 0;
    // 進度回報用「壓縮後」的位元組數：那才是使用者真的在等的東西
    const counted = gzRes.body.pipeThrough(new TransformStream({
      transform(chunk, ctrl) { loaded += chunk.length; onProgress(loaded, total || loaded); ctrl.enqueue(chunk); },
    }));
    const buf = await new Response(counted.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    return { manifest, bytes: new Uint8Array(buf) };
  }

  const res = await fetch(base + '/mudlib.data');
  if (!res.ok) throw new Error(`下載 mudlib.data 失敗：HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length')) || manifest.totalBytes || 0;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress(buf.length, total || buf.length);
    return { manifest, bytes: buf };
  }

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total || loaded);
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return { manifest, bytes };
}
