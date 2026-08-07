// 行級 opcode 解析器。
//
// 把伺服器送來的一行文字轉成結構化事件物件。
// 對應 docs/ZJMUD_CLIENT_PROTOCOL.md §2 與 §4。
//
// 本模組是純函式：不碰 DOM、不碰 store、不送指令。
// 這是與原 Android 客戶端最大的架構差異 —— 原版的 opcode 分派器直接操作 View，
// 導致協議邏輯與 UI 無法分離、也無法測試。

import { ESC } from './ansi.js';
import { lookupExtended, KIND, detectDialect, setDialect } from './dialects.js';

/** 核心 opcode 集合。用來判斷一個碼是否「認得」，供變長 opcode 消歧義。 */
const CORE_OPCODES = new Set([
  '000','001','002','003','004','005','006','007','008','009','010','011','012',
  '013','014','015','016','017','020','021','022','023','024','045','100',
  '900','903','905','913','997','998','999',
]);

/** 這個碼是否出現在核心表或擴充方言表中。 */
function isKnownOpcode(op) {
  return CORE_OPCODES.has(op) || lookupExtended(op) != null;
}

// ── 分隔符（協議 §4.0）──────────────────────────────
export const SEP = {
  REC: '$zj#',   // 記錄
  REC2: '$z2#',  // 記錄（僅彈出選單）
  BR: '$br#',    // 換行
  DIALOG: '$dh#',// 對話框區塊
  CMDSEQ: '$sock#', // 指令序列
  FIELD: ':',
  SUB: '|',
  BAR: '║',      // U+2551
  NUM: '$N',     // 數量佔位符
  KEEP: '$txt#', // 點擊後保持面板開啟
};

/** 方向鍵 → 方向盤位置（協議 §4.1）。未列出者放「額外出口」。 */
const DIR_SLOT = {
  north: 'n', northup: 'n', northdown: 'n',
  south: 's', southup: 's', southdown: 's',
  east: 'e', eastup: 'e', eastdown: 'e',
  west: 'w', westup: 'w', westdown: 'w',
  northwest: 'nw', northeast: 'ne',
  southwest: 'sw', southeast: 'se',
};

/** 物品品階 → 語意名稱（協議 §5）。 */
const ITEM_TIER = {
  1: 'white', 2: 'green', 3: 'blue', 4: 'purple',
  5: 'gold', 6: 'red', 7: 'grey',
};

/**
 * 從一行原始文字擷取 opcode 與 payload。
 *
 * opcode = ESC + **三個英數字元**，共 4 個字元。
 * 注意不是「三個數字」—— 擴充方言存在 `10a`、`11a`、`2k1`–`2k4` 這種碼
 * （見 dialects.js）。原本寫成 /^\d{3}$/ 會把它們當成一般訊息，
 * 導致整段內容以亂碼形式印在畫面上。
 */
export function parseLine(raw) {
  if (typeof raw !== 'string') return { op: null, payload: '' };

  // 行首的完整重置前綴要先剝掉才看得到 opcode（協議 §2.1）
  let line = raw;
  let resetStyles = false;
  if (line.startsWith(ESC + '[2;37;0m')) {
    resetStyles = true;
    line = line.slice(9);
  }

  if (line.length < 4 || line[0] !== ESC) {
    return { op: null, payload: line, resetStyles };
  }

  // 先試 3 字元（絕大多數 opcode）
  const three = line.slice(1, 4);
  if (/^[0-9a-z]{3}$/i.test(three)) {
    // 少數方言有 4 字元 opcode（指游 ZYMAP = "1085"）。
    // 只有在「4 字元版本認得、3 字元版本不認得」時才採用 4 字元，
    // 這樣既能支援它，又不會把 `108` + 內容 "5..." 這種正常情況誤判。
    const four = line.slice(1, 5);
    if (/^[0-9a-z]{4}$/i.test(four) && isKnownOpcode(four) && !isKnownOpcode(three)) {
      return { op: four, payload: line.slice(5), resetStyles };
    }
    return { op: three, payload: line.slice(4), resetStyles };
  }
  return { op: null, payload: line, resetStyles };
}

