// 假 ZJMUD 伺服器 —— 開發與驗收用。
//
// 用途：不需要真實伺服器就能開發 UI，而且可以重現畸形輸入。
// 它會播放一段涵蓋「全部 opcode」的腳本，並對常見指令做出反應。
//
// 執行：node tools/fake-server.mjs [port]
// 預設 port 6666，與 800100 容器的 MUD telnet 埠一致。

import net from 'node:net';

const PORT = Number(process.argv[2]) || 6666;
const E = '\u001b';

/** 開場腳本：每一項是 [延遲毫秒, 要送出的行]。 */
const INTRO = [
  [0,    `${E}[2;37;0m${E}015${E}[1;33m歡迎來到假伺服器 —— 這是給 Web 客戶端測試用的。${E}[0m`],
  [120,  `${E}002${E}[1;33m客棧大廳${E}[0m`],
  [60,   `${E}004${E}[37m這是一間寬敞的客棧大廳，幾張八仙桌散落其間，空氣裡飄著酒香。${E}[0m`],
  [60,   `${E}003north:北面大門$zj#east:東廂$zj#out:出去:out$zj#up:上樓:up`],
  [60,   `${E}005${E}[1;32m店小二${E}[0m:look xiaoer$zj#${E}[1;36m王掌櫃${E}[0m:look zhanggui$zj#${E}[37m酒罈${E}[0m:look jar`],
  [60,   `${E}021查看:look$zj#休息:rest$zj#打坐:dazuo`],
  // 依伺服器 cmds/usr/hp1.c 的真實形態：ZJMENUF(6,6,25,40)、標籤含全形冒號、8 位 ARGB 色碼
  [60,   `${E}012$4,4,25,40#我：張三:100/100:#333333║氣血.180:180/190/200:#99FF0000:hp║內力.95:95/120/150:#990066FF:hp║忙亂.0:0/1:#BB3F51B5`],
  [60,   `${E}006b1:查看$br#屬性:score$zj#b2:隨身$br#物品:i$zj#b3:查看$br#技能:skills$zj#bs::look here`],
  [60,   `${E}022look xiaoer$zj#70:85:100`],
  [200,  `${E}100${E}[1;35m【世界】某某：有人打boss嗎？${E}[0m`],
  [300,  `${E}100${E}[1;36m【門派】某乙：+1${E}[0m`],
  [400,  `你環顧四周，覺得這裡頗為熱鬧。`],
  [200,  `試試點擊左邊的人物，或輸入 ${E}[u:cmds:help]help${E}[0m 看看有哪些測試指令。`],
];

