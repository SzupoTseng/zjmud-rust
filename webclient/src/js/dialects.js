// 協議方言註冊表 —— 支援不同 mudlib 的 opcode 擴充。
//
// 【為什麼需要】
// zjmud 協議有兩個世代：
//   * 經典版：27 個 opcode。收藏中 14 個 mudlib 都用這套，本客戶端原本只支援這個。
//   * 擴充版：再加約 60 個。`大梦江湖(新协议版)` 實際使用 81 個；
//             `nt7` 雖然定義了 102 個，但 .c 裡一個都沒用（複製過去的 header）。
//
// 【為什麼是表格而不是 61 個處理器】
// 把這 61 個的實際 payload 攤開來看，它們只是同樣幾種結構換個標題：
//   樣式文字 / `label:cmd` 清單 / 帶版面前綴的動作列 / ║ 分隔的數值條 /
//   實體增刪 / 一般訊息。
// 這些解析器核心 opcode 已經有了，所以擴充只需要一張「opcode → 結構 + 去處」的表。
//
// 證據：zjmud-collection-master 內 16 份 include/zjmud.h 交叉比對，
// 並以各 mudlib 的 .c 實際使用情形過濾掉未使用的定義。

/** 泛型結構種類。每一種都對應一個既有的 payload 解析器。 */
export const KIND = {
  TEXT: 'text',        // 樣式文字（可含 $br#）
  LIST: 'list',        // `label:cmd` × $zj#
  ACTIONS: 'actions',  // 帶版面前綴的按鈕網格
  BARS: 'bars',        // ║ 分隔的數值條
  ENTITY_ADD: 'entity.add', // id $zj# 名字 $zj# a:b:max
  ENTITY_DEL: 'entity.del', // id
  MESSAGE: 'message',  // 進訊息區
  TITLE: 'title',      // 面板標題
  CLOSE: 'close',      // 關閉某面板
  // ── 指游 ZY 方言新增的「客戶端能力」類 ──
  CLEAR_MAIN: 'clearMain', // 清空主訊息區
  RELOGIN: 'relogin',      // N 毫秒後回登入畫面
  NETSTAT: 'netstat',      // 顯示/隱藏網路狀態
  HINT: 'hint',            // 元件提示
  DAMAGE: 'damage',        // 傷害飄字（帶目標與顏色）
  STORY: 'story',          // 逐字劇情
  VIBRATE: 'vibrate',      // 震動
  IGNORE: 'ignore',        // 明確忽略（官方標為未實現或平台不適用）
};

/**
 * 擴充方言表。
 *
 * `panel` 是這筆內容要送去的邏輯面板名稱；同一個面板的 title/list/text
 * 會被組裝成一個可開關的資訊視窗，不需要為每個功能各寫一套 UI。
 */
