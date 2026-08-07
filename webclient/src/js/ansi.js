// 行內樣式方言解析器。
//
// ZJMUD 用的不是標準 ANSI，而是一套擴充方言（見 docs/ZJMUD_CLIENT_PROTOCOL.md §3）：
//   * 標準 SGR 色碼，但用自訂調色盤
//   * [f#RRGGBB m / [b#RRGGBB m  自訂前景/背景色
//   * [s<n>]                     字級（以 ] 收尾，不是 m）
//   * [u<url>]                   超連結（以 ] 收尾，不是 m）
//   * [9m                        全形模式
//   * [2J                        清空主訊息區
//
// 本模組是純函式，不碰 DOM，可獨立單元測試。
// 樣式是「跨段有狀態」的：設定後持續生效直到 [0m 或 *;0m 重置。

/** U+001B。刻意用逸出寫法，避免原始控制字元在編輯器/版控中被吃掉。 */
export const ESC = '\u001b';

/** 前景色（一般）30–37 */
const FG = ['#000000', '#aa3300', '#00bb00', '#eeee00', '#0000aa', '#aa00aa', '#00bbbb', '#aaaaaa'];
/** 前景色（高亮）1;30–1;37 */
const FG_HI = ['#000000', '#ff3300', '#88ff00', '#ffff00', '#0000ff', '#ff00ff', '#88ffff', '#ffffff'];
/** 背景色（一般）40–47 */
const BG = ['#222222', '#aa0000', '#00aa00', '#aaaa00', '#0000ff', '#aa00aa', '#00aaaa', '#aaaaaa'];
/** 背景色（高亮）40;1–47;1 */
const BG_HI = ['#000000', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff'];

/**
 * 白天模式的色彩改寫：淺底上綠/黃/青/白讀不出來，一律改藍。
 * 對應協議 §3.2.1。
 */
const DAY_REMAP = new Set([2, 3, 6, 7]); // 索引 = 色碼 - 30

function newStyle() {
  return { fg: null, bg: null, bold: false, size: null, link: null, fullwidth: false };
}

/** `[u:` / `[s:` 的參數前綴冒號。伺服器巨集會帶，舊文件寫法不帶，兩者都接受。 */
function stripLeadingColon(s) {
  return s.startsWith(':') ? s.slice(1) : s;
}

/**
 * 把 ASCII 可見字元轉全形（[9m 模式）。
 * U+0021–U+007E → U+FF01–U+FF5E，空白 → U+3000。
 */
function toFullWidth(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0x20) out += '　';
    else if (c >= 0x21 && c <= 0x7e) out += String.fromCodePoint(c + 0xfee0);
    else out += ch;
  }
  return out;
}

/**
 * 色碼正規化。
 * 協議允許帶 alpha 前綴形成 ARGB（例：#99aa3300），CSS 需要的是 RGBA，
 * 所以 9 字元的情況要把 alpha 從頭搬到尾。見協議 §9 第 5 點。
 */