/** 指令 → 回應腳本。 */
const RESPONSES = {
  help: [
    [0, `${E}013可用的測試指令：$br#$br#` +
        `  look xiaoer  → 互動面板（ESC007 + ESC008/009）$br#` +
        `  menu         → NPC 對話框（ESC010，含數量輸入）$br#` +
        `  pop          → 彈出選單（ESC020）$br#` +
        `  fight        → 戰鬥訊息 + 傷害飄字（ESC016 / ESC024）$br#` +
        `  map          → 地圖疊層（ESC011）$br#` +
        `  colors       → 全部色彩測試$br#` +
        `  prompt       → 文字輸入面板（ESC001，$txt# 樣板）$br#` +
        `  prompt2      → 同上，接數字$br#` +
        `  hideDesc     → 屏蔽房間描述（ESC023）$br#` +
        `  malformed    → 故意送畸形封包，測試降級處理$br#` +
        `  north/east/… → 移動`],
  ],
  'look xiaoer': [
    [0,  `${E}007${E}[37m店小二穿著一身粗布衣裳，肩上搭著條白毛巾。$br#他正忙進忙出地招呼客人。${E}[0m`],
    [40, `${E}008$2,3,9,30#打招呼:greet xiaoer$zj#點菜|10兩:menu$txt#$zj#切磋:fight xiaoer$zj#離開:leave`],
    [40, `${E}009$1,3,9,30#查看物品:li xiaoer$zj#更多…:${E}020買酒|buy wine$z2#賣酒|sell wine$z2#算了|say 算了`],
  ],
  'look zhanggui': [
    [0,  `${E}007${E}[1;36m王掌櫃${E}[0m${E}[37m捻著鬍鬚，笑瞇瞇地看著你。${E}[0m`],
    [40, `${E}008$2,3,9,30#打聽消息:ask zhanggui$zj#住店:rent`],
  ],
  menu: [
    [0, `${E}010店小二問道：「客官要幾壺女兒紅？」$br#$god#你身上有 320 兩銀子$dh#numb.$dh#ok11.buy $N wine$dh#no11.say 算了`],
  ],
  pop: [
    [0, `${E}020$2,2,8,25#買酒|buy wine$z2#賣酒|sell wine$z2#打聽|ask news$z2#離開|leave`],
  ],
  prompt: [
    // 伺服器巨集 INPUTTXT(question, template)，template 一律用 $txt# 佔位（非 $N）
    [0, `${E}001${E}[37m請輸入想設定的【中文名字 英文名字】：${E}[0m$zj#name $txt#`],
  ],
  prompt2: [
    [0, `${E}001${E}[37m你要存入多少銀兩？${E}[0m$zj#deposit $txt#`],
  ],
  fight: [
    [0,   `${E}016${E}[1;31m你一劍刺出，正中店小二胸口！${E}[0m`],
    [120, `${E}024-37`],
    [300, `${E}016${E}[1;33m店小二反手一掌，你只覺胸口一悶。${E}[0m`],
    [120, `${E}024-12`],
    [300, `${E}022look xiaoer$zj#40:55:100`],
    [900, `${E}016${E}[1;32m店小二求饒道：「好漢饒命！」${E}[0m`],
    [600, `${E}017`],
  ],
  map: [
    [0, `${E}011      ${E}[1;33m[客棧]${E}[0m$br#         |$br#  ${E}[37m[market]${E}[0m--${E}[1;32m[你]${E}[0m--${E}[37m[東廂]${E}[0m$br#         |$br#      ${E}[37m[街道]${E}[0m`],
  ],
  colors: [
    [0,  `${E}[30m黑${E}[31m紅${E}[32m綠${E}[33m黃${E}[34m藍${E}[35m紫${E}[36m青${E}[37m白${E}[0m ← 一般前景`],
    [30, `${E}[1;30m黑${E}[1;31m紅${E}[1;32m綠${E}[1;33m黃${E}[1;34m藍${E}[1;35m紫${E}[1;36m青${E}[1;37m白${E}[0m ← 高亮前景`],
    [30, `${E}[41m紅底${E}[42m綠底${E}[43m黃底${E}[44m藍底${E}[0m ← 背景`],
    [30, `${E}[f#ff8800m自訂橙${E}[0m ${E}[b#334455m自訂底${E}[0m ${E}[1m粗體${E}[0m`],
    [30, `${E}[s:18]放大字${E}[0m ${E}[9m全形ABC123${E}[0m`],
    [30, `連結：${E}[u:cmds:look xiaoer]點我看店小二${E}[0m ／ ${E}[u:pops:甲|say 甲$z2#乙|say 乙]點我開選單${E}[0m`],
  ],
  hidedesc: [[0, `${E}023屏蔽描述`]],
  showdesc: [[0, `${E}023顯示`]],
  malformed: [
    [0,  `${E}012壞掉的:::::`],
    [30, `${E}003$zj#$zj#`],
    [30, `${E}022沒有分隔符`],
    [30, `${E}555這是未知的 opcode，應該原樣顯示在主訊息區`],
    [30, `${E}[999m無法辨識的樣式碼，文字仍應出現`],
    [30, `${E}015${E}[1;32m畸形測試完成 —— 客戶端沒有崩潰就是通過。${E}[0m`],
  ],
};

