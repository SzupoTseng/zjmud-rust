// 啟動、組裝、事件接線。
//
// 資料流（單向）：
//   TCP 一行 → protocol.decodeLine → applyEvent(reducer) → store → UI 訂閱者重繪
//   使用者操作 → sendCommand → TCP
//
// 見 docs/ZJMUD_CLIENT_LOGIC_DESIGN.md §3.1 依賴方向。

import {
  decodeLine, parseDialog, expandDialogCommands, expandInputTemplate, SEP,
  LOGIN, buildLoginLine, buildCharLine, isChallenge, applyDialectFromChallenge,
} from './protocol.js';
import { createStore } from './store.js';
import { createTransport, isTauri, environment } from './net.js';
import { loadPrefs, savePrefs, pushHistory } from './prefs.js';
import * as UI from './ui.js';
import { PANEL_TITLE } from './dialects.js';
import { loadCatalogue, bootMudInPage, currentMud } from './wasmboot.js';
import { createTelnetLogin, validateCreds, specSummary } from './telnetlogin.js';

// 伺服器最近一次的說明文字（ESC015／純文字），用來把**真正的理由**
// 顯示在登入視窗裡——而不是我們自己編一句籠統的話。
// 【WHY】各站拒絕帳號的理由差很多（長度、字集、禁用字、重複字元、
// 「這個名字被系統禁止註冊」…），只說「不接受這個帳號」等於沒說。
let lastServerNotice = '';

const store = createStore();
const prefs = loadPrefs();

let toast = null;
let floatText = null;

// ── 指令送出 ────────────────────────────────────────

/**
 * 所有可點元件與輸入列共用的唯一送出路徑。
 * multiline=false 時把 \n 換成 ;（協議 §1.1）。
 */
function sendCommand(cmd) {
  if (cmd == null || cmd === '') return;
  const line = store.get('conn.multiline') ? cmd : cmd.split('\n').join(';');
  net.send(line);
}

// ── 事件套用（reducer）───────────────────────────────