const DMJH = {
  // ── 戰鬥（大梦江湖 511–521）──
  // XYKILL 的 payload 實測是 `檔名$zj#名字$zj#氣:最大氣:…`，
  // 與核心的 ESC005 + ESC022 同構，所以直接複用實體增刪那條路。
  '511': { name: 'XYKILL',      kind: KIND.ENTITY_ADD, panel: 'combat', side: 'enemy' },
  '512': { name: 'XYKILLD',     kind: KIND.ENTITY_DEL, panel: 'combat', side: 'enemy' },
  '513': { name: 'XYKILLDY',    kind: KIND.ENTITY_ADD, panel: 'combat', side: 'ally' },
  '514': { name: 'XYKILLDT',    kind: KIND.ENTITY_DEL, panel: 'combat', side: 'ally' },
  '515': { name: 'XYKILLMIAO',  kind: KIND.MESSAGE,    channel: 'combat' },
  '516': { name: 'KILLEND',     kind: KIND.CLOSE,      panel: 'combat' },
  '517': { name: 'KILLJN',      kind: KIND.ACTIONS,    panel: 'combat' },
  '518': { name: 'KILLKS',      kind: KIND.MESSAGE,    channel: 'combat' },
  '519': { name: 'KILLQL',      kind: KIND.CLOSE,      panel: 'combat' },
  '521': { name: 'XJTILI',      kind: KIND.BARS,       panel: 'combat' },

  // ── 商城／背包（343–350）──
  '343': { name: 'XYSHOPJZ',    kind: KIND.TEXT,    panel: 'shop', slot: 'currency' },
  '344': { name: 'XYSHOPLX',    kind: KIND.LIST,    panel: 'shop', slot: 'category' },
  '345': { name: 'XYSHOP',      kind: KIND.ACTIONS, panel: 'shop', slot: 'items' },
  '346': { name: 'XYBBTEXT',    kind: KIND.TEXT,    panel: 'bag',  slot: 'detail' },
  '347': { name: 'XYBEIBAO',    kind: KIND.ACTIONS, panel: 'bag',  slot: 'items' },
  '348': { name: 'XYCWD',       kind: KIND.ACTIONS, panel: 'store', slot: 'items' },
  '349': { name: 'XYCWDT',      kind: KIND.TEXT,    panel: 'store', slot: 'detail' },
  '350': { name: 'XYBEIBAOT',   kind: KIND.TEXT,    panel: 'bag',  slot: 'detail2' },

  // ── 人物資訊（417–421）──
  '417': { name: 'XYRWNAME',    kind: KIND.TITLE,   panel: 'person' },
  '418': { name: 'XYRWMIAO',    kind: KIND.TEXT,    panel: 'person', slot: 'detail' },
  '419': { name: 'XYRWBUT1',    kind: KIND.ACTIONS, panel: 'person', slot: 'row1' },
  '420': { name: 'XYRWBUT2',    kind: KIND.ACTIONS, panel: 'person', slot: 'row2' },
  '421': { name: 'XYRWBUT3',    kind: KIND.TEXT,    panel: 'person', slot: 'detail2' },

  // ── 物品資訊（308–311）──
  '308': { name: 'XYTEXT3',     kind: KIND.ACTIONS, panel: 'item', slot: 'actions' },
  '309': { name: 'XYTEXT2',     kind: KIND.TEXT,    panel: 'item', slot: 'detail' },
  '310': { name: 'XYTEXT1',     kind: KIND.TITLE,   panel: 'item' },
  '311': { name: 'XYTEXT',      kind: KIND.TEXT,    panel: 'item', slot: 'body' },

  // ── 副本（270–272）──
  '270': { name: 'XYZFUBEN',    kind: KIND.TITLE,   panel: 'instance' },
  '271': { name: 'XYZFBTE',     kind: KIND.TEXT,    panel: 'instance', slot: 'detail' },
  '272': { name: 'XYZFBLIE',    kind: KIND.LIST,    panel: 'instance', slot: 'list' },

  // ── 綜合屬性（291–297、2k1–2k4）──
  '291': { name: 'XYZZHSXBT',   kind: KIND.TITLE,   panel: 'attr' },
  '292': { name: 'XYZZHSXXX',   kind: KIND.LIST,    panel: 'attr', slot: 'options' },
  '293': { name: 'XYZZHSXWB',   kind: KIND.TEXT,    panel: 'attr', slot: 'body' },
  '294': { name: 'XYZZHSXBUT',  kind: KIND.ACTIONS, panel: 'attr', slot: 'row1' },
  '295': { name: 'XYZZHSXBUT1', kind: KIND.ACTIONS, panel: 'attr', slot: 'row2' },
  '296': { name: 'XYZZHSXWB1',  kind: KIND.TEXT,    panel: 'attr', slot: 'body1' },
  '297': { name: 'XYZZHSXWB2',  kind: KIND.TEXT,    panel: 'attr', slot: 'body2' },
  '2k1': { name: 'XJYS1',       kind: KIND.TEXT,    panel: 'attr', slot: 'style1' },
  '2k2': { name: 'XJYS2',       kind: KIND.TEXT,    panel: 'attr', slot: 'style2' },
  '2k3': { name: 'XJYS3',       kind: KIND.TEXT,    panel: 'attr', slot: 'style3' },
  '2k4': { name: 'XJYS4',       kind: KIND.TEXT,    panel: 'attr', slot: 'style4' },

  // ── 好友／聊天（491–498）──
  '491': { name: 'XYFRIENDS1',  kind: KIND.ACTIONS, panel: 'friends', slot: 'row1' },
  '492': { name: 'XYFRIENDS2',  kind: KIND.ACTIONS, panel: 'friends', slot: 'row2' },
  '493': { name: 'XYFRIENDS3',  kind: KIND.ACTIONS, panel: 'friends', slot: 'row3' },
  '494': { name: 'XYFRIENDS4',  kind: KIND.ACTIONS, panel: 'friends', slot: 'row4' },
  '495': { name: 'XYFRIENDS5',  kind: KIND.TEXT,    panel: 'friends', slot: 'info' },
  '496': { name: 'XYFRIENDS6',  kind: KIND.MESSAGE, channel: 'chat' },
  '497': { name: 'XYFRIENDS7',  kind: KIND.TEXT,    panel: 'friends', slot: 'info2' },
  '498': { name: 'XYFRIENDS8',  kind: KIND.TEXT,    panel: 'friends', slot: 'info3' },

  // ── 跑鏢／列表（10a、11a、211–217）──
  '10a': { name: 'XYMRX',       kind: KIND.TEXT,    panel: 'escort', slot: 'banner' },
  '11a': { name: 'XYMRU',       kind: KIND.TEXT,    panel: 'escort', slot: 'tip' },
  '211': { name: 'XYLIE',       kind: KIND.TITLE,   panel: 'list' },
  '212': { name: 'XYLIF',       kind: KIND.LIST,    panel: 'list', slot: 'rows' },
  '213': { name: 'XYLIG',       kind: KIND.TEXT,    panel: 'list', slot: 'body' },
  '214': { name: 'XYLIK',       kind: KIND.ACTIONS, panel: 'list', slot: 'actions' },
  '215': { name: 'XYLIL',       kind: KIND.CLOSE,   panel: 'list' },
  '217': { name: 'XYJI',        kind: KIND.TEXT,    panel: 'list', slot: 'note' },

  // ── 排行榜（331–333）──
  '331': { name: 'DMJHPAI',     kind: KIND.TITLE,   panel: 'rank' },
  '332': { name: 'DMJHPAILEI',  kind: KIND.LIST,    panel: 'rank', slot: 'category' },
  '333': { name: 'DMJHPAIMING', kind: KIND.TEXT,    panel: 'rank', slot: 'body' },

  // ── 主頁（602–605）──
  '602': { name: 'DMZHUYET',    kind: KIND.TEXT,    panel: 'home', slot: 'body' },
  '603': { name: 'DMZHUYETY',   kind: KIND.TEXT,    panel: 'home', slot: 'body2' },
  '604': { name: 'DMZHUJMQH',   kind: KIND.CLOSE,   panel: 'home' },
  '605': { name: 'DMZHUJIU',    kind: KIND.TEXT,    panel: 'home', slot: 'notice' },

  // ── 其他 ──
  '030': { name: 'ZJEXIT1',     kind: KIND.TEXT,    panel: 'map', slot: 'meta' },
  '111': { name: 'DMJHLOOK',    kind: KIND.TEXT,    panel: 'self',  slot: 'body' },
  '130': { name: 'XYTISHI',     kind: KIND.MESSAGE, channel: 'sys' },
  '234': { name: 'ZJHPTXT1',    kind: KIND.BARS,    panel: 'stats2' },
  '286': { name: 'DMMAP',       kind: KIND.TEXT,    panel: 'map',   slot: 'body' },
  '450': { name: 'YJBUTTON',    kind: KIND.ACTIONS, panel: 'misc',  slot: 'buttons' },
  '701': { name: 'XCGX',        kind: KIND.TEXT,    panel: 'misc',  slot: 'daily' },
  '702': { name: 'JHYJMP',      kind: KIND.TITLE,   panel: 'sect' },
  '703': { name: 'JHYJMP1',     kind: KIND.LIST,    panel: 'sect', slot: 'types' },
};