/**
 * 版面前綴解析（協議 §4.0.1）：`$a,b,c,d#<內容>`
 * @returns {{ layout: number[]|null, rest: string }}
 */
export function takeLayout(payload, defaults) {
  if (typeof payload !== 'string' || payload[0] !== '$') {
    return { layout: defaults ? [...defaults] : null, rest: payload ?? '' };
  }
  const end = payload.indexOf('#');
  if (end === -1) {
    return { layout: defaults ? [...defaults] : null, rest: payload };
  }
  const nums = payload.slice(1, end).split(',').map((n) => parseInt(n, 10));
  const layout = (defaults ? [...defaults] : [0, 0, 0, 0]).map((d, i) =>
    Number.isFinite(nums[i]) ? nums[i] : d,
  );
  return { layout, rest: payload.slice(end + 1) };
}

/** 以記錄分隔符切開，並丟掉空記錄。 */
function records(payload, sep = SEP.REC) {
  if (!payload) return [];
  return payload.split(sep).filter((r) => r.length > 0);
}

// ── 各 opcode 的 payload 解析 ────────────────────────

/** ESC003 出口：`dir:label[:cmd]` × $zj# */
function parseExits(payload) {
  return records(payload).map((rec) => {
    const f = rec.split(SEP.FIELD);
    const dir = f[0] ?? '';
    return {
      dir,
      slot: DIR_SLOT[dir] ?? null, // null = 額外出口
      label: f[1] ?? dir,
      cmd: f.length > 2 ? f[2] : dir, // 第 3 欄省略時，指令 = 方向鍵本身
    };
  });
}

/** ESC005 物件：`label:cmd` × $zj# */
function parseObjects(payload) {
  if (!payload || payload.length <= 4) return [];
  return records(payload).map((rec) => {
    const i = rec.indexOf(SEP.FIELD);
    return i === -1
      ? { label: rec, cmd: rec }
      : { label: rec.slice(0, i), cmd: rec.slice(i + 1) };
  });
}

/** ESC006 自訂按鈕：`slot:label:cmd` × $zj# */
function parseButtons(payload) {
  const body = (payload ?? '').split(SEP.BR).join('\n');
  return records(body).map((rec) => {
    const f = rec.split(SEP.FIELD);
    return { slot: f[0] ?? '', label: f[1] ?? '', cmd: f[2] ?? '' };
  });
}

/** ESC021 標題列按鈕：`label:cmd` × $zj# */
function parseTitleButtons(payload) {
  if (!payload || payload.length <= 2) return [];
  return records(payload).map((rec) => {
    const i = rec.indexOf(SEP.FIELD);
    return i === -1
      ? { label: rec, cmd: rec }
      : { label: rec.slice(0, i), cmd: rec.slice(i + 1) };
  });
}

/** ESC008/009 動作列（協議 §4.4） */
function parseActions(payload) {
  const { layout, rest } = takeLayout(payload, [1, 3, 9, 30]);
  const items = records(rest).map((rec) => {
    const i = rec.indexOf(SEP.FIELD);
    const head = i === -1 ? rec : rec.slice(0, i);
    const cmd = i === -1 ? '' : rec.slice(i + 1);
    const [title, sub] = head.split(SEP.BR).join('\n').split(SEP.SUB);
    return {
      title: title ?? '',
      sub: sub ?? null,
      cmd,
      // 指令欄內含 ESC020 → 點擊時開彈出選單而非送指令
      popup: cmd.includes(ESC + '020') ? cmd.slice(cmd.indexOf(ESC + '020') + 4) : null,
      // 含 $txt# → 點擊後保持面板開啟（供連續操作）
      keepOpen: cmd.includes(SEP.KEEP),
    };
  });
  return { layout: { cols: layout[0], widthDiv: layout[1], heightDiv: layout[2], fontDiv: layout[3] }, items };
}