function applyEvent(ev) {
  switch (ev.type) {
    // ── 連線 ──
    case 'conn.notice': {
      // 伺服器完成重連後要求客戶端重新 look（協議 §2.3）
      if (ev.reloginLook) sendCommand('l');

      // 登入狀態碼（協議 §6.3）
      const code = (ev.text ?? '').slice(0, 4);
      if (code === LOGIN.NEED_CHAR) {
        // 0008：帳號沒有角色，跳出建角視窗
        login.stage = 'creating';
        openCharModal();
      } else if (code === LOGIN.OK) {
        // 0007：登入成功
        login.stage = 'done';
        login.failures = 0;
        closeLoginModal();
        closeCharModal();
        updateWhoLabel();
        // ★ 進世界後主動 look 三次（間隔開）。
        //
        // 【WHY】原生 zjmud 台進場就會送面板，但**由一般 mudlib 轉換而來**的
        // 台不一定：
        //   ① 有些家族的 enter_world 還要幾拍才把人物移進起始房間，
        //      太早看等於看空氣；
        //   ② 风云Ⅱ 系進世界後還掛著 `请敲回车键［ＲＥＴＵＲＮ］` 的 input_to，
        //      面板 opcode 全被「[输入时暂存讯息]」緩衝住——第一次 look
        //      會被當成那個 RETURN 的答案吃掉，第二次才真的看到房間。
        // 使用者看到的差別是「登入成功後一片空白」與「正常進到房間」。
        // 【WHY 送 look 是安全的】它是唯讀指令，重複執行沒有副作用；
        // 而閘門（boot-test）用的是同一組時間點——閘門不可以比產品寬容。
        for (const ms of [500, 2500, 5000, 9000]) setTimeout(() => sendCommand('look'), ms);
      } else if (code === LOGIN.BAD_ID) {
        // ★ 帳號被拒：把登入視窗叫回來，並把伺服器的理由顯示出來。
        //
        // 【WHY】原本完全沒有處理 0001——客戶端收到之後什麼都不做，
        // 於是畫面停在一行原始的伺服器訊息（例如
        // 「对不起，请不要使用重复三个字母以上的字符做名字」），
        // **登入視窗再也不會出現**，使用者只能重新整理。
        // 【證據】使用者實測 aoxiangtianji：輸入含重複字元的帳號後卡住，
        // 而 logind 的 check_legal_id 確實 return 0 並要求重輸。
        // 【WHY 之前沒發現】閘門固定用一個「剛好合法」的帳號，
        // 從來沒走過被拒的路徑——**測試資料要挑最容易踩雷的合法輸入**
        // （CLAUDE.md §3），而帳號規則正是各家差異最大的地方。
        login.stage = 'authing';
        showLoginError(lastServerNotice
          || '伺服器不接受這個帳號，請換一個（各站的規則不同：長度、字集、不可有重複字元…）。');
        openLoginModal();
      } else if (code === LOGIN.BAD_NAME) {
        showCharError('伺服器不接受這個名字，請換一個。');
        openCharModal();
      }
      break;
    }
    case 'conn.multiline':
      store.set('conn.multiline', ev.value);
      break;
    case 'conn.echo':
      // 伺服器代送指令：把 payload 原樣回送
      sendCommand(ev.cmd);
      break;
    case 'conn.relocate':
      if (ev.host && ev.port) {
        toast?.show(`伺服器要求切換到 ${ev.host}:${ev.port}`);
        net.close().then(() => net.connect(ev.host, ev.port));
      }
      break;
    case 'conn.quit':
      // 原版是無條件 System.exit(0)。這裡改成詢問，避免玩家莫名其妙被關掉。
      if (confirm('伺服器要求結束連線，要關閉客戶端嗎？')) {
        net.close();
        globalThis.__TAURI__?.window?.getCurrentWindow?.().close?.();
      } else {
        net.close();
      }
      break;

    // ── 房間 ──
    case 'room.title':
      // ESC002 有大量副作用：清空出口、物件、標題按鈕、戰鬥面板（協議 §2.3）
      store.resetRoom();
      store.set('room.title', ev.text);
      break;
    case 'room.desc':
      store.set('room.desc', ev.text);
      break;
    case 'room.descToggle':
      store.set('room.descForcedHidden', ev.hidden);
      break;
    case 'room.exits':
      store.set('room.exits', ev.exits);
      break;
    case 'room.exitRemove': {
      const exits = store.get('room.exits').filter((e) => e.dir !== ev.dir);
      store.set('room.exits', exits);
      break;
    }
    case 'room.exitClear':
      store.set('room.exits', []);
      break;
    case 'room.objects':
      store.set('room.objects', ev.objects);
      break;
    case 'room.objectRemove':
      store.set('room.objects', store.get('room.objects').filter((o) => o.cmd !== ev.tag));
      break;
    case 'room.objectBar': {
      const objects = store.get('room.objects').map((o) =>
        o.cmd === ev.tag ? { ...o, bar: { a: ev.a, b: ev.b, max: ev.max } } : o,
      );
      store.set('room.objects', objects);
      break;
    }

    // ── 狀態列與快捷鈕 ──
    case 'stat.bars':
      store.set('stats', { bars: ev.bars, layout: ev.layout });
      break;
    case 'ui.titleButtons':
      store.set('room.titleButtons', ev.buttons);
      break;
    case 'ui.quickButtons': {
      const slots = { ...store.get('quick.slots') };
      for (const b of ev.buttons) {
        if (b.slot === 'bs') {
          // bs 槽位：房間名本身變成可點擊指令，不使用 label 欄
          store.set('room.titleCmd', b.cmd);
        } else {
          slots[b.slot] = { label: b.label, cmd: b.cmd };
        }
      }
      store.set('quick.slots', slots);
      // 任何 b1–b17 出現就切到自訂按鈕列（協議 §4.3 副作用）
      if (ev.buttons.some((b) => b.slot !== 'bs')) store.set('quick.showCustom', true);
      break;
    }

    // ── 訊息 ──
    case 'msg.main':
      store.pushMessage('main', ev.text);
      break;
    case 'msg.chat':
      store.pushMessage('chat', ev.text);
      break;
    case 'msg.toast':
      toast?.show(ev.text);
      store.pushMessage('sys', ev.text);
      break;
    case 'msg.combat':
      store.set('ui.combatVisible', true);
      store.pushMessage('combat', ev.text);
      store.pushMessage('sys', ev.text);
      break;
    case 'msg.combatClose':
      store.set('ui.combatVisible', false);
      store.clearMessages('combat');
      break;
    case 'msg.float':
      floatText?.show(ev.text);
      break;

    // ── 疊層 ──
    case 'overlay.prompt':
      store.patch('overlay', {
        kind: 'interact', detail: ev.text, promptTemplate: ev.template,
        needNumber: true, actions1: null, actions2: null,
      });
      break;
    case 'overlay.detail':
      // ESC007 會清空兩組動作列並隱藏數量輸入（協議 §2.3）。
      // $br# 在這裡（UI 層）轉成真換行——解析層依契約原樣保留
      // （test/server-fixtures.test.mjs 明文釘住），而畫面端先前漏了履約：
      // 91书剑 的登入公告整段原字印出 $br#（實錄截圖）。
      store.patch('overlay', {
        kind: 'interact', detail: String(ev.text ?? '').split(SEP.BR).join('\n'), promptTemplate: null,
        needNumber: false, actions1: null, actions2: null,
      });
      break;
    case 'overlay.actions':
      store.patch('overlay', {
        kind: 'interact',
        [ev.column === 1 ? 'actions1' : 'actions2']: { layout: ev.layout, items: ev.items },
      });
      break;
    case 'overlay.dialog':
      store.patch('overlay', { kind: 'dialog', dialog: ev.dialog });
      break;
    case 'overlay.map':
      store.patch('overlay', { kind: 'map', map: String(ev.text ?? '').split(SEP.BR).join('\n') });
      break;
    case 'overlay.pagedText':
      store.patch('overlay', { kind: 'paged', paged: String(ev.text ?? '').split(SEP.BR).join('\n'), pagedPage: 0 });
      break;
    case 'overlay.popMenu':
      store.patch('overlay', { kind: 'popmenu', popMenu: { layout: ev.layout, items: ev.items } });
      break;
    case 'overlay.web':
      // 內嵌網頁在 Tauri 的 CSP 下不開放外連，改用外部瀏覽器開啟
      store.patch('overlay', { kind: null });
      openExternal(ev.url);
      break;

    // ── 指游 ZY 方言的「客戶端能力」類 ──
    // 這些不是內容而是行為：清畫面、震動、延時重登…
    // 它們由 decodeLine 產生，若這裡沒有對應 case 會靜默掉進 default，
    // 表現為「伺服器叫客戶端做某件事，客戶端什麼都沒做」。
    case 'ui.clearMain':
      store.clearMessages('main');
      break;

    case 'ui.vibrate':
      // 瀏覽器版在支援的裝置上真的會震；桌面版沒有這個 API，安靜略過
      try { globalThis.navigator?.vibrate?.(ev.durationMs); } catch { /* 不支援 */ }
      break;

    case 'ui.netStat':
      store.set('ui.netStatVisible', ev.enabled);
      break;

    case 'ui.hint':
      // 元件提示（`.選擇器|說明`）。目前以系統訊息呈現，不做浮動 tooltip。
      for (const h of ev.items ?? []) {
        if (h.text) store.pushMessage('sys', h.text);
      }
      break;

    case 'ui.ignored':
      // 官方明確標為「未實現」或平台不適用（語音界面、Android 通知欄）
      break;

    case 'conn.relogin':
      // ZYSYSEXIT(ms)：N 毫秒後回登入畫面
      toast?.show(`伺服器要求 ${Math.round((ev.delayMs || 0) / 1000)} 秒後重新登入`);
      setTimeout(() => {
        net.close();
        resetLoginState();
        openLoginModal();
      }, ev.delayMs || 0);
      break;

    case 'overlay.story':
      store.patch('overlay', {
        kind: 'story', story: { text: ev.text, speedMs: ev.speedMs, background: ev.background },
      });
      break;

    case 'overlay.storyClose':
      store.patch('overlay', { kind: null, story: null });
      break;

    // ── 擴充方言面板（新協議 mudlib，見 dialects.js）──
    case 'panel.title':
      store.extSet(ev.panel, { title: ev.text });
      break;
    case 'panel.text':
      store.extSlot(ev.panel, ev.slot, { kind: 'text', text: ev.text });
      break;
    case 'panel.list':
      store.extSlot(ev.panel, ev.slot, { kind: 'list', items: ev.items });
      break;
    case 'panel.actions':
      store.extSlot(ev.panel, ev.slot, { kind: 'actions', layout: ev.layout, items: ev.items });
      break;
    case 'panel.bars':
      store.extSlot(ev.panel, ev.slot, { kind: 'bars', layout: ev.layout, bars: ev.bars });
      break;
    case 'panel.entityAdd':
      store.extEntity(ev.panel, ev.side, { id: ev.id, label: ev.label, bar: ev.bar });
      break;
    case 'panel.entityDel':
      store.extEntityRemove(ev.panel, ev.side, ev.id);
      break;
    case 'panel.close':
      store.extClose(ev.panel);
      break;

    default:
      console.warn('[main] 未處理的事件：', ev.type);
  }
}

function openExternal(url) {
  const opener = globalThis.__TAURI__?.opener;
  if (opener?.openUrl) opener.openUrl(url).catch(() => {});
  else console.info('[main] 伺服器要求開啟網頁：', url);
}

