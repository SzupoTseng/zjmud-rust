#!/usr/bin/env node
// telnet mudlib → zjmud：把房間與狀態轉成 zjmud 協議的面板。
//
// 【WHY】mudlibs-main 的 97 台 telnet lib 只用文字說話，我們的客戶端接上去
// 只是「一個比 xterm 差的文字框」——加值全在 GUI 面板（房間／出口／血條）。
// 而 GUI 需要**結構化資料**，那只有 mudlib 自己有。
//
// 【推理】轉換的單位不是「每一台 mud」，是**每個家族的一個 hook 點**：
// 一台 mud 的世界有幾萬個房間，但它們全部走同一支 `look`。實測 98 台的
// 檔案指紋，路徑佈局與狀態欄位命名完全相關，6 群覆蓋 90 台。
//
// 【證據】轉換範本不是發明的——`others/zjmud转zymud教程/look.c`（1,485 行）
// 就是轉換後的成品，它的做法是：
//     str = sprintf("\n"+ZJTITLE+"%s\n"+ZJLONG+"%s\n",
//                   env->short(), replace_string(env->long(),"\n",""));
// 本工具照同一個語意，但改成「注入一支 daemon ＋ 在 look 裡插一行呼叫」，
// 理由是**可逆、可重跑、單一 patch 點**——直接改 1,485 行的 look 無法跨 46 台重用。
//
// 用法：node tools/convert-to-zjmud.mjs <slug> --family es2-inherit [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_FORMAT } from '../src/js/mudlibimage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIBS = path.resolve(HERE, '..', '..', 'libs');
const ZJMUD_H_SRC = '/mnt/g/GameDevZ/700600_ZJMUD_ALL/others/zjmud.h';

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * 家族設定。每一群一組——這就是「轉換的單位是家族不是 mud」的具體形式。
 *
 * 指紋來自對 98 台的實測（詳見 docs/telnet_to_zjmud_SOP.md §A0）：
 * 路徑佈局與狀態欄位命名完全相關，所以一個 family 同時決定 hook 點與欄位名。
 */
export const FAMILIES = {
  'es2-inherit': {
    look: 'cmds/std/look.lpc',
    // 狀態欄位：侠客行／ES2 系。三條命脈 ＋ 經驗/潛能
    bars: [
      ['气血', 'qi', 'eff_qi', 'max_qi', '#c71417'],
      ['内力', 'neili', 'neili', 'max_neili', '#2b5eda'],
      ['精神', 'jing', 'eff_jing', 'max_jing', '#ac16a9'],
      ['食物', 'food', 'food', 'max_food', '#8a6d3b'],
      ['饮水', 'water', 'water', 'max_water', '#31708f'],
    ],
  },
  'gks-std': {
    look: 'cmds/std/look.lpc',
    // 金庸群侠传／東方故事系：gin（精）/ kee（氣）/ sen（神）
    bars: [
      ['气', 'kee', 'eff_kee', 'max_kee', '#c71417'],
      ['精', 'gin', 'eff_gin', 'max_gin', '#2b5eda'],
      ['神', 'sen', 'eff_sen', 'max_sen', '#ac16a9'],
      ['内力', 'force', 'force', 'max_force', '#2b8a3e'],
    ],
  },
  'gks-system': { look: 'cmds/verb/look.lpc', bars: null },   // bars 同 gks-std
  'gks-nested': { look: 'cmds/std/look.lpc', bars: null },
  'es1-body': {
    look: 'cmds/std/_look.lpc',
    bars: [
      ['生命', 'hp', 'hp', 'max_hp', '#c71417'],
      ['法力', 'mp', 'mp', 'max_mp', '#2b5eda'],
      ['體力', 'sp', 'sp', 'max_sp', '#2b8a3e'],
    ],
  },
  'hpmp-std': {
    look: 'cmds/std/look.lpc',
    bars: [
      ['生命', 'hp', 'hp', 'max_hp', '#c71417'],
      ['體力', 'sp', 'sp', 'max_sp', '#2b8a3e'],
    ],
  },
};
FAMILIES['gks-system'].bars = FAMILIES['gks-std'].bars;
FAMILIES['gks-nested'].bars = FAMILIES['gks-std'].bars;

/** 產生 zjmud 面板 daemon。所有協議細節集中在這裡，look 只插一行呼叫。 */
// 快捷列的候選：標籤、指令、判定用的動詞檔名。
// 【WHY 要列這麼多候選】各家的動詞不同（有的叫 `i` 有的叫 `inventory`、
// 有的有 `dazuo` 有的沒有）。列出常見的，實際存在才放進去——
// 寧可某台只有五個按鈕，也不要放一個按了回「什麼？」的。
const QUICK_CANDIDATES = [
  ['看', 'look', 'look'],
  ['狀態', 'hp', 'hp'],
  ['背包', 'i', 'i'],
  ['背包', 'inventory', 'inventory'],
  ['技能', 'skills', 'skills'],
  ['裝備', 'eq', 'eq'],
  ['成績', 'score', 'score'],
  ['經驗', 'exp', 'exp'],
  ['打坐', 'dazuo 10', 'dazuo'],
  ['吐納', 'tuna', 'tuna'],
  ['退出', 'quit', 'quit'],
];