/** 移動：換房間，驗證 ESC002 的清空副作用。 */
const ROOMS = {
  north: ['大街', '寬闊的青石大街向南北延伸，行人熙攘。', 'south:南回客棧$zj#north:繼續向北'],
  east:  ['東廂房', '陳設簡單的廂房，靠窗擺著一張木榻。', 'west:回大廳'],
  up:    ['二樓迴廊', '迴廊上掛著幾盞燈籠。', 'down:下樓'],
  out:   ['客棧門口', '客棧的招牌在風中吱呀作響。', 'enter:進客棧:enter'],
  south: ['客棧大廳', '這是一間寬敞的客棧大廳，幾張八仙桌散落其間。', 'north:北面大門$zj#east:東廂$zj#out:出去:out'],
  west:  ['客棧大廳', '這是一間寬敞的客棧大廳，幾張八仙桌散落其間。', 'north:北面大門$zj#east:東廂$zj#out:出去:out'],
  down:  ['客棧大廳', '這是一間寬敞的客棧大廳，幾張八仙桌散落其間。', 'north:北面大門$zj#east:東廂$zj#out:出去:out'],
  enter: ['客棧大廳', '這是一間寬敞的客棧大廳，幾張八仙桌散落其間。', 'north:北面大門$zj#east:東廂$zj#out:出去:out'],
};

const server = net.createServer((socket) => {
  const who = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[+] 連線 ${who}`);
  socket.setEncoding('utf8');

  const send = (line) => { if (!socket.destroyed) socket.write(line + '\n'); };
  const play = (script) => {
    let t = 0;
    for (const [delay, line] of script) {
      t += delay;
      setTimeout(() => send(line), t);
    }
  };

  play(INTRO);

  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const cmd = buf.slice(0, i).replace(/\r$/, '').trim();
      buf = buf.slice(i + 1);
      if (!cmd) continue;
      console.log(`[>] ${who} ${JSON.stringify(cmd)}`);
      handle(cmd, send, play);
    }
  });

  socket.on('close', () => console.log(`[-] 離線 ${who}`));
  socket.on('error', (e) => console.log(`[!] ${who} ${e.message}`));
});

function handle(cmd, send, play) {
  const key = cmd.toLowerCase();

  if (RESPONSES[cmd]) return play(RESPONSES[cmd]);
  if (RESPONSES[key]) return play(RESPONSES[key]);

  if (ROOMS[key]) {
    const [title, desc, exits] = ROOMS[key];
    play([
      [0,  `${E}002${E}[1;33m${title}${E}[0m`],
      [40, `${E}004${E}[37m${desc}${E}[0m`],
      [40, `${E}003${exits}`],
      [40, `${E}012$2,0,22,35#氣血:180/190/200:#c94f4f:hp║內力:95/120/120:#4f7fc9:hp`],
    ]);
    return;
  }

  if (key === 'l' || key === 'look') {
    return play(INTRO.slice(1, 7));
  }
  if (key.startsWith('buy ')) {
    return send(`${E}015${E}[1;32m你買了 ${cmd.split(' ')[1]} 份東西。${E}[0m`);
  }
  if (key === 'score' || key === 'i' || key === 'skills') {
    return send(`${E}013${E}[1;33m【${cmd}】${E}[0m$br#（假伺服器不提供真實資料）$br#$br#這是分頁長文本的示範。`);
  }
  if (key === 'quit') {
    send(`${E}015再會。`);
    return;
  }
  send(`${E}[37m假伺服器不認得指令「${cmd}」。輸入 ${E}[u:cmds:help]help${E}[0m${E}[37m 看可用指令。${E}[0m`);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`假 ZJMUD 伺服器已啟動：127.0.0.1:${PORT}`);
  console.log('在客戶端的連線面板填入這個位址即可測試。');
});
