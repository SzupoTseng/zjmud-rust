"""CLI —— 一鍵把一般 mudlib 轉成可跑的原生 zjmud lib。

    # 從原始 mudlib 目錄一路做到可跑
    python -m mud2zjmud build --from /path/to/mudlib/work --slug myMud

    # 對既有的 lib 重跑（規則改良後）
    python -m mud2zjmud build libs/xkx2001

    # 只跑某一條規則
    python -m mud2zjmud build libs/xkx2001 --only login-native-zjmud

    # 看規則表 / 驗證現況
    python -m mud2zjmud rules -v
    python -m mud2zjmud verify libs/*
"""
from __future__ import annotations

import argparse
import json
import sys
import os
from pathlib import Path

from .rules import r10_import, r20_config, r30_delegate, r36_readfiles, r50_login, r60_meta, r70_pack  # noqa: F401
from .rules.base import PHASE_NAMES, all_rules
from .runner import build
from .verify import boot, summarize

LIBS = Path(__file__).resolve().parents[2] / "libs"


def cmd_rules(a):
    phase = None
    for r in all_rules():
        if r.phase != phase:
            phase = r.phase
            print(f"\n── [{phase}] {PHASE_NAMES.get(phase, phase)} ──")
        chk = " ✓自驗" if r.verify else ""
        print(f"  {r.id:<22}{chk:<5} {r.desc}")
        if a.verbose and r.why:
            print(f"      為什麼：{r.why}")
    print(f"\n合計 {len(all_rules())} 條規則（{sum(1 for r in all_rules() if r.verify)} 條有自驗）")


def cmd_build(a):
    ctx = {}
    if a.src:
        ctx["src"] = a.src
        ctx["slug"] = a.slug or Path(a.src).parent.name
        lib = LIBS / ctx["slug"]
        lib.mkdir(parents=True, exist_ok=True)
    else:
        lib = Path(a.lib).resolve()
        ctx["slug"] = lib.name
    if a.family:
        ctx["family"] = a.family
    if getattr(a, "debug", False):
        ctx["debug"] = True
    res, _ = build(lib, ctx, only=set(a.only.split(",")) if a.only else None, dry_run=a.dry_run)
    print(res.render())
    if a.no_verify:
        return 0 if res.ok else 1
    print("  ── 開機驗證 ──")
    d = boot(lib)
    print("  " + summarize(d))
    # ★ 把驗證結果寫回 mud.json。
    #
    # 【WHY】builder 每次都真的開機驗證過，卻從不把結果留下來——
    # 於是 `build-site --skip-boot-test` 只能把那些台標成 `unknown`，
    # 而 `sweep-web` 只掃 `playable`，結果是**一台都不會被驗到**
    # （再配上空集合的假綠燈，畫面還會印「全部通過」）。
    # 證據產生了卻沒有保存，等於沒產生。
    try:
        mp = lib / "mud.json"
        if mp.exists():
            meta = json.loads(mp.read_text("utf-8"))
            meta["badge"] = d.get("badge", "unknown")
            meta.setdefault("convert", {})["lastCheck"] = {
                "badge": d.get("badge"), "opcodes": d.get("opcodes", []),
                "reason": (d.get("reason") or "")[:120],
            }
            mp.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", "utf-8")
    except Exception as e:      # 寫不進去不該讓建置失敗
        print(f"  · 驗證結果寫回 mud.json 失敗：{e}")
    return 0 if (res.ok and d.get("badge") == "playable") else 1


def _persist(lib: Path, d: dict):
    """把驗證結果寫回 mud.json。

    【WHY】`build` 與 `verify` 都真的開機驗證過，但只有 build 會留下結果。
    於是抽驗（verify）產生的證據全部蒸發，建站時那些台仍是 `unknown`，
    而 `sweep-web` 只掃 `playable`——**驗過的台反而不會被網頁路徑驗到**。
    兩個入口產生的是同一種證據，就該用同一種方式保存。
    """
    try:
        mp = lib / "mud.json"
        if not mp.exists():
            return
        meta = json.loads(mp.read_text("utf-8"))
        meta["badge"] = d.get("badge", "unknown")
        meta.setdefault("convert", {})["lastCheck"] = {
            "badge": d.get("badge"), "opcodes": d.get("opcodes", []),
            "reason": (d.get("reason") or "")[:120],
        }
        mp.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", "utf-8")
    except Exception:
        pass


def _resync_from_gz(lib: Path) -> bool:
    """從 `.gz` 重建 `.data` 並對齊時間戳。回傳有沒有做事。

    【WHY 需要這個】`mudlib.data` 是 gitignore 的，只有 `.gz` 進版控。
    於是 `git checkout -- libs/<slug>` **只還原 `.gz`**，`.data` 留在舊版——
    而載入端優先讀 `.data`，映像因此錯位。
    症狀極度誤導：某個檔的**開頭被吃掉**（實測 chongshengdeshijie 的
    `simul_efun.lpc` 第一行從 `/* This program is a part of RW mudlib`
    變成 `udlib`），看起來像那個檔壞了或被哪條規則吃掉，
    實際上檔案好好的，只是讀取的視窗偏移了。

    本 session 我手動補救了**三次**（nt7／nitan7／chongshengdeshijie）——
    第三次就該做成工具（CLAUDE.md §18：同一個症狀第三次出現時，
    停下來把它變成可重複執行的檢查）。
    """
    import gzip
    gz, data = lib / "mudlib.data.gz", lib / "mudlib.data"
    if not gz.exists():
        return False
    blob = gzip.decompress(gz.read_bytes())
    if data.exists() and data.read_bytes() == blob:
        return False
    data.write_bytes(blob)
    st = data.stat()
    os.utime(gz, (st.st_atime, st.st_mtime))
    return True