const TITLE_CANDIDATES = [
  ['地圖', 'map', 'map'],
  ['打坐', 'dazuo 10', 'dazuo'],
  ['練功', 'practice', 'practice'],
  ['技能', 'skills', 'skills'],
  ['狀態', 'hp', 'hp'],
];

// 標題列按鈕：依**實際有的指令**產生，格式是「標籤:指令」。
//
// 【WHY】使用者截圖裡標題列冒出六顆按鈕：地圖 | map | 打坐 | dazuo 10 | 練功 |
// practice——一半是標籤、一半是指令。真因是我把 021 的內容寫成
//   "地圖" + ZJSEP + "map" + ZJSEP + "打坐" + ZJSEP + "dazuo 10"
// 而 ZJSEP($zj#) 分隔的是**記錄**，一筆記錄本身要用冒號接指令。
// 於是每個標籤與每個指令各自變成一顆按鈕，按「map」那顆送出的是標籤字串。
// 【證據】原生台 終極地獄 cmds/usr/mycmds.c：
//   write(ZJTTMENU" 飞行 :help mapb"ZJSEP" 附近 :map view\n");
// 一筆記錄一個冒號，記錄之間才是 ZJSEP。docs/zjmud-spec.MD §3 的 021 欄同義。
//
// 【WHY 還要挑指令】原本三顆是寫死的，而 yanhuangwuhun 根本沒有 dazuo，
// 打坐那顆按下去只會得到「什麼？」——與快捷列踩過的是同一條（CLAUDE.md §5：
// 斷言要是實數）。這裡改成掃 cmds/ 底下真的存在的檔案才放。
function titleBarLines(files) {
  const has = (verb) => {
    for (const p of files.keys()) {
      if (new RegExp('cmds/.*/' + verb + '\\.(c|lpc)$').test(p)) return true;
    }
    return false;
  };
  const picked = TITLE_CANDIDATES.filter(([, , v]) => has(v)).slice(0, 4);
  if (!picked.length) return '    s = "";';
  return picked.map(([label, cmd], i) =>
    `    s ${i ? '+=' : '='} ${i ? 'ZJSEP + ' : ''}"${label}:${cmd}";`).join('\n');
}

function quickBarLines(files) {
  const has = (verb) => {
    for (const p of files.keys()) {
      if (new RegExp('cmds/.*/' + verb + '\\.(c|lpc)$').test(p)) return true;
    }
    return false;
  };
  const picked = [];
  const seenLabel = new Set();
  for (const [label, cmd, verb] of QUICK_CANDIDATES) {
    if (picked.length >= 8) break;
    if (seenLabel.has(label)) continue;       // 背包只要一個（i 或 inventory）
    if (!has(verb)) continue;
    seenLabel.add(label);
    picked.push([label, cmd]);
  }
  // 一個都沒有時至少給 look——那是 zjmud 面板本身依賴的指令
  if (!picked.length) picked.push(['看', 'look']);
  return picked.map(([label, cmd], i) =>
    `    s ${i ? '+=' : '='} ${i ? 'ZJSEP + ' : ''}"b${i + 1}:${label}:${cmd}";`).join('\n');
}

