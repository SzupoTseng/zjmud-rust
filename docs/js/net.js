// 傳輸層抽象 —— 桌面與瀏覽器共用同一份前端。
//
// 三種實作，介面完全相同，由執行環境自動選擇：
//
//   TauriTransport      桌面版。Rust 端直接開 raw TCP，不需要任何額外程序。
//   WebSocketTransport  瀏覽器版。連到 bridge/server.mjs，由它代開 TCP。
//   WasmTransport       GitHub Pages 版。伺服器**就在這個分頁裡**（FluffOS 編成
//                       WebAssembly），沒有 socket 也沒有橋接（見 wasmdriver.js）。
//
// 上層（main.js / ui.js）完全不知道自己跑在哪一種底下。
// 見 docs/ZJMUD_CLIENT_LOGIC_DESIGN.md §4.1。

/**
 * @typedef {'IDLE'|'CONNECTING'|'OPEN'|'RECONNECTING'|'FAILED'} ConnState
 */

/** 指數退避的重試間隔（毫秒）。用完最後一項就停在 30 秒。 */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const MAX_RETRIES = 8;

/** Tauri v2 的 IPC 入口。在瀏覽器中會是 undefined。 */
function tauri() {
  return globalThis.__TAURI__ ?? null;
}

export function isTauri() {
  return tauri() != null;
}

/** 目前執行環境：'tauri' | 'browser'。 */
export function environment() {
  return isTauri() ? 'tauri' : 'browser';
}

// ══ Tauri：Rust 端直連 TCP ═══════════════════════════

function tauriBackend({ onLine, onClosed }) {
  let unlisteners = [];

  async function unbind() {
    for (const un of unlisteners) {
      try { await un(); } catch { /* 已解除 */ }
    }
    unlisteners = [];
  }

  return {
    name: 'tauri',
    available: () => tauri() != null,
    unavailableReason: '未偵測到 window.__TAURI__（IPC 橋接未載入）',

    async open(host, port) {
      const t = tauri();
      await unbind();
      const un1 = await t.event.listen('mud://line', (e) => onLine(String(e.payload ?? '')));
      const un2 = await t.event.listen('mud://state', (e) => {
        const p = e.payload ?? {};
        if (p.state === 'closed' || p.state === 'error') {
          onClosed(p.reason || p.message || '連線中斷');
        }
      });
      unlisteners = [un1, un2];
      await t.core.invoke('mud_connect', { host, port });
    },

    async send(line) {
      await tauri().core.invoke('mud_send', { line });
    },

    async close() {
      const t = tauri();
      if (t) { try { await t.core.invoke('mud_disconnect'); } catch { /* 已斷 */ } }
      await unbind();
    },
  };
}

// ══ 瀏覽器：WebSocket → 橋接 → TCP ════════════════════