// ── 登入狀態機 ──────────────────────────────────────
//
// 【為什麼要這個】
// 伺服器對「連上到登入完成」有時限（logind.c 的 input_to 逾時）。
// 初版沒有登入介面，要使用者自己在指令列打三行 ——
// 人工打字趕不上逾時，於是變成「連線→被踢→自動重連→再被踢」的無限迴圈，
// 畫面只會一直重複 ver1.0 與「您花在连线进入手续的时间太久了」。
//
// 現在改由客戶端接手：偵測到版本挑戰就跳出登入表單，
// 送出時把三個步驟一次打完，人不必跟伺服器賽跑。


const login = {
  stage: 'idle',   // idle | challenge | authing | creating | done
  id: '', password: '', email: '', cname: '', gender: 'm',
  manual: false,   // 使用者選擇自己手動打指令
  failures: 0,     // 連續失敗次數，用來止住重連迴圈
  dialect: 'dmjh', // 由版本挑戰字串判別（見 dialects.js detectDialect）
  charFields: 3,   // 建角欄位數：經典 3 欄、指游 2 欄
  loginFields: 4,  // 登入欄位數：LPMud-Name 4 欄、官方文件 3 欄
};

function resetLoginState() {
  telnetLogin = null;
  login.stage = 'idle';
  login.manual = false;
  updateWhoLabel();
}

/** 伺服器每一行都先給登入狀態機看一眼；回傳 true 表示這行已被它處理掉。 */
function loginIntercept(raw) {
  if (typeof raw !== 'string') return false;

  // ① 版本挑戰 → 判別方言、準備登入
  if (isChallenge(raw)) {
    // ★ 一條連線只登入一次。
    // 【WHY】曾經每收到一行 ver1.0: 就送一次登入，伺服器 log 累積五萬次登入。
    // 【推理】真因是連線被反覆取代（見 net.js connect()），但這裡缺少防線，
    //   讓一個傳輸層的 bug 直接放大成「對伺服器狂打帳密」。防線與根因要分開修：
    //   根因修好可以不再觸發，防線確保下次別的原因造成重送時不會再打爆伺服器。
    // 【證據】world/log/debug.log 每秒一組 crypt 驗證警告，累計 50,251 次。
    if (login.stage === 'authing' || login.stage === 'done') return false;
    cancelNoChallengeFallback();   // 真的收到挑戰了，退路用不上
    login.stage = 'challenge';
    // 三種挑戰寫法對應不同方言，順便決定 opcode 表與建角欄位數
    login.dialect = applyDialectFromChallenge(raw);
    login.charFields = login.dialect === 'zymud' ? 2 : 3;
    if (login.manual) return false;

    if (login.id && login.password) {
      doAutoLogin();
    } else {
      openLoginModal();
    }
    return false; // 仍讓它顯示在訊息區，方便除錯
  }

  // ② 帳號在別處登入被踢
  //    兩個客戶端（例如桌面版與瀏覽器版）用同一組帳號時會互相把對方踢下線。
  //    若還讓自動重連跑下去，兩邊會無限互踢，畫面被洗版。
  if (raw.includes('账号在别处登录') || raw.includes('帳號在別處登入')) {
    net.stopReconnect();
    openLoginModal();   // 先開，因為它會清空錯誤列
    showLoginError('這個帳號已在別處登入，本端已停止自動重連。\n'
      + '（同時開桌面版與瀏覽器版會互踢，請只留一個，或用不同帳號。）');
    return false;
  }

  // ③ 逾時被踢
  if (raw.includes('花在连线进入手续的时间太久')) {
    login.failures += 1;
    if (login.failures >= 3) {
      // 連續失敗就停止重連，否則會無限迴圈刷畫面
      net.stopReconnect();
      openLoginModal();   // 先開，因為它會清空錯誤列
      showLoginError('連續多次登入逾時，已停止自動重連。請確認帳號密碼後按「登入」重試。');
    }
    return false;
  }
  return false;
}

/** 把版本回覆與帳號行一次送完，不給伺服器逾時的機會。 */
/**
 * telnet 接應器（非 zjmud 的 mudlib 用）。
 * null = 目前這台講 zjmud，走原本的登入路徑。詳見 telnetlogin.js 檔頭。
 */
let telnetLogin = null;

function doAutoLogin() {
  login.stage = 'authing';

  // telnet lib：不能送 `账号║密码║…`（它看不懂 ║）。改由接應器按提示代答，
  // 帳密還是登入視窗收到的這一組，只是改成一行一行回。
  const mud = currentMud();
  if (mud?.protocol === 'telnet') {
    telnetLogin = createTelnetLogin({
      profile: mud.loginProfile,
      creds: { id: login.id, pw: login.password, name: login.cname, gender: login.gender },
      send: (l) => net.send(l),
      onDone: () => {
        login.stage = 'done';
        login.failures = 0;
        closeLoginModal();
        updateWhoLabel();
        sendCommand('look');    // 進世界了，主動看一眼帶出房間文字
      },
    });
    // ★ 開機踢一腳：名字提示多半在使用者還在打帳密時就送到並顯示過了，
    // 接應器是提交後才建立的，看不到已經過去的行。送一個空行讓伺服器
    // 重印目前這一步的提示（input_to 對空輸入的標準行為就是再問一次），
    // 接應器就能從當下這一步接手。
    net.send('');
    // 停滯偵測：接應器 20 秒沒走完，就把「卡住了」講出來。
    // 【WHY】接應器啞掉時（沒對上的提示）畫面只是靜止，使用者無從回報起；
    // 東方故事的短密碼卡死就是這樣被發現得太晚的。
    const guard = telnetLogin;
    setTimeout(() => {
      if (telnetLogin === guard && guard && !guard.done) {
        store.pushMessage('sys', '【接應器】登入流程 20 秒未完成——伺服器最後的提示可能沒被認出。'
          + '可以直接在下方輸入列手動回答，或斷線重試；請把畫面回報給開發者。');
        toast?.show('登入流程卡住了，可改用手動輸入');
      }
    }, 20000);
    return;
  }

  net.send(LOGIN.ANY);
  net.send(buildLoginLine({
    id: login.id, password: login.password, email: login.email,
    fields: login.loginFields ?? 4,
  }));
}

/**
 * 開啟登入視窗。**必須是等冪的：已經開著就完全不動它。**
 *
 * 【WHY】使用者回報「點了密碼欄，focus 一直跳回帳號欄，密碼打不進去」。
 *
 * 【推理】這個函式有五個呼叫點，其中 loginIntercept() 的版本挑戰分支是每收到一行
 * 挑戰就呼叫一次；而伺服器在等待輸入期間會**反覆重送** `ver1.0:` 挑戰行，
 * 於是 openLoginModal() 被連續呼叫，每次都無條件 focus('login-id')——
 * 視窗其實一直開著，被重設的只有游標位置。曾誤以為是瀏覽器密碼管理員搶 focus，
 * 但改掉 autocomplete 屬性後症狀不變，才回頭看呼叫次數。
 *
 * 【證據】main.js:337 挑戰分支呼叫本函式；isChallenge() 對每一行挑戰都成立，
 * 伺服器 LPMud-Name 在登入前會週期性重送該行（實機 live-capture 可見多次 ver1.0:）。
 * 另外 §015「[hidden] 被作者樣式蓋掉」的教訓同樣適用：狀態轉換要看 m.hidden，
 * 不能假設「呼叫了就等於剛剛才打開」。
 */