/**
 * 指游 MUD 方言（ZY*）。
 *
 * ⚠️ **與 DMJH 有實際衝突**：602/603/604/605 在兩邊意義完全不同
 * （大梦江湖是「主頁」相關，指游是 ZYCHARHP / ZYFIGHTBTN / ZYHANDLERBTN / ZYCLEARSCREEN）。
 * 這就是為什麼不能把所有方言合併成一張表 —— 合併時後者會靜默覆蓋前者。
 */
const ZYMUD = {
  '600': { name: 'ZYRIGHTBTN',    kind: KIND.ACTIONS, panel: 'quickside', slot: 'buttons' },
  '601': { name: 'ZYHPTXT',       kind: KIND.ENTITY_ADD, panel: 'status', side: 'ally' },
  '602': { name: 'ZYCHARHP',      kind: KIND.ENTITY_ADD, panel: 'status', side: 'enemy' },
  '603': { name: 'ZYFIGHTBTN',    kind: KIND.ACTIONS, panel: 'combat', slot: 'skills' },
  '604': { name: 'ZYHANDLERBTN',  kind: KIND.ACTIONS, panel: 'handler', slot: 'buttons' },
  '605': { name: 'ZYCLEARSCREEN', kind: KIND.CLEAR_MAIN },
  '606': { name: 'ZYRIGHTMENU',   kind: KIND.LIST,    panel: 'sidemenu', slot: 'items' },
  '607': { name: 'ZYVOICE',       kind: KIND.IGNORE },      // 官方標註「暫未實現」
  '608': { name: 'ZYPROGRESS',    kind: KIND.BARS,    panel: 'status', slot: 'progress' },
  '609': { name: 'ZYSYSEXIT',     kind: KIND.RELOGIN },     // payload = 幾毫秒後回登入畫面
  '610': { name: 'ZYSTATUSINFO',  kind: KIND.IGNORE },      // Android 通知欄，Web 端無效
  '611': { name: 'ZYCLIENTSTATUS',kind: KIND.NETSTAT },     // 開啟/關閉 網路狀態與幀率
  '612': { name: 'ZYSELECT',      kind: KIND.HINT },        // 元件提示：`選擇器|說明`
  '613': { name: 'ZYATTACK',      kind: KIND.DAMAGE },      // 目標$zj#訊息$zj#顏色$zj#持續ms
  '614': { name: 'ZYSKILL',       kind: KIND.ACTIONS, panel: 'skill', slot: 'items' },
  '615': { name: 'ZYSTORYTEXT',   kind: KIND.STORY },       // 逐字劇情
  '616': { name: 'ZYVIBRATE',     kind: KIND.VIBRATE },     // 時長 ms
  '617': { name: 'ZYBTSET',       kind: KIND.ACTIONS, panel: 'quickside', slot: 'unlimited' },
  '618': { name: 'ZYKJ',          kind: KIND.ACTIONS, panel: 'hotkey', slot: 'items' },
  // ★ 唯一的 4 字元 opcode
  '1085': { name: 'ZYMAP',        kind: KIND.TEXT,    panel: 'map', slot: 'body' },
};

