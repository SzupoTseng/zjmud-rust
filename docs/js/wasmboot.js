// 瀏覽器端的 WASM 啟動流程 —— 「選一個 mud → 在這個分頁裡把它跑起來」。
//
// 【WHY】原本第一個畫面問的是「位址 / 埠號」，那是**遠端伺服器**的心智模型。
// WASM 版沒有伺服器可連：每個 mud 就是一份靜態映像，選哪個就把哪個灌進 driver。
// 所以連線面板要從「填位址」變成「挑一個 mudlib」。
//
// 【推理】catalogue（libs/index.json）由 build-site.mjs 產生，內容是
// boot-test 真的跑過一遍的結果——badge 不是人工標的，是「註冊→建角→進世界」
// 走完才給的。沒有 catalogue 的情況（開發時用橋接、或桌面版）本模組完全不動作，
// 連 driver 都不會下載，舊的兩條傳輸路徑行為不變。
//
// 【證據】src/wasm/comm_wasm.cc 的 wasm_console_connect()；
// tools/boot-test.mjs 對 LPMud-Name 的實測：
// `ver1.0:byz0rmpISExtQ` → ESC000 0008 → 建角 → 進世界，opcode 000/006/021。

import { createWasmDriver } from './wasmdriver.js';
import { loadMetadata } from './telnetlogin.js';
import { fetchImage, unpackImage } from './mudlibimage.js';

/** catalogue 與 driver 的相對位置（build-site.mjs 產生的版面）。 */
const CATALOGUE_URL = './libs/index.json';
const DRIVER_URL = './_driver/fluffos.js';

/**
 * 讀取可選的 mud 清單。
 * 沒有這個檔（＝不是 WASM 站台）就回空陣列，呼叫端據此保留原本的位址／埠號介面。
 */
export async function loadCatalogue() {
  try {
    const res = await fetch(CATALOGUE_URL, { cache: 'no-cache' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.muds) ? data.muds : [];
  } catch {
    return []; // file:// 或桌面版：沒有 catalogue 很正常，不是錯誤
  }
}

/** driver glue 是 classic script（會掛上 globalThis.createFluffOS），只載入一次。 */
let driverScriptPromise = null;
function loadDriverScript() {
  if (driverScriptPromise) return driverScriptPromise;
  driverScriptPromise = new Promise((resolve, reject) => {
    if (globalThis.createFluffOS) { resolve(globalThis.createFluffOS); return; }
    const s = document.createElement('script');
    s.src = DRIVER_URL;
    s.onload = () => {
      if (globalThis.createFluffOS) resolve(globalThis.createFluffOS);
      else reject(new Error('driver 載入了但沒有 createFluffOS'));
    };
    s.onerror = () => reject(new Error('無法載入 ' + DRIVER_URL));
    document.head.appendChild(s);
  });
  return driverScriptPromise;
}

/**
 * 啟動一個 mud。完成後 globalThis.__ZJMUD_WASM__ 就緒，net.js 的 wasm backend
 * 才會回報 available。
 *
 * @param {object} entry  catalogue 的一筆
 * @param {(phase:string, frac:number|null, detail?:string)=>void} onProgress
 */
/**
 * 關掉目前這一台（如果有）。
 *
 * 【WHY】使用者的話講得比我準：「選單選完不是就回到一對一？你沒有隔離？」
 * ——沒有。第一版把「正在跑的 driver」放在一個全域裡，然後在**呼叫端**加條件
 * 判斷要不要重開，於是換 mud 變成一個要特別處理的例外，而不是回到原本那條
 * 一客戶端對一伺服器的路。症狀就是換了沒反應、兩台同時 tick、輸出交錯。
 *
 * 【推理】隔離要做在**產生 session 的地方**，不是在每個呼叫端。所以生命週期
 * 收回這個模組：開一台新的以前，一定先把舊的關乾淨。呼叫端只需要問
 * 「我要的那台在跑嗎」，不需要知道怎麼收拾。
 */
export function disposeCurrentMud() {
  const cur = globalThis.__ZJMUD_WASM__;
  if (!cur) return false;
  try { cur.driver.shutdown(); } catch { /* 已經停了 */ }
  globalThis.__ZJMUD_WASM__ = null;
  return true;
}

/** 目前正在跑的 mud（沒有就是 null）。 */
export function currentMud() {
  return globalThis.__ZJMUD_WASM__?.entry ?? null;
}

export async function bootMudInPage(entry, onProgress = () => {}) {
  // ★ 一台就是一台：開新的以前先關舊的。這樣「選一個 mud」永遠等於
  // 「開一條全新的、乾淨的 session」，呼叫端不必知道上一台的存在。
  disposeCurrentMud();

  onProgress('載入驅動程式', null);
  const createFluffOS = await loadDriverScript();

  onProgress('下載遊戲資料', 0);
  const base = entry.base || ('./libs/' + entry.slug);
  const { manifest, bytes } = await fetchImage(base, (loaded, total) => {
    onProgress('下載遊戲資料', total ? loaded / total : null,
      `${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
  });

  onProgress('建立檔案系統', null);
  const M = await createFluffOS({
    locateFile: (f) => (f.endsWith('.wasm') ? './_driver/' + f : f),
    print: () => {},
    printErr: () => {},
    noInitialRun: true,
  });
  const { mount } = unpackImage(M.FS, manifest, bytes);
  M.FS.chdir(mount);

  // telnet 台：登入知識（會問什麼、每欄限制、怎麼答）以 metadata 檔跟映像
  // 一起發佈——接新 lib 不用改 client。載不到就退回內建 profile。
  if (entry.protocol === 'telnet') {
    try {
      const res = await fetch(`${base}/zjmud.metadata.${entry.slug}.json`, { cache: 'no-cache' });
      if (res.ok) {
        const meta = await res.json();
        if (!meta.draft) entry.loginProfile = loadMetadata(meta, entry.loginProfile);
      }
    } catch { /* 沒有 metadata：用內建 profile */ }
  }

  onProgress('啟動伺服器', null);
  // sink 由 net.js 在 open() 時換掉；driver 建立時還不知道誰要收行。
  const state = { sink: () => {}, closedSink: () => {} };
  const driver = createWasmDriver(M, {
    onLine: (line) => state.sink(line),
    onClosed: (reason) => state.closedSink(reason),
    // telnet 台的提示沒有換行，需要靜置沖洗；zjmud 台**必須關**（見 wasmdriver）
    promptFlush: entry.protocol === 'telnet',
  });
  const rc = driver.boot(manifest.config || 'config.ini');
  if (rc !== 0) throw new Error(`fluffos_boot 失敗（回傳 ${rc}）`);

  const handle = {
    entry,
    driver,
    setSink(onLine, onClosed) {
      state.sink = onLine || (() => {});
      state.closedSink = onClosed || (() => {});
    },
  };
  globalThis.__ZJMUD_WASM__ = handle;
  onProgress('就緒', 1);
  return handle;
}
