"""中繼資料：讓客戶端知道這台說 zjmud。"""
from __future__ import annotations

import json

from .base import PHASE_META, rule


@rule(
    id="meta-protocol-zjmud",
    phase=PHASE_META,
    desc="mud.json 標記 protocol=zjmud、方言 dmjh，移除 telnet 接應器設定",
    why="轉換後 lib 已自己說 zjmud；mud.json 若還寫 telnet，客戶端會去跑接應器對話，"
        "對著一個講 zjmud 的伺服器問「您的英文名字」，兩邊永遠對不上。",
)
def mark_protocol(img, ctx):
    if not ctx.get("native_login"):
        return None
    p = img.root / "mud.json"
    if not p.exists():
        return None
    meta = json.loads(p.read_text("utf-8"))
    before = meta.get("protocol")
    meta["protocol"] = "zjmud"
    meta["dialect"] = "dmjh"          # `ver1.0,` —— 原生台（終極地獄）用的也是這個
    meta.pop("loginProfile", None)
    meta.setdefault("convert", {}).update(family=ctx.get("family"), by="mud2zjmud", nativeLogin=True)
    p.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", "utf-8")
    return f"protocol {before} → zjmud（dmjh）"