/** ESC012 屬性條（協議 §4.5） */
function parseStatBars(payload) {
  const { layout, rest } = takeLayout(payload, [0, 0, 22, 35]);
  const raw = (rest ?? '').split(SEP.BAR).filter((r) => r.length > 0);

  const bars = raw.map((rec) => {
    const f = rec.split(SEP.FIELD);
    const label = f[0] ?? '';
    const nums = (f[1] ?? '').split('/').map((n) => parseInt(n, 10));
    const color = f[2] ?? null;
    const cmd = f.length > 3 ? f[3] : null;

    // 三種寫法：a/b/max（雙層）、a/max（單層）、a（不畫條）
    if (nums.length === 3 && nums[2] > 0) {
      return { label, a: nums[0], b: nums[1], max: nums[2], color, cmd, mode: 'dual' };
    }
    if (nums.length === 2 && nums[1] > 0) {
      return { label, a: nums[0], b: nums[1], max: nums[1], color, cmd, mode: 'single' };
    }
    return { label, a: null, b: null, max: null, color, cmd, mode: 'text', text: f[1] ?? '' };
  });

  // 未指定欄數時，預設兩列（協議 §4.5）
  const cols = layout[0] > 0 ? layout[0] : Math.max(1, Math.ceil(bars.length / 2));
  return { layout: { cols, heightDiv: layout[2], fontDiv: layout[3] }, bars };
}

/** ESC020 彈出選單（協議 §4.6）。注意分隔符是 $z2# 不是 $zj# */
function parsePopMenu(payload) {
  const { layout, rest } = takeLayout(payload, [1, 2, 8, 25]);
  const items = records(rest, SEP.REC2).map((rec) => {
    const i = rec.indexOf(SEP.SUB);
    return i === -1
      ? { label: rec, cmd: rec }
      : { label: rec.slice(0, i), cmd: rec.slice(i + 1) };
  });
  return { layout: { cols: layout[0], widthDiv: layout[1], heightDiv: layout[2], fontDiv: layout[3] }, items };
}

/** ESC022 血條更新：`tag$zj#a:b:max` */
function parseBarUpdate(payload) {
  const parts = (payload ?? '').split(SEP.REC);
  const nums = (parts[1] ?? '').split(SEP.FIELD).map((n) => parseInt(n, 10));
  return {
    tag: parts[0] ?? '',
    a: nums[0] ?? 0,
    b: nums[1] ?? 0,
    max: nums[2] ?? 0,
  };
}

/** ESC001 互動面板＋數量輸入：`說明$zj#指令樣板` */
function parsePrompt(payload) {
  const parts = (payload ?? '').split(SEP.REC);
  return { text: parts[0] ?? '', template: parts[1] ?? '' };
}

/** ESC900 換伺服器：`ip:port` */
function parseRelocate(payload) {
  const i = (payload ?? '').lastIndexOf(':');
  if (i === -1) return { host: payload ?? '', port: null };
  return { host: payload.slice(0, i), port: parseInt(payload.slice(i + 1), 10) || null };
}

/**
 * ESC010 NPC 對話框（協議 §5）。
 * payload 先以 $dh# 切塊，逐塊依前 5 字元判斷用途。
 */