def cmd_doctor(a):
    from .doctor import check
    libs = [Path(x) for x in a.libs] if a.libs else sorted(
        d for d in LIBS.iterdir() if d.is_dir() and (d / "mudlib.json").exists())

    # ★ 指名的路徑不存在要**報錯**，不可以當成通過。
    #
    # 【WHY】`check()` 對「沒有 mudlib.json 的目錄」回空清單（那是給
    # 「不是映像目錄」用的），於是指名一個**打錯的路徑**會印出
    # 「1/1 台通過健檢」。實測踩到：在 `tools/` 底下打 `doctor --fix libs/<slug>`
    # （正確是 `../libs/<slug>`），健檢回報通過，而那台其實 .gz 與 .data 不同步——
    # 全量健檢隨後就抓到了。**假綠燈比紅燈危險**（CLAUDE.md §10）。
    if a.libs:
        missing = [str(x) for x in libs if not (x / "mudlib.json").exists()]
        if missing:
            print("✗ 這些路徑不是映像目錄（沒有 mudlib.json）：" + "、".join(missing))
            print("  （在 tools/ 底下要寫 ../libs/<slug>）")
            return 2
    bad = 0
    fixed = 0

    # ⑥ `libs/` 底下不可以有「只有名字、沒有內容」的目錄。
    #
    # 【WHY】收錄清單是用**目錄名**算的
    # （`comm -13 <(ls libs) <(ls 上游/libs)`），所以一個空目錄會讓那台
    # **被當成已收錄**——清單顯示見底，實際上它從來沒被轉過。
    # 實測 `libs/hellxg/` 就是這樣：完全空的目錄，而上游的 hellxg 有 work/。
    # （查下去它上游自己標 noboot、確實不該收——但那是查了才知道的，
    #  空目錄讓人連查都不會去查。）
    # 【判準】每個目錄都要有 `mud.json`（那是這台的身分證：來源、work、badge）。
    # 這一格只在全量健檢時跑；指定 libs 參數時是局部檢查，不適用。
    if not a.libs:
        hollow = sorted(d.name for d in LIBS.iterdir()
                        if d.is_dir() and not (d / "mud.json").exists())
        if hollow:
            bad += len(hollow)
            for name in hollow:
                print(f"✗ {name}")
                print("    目錄存在但沒有 mud.json——收錄清單會把它當成已收錄，"
                      "這台其實從來沒被轉過")
            libs = libs + [LIBS / n for n in hollow]
    for lib in libs:
        probs = check(lib)
        if probs and getattr(a, "fix", False):
            # 先試著用 `.gz`（版控的真相）重建 `.data`，再驗一次
            if _resync_from_gz(lib):
                probs = check(lib)
                if not probs:
                    fixed += 1
                    print(f"✔ {lib.name}：已從 .gz 重建 .data")
        if probs:
            bad += 1
            print(f"✗ {lib.name}")
            for x in probs:
                print(f"    {x}")
    if fixed:
        print(f"（{fixed} 台由 --fix 從 .gz 重建 .data 後通過）")
    print(f"\n{len(libs) - bad}/{len(libs)} 台通過健檢")
    return 1 if bad else 0


def cmd_verify(a):
    bad = 0
    for lib in a.libs:
        p = Path(lib).resolve()
        d = boot(p)
        _persist(p, d)
        print(f"{Path(lib).name:<28} {summarize(d)}")
        if d.get("badge") != "playable":
            bad += 1
    print(f"\n{len(a.libs) - bad}/{len(a.libs)} 可玩")
    return 1 if bad else 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="mud2zjmud", description="一般 mudlib → 原生 zjmud lib 自動轉換器")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("rules", help="列出轉換規則")
    p.add_argument("-v", "--verbose", action="store_true")
    p.set_defaults(func=cmd_rules)

    p = sub.add_parser("build", help="轉換（可從原始目錄，也可對既有 lib 重跑）")
    p.add_argument("lib", nargs="?", help="既有的 lib 目錄")
    p.add_argument("--from", dest="src", help="原始 mudlib 目錄（通常是 .../work）")
    p.add_argument("--slug", help="輸出名稱")
    p.add_argument("--family", help="強制指定家族（預設自動偵測）")
    p.add_argument("--only", help="只跑指定規則（逗號分隔）")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--debug", action="store_true", help="打開注入程式碼的診斷輸出")
    p.add_argument("--no-verify", action="store_true", help="跳過開機驗證")
    p.set_defaults(func=cmd_build)

    p = sub.add_parser("doctor", help="映像健檢：檢查每一台的不變式")
    p.add_argument("--fix", action="store_true",
                   help="發現問題時先從 .gz 重建 .data 再驗一次"
                        "（git checkout 只還原 .gz，是最常見的錯位來源）")
    p.add_argument("libs", nargs="*", help="不指定就檢查全部")
    p.set_defaults(func=cmd_doctor)

    p = sub.add_parser("verify", help="開機驗證既有的 lib")
    p.add_argument("libs", nargs="+")
    p.set_defaults(func=cmd_verify)

    a = ap.parse_args(argv)
    sys.exit(a.func(a) or 0)


if __name__ == "__main__":
    main()
