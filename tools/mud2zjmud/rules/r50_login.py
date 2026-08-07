"""原生 zjmud 登入的注入 —— **builder 的核心規則**。

【WHY 這條最重要】「轉成 zjmud lib」有兩種做法：
  (a) 嫁接——客戶端寫接應器，替使用者把 telnet 問答一題一題答完
  (b) 原生——讓 mudlib 自己說 zjmud 協議
(a) 把「這台的登入長什麼樣」寫進客戶端，但那是**伺服器的**性質：
每加一台就要多寫規則，而規則彼此干擾（實測放寬一條讓 14 台一起退步）。
(b) 一次到位：轉換後的台與原生 zjmud 台在協議層無法區分。
實測 62 台：嫁接 43 可玩、原生 58 可玩，且單台登入從 23 秒降到 4.5 秒。
"""
from __future__ import annotations

import re
from pathlib import Path

from .base import PHASE_LOGIN, rule

TMPL = (Path(__file__).resolve().parent.parent / "lpc" / "zjlogin.lpc.tmpl").read_text("utf-8")
MARK = "[zjmud] 原生登入"


def _sig(text: str, name: str):
    """取函數**定義**（不是前向宣告）的參數清單與是否 varargs。

    【WHY 一定要 `{` 結尾】前向宣告 `void enter_world(object ob, object user, int silent);`
    與定義長得幾乎一樣。抓到宣告的話參數看起來沒問題，但真正的定義可能多兩個——
    本專案在 look hook 上踩過同一個坑（改到宣告，等於沒改）。
    """
    m = re.search(r"(varargs\s+)?(?:private\s+|static\s+|protected\s+)*"
                  r"(?:void|object|int|string|mixed)\s+" + name + r"\s*\(([^)]*)\)\s*\{", text)
    if not m:
        return None
    return [a.strip() for a in m.group(2).split(",") if a.strip()], bool(m.group(1))


def _user_ob(img) -> str:
    """找出使用者（人物）物件的路徑。

    【WHY 不能依賴 `#ifdef USER_OB`】那個巨集是否可見，取決於 **logind 這個
    編譯單元有沒有 include 到定義它的標頭**。es1_win 的 `USER_OB` 明明是
    `/std/user` 而且檔案存在，但 logind 沒 include 那個標頭 → `#ifdef` 取到
    else 分支 → `new(ob->query("body"))` → 0 → 訊息只有「建立角色失败」，
    完全看不出是巨集不可見。
    【推理】builder 在**轉換時**就能把路徑查出來，寫成自己的巨集最保險——
    不依賴任何 include 關係。
    """
    from .r36_readfiles import _resolve
    # 【WHY 名字要列這麼多】各家對「玩家物件」的常數名沒有共識。
    # RWlib（重生的世界）叫 `PPL_OB`（people），而它的 include 裡**沒有**
    # USER_OB／PLAYER_OB——偵測落空 → 模板走 `new(ob->query("body"))` 退路
    # → 那個 query 回 0 → `*Bad argument 1 to EFUN new()`，
    # 而這個錯誤被 lib 自己的 error_handler 接走（不進 driver log），
    # 外面只看得到「停在 authing」。加一個名字的成本是零，
    # 漏一個的代價是一整台開不起來（spec §D40）。
    for sym in ("USER_OB", "USER_OBJ", "PLAYER_OB", "PPL_OB", "CHAR_OB", "BODY_OB"):
        v = _resolve(img, sym)
        if v and any((v.lstrip("/") + e) in img.files for e in (".c", ".lpc")):
            return v
    for cand in ("clone/user/user", "std/user", "obj/user", "clone/user", "std/player",
                 "system/object/ppl_ob"):
        if any((cand + e) in img.files for e in (".c", ".lpc")):
            return "/" + cand
    return ""