export function parseDialog(payload) {
  const result = { blocks: [], okCmds: [], cancelCmd: null, needNumber: false };
  const chunks = (payload ?? '').split(SEP.DIALOG);

  for (const chunk of chunks) {
    const head = chunk.slice(0, 5);

    if (chunk.length > 5 && head === 'ok11.') {
      result.okCmds.push(chunk.slice(5));
      continue;
    }
    if (chunk.length > 5 && head === 'no11.') {
      result.cancelCmd = chunk.slice(5);
      continue;
    }
    if (chunk.length > 5 && head === 'numb.') {
      result.needNumber = true;
      continue;
    }
    // 原版對 `numb.` 的判斷是「長度 > 5 才算」，但實務上它常單獨出現。
    // 這裡放寬成完全相等也接受，否則 `numb.` 這個 chunk 會被當成內容文字印出來。
    if (chunk === 'numb.') {
      result.needNumber = true;
      continue;
    }

    // 內容區塊：以 $br# 切行
    for (const line of chunk.split(SEP.BR)) {
      if (line.length > 5 && line.startsWith('$exp#')) {
        result.blocks.push({ kind: 'exp', text: line.slice(5) });
      } else if (line.length > 5 && line.startsWith('$god#')) {
        result.blocks.push({ kind: 'money', text: line.slice(5) });
      } else if (line.length > 5 && line.startsWith('$obj#')) {
        const f = line.slice(5).split(',');
        result.blocks.push({
          kind: 'item',
          tag: f[0] ?? '',
          image: f[1] ?? '',
          tier: ITEM_TIER[parseInt(f[2], 10)] ?? 'default',
        });
      } else if (line.length > 7 && /^#[0-9a-fA-F]{6}/.test(line)) {
        result.blocks.push({ kind: 'text', color: line.slice(0, 7), text: line.slice(7) });
      } else {
        result.blocks.push({ kind: 'text', color: null, text: line });
      }
    }
  }
  return result;
}

/**
 * ESC001 輸入面板的送出規則（協議 §4.9）。
 *
 * 伺服器端巨集是 `INPUTTXT(question, template)`，template 幾乎一律長成
 * `"某指令 $txt#"`（見 world/adm/npc/ganjiang.c、cmds/usr/edroom.c 等數十處）。
 *
 *   * template 內含 `$txt#` → 就地替換成使用者輸入
 *   * 否則                 → template + 空格 + 使用者輸入
 *
 * 注意這裡用的是 `$txt#` 而不是對話框（ESC010）的 `$N`，兩者不可混用。
 * 輸入內容是**自由文字**（伺服器拿它接名字、四項屬性數列、聊天內容），不是純數字。
 */
export function expandInputTemplate(template, value) {
  const tpl = template ?? '';
  const v = value ?? '';
  if (tpl.includes(SEP.KEEP)) return tpl.split(SEP.KEEP).join(v);
  return tpl === '' ? v : `${tpl} ${v}`;
}

/**
 * 把「確定」鈕的指令序列展開成實際要送出的多條指令。
 * `$N` 替換成數量，再以 `$sock#` 拆開（協議 §5）。
 */
export function expandDialogCommands(okCmds, number) {
  const joined = okCmds.join(SEP.CMDSEQ);
  const replaced = number == null ? joined : joined.split(SEP.NUM).join(String(number));
  return replaced.split(SEP.CMDSEQ).filter((c) => c.length > 0);
}

/** 伺服器登入握手的固定字串（出處 world/adm/daemons/logind.c）。 */
export const LOGIN = {
  /**
   * 版本挑戰的三種已知寫法。收藏中三個來源各不相同：
   *   `ver1.0:<crypt>`            LPMud-Name（logind.c）
   *   `ver1.0,<crypt>`            官方協議文件
   *   `version 1.0 key::<crypt>`  指游 MUD（轉換教程）
   * 只認其中一種會讓另外兩種伺服器完全連不上。
   */
  CHALLENGES: ['ver1.0:', 'ver1.0,', 'version 1.0'],
  /** @deprecated 保留舊名，改用 CHALLENGES */
  CHALLENGE: 'ver1.0:',
  /** 版本回覆被接受 */
  VERIFIED: '版本验证成功',
  /** ESC000 狀態碼 */
  OK: '0007',        // 登入成功
  NEED_CHAR: '0008', // 帳號無角色，需建立
  BAD_ID: '0001',    // 帳號不合法（各家的規則不同：長度、字集、禁用字、重複字元…）
  BAD_NAME: '0009',  // 暱稱不符合要求
  /** 欄位分隔符 U+2551 */
  SEP: '║',
  /**
   * 版本挑戰的回覆。
   *
   * 【WHY】原本送 `'x'`——因為 LPMud-Name 的 `logind::jiance()` 只擋 `"//"`，
   * 任何其他字串都算通過。但收藏裡的其他 mudlib 不是這樣：`谁与争锋` 會驗
   * `arg != crypt(ZJKEY, str[2..3])`，送 `'x'` 直接回「客户端非法」並斷線。
   *
   * 【推理】正規的回覆要算 `crypt(ZJKEY, salt)`，而 ZJKEY 是各 mudlib
   * `include/zjmud.h` 裡的常數（LPMud-Name 是 `"123456789abcd"`）——
   * 客戶端不可能事先知道每一台的值，所以那條路不可行。
   * 但同一段條件式的第二個分支寫著 `|| arg == "zjmDMaIpOvxdb"`，
   * 而且命中時會 `set_temp("web_log", 1)`——**這是 mudlib 自己為網頁客戶端
   * 保留的通行字串**，不是繞過驗證。它同時滿足 LPMud-Name 的「非 //」條件，
   * 所以一個值就涵蓋兩種寫法。
   *
   * 【證據】谁与争锋 `adm/daemons/logind.c`：
   *   `else if (arg != crypt(ZJKEY, str[2..3]) && arg != "zjmDMaIpOvxdb")`
   *   `if (arg == "zjmDMaIpOvxdb") ob->set_temp("web_log", 1);`
   *   LPMud-Name 同檔：`ob->set_temp("web_log",1); if (arg != "//") ...`
   */
  ANY: 'zjmDMaIpOvxdb',
};

