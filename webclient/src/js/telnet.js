// telnet IAC 剝除（位元組層）—— 與 src-tauri/src/telnet.rs 同一套邏輯。
//
// 【WHY 這份檔案存在於 src/js 而不是只在 bridge/】
// 原本 IAC 剝除只有兩份實作：Rust（桌面版）與 bridge/telnet.mjs（瀏覽器版，
// 跑在橋接程序裡）。WASM 版把伺服器搬進分頁之後，**瀏覽器自己要面對原始位元組**
// ——driver 的 onOutput 送出的是真正的 telnet 串流（fluffos src/net/telnet.cc
// 一連上就送 6 組 IAC），沒有任何中間程序可以代勞。
//
// 【推理】直接把 bridge/telnet.mjs 拿來用不行：它的介面是 node 的 Buffer，
// 瀏覽器沒有。改寫成 Uint8Array 之後兩邊都能用，於是 bridge/telnet.mjs 退化成
// 一層 Buffer 轉接（保留舊介面，bridge.test.mjs 一條都不用改）。
//
// 【證據】docs/ZJMUD_CLIENT_PROTOCOL.md §1.0（IAC 序列與「一律拒絕」策略）；
// wasm driver 實測首包 42 bytes：
//   ff fd 18 | ff fd 1f | ff fd 27 | ff fb 46 | ff fb 2a | ff fb 5a
//   後接 "ver1.0:<crypt>\r\n"
// 注意 **wasm 版沒有 MCCP2（0x56）**——compress package 未連結，zlib 不存在；
// 原生版有。策略仍是全部拒絕，所以兩者行為一致。

export const IAC = 255;
export const DONT = 254;
export const DO = 253;
export const WONT = 252;
export const WILL = 251;
export const SB = 250;
export const SE = 240;

/**
 * 從一段位元組中剝除 telnet IAC 序列，並產生「全部拒絕」的回覆。
 *
 * @param {Uint8Array} buf
 * @returns {{ data: Uint8Array, reply: Uint8Array }}
 */
export function filterBytes(buf) {
  const data = [];
  const reply = [];
  let i = 0;

  while (i < buf.length) {
    if (buf[i] !== IAC) {
      data.push(buf[i]);
      i += 1;
      continue;
    }
    const cmd = buf[i + 1];
    if (cmd === undefined) break; // 不完整，丟棄

    if (cmd === IAC) {
      data.push(IAC); // 跳脫的 0xFF，還原成單一位元組
      i += 2;
    } else if (cmd === SB) {
      // 子協商：一路吃到 IAC SE
      let j = i + 2;
      while (j + 1 < buf.length && !(buf[j] === IAC && buf[j + 1] === SE)) j += 1;
      i = j + 2;
    } else if (cmd === WILL) {
      if (buf[i + 2] === undefined) break;
      reply.push(IAC, DONT, buf[i + 2]);
      i += 3;
    } else if (cmd === DO) {
      if (buf[i + 2] === undefined) break;
      reply.push(IAC, WONT, buf[i + 2]);
      i += 3;
    } else if (cmd === WONT || cmd === DONT) {
      if (buf[i + 2] === undefined) break;
      i += 3;
    } else {
      i += 2; // 其他兩位元組命令（NOP/AYT/GA…）
    }
  }

  return { data: Uint8Array.from(data), reply: Uint8Array.from(reply) };
}

/**
 * 逐行切分器：吃位元組、吐出 UTF-8 字串行（已剝 IAC、已去 \r）。
 *
 * 分行必須在**位元組層**做，理由與 telnet.rs 的 spawn_reader 相同：
 * 0xFF 不是合法 UTF-8，先解碼再分行會在第一個 IAC 就壞掉。
 */
export function createLineReader({ maxLineBytes = 64 * 1024 } = {}) {
  let pending = new Uint8Array(0);
  const decoder = new TextDecoder('utf-8', { fatal: false });

  return {
    /**
     * @param {Uint8Array} chunk
     * @returns {{ lines: string[], reply: Uint8Array }}
     */
    push(chunk) {
      const { data, reply } = filterBytes(chunk);
      if (data.length) {
        const merged = new Uint8Array(pending.length + data.length);
        merged.set(pending, 0);
        merged.set(data, pending.length);
        pending = merged;
      }

      const lines = [];
      let idx;
      while ((idx = pending.indexOf(0x0a)) !== -1) {
        let line = pending.subarray(0, idx);
        pending = pending.subarray(idx + 1);
        if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
        if (line.length > maxLineBytes) line = line.subarray(0, maxLineBytes);
        lines.push(decoder.decode(line));
      }
      // 異常伺服器送出無限長的一行時不要把記憶體吃光
      if (pending.length > maxLineBytes) pending = new Uint8Array(0);

      return { lines, reply };
    },

    /** 緩衝裡有沒有還沒斷行的東西（＝可能是一個停在那裡等輸入的提示）。 */
    hasPartial() { return pending.length > 0; },

    /**
     * 把未斷行的緩衝**當成一行**吐出來。
     *
     * 【WHY】telnet mudlib 的提示是 `input_to()` 印的：「您的英文名字：」
     * **後面沒有換行**——游標就停在冒號後面等人打字。分行器只在看到 \n 才
     * 產出一行，於是提示會永遠躺在緩衝裡，登入接應器一個提示都看不到。
     * zjmud 流程碰不到這件事（它的每一句都帶 \n），所以這是接 telnet lib
     * 才暴露的缺口。
     *
     * 【推理】判斷「這是提示」的依據是**時間**不是內容：伺服器講完一段話
     * 之後停下來，緩衝裡還剩半行——那半行就是在等你的東西。所以 flush 由
     * 上層在輸出靜置一小段時間後呼叫，而不是每個 chunk 都硬切。
     */
    flushPartial() {
      if (!pending.length) return null;
      let line = pending;
      pending = new Uint8Array(0);
      if (line.length > maxLineBytes) line = line.subarray(0, maxLineBytes);
      return decoder.decode(line);
    },
  };
}