function normalizeColor(hex) {
  if (typeof hex !== 'string') return null;
  const h = hex.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(h)) return h;
  if (/^#[0-9a-fA-F]{8}$/.test(h)) return '#' + h.slice(3) + h.slice(1, 3); // ARGB → RGBA
  if (/^#[0-9a-fA-F]{3}$/.test(h)) return h;
  return null;
}

/**
 * 解析一個樣式段的開頭指令，就地更新 style，回傳剩餘文字。
 *
 * @param {string} seg   以 ESC 切開後的一段（不含 ESC 本身）
 * @param {object} style 目前樣式狀態（會被就地修改）
 * @param {object} opts  { dayMode }
 * @returns {{ text: string, clearScreen: boolean }}
 */
function applySegment(seg, style, opts) {
  let clearScreen = false;

  // ── 先處理以 ] 收尾的擴充指令，它們不能用「找第一個 m」的規則 ──
  //
  // 伺服器端巨集是 ZJURL(w) = ESC + "[u:" + w + "]"、ZJSIZE(n) = ESC + "[s:" + n + "]"，
  // 也就是參數前面**有一個冒號**（見 world/include/zjmud.h）。
  // 這裡容忍有無冒號兩種寫法，避免任何一種伺服器版本解錯。
  if (seg.startsWith('[u')) {
    const end = seg.indexOf(']');
    if (end !== -1) {
      style.link = stripLeadingColon(seg.slice(2, end));
      return { text: seg.slice(end + 1), clearScreen };
    }
  }
  if (seg.startsWith('[s')) {
    const end = seg.indexOf(']');
    if (end !== -1) {
      const n = parseInt(stripLeadingColon(seg.slice(2, end)), 10);
      // 原版是「畫面寬 ÷ n」。Web 版改成相對倍率，避免綁死畫面寬度。
      style.size = Number.isFinite(n) && n > 0 ? +(30 / n).toFixed(3) : null;
      return { text: seg.slice(end + 1), clearScreen };
    }
  }

  // ── 螢幕控制 ──
  if (seg.startsWith('[2J')) {
    clearScreen = true;
    return { text: seg.slice(3), clearScreen };
  }
  if (seg.startsWith('[H')) {
    return { text: seg.slice(2), clearScreen };
  }

  // ── 游標控制／清除類 CSI：吃掉，不顯示 ──
  //
  // 【WHY】使用者截圖裡訊息區出現 `[256D[K` 這種字面亂碼。真因是這裡只認得
  // 「以 m 收尾的 SGR」與 [2J/[H，其餘 CSI 落到下面「不是樣式指令 → 整段都是
  // 文字」那條，於是 ESC 被 split 吃掉、剩下的 `[256D` 原樣印出來。
  // 【推理】伺服器送這些是為了在**終端機**上抹掉剛回顯的輸入
  // （ESC[256D = 游標左移 256 欄、ESC[K = 清到行尾，配成一組就是「洗掉這一行」）。
  // 網頁不是終端機、沒有游標可移，正確處理就是**消化掉它**——
  // 顯示出來反而是雜訊。更糟的是下面那條 `seg.indexOf('m')`：後文只要出現任何
  // 一個英文 m，`[256D...m` 會被誤當成 SGR，把中間的正文一起吞掉。
  // 【證據】play.html?mud=yanhuangwuhun 登入後的訊息區（使用者 2026-08-01 截圖）；
  // ECMA-48 CSI 的終止位元組落在 @-~，其中 A-D 是游標移動、J/K 是清除。
  // 【WHY 這個字元類】只收**大寫**終止碼且參數限定 [0-9;]，才不會誤傷自訂碼
  // `[f#RRGGBBm` / `[b#RRGGBBm`（小寫 f/b 起頭）與 `[u:…]` / `[s:…]`，
  // 也不會誤吃小寫 m 的 SGR——那條由下面的既有邏輯負責。
  // 【WHY 還要一條小寫 f/H】`ESC[7;0f`（HVP，游標定位到列;欄）是地圖類指令
  // 用來畫格的——實測 sj 的 `dazuo` 回應裡整串 `[s[7;0f[1;0f[2;0f…` 原樣漏出來。
  // 第一條規則只收大寫終止碼，是為了不誤傷自訂色 `[f#RRGGBBm`（小寫 f 起頭）。
  // 兩者可以分開：HVP 的參數**一定是數字與分號**且非空，
  // 而自訂色的下一個字元是 `#`。用「至少一個參數字元」就能分辨。
  const csi = /^\[[0-9;]*[A-DEFGJKLMPSTX]/.exec(seg) || /^\[[0-9;]+[fH]/.exec(seg)
    // `ESC[s` / `ESC[u`（存／復原游標位置）：`[s:` 與 `[u:` 是我們的自訂碼，
    // 已在上面處理掉；走到這裡而後面不是冒號的，就是真的游標控制。
    || /^\[[su](?![:#])/.exec(seg);
  if (csi) {
    return { text: seg.slice(csi[0].length), clearScreen };
  }

  // ── 其餘一律是以 m 收尾的 SGR ──
  const mIdx = seg.indexOf('m');
  if (!seg.startsWith('[') || mIdx === -1) {
    // 不是樣式指令，整段都是文字（沿用目前樣式）
    return { text: seg, clearScreen };
  }

  const code = seg.slice(0, mIdx + 1); // 含 '[' 與 'm'
  const rest = seg.slice(mIdx + 1);

  // 重置：[0m 或任何以 ;0m 結尾者
  if (code === '[0m' || code.endsWith(';0m')) {
    Object.assign(style, newStyle());
    return { text: rest, clearScreen };
  }
  if (code === '[1m') {
    style.bold = true;
    return { text: rest, clearScreen };
  }
  if (code === '[9m') {
    style.fullwidth = true;
    return { text: rest, clearScreen };
  }
  // 自訂色：[f#RRGGBBm / [b#RRGGBBm
  if (code.startsWith('[f#')) {
    style.fg = normalizeColor(code.slice(2, -1)) ?? style.fg;
    return { text: rest, clearScreen };
  }
  if (code.startsWith('[b#')) {
    style.bg = normalizeColor(code.slice(2, -1)) ?? style.bg;
    return { text: rest, clearScreen };
  }

  // 標準色碼
  const m = /^\[(1;)?(\d{2})(;1)?m$/.exec(code);
  if (m) {
    const bright = Boolean(m[1] || m[3]);
    let n = parseInt(m[2], 10);

    if (n >= 30 && n <= 37) {
      let idx = n - 30;
      if (opts.dayMode && DAY_REMAP.has(idx)) idx = 4; // → 藍
      style.fg = bright ? FG_HI[idx] : FG[idx];
      return { text: rest, clearScreen };
    }
    if (n >= 40 && n <= 47) {
      const idx = n - 40;
      style.bg = bright ? BG_HI[idx] : BG[idx];
      return { text: rest, clearScreen };
    }
  }

  // 無法辨識的樣式指令：忽略指令、保留文字（降級而非丟棄）
  return { text: rest, clearScreen };
}

/**
 * 把一段含 ESC 的文字解析成有樣式的片段陣列。
 *
 * @param {string} raw
 * @param {object} [options]
 * @param {object} [options.state]   跨呼叫延續的樣式狀態；不給則每次從乾淨狀態開始
 * @param {boolean} [options.dayMode] 白天模式色彩改寫
 * @returns {{ spans: Array<{text:string, style:object}>, clearScreen: boolean }}
 */
export function parseStyled(raw, options = {}) {
  const style = options.state ?? newStyle();
  const dayMode = Boolean(options.dayMode);
  const spans = [];
  let clearScreen = false;

  if (typeof raw !== 'string' || raw === '') {
    return { spans, clearScreen };
  }

  // 行首的完整重置前綴（協議 §2.1）
  let text = raw;
  if (text.startsWith(ESC + '[2;37;0m')) {
    Object.assign(style, newStyle());
    text = text.slice(9);
  }

  const segments = text.split(ESC);

  segments.forEach((seg, i) => {
    let out;
    if (i === 0) {
      // 第一段在任何 ESC 之前，是純文字
      out = { text: seg, clearScreen: false };
    } else {
      out = applySegment(seg, style, { dayMode });
    }
    if (out.clearScreen) clearScreen = true;
    if (out.text) {
      const t = style.fullwidth ? toFullWidth(out.text) : out.text;
      spans.push({ text: t, style: { ...style } });
    }
  });

  return { spans, clearScreen };
}

/**
 * 只取純文字（去掉所有樣式碼）。用於比對、搜尋、複製。
 */
export function stripStyles(raw) {
  return parseStyled(raw).spans.map((s) => s.text).join('');
}

/**
 * 連結 scheme 判定（協議 §3.3）。
 * @returns {{kind:'cmd'|'pop'|'voice'|'external', value:string}}
 */
export function classifyLink(url) {
  if (typeof url !== 'string') return { kind: 'external', value: '' };
  if (url.startsWith('cmds:')) return { kind: 'cmd', value: url.slice(5) };
  if (url.startsWith('pops:')) return { kind: 'pop', value: url.slice(5) };
  if (url.startsWith('voice:')) return { kind: 'voice', value: url.slice(6) };
  return { kind: 'external', value: url };
}

export const __test__ = { toFullWidth, normalizeColor, newStyle };
