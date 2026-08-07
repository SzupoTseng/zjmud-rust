// WASM driver 綁定 —— 把「跑在同一個分頁裡的 FluffOS」包成一條位元組通道。
//
// 【WHY】瀏覽器開不了 raw TCP，所以原本一定要有 bridge/server.mjs 代開。
// 但如果**伺服器本身就在分頁裡**（FluffOS 編成 WebAssembly），就沒有網路可言了：
// driver 匯出一組位元組橋接函式，頁面直接呼叫，socket 整層消失。
//
// 【推理】設計書 §031 的結論是「協議是原生 TCP + 執行環境是瀏覽器 → 中間必須有
// 一個能開 socket 的程序」。那句話的前提是**伺服器在遠端**；WASM 版把前提拿掉了，
// 所以結論不適用（而不是被推翻）。mud.rs 依然編不成 wasm32（tokio::net），
// 但它的位置被 driver 自己的 src/wasm/comm_wasm.cc 佔走了。
//
// 【證據】fluffos v2026.0729.0 的 src/wasm/comm_wasm.cc：
//   * 匯出 fluffos_boot / fluffos_tick / fluffos_connect / fluffos_input /
//     fluffos_disconnect，回呼 Module.fluffos.onOutput / onDisconnect
//   * wasm_console_connect() 把連線偽裝成「來自第一個 external_port」
//     （`user->local_port = external_port[0].port`，comm_wasm.cc:124-126），
//     所以 LPMud-Name 的 master::connect(5001) 走 UTF-8 分支，不會踩到
//     `if (port == 5003) set_encoding("GBK")`——WASM 版沒有表格式字集，
//     真的走進去會直接 raise error。
//   * 送出的仍是**真正的 telnet 串流**，所以這裡照樣要剝 IAC（見 telnet.js）。
//
// 本模組不碰 DOM、不碰 store，node 與瀏覽器共用。

import { createLineReader } from './telnet.js';

/** driver 的心跳間隔（毫秒）。原生版由 libevent 驅動，wasm 版由頁面手動泵。 */
export const DEFAULT_TICK_MS = 20;

/**
 * 撥號後的靜默期（毫秒）。見 flushOut() 的 WHY。
 */
export const DEFAULT_GRACE_MS = 400;

/**
 * 「伺服器剛講完話」之後要靜置多久才送出佇列（毫秒）。見 flushOut() 的 WHY。
 * 對互動輸入幾乎沒有代價：使用者打指令時伺服器通常早就安靜了，窗口早已過期。
 */
export const DEFAULT_SETTLE_MS = 250;

/**
 * @param {object} M            已建立並已載入 mudlib 的 FluffOS Module
 * @param {object} opts
 * @param {(line: string) => void} opts.onLine
 * @param {(reason: string) => void} [opts.onClosed]
 * @param {(msg: string, isErr: boolean) => void} [opts.onLog]
 */
