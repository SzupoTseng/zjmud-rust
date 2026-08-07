"""開機驗證：真的把 mudlib 跑起來、真的登入、真的看房間。

【WHY 不能只驗「檔案有沒有寫進去」】那只證明轉換器動過手。
本專案的每一次「測試全綠但使用者一開就壞」都是這條被違反。
判準要用**行為**：收到房間標題（ESC002）才算畫面上真的有東西。
"""
from __future__ import annotations

import json
import subprocess

from .rules.r30_delegate import WEBCLIENT

# 原生 zjmud 台的完整 opcode 集（實測 終極地獄）
FULL = ["000", "002", "003", "004", "005", "006", "012", "021", "022"]


def boot(lib_dir, timeout=300, retries=1) -> dict:
    """開機驗證。失敗時**重試一次**。

    【WHY】閘門對時序敏感：進世界後面板要幾拍才到，而四路並行掃描時
    CPU 爭用會把那幾拍拖過等待窗口。實測同一台單獨連驗兩次都是 8/9 可玩，
    在並行掃描裡卻回報「登入成功但沒有任何面板」。
    【後果】這種假失敗非常昂貴——本 session 至少三輪在追不存在的回歸，
    每次都要單台重驗才發現是抖動。判準本身不穩，等於沒有判準。
    【推理】重試只在**失敗時**發生，成功的台不會變慢；而真正壞掉的台
    重試一次仍然壞，不會被掩蓋。
    """
    d = _boot_once(lib_dir, timeout)
    while retries > 0 and d.get("badge") != "playable":
        retries -= 1
        d2 = _boot_once(lib_dir, timeout)
        # 取較好的那次：真壞的台兩次都壞，抖動的台第二次會過
        if d2.get("badge") == "playable" or len(d2.get("opcodes", [])) > len(d.get("opcodes", [])):
            d = d2
    return d


def _boot_once(lib_dir, timeout=300) -> dict:
    r = subprocess.run(
        ["node", "tools/boot-test.mjs", str(lib_dir), "--image", "--json"],
        cwd=WEBCLIENT, capture_output=True, text=True, timeout=timeout)
    out = r.stdout or ""
    i = out.find("{")
    if i < 0:
        return {"badge": "error", "reason": (r.stderr or out)[-200:], "opcodes": []}
    return json.loads(out[i:])


def summarize(d: dict) -> str:
    ops = d.get("opcodes", [])
    missing = [o for o in FULL if o not in ops]
    tag = {"playable": "✔ 可玩", "limited": "△ 受限", "noboot": "✘ 開不了機"}.get(d.get("badge"), "？")
    s = f"{tag}　opcode {len(ops)}/9"
    if missing:
        s += f"（缺 {' '.join(missing)}）"
    if d.get("badge") != "playable":
        s += f"　—— {d.get('reason', '')[:60]}"
    return s
