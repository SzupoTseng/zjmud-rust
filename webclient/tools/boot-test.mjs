#!/usr/bin/env node
// 單一 mudlib 的 WASM 開機檢驗 —— 打包管線的品質閘門。
//
// 【WHY】收藏裡每個 mudlib 各有各的死法：WASM build 關掉了
// sockets/db/external/ffi/pcre/crypto/async/compress，任何用到那些 efun 的
// 檔案會在載入時編譯失敗；GBK 這種表格式字集會直接 raise error。
// 人工一個個試不可行，而且結論會過期。
//
// 【推理】判準必須是「真的開一次機、真的撥一條連線、看它吐什麼」，
// 而不是靜態掃描——靜態掃描只能當預篩，它分不出「死在 preload」與
// 「載入失敗但 driver 活著」。前者不能上架，後者只是功能殘缺。
//
// 【證據】LPMud-Name 實測：kuafu/qqd/miraid 三個 preload daemon 因
// `Undefined function socket_create` 載入失敗（socket_create/bind/write/close
// 共 13 處），但 driver 照常完成開機並送出
// `ver1.0:byz0rmpISExtQ` 握手行 —— 這正是「limited 而非 noboot」的定義。
//
// 用法：node tools/boot-test.mjs <mudlib-dir> [--config config.ini] [--json]

import path from 'node:path';
import { bootMud, summarizeLog, waitFor, driverAvailable, DRIVER_DIR } from './wasm-node.mjs';
import { isChallenge, parseLine, LOGIN, buildLoginLine, buildCharLine } from '../src/js/protocol.js';
import { detectDialect } from '../src/js/dialects.js';
import { createTelnetLogin } from '../src/js/telnetlogin.js';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * 開機 → 撥號 → 握手 → 登入，回報這個 mudlib 在 wasm 上的健康度。
 *
 * @returns {Promise<object>} 一份可直接寫進 site index 的結論
 */
