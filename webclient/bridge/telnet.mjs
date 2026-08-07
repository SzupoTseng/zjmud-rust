// telnet IAC 剝除（橋接用的 Buffer 介面）。
//
// 【WHY 這裡只剩一層轉接】
// 真正的實作已經搬到 ../src/js/telnet.js，因為 WASM 版（伺服器跑在分頁裡）
// 也需要同一套邏輯，而瀏覽器沒有 node 的 Buffer。原本這裡有一份完整實作，
// 與 Rust 版並列為「兩份必須行為一致」的重複——設計書 §031 記錄了這筆技術債。
//
// 【推理】把實作改寫成 Uint8Array 後，node 端只需要 Buffer↔Uint8Array 的薄轉接，
// 而 Buffer 本來就是 Uint8Array 的子類別，轉接成本是零拷貝的 Buffer.from(view)。
// 保留這個模組與它的具名匯出，是為了讓 bridge/server.mjs 與 test/bridge.test.mjs
// 一行都不用改（該測試以 42 個實機位元組釘住行為）。
//
// 【證據】docs/ZJMUD_CLIENT_PROTOCOL.md §1.0；test/bridge.test.mjs 的實機封包。

import { filterBytes, IAC, DONT, DO, WONT, WILL, SB, SE } from '../src/js/telnet.js';

export { IAC, DONT, DO, WONT, WILL, SB, SE };

/**
 * @param {Buffer} buf
 * @returns {{ data: Buffer, reply: Buffer }}
 */
export function filter(buf) {
  const { data, reply } = filterBytes(new Uint8Array(buf));
  return { data: Buffer.from(data), reply: Buffer.from(reply) };
}