/**
 * 是否為版本挑戰行。
 */
export function isChallenge(line) {
  const s = String(line ?? '');
  return LOGIN.CHALLENGES.some((c) => s.startsWith(c));
}

/**
 * 組出登入握手要送的那一行。
 *
 * 欄位數依伺服器而異：
 *   4 欄 `帳號║密碼║密文║email`  LPMud-Name
 *   3 欄 `帳號║密碼║密文`        官方協議文件
 * 多送一欄時 LPMud-Name 會用到，少一欄的伺服器則忽略；
 * 但 `sizeof(myinfo)!=3` 這種嚴格檢查會擋下來，所以要能選。
 *
 * 密文欄位：官方定義是 `crypt(ZJKEY,帳號)+crypt(ZJKEY,密碼)`，
 * 但那需要伺服器端的 ZJKEY，客戶端拿不到（官方作法是走網關產生）。
 * 實務上多數自架伺服器把該檢查註解掉了，因此沿用固定值。
 */
export function buildLoginLine({ id, password, email = '', secret = 'byname666', fields = 4 }) {
  if (fields === 3) return [id, password, secret].join(LOGIN.SEP);
  // 【WHY 空 email 要補一個佔位字元】
  // 伺服器端是 `explode(arg, "║")` 後檢查 `sizeof(myinfo) != 4`，而 LPC 的
  // explode **會把結尾的空欄丟掉**：`a║b║c║` 只會得到 3 個元素，於是登入被判
  // 「未知错误，请重试s」並回到輸入狀態——畫面上看起來像帳號密碼錯了。
  // 【推理】不能改成少送一欄（那是 3 欄方言，另一批伺服器才用）；也不能送空白，
  // 空白同樣會被 explode 保留但某些 mudlib 會拿它當 email 存起來。送一個
  // 明確的佔位符最不會誤導：它會被存成 email，而使用者本來就沒填。
  // 【證據】谁与争锋 `adm/daemons/logind.c` get_user()：
  //   `myinfo = explode(arg,"║"); if (sizeof(myinfo)!=4) { write("未知错误，请重试s"); }`
  //   實測送 `id║pw║byname666║`（空 email）→ ESC015 未知错误；補上佔位符後通過。
  return [id, password, secret, email || '-'].join(LOGIN.SEP);
}

/**
 * 組出建立角色要送的那一行。
 *   3 欄 `性別║頭像║暱稱`  經典／大梦江湖（頭像留空）
 *   2 欄 `性別║暱稱`      指游 MUD（轉換教程明載「目前只发送2段(原来3段)」）
 */
export function buildCharLine({ sex = '男', avatar = '', name, fields = 3 }) {
  return fields === 2
    ? [sex, name].join(LOGIN.SEP)
    : [sex, avatar, name].join(LOGIN.SEP);
}

