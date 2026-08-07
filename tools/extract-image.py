#!/usr/bin/env python3
"""把一台 mud 的映像還原成原始目錄樹 —— 本機檔案或線上網址都可以。

【WHY 要有這支】使用者問「站台可以下載原始 mudlib 嗎」。答案是可以，
而且這不是漏洞是架構的必然：WASM driver 在**瀏覽器裡**跑 mudlib，
整份原始碼必須下載到使用者端才跑得起來。任何託管方式都一樣。

既然如此，就把還原這件事做成正式工具，而不是讓每個人自己拼
`mudlib.json` 的 (at,size) 去切 blob——那正是我在追 bug 時反覆手寫的東西。

【格式】兩個檔：
  mudlib.json     清單：{"files":[{"path","at","size"}...], "dirs":[...]}
  mudlib.data.gz  gzip 過的整包內容；每個檔就是 blob[at : at+size]
（`mudlib.data` 是未壓縮版，版控裡不收——`.gz` 才是發佈的位元組。）

用法：
  python3 tools/extract-image.py libs/sj 還原目錄
  python3 tools/extract-image.py https://szupotseng.github.io/zjmud-rust/libs/sj 還原目錄
  python3 tools/extract-image.py libs/sj --list | head          # 只列檔名
  python3 tools/extract-image.py libs/sj --cat cmds/std/look.lpc  # 只印一個檔
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
import urllib.request
from pathlib import Path


def _read(src: str, name: str) -> bytes:
    """從本機目錄或 http(s) 位址讀一個檔。"""
    if src.startswith(("http://", "https://")):
        with urllib.request.urlopen(src.rstrip("/") + "/" + name) as r:
            return r.read()
    return (Path(src) / name).read_bytes()


def load(src: str) -> tuple[dict, bytes]:
    """回傳 (manifest, blob)。優先用 .gz——那是實際發佈的位元組。"""
    manifest = json.loads(_read(src, "mudlib.json").decode("utf-8"))
    try:
        blob = gzip.decompress(_read(src, "mudlib.data.gz"))
    except Exception:
        # 本機開發樹才有未壓縮版；線上只有 .gz
        blob = _read(src, "mudlib.data")
    total = manifest.get("totalBytes")
    if total is not None and total != len(blob):
        # 這正是 doctor 的第二個不變式。對不上的話後面切出來的每個檔都會錯位，
        # 而症狀會是「某個 .h 檔語法錯誤」——完全指不到真因。
        print(f"⚠ manifest 說 {total} bytes，實際 {len(blob)}——兩者不同步，"
              f"解出來的內容會錯位", file=sys.stderr)
    return manifest, blob


def main() -> int:
    ap = argparse.ArgumentParser(description="還原 zjmud 映像成原始目錄樹")
    ap.add_argument("src", help="映像目錄或線上網址（.../libs/<slug>）")
    ap.add_argument("out", nargs="?", help="輸出目錄")
    ap.add_argument("--list", action="store_true", help="只列出檔名與大小")
    ap.add_argument("--cat", metavar="PATH", help="只印出其中一個檔")
    a = ap.parse_args()

    manifest, blob = load(a.src)
    files = manifest.get("files", [])

    if a.list:
        for f in files:
            print(f"{f['size']:>9}  {f['path']}")
        print(f"\n共 {len(files)} 檔 / {len(blob)} bytes", file=sys.stderr)
        return 0

    if a.cat:
        for f in files:
            if f["path"] == a.cat:
                sys.stdout.write(blob[f["at"]:f["at"] + f["size"]].decode("utf-8", "replace"))
                return 0
        print(f"找不到 {a.cat}", file=sys.stderr)
        return 2

    if not a.out:
        ap.error("要還原成目錄樹的話需要指定輸出目錄（或用 --list / --cat）")
    root = Path(a.out)
    for f in files:
        p = root / f["path"]
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(blob[f["at"]:f["at"] + f["size"]])
    print(f"已還原 {len(files)} 檔到 {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
