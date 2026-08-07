"""登入路徑上 read_file() 的目標檔案。"""
from __future__ import annotations

import re

from .base import PHASE_CONFIG2, rule
from .r50_login import find_logind


def _resolve(img, sym, depth=0):
    """把巨集展開成字串（支援一層串接與遞迴巨集）。"""
    if depth > 3:
        return ""
    for _p, data in img.sources():
        t = data.decode("utf-8", "replace")
        m = re.search(r'#define\s+' + re.escape(sym) + r'\s+([^\n]+)', t)
        if not m:
            continue
        out = ""
        for lit, ref in re.findall(r'"([^"]*)"|(\w+)', m.group(1).split("//")[0]):
            out += lit if lit else _resolve(img, ref, depth + 1)
        return out.strip()
    return ""


@rule(
    id="login-readfile-targets",
    phase=PHASE_CONFIG2,
    desc="替登入流程 read_file() 會讀的檔案建立空檔（禁用名單等）",
    why="西游记2003 的 `check_legal_id()` 第一行就是 "
        "`explode(read_file(BANNED_ID), \"\\n\")`。那個檔在封存時沒被收進來"
        "（它是伺服器的執行期資料），`read_file` 回 0，`explode(0, ...)` 直接拋錯——"
        "帳號檢查永遠失敗，客戶端只收到狀態碼 0001「ID 不合法」。"
        "症狀完全誤導：看起來像帳號規則太嚴，實際上是**一個空檔案不見了**。",
)
def ensure_readfiles(img, ctx):
    path = find_logind(img)
    if not path:
        return None
    text = img.text(path) or ""
    # 巨集或字面路徑都要解：`read_file(BANNED_ID)` / `read_file("/adm/etc/banned")`
    targets = set()
    for m in re.finditer(r'read_file\s*\(\s*("?)([A-Za-z_/][\w/.]*)\1', text):
        tok = m.group(2)
        if tok.startswith("/"):
            targets.add(tok)
            continue
        # 巨集：到各標頭找它的值。
        # 【WHY 要解串接】值常常是「另一個巨集 ＋ 字串」
        # （`#define BANNED_ID DATA_DIR "banned_id"`）。只認純字串的話，
        # 這一條規則對整批用串接寫法的 lib **靜默失效**——
        # 檔案沒建、報告顯示成功，而登入照樣被 0001 擋下。
        # 這與 find_logind 解 LOGIN_D 是同一個問題，寫法也一致。
        val = _resolve(img, tok)
        if val:
            targets.add(val)

    made = []
    for t in targets:
        rel = t.lstrip("/")
        # 【WHY 要排除目錄】巨集有時解出來是**目錄**（`#define X DATA_DIR` 這種，
        # 或串接的後半段沒解出來）。把目錄當檔案建進映像，解包時就是
        # `寫入 adm/etc/ 失敗（errno 31）`——而那個錯誤發生在載入階段，
        # 症狀是 **boot-test 整個拋例外**，看起來像測試工具壞了，
        # 完全不會有人聯想到是某條規則建了一個不該存在的「檔案」。
        # 【證據】泥潭系 nitan6／nitan170911：BANNED_ID 解到 `/adm/etc/`。
        if rel.endswith("/") or not rel.rsplit("/", 1)[-1]:
            continue
        # 已經是目錄（映像裡有以它為前綴的檔案）也不能當檔案建
        if any(p.startswith(rel + "/") for p in img.files):
            continue
        if rel and rel not in img.files:
            # 【WHY 空檔而不是省略】mudlib 要的是「讀得到一個（可能空的）名單」。
            # 給空檔，行為等同「名單是空的」——最保守，不會誤擋任何帳號。
            img.put(rel, "")
            made.append(rel)
    return f"建立 {len(made)} 個缺件：{'、'.join(made[:3])}" if made else None