export function createWasmDriver(M, {
  onLine,
  onClosed = () => {},
  tickMs = DEFAULT_TICK_MS,
  graceMs = DEFAULT_GRACE_MS,
  settleMs = DEFAULT_SETTLE_MS,
  promptFlush = false,   // 只有 telnet 台開啟——見 flushPrompt 的 WHY
} = {}) {
  let connId = null;
  let timer = null;
  let booted = false;
  let reader = createLineReader();

  /**
   * driver 的時鐘來源：單調遞增、開機起算、從 0 開始。
   *
   * performance.now() 存在時用它（單調，不受系統時間調整影響）；
   * 沒有的話退回 Date.now()——差值仍然正確，只是理論上可能被改時間干擾。
   */
  const monotonicNow = () => (typeof performance !== 'undefined' && performance.now
    ? performance.now() : Date.now());
  let clockOrigin = monotonicNow();

  /**
   * 待送佇列。**不可以在 onOutput 裡直接呼叫 fluffos_input。**
   *
   * 【WHY】boot-test 第一版把「收到版本挑戰 → 立刻送帳號」寫在 onLine 裡，
   * 結果伺服器只收到握手就再也沒有下文（實測只回 2 行、卡在 authing 30 秒）。
   * 同一段邏輯改成延遲 300ms 送出就一路走到 ESC000 0008（要求建角）。
   *
   * 【推理】onOutput 是 driver **在自己的輸出路徑中途**回呼頁面的；此時再呼叫
   * fluffos_input 等於在 telnet 解析器還沒吐完位元組時重入 driver。官方的參考
   * 前端把這件事寫在註解裡：「fluffos_input() can emit output before it returns,
   * and onOutput arrives while the telnet parser is mid-byte-stream, so sends
   * must be queued」。所以正解不是「延遲一點送」，而是**一律排隊、在 tick 裡送**。
   *
   * 【證據】mudlibs.fluffos.info 的 play 頁 inline script #4（第 934-935 行註解）；
   * 本專案 boot-test 的 before/after 實測（2 行 vs 完整登入序列）。
   */
  const outQueue = [];
  let graceUntil = 0;
  let lastOutputAt = 0;
  /**
   * 是否已經明確關閉。**不能用 connId === null 當「還沒連上」的判準。**
   *
   * 【WHY】boot-test 收到握手行後呼叫 send()，位元組卻連佇列都沒進去
   *（加了 [queue] 追蹤才發現 rawSend 一次都沒被呼叫），伺服器當然沒反應。
   *
   * 【推理】fluffos_connect() 會**在自己還沒回傳之前**就把 logon 的輸出
   * 同步回呼給頁面——此時 `connId = M.ccall(...)` 這行賦值還沒發生，connId
   * 仍是 null。舊的 send() 以 `connId === null` 當「尚未連線」直接 return，
   * 於是「收到握手 → 立刻回覆」這條最自然的寫法被靜默吞掉。
   * 先前誤判成時序問題（試過撥號 grace、輸出靜置窗），兩者都無效，因為根本
   * 不是時間問題，是**狀態判斷用錯了變數**。
   *
   * 【證據】mudlibs.fluffos.info play 頁 inline script #4 有同一句警告：
   * “The synchronous bridge can emit before fluffos_connect() [returns]”；
   * 本專案以 WASM_DEBUG 追蹤確認 rawSend 呼叫次數為 0。
   */
  let closed = true;

  M.fluffos = {
    onOutput: (id, bytes) => {
      if (connId !== null && id !== connId) return; // 別條連線的位元組（多開時）
      lastOutputAt = Date.now();
      const { lines, reply } = reader.push(Uint8Array.from(bytes));
      // 協商一律拒絕。回覆要在同一個 tick 內送回去，否則 driver 會一直等。
      if (reply.length && !closed) rawSend(reply);
      for (const line of lines) onLine(line);
    },
    onDisconnect: (id) => {
      if (connId !== null && id !== connId) return;
      connId = null;
      closed = true;
      onClosed('伺服器關閉連線');
    },
  };

  function rawSend(bytes) {
    outQueue.push(Array.from(bytes));
  }

  /**
   * 把佇列裡的位元組真正交給 driver。只在 tick 的堆疊上呼叫。
   *
   * 兩個閘門：撥號後的 grace 期，以及「伺服器剛講完話」的靜置期。
   *
   * 【WHY】收到 `ver1.0:` 挑戰後立刻回覆，伺服器完全沒反應（只回 2 行、卡在
   * authing 30 秒）；同一段邏輯延後 300ms 送出就一路走到 ESC000 0008（要求建角）。
   * 兩次唯一的差別就是這個延遲——先試過只在 connect() 後設 grace，**無效**，
   * 因為挑戰行是在 connect 之後 1-2 秒（編譯 logind 期間）才出現，grace 早就過期。
   * 所以窗口必須錨在「最後一次收到輸出」，不是「撥號」。
   *
   * 【推理】WASM 版沒有網路往返：回覆會在下一個 20ms tick 就抵達，落在伺服器
   * 還沒把接收端準備好的空窗裡而被丟掉。真實 TCP 的 RTT 天然蓋掉了這段空窗，
   * 所以同一套客戶端邏輯在橋接版從來不會踩到——這是**只有把伺服器搬進分頁才會
   * 出現的新失效模式**，不是客戶端的既有 bug。
   *
   * 【證據】20ms → 收到 2 行、stage 停在 authing；300ms → 版本验证成功 →
   * ESC000 0008 → 建角 → 進世界。另見 mudlibs.fluffos.info play 頁 inline
   * script #4 註解：sends must be queued（重入問題，與本窗口是兩件事，都要處理）。
   */
  function flushOut() {
    const now = Date.now();
    if (graceUntil && now < graceUntil) return;
    if (lastOutputAt && now - lastOutputAt < settleMs) return;
    while (outQueue.length) {
      if (connId === null) { outQueue.length = 0; return; }
      const arr = outQueue.shift();
      M.ccall('fluffos_input', null, ['number', 'array', 'number'], [connId, arr, arr.length]);
    }
  }

  /**
   * 提示行沖洗：伺服器停止輸出一小段時間後，把分行器裡未斷行的殘餘
   * 當成一行交出去。telnet lib 的 input_to 提示（「您的英文名字：」）
   * 沒有換行，不沖的話登入接應器一個提示都看不到。詳見 telnet.js flushPartial。
   */
  const PROMPT_FLUSH_MS = 300;
  function flushPrompt() {
    // ★ 預設關閉，只有 telnet 台才開。
    // 【WHY】這個沖洗上線後，使用者手機上的書劍（zjmud 台）卡死在握手：
    // 畫面是被切成碎片的 ver1.0 挑戰行。手機較慢，driver 的輸出分好幾段
    // 抵達，段與段之間超過 300ms——沖洗把**半行**當提示吐出去，
    // isChallenge 永遠看不到完整的挑戰行，登入視窗就不開。
    // zjmud 協議每一句都帶 \n，本來就不需要沖洗；需要的只有 telnet 台
    // （input_to 的提示真的沒有換行）。所以這是 per-mud 的開關，不是全域行為。
    if (!promptFlush) return;
    if (closed || !reader.hasPartial()) return;
    if (Date.now() - lastOutputAt < PROMPT_FLUSH_MS) return;
    const line = reader.flushPartial();
    if (line != null) onLine(line);
  }

  function startTick() {
    if (timer) return;
    timer = setInterval(() => {
      try {
        flushOut();
        flushPrompt();
        // ★ 時鐘必須是「**這個 driver** 開機起算」的毫秒，而且從 0 開始。
        //
        // 【WHY】兩次都是同一個症狀：91书剑 一連上就收到
        // 「您花在连线进入手续的时间太久了」——那是 clone/user/login.c 的
        // `call_out("time_check", 30)`，理應 30 秒後才跑。
        //   第一版錯在用 Date.now()（epoch 毫秒）→ 第一拍就宣告過了 1.7 兆毫秒。
        //   第二版改用 performance.now() 仍然錯，只是錯得比較小：那是**分頁載入**
        //   起算的，而使用者是先看清單、再等 29 MB 下載完才開機的，開機時它
        //   早就是幾十萬毫秒了。node 測試看不到這件事，因為那邊開機就在 process
        //   起頭，performance.now() 還很小——**這是只有在瀏覽器才會踩到的差異**。
        //
        // 【推理】driver 把傳進來的值當成單調遞增的毫秒時鐘來推進 call_out 與
        // heartbeat。它要的是「經過了多久」，不是「現在幾點」。所以正確的來源
        // 是開機當下記一個原點，之後一律送差值——這樣不管分頁開多久、
        // 使用者在清單頁待多久，driver 看到的第一拍永遠接近 0。
        //
        // 【證據】把 performance.now() 加上 300000 的偏移量重跑 91书剑，
        // 逐字重現使用者截圖：只收到握手行 ＋ ESC015 逾時訊息就沒了；
        // 改成零起點之後同一份映像一路走到進世界。
        M.ccall('fluffos_tick', 'number', ['number'], [monotonicNow() - clockOrigin]);
      } catch (e) {
        stopTick();
        onClosed('driver 異常：' + (e?.message ?? e));
      }
    }, tickMs);
  }

  function stopTick() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    /** 啟動 driver。configPath 相對於已 chdir 的 mudlib 根目錄。 */
    boot(configPath) {
      if (booted) return 0;
      // 原點必須壓在**開機這一刻**，不是模組載入時：使用者可能在清單頁停留
      // 很久，或先下載完 85 MB 的映像才開機（見 startTick 的長註解）。
      clockOrigin = monotonicNow();
      const rc = M.ccall('fluffos_boot', 'number', ['string'], [configPath]);
      if (rc === 0) { booted = true; startTick(); }
      return rc;
    },

    isBooted: () => booted,

    /** 開一條虛擬連線（相當於一個 telnet 客戶端撥進來）。 */
    connect() {
      if (!booted) throw new Error('driver 尚未啟動');
      reader = createLineReader();
      closed = false;   // ★ 必須在 ccall 之前：logon 的輸出會同步回呼進來
      connId = M.ccall('fluffos_connect', 'number', [], []);
      if (connId < 0) { connId = null; closed = true; throw new Error('fluffos_connect 失敗'); }
      graceUntil = Date.now() + graceMs;
      return connId;
    },

    /** 送一行指令（自動補換行，與 bridge/server.mjs 的語意一致）。 */
    send(line) {
      if (closed) return;
      rawSend(new TextEncoder().encode(String(line) + '\n'));
    },

    disconnect() {
      closed = true;
      outQueue.length = 0;
      if (connId === null) return;
      const id = connId;
      connId = null;
      try { M.ccall('fluffos_disconnect', null, ['number'], [id]); } catch { /* 已斷 */ }
    },

    shutdown() {
      this.disconnect();
      stopTick();
    },
  };
}
