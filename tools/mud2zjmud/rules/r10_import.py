"""匯入 ＋ 家族偵測。"""
from __future__ import annotations

import re

import subprocess
from pathlib import Path

from .base import PHASE_IMPORT, rule
from .r30_delegate import WEBCLIENT

LIBS = Path(__file__).resolve().parents[3] / "libs"

# 家族指紋：靠**目錄佈局**與**屬性欄位**判定，不靠 mud 名字。
#
# 【WHY 不看名字】收藏裡同一款遊戲有十幾種改版，名字五花八門；
# 而真正決定「面板要讀哪些欄位」的是它繼承自哪一支 mudlib。
# 【證據】掃過 98 台：`inherit/` 佈局 ⟺ qi/neili（ES2／侠客行系，46 台）；
# `std/` 佈局 ⟺ gin/kee/sen（東方故事系，35 台）。
FAMILY_PROBES = [
    ("es2-inherit", ["inherit/room/room.lpc", "inherit/room/room.c"], ("max_qi", "max_neili")),
    ("gks-std", ["std/room/room.lpc", "std/room/room.c"], ("max_kee", "max_gin")),
    ("gks-system", ["cmds/verb/look.lpc", "cmds/verb/look.c"], ("max_kee",)),
    ("es1-body", ["cmds/std/_look.lpc", "cmds/std/_look.c"], ("max_hp",)),
    ("hpmp-std", ["std/room.lpc", "std/room.c"], ("max_hp", "max_mp")),
]


def detect_family(img) -> str | None:
    """回傳家族代號；認不出來回 None（呼叫端要求人工指定）。"""
    # 【WHY 掃全樹而不是只看 user.c】重生的世界 的角色物件不叫 user/char，
    # 只看那兩個檔名等於什麼都沒掃到（fields 是空的），家族判定直接放棄，
    # 而報告只寫「認不出家族」——看不出是**掃描範圍太窄**還是真的不支援。
    # 屬性欄位在整棵樹裡到處出現（NPC、技能、指令），統計次數比找特定檔案可靠。
    counts = {f: 0 for f in ("max_qi", "max_neili", "max_kee", "max_gin", "max_hp", "max_mp")}
    for _path, data in img.sources():
        t = data.decode("utf-8", "replace")
        for f in counts:
            if f in t:
                counts[f] += 1
    fields = {f for f, n in counts.items() if n >= 3}   # 出現在 3 個以上檔案才算數
    for fam, layout, want in FAMILY_PROBES:
        if any(p in img.files for p in layout) and any(w in fields for w in want):
            return fam
    # 退而求其次：只看佈局
    for fam, layout, _ in FAMILY_PROBES:
        if any(p in img.files for p in layout):
            return fam
    # 【WHY 還要一層純欄位判定】重生的世界 這種變體把目錄佈局改掉了，
    # 靠佈局完全認不出來（實測 `認不出家族`，整台停在第一步）。
    # 但**屬性欄位不會變**——面板要讀什麼，決定於角色物件有哪些欄位，
    # 那才是家族的本質，目錄佈局只是它的常見外觀。
    if "max_kee" in fields or "max_gin" in fields:
        return "gks-std"
    if "max_qi" in fields or "max_neili" in fields:
        return "es2-inherit"
    if "max_mp" in fields:
        return "hpmp-std"
    if "max_hp" in fields:
        return "es1-body"
    # ★ 一個屬性欄位都認不出來時，只要**找得到 look_room** 就仍然可以轉。
    #
    # 【WHY】重生的世界 的屬性用了完全不同的命名（掃不到任何 max_*），
    # 家族偵測因此直接放棄，整台停在第一步——而它的
    # `cmds/std/ppl/look.lpc` 裡明明有 look_room()，面板注入完全可行。
    # 【WHY 現在猜錯沒有代價】狀態條已經改成**聯集**（送出實際有值的那幾條），
    # 房間介面也是雙套都試。家族在這個階段只剩「預設 look 路徑」的作用，
    # 而那個路徑我們本來就會用 detect_look() 掃出來。
    # 【推理】能轉就轉，轉完由開機驗證決定它到底行不行——
    # 比在偵測階段就放棄有用得多。
    if detect_look(img):
        return "es2-inherit"
    return None