function openLoginModal() {
  const m = document.getElementById('login-modal');
  if (!m) return;
  // telnet 台：把「這台可能會問的欄位」全部先收齊（超集），並把該台的
  // 硬性限制寫在視窗裡——送出前就把關，不等伺服器的拒絕訊息。
  const mud = currentMud();
  // ★ 標題要在**開視窗時**設，不是在直達流程裡設。
  // 【WHY】直達流程設完之後，登入視窗是稍後才開的——中間隔著映像載入
  // 與伺服器握手，而開視窗這條路徑不知道使用者選了哪一台。
  // 實測：picker 修好之後標題仍只顯示「登入」。
  // `currentMud()` 是**正在跑的那一台**，比任何早先記下的值可靠。
  const lt = document.getElementById('login-title');
  if (lt) lt.textContent = mud ? `登入 ${mud.title || mud.slug}` : '登入';
  const tf = document.getElementById('telnet-fields');
  if (tf) {
    tf.hidden = mud?.protocol !== 'telnet';
    if (!tf.hidden) {
      const req = document.getElementById('login-req');
      if (req) req.textContent = '這台的要求：' + specSummary(mud.loginProfile);
    }
  }
  // 已經開著 → 不重設錯誤列、更不可搶 focus，否則使用者永遠停在帳號欄。
  if (!m.hidden) return;
  showLoginError('');
  m.hidden = false;
  document.getElementById('login-id')?.focus();
}

function closeLoginModal() {
  const m = document.getElementById('login-modal');
  if (m) m.hidden = true;
}

function showLoginError(msg) {
  const b = document.getElementById('login-error');
  if (!b) return;
  b.textContent = String(msg ?? '');
  b.hidden = !msg;
}

function openCharModal() {
  const m = document.getElementById('char-modal');
  if (!m) return;
  m.hidden = false;
  document.getElementById('char-name')?.focus();
}

function closeCharModal() {
  const m = document.getElementById('char-modal');
  if (m) m.hidden = true;
}

function bindLoginForms() {
  const idEl = document.getElementById('login-id');
  const pwEl = document.getElementById('login-pw');
  const emEl = document.getElementById('login-email');
  const rmEl = document.getElementById('login-remember');

  rmEl.checked = Boolean(prefs.rememberAccount);
  emEl.value = prefs.accountEmail ?? '';
  if (rmEl.checked) {
    idEl.value = prefs.accountId ?? '';
    pwEl.value = prefs.accountPw ?? '';
  }

  // ★ 自動登入的帳密**只能**來自我們自己存的偏好，不能來自輸入框的值。
  //
  // 【為什麼】輸入框帶 autocomplete="username"/"current-password"，
  // 瀏覽器的密碼管理員會自動填入。先前這裡直接讀 idEl.value / pwEl.value，
  // 於是「瀏覽器幫你填」被誤當成「使用者選擇了自動登入」——
  // 結果連全新的瀏覽器設定檔都會跳過登入表單直接進遊戲，
  // 使用者完全沒機會選帳號，也不知道自己是用哪個帳號進去的。
  //
  // 自動填入是方便使用者「少打字」，不等於同意「自動送出」。
  if (rmEl.checked) {
    login.id = prefs.accountId ?? '';
    login.password = prefs.accountPw ?? '';
  } else {
    login.id = '';
    login.password = '';
  }
  login.email = prefs.accountEmail ?? '';

  function submit() {
    const id = idEl.value.trim();
    const pw = pwEl.value;
    const mud = currentMud();

    if (mud?.protocol === 'telnet') {
      // telnet 台：照該台的欄位規格把關（前移驗證——不等伺服器的拒絕訊息）。
      const cname = document.getElementById('login-cname')?.value.trim() ?? '';
      const gender = document.getElementById('login-gender')?.value ?? 'm';
      const v = validateCreds(mud.loginProfile, {
        id: id.toLowerCase(), pw, name: cname, gender,
      });
      if (!v.ok) { showLoginError(v.errors.map((e) => e.msg).join('；')); return; }
      login.cname = cname;
      login.gender = gender;
    } else {
      if (!/^[a-z][a-z0-9_]{3,19}$/.test(id.toLowerCase())) {
        showLoginError('ID 需 4–20 字元、英文字母開頭，只能用小寫字母／數字／底線。');
        return;
      }
      if (!pw) { showLoginError('請輸入密碼。'); return; }
    }

    login.id = id.toLowerCase();
    login.password = pw;
    login.email = emEl.value.trim();
    login.failures = 0;

    // 密碼以明文存在本機。協議本身也是明文傳輸，這裡不會更不安全，
    // 但仍設成 opt-in，預設不記。
    savePrefs({
      rememberAccount: rmEl.checked,
      accountId: rmEl.checked ? login.id : '',
      accountPw: rmEl.checked ? login.password : '',
      accountEmail: login.email,
    });

    closeLoginModal();
    doAutoLogin();
  }

  document.getElementById('login-submit').addEventListener('click', submit);
  for (const el of [idEl, pwEl, emEl]) {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }
  document.getElementById('login-manual').addEventListener('click', () => {
    login.manual = true;
    closeLoginModal();
    store.pushMessage('main',
      '\u001b[1;33m【手動模式】請自行輸入：x → 帳號\u2551密碼\u2551byname666\u2551email → 性別\u2551\u2551角色名\u001b[0m');
  });

  // ── 建立角色 ──
  function submitChar() {
    const name = document.getElementById('char-name').value.trim();
    const sex = document.querySelector('input[name="char-sex"]:checked')?.value ?? '男';
    if (![...name].length || [...name].length < 2 || [...name].length > 4) {
      showCharError('角色名需 2–4 個字。');
      return;
    }
    if (/[a-zA-Z0-9]/.test(name)) { showCharError('請用中文取名。'); return; }
    closeCharModal();
    net.send(buildCharLine({ sex, name, fields: login.charFields ?? 3 }));
  }
  document.getElementById('char-submit').addEventListener('click', submitChar);
  document.getElementById('char-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitChar();
  });
}

function showCharError(msg) {
  const b = document.getElementById('char-error');
  if (!b) return;
  b.textContent = String(msg ?? '');
  b.hidden = !msg;
}

// ── 收到一行 ────────────────────────────────────────

function handleLine(raw) {
  try {
    // telnet 接應器優先看一眼：登入期間的提示由它代答。
    // 這一行**照樣往下顯示**——使用者要看得到伺服器在問什麼、我們答了什麼流程。
    if (telnetLogin && !telnetLogin.done && typeof raw === 'string') {
      telnetLogin.feed(raw);
    }
    loginIntercept(raw);
    applyEvent(decodeLine(raw));
  } catch (err) {
    // 單行解析失敗不能中斷整條讀取管線。降級成純文字並記錄原始行。
    console.warn('[main] 解析失敗，降級為純文字：', err, JSON.stringify(raw));
    store.pushMessage('main', raw);
  }
}