/**
 * 方言 profile。核心 27 個 opcode 三者共用，差異只在擴充區。
 * 選哪一套由連線時的版本挑戰字串決定（見 detectDialect）。
 */
export const PROFILES = {
  classic: { label: '經典 zjmud', ext: {} },
  dmjh:    { label: '大梦江湖（新協議）', ext: DMJH },
  zymud:   { label: '指游 MUD（ZY）', ext: ZYMUD },
};

/** 目前套用的 profile。預設 dmjh —— 它是擴充最完整、且與經典完全相容的一套。 */
let activeProfile = 'dmjh';

export function setDialect(name) {
  if (PROFILES[name]) activeProfile = name;
  return activeProfile;
}

export function getDialect() { return activeProfile; }

/**
 * 從伺服器的版本挑戰字串判別方言。
 *
 * 三種已知寫法（出處分別是 LPMud-Name 的 logind.c、官方協議文件、指游轉換教程）：
 *   `ver1.0:<crypt>`           經典
 *   `ver1.0,<crypt>`           官方文件版
 *   `version 1.0 key::<crypt>` 指游
 */
export function detectDialect(challengeLine) {
  const s = String(challengeLine ?? '');
  if (s.startsWith('version 1.0')) return 'zymud';
  if (s.startsWith('ver1.0')) return 'dmjh';   // 經典與 dmjh 的核心相同，用 dmjh 較不會漏
  return activeProfile;
}

/** 面板的人類可讀名稱，給 UI 當標題用。 */
export const PANEL_TITLE = {
  combat: '戰鬥', shop: '商城', bag: '背包', store: '儲物袋',
  person: '人物', item: '物品', instance: '副本', attr: '綜合屬性',
  friends: '好友', escort: '跑鏢', list: '列表', rank: '排行榜',
  home: '主頁', self: '自身', map: '地圖', stats2: '狀態',
  misc: '其他', sect: '門派',
  // 指游 ZY 方言
  quickside: '側邊按鈕', status: '狀態', handler: '操作面板',
  sidemenu: '選單', skill: '技能', hotkey: '快捷鍵',
};

/**
 * 查詢一個 opcode 的擴充定義。
 * @returns {object|null}
 */
export function lookupExtended(op) {
  const ext = PROFILES[activeProfile]?.ext ?? {};
  if (Object.prototype.hasOwnProperty.call(ext, op)) return ext[op];
  // 沒命中目前 profile 時，仍在其他 profile 找一次 —— 寧可認得也不要當成亂碼丟出去。
  // 但有衝突的碼（602–605）一定以目前 profile 為準，所以只在「所有 profile 都唯一」時才回退。
  const hits = [];
  for (const p of Object.values(PROFILES)) {
    if (Object.prototype.hasOwnProperty.call(p.ext, op)) hits.push(p.ext[op]);
  }
  return hits.length === 1 ? hits[0] : null;
}

/** 擴充方言涵蓋的 opcode 數量。 */
export function extendedCount() {
  return Object.keys(PROFILES[activeProfile]?.ext ?? {}).length;
}

/** 所有 profile 加總涵蓋的不同 opcode 數（含衝突的只算一次）。 */
export function totalOpcodeCoverage() {
  const all = new Set();
  for (const p of Object.values(PROFILES)) for (const k of Object.keys(p.ext)) all.add(k);
  return all.size;
}

/** 診斷用：列出在多個 profile 中意義不同的 opcode。 */
export function conflictingOpcodes() {
  const seen = new Map();
  for (const [name, p] of Object.entries(PROFILES)) {
    for (const [op, def] of Object.entries(p.ext)) {
      if (!seen.has(op)) seen.set(op, []);
      seen.get(op).push({ profile: name, macro: def.name });
    }
  }
  return [...seen.entries()].filter(([, v]) => v.length > 1)
    .map(([op, v]) => ({ op, defs: v }));
}