def _start_room(img) -> str:
    """找出起始房間。

    【WHY 需要】有些家族的初始化鏈會中途拋錯，人物建起來了卻**沒有被放進任何房間**
    （`environment()` 是 0）。面板是靠房間資料產生的，沒有房間就什麼都送不出去——
    症狀是「登入成功但畫面一片空白」，看起來像面板壞了。
    有了起始房間，我們可以在重試用盡後自己把人放進去，讓世界至少可玩。
    """
    from .r36_readfiles import _resolve
    # 【WHY 有 STARTROOM 這個沒底線的寫法】RWlib（重生的世界）的 login.h 寫的是
    # `#define STARTROOM`，不在原本的清單裡 → 一路落到 `VOID_OB`（虛空），
    # 於是人物確實登入了、面板也出來了，但站在一個**沒有出口也沒有物件**的
    # 房間裡（003／005 缺席）。報告寫「起始房間＝/obj/etc/void」看起來很正常。
    # VOID_OB 必須留在最後——它是最後手段，不是候選之一。
    for sym in ("START_ROOM", "STARTROOM", "DEFAULT_START_ROOM", "HOME_ROOM", "VOID_OB"):
        v = _resolve(img, sym)
        if not v:
            continue
        # 【WHY 要處理「值本身已含副檔名」】火影的 START_ROOM 是
        # `/world/area/wizard/guildhall.lpc`——已經帶 `.lpc`。
        # 無條件再補一次副檔名會判定「檔案不存在」，於是退回清單裡的
        # 下一個候選 `/obj/void`（虛空房間）——**規則挑到了錯的房間，
        # 而且看起來像它正常運作**（報告寫「起始房間＝/obj/void」）。
        rel = v.lstrip("/")
        for cand in (rel, rel + ".c", rel + ".lpc"):
            if cand in img.files:
                # LPC 的 load_object 不要副檔名
                return "/" + re.sub(r"\.(c|lpc)$", "", cand)

    # 【WHY 還要掃描退路】es1 系（es1_win／esI）**沒有任何 START_ROOM 巨集**——
    # 起始點寫死在它們自己的 login 流程裡。沒有起始房間，`enter_world()` 拋錯之後
    # 就沒有任何兜底，人物永遠停在無房間狀態，客戶端看到「登入成功、畫面空白」。
    # 【判準】找路徑像起始點的房間檔（`.../start`、`.../entrance/...`），
    # 而且**要確認它真的是房間**（檔案裡有 `set("exits"` 或 inherit ROOM）——
    # 光看檔名會挑到 `adm/daemons/network/services/startup.lpc` 這種無關的東西。
    for path in sorted(img.files):
        if not re.search(r"^d/.*/(start|entrance/start|entry)\.(c|lpc)$", path):
            continue
        body = img.files[path].decode("utf-8", "replace")
        if 'set("exits"' in body or re.search(r"inherit\s+ROOM", body):
            return "/" + re.sub(r"\.(c|lpc)$", "", path)
    return ""


VITALS = ("qi", "neili", "jing", "kee", "gin", "sen", "force", "hp", "mp", "sp")


def _vitals_macro(img) -> str:
    """為這台**實際使用**的生命值欄位補保底值。

    【WHY】`init_new_player()` 常常會拋錯而被我們 catch 掉，那一步順帶設定的
    生命值就沒設成——角色的 hp／qi 全是 0，狀態條（ESC012）因此一條都送不出去，
    客戶端的狀態列整片空白。
    【WHY 不是全部塞滿】十個欄位全設的話，每一台都會冒出十條狀態條，
    其中大半是這個 mud 根本沒有的屬性——**假資料比沒資料更糟**。
    【判準】只補這台的角色物件真的提到的欄位；那是可以直接觀察的事實。
    """
    used = set()
    for path, data in img.sources():
        if not re.search(r"(user|char|body|player)\.(c|lpc)$", path):
            continue
        t = data.decode("utf-8", "replace")
        for f in VITALS:
            if f'"max_{f}"' in t or f'"{f}"' in t:
                used.add(f)
    if not used:
        return ""
    stmts = []
    for f in sorted(used):
        stmts.append(f'if (! (u)->query("max_{f}")) (u)->set("max_{f}", 100); ')
        stmts.append(f'if (! (u)->query("{f}")) (u)->set("{f}", 100); ')
    return "#define ZJ_SET_VITALS(u)  do {{ {} }} while(0)\n".format("".join(stmts))