// ── 傳輸層 ──────────────────────────────────────────

/**
 * 「這台伺服器不送版本挑戰」的退路。
 *
 * 【WHY】逐台跑真網頁路徑時抓到兩台連上之後**完全沒有反應**：畫面空白、
 * 登入視窗不開、按鈕列全空。真因不是客戶端漏收，是伺服器根本沒送——
 * 大梦江湖 的 logind.logon() 把 `write("ver1.0,"+str+"\n")` 整行註解掉了，
 * 而它的 jiance() 比對的是**伺服器自己給的** str、不是客戶端送來的 arg，
 * 所以它其實接受任何輸入，只是不主動打招呼。
 *
 * 【推理】boot-test 早就有這條退路（等不到挑戰就照樣送帳號），所以 node 端
 * 一直是綠的——**驗證管線比產品本身寬容**，於是這個缺口在「17 台都 playable」
 * 的報告底下藏了很久。正確的修法是把同一條退路放進客戶端本體：
 * 連線開著、等了一段時間仍然沒有挑戰，就當作「這台不打招呼」，
 * 用預設方言把登入流程照樣走下去。
 *
 * 【證據】damengjianghu／nt7 在真網頁路徑等滿 120 秒，主訊息區一個字都沒有；
 * 而同樣兩台在 boot-test 走得完整條登入——差別只有這條退路。
 */
const NO_CHALLENGE_MS = 8000;
let noChallengeTimer = null;

function cancelNoChallengeFallback() {
  if (noChallengeTimer) { clearTimeout(noChallengeTimer); noChallengeTimer = null; }
}

function armNoChallengeFallback() {
  cancelNoChallengeFallback();
  // telnet 台**必然**不送 zjmud 挑戰（那正是它是 telnet 台的定義），
  // 等 8 秒只是白白讓使用者盯著招牌；1 秒足夠讓招牌先印完。
  const delay = currentMud()?.protocol === 'telnet' ? 1000 : NO_CHALLENGE_MS;
  noChallengeTimer = setTimeout(() => {
    noChallengeTimer = null;
    if (login.stage !== 'idle' || login.manual) return;   // 已經在走流程了
    login.dialect = 'dmjh';        // 沒有挑戰可判別，用收藏中最常見的那一種
    login.charFields = 3;
    login.stage = 'challenge';
    if (login.id && login.password) doAutoLogin();
    else openLoginModal();
  }, delay);
}

const net = createTransport({
  onLine: handleLine,
  onState: (s) => {
    if (s.state === 'IDLE' || s.state === 'FAILED') { resetLoginState(); cancelNoChallengeFallback(); }
    // 新連線 = 全新一輪握手，允許再登入一次（見 loginIntercept 的 stage 防線）。
    if (s.state === 'CONNECTING') login.stage = 'idle';
    if (s.state === 'OPEN') armNoChallengeFallback();
    store.patch('conn', {
      state: s.state, host: s.host, port: s.port,
      retries: s.retries ?? 0, nextRetryMs: s.nextRetryMs ?? 0,
      lastError: s.lastError ?? null,
    });
  },
});

// ── UI 操作上下文（傳給所有元件）──────────────────────

const ctx = {
  send: sendCommand,
  savePref: savePrefs,
  get dayMode() { return store.get('ui.theme') === 'day'; },

  onLink(link) {
    if (link.kind === 'cmd') { sendCommand(link.value); closeOverlay(); }
    else if (link.kind === 'pop') { applyEvent(decodeLine('020' + link.value)); }
    else if (link.kind === 'voice') { toast?.show('此版本未實作語音播放'); }
    else openExternal(link.value);
  },

  selectTarget(obj) {
    store.set('target', { id: obj.cmd, name: obj.label });
    sendCommand(obj.cmd);
  },

  requestMap() { sendCommand('map'); },

  runAction(item) {
    if (item.popup != null) {
      applyEvent(decodeLine('020' + item.popup));
      return;
    }
    sendCommand(item.cmd);
    // 含 $txt# 的動作保持面板開啟，供連續操作（協議 §4.4）
    if (!item.keepOpen) closeOverlay();
  },

  /** ESC001 輸入面板送出：template 內的 $txt# 換成輸入值，沒有就以空格接在後面。 */
  submitPrompt(value) {
    const tpl = store.get('overlay.promptTemplate');
    if (tpl != null) sendCommand(expandInputTemplate(tpl, value));
    closeOverlay();
  },

  confirmDialog(number) {
    const d = store.get('overlay.dialog');
    if (!d) return;
    if (d.needNumber && (number == null || number === '')) {
      toast?.show('請填入數量');
      return;
    }
    for (const cmd of expandDialogCommands(d.okCmds, d.needNumber ? number : null)) {
      sendCommand(cmd);
    }
    closeOverlay();
  },

  cancelDialog() {
    const d = store.get('overlay.dialog');
    if (d?.cancelCmd) sendCommand(d.cancelCmd);
    closeOverlay();
  },

  closeOverlay,
  retryNow: () => net.retryNow(),

  setExtPanel(name) { store.set('ext.active', name); },
  closeExtPanel() {
    const active = store.get('ext.active');
    if (active) store.extClose(active);
  },

  editQuickSlot(slot) {
    const cur = store.get('quick.slots')[slot];
    const input = prompt('輸入「名稱,指令」（留空則清除）', cur ? `${cur.label},${cur.cmd}` : '');
    if (input == null) return;
    const slots = { ...store.get('quick.slots') };
    if (input.trim() === '') {
      delete slots[slot];
    } else {
      const i = input.indexOf(',');
      const label = i === -1 ? input : input.slice(0, i);
      const cmd = i === -1 ? input : input.slice(i + 1);
      slots[slot] = { label: label.trim(), cmd: cmd.trim() };
    }
    store.set('quick.slots', slots);
    savePrefs({ quickSlots: slots });
  },
};

function closeOverlay() {
  store.patch('overlay', {
    kind: null, detail: '', promptTemplate: null, needNumber: false,
    actions1: null, actions2: null, dialog: null, popMenu: null,
  });
}

// ── 組裝 ────────────────────────────────────────────

/**
 * 逐項掛載，且**任何一項失敗都不會拖垮其他項**。
 *
 * 【為什麼要這樣】
 * 先前 mount() 是一長串直接呼叫，其中 MessageList 內部呼叫了在某些執行環境
 * 不存在的 Element.scrollTo，一拋例外整個 mount 就中斷 ——
 * 後面的 bindConnectForm() 從未執行，於是畫面渲染正常、但「連線」鈕
 * 完全沒有事件處理器，按下去毫無反應且沒有任何錯誤提示。
 * 現在每一項獨立保護，並把失敗蒐集起來顯示給使用者。
 */
