// 本地偏好持久化。
//
// 原客戶端把自訂按鈕存成 my_cmds_<n>a（標籤）/ my_cmds_<n>b（指令）這種扁平鍵，
// 這裡改成單一 JSON 物件，比較好演進。

// ★ 每一台 mud 各自一組儲存空間。
//
// 【WHY】站台上有上百台 mud，而它們的帳號規則、角色名、上次進度全都不同。
// 共用一組 `zjmud.prefs.v1` 會讓 A 台記住的帳號被帶進 B 台——
// B 台的 `check_legal_id` 可能根本不收那個名字（各家禁用清單不同），
// 使用者看到的是「我明明沒填過，卻說我的名字不合法」。
// 角色名同理：A 台建過「風逸」，切到 B 台時被自動帶入，
// 而 B 台的中文名長度限制是 2–4 字，直接被擋。
//
// 【判準】命名空間用 mud 的 slug（從 `?mud=` 或已載入的 mud 取得）。
// 沒有 slug 時（桌面版、橋接版直連）維持原本的全域鍵，行為不變。
const BASE_KEY = 'zjmud.prefs.v1';

/** 目前這一頁綁定的 mud slug（`?mud=xxx`）；沒有就是 null。 */
export function currentMudSlug() {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('mud') || null;
  } catch {
    return null;
  }
}

function storageKey() {
  const slug = currentMudSlug();
  return slug ? `${BASE_KEY}.${slug}` : BASE_KEY;
}

const DEFAULTS = {
  theme: 'night',      // night | day | mud
  fontScale: 1,
  descHidden: false,
  lastHost: '127.0.0.1',
  lastPort: 5001,   // LPMud-Name 的 UTF-8 埠（5003 是 GBK，連了會亂碼）
  autoConnect: true,   // 啟動時自動連上次的伺服器（MUD 客戶端的常見行為）
  // 帳號資訊。密碼以明文存放 —— 協議本身也是明文傳輸，這裡不會更不安全，
  // 但仍設成 opt-in（rememberAccount 預設 false），不主動記。
  rememberAccount: false,
  accountId: '',
  accountPw: '',
  accountEmail: '',
  quickSlots: {},      // slot → { label, cmd }
  history: [],         // 指令歷史
  historyLimit: 200,
};

let cache = null;

export function loadPrefs() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(storageKey());
    cache = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function savePrefs(partial) {
  const cur = loadPrefs();
  Object.assign(cur, partial);
  try {
    localStorage.setItem(storageKey(), JSON.stringify(cur));
  } catch (err) {
    console.warn('[prefs] 無法寫入偏好：', err);
  }
  return cur;
}

export function pushHistory(cmd) {
  const p = loadPrefs();
  if (!cmd) return p.history;
  // 與上一筆相同就不重複記錄
  if (p.history[p.history.length - 1] === cmd) return p.history;
  p.history.push(cmd);
  if (p.history.length > p.historyLimit) {
    p.history.splice(0, p.history.length - p.historyLimit);
  }
  savePrefs({ history: p.history });
  return p.history;
}