function daemonSource(family, files) {
  // ★ 狀態條不再由家族常數決定，改送**這台實際有值的那幾條**。
  //
  // 【WHY】家族常數會錯：火影被判為 hpmp-std，於是 daemon 去讀 hp／sp，
  // 但它的 /std/char 實際上只有 hp／mp——sp 永遠是 0、max_hp 不存在，
  // 結果 012 一條都送不出去，客戶端狀態列整片空白。
  // 而「這台有哪些屬性」是可以直接觀察的事實，不需要靠家族推論。
  // 【推理】把三個血緣的欄位全部列出來，每一條都用 if (m > 0) 守住：
  // 有值的才送。多列幾條的成本是零（沒值的那幾行不會產出任何 opcode），
  // 而少列一條的代價是整個狀態列消失。
  const UNION_BARS = [
    ['氣血', 'qi', 'eff_qi', 'max_qi', '#c71417'],
    ['內力', 'neili', 'neili', 'max_neili', '#2b5eda'],
    ['精神', 'jing', 'eff_jing', 'max_jing', '#ac16a9'],
    ['氣', 'kee', 'eff_kee', 'max_kee', '#c71417'],
    ['精', 'gin', 'eff_gin', 'max_gin', '#2b5eda'],
    ['神', 'sen', 'eff_sen', 'max_sen', '#ac16a9'],
    ['內力', 'force', 'force', 'max_force', '#2b8a3e'],
    ['生命', 'hp', 'hp', 'max_hp', '#c71417'],
    ['法力', 'mp', 'mp', 'max_mp', '#2b5eda'],
    ['體力', 'sp', 'sp', 'max_sp', '#2b8a3e'],
    // ★ Dead Souls 血緣的屬性名：spi（spirit points）。
    //
    // 【WHY】山海戰神／最終幻境的狀態列一直是空的（012 一條都不送），
    // 而它們的面板其他八格都正常——看起來像「這台就是沒有狀態列」。
    // 用探針印出玩家 dbase 的實際欄位才看清楚：
    // `spi=100 max_spi=100 eff_spi=100 food=200 water=200 str=20 con=20`，
    // 金庸那套（qi/jing/kee/gin/sen/neili/force）**一個都沒有**。
    // 上面那張表是照金庸系寫的，對 DS 血緣的台等於整張表落空。
    // 【WHY 只加 spi，不加 food/water】food/water 金庸系也普遍有，
    // 加進來會讓既有的台**多出兩條狀態條**——那是改動既有行為，
    // 而 spi 只有 DS 血緣才有，影響面是單向的（只讓空的變有內容）。
    ['精神', 'spi', 'eff_spi', 'max_spi', '#ac16a9'],
  ];
  const bars = UNION_BARS;
  const barLines = bars.map(([label, cur, eff, max, color], i) => `    // ★ 先接成 mixed 再驗型別——不可以直接指派給 int。
    // 【WHY】小魚西遊 的狀態列一直空著，而面板其他八格都正常。探針顯示
    // status_panel **開頭印得出、結尾印不出**——函數在中間就中止了。
    // 真因：這些 lib 的 query("qi") 不一定回整數（可能是 mapping 或 0 以外的
    // 型別），而 v/e/m 宣告成 int，指派當場 raise，整個 status_panel 中止，
    // 於是連後面本來有值的 kee／gin／sen 三條也一起沒了（同 §D35 的連坐）。
    // 【判準】取值一律 catch ＋ intp() 驗過才用；取不到就當 0，跳過這一條。
    tv = 0; te = 0; tm = 0;
    catch(tv = me->query("${cur}"));
    catch(te = me->query("${eff}"));
    catch(tm = me->query("${max}"));
    v = intp(tv) ? tv : 0;
    e = intp(te) ? te : 0;
    m = intp(tm) ? tm : 0;
    // 屬性也有 getter 風格（見房間介面那條）：query("hp") 取不到時試 query_hp()
    if (! v) { tv = 0; catch(tv = me->query_${cur}()); v = intp(tv) ? tv : 0; }
    if (! m) { tm = 0; catch(tm = me->query_${max}()); m = intp(tm) ? tm : 0; }
    // 【WHY 上限取不到要退回當前值】火影的 /std/char 只有 hp／mp，
    // **沒有 max_hp**。原本的條件是 if (m > 0)，上限取不到就整條 bar 跳過——
    // 而全部欄位都取不到時，012 一個都不會送，客戶端的狀態列整片空白。
    // 狀態列的用途是「看得出還剩多少」，上限未知時用當前值當上限，
    // 至少顯示得出數值；比整條消失有用。
    if (m <= 0) m = v;
    if (m > 0) s += ${i ? '"\\u2551" + ' : ''}sprintf("${label}.%d:%d/%d/%d:%s", v, v, e ? e : v, m, "${color}");`).join('\n');

  return `// [zjmud] 由 tools/convert-to-zjmud.mjs 產生 —— 房間與狀態面板。
//
// 這個檔案是**轉換層**，不是原 mudlib 的一部分：它把 mudlib 已經有的資料
// （short/long/exits/all_inventory 與屬性欄位）翻譯成 zjmud 協議的 opcode，
// 讓手機客戶端畫得出面板。原 mudlib 的行為完全不變——文字照舊輸出。
//
// 協議規範出自 others/zjmud.h 與收藏中 16 台已轉換的 lib：
//   ESC002 標題（**有副作用：客戶端會清空出口／物件**，所以必須第一個送）
//   ESC004 描述 → ESC003 出口 → ESC005 物件，順序固定
//   分隔符：記錄間 $zj#、記錄內換行 $br#、屬性條之間 U+2551
#include <ansi.h>
#include <zjmud.h>

// ZJCHARHP（ESC022，同房生物血條）在 others/zjmud.h 裡是**被註解掉的**
// （標註「弃用」），但客戶端仍然支援，而原生 zjmud 台（終極地獄）實測會送。
// 少了這個定義整個 daemon 編譯失敗、所有面板一起消失——
// 所以在這裡自己定義，不去改共用的標頭。
#ifndef ZJCHARHP
#define ZJCHARHP        ESA + "022"
#endif

// LPC 需要前向宣告：room_panel 會呼叫在它後面才定義的 quick_bar。
// （實測 error: Undefined function quick_bar，整個 daemon 編譯失敗 → 面板全無）
void quick_bar(object me);
void title_buttons(object me);
void npc_bars(object me, object env);
void item_panel(object me, object ob);
void status_panel(object me);

// 出口的中文別名：手機上的方向鍵要看得懂
mapping dir_cn = ([
  "north":"北","south":"南","east":"東","west":"西",
  "northup":"北上","northdown":"北下","southup":"南上","southdown":"南下",
  "eastup":"東上","eastdown":"東下","westup":"西上","westdown":"西下",
  "northeast":"東北","northwest":"西北","southeast":"東南","southwest":"西南",
  "up":"上","down":"下","enter":"進","out":"出",
]);

void room_panel(object me, object env)
{
    string s, l, *dirs, d;
    mapping exits;
    object *inv;
    int i;

    if (! objectp(me) || ! objectp(env)) return;

    // ① 標題（必須最先，它會清空舊的出口與物件）
    // ★ 房間介面有**兩套**，要都支援。
    // 【WHY】ES2／金庸系用 mapping：set("short", …) ／ query("short")；
    // 而 es1 系（LPMud 2.4.5 血緣）用 setter/getter：set_short(...) ／
    // query_short()——query("short") 對它們一律回 0。只寫一種的話，
    // 面板 daemon 會**完全正常地送出空內容**：沒有錯誤、沒有警告，
    // 客戶端收到的就是「登入成功、畫面空白」。
    // 【證據】es1_win /d/abyss/entrance/start.c：set_short("A empty room", "仙境")。
    s = (string)env->query("short");
    if (! stringp(s)) catch(s = (string)env->query_short());
    if (! stringp(s)) s = "";
    s = "\\n" + ZJTITLE + s + "\\n";

    // ② 描述——換行拿掉，客戶端自己排版
    l = (string)env->query("long");
    if (! stringp(l)) catch(l = (string)env->query_long());
    if (! stringp(l)) l = "";
    s += ZJLONG + replace_string(l, "\\n", "") + "\\n";
    tell_object(me, s);

    // ③ 出口：dir:標籤:指令，$zj# 分隔
    exits = (mapping)env->query("exits");
    if (! mapp(exits)) catch(exits = (mapping)env->query_exits());
    if (mapp(exits)) {
        dirs = keys(exits);
        s = "";
        for (i = 0; i < sizeof(dirs); i++) {
            d = dirs[i];
            if (i) s += ZJSEP;
            s += d + ":" + (dir_cn[d] ? dir_cn[d] : d) + ":" + d;
        }
        if (strlen(s)) tell_object(me, "\\n" + ZJEXIT + s + "\\n");
    }

    // ④ 物件：標籤:指令（指令用 look <id>，客戶端點了就送）
    //
    // ★ 每個物件各自 catch —— 一個壞物件不可以吃掉後面全部的面板。
    // 【WHY】xkx2017 只收到 000/002/003/004，005 之後**五個 opcode 全部消失**。
    // 缺口太整齊（就是「④ 以後的全部」）不像資料問題。二分證實：
    // 單獨把 query("id") 的硬轉拿掉 → 還是 4/9；單獨把 short() 的真假判斷
    // 改成 stringp() → 還是 4/9；**只把 short() 包進 catch → 立刻 9/9**。
    // 所以是 short() 自己丟例外（客店裡的「牌子(paizi)」），而未捕捉的
    // 例外會中止整個 look 指令——連 look.lpc 裡排在 room_panel 之後的
    // status_panel（012）都一起沒了。一個壞物件，五個 opcode。
    // 【判準】短少的是「顯示不出來的那一個物件」，不是整個介面。
    inv = all_inventory(env);
    s = "";
    for (i = 0; i < sizeof(inv); i++) {
        mixed sh, id;
        if (inv[i] == me) continue;
        if (catch(sh = inv[i]->short())) continue;
        if (! stringp(sh)) continue;
        if (catch(id = inv[i]->query("id"))) id = "";
        if (strlen(s)) s += ZJSEP;
        s += sh + ":look " + (stringp(id) ? id : "");
    }
    if (strlen(s)) tell_object(me, "\\n" + ZJOBIN + s + "\\n");

    // 快捷按鈕列、標題列按鈕、同房生物血條：每次 look 都補送
    // （客戶端以槽位／標籤覆蓋，不會累積）
    //
    // ★ 三格各自 catch，理由同上：它們彼此獨立，任何一格失敗都不該
    // 連坐後面兩格。npc_bars 也會走遍房內物件（query("max_qi") 等），
    // 同樣可能踩到會丟例外的物件。
    catch(quick_bar(me));
    catch(title_buttons(me));
    catch(npc_bars(me, env));
}

// 狀態條：ESC012 + 「標籤.數值:當前/有效/上限:顏色」以 U+2551 分隔
void status_panel(object me)
{
    string s;
    int v, e, m;
    mixed tv, te, tm;

    if (! objectp(me)) return;
    s = "";
${barLines}
    if (strlen(s)) tell_object(me, "\\n" + ZJHPTXT + s + "\\n");
}

// 快捷按鈕列：ESC006「槽位:標籤:指令」以 $zj# 分隔。
//
// 【WHY 這是最重要的遺漏】使用者最早的抱怨就是「下方 GUI 選單沒有出來」。
// zjmud 原生台會送 006，所以底下那兩排是有內容的；而轉換的 telnet 台
// 只送了房間與狀態，底部一排全是空的「＋」——**顯示做了、互動沒做**。
// 這些指令是每一台 ES2／金庸系都有的標準指令，不需要各台客製。
void quick_bar(object me)
{
    string s;

    if (! objectp(me)) return;
    // 快捷列的內容由 builder 依**這一台實際有的指令**填入。
    // 【WHY】原本寫死八個指令（look/hp/i/skills/eq/dazuo 10/tuna/quit），
    // 但**不是每台都有**——火影沒有 i／eq／dazuo／tuna，按下去伺服器
    // 只回「什麼？」。使用者看到的是「按鈕會動但沒有用」，
    // 比沒有按鈕更糟：它讓人以為自己按錯了。
    // 【判準】掃 cmds/**/<verb>.(c|lpc) 是否存在——可以直接觀察的事實。
${quickBarLines(files)}
    tell_object(me, "\n" + ZJBTSET + s + "\n");
}

// 物件詳細（ESC007）＋ 可做的動作（ESC008）。
// 手機上點一個 NPC／物品會開底部抽屜，內容就是這兩個 opcode——
// 沒有它們的話點了沒反應，「現場」面板等於裝飾。
void item_panel(object me, object ob)
{
    string s, d;

    if (! objectp(me) || ! objectp(ob)) return;
    d = (string)ob->query("long");
    if (! stringp(d)) d = (string)ob->short();
    if (! stringp(d)) return;
    tell_object(me, "\n" + ZJOBLONG + replace_string(d, "\n", ZJBR) + "\n");

    // 動作列：$r,w,h,s# 版面前綴 ＋「標題:指令」——冒號分欄，ZJSEP 只分記錄。
    s = ZJMENUF(2, 4, 22, 40);
    s += "察看:look " + (string)ob->query("id");
    if (living(ob)) {
        s += ZJSEP + "攻擊:kill " + (string)ob->query("id");
        s += ZJSEP + "交談:ask " + (string)ob->query("id") + " about here";
    } else {
        s += ZJSEP + "拿取:get " + (string)ob->query("id");
    }
    tell_object(me, "\n" + ZJOBACTS + s + "\n");
}

// ESC021 標題列按鈕：「標籤:指令」以 $zj# 分隔。
// 手機上顯示在房間標題那一列，放最常用的幾個動作。
// 【為什麼補這個】與原生 zjmud 台逐 opcode 對照後發現的缺口：
// 終極地獄（原生）會送 021/022，轉換台完全沒有——標題列與同房血條是空的。
void title_buttons(object me)
{
    string s;

    if (! objectp(me)) return;
    // 每筆記錄是「標籤:指令」，記錄之間才用 ZJSEP 分隔。
${titleBarLines(files)}
    tell_object(me, "\n" + ZJTTMENU + s + "\n");
}

// ESC022 同房生物的血條：「標籤$zj#當前:有效:上限」。
// 客戶端會把它畫在「現場」清單的每個項目下面，戰鬥時一眼看得出誰快倒了。
// 標籤必須與 ESC005 送出的指令一致，客戶端靠它配對。
// 單一生物的血條。抽出來是為了讓呼叫端可以 catch **每一個物件**——
// 這個迴圈裡有十幾個 query() 與一個 (string) 硬轉，任何一個丟例外，
// 原本會讓整個房間**一條血條都不送**（同 room_panel ④ 的教訓）。
void one_bar(object me, object ob)
{
    int v, m;
    mixed id;

    m = (int)ob->query("max_qi");
    if (m < 1) m = (int)ob->query("max_kee");
    if (m < 1) m = (int)ob->query("max_hp");
    // 上限取不到時用**當前值**當上限（與狀態條同一條規則）。
    // 火影的 NPC 有 hp 但沒有 max_hp，原本 m < 1 就 continue，
    // 於是整個房間一條血條都不送——而房間裡明明站著五個 NPC。
    // 這是缺陷不是資料相依，兩者要分清楚：先確認房間真的有 living 物件。
    if (m < 1) m = (int)ob->query("qi");
    if (m < 1) m = (int)ob->query("kee");
    if (m < 1) m = (int)ob->query("hp");
    if (m < 1) catch(m = (int)ob->query_hp());
    if (m < 1) return;
    v = (int)ob->query("qi");
    if (v < 1) v = (int)ob->query("kee");
    if (v < 1) v = (int)ob->query("hp");
    if (catch(id = ob->query("id"))) id = "";
    tell_object(me, "\n" + ZJCHARHP + "look " + (stringp(id) ? id : "") + ZJSEP
        + sprintf("%d:%d:%d", v, v, m) + "\n");
}

void npc_bars(object me, object env)
{
    object *inv;
    int i;

    if (! objectp(me) || ! objectp(env)) return;
    inv = all_inventory(env);
    for (i = 0; i < sizeof(inv); i++) {
        // 【WHY 不用 living()】living() 要求物件被 enable_commands 過。
        // 火影的房間裡站著五個 NPC（005 明明列出了 tmr／annihilator／acme…），
        // 但它們沒被喚醒，living() 一律回假，於是 022 一條都不送——
        // 而使用者看得到那些 NPC，卻看不到它們的血條。
        // 【判準】改用證據：**身上有生命值欄位的就是生物**。
        // 公告板、物品沒有這些欄位，自然會被 one_bar 裡的 m < 1 濾掉。
        if (inv[i] == me) continue;
        catch(one_bar(me, inv[i]));
    }
}

void create() { seteuid(getuid()); }
`;
}