const mountErrors = [];

function step(name, fn) {
  try {
    fn();
  } catch (err) {
    mountErrors.push(`${name}: ${err?.message ?? err}`);
    console.error('[mount]', name, err);
  }
}

function mount() {
  const $ = (id) => document.getElementById(id);

  step('Toast', () => { toast = UI.Toast($('toast-host'), { ctx }); });
  step('FloatText', () => { floatText = UI.FloatText($('float-host'), { ctx }); });

  step('ConnBadge', () => UI.ConnBadge($('conn-badge'), { store, ctx }));
  step('RoomHeader', () => UI.RoomHeader($('room-header'), { store, ctx }));
  step('RoomDesc', () => UI.RoomDesc($('room-desc'), { store, ctx }));
  step('EntityList', () => UI.EntityList($('entity-list'), { store, ctx }));
  step('ExitPad', () => UI.ExitPad($('exit-pad-host'), { store, ctx }));
  step('StatBars', () => UI.StatBars($('stat-bars'), { store, ctx }));
  step('QuickBar/main', () => UI.QuickBar($('quick-main'), { store, ctx, slots: UI.QUICK_MAIN }));
  step('QuickBar/bottom', () => UI.QuickBar($('quick-bottom'), { store, ctx, slots: UI.QUICK_BOTTOM }));

  step('MessageList/main', () => UI.MessageList($('msg-main'), { channel: 'main', store, ctx }));
  step('MessageList/chat', () => UI.MessageList($('msg-chat'), { channel: 'chat', store, ctx }));
  step('MessageList/sys', () => UI.MessageList($('msg-sys'), { channel: 'sys', store, ctx }));
  step('MessageList/combat', () => UI.MessageList($('msg-combat'), { channel: 'combat', store, ctx }));

  step('InteractSheet', () => UI.InteractSheet($('overlay-interact'), { store, ctx }));
  step('PopMenu', () => UI.PopMenu($('overlay-popmenu'), { store, ctx }));
  step('DialogModal', () => UI.DialogModal($('overlay-dialog'), { store, ctx }));
  step('MapOverlay', () => UI.SimpleOverlay($('overlay-map'), { store, ctx, kind: 'map', mono: true }));
  step('PagedOverlay', () => UI.SimpleOverlay($('overlay-paged'), { store, ctx, kind: 'paged', mono: false }));

  // 這幾項是使用者能不能操作的關鍵，放在最後但各自獨立保護
  step('CommandInput', () => bindCommandInput($('cmd-input'), $('cmd-send')));
  step('ChatTabs', () => bindChatTabs());
  step('CombatPane', () => bindCombatVisibility($('combat-pane')));
  step('Settings', () => bindSettings());
  step('ConnectForm', () => bindConnectForm());
  step('LoginForms', () => bindLoginForms());
  step('ExtPanels', () => UI.ExtPanels($('ext-panels'), { store, ctx, panelTitles: PANEL_TITLE }));

  // 還原偏好
  store.set('quick.slots', prefs.quickSlots ?? {});
  store.set('room.descHidden', Boolean(prefs.descHidden));
  applyTheme(prefs.theme ?? 'night');
  applyFontScale(prefs.fontScale ?? 1);

  // 環境提示。瀏覽器版經橋接一樣能連，只有「兩者皆不可用」時才需要警告。
  const envKind = environment();
  if (envKind === 'browser' && !(typeof WebSocket !== 'undefined' && globalThis.location?.host)) {
    store.pushMessage('main',
      '\u001b[1;33m【提示】此頁面不是由橋接程序供應，無法建立連線。\u001b[0m');
    store.pushMessage('main',
      '\u001b[37m請執行 START_WEB.bat（或 npm run web）後從 http:// 開啟，或改用桌面版。\u001b[0m');
  }

  // 任何一項掛載失敗都直接寫在連線面板上，不讓使用者面對「沒反應」的黑箱
  if (mountErrors.length) {
    showConnectError('介面初始化有 ' + mountErrors.length + ' 項失敗：\n' + mountErrors.join('\n'));
  }
}

// ── 指令輸入列（含歷史）──────────────────────────────

function bindCommandInput(input, sendBtn) {
  let history = [...(prefs.history ?? [])];
  let cursor = history.length;

  function submit() {
    const cmd = input.value;
    if (!cmd) return;
    sendCommand(cmd);
    history = pushHistory(cmd);
    cursor = history.length;
    input.value = '';
  }

  sendBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    else if (e.key === 'ArrowUp') {
      // 原版沒有指令歷史，這是新增的體驗改善（UI 文件 §9）
      if (cursor > 0) { cursor -= 1; input.value = history[cursor] ?? ''; e.preventDefault(); }
    } else if (e.key === 'ArrowDown') {
      if (cursor < history.length - 1) { cursor += 1; input.value = history[cursor] ?? ''; }
      else { cursor = history.length; input.value = ''; }
      e.preventDefault();
    } else if (e.key === 'Escape') {
      closeOverlay();
    }
  });
}

function bindChatTabs() {
  const tabs = document.querySelectorAll('[data-chat-tab]');
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const which = tab.dataset.chatTab;
      store.set('ui.chatTab', which);
      for (const t of tabs) t.classList.toggle('active', t === tab);
      document.getElementById('msg-chat').parentElement.hidden = which !== 'chat';
      document.getElementById('msg-sys').parentElement.hidden = which !== 'sys';
    });
  }
}

function bindCombatVisibility(pane) {
  store.sub('ui.combatVisible', (v) => { pane.hidden = !v; });
  pane.hidden = true;
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.set('ui.theme', theme);
  savePrefs({ theme });
}

function applyFontScale(scale) {
  document.documentElement.style.setProperty('--font-scale', String(scale));
  store.set('ui.fontScale', scale);
  savePrefs({ fontScale: scale });
}

function bindSettings() {
  const sel = document.getElementById('theme-select');
  sel.value = prefs.theme ?? 'night';
  sel.addEventListener('change', () => applyTheme(sel.value));

  const range = document.getElementById('font-range');
  range.value = String(prefs.fontScale ?? 1);
  range.addEventListener('input', () => applyFontScale(Number(range.value)));
}

/** 頂列顯示目前登入的帳號，並依狀態切換登出鈕。 */
function updateWhoLabel() {
  const who = document.getElementById('who-label');
  const btn = document.getElementById('logout-btn');
  const active = login.stage === 'done' && login.id;
  if (who) {
    who.textContent = active ? `帳號：${login.id}` : '';
    who.hidden = !active;
  }
  if (btn) btn.hidden = !active;
}

/** 把錯誤顯示在連線面板上。沒有這個的話連線失敗時畫面完全沒反應，無法診斷。 */
function showConnectError(msg) {
  const box = document.getElementById('connect-error');
  if (!box) return;
  box.textContent = String(msg);
  box.hidden = !msg;
}

