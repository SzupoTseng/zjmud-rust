// 「這個檔案是不是玩家存檔」—— **唯一的判準來源**。
//
// 【WHY 要抽出來】同一個問題本來有三份答案，而且只有兩份是對的：
//
//   webclient/tools/import-lib.mjs   路徑要含 `data/`，且只看前 4096 bytes
//   webclient/tools/fix-image.mjs    路徑像登入目錄 **或** 內容有帶值 password
//   scripts/scan-images.mjs          同上，但是**複製**的一份
//
// 第一份漏掉了真實世界裡大多數的存檔位置——實測 184 台映像裡有
// **45,692 個**玩家存檔被打包發佈，而它們多半不在 `data/` 底下：
//   temp/login/a/a11216266.o      dump/2020-6-15/login/a/…
//   drop/login_bak/a/aaa.o        suicide/login/…
//   u/<巫師>/badplayer/login/…    data/user/a/aaa.o
//
// 第二、三份判準相同但是**兩份程式碼**——那是會慢慢漂移的東西，
// 而「修的」與「驗的」一旦分岔，缺口就會再出現一次（CLAUDE.md §52）。
//
// 【判準】兩條任一成立就是玩家存檔：
//   ① 路徑落在登入／人物存檔目錄（login／user／player／char）
//   ② 內容有 password 欄而且**有值**（巫師自己的物件也可能帶密碼）
// 兩條都不成立的 `.o` 是遊戲資料（公告板、語言表、任務狀態），不要動它。
//
// 【WHY 不整份掃內容】存檔可能很大，而 password 欄一律在前段；
// 但**不要**像 import-lib 原本那樣只看 4096 bytes 就下「沒有」的結論——
// 那是「找不到」與「不存在」混為一談。這裡的規則是：路徑像就直接算，
// 不像才去看內容，而看內容時看的是**整份**。

/** 路徑落在登入／人物存檔目錄。 */
export const SAVE_PATH_RE = /(^|\/)(login|users?|players?|chars?|characters?)(\/|_bak\/)/i;

/** 內容有 password 欄而且有值（ES2 的行式存檔與 JSON 式都認）。 */
export const SAVE_PWD_RE = /password"?\s*[:\s]\s*"[^"\n]{4,}"/;

/**
 * @param {string} filePath 映像內的相對路徑（不需要開頭斜線）
 * @param {Buffer|Uint8Array|string} [content] 檔案內容；沒給就只用路徑判斷
 * @returns {boolean}
 */
export function isPlayerSave(filePath, content) {
  if (!/\.o$/i.test(filePath)) return false;
  if (SAVE_PATH_RE.test('/' + filePath)) return true;
  if (content == null) return false;
  const text = typeof content === 'string'
    ? content
    : Buffer.from(content).toString('latin1');
  return text.includes('password') && SAVE_PWD_RE.test(text);
}

/** 匯入端額外要整個跳過的目錄（存檔以外的傾印／備份）。 */
export const SAVE_DIRS = ['dump', 'drop', 'suicide'];