def detect_look(img) -> str | None:
    """找出真正定義 `look_room()` 的那個檔。

    【WHY 不用家族常數】家族設定裡的 look 位置是歸納出來的**常見值**，
    變體會放在別處：ds386（hpmp-std）沒有 `cmds/std/look.lpc`，
    於是轉換直接失敗——而檔案其實就在旁邊。
    判準要指得到證據：**檔案裡有沒有 look_room 的定義**。
    """
    cands = []
    for path, data in img.sources():
        # 【WHY 放寬到 verbs/ 與任意深度】各家把 look 放在不同地方：
        # `cmds/std/look`、`cmds/verb/look`、`cmds/std/ppl/look`、`verbs/items/look`。
        # 寫死一種等於只支援一種佈局。
        if not re.search(r"(cmds|verbs)/.*/_?look\.(c|lpc)$", path):
            continue
        t = data.decode("utf-8", "replace")
        # 【WHY 要求 `)` 後面接 `{`】只寫 `look_room\s*\(` 會抓到**呼叫**：
        #   `msg += (env->query_module_file())->look_room(env) || "";`
        # 於是 builder 認定這個檔案可以注入，實際上裡面沒有 look_room 的本體，
        # 轉換到最後才報「沒有 look_room() 的標準結尾」——而錯誤訊息指向「結尾」，
        # 真正的問題在**這個判準一開始就抓錯了東西**。
        # 這條紀律 spec §C3 早就寫過（前向宣告 vs 定義），
        # 但新寫的偵測函數沒有套用——每個新增的偵測點都要重新確認一次。
        if re.search(r"(?:varargs|private|static|protected|nomask|public)?\s*"
                     r"(?:int|void|mixed|string|object)\s+look_(?:room|in_room)"
                     r"\s*\([^)]*\)\s*\{", t):
            cands.append((0, path))          # 有 look_room **定義**：最優先
        elif re.search(r"\bint\s+main\s*\(\s*object\s+\w+\s*,\s*string\s+\w+\s*\)\s*\{", t):
            # 【WHY 要收這種】火影 的 look 指令沒有 look_room——
            # 房間顯示直接寫在 `int main(object me, string arg)` 裡。
            # 偵測端若不放寬，`--look` 就傳不出去，注入端的退路等於白做：
            # **兩端的判準必須同步**，否則放寬一邊等於沒放寬。
            cands.append((1, path))
        elif "look_room" in t:
            cands.append((2, path))
    if not cands:
        return None
    cands.sort()
    return cands[0][1]


@rule(
    id="import-tree",
    phase=PHASE_IMPORT,
    desc="從原始 mudlib 目錄匯入成映像，並自動判定家族",
    why="原始樹是別人伺服器的完整備份：含 log、玩家存檔（明文密碼）、"
        "以及一堆執行期狀態。匯入要挑掉這些，並把家族判出來——"
        "家族決定面板要讀哪些屬性欄位，判錯的話血條會全空。",
)
def import_tree(img, ctx):
    src = ctx.get("src")
    notes = []
    if src:
        subprocess.run(
            ["node", str(WEBCLIENT / "tools" / "import-telnet.mjs"),
             "--from", str(src), "--slug", ctx["slug"], "--title", ctx.get("title", ctx["slug"]),
             "--profile", "generic-cn", "--subtitle", "mud2zjmud 自動轉換"],
            cwd=WEBCLIENT, capture_output=True, text=True, check=True)
        ctx["reload"] = True
        notes.append(f"匯入 {src}")
    # 匯入之後才有映像可以判家族——所以這裡自己重讀一次，
    # 而不是用外面傳進來的（第一次建置時那還是 None）。
    from ..image import MudlibImage
    img = MudlibImage.load(LIBS / ctx["slug"])
    fam = ctx.get("family") or detect_family(img)
    if not fam:
        raise RuntimeError(
            "認不出家族——這台的屬性欄位不在已知的六種之列，可能是別的血緣"
            "（例如 Dead Souls／LPUniversity 系的 lib/events + verbs + domains 佈局）。"
            "確認之後用 --family 指定，或先為它新增一個家族定義。")
    ctx["family"] = fam
    notes.append(f"家族＝{fam}")
    look = detect_look(img)
    if look:
        ctx["look"] = look
        notes.append(f"look＝{look}")
    return "；".join(notes)