/**
 * 連線面板的 mud 選單（WASM 模式專用）。
 *
 * 【WHY】WASM 版沒有遠端伺服器：每個 mud 是一份靜態映像，選哪個就把哪個灌進
 * driver 跑起來。第一個畫面問「位址／埠號」對這條路完全沒有意義。
 *
 * 【推理】清單必須是**動態**的：mud 會一直增加，而且每個 mud 的可玩程度是
 * build 時由 boot-test 真的跑一次「註冊→建角→進世界」量出來的（badge）。
 * 把清單寫死在 HTML 裡就等於每加一個 mud 就要改前端，而且 badge 會過期。
 *
 * 【證據】tools/build-site.mjs 產生 libs/index.json；badge 的定義見
 * tools/boot-test.mjs（playable / limited / noboot）。
 */
async function bindMudPicker(connectBtn) {
  const picker = document.getElementById('mud-picker');
  const listBox = document.getElementById('mud-list');
  const direct = document.getElementById('direct-fields');
  if (!picker || !listBox) return;

  const muds = await loadCatalogue();
  if (!muds.length) return;            // 不是 WASM 站台：維持原本的位址／埠號介面

  // ★ `?mud=<slug>`：直接開這一台，不顯示選單。
  //
  // 【WHY】站台改成「一台一個連結」的目錄頁之後，使用者是**帶著意圖**進來的
  // ——他點的是「火影忍者」那一列，不該再被問一次要玩哪一台。
  // 開場選單在只有十幾台時還算合理，上百台時它變成一道多餘的門。
  // 【證據】參考 mudlibs.fluffos.info 的做法：目錄頁列出全部，
  // 每一列一個連結，點進去就是那一台。
  // 【WHY 找不到就退回選單】網址可能是舊的、或那台被移除了；
  // 直接失敗會讓使用者卡在空白頁，退回選單至少還能繼續。
  let selected = muds.find((m) => m.slug === prefs.lastMud) ?? muds[0];

  const wanted = new URLSearchParams(globalThis.location?.search ?? '').get('mud');
  const direct0 = wanted && muds.find((m) => m.slug === wanted);
  if (direct0) {
    picker.hidden = true;
    if (direct) direct.hidden = true;
    connectBtn.textContent = `進入 ${direct0.title || direct0.slug}`;
    connectBtn.disabled = false;
    // 沿用選單原本的流程：把它設成「選中的那一台」，再讓下面註冊的
    // click 攔截器負責開機——不要另外寫一條開機路徑，否則兩條會漂移。
    selected = direct0;
    savePrefs({ lastMud: direct0.slug });
    // ★ 登入視窗的標題要跟著這一台。
    // 【WHY】`index.html` 原本寫死 `登入 江湖论剑`——那是開發時隨手填的
    // 佔位字串，從來沒被改成動態的。於是不論從目錄頁點哪一台，
    // 登入視窗都說「登入 江湖论剑」，使用者完全無法確認自己開對了沒有。
    const lt = document.getElementById('login-title');
    if (lt) lt.textContent = `登入 ${direct0.title || direct0.slug}`;
    setTimeout(() => connectBtn.click(), 0);   // 一進頁就開始載入
  }

  // 【WHY 要看 direct0】直達區塊執行在這一行**之前**，於是它設的
  // `picker.hidden = true` 立刻被這裡覆蓋回 false——選單照樣冒出來。
  // 使用者從目錄頁點進來是帶著意圖的，不該再看到一次清單。
  // 實測：`?mud=91shujian` 進去 pickerHidden 仍是 false。
  picker.hidden = Boolean(direct0);
  if (direct) direct.hidden = true;    // 兩種介面不並存，避免使用者以為要兩邊都填
  connectBtn.textContent = '進入';
  connectBtn.disabled = true;



  const render = () => {
    listBox.replaceChildren(...muds.map((m) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'mud-item' + (m.slug === selected.slug ? ' selected' : '')
        + (m.badge === 'noboot' ? ' disabled' : '');
      el.disabled = m.badge === 'noboot';
      el.innerHTML = '';
      const title = document.createElement('span');
      title.className = 'mud-item-title';
      title.textContent = m.title || m.slug;
      const meta = document.createElement('span');
      meta.className = 'mud-item-meta';
      meta.textContent = [
        m.dialect ? '方言 ' + m.dialect : null,
        m.sizeMB ? m.sizeMB + ' MB' : null,
        m.badge === 'playable' ? '可玩' : m.badge === 'limited' ? '部分功能' : '無法開機',
      ].filter(Boolean).join(' · ');
      el.append(title, meta);
      if (m.note) { const n = document.createElement('span'); n.className = 'mud-item-note'; n.textContent = m.note; el.append(n); }
      el.addEventListener('click', () => { selected = m; render(); });
      return el;
    }));
  };
  render();
  connectBtn.disabled = false;

  const progress = document.getElementById('mud-progress');
  const fill = document.getElementById('mud-progress-fill');
  const text = document.getElementById('mud-progress-text');
  const setProgress = (phase, frac, detail) => {
    if (progress) progress.hidden = false;
    if (fill) fill.style.transform = 'scaleX(' + (frac == null ? 0.15 : Math.max(0, Math.min(1, frac))) + ')';
    if (text) text.textContent = detail ? phase + ' — ' + detail : phase + '…';
  };

  // 攔在 connect 之前：先把選中的 mud 跑起來，再讓原本的連線流程照舊執行。
  // 用 capture 階段是因為原本的 click 監聽器是在 bindConnectForm 裡註冊的，
  // 而它預期按下去就直接 net.connect()——WASM 模式必須先有 driver 才有得連。
  connectBtn.addEventListener('click', async (ev) => {
    // ★ 判斷「要不要開機」看的是**選中的是不是正在跑的那一台**，不是「有沒有跑著」。
    //
    // 【WHY】使用者回報：換 mudlib 沒有用——斷線、選另一台、按進入，進去的還是
    // 第一台，而且畫面上一直疊出新的 `ver1.0,…` 握手行與「版本验证成功」。
    //
    // 【推理】舊條件是 `if (globalThis.__ZJMUD_WASM__) return;`：只要曾經開過任何
    // 一台，這個全域就永遠不是 null，於是第二次點「進入」直接放行給原本的連線
    // 流程——那條流程只會對**已經在跑的那個 driver** 再撥一次號。所以看到的是
    // 同一台 mud 重複 logon（每撥一次就再送一次握手行），而不是換了一台。
    // 這也解釋了「只有一台需要登入」：登入視窗是第一次握手時開的，後面幾次
    // 都被自動登入接手了。
    //
    // 【證據】使用者截圖裡連續五行 `ver1.0,$6$…`——`$6$` 這種 SHA-512 crypt 是
    // 91书剑 logind.c 的簽名（其他 lib 是 13 字元 DES 或固定字串），也就是說
    // 不管選了誰，跑的都還是第一次選的 91书剑。
    // 選中的那台已經在跑 → 什麼都不用做，讓原本的連線流程接手（＝一對一重連）。
    // 選了別台 → 交給 bootMudInPage，它自己會把舊的關乾淨（見 wasmboot.js
    // 的 disposeCurrentMud）。這裡不再自己收拾別人的東西。
    const running = currentMud();
    if (running && running.slug === selected.slug) return;
    ev.stopImmediatePropagation();
    ev.preventDefault();
    connectBtn.disabled = true;
    showConnectError('');
    try {
      savePrefs({ lastMud: selected.slug });
      if (running) {
        try { await net.close(); } catch { /* 本來就沒連上 */ }
        // 換的是**另一個世界**，前一台的房間／出口／狀態列／訊息全部作廢。
        // 不清掉的話新 mud 的畫面會疊在舊 mud 的殘留上，看起來像「換了但沒換乾淨」。
        store.reset();
      }
      await bootMudInPage(selected, setProgress);
      if (progress) progress.hidden = true;
      // ★ 一定要先解除 disabled 再點。
      // 【WHY】被 disabled 的按鈕**不會派發 click**，於是這一下完全沒作用：
      // driver 起來了、backend 也選到 wasm，但 net 永遠停在 IDLE，畫面上就是
      // 「載入完成卻沒有進遊戲」。原本 disabled 是在 finally 才解除的。
      // 【證據】全鏈路測試實測：wasm=true / backend=wasm / net=IDLE / 登入視窗沒開。
      connectBtn.disabled = false;
      connectBtn.click();                        // 這次 __ZJMUD_WASM__ 已就緒
    } catch (e) {
      if (progress) progress.hidden = true;
      showConnectError('啟動失敗：' + (e?.message ?? e));
    } finally {
      connectBtn.disabled = false;
    }
  }, true);
}

