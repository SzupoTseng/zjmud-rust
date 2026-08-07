"""設定檔的必要欄位。"""
from __future__ import annotations

import re

from .base import PHASE_CONFIG2, rule


def _cfg_path(img):
    return img.manifest.get("config") or img.find("config.fluffos", "config.ini", "config")


@rule(
    id="config-required-fields",
    phase=PHASE_CONFIG2,
    desc="補齊 driver 必要的設定欄位（name、mudlib directory…）",
    why="FluffOS 在讀設定檔時就會檢查必要欄位，缺一個就 `*Error in config file. "
        "Missing line: name` 然後 exit(-1)——**driver 根本沒開機**，"
        "而報告只寫 `fluffos_boot 回傳 -1`，看不出是設定檔的問題。"
        "既有的修正只做了路徑正規化與 external_port，沒有管必要欄位。"
        "【WHY 排在相容性之後】相容性階段會**重新產生**設定檔（路徑正規化、補 port），"
        "排在它前面的話補上的欄位會被整個蓋掉——規則有跑、報告顯示成功，"
        "而產物裡什麼都沒有。順序本身就是規則的一部分。",
    verify=lambda img: (lambda t: bool(t) and bool(re.search(r"^\s*name\s", t, re.M)))(
        img.text(_cfg_path(img) or "")),
)
def config_required(img, ctx):
    p = _cfg_path(img)
    if not p:
        return None
    t = img.text(p)
    if t is None:
        return None
    added = []
    # `name` 是 driver 的硬性要求（mud 名稱，會出現在 log 與對外顯示）
    if not re.search(r"^\s*name\s", t, re.M):
        t = f"name : {ctx.get('slug', img.root.name)}\n" + t
        added.append("name")
    if not added:
        return None
    img.put(p, t)
    return f"補上必要欄位：{'、'.join(added)}"