/** 依版本挑戰字串切換方言，回傳選中的 profile 名稱。 */
export function applyDialectFromChallenge(line) {
  return setDialect(detectDialect(line));
}

/**
 * 主入口：一行原始文字 → 事件物件。
 *
 * 未知 opcode 一律降級成 `msg.main`（不丟棄），
 * 解析拋錯由呼叫端捕捉後同樣降級。
 */
export function decodeLine(raw) {
  const { op, payload, resetStyles } = parseLine(raw);

  switch (op) {
    // ── 連線／控制 ──
    case '000':
      // payload 為「重连完毕」時，客戶端需自動回送 `l`（協議 §2.3）
      return { type: 'conn.notice', text: payload, reloginLook: payload === '重连完毕' };
    case '900': return { type: 'conn.relocate', ...parseRelocate(payload) };
    case '997': return { type: 'conn.multiline', value: false };
    case '998': return { type: 'conn.multiline', value: true };
    case '999': return { type: 'conn.quit' };
    case '014': return { type: 'conn.echo', cmd: payload };

    // ── 房間 ──
    case '002': return { type: 'room.title', text: payload, resetStyles };
    case '004': return { type: 'room.desc', text: payload };
    case '023': return { type: 'room.descToggle', hidden: payload === '屏蔽描述' };
    case '003': return { type: 'room.exits', exits: parseExits(payload) };
    case '903': return { type: 'room.exitRemove', dir: payload, slot: DIR_SLOT[payload] ?? null };
    case '913': return { type: 'room.exitClear' };
    case '005': return { type: 'room.objects', objects: parseObjects(payload) };
    case '905': return { type: 'room.objectRemove', tag: payload };
    case '022': return { type: 'room.objectBar', ...parseBarUpdate(payload) };
    case '021': return { type: 'ui.titleButtons', buttons: parseTitleButtons(payload) };

    // ── 狀態列與快捷鈕 ──
    case '012': return { type: 'stat.bars', ...parseStatBars(payload) };
    // 注意：原版的分派鏈中 006 出現兩次，第二個分支永遠不可達（協議 §2.3.1）。
    // 這裡只實作有效語意 —— 自訂按鈕。
    case '006': return { type: 'ui.quickButtons', buttons: parseButtons(payload) };

    // ── 訊息 ──
    case '015': return { type: 'msg.toast', text: payload };
    case '016': return { type: 'msg.combat', text: payload };
    case '017': return { type: 'msg.combatClose' };
    case '100': return { type: 'msg.chat', text: payload };
    case '024': return { type: 'msg.float', text: payload };

    // ── 疊層 ──
    case '001': return { type: 'overlay.prompt', ...parsePrompt(payload) };
    case '007': return { type: 'overlay.detail', text: payload };
    case '008': return { type: 'overlay.actions', column: 1, ...parseActions(payload) };
    case '009': return { type: 'overlay.actions', column: 2, ...parseActions(payload) };
    case '010': return { type: 'overlay.dialog', dialog: parseDialog(payload) };
    case '011': return { type: 'overlay.map', text: payload };
    case '013': return { type: 'overlay.pagedText', text: payload };
    case '020': return { type: 'overlay.popMenu', ...parsePopMenu(payload) };
    case '045': return { type: 'overlay.web', url: payload };

    default: {
      if (op == null) return { type: 'msg.main', text: payload };

      // 核心表沒有 → 查擴充方言（大梦江湖等新協議 mudlib）
      const ext = lookupExtended(op);
      if (ext) return decodeExtended(op, payload, ext);

      // 真的不認識 → 降級成一般訊息，內容完整保留
      return { type: 'msg.main', text: ESC + op + payload, unknownOpcode: op };
    }
  }
}

/**
 * 擴充方言的 payload 解析。
 *
 * 這些 opcode 的 payload 結構與核心 opcode 同構，所以直接複用既有的解析器；
 * 差別只在「這份內容要放到哪個面板的哪個欄位」，由 dialects.js 的表決定。
 */