function websocketBackend({ onLine, onClosed }) {
  let ws = null;

  /** 橋接與網頁同源，所以直接沿用當前頁面的 host/port。 */
  function bridgeUrl() {
    const loc = globalThis.location;
    const scheme = loc?.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${loc.host}/mud`;
  }

  return {
    name: 'websocket',
    available: () => typeof WebSocket !== 'undefined' && Boolean(globalThis.location?.host),
    unavailableReason: '此頁面不是由橋接程序供應（請用 npm run web 啟動後從 http:// 開啟）',

    open(host, port) {
      return new Promise((resolve, reject) => {
        ws = new WebSocket(bridgeUrl());
        let settled = false;

        ws.addEventListener('open', () => {
          // 第一則訊息是連線請求，其餘都是指令
          ws.send(JSON.stringify({ host, port }));
        });

        ws.addEventListener('message', (e) => {
          const text = String(e.data ?? '');

          // 橋接的狀態訊息包成 {"__state":{...}}，與遊戲資料區隔
          if (text.startsWith('{"__state"')) {
            let st;
            try { st = JSON.parse(text).__state; } catch { st = null; }
            if (!st) return;
            if (st.state === 'open') {
              if (!settled) { settled = true; resolve(); }
            } else if (st.state === 'error') {
              if (!settled) { settled = true; reject(new Error(st.message || '橋接錯誤')); }
              else onClosed(st.message || '橋接錯誤');
            } else if (st.state === 'closed') {
              onClosed(st.reason || '伺服器關閉連線');
            }
            return;
          }
          onLine(text);
        });

        ws.addEventListener('error', () => {
          if (!settled) { settled = true; reject(new Error('無法連上橋接程序 ' + bridgeUrl())); }
        });

        ws.addEventListener('close', () => {
          if (!settled) { settled = true; reject(new Error('橋接連線被關閉')); }
          else onClosed('橋接連線中斷');
        });
      });
    },

    async send(line) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(line);
    },

    async close() {
      if (ws) { try { ws.close(); } catch { /* 已關 */ } }
      ws = null;
    },
  };
}

// ══ WASM：伺服器就在這個分頁裡 ═══════════════════════

/**
 * 由 wasmboot.js 先把 mudlib 灌進 driver 並 boot 起來，這裡只負責「撥號」。
 *
 * 【WHY 不在這裡 boot】選哪一個 mud 是**使用者的選擇**，而且要顯示下載進度
 * （mudlib 映像動輒 30 MB）。傳輸層不該知道這些；它只需要一條已經活著的通道。
 *
 * 【推理】host/port 在這條路上沒有意義——driver 的 wasm_console_connect()
 * 會把連線一律標成「來自第一個 external_port」（comm_wasm.cc:124-126）。
 * 保留參數是為了讓三個 backend 的介面完全一致，上層不必分支。
 */
function wasmBackend({ onLine, onClosed }) {
  const handle = () => globalThis.__ZJMUD_WASM__ ?? null;

  return {
    name: 'wasm',
    available: () => handle() != null,
    unavailableReason: '尚未選擇 mud（WASM 模式要先挑一個 mudlib 才會有伺服器）',

    async open() {
      const h = handle();
      if (!h) throw new Error('WASM driver 尚未就緒');
      h.setSink(onLine, onClosed);
      h.driver.connect();
    },

    async send(line) {
      handle()?.driver.send(line);
    },

    async close() {
      handle()?.driver.disconnect();
    },
  };
}

// ══ 共用的連線狀態機 ═════════════════════════════════

export function createTransport({ onLine, onState }) {
  let host = null;
  let port = null;
  let state = 'IDLE';
  let retries = 0;
  let retryTimer = null;
  let manualClose = false;
  /** 是否有一個 connect() 正在飛行中。用來擋掉重入與「取代舊連線」造成的假斷線。 */
  let connecting = false;

  function setState(next, extra = {}) {
    state = next;
    onState?.({ state: next, host, port, retries, ...extra });
  }

  function handleClosed(reason) {
    if (manualClose) { setState('IDLE'); return; }
    // ★ 連線建立中收到的 closed 一律忽略（縱深防禦，見 connect() 的說明）。
    //   它必定來自「正被取代的舊連線」，不是伺服器把我們踢掉。
    if (connecting) return;
    scheduleReconnect(reason);
  }

  /**
   * 依環境挑 backend。**必須延遲到用的時候才決定**。
   *
   * 【WHY】原本在 createTransport() 當下就固定了 backend；WASM 模式下
   * driver 是使用者在連線面板選了 mud、下載完映像才存在的，那時 transport
   * 早就建好了，於是永遠選到 websocket，按下「進入」只會得到「橋接連不上」。
   *
   * 【推理】三個 backend 的介面相同，重挑的成本是建一個小物件；而「什麼時候
   * 有 driver」不是傳輸層能預測的事，所以判斷點要移到 connect()／close() 當下。
   */
  let backend = null;
  function currentBackend() {
    const wantWasm = globalThis.__ZJMUD_WASM__ != null;
    if (backend && (backend.name === 'wasm') === wantWasm) return backend;
    const wire = { onLine: (l) => onLine?.(l), onClosed: handleClosed };
    backend = wantWasm ? wasmBackend(wire)
      : (isTauri() ? tauriBackend(wire) : websocketBackend(wire));
    return backend;
  }

  function scheduleReconnect(reason) {
    if (retries >= MAX_RETRIES) {
      setState('FAILED', { lastError: reason });
      return;
    }
    const wait = BACKOFF_MS[Math.min(retries, BACKOFF_MS.length - 1)];
    retries += 1;
    setState('RECONNECTING', { nextRetryMs: wait, lastError: reason });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { connect(host, port, true); }, wait);
  }

  /**
   * 建立連線。**必須擋重入**。
   *
   * 【WHY】使用者回報「登入成功提示狂跳」，伺服器 log 每秒多一次登入，累計五萬次。
   *
   * 【推理】原本沒有任何重入保護：只要 connect() 被呼叫，就無條件再開一條。
   * 而 Rust 端的 connect() 會先關掉舊連線，舊連線關閉時 emit `closed`，
   * 前端 handleClosed() 當成非預期斷線 → scheduleReconnect → connect() → 循環。
   * 關鍵在於**退避永遠升不上去**：每次重連都成功，成功就把 retries 歸零，
   * 於是永遠停在 BACKOFF_MS[0] = 1 秒，形成穩定 1 Hz 打樁 —— 與 log 完全吻合。
   *
   * 【證據】伺服器 `world/log/debug.log` 每 8 秒增加約 4000 bytes ≈ 每秒一次
   * get_user 密碼驗證；關閉客戶端後增長立刻歸零，確認來源是本程式。
   * 修法分三層：Rust 端不為「被取代」emit closed（mud.rs StopReason）、
   * 前端擋重入（本函式）、connecting 期間忽略 closed（handleClosed）。
   */
  async function connect(h, p, isRetry = false) {
    const be = currentBackend();
    if (!be.available()) {
      setState('FAILED', { lastError: be.unavailableReason });
      return false;
    }
    // ★ 已經在連、或已經連上而且是連同一個位址 → 不重開。
    if (connecting) return false;
    if (state === 'OPEN' && !isRetry && h === host && p === port) return true;

    host = h;
    port = p;
    manualClose = false;
    if (!isRetry) retries = 0;

    connecting = true;
    setState('CONNECTING');
    try {
      await be.open(host, port);
      retries = 0;
      setState('OPEN');
      return true;
    } catch (err) {
      scheduleReconnect(err?.message ?? String(err));
      return false;
    } finally {
      connecting = false;
    }
  }

  async function send(line) {
    if (state !== 'OPEN') return false;
    try {
      await currentBackend().send(line);
      return true;
    } catch (err) {
      console.warn('[net] 送出失敗：', err);
      return false;
    }
  }

  async function close() {
    manualClose = true;
    clearTimeout(retryTimer);
    retries = 0;
    await currentBackend().close();
    setState('IDLE');
  }

  /** 使用者手動要求立刻重試（不等退避計時）。 */
  function retryNow() {
    clearTimeout(retryTimer);
    retries = 0;
    if (host && port) connect(host, port, false);
  }

  /** 停止自動重連但保持現有連線（登入逾時止血用）。 */
  function stopReconnect() {
    clearTimeout(retryTimer);
    retries = MAX_RETRIES;
  }

  return {
    connect, send, close, retryNow, stopReconnect,
    get state() { return state; },
    get backend() { return currentBackend().name; },
  };
}