export async function bootTest({
  lib,
  image,
  config = 'config.ini',
  // 【WHY 帳號不含數字】ES2 一系的 `check_legal_id()` 逐字檢查
  // `id[i] < 'a' || id[i] > 'z'`，含數字的帳號一律回狀態碼 0001。
  // 閘門用一個**各家都收得下**的帳號，才不會把「這台其實可以玩」
  // 誤判成登入失敗。產品端另有處理（原生登入會把數字映射成字母）。
  // 【WHY 不能叫 …test…】西游记2003 的 `check_legal_id()` 有一張禁用子字串表，
  // `test` 在裡面（連同 quit/kill/save/who/skill…那些指令名）。
  // 帳號含 `test` 一律回「类似含有 test 这样的英文字符被系统禁止注册」→ 狀態碼 0001，
  // 而報告只寫「ID 不合法」，看不出是**閘門自己挑的名字**踩到禁字。
  // `qingfeng` 3-8 個小寫字母、不含任何常見禁用指令名。
  account = 'qingfeng',
  password = 'qingfeng',
  // ★ 用**兩個字**的名字，不要用四個字。
  //
  // 【WHY】原本用「令狐一郎」，17 台全過；使用者一打兩三個字的名字就被擋
  // （「你的中文姓名不能太长或太短」）。真因是 check_legal_name 數的是 GBK
  // 位元組（`i < 4 || i > 8 || i%2`），轉 UTF-8 後只有**剛好四個字**的名字能通過——
  // 而那正好是測試資料。測試資料的巧合把一個 15/17 台都有的 bug 藏了起來。
  //
  // 【推理】所以測試要用**最容易踩到的合法輸入**，不是最容易過的那一個。
  // 兩個字是這些 mudlib 自己宣告的下限（「2 到 4 個中文字」），
  // 用它才驗得到界限本身。
  charName = '無名',   // 可用 --name 覆寫；簡繁都要能過
  bootWaitMs = 30000,
  challengeWaitMs = 15000,   // 等版本挑戰的上限；逾時就當作「這台不送挑戰」
  quiet = true,
  keepLog = false,   // sweep-logs.mjs 要原始 driver log 來抓例外
  // 【WHY】原本只留 sample（前 40 行），而 opcode 的**內容**都在後面——
  // 診斷「002 有出但 003 沒出」時，你要看的是房間標題到底是哪一間，
  // sample 完全看不到。少了這個能力，只能靠猜（實測在 nitan170911 上
  // 白繞了好幾圈）。SOP §B1-b 的逐 opcode 對照需要它。
  keepTranscript = false,
  protocol = 'zjmud',        // 'telnet' = 非 zjmud lib，走登入接應器
  loginProfile = 'generic-cn',
} = {}) {
  const lines = [];
  const t0 = Date.now();
  let challenge = null;
  let dialect = null;
  let closed = null;
  let stage = 'wait-challenge';   // wait-challenge → authing → creating → in-world
  let status = null;
  let idRetried = false;              // 最後一個 ESC000 狀態碼

  // ★ telnet 接應器要在 **bootMud 之前**建好，並直接接進 onLine。
  // 【WHY】原本是在 driver.connect() 之後才用 monkeypatch 把它掛上去——
  // 而開場招牌與第一個提問（「您的英文名字：」）早就在那之前送完了。
  // 接應器等於錯過開頭，之後每一步都對不上，報告寫「登入未走完（17 行）」，
  // 但同一台用 dbg 腳本（一開始就接線）跑起來面板全出來。
  // **接線時機不對，會讓好的東西看起來是壞的。**
  let tn = null;
  let tnDone = false;
  let tnStalled = null;
  const tnFeed = (line) => { if (tn) { try { tn.feed(line); } catch { /* 接應器不該炸掉測試 */ } } };

  const { driver, log, stats, rc } = await bootMud({
    lib,
    image,
    config,
    promptFlush: protocol === 'telnet',   // 沖洗只給 telnet：zjmud 台會把挑戰行切碎（實錄回歸）
    onLine: (line) => {
      lines.push(line);

      if (protocol === 'telnet') { tnFeed(line); return; }

      // telnet 模式：zjmud 的自動應答（挑戰回覆、0007→look）**全部不跑**。
      // 【WHY】nt7 實測：zjmud 分支看到 ESC000 0007 就排程送 look，
      // 而此刻 telnet 登入還在問名字——look 被當成英文名字打回票，
      // 兩條狀態機互相踩，輸出全亂。一台一次只能有一個登入代理。
      // ① 版本挑戰 → 決定方言 → 版本回覆與帳號行一次送完
      //   （與 main.js doAutoLogin 同序：不給伺服器逾時的機會）
      if (challenge === null && isChallenge(line)) {
        challenge = line;
        dialect = detectDialect(line);
        stage = 'authing';
        driver.send(LOGIN.ANY);
        driver.send(buildLoginLine({ id: account, password, email: '' }));
        return;
      }

      // ② ESC000 帶三位狀態碼：0007 登入成功 / 0008 需建角 / 0009 名字不合
      const { op, payload } = parseLine(line);
      if (op === '000') {
        const code = String(payload).trim().slice(0, 4);
        status = code;
        // ★ 帳號被拒（0001）時換一個名字再試。
        //
        // 【WHY】各家的 check_legal_id 有各自的禁用清單，而且理由五花八門：
        // 西游记2003 禁 `test`（指令名），月影奇缘 連 `qingfeng` 都擋
        // （「这种英文名字会造成其他人的困扰」）。閘門用固定帳號，
        // 撞到哪一台的清單就報「ID 不合法」——而那是**閘門自己挑的名字**
        // 踩到禁字，不是這台不能玩。
        // 【WHY 不在產品端修】使用者選到禁用名字時，伺服器會把理由印出來，
        // 客戶端照實顯示就是正確行為。要退讓的是測試帳號，不是產品。
        if (code === '0001' && stage === 'authing' && !idRetried) {
          idRetried = true;
          const alt = ['wanyou', 'zjkeai', 'lvxing'][0];
          setTimeout(() => driver.send(buildLoginLine({ id: alt, password: alt, email: '' })), 400);
        } else if (code === LOGIN.NEED_CHAR && stage === 'authing') {
          stage = 'creating';
          driver.send(buildCharLine({ name: charName, fields: dialect === 'zymud' ? 2 : 3 }));
        } else if (code === LOGIN.OK) {
          stage = 'in-world';
          // 進世界後主動看一眼，逼伺服器送出房間／狀態列那組 opcode。
          //
          // 【WHY 要送三次、而且要間隔開】只送一次（+500ms）會同時撞上兩件事：
          //   ① 有些家族的 enter_world 自己還要幾拍才把人物移進起始房間，
          //      太早送的 look 落在「還沒進場」的空窗，什麼都沒有。
          //   ② 风云Ⅱ 系進世界後還掛著一個 `请敲回车键［ＲＥＴＵＲＮ］` 的
          //      input_to——面板 opcode 全被「[输入时暂存讯息]」緩衝住，
          //      而我們那一次 look 剛好**被當成那個 RETURN 的答案**吃掉了。
          // 分三拍送就同時解決：第一拍可能被吃，第二、三拍才是真的 look。
          //
          // ★ 但**次數不可以是固定的**——那等於在量機器速度。
          // 【WHY】原本固定送 500/2500/5000/9000ms 四拍，然後等 002 最多 18 秒。
          // 江湖論劍（lpmudname）在本機 7.3 秒就收滿 9 種 opcode 判 playable，
          // 在 CI 上卻連 002 都沒到（線上索引寫著「只收到 000 006 021」）——
          // 006/021 有到代表輸出是通的，是那四拍**全部落在世界就緒之前**，
          // 而第四拍之後就再也沒有人敲門了。同一台在兩台機器上結論相反，
          // 那不是這台不穩，是尺規綁在時鐘上（CLAUDE.md §21 記過同一個形狀）。
          // 【判準】改成「敲到門開為止」：每 2.5 秒送一次 look，直到 002 出現
          // 或超過 30 秒。快的台第一拍就拿到 002，之後一次都不會多送——
          // 這個改動只可能讓慢的台從 limited 變 playable，不可能反過來。
          setTimeout(() => driver.send('look'), 500);
          const knock = setInterval(() => {
            if (lines.some((l) => parseLine(l).op === '002')) { clearInterval(knock); return; }
            driver.send('look');
          }, 2500);
          setTimeout(() => clearInterval(knock), 30000);
        }
      }
    },
    onClosed: (reason) => { closed = reason; },
  });

  const result = {
    lib: path.basename(lib || image),
    config,
    bootRc: rc,
    files: stats.files,
    megabytes: +(stats.bytes / 1e6).toFixed(1),
    booted: rc === 0,
    handshake: null,
    dialect: null,
    opcodes: [],
    lines: 0,
    closed: null,
    ...summarizeLog(log),
  };

  if (rc !== 0) {
    result.badge = 'noboot';
    result.reason = `fluffos_boot 回傳 ${rc}`;
    return result;
  }

  // 撥號本身也可能失敗（master::connect() 回 0 → driver 回 -1）。
  // 不接住的話整個批次測試會在這裡整支掛掉，而它其實只是「這個 lib 不能玩」。
  try {
    driver.connect();
  } catch (e) {
    driver.shutdown();
    result.badge = 'noboot';
    result.reason = `撥號失敗：${e?.message ?? e}`;
    result.lines = lines.length;
    return result;
  }

  // ── telnet 模式：非 zjmud lib，用登入接應器按提示代答 ──
  // 判準與 zjmud 模式同義：接應器判定「不再被問問題」＝進世界，
  // 之後 look 有輸出就是 playable。沒有 opcode 可數（它本來就不講 zjmud）。
  if (protocol === 'telnet') {
    tn = createTelnetLogin({
      profile: loginProfile,
      creds: { id: account, pw: password, name: charName, gender: 'm' },
      send: (l) => driver.send(l),
      onDone: () => { tnDone = true; },
      onStalled: (step, n) => { tnStalled = `卡在「${step}」重複 ${n} 次`; },
    });
    const before = lines.length;
    // 踢一腳**只在真的需要時**。
    // 【WHY】無條件送空行會被伺服器當成「第一題的答案」，整個對話錯開一格——
    // 炎黃英雄史實測：名字被當成 (y/n) 的回答，走進「好吧，请重新输入」的
    // 死循環，看起來像規則不對，其實是我們自己多送了一行。
    // 只有等了幾秒仍然一句提示都沒收到（招牌在我們接線前就送完了）才踢。
    await new Promise((r) => setTimeout(r, 2500));
    if (tn.sentCount === 0) driver.send('');
    try {
      await waitFor(() => tnDone, { timeoutMs: Math.max(bootWaitMs, 60000) });
      // ★★ 進世界 ≠ 可以玩。
      //
      // 【WHY】泥潭系實測：登入走完後玩家被丟進 `/d/register/regroom`
      // ——沒有出口、沒有物件，要先 `reg <email>` 才移得出去；出去之後
      // 又是「生命之谷」，要 choose 性格再 born 投胎。北美侠客行 則是
      // `set("exits", ([ ]))` ＋ `add_action("block_cmd", "", 1)` 的腳本開場，
      // 所有指令被擋住，要等 NPC 演完。兩台都收得到 002/004/005/006/012/021，
      // 閘門照樣判 playable——**玩家其實一步都走不了**。
      //
      // 【推理】「收到 opcode」只證明轉換層會翻譯，不證明世界可玩。
      // 可玩的定義就是**走得動**：有出口、送出方向、房間標題真的變了。
      // 這是可以直接觀察的事實，不是啟發式。
      //
      // 接應器的 POST_RULES 要幾個來回才解得完新手關卡，先給它時間安靜下來。
      // 【WHY 要等這麼久、而且要連續安靜好幾輪】新手關卡的 NPC 是靠
      // `call_out` 一段一段演的：北美的 `check_follow` 是 +5 秒、再 +10 秒，
      // 木老五 的登記說明更在那之後。只要「兩秒沒有新輸出就當穩定」，
      // 就會在 NPC 兩句話中間的空檔收工——實測停在「侠客岛挂名处」，
      // 而登記指令根本還沒印出來。要連續 3 輪（6 秒）安靜才算真的停了。
      const settleUntil = Date.now() + 40000;
      let lastCount = -1;
      let calm = 0;
      while (Date.now() < settleUntil) {
        if (lines.length === lastCount) { calm += 1; if (calm >= 3) break; } else { calm = 0; }
        lastCount = lines.length;
        await new Promise((r) => setTimeout(r, 2000));
      }
      // ★★ 第六種新手關卡：**登記完發新密碼、要求重連**。
      //
      // 【WHY】北美侠客行 的 `register <email>` 成功之後，伺服器回
      //   「您的新密码是osoni」「请用新的密码连线：）」
      // ——世界只在**第二次登入**時才到得了。第一條連線就到此為止，
      // 不重連的話永遠停在「侠客岛挂名处」，而那間房沒有出口，
      // 看起來就像「這台轉換失敗」。真相是流程還沒走完。
      //
      // 【推理】密碼要**原樣**送回去（keepPw），不能套用開新帳號的補強規則——
      // `osoni` 被補成 `osoniZ9` 就登不進去，而畫面只會說密碼不對。
      //
      // 【證據】`d/xiakedao/npc/mux.lpc` do_register()：產生亂數密碼後
      // `ob->set("password", …)` 並斷線；`d/xiakedao/register.lpc` 的
      // block_cmd 只放行 quit/goto/suicide/register/tell/say/reply/look。
      const strip = (l) => String(l).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      let issuedPw = null;
      for (let i = lines.length - 1; i >= 0 && !issuedPw; i -= 1) {
        const m = /新密[码碼][是為为]?\s*[:：]?\s*([A-Za-z0-9]{3,20})/.exec(strip(lines[i]));
        if (m) issuedPw = m[1];
      }
      if (issuedPw) {
        result.reconnected = issuedPw;
        try { driver.disconnect(); } catch { /* 可能已經被伺服器斷了 */ }
        await new Promise((r) => setTimeout(r, 1500));
        driver.connect();
        tnDone = false;
        tn = createTelnetLogin({
          profile: loginProfile,
          creds: { id: account, pw: issuedPw, name: charName, gender: 'm' },
          keepPw: true,
          send: (l) => driver.send(l),
          onDone: () => { tnDone = true; },
          onStalled: (step, n) => { tnStalled = `重連後卡在「${step}」重複 ${n} 次`; },
        });
        try {
          await waitFor(() => tnDone, { timeoutMs: 60000 });
        } catch { /* 重連沒走完，照樣往下量 */ }
        // 重連之後同樣可能還有關卡（例如再一次的引路），一樣等它安靜
        let c2 = 0; let last2 = -1;
        const until2 = Date.now() + 30000;
        while (Date.now() < until2) {
          if (lines.length === last2) { c2 += 1; if (c2 >= 3) break; } else { c2 = 0; }
          last2 = lines.length;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      driver.send('look');
      await new Promise((r) => setTimeout(r, 3000));

      // ── 指令探針：世界到底收不收玩家的話 ──────────────
      //
      // 【WHY】這一格是 boot-test 長期的盲點。房間面板（002/003/004/005）是
      // **伺服器主動送的**——`zj_first_look` 在進世界時就會畫一次。
      // 所以即使角色連一個指令都下不了，opcode 照樣收滿、照樣被判 playable。
      // 【證據】sjecl：boot-test 判 playable、搜尋路徑完整、面板齊全，
      // 而真瀏覽器裡 `look` 與 `hp` 都回「什麼？」——玩家一個指令都下不了。
      // 這正是 CLAUDE.md §11：收到訊號 ≠ 事情發生。
      // 【判準】送一個**每台都該有**的指令（look），看回話是不是
      // 「指令不存在」的那句。是的話代表 add_action／指令搜尋路徑沒接上，
      // 整個世界對玩家是唯讀的——那不叫可玩。
      // 【WHY 貼著整句比對】含「什麼」二字的句子多半是遊戲內容
      // （「还没有出生呐，察看什么？」是世界拒絕，不是指令不存在），
      // 混為一談會讓結論指向錯的地方（見 spec §D23）。
      {
        const before = lines.length;
        driver.send('look');
        await new Promise((r) => setTimeout(r, 3000));
        const fresh = lines.slice(before)
          .map((l) => parseLine(l).payload ?? '')
          .join('\n')
          .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
          .replace(/^[\s>]+/, '')
          .trim();
        result.acceptsCommands = !/^(什麼|什么)\s*[？?]/.test(fresh);
        if (!result.acceptsCommands) result.commandReply = fresh.slice(0, 80);
      }

      // ── 移動探針 ────────────────────────────────────
      const lastOp = (want) => {
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const { op, payload } = parseLine(lines[i]);
          if (op === want) return payload.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
        }
        return null;
      };
      const roomTitle = () => lastOp('002');
      // ★ 「有沒有移動」不能只比房間**標題**。
      //
      // 【WHY】北美侠客行 的海岸線上連續好幾間房間**全叫「沙滩」**。
      // 實測玩家確實一路走過去（出口從 east/west 變成 west/northeast、
      // 海龜從「小海龟」換成「海龟」），但標題一字不變，
      // 於是閘門判「移動被擋住」——把一台完全正常的台判成 limited。
      // 同名房間在中文 MUD 極常見（沙滩／小路／山道／甬道往往連成一串）。
      //
      // 【推理】房間的身分要用**它送出來的整組面板**當指紋：
      // 標題＋出口清單＋房內物件。三者只要有一項變了就是換了房間。
      const roomPrint = () => `${lastOp('002') ?? ''}|${lastOp('003') ?? ''}|${lastOp('005') ?? ''}`;
      const exitDirs = () => {
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const { op, payload } = parseLine(lines[i]);
          // ESC003 格式：`dir:標籤:指令$zj#…`，第一段就是方向
          if (op === '003') return payload.split('$zj#').map((r) => r.split(':')[0]).filter(Boolean);
        }
        return [];
      };
      // ★ 要**重試**，不能只試一次。
      //
      // 【WHY】腳本化開場是有節奏的：北美侠客行 的引路人在 +5 秒問一次、
      // +15 秒才硬把人拖走，這段期間 `block_cmd` 擋掉所有移動。
      // 只探一次就等於在演到一半的時候下結論——實測第一次必失敗，
      // 而失敗原因（「還在演」）和真正的失敗（「這台就是走不了」）
      // 從單次結果完全分不出來。
      //
      // 【推理】重試三輪、每輪間隔 8 秒（涵蓋 NPC 的 5／10 秒 call_out），
      // 每輪都**重新讀一次出口**——因為房間可能已經被腳本換掉了。
      result.moved = false;
      for (let attempt = 0; attempt < 3 && !result.moved; attempt += 1) {
        if (attempt) {
          await new Promise((r) => setTimeout(r, 8000));
          driver.send('look');
          await new Promise((r) => setTimeout(r, 2000));
        }
        const from = roomPrint();
        const dirs = exitDirs();
        result.finalRoom = roomTitle();
        result.exits = dirs;
        if (!dirs.length) continue;   // 沒有出口就無從走起，等下一輪
        // ★ 每個出口都要試，不能只試第一個。
        //
        // 【WHY】金庸群侠传系的新手起點是「客店」，出口是 `up` 和 `west`。
        // `up` 被店小二擋著——「店小二一下挡在楼梯前，白眼一翻：怎麽着，
        // 想白住啊！」（沒付房錢），但 `west` 完全走得通。
        // 只試 `dirs[0]` 就把 6 台正常的台判成「移動被擋住」——
        // **是探針只敲了一扇上鎖的門，不是屋子沒有出路**。
        //
        // 【推理】MUD 裡「某個出口有條件」是常態（收費、任務、等級、劇情），
        // 判準要問的是「有沒有任何一條路走得通」，不是「第一條路通不通」。
        for (const d of dirs.slice(0, 5)) {
          driver.send(d);
          await new Promise((r) => setTimeout(r, 2000));
          driver.send('look');
          await new Promise((r) => setTimeout(r, 2000));
          if (roomPrint() !== from) {
            result.moved = true;
            result.movedTo = roomTitle();
            result.movedVia = d;
            break;
          }
        }
      }
    } catch { /* 沒走完，照樣統計 */ }
    driver.shutdown();
    {
      const ops = new Set();
      for (const l of lines) { const { op } = parseLine(l); if (op) ops.add(op); }
      result.opcodes = [...ops].sort();
    }
    result.handshake = '（telnet：無 zjmud 握手）';
    result.dialect = 'telnet';
    result.stage = tnDone ? 'in-world' : 'authing';
    result.lines = lines.length;
    result.closed = closed;
    result.elapsedMs = Date.now() - t0;
    if (tnDone && lines.length > before + 3 && result.moved) {
      result.badge = 'playable';
      result.reason = result.opcodes.length
        ? `走得動（${result.finalRoom} －${result.movedVia}→ ${result.movedTo}）；收到 ${result.opcodes.length} 種 opcode`
        : `走得動（${result.finalRoom} → ${result.movedTo}），但未轉換、無面板`;
    } else if (tnDone && lines.length > before + 3) {
      // 登入走完、面板也出來了，但**走不出去**——停在新手關卡。
      // 這種狀態以前被判 playable，是最危險的假綠燈：使用者點進去
      // 看到完整介面，然後發現一步都動不了。
      result.badge = 'limited';
      result.reason = result.exits?.length
        ? `停在「${result.finalRoom}」，${result.exits.length} 個出口（${result.exits.slice(0, 4).join('／')}）全試過都走不出去`
        : `停在「${result.finalRoom}」，這個房間沒有出口——新手關卡沒過（註冊／投胎／腳本開場）`;
    } else {
      result.badge = 'limited';
      result.reason = tnStalled
        ? `telnet 登入${tnStalled}——接應器主動停手（規則答不對，需要人工看提示）`
        : `telnet 登入未走完（${lines.length} 行）`;
    }
    if (!quiet) result.sample = lines.slice(0, 40);
    if (keepLog) result.rawLog = log;
    if (keepTranscript) result.transcript = lines;
    return result;
  }

  // 等握手行。**沒有握手行不代表壞掉**——大梦江湖的 logind.logon() 把
  // `write("ver1.0,"+str+"\n")` 整行註解掉了，而 jiance() 檢查的是 `str != ZJKEY`
  // （伺服器自己給的值），不是客戶端送來的 arg，所以它其實接受任何輸入。
  // 對這種伺服器，正確行為是「等一下沒等到就照樣送」，而不是判定失敗。
  try {
    await waitFor(() => challenge !== null, { timeoutMs: challengeWaitMs });
  } catch {
    if (lines.length === 0) {
      driver.shutdown();
      result.badge = 'noboot';
      result.reason = '撥號後完全沒有輸出';
      result.lines = 0;
      return result;
    }
    stage = 'authing';
    result.noChallenge = true;
    driver.send(LOGIN.ANY);
    driver.send(buildLoginLine({ id: account, password, email: '' }));
  }

  // 等到進世界（或放棄）。第一次登入要編譯 user 物件與一整串 daemon，
  // 實測 5-10 秒都算正常，所以這裡等的是**狀態**而不是固定秒數。
  try {
    await waitFor(() => stage === 'in-world', { timeoutMs: bootWaitMs });
    // ★ 等到**面板真的出現**，不是等一個固定秒數。
    //
    // 【WHY】原本固定等 3 秒，而進世界後排的 look 是 500/2500/5000/9000ms
    // ——後兩次根本還沒送出，閘門就 shutdown 了。**閘門的等待比它自己的
    // 重試排程還短**，於是慢一點的台永遠被判「登入成功但沒有面板」。
    // 實測 侠客英雄传3 手動 trace 看得到完整面板，閘門卻回報只有 000，
    // 兩次結論相反——那不是這台不穩，是尺規太短。
    //
    // 【推理】判準要綁在事實上：ESC002（房間標題）出現就代表畫面有東西了，
    // 立刻可以收工；沒出現就等滿 18 秒再說。快的台不會因此變慢
    // （第一個面板通常 1 秒內就到）。
    try {
      // 預算與上面的「敲到門開為止」對齊：那邊敲到 30 秒，這邊就要等得到 30 秒。
      // 兩個數字不一致的話，等待會先結束而最後幾拍 look 白敲了。
      await waitFor(() => lines.some((l) => parseLine(l).op === '002'), { timeoutMs: 32000 });
      await new Promise((r) => setTimeout(r, 1200));   // 讓同一批的其餘 opcode 到齊
    } catch {
      /* 等不到面板：照樣往下統計，讓報告說出「只收到 000」這個事實 */
    }

    // ── 指令探針：世界到底收不收玩家的話 ──────────────
    //
    // 【WHY】這是 boot-test 長期的盲點。房間面板（002/003/004/005）是
    // **伺服器主動送的**——`zj_first_look` 在進世界時就會畫一次。
    // 所以即使角色連一個指令都下不了，opcode 照樣收滿、照樣被判 playable。
    // 【證據】sjecl：boot-test 判 playable、面板齊全、搜尋路徑完整，
    // 而真瀏覽器裡 `look` 與 `hp` 都回「什麼？」——玩家一個指令都下不了。
    // 這正是 CLAUDE.md §11：收到訊號 ≠ 事情發生。
    // 【判準】送一個每台都該有的指令（look），看回話是不是「指令不存在」那句。
    // 【WHY 貼著整句比對】含「什麼」二字的句子多半是遊戲內容
    // （「还没有出生呐，察看什么？」是世界拒絕，不是指令不存在），
    // 混為一談會讓結論指向錯的地方（spec §D23）。
    try {
      const beforeN = lines.length;
      driver.send('look');
      await new Promise((r) => setTimeout(r, 3500));
      const fresh = lines.slice(beforeN)
        .map((l) => parseLine(l).payload ?? '')
        .join('\n')
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/^[\s>]+/, '')
        .trim();
      result.acceptsCommands = !/^(什麼|什么)\s*[？?]/.test(fresh);
      if (!result.acceptsCommands) result.commandReply = fresh.slice(0, 80);
    } catch { /* 探針失敗不該讓整個測試失敗 */ }
  } catch { /* 停在 authing/creating，下面照樣統計 */ }
  driver.shutdown();

  const ops = new Set();
  for (const l of lines) {
    const { op } = parseLine(l);
    if (op) ops.add(op);
  }

  result.handshake = challenge ?? '（此伺服器不送版本挑戰）';
  result.dialect = dialect;
  result.stage = stage;
  result.status = status;
  result.opcodes = [...ops].sort();
  result.lines = lines.length;
  result.closed = closed;
  result.elapsedMs = Date.now() - t0;

  // 分級與 mudlibs.fluffos.info 同義：
  //   playable = 註冊 + 建角 + 進世界整條走完，且真的收到協議 opcode
  //   limited  = 開得起來、講得出握手，但沒走完（多半是 mudlib 自己的登入流程差異）
  //   noboot   = 連握手都沒有
  if (stage === 'in-world' && ops.size > 0) {
    // ★ 「進世界」不等於「看得到東西」。
    //
    // 【WHY】實測有 4 台登入成功（狀態碼 0007）之後**一個面板 opcode 都沒有**——
    // 使用者看到的是一片空白，而閘門判 playable。這和本 session 花大半時間
    // 消滅的假綠燈是同一件事（CLAUDE.md §11：能不能玩要用行為驗，不能用訊號驗）。
    // ESC002（房間標題）是「畫面上真的有東西」的最低證據。
    if (!ops.has('002')) {
      result.badge = 'limited';
      result.reason = `登入成功但沒有任何面板（只收到 ${[...ops].join(' ') || '無'}）`
        + '——畫面會是空白的';
    } else if (result.acceptsCommands === false) {
      // ★ 面板齊全但**世界不收玩家的指令**——那不叫可玩。
      //
      // 【WHY】房間面板是伺服器在進世界時主動畫的，不是玩家下 look 換來的。
      // 所以「opcode 收滿」與「玩家下得了指令」是兩件事，而舊判準只看前者。
      // 實測 sjecl：判 playable、面板齊全，真瀏覽器裡 `look`／`hp` 全回「什麼？」。
      // 使用者點進去會看到一個漂亮但完全按不動的世界——比紅燈難受得多。
      // 【判準】誠實分級（CLAUDE.md §10）：跑不完就是 limited，
      // 而且把世界的原話寫進理由，讓下一個人不用重查一次。
      result.badge = 'limited';
      result.reason = `面板齊全但世界不收指令（送 look 回「${result.commandReply || '什麼？'}」）`
        + '——玩家一個指令都下不了';
    } else {
      result.badge = 'playable';
      result.reason = `註冊→建角→進世界完成，收到 ${ops.size} 種 opcode`;
    }
  } else if (ops.size > 0) {
    result.badge = 'limited';
    result.reason = `停在 ${stage}（最後狀態碼 ${status ?? '無'}），已收到 ${ops.size} 種 opcode`;
  } else {
    result.badge = 'limited';
    result.reason = `停在 ${stage}，沒有收到任何 opcode`;
  }
  if (!quiet) result.sample = lines.slice(0, 40);
  if (keepLog) result.rawLog = log;
  if (keepTranscript) result.transcript = lines;
  return result;
}