function bindConnectForm() {
  const host = document.getElementById('host-input');
  const port = document.getElementById('port-input');
  const btn = document.getElementById('connect-btn');
  const panel = document.getElementById('connect-panel');
  const envBox = document.getElementById('connect-env');

  host.value = prefs.lastHost ?? '127.0.0.1';
  port.value = String(prefs.lastPort ?? 5001);

  // ── WASM 模式：把「位址／埠號」換成「選一個 mudlib」──
  // 清單是動態的：build-site.mjs 把 boot-test 真的跑過的結果寫成 libs/index.json，
  // 這裡照它渲染。沒有這個檔就完全不動，桌面版與橋接版行為不變。
  bindMudPicker(btn).catch((e) => showConnectError('讀取 mud 清單失敗：' + (e?.message ?? e)));

  // 環境自我診斷：一眼看出走的是哪一條路、通不通
  const env = environment();
  if (env === 'tauri') {
    const t = globalThis.__TAURI__;
    const parts = ['core' in t ? 'core✓' : 'core✗', 'event' in t ? 'event✓' : 'event✗'];
    envBox.textContent = `環境：桌面版（Tauri 直連 TCP，${parts.join(' ')}）`;
  } else if (typeof WebSocket !== 'undefined' && globalThis.location?.host) {
    envBox.textContent = `環境：瀏覽器版（經 WebSocket 橋接 ${globalThis.location.host}）`;
  } else {
    envBox.textContent = '⚠ 無可用的傳輸方式。請用桌面版，或由橋接程序供應此頁面。';
    envBox.classList.add('bad');
  }

  btn.addEventListener('click', async () => {
    showConnectError('');
    const h = host.value.trim();
    const p = parseInt(port.value, 10);
    if (!h || !Number.isFinite(p)) { showConnectError('請填入正確的位址與埠號'); return; }
    savePrefs({ lastHost: h, lastPort: p });
    btn.disabled = true;
    btn.textContent = '連線中…';
    try {
      const ok = await net.connect(h, p);
      if (ok) panel.hidden = true;
      else showConnectError(store.get('conn.lastError') || '連線失敗（原因不明）');
    } catch (err) {
      showConnectError('連線時發生例外：' + (err?.message ?? err));
    } finally {
      btn.disabled = false;
      btn.textContent = '連線';
    }
  });

  store.sub('conn.state', (s) => {
    // 連線失敗或使用者主動斷線時把連線面板叫回來
    if (s === 'FAILED' || s === 'IDLE') {
      panel.hidden = false;
      const e = store.get('conn.lastError');
      if (e) showConnectError(e);
    }
  });

  document.getElementById('disconnect-btn').addEventListener('click', () => net.close());

  // ── 登出／切換帳號 ──
  // 先前沒有這個，一旦勾了「記住」就再也回不到登入畫面，也看不出自己是誰。
  const logoutBtn = document.getElementById('logout-btn');
  logoutBtn?.addEventListener('click', async () => {
    savePrefs({ rememberAccount: false, accountId: '', accountPw: '' });
    login.id = '';
    login.password = '';
    login.stage = 'idle';
    login.failures = 0;
    closeCharModal();
    await net.close();          // 斷線，回到乾淨狀態
    store.reset();              // 清掉上一個角色的房間／訊息／面板
    updateWhoLabel();
    openLoginModal();
    // 重新連線，讓伺服器再送一次版本挑戰
    setTimeout(() => btn.click(), 200);
  });

  // ── 啟動時自動連線 ──
  // 除了是 MUD 客戶端的常見行為，這也讓整條「UI → IPC → Rust → TCP」鏈路
  // 可以從伺服器端被觀測驗證（netstat 看得到 ESTABLISHED），
  // 不必依賴人工點擊才能確認客戶端到底有沒有真的連出去。
  const auto = document.getElementById('autoconnect-check');
  if (auto) {
    auto.checked = prefs.autoConnect !== false;
    auto.addEventListener('change', () => savePrefs({ autoConnect: auto.checked }));
    // WASM 模式沒有位址／埠號，但一樣可以「選好就自動進去」。
    if (auto.checked && ((host.value && port.value) || globalThis.__ZJMUD_WASM__)) {
      setTimeout(() => btn.click(), 300);
    }
  }
}


/**
 * 全域錯誤攔截：把未捕捉的例外顯示出來。
 * 沒有這個的話，前端一旦拋錯就只是靜默失效 —— 正是「按連線沒反應」當時的情況。
 */
function installErrorSurface() {
  const report = (msg) => {
    try { showConnectError(String(msg)); } catch { /* 面板尚未就緒 */ }
    console.error('[uncaught]', msg);
  };
  globalThis.addEventListener?.('error', (e) => report(e?.message ?? e?.error ?? e));
  globalThis.addEventListener?.('unhandledrejection', (e) => report(e?.reason?.message ?? e?.reason));
}

installErrorSurface();
document.addEventListener('DOMContentLoaded', mount);

// 開發時方便在 devtools 直接戳
globalThis.__zjmud = { store, net, sendCommand, applyEvent, decodeLine, parseDialog, SEP };