/**
 * 在 look_room() 裡「印出房間文字的那一刻」插入面板呼叫。
 *
 * 【WHY 不用「函式結尾」當錨點】前兩版分別要求結尾是 `write(str); return 1; }`
 * 與 `tell_object(me, str); return 1; }`，結果第三種寫法（shiji、爱若幽兰）
 * 在 write(str) **之後還有小地圖繪製的一大段**，錨點對不上就整台被跳過。
 *
 * 【推理】語意上要的是「房間文字送出去的那一刻」，不是「函式結束」。
 * 所以錨點改成 look_room 函式體內**第一個** write(str)／tell_object(me,str)，
 * 插在它後面——後面還有什麼都不影響。
 */
function patchLook(text) {
  // 冪等：先撕掉自己上次插的區塊（CLAUDE.md §6）
  text = text.replace(/[ \t]*\/\/ \[zjmud\] 面板[^\n]*\n(?:[ \t]*"\/adm\/daemons\/zjmudd"->[^\n]*\n)+/g, '');

  // ★ 回傳型別與函數名都不能寫死。
  // 【WHY】實測三種變體，每一種都讓整台轉換失敗：
  //   int look_room(object me, object env)      最常見
  //   mixed look_room(object env)               笑傲系：回傳 mixed，而且**只有一個參數**
  //   string look_in_room(object room, int)     es1 系：連名字都不一樣
  // 只認第一種＝只支援第一種，而其餘兩種的 look_room 明明是好好的。
  // 【WHY 要允許修飾字】簽名前面可能有 varargs／private／static／protected／nomask
  // ——重生的世界 的 look_room 就帶修飾字，於是正則對不上，
  // 報「沒有 look_room() 的標準結尾」，而那個函數明明就在檔案裡。
  // 錯誤訊息還會誤導人去看「結尾」，真正的問題在**開頭**。
  let sig = text.search(/(?:varargs|private|static|protected|nomask|public)?\s*(?:int|void|mixed|string|object)\s+look_(?:room|in_room)\s*\([^)]*\)\s*\{/);
  if (sig === -1) {
    // ★ 最後一層退路：掛 look 指令的 main()。
    // 【WHY】火影 的 cmds/usr/look.lpc 根本沒有 look_room——
    // 房間顯示直接寫在 int main(object me, string arg) 裡面。
    // 沒有這層退路的話，協議注入整個失敗，而它連帶讓登入注入也失敗
    // （Cannot #include zjmud.h）——**一個階段失敗把下一個拖下水**。
    // 【WHY 安全】main() 同時處理「看房間」與「看物件」，
    // 多送一次房間面板只是刷新，客戶端不會出錯。
    sig = text.search(/\bint\s+main\s*\(\s*object\s+\w+\s*,\s*string\s+\w+\s*\)\s*\{/);
  }
  if (sig === -1) {
    // ★ 再一層退路：`do_command()` 型的指令。
    // 【WHY】重生的世界（RWlib 血緣，與本收藏其餘武俠 lib 完全無關）的
    // cmds/std/ppl/look.lpc 既沒有 look_room 定義、也沒有 main()——
    // 它的入口是 `void do_command(...)`，而檔案裡出現的 look_room 是**呼叫**：
    //   msg += (env->query_module_file())->look_room(env) || "";
    // 偵測端（r10_import）的第三順位「只要提到 look_room 就收」會挑中它，
    // 注入端卻認不得 → 整個 protocol-panels 拋 RuntimeError，
    // 連帶讓登入注入也失敗，這台因此停在 opcode 0/9。
    // 【判準】**兩端的判準必須同步**：偵測端收得進來的形狀，注入端就要接得住。
    // 這條在上一次放寬 main() 時就寫過（見上面的說明），而新的形狀又漏了一種。
    sig = text.search(/\bvoid\s+do_command\s*\([^)]*\)\s*\{/);
  }
  if (sig === -1) return null;
  // 從函式開頭數大括號，找出函式體範圍
  let i = text.indexOf('{', sig);
  let depth = 0;
  let bodyEnd = -1;
  for (let j = i; j < text.length; j += 1) {
    if (text[j] === '{') depth += 1;
    else if (text[j] === '}') { depth -= 1; if (depth === 0) { bodyEnd = j; break; } }
  }
  if (bodyEnd === -1) return null;

  const body = text.slice(i, bodyEnd);

  // ★ 參數名字要從**簽名**讀，不要寫死 me/env。
  // 【WHY】int look_room(object who, object room) 這種命名是存在的；
  // 寫死 me/env 會編出 Undefined variable，而失敗的是整個 look 指令——
  // 症狀是「這台完全沒有面板」，看起來像轉換沒生效。
  const sigTxt = text.slice(sig, i);
  const params = [...sigTxt.matchAll(/object\s+(\w+)/g)].map((x) => x[1]);
  // 【WHY 要判斷單一參數是「誰」】mixed look_room(object env) 只有一個 object，
  // 而它是**房間**不是玩家。直接當成 me 用的話，面板會拿房間去查血條，
  // 結果是所有數值都空——不會報錯，只會「看起來壞掉」。
  // 判準用參數名字：env/room/here 這類是環境，其餘視為玩家。
  const isEnvName = (n) => /^(env|room|here|place|where)$/i.test(n || '');
  let meVar, envVar;
  if (params.length >= 2) {
    [meVar, envVar] = params;
  } else if (params.length === 1 && isEnvName(params[0])) {
    meVar = 'this_player()';
    envVar = params[0];
  } else {
    meVar = params[0] || 'this_player()';
    envVar = 'environment(' + meVar + ')';
  }
  const mk = (indent) => indent + '// [zjmud] 面板：把房間資料翻成 opcode，原本的文字輸出完全不動\n'
    + indent + '"/adm/daemons/zjmudd"->room_panel(' + meVar + ', ' + envVar + ');\n'
    + indent + '"/adm/daemons/zjmudd"->status_panel(' + meVar + ');\n';

  // 首選：接在**最後一次**房間文字輸出之後。
  // 【WHY 要最後一次】有些 look_room 前面有提前 return 的分支
  // （if (!sizeof(dirs)) { write(str); return 1; }），接在第一次輸出後面
  // 等於把 hook 放進一條走不到的死路。
  const all = [...body.matchAll(/\n([ \t]*)(?:write\(str\)|tell_object\(\w+,\s*str\));[^\n]*\n/g)];
  if (all.length) {
    const m = all[all.length - 1];
    const at = i + m.index + m[0].length;
    return text.slice(0, at) + mk(m[1]) + text.slice(at);
  }

  // 退路：注入到函數**結尾的 return 之前**。
  // 【WHY 需要退路】write(str) 只是**常見**寫法，不是規範：
  // es1_win／三界神话 用別的輸出形式，於是整台轉換直接失敗，
  // 而它們的 look_room 明明是好好的。錨點寫死一種寫法＝只支援那一種。
  // 【WHY 錨在 return 之前】那是函數必經的最後一點，不管前面走哪個分支都會到——
  // 比猜「哪一行是房間輸出」可靠。
  const rets = [...body.matchAll(/\n([ \t]*)return[^\n;]*;[^\n]*\n/g)];
  if (rets.length) {
    const m = rets[rets.length - 1];
    const at = i + m.index + 1;
    return text.slice(0, at) + mk(m[1]) + text.slice(at);
  }
  // 連 return 都沒有：貼在函數結尾的 } 之前
  return text.slice(0, bodyEnd) + mk('  ') + text.slice(bodyEnd);
}

/**
 * 在 look_item()／look_living() 印出物件描述之後插入面板呼叫。
 * 找不到就回 null——這是加分項，不該擋住整台的轉換。
 */
function patchLookItem(text) {
  text = text.replace(/[ \t]*\/\/ \[zjmud\] 物件面板[^\n]*\n(?:[ \t]*"\/adm\/daemons\/zjmudd"->item_panel[^\n]*\n)+/g, '');

  // ★ look_item **與** look_living 都要 hook。
  // 【WHY】北美侠客行實測：hook 只插了 look_item，但點 NPC（「赏善使」张三）
  // 走的是 look_living——抽屜還是空的。物品與活物是兩條路，兩條都要。
  let out = text;
  let hooked = 0;
  for (const fn of ['look_item', 'look_living']) {
    const sigM = out.match(new RegExp(`\\bint\\s+${fn}\\s*\\([^)]*\\)\\s*\\{`));
    if (!sigM) continue;
    const open = out.indexOf('{', sigM.index);
    let depth = 0;
    let bodyEnd = -1;
    for (let j = open; j < out.length; j += 1) {
      if (out[j] === '{') depth += 1;
      else if (out[j] === '}') { depth -= 1; if (depth === 0) { bodyEnd = j; break; } }
    }
    if (bodyEnd === -1) continue;
    const body = out.slice(open, bodyEnd);
    // 錨在函式的 **return 之前**，不是第一個輸出。
    // 【WHY】look_living 的開頭有一個 message("vision", …) 是「別人看你」的
    // 廣播，且包在條件式裡；抓第一個輸出會插到那裡——那條路多數時候不會走到，
    // 於是 hook 形同不存在（實測：點 NPC 描述有出來，抽屜卻是空的）。
    // 函式尾端則是所有路徑的匯流處。
    const rets = [...body.matchAll(/\n([ \t]*)return\s+1;\s*\n/g)];
    const all = rets.length ? rets
      : [...body.matchAll(/\n([ \t]*)(?:write\([^;]*\)|tell_object\(me,[^;]*\));[^\n]*\n/g)];
    if (!all.length) continue;
    const m = all[all.length - 1];
    const at = open + m.index + (rets.length ? 1 : m[0].length);
    const indent = m[1];
    out = out.slice(0, at)
      + `${indent}// [zjmud] 物件面板：點 NPC／物品時的詳細與動作列\n`
      + `${indent}"/adm/daemons/zjmudd"->item_panel(me, obj);\n`
      + out.slice(at);
    hooked += 1;
  }
  return hooked ? out : null;
}

// ── 映像讀寫（與 fix-image 同構）─────────────────
function loadImage(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mudlib.json'), 'utf8'));
  const data = fs.readFileSync(path.join(dir, 'mudlib.data'));
  return { manifest, files: new Map(manifest.files.map((f) => [f.path, data.subarray(f.at, f.at + f.size)])) };
}
function saveImage(dir, manifest, files) {
  const dirs = new Set(manifest.dirs ?? []);
  for (const p of files.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  const parts = [];
  const list = [];
  let at = 0;
  for (const [p, buf] of files) { list.push({ path: p, at, size: buf.length }); parts.push(buf); at += buf.length; }
  const data = Buffer.concat(parts);
  fs.writeFileSync(path.join(dir, 'mudlib.json'), JSON.stringify({
    ...manifest, format: IMAGE_FORMAT, totalBytes: data.length,
    dirs: [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)),
    files: list,
  }));
  fs.writeFileSync(path.join(dir, 'mudlib.data'), data);
}

/** 轉換一台。回傳 { ok, note }。 */
export function convert(dir, family) {
  const cfg = FAMILIES[family];
  if (!cfg) return { ok: false, note: `不認得的家族 ${family}` };
  const { manifest, files } = loadImage(dir);
  const done = [];

  // ① include/zjmud.h —— **一律覆寫**。
  //
  // 【WHY 不做「已存在就跳過」】那樣寫的話，工具改良版（例如拿掉
  // `#include <getconfig.h>` 那一行）永遠注入不進去，而報告顯示成功——
  // 同一個坑 fix-image 踩過三次，CLAUDE.md §6 就是為它寫的。
  // 用標記判斷也不行：**先前注入的版本沒有標記**，雞生蛋。
  //
  // 【為什麼覆寫是安全的】98 台的指紋掃描顯示，自帶 include/zjmud.h 的
  // 只有 zhongjidiyu_zhijian 一台，而它本來就是 zjmud、根本不需要轉換。
  // 換句話說：這個路徑上的檔案只可能是我們自己放的。
  {
    // 開頭的 `#include <getconfig.h>` 是 zjmud 收藏專屬的（那邊才有這個檔），
    // telnet lib 一定找不到 → 整份 zjmud.h 編譯失敗 → 面板 daemon 載不起來。
    // 實測：星戰英雄 `/include/zjmud.h:1: error: Cannot #include getconfig.h`。
    // 我們要的只有 ESC 巨集，而 ZJKEY 本來就定義在 zjmud.h 自己裡面。
    const zh = '// [zjmud] 由 convert-to-zjmud.mjs 注入（來源 others/zjmud.h）\n'
      + fs.readFileSync(ZJMUD_H_SRC, 'utf8')
        .replace(/^\s*#include\s+[<"][^>"]*[>"]\s*$/gm,
          '// [zjmud] 移除收藏專屬的 include（telnet lib 沒有這個檔）');
    files.set('include/zjmud.h', Buffer.from(zh, 'utf8'));
    done.push('include/zjmud.h');
  }

  // ② 面板 daemon
  files.set('adm/daemons/zjmudd.lpc', Buffer.from(daemonSource(family, files), 'utf8'));
  done.push('adm/daemons/zjmudd.lpc');

  // ③ look 的 hook（一行）
  // 【WHY 允許外部指定 look 路徑】家族設定裡的 look 位置是**歸納出來的常數**，
  // 而收藏裡的變體會把它放在別處（ds386 的 hpmp-std 就沒有 cmds/std/look.lpc）。
  // 猜錯的後果是整台轉換失敗，而真正的檔案其實就在旁邊。
  // builder 會先掃出「真的定義了 look_room() 的那個檔」再傳進來——
  // 依據資料，不依據假設（SOP §8）。
  const lookOverride = arg('look');
  const lookPath = lookOverride && files.has(lookOverride) ? lookOverride
    : [cfg.look, cfg.look.replace(/\.lpc$/, '.c')].find((p) => files.has(p));
  if (!lookPath) return { ok: false, note: `找不到 look（${cfg.look}）` };
  let patched = patchLook(files.get(lookPath).toString('utf8'));
  if (patched == null) return { ok: false, note: `${lookPath} 沒有 look_room() 的標準結尾，需手動處理` };
  // look_item 也要 hook：點 NPC／物品時送 ESC007（詳細）＋ ESC008（動作列），
  // 否則「現場」面板點下去沒有任何反應。找不到就跳過（不擋轉換）。
  patched = patchLookItem(patched) ?? patched;
  files.set(lookPath, Buffer.from(patched, 'utf8'));
  done.push(lookPath);

  return { ok: true, files: done, save: () => saveImage(dir, manifest, files) };
}

// ── CLI ────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const slug = process.argv[2];
  const family = arg('family');
  if (!slug || !family) {
    console.error('用法：node tools/convert-to-zjmud.mjs <slug> --family <es2-inherit|gks-std|…> [--dry-run]');
    process.exit(2);
  }
  const dir = path.join(LIBS, slug);
  const r = convert(dir, family);
  if (!r.ok) { console.error(`✗ ${slug}：${r.note}`); process.exit(1); }
  if (!process.argv.includes('--dry-run')) {
    r.save();
    const metaPath = path.join(dir, 'mud.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.convert = {
      family,
      by: 'tools/convert-to-zjmud.mjs',
      files: r.files,
      opcodes: ['002', '003', '004', '005', '012'],
      verified: { bootTest: false, layout: false, manual: false },
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  }
  console.log(`✓ ${slug}（${family}）：${r.files.join('、')}`);
}