// ── CLI ────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const lib = process.argv[2];
  if (!lib) {
    console.error('用法：node tools/boot-test.mjs <mudlib-dir> [--config config.ini] [--json]');
    process.exit(2);
  }
  if (!driverAvailable()) {
    console.error(`找不到 driver（${DRIVER_DIR}）。先跑：node tools/fetch-driver.mjs`);
    process.exit(2);
  }
  const useImage = process.argv.includes('--image');
  // --image 模式順便讀旁邊的 mud.json：telnet lib 要走接應器
  let proto = {};
  try {
    const metaPath = path.join(path.resolve(lib), 'mud.json');
    const meta = JSON.parse((await import('node:fs')).readFileSync(metaPath, 'utf8'));
    if (meta.protocol) proto = { protocol: meta.protocol, loginProfile: meta.loginProfile };
    if (meta.config) proto.config = meta.config;
  } catch { /* 沒有 mud.json 就照舊 */ }
  const res = await bootTest({
    lib: useImage ? undefined : path.resolve(lib),
    image: useImage ? path.resolve(lib) : undefined,
    config: arg('config', 'config.ini'),
    charName: arg('name', undefined),
    quiet: !process.argv.includes('--verbose'),
    keepTranscript: process.argv.includes('--transcript'),
    ...proto,
  });
  if (process.argv.includes('--transcript') && !process.argv.includes('--json')) {
    // 把 opcode 逐條印出來：代號 ＋ 內容（控制碼轉可讀），這是對照時真正要看的
    for (const ln of res.transcript ?? []) {
      const m = /\x1b(\d{3})([\s\S]*)/.exec(ln);
      if (m) console.log(`  ESC${m[1]}  ${m[2].replace(/\u2551/g, ' ║ ').slice(0, 200)}`);
    }
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`\n=== ${res.lib} → ${res.badge.toUpperCase()} ===`);
    console.log(`  ${res.reason}`);
    console.log(`  檔案 ${res.files} / ${res.megabytes} MB，收到 ${res.lines} 行，耗時 ${res.elapsedMs ?? '-'} ms`);
    console.log(`  握手：${res.handshake ?? '（無）'}  方言：${res.dialect ?? '-'}`);
    console.log(`  opcode：${res.opcodes.join(' ') || '（無）'}`);
    if (res.loadFailures.length) console.log(`  載入失敗：${res.loadFailures.join(', ')}`);
    if (res.undefinedFuncs.length) console.log(`  缺少的 efun：${res.undefinedFuncs.join(', ')}`);
  }
  process.exit(res.badge === 'noboot' ? 1 : 0);
}
