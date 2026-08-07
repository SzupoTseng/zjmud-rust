"""把**已經能跑**的既有工具當成規則接進來。

【WHY 不重寫】`fix-image.mjs` 的 20 條相容性修正與 `convert-to-zjmud.mjs`
的協議注入都已經在 62 台上驗證過。把它們手工翻寫一遍，最好的情況是
「花很多時間得到一樣的東西」，最壞的情況是**靜默偏差**——
regex 差一個字元、副檔名少一種，症狀跟本專案踩過的坑一模一樣。

【推理】builder 的價值在**編排與驗證**，不在重新實作已經正確的東西。
所以這裡只做一件事：以子行程呼叫它們，把 stdout 收成規則的執行紀錄。
哪一天要把某一條真的搬進 Python，也是**一條一條搬、搬完比對產出**，
不是整批重寫。
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from .base import PHASE_COMPAT, PHASE_PROTOCOL, rule

WEBCLIENT = Path(__file__).resolve().parents[3] / "webclient"


def _node(script: str, *args: str) -> str:
    r = subprocess.run(["node", str(WEBCLIENT / "tools" / script), *args],
                       cwd=WEBCLIENT, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip()[-300:])
    return (r.stdout or "").strip()


@rule(
    id="compat-fixups",
    phase=PHASE_COMPAT,
    desc="套用相容性修正（設定檔、is_chinese、名字長度、執行期目錄、euid…共 20 條）",
    why="老 mudlib 在 FluffOS/WASM 上會踩到一整批問題：GBK 位元組長度假設、"
        "空目錄在打包時消失、valid_read 擋掉 load_object…每一條都能讓整台開不了機。",
)
def compat(img, ctx):
    out = _node("fix-image.mjs", img.root.name)
    ctx["reload"] = True          # 子行程直接改了映像，記憶體中的要重讀
    return out.split("：", 1)[-1].strip() if out else "無需修正"


@rule(
    id="protocol-panels",
    phase=PHASE_PROTOCOL,
    desc="注入 zjmud.h、面板 daemon（zjmudd）與 look hook",
    why="面板 opcode（房間／出口／物件／快捷列／狀態條／血條）是 zjmud 客戶端"
        "畫得出畫面的唯一來源；沒有這一步，登入成功也只是一片空白。",
    verify=lambda img: (
        "adm/daemons/zjmudd.lpc" in img.files and "include/zjmud.h" in img.files
    ),
)
def protocol(img, ctx):
    # ★ 已經是 zjmud 的 lib 連面板也不要注入。
    # 【WHY】它們有自己的面板實作（nt7 原生就會送 ESC000）。再塞一份
    # zjmud.h ＋ zjmudd ＋ look hook 會與既有的打架——實測 nt7 從
    # 「可連線」變成開不了機。§D8 的道理對整條流水線都成立，不只登入那一步。
    import re as _re
    from .r50_login import find_logind, MARK
    _p = find_logind(img)
    _t = img.text(_p) if _p else ""
    if _t and MARK not in _t and _re.search(r'"ver\s*1\.0', _t):
        return "跳過：這個 lib 本來就有原生 zjmud 面板與登入"

    fam = ctx.get("family")
    if not fam:
        # 【WHY 要從 mud.json 補讀】用 `--only protocol-panels` 時，
        # 設定 ctx["family"] 的 import 規則不會跑，於是這條規則**靜默跳過**——
        # 報告寫「未觸發」，看起來像「這台不需要」，實際是「我們沒給它資料」。
        # 實測：改了 daemon 模板後重跑 --only，產物完全沒更新，
        # 而我以為是模板沒生效，白查了一輪。
        import json
        mp = img.root / "mud.json"
        if mp.exists():
            fam = (json.loads(mp.read_text("utf-8")).get("convert") or {}).get("family")
        if not fam:
            return None
        ctx["family"] = fam
    args = [img.root.name, "--family", fam]
    look = ctx.get("look")
    if not look:
        # `--only` 時 import 規則不會跑，look 路徑也要能自己找回來
        from .r10_import import detect_look
        look = detect_look(img)
    if look:
        args += ["--look", look]
    _node("convert-to-zjmud.mjs", *args)
    ctx["reload"] = True
    return f"{fam} 家族：zjmud.h ＋ zjmudd ＋ hook 於 {ctx.get('look', '預設 look')}"