def _born_macro(img) -> str:
    """為「出生地」欄位補值——**只用這台自己的詞彙**。

    【WHY】使用者實測 yanhuangwuhun：登入後點「狀態」「成績」兩顆按鈕，
    伺服器回「还没有出生呐，察看什么？」。查 cmds/usr/hp.lpc：

        if (userp(ob) && (!stringp(my["born"]) || !my["born"]))
            return notify_fail("还没有出生呐，察看什么？\n");

    ——不是「沒有這個指令」（檔案就在 cmds/usr/hp.lpc），是**角色沒完成出生**。
    telnet 版的出生在註冊室（d/register/yanluodian.lpc `me->set("born", arg)`），
    而 logind 裡那行 `user->set("born",1)` 是**被註解掉的**。
    zjmud 客戶端沒有那一關對話，所以這個欄位永遠是空的。

    【推理】這與模板已經在做的「天賦」（str/int/con…取中間值）是同一類：
    原生化要**吸收掉**telnet 的逐項問答，否則世界會用它自己的守衛把玩家擋在門外。
    症狀特別難查——面板齊全、能走能看，只有某幾顆按鈕回一句看起來像
    「指令不存在」的話。這正是 CLAUDE.md §11：訊號齊全不等於世界可玩。

    【WHY 不寫死一個值】born 會被印成「你是<born>」，各台的詞彙完全不同
    （武俠是「中原人氏」，火影／星戰系根本沒有這個概念）。憑空塞一個值
    等於往世界裡寫假內容。**只在這台自己有 born 詞彙時才補，並沿用它的用詞**；
    找不到就不補——寧可留著已知的缺口，也不要製造看不出來的假資料。

    【判準】① 這台真的有 born 守衛（notify_fail 那條）② 這台真的有 born 字彙表。
    兩個條件都是可直接觀察的事實。
    """
    guarded = False
    for path, data in img.sources():
        if not re.search(r"^cmds/.*\.(c|lpc)$", path):
            continue
        t = data.decode("utf-8", "replace")
        if '["born"]' in t and "notify_fail" in t:
            guarded = True
            break
    if not guarded:
        return ""

    # 這台自己用過的出生地字串（註冊室的資料表最可靠）
    seen: dict[str, int] = {}
    for path, data in img.sources():
        t = data.decode("utf-8", "replace")
        for m in re.finditer(r'"born"\s*:\s*"([^"\n]{2,12})"', t):
            seen[m.group(1)] = seen.get(m.group(1), 0) + 1
    if not seen:
        for path, data in img.sources():
            t = data.decode("utf-8", "replace")
            for m in re.finditer(r'set\(\s*"born"\s*,\s*"([^"\n]{2,12})"', t):
                seen[m.group(1)] = seen.get(m.group(1), 0) + 1
    if not seen:
        return ""
    value = sorted(seen.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    return ('#define ZJ_SET_BORN(u)  do {{ if (! stringp((u)->query("born"))) '
            '(u)->set("born", "{}"); }} while(0)\n').format(value)


def _registered_macro(img) -> str:
    """把角色標記為「已註冊」——否則指令搜尋路徑會被縮小。

    【WHY】使用者要求「測試所有選單」之後，逐台按鈕掃描發現六台的「技能」鈕
    回「什么？」，而 `cmds/skill/skills.lpc` 明明就在。真因不是缺檔，是**身分**：

        // include/command.h
        #define PLR_PATH ({"/cmds/std/", "/cmds/usr/", "/cmds/skill/"})
        #define UNR_PATH ({"/cmds/usr/", "/cmds/std/"})     // ← 少了 skill/

        // feature/command.lpc  enable_player()
        else if (this_object()->query("registered") == 0)
            set_path(UNR_PATH);

    telnet 版的註冊流程走完會把 `registered` 設起來；zjmud 客戶端沒有那一關，
    於是角色永遠是「未註冊」，`/cmds/skill/` 整個目錄都不在搜尋路徑裡。
    症狀極度誤導：檔案在、沒有編譯錯誤、其他指令都正常，只有某幾顆按鈕
    回一句看起來像「沒有這個指令」的話——結論會指向「快捷列掛錯指令」，
    然後往錯的方向修（實測我第一版就是這樣寫報告的）。

    【推理】這與 [ZJ_SET_BORN] 完全同源：**原生化要吸收掉 telnet 的註冊步驟**，
    而每漏掉一個欄位，就會有一塊世界對玩家關著門。差別是 born 影響幾個指令，
    registered 影響**整個目錄**——影響面更大而更難察覺。

    【判準】兩個條件都要成立，都是可直接觀察的事實：
      ① 這個 lib 真的用 `query("registered")` 決定搜尋路徑（同檔案裡有 `set_path(`）
      ② 值是布林閘門，不是詞彙表——所以直接設 1，不需要像 born 那樣沿用用詞
    找不到這個守衛就不補：沒有這個機制的 lib 設了也只是多一個沒人看的欄位。
    """
    for path, data in img.sources():
        if not re.search(r"\.(c|lpc)$", path):
            continue
        t = data.decode("utf-8", "replace")
        if "set_path(" in t and re.search(r'query\(\s*"registered"', t):
            return ('#define ZJ_SET_REGISTERED(u)  do {{ if (! (u)->query("registered")) '
                    '(u)->set("registered", 1); }} while(0)\n')
    return ""


def _enter_macro(text: str) -> str:
    """產生 `ZJ_ENTER`——但**先確認那個函數真的存在**。

    【WHY】重生的世界（RWlib）的 `ppl_login_d.lpc` 根本沒有 `enter_world()`，
    而舊版在 `_sig()` 回傳 None（＝找不到）時仍然照樣輸出
    `#define ZJ_ENTER(o, u)  enter_world((o), (u))`。
    結果是我們注入的程式碼呼叫一個不存在的函數：

        ppl_login_d.lpc:877: error: Undefined function enter_world
          note: expanded from macro 'ZJ_ENTER'

    → 登入 daemon 編不出來 → LOGIN_OB 建不起來 → `fluffos_connect 失敗`。
    而報告只寫「撥號失敗」，看起來像網路層的問題，
    完全看不出是**我們自己產生的巨集呼叫了不存在的東西**。

    【判準】`_sig()` 找不到 ＝ 這個 lib 沒有這個函數。這時候不能硬呼叫；
    退而求其次用 `(u)->move(...)` 之類的通用做法會改變語意，
    所以改成**空操作**並讓後面的 `zj_enter` 退路（起始房間 ＋ 自己搬人）接手——
    模板本來就有那條退路（見 ZJ_START_ROOM 的說明）。
    """
    sig = _sig(text, "enter_world")
    if sig is None:
        return ("// 這個 lib 沒有 enter_world()——不要呼叫不存在的函數。\n"
                "// 進世界改由模板的 ZJ_START_ROOM 退路負責（自己把人搬進起始房間）。\n"
                "#define ZJ_ENTER(o, u)  ((void)0)")
    if sig[1] or len(sig[0]) <= 2:
        return "#define ZJ_ENTER(o, u)  enter_world((o), (u))"
    pad = ", ".join(["0"] * (len(sig[0]) - 2))
    return f"#define ZJ_ENTER(o, u)  enter_world((o), (u), {pad})"


def _macros(text: str) -> str:
    """依 mudlib 實際簽名生成呼叫巨集。

    【WHY 每一個都要偵測】同一血緣的 mudlib，關鍵函數簽名仍到處不同，
    而**每一種都造成過整台失敗**：
      check_legal_id   `(string)` / `(string, object)`
        → 個數錯＝編譯失敗＝整個 logind 載不起來＝報告寫「撥號失敗」，
          看起來像網路問題，跟登入改寫毫無關聯。
      init_new_player  `(user)` / `(link, user)` / **根本不存在**（6 台）
        → 個數錯＝編譯失敗（13 台同時中招）；**順序**錯不會報錯，
          但把登入物件當人物初始化，角色屬性全空。
      enter_world      `(ob, user, int)` / `(ob, user, int, int, string)`
        → 非 varargs 時少傳＝編譯失敗。
    結論：不要假設「同一系應該一樣」，一律先讀定義再生成。
    """
    out = []

    sig = _sig(text, "check_legal_id")
    if not sig:
        out.append("#define ZJ_LEGAL_ID(i, o)  (strlen(i) >= 2 && strlen(i) <= 16)")
    elif len(sig[0]) >= 2:
        # 【WHY 要看**型別**不能只看個數】翱翔天际 的簽名是
        #   `int check_legal_id(string id, int insaneid)`
        # ——第二個參數是 int（「是否做完整檢查」的旗標），不是登入物件。
        # 只數個數就會傳 object 進去：`Bad type for argument 2 ( int vs object )`，
        # 整個 logind 編譯失敗 → 又是「撥號失敗」。
        # int 一律傳 0：那是「只做基本檢查」的意思，對我們剛好。
        second = sig[0][1].split()[0]
        arg2 = "(o)" if second.startswith("object") else "0"
        out.append(f"#define ZJ_LEGAL_ID(i, o)  check_legal_id((i), {arg2})")
    else:
        out.append("#define ZJ_LEGAL_ID(i, o)  check_legal_id(i)")

    # ★ init_new_player 若是**互動式**的，就不能呼叫它。
    #
    # 【WHY】大唐双龙／侠客英雄传／逍遥情缘 等六台的 `init_new_player()` 內部
    # 自己還會 `input_to` 問屬性分配：
    #   `请输入您想要的属性，四项之和必须等于八十点，每一项不能少于十点…`
    # 那是 telnet 時代的建角對話，而 zjmud 客戶端沒有這一關——
    # 人物因此停在 input_to 狀態，`environment()` 永遠是 0，面板無從送起。
    # 症狀：登入成功（0007 正常）但畫面一片空白，看起來像面板壞了，
    # 其實是**建角還沒結束**。
    #
    # 【推理】我們在 zj_get_char 已經把屬性設好了，那段對話對我們是多餘的。
    # 判準：函數本體裡有沒有 `input_to`／`write_prompt`。有就繞過它，
    # 改呼叫 `setup()`（ES2 一系的共同初始化入口，各家都有）。
    # 【WHY 這樣安全】setup() 本來就會被 enter_world 再叫一次，重複是冪等的；
    # 而屬性我們已經給了合法值，人物該有的都有。
    m_body = re.search(r"(?:private\s+|static\s+|protected\s+)*void\s+init_new_player\s*\([^)]*\)\s*\{",
                       text)
    if m_body:
        depth, end = 0, -1
        for j in range(m_body.end() - 1, len(text)):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    end = j
                    break
        body = text[m_body.end():end] if end > 0 else ""
        if re.search(r"\binput_to\s*\(", body):
            out.append("// init_new_player 是互動式的（內部 input_to 問屬性）——繞過")
            out.append('#define ZJ_INIT_NEW(u, o)  catch((u)->setup())')
            out.append(_enter_macro(text))
            # 【WHY 不能在這裡 return】早期版本直接回傳，**跳過了後面的
            # ZJ_MAKE_BODY／ZJ_FIND_BODY／ZJ_RECONNECT 定義**——那些巨集在模板裡
            # 就展開成裸函數名，編譯失敗（Undefined function ZJ_FIND_BODY），
            # 整個 logind 死。症狀是「撥號失敗」，跟互動式 init 完全無關。
            # 用旗標記住決定，其餘照常往下生成。
            _skip_init = True
        else:
            _skip_init = False
    else:
        _skip_init = False

    if _skip_init:
        pass
    else:

        sig = _sig(text, "init_new_player")
        if not sig:
            # 【WHY 退成 setup()】有六台的 logind 根本沒有 init_new_player，
            # 初始化寫在別處。照樣生成呼叫＝`Undefined function`＝整台開不了機。
            # setup() 是 ES2 一系的共同初始化入口，且重複呼叫是冪等的。
            out.append("#define ZJ_INIT_NEW(u, o)  (u)->setup()")
        elif len(sig[0]) >= 2:
            first = sig[0][0].split()[-1].lstrip("*")
            # 參數名字就是意圖：叫 link/ob/login 的那個是登入物件
            args2 = "(o), (u)" if first in ("link", "ob", "login", "login_ob") else "(u), (o)"
            # 【WHY 要補多餘的參數】天下 的簽名是三個參數
            # （`init_new_player(string, object, object)` 之類），少傳就是編譯失敗。
            # 多出來的一律補 0——那是 LPC 裡「沒有值」的通用寫法，
            # 對 int 是 0、對 string／object 是空。
            pad = "".join(", 0" for _ in range(len(sig[0]) - 2))
            # 第一個參數若是 string（不是 object），順序整個不同：把 id 擺前面
            if not sig[0][0].split()[0].startswith("object"):
                args2 = '(u)->query("id"), (u), (o)'[: None] if len(sig[0]) >= 3 else args2
                pad = ""
            out.append(f"#define ZJ_INIT_NEW(u, o)  init_new_player({args2}{pad})")
        else:
            out.append("#define ZJ_INIT_NEW(u, o)  init_new_player(u)")

    sig = _sig(text, "enter_world")
    if not sig or sig[1] or len(sig[0]) <= 2:
        out.append(_enter_macro(text))
    else:
        pad = ", ".join(["0"] * (len(sig[0]) - 2))
        out.append(f"#define ZJ_ENTER(o, u)  enter_world((o), (u), {pad})")

    # 【WHY find_body／reconnect 也要偵測】es1_win／esI 的 logind **沒有**這兩個
    # 函數（它們的重連是別的機制）。模板無條件呼叫就是
    # `Undefined function find_body` → 整個 logind 編譯失敗 → 「撥號失敗」。
    # 退路都有現成的等價物：
    #   find_body  → `find_player()` 是 driver efun，語意相同（找線上的人物）
    #   reconnect  → 直接走 enter_world，差別只是少了「接管舊連線」的最佳化
    # make_body 同理：沒有就用我們自備的最小實作（見模板 zj_make_body）
    out.append("#define ZJ_MAKE_BODY(o)  "
               + ("make_body(o)" if _sig(text, "make_body") else "zj_make_body(o)"))
    if not _sig(text, "find_body"):
        out.append("#define ZJ_FIND_BODY(i)  find_player(i)")
    else:
        out.append("#define ZJ_FIND_BODY(i)  find_body(i)")
    if not _sig(text, "reconnect"):
        out.append("#define ZJ_RECONNECT(o, u)  ZJ_ENTER((o), (u))")
    else:
        out.append("#define ZJ_RECONNECT(o, u)  reconnect((o), (u))")
    return "\n".join(out)


def find_logind(img):
    """找出真正的登入 daemon —— **掃描**，不用固定路徑。

    【WHY】`adm/daemons/logind` 只是**最常見**的位置，不是規範：
    xo 系放在 `system/daemon/logind.lpc`。寫死路徑的話這些台的
    原生登入規則根本不會執行，而報告只顯示「未觸發」——
    看起來像「這台不需要」，其實是「我們沒找到」。
    判準要指得到證據：**檔案裡有沒有 logon() 的定義**。
    """
    # 【WHY 不能只認檔名 logind】笑傲Ⅱ 把**整個登入流程寫在登入物件本身**
    # （`clone/user/login.lpc`），根本沒有獨立的 logind daemon。
    # 只認檔名的話這台的原生登入規則永遠不會執行，而報告寫「未觸發」——
    # 看起來像「這台不需要」，其實是「我們沒找到」。
    # 判準改成**誰真的在跑登入流程**：定義了 logon()，而且用 input_to 一步步問。
    # ★ 最可靠的來源：mudlib **自己宣告**的 LOGIN_D。
    # 【WHY】檔名與位置都可能不同（`adm/daemons/logind`、`system/daemon/logind`…），
    # 但每個 lib 都會在標頭裡寫明登入 daemon 是誰——那是事實，不是猜測。
    # 掃描只是它找不到時的退路。
    # 【WHY 要含 daemon.h／object.h】重生的世界（RWlib kernel 血緣）把
    # `#define LOGIN_D "/system/daemons/login_d"` 寫在 `include/daemon.h`，
    # 不在上面那四個常見標頭裡——於是這一段整個略過，退路的檔名樣式又收不到
    # `login_ob.lpc`（見下面），結果是規則顯示「未觸發」。
    # 「未觸發」看起來像「這台不需要」，實際上是「我們沒找到」——
    # 而那台因此停在 opcode 0/9、telnet 登入走不完。
    for hdr in ("include/globals.h", "include/mudlib.h", "include/config.h",
                "include/login.h", "include/daemon.h", "include/object.h"):
        t = img.text(hdr)
        if not t:
            continue
        # 【WHY 要抓整行】值可能是「巨集 ＋ 字串」的串接
        # （`#define LOGIN_D DAEMON_DIR "logind"`）。用 `[^"\s]+` 會在
        # `DAEMON_DIR` 就停住，把後面的 `"logind"` 丟掉，
        # 於是解出來的路徑是目錄而不是檔案——找不到，而且**靜默**。
        m = re.search(r'#define\s+LOGIN_D\s+([^\n]+)', t)
        if not m:
            continue
        # 【WHY 要解巨集串接】笑傲Ⅱ 寫的是 `#define LOGIN_D DAEMON_DIR "logind"`
        # ——值是**另一個巨集加上字串**。直接拿 `DAEMON_DIR` 當路徑當然找不到檔案，
        # 而失敗是靜默的：規則顯示「未觸發」，看起來像這台不需要原生登入。
        raw = m.group(1).split("//")[0].strip()
        parts = re.findall(r'"([^"]*)"|(\w+)', raw)
        base = ""
        for lit, sym in parts:
            if lit:
                base += lit
            elif sym:
                d = re.search(r'#define\s+' + sym + r'\s+"([^"]*)"', t)
                base += d.group(1) if d else ""
        base = base.strip().lstrip("/")
        # ★ 捷徑也要通過**同一個判準**：那個檔真的定義了 logon()。
        # 【WHY】重生的世界的 `LOGIN_D` 指向 `/system/daemons/login_d`，
        # 但那個檔只管 IP 計數與重複登入偵測——`logon()` 在
        # `/system/object/login_ob.lpc` 裡。捷徑直接回傳 LOGIN_D 的話，
        # 注入會打在一個沒有 logon() 的檔上，然後靜默地什麼都沒發生。
        # 【判準】「宣告的 LOGIN_D」是線索，「有 logon() 定義」才是事實。
        # 線索與事實衝突時，以事實為準——捷徑不成立就往下走掃描。
        for ext in (".lpc", ".c", ""):
            cand = base + ext
            if base and cand in img.files:
                t2 = img.text(cand) or ""
                if re.search(r"^\s*(?:varargs\s+|private\s+|static\s+|nomask\s+|protected\s+|public\s+)*"
                             r"(?:void|int|mixed|object|string)\s+logon\s*\([^)]*\)\s*\{", t2, re.M):
                    return cand
                break

    cands = []
    for path, data in img.sources():
        # 【WHY 放寬檔名】`login_ob.lpc`／`login_d.lpc`／`ppl_login_d.lpc` 都是
        # 真的登入物件，而原本的樣式要求檔名**正好**是 logind 或 login。
        # 判準本來就不是檔名而是「有沒有 logon() 的定義」（見下面），
        # 檔名只是用來縮小掃描範圍——縮得太緊等於把判準架空。
        if not re.search(r"(logind|login|login_\w+|\w+_login\w*)\.(c|lpc)$", path):
            continue
        t = data.decode("utf-8", "replace")
        if not re.search(r"void\s+(?:telnet_)?logon\s*\([^)]*\)\s*\{", t):
            continue
        if "input_to" not in t:
            continue          # 只是轉呼叫別人的殼，不是真正的流程
        # 排序：① 檔名叫 logind ② 位於 adm/ ③ 有 make_body（建角能力在這裡）
        score = (0 if "logind" in path else 1,
                 0 if path.startswith("adm/") else 1,
                 0 if "make_body" in t else 1)
        cands.append((score, path))
    if not cands:
        return None
    cands.sort()
    return cands[0][1]


def _verify(img) -> bool:
    p = find_logind(img)
    t = img.text(p) if p else None
    # 【WHY 不能檢查 `void logon(`】入口函數名不是固定的（笑傲Ⅱ 叫 `StartLogon`）。
    # 用固定名字驗證會對正確的產物報「靜默失效」——**驗證本身變成假警報**，
    # 比不驗還糟：它會讓人去修一個根本沒壞的東西。
    # 判準改成看真正的不變式：注入的四個函數在不在，而且有人呼叫 zj_logon。
    # 【WHY 要接受「本來就是 zjmud」】§D8 的跳過是**正確結果**，不是失效。
    # 自驗若只認我們注入的函數，會對這些台報「規則靜默失效」——
    # 一個假警報比不驗更糟：它會讓人去修一個沒壞的東西。
    if t and MARK not in t and re.search(r'"ver\s*1\.0', t):
        return True
    return bool(t and "zj_get_char" in t and "zj_get_user" in t
                and re.search(r"zj_logon\s*\(", t))


@rule(
    id="login-native-zjmud",
    phase=PHASE_LOGIN,
    desc="把 zjmud 原生登入注入 mudlib 自己的 logind，並把 logon() 導向它",
    why="建角必須呼叫 init_new_player()，它在每一家都是 private——獨立 daemon 叫不到。"
        "注入之後，原生登入走的是這個 mud 原本就在走的那條路。",
    verify=_verify,
)
def inject_native_login(img, ctx):
    # ★ 協議標頭不在就不要注入。
    # 【WHY】火影 的 protocol-panels 因為找不到 look_room 而失敗，
    # `include/zjmud.h` 因此沒被建立；登入規則照樣塞了 `#include <zjmud.h>`
    # → `Cannot #include zjmud.h` → 連鎖出四個語法錯誤 → 整個 logind 死。
    # 結果是「一個階段失敗，把下一個階段也拖下水」，而報告上看起來
    # 像登入規則自己壞了。**規則要檢查自己的前置條件**。
    if "include/zjmud.h" not in img.files:
        return "跳過：include/zjmud.h 不存在（協議注入階段沒成功）"

    # ★ 已經會說 zjmud 的 lib 不要再轉一次。
    #
    # 【WHY】收藏裡有一批**原生 zjmud** 台（終極地獄、nt7…），它們的 logind
    # 本來就有完整的 `ver1.0` 握手與 `get_user`／`get_char` 流程。
    # 再注入一套我們的，兩套會互相打架——實測 nt7 從「可連線」變成
    # `fluffos_connect 失敗`，**轉換讓它變得更糟**。
    # 【判準】logind 裡有沒有既有的版本握手（`ver1.0`）。有就不要碰。
    _p = find_logind(img)
    _t = img.text(_p) if _p else ""
    if _t and MARK not in _t and re.search(r'"ver\s*1\.0', _t):
        # 【WHY 仍要設 native_login】它**確實會說 zjmud**，只是不需要我們注入。
        # 少了這一步，`meta-protocol-zjmud` 不會標記，mud.json 停在 telnet，
        # 客戶端就去跑 telnet 接應器對話——對著一個講 zjmud 的伺服器問
        # 「您的英文名字」，兩邊永遠對不上（nt7 實測停在 24 行）。
        # 「跳過注入」與「這台不是 zjmud」是兩件事，不能混為一談。
        ctx["native_login"] = True
        return "跳過注入：這個 lib 本來就有原生 zjmud 登入流程（仍標記為 zjmud）"

    path = find_logind(img)
    if not path:
        return None
    text = img.text(path)
    notes = []

    # ── 冪等：先把自己上一次寫的東西**整個**清掉 ──
    # 【WHY 不「已存在就跳過」】那樣的話模板改良永遠進不去，而報告顯示成功。
    # 【WHY 清理要涵蓋歷史位置】早期版本把巨集寫在標記**之前**，
    # 而移除是從標記截斷 → 每跑一次多留一份，跑三次就三份。
    # 只要有一次「寫入」與「移除」不對稱，之後每次執行都在累積垃圾。
    text = re.sub(r"\n*// \[zjmud\] 原型：[^\n]*\nvoid \w+\([^)]*\);", "", text)
    n = len(re.findall(r"^#define ZJ_(?:LEGAL_ID|INIT_NEW|ENTER)\b[^\n]*\n?", text, re.M))
    if n:
        text = re.sub(r"^#define ZJ_(?:LEGAL_ID|INIT_NEW|ENTER)\b[^\n]*\n?", "", text, flags=re.M)
        notes.append(f"清掉 {n} 行殘留巨集")
    head = "\n// ══ " + MARK
    if head in text:
        text = text[: text.index(head)]
        notes.append("移除舊版注入")

    if "#include <zjmud.h>" not in text:
        incs = list(re.finditer(r"^#include[^\n]*$", text, re.M))
        ins = incs[-1].end() if incs else 0
        text = text[:ins] + "\n#include <zjmud.h>" + text[ins:]
        notes.append("補 #include <zjmud.h>")

    # ── 原本的 logon() 更名保留 ──
    # 【WHY 保留】出問題時一行切回去比對，不必重跑整個轉換。
    # 【WHY 先看 telnet_logon 在不在】第一次注入已經改過名；第二次再找
    # `void logon(` 會失敗 → 報「找不到登入入口」，**規則對自己的產物不冪等**，
    # 於是「重跑一次確認」反而製造假紅燈。
    # ★ 入口函數不一定叫 `logon`。
    # 【WHY】笑傲Ⅱ 的登入物件呼叫的是 `LOGIN_D->StartLogon(...)`。
    # 只找 `void logon(` 就會判定「這個 lib 的登入入口不是標準寫法」，
    # 而它其實完全正常——只是名字不同。名字要從**呼叫端**讀：
    # 登入物件裡的 `LOGIN_D->XXX` 就是入口。
    entry = "logon"
    for lp, ld in img.sources():
        if re.search(r"(clone/user/login|obj/login|adm/obj/login)\.(c|lpc)$", lp):
            mm = re.search(r"LOGIN_D\s*->\s*(\w+)", ld.decode("utf-8", "replace"))
            if mm:
                entry = mm.group(1)
                break
    if entry != "logon":
        notes.append(f"入口函數＝{entry}()")

    prev = re.search(r"(?<![\w_])void\s+telnet_" + entry + r"\s*\(([^)]*)\)\s*\{", text)
    if prev:
        args = prev.group(1).strip()
        notes.append(f"沿用既有 telnet_{entry}()")
    else:
        # ★ **每一個**定義都要改名，不能只改第一個。
        #
        # 【WHY】有些 lib 的 logind 裡有**兩個以上** `void logon(object ob) {`
        # （不同 #ifdef 分支，或歷史遺留的重複定義）。原本用 re.search 只換
        # 第一個，第二個留在原地——加上我們注入的入口就變成三個同名函數，
        # driver 報 `Redeclaration of function 'logon'`，整個 logind 編譯失敗。
        # 【證據】天涯&碧血江湖（tybxjh）與武林浩荡（wlhd）同時中招，
        # 而上游 meta.json 都標記 playable——**是我們的缺陷不是來源的問題**。
        hits = list(re.finditer(r"(?<![\w_])void\s+" + entry + r"\s*\(([^)]*)\)\s*\{", text))
        if not hits:
            return f"找不到 {entry}()——這個 lib 的登入入口不是標準寫法，需人工處理"
        args = hits[0].group(1).strip()
        # 由後往前替換，才不會讓前面的 offset 失效
        for h in reversed(hits):
            text = text[: h.start()] + f"void telnet_{entry}(" + h.group(1).strip() + ") {" + text[h.end():]
        notes.append(f"原 {entry}() 更名 telnet_{entry}()"
                     + (f"（{len(hits)} 處）" if len(hits) > 1 else ""))

    # 【WHY 要保留完整參數列】xo 系的簽名是 `void logon(string null, object ob)`
    # ——兩個參數，而且物件是**第二個**。生成 `void logon(object ob)` 會讓
    # 呼叫端（登入物件）傳兩個參數進來對不上，整個 logind 編譯失敗。
    # 物件參數用名字找（不管它排第幾個），參數列則原樣保留。
    var = (re.search(r"object\s+(\w+)", args) or [None, "ob"])[1]

    # ── logon() 的前向宣告 ──
    # 【WHY】泥潭的 logind 內部會再呼叫自己的 logon()（「伺服器還在載入 → 等一下重試」
    # 那條路）。改名後那些呼叫點指向定義在**檔尾**的新 logon——LPC 不是兩遍編譯，
    # 用在定義之前一定要有原型，否則 `Undefined function logon`，整個 logind 死。
    if not re.search(r"^\s*void\s+" + entry + r"\s*\([^)]*\)\s*;", text, re.M):
        incs = list(re.finditer(r"^#include[^\n]*$", text, re.M))
        ins = incs[-1].end() if incs else 0
        text = (text[:ins] + f"\n\n// [zjmud] 原型：內部呼叫點在定義之前用到 logon()\n"
                f"void {entry}({args});" + text[ins:])
        notes.append("補 logon() 前向宣告")

    macros = _macros(text)
    # `--debug` 時打開模板裡的 ZJDBG（見模板說明：診斷工具要能先驗證）
    if ctx.get("debug"):
        macros = "#define ZJ_DEBUG  1\n" + macros
    uo = _user_ob(img)
    if uo:
        macros += f'\n#define ZJ_USER_OB  "{uo}"'
        notes.append(f"使用者物件＝{uo}")
    vm = _vitals_macro(img)
    if vm:
        macros += "\n" + vm.rstrip()
        notes.append("生命值保底")
    rm_ = _registered_macro(img)
    if rm_:
        macros += "\n" + rm_.rstrip()
        notes.append("標記為已註冊")
    bm = _born_macro(img)
    if bm:
        macros += "\n" + bm.rstrip()
        notes.append("出生地保底")
    sr = _start_room(img)
    if sr:
        macros += f'\n#define ZJ_START_ROOM  "{sr}"'
        notes.append(f"起始房間＝{sr}")
    body = TMPL.replace("{{MACROS}}", macros)
    text = (text.rstrip() + "\n\n" + body
            + f"\n\n// 入口：登入物件呼叫 LOGIN_D->logon()，一律走 zjmud 原生流程。\n"
              f"void {entry}({args})\n{{\n    zj_logon({var});\n}}\n")
    img.put(path, text)
    notes.append("注入 zj_logon / zj_verify / zj_get_user / zj_get_char")
    ctx["native_login"] = True
    return "；".join(notes)