function decodeExtended(op, payload, ext) {
  const base = { opcode: op, macro: ext.name, panel: ext.panel, slot: ext.slot ?? null };

  switch (ext.kind) {
    case KIND.TITLE:
      return { type: 'panel.title', ...base, text: payload };

    case KIND.TEXT:
      return { type: 'panel.text', ...base, text: payload };

    case KIND.LIST:
      return { type: 'panel.list', ...base, items: parseTitleButtons(payload) };

    case KIND.ACTIONS: {
      const a = parseActions(payload);
      return { type: 'panel.actions', ...base, layout: a.layout, items: a.items };
    }

    case KIND.BARS: {
      const b = parseStatBars(payload);
      return { type: 'panel.bars', ...base, layout: b.layout, bars: b.bars };
    }

    case KIND.ENTITY_ADD: {
      // 實測形狀：`檔名$zj#名字$zj#a:b:max`（大梦江湖 XYKILL）
      const f = (payload ?? '').split(SEP.REC);
      const nums = (f[2] ?? '').split(SEP.FIELD).map((n) => parseInt(n, 10));
      return {
        type: 'panel.entityAdd', ...base, side: ext.side ?? 'enemy',
        id: f[0] ?? '', label: f[1] ?? f[0] ?? '',
        bar: nums.length >= 2 && nums[nums.length - 1] > 0
          ? { a: nums[0] ?? 0, b: nums[1] ?? nums[0] ?? 0, max: nums[nums.length - 1] }
          : null,
      };
    }

    case KIND.ENTITY_DEL:
      return { type: 'panel.entityDel', ...base, side: ext.side ?? 'enemy', id: payload };

    case KIND.CLOSE:
      return { type: 'panel.close', ...base };

    case KIND.MESSAGE:
      return { type: 'msg.' + (ext.channel === 'chat' ? 'chat'
              : ext.channel === 'combat' ? 'combat' : 'toast'), text: payload };

    // ── 指游 ZY 方言的「客戶端能力」類 ──
    case KIND.CLEAR_MAIN:
      return { type: 'ui.clearMain', ...base };

    case KIND.RELOGIN:
      return { type: 'conn.relogin', ...base, delayMs: parseInt(payload, 10) || 0 };

    case KIND.NETSTAT:
      return { type: 'ui.netStat', ...base, enabled: !/關閉|关闭|off/i.test(payload) };

    case KIND.HINT: {
      // `.選擇器|說明文字`（可用 $zj# 串多筆）
      const items = (payload ?? '').split(SEP.REC).filter(Boolean).map((r) => {
        const i = r.indexOf(SEP.SUB);
        return i === -1 ? { selector: r, text: '' }
                        : { selector: r.slice(0, i), text: r.slice(i + 1) };
      });
      return { type: 'ui.hint', ...base, items };
    }

    case KIND.DAMAGE: {
      // `目標$zj#訊息$zj#顏色$zj#持續ms`
      const f = (payload ?? '').split(SEP.REC);
      return {
        type: 'msg.float', ...base,
        target: f[0] ?? '', text: f[1] ?? '',
        color: f[2] || null, durationMs: parseInt(f[3], 10) || 1900,
      };
    }

    case KIND.STORY: {
      // `文本$zj#速度ms$zj#背景色`；單獨 `close` 表示關閉
      if ((payload ?? '').trim() === 'close') {
        return { type: 'overlay.storyClose', ...base };
      }
      const f = (payload ?? '').split(SEP.REC);
      return {
        type: 'overlay.story', ...base,
        text: f[0] ?? '', speedMs: parseInt(f[1], 10) || 80, background: f[2] || null,
      };
    }

    case KIND.VIBRATE:
      return { type: 'ui.vibrate', ...base, durationMs: parseInt(payload, 10) || 200 };

    case KIND.IGNORE:
      return { type: 'ui.ignored', ...base };

    default:
      return { type: 'msg.main', text: payload };
  }
}

export const __test__ = { parseExits, parseObjects, parseStatBars, parsePopMenu, DIR_SLOT, ITEM_TIER };
