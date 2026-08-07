"""映像健檢：檢查每一台的不變式。

【WHY 做成常駐工具而不是一次性指令】本 session 三度遇到「映像位元組錯位」，
每次都當成個案還原，其實是同一個根因（`.gz` 沒跟著 `.data` 更新）。
個案還原不會累積成防線——**能重複執行的檢查才會**。

五個不變式，任一不成立都會讓 driver 載到錯的東西或讓使用者看到不該看的東西，
而症狀都極度誤導：

  ① `.gz` 不比 `.data` 舊 —— 載入端優先讀 `.gz`，舊的 `.gz` 裡 offset 對應
     舊內容，解出來的 `include/globals.h` 變成別的檔案的片段，
     報「syntax error」，看起來像那台 mudlib 自己壞了。
  ② manifest 的 (at,size) 與 blob 對得上 —— 打包時 offset 與內容不同步，
     整台無聲損壞。
  ③ 每台都有 `.gz` —— 版控只留 `.gz`，缺了 CI checkout 就拿不到資料，
     boot-test 直接 ENOENT（實測讓 CI 連續失敗）。
  ④ 同一個名字不可以既是目錄又是檔案 —— 載入端先照 dirs 建目錄再寫 files，
     撞名時寫檔拋 errno 31（EMLINK），訊息看起來像 driver 或檔案系統壞了。
     **這一格是補的**：sje 的 `open/freeze_list` 正是撞名，而前三個不變式
     全部通過——健檢說健康、一解包就炸，而且它讓整個 build-site 死在
     第 106 台，前面 105 台的結果全部沒寫進索引。
     健檢漏一格，那一格就會變成別人替你發現的故障（CLAUDE.md 核心原則）。
  ⑤ 產物裡不可以有 `#define ZJ_DEBUG` —— 那是 `--debug` 建置留下的，
     會讓 logind 把 `DBG …` 診斷訊息（ESC015）噴給**真的玩家**。
     診斷時很自然會建 debug 版，然後很自然地忘記換回來；實測一次就留下 5 台
     （其中一台還是好幾輪以前留的，沒人發現）。這種「靠人記得」的東西
     一律該變成檢查。
"""
from __future__ import annotations

import gzip
import json
from pathlib import Path


def check(lib: Path) -> list[str]:
    """回傳這一台的問題清單；空清單＝健康。"""
    bad = []
    mj, data, gz = lib / "mudlib.json", lib / "mudlib.data", lib / "mudlib.data.gz"
    if not mj.exists():
        return []                       # 不是映像目錄（例如只有 work/）

    # ③ 一定要有 .gz
    if not gz.exists():
        bad.append("缺 mudlib.data.gz（版控只留 .gz，CI 會拿不到資料）")

    # ①-b `.gz` 也不可比 `mudlib.json` 舊。
    #
    # 【WHY】原本只比對 `.gz` 與 `.data`——但 CI 拿到的是 git 裡的
    # `mudlib.json` ＋ `.gz`，而**這兩個檔可能來自不同的 commit**。
    # 實測 nt7／zhongjidiyu：工作區完全乾淨（`.data` 與 `.gz` 同步），
    # 但 git 裡的 `mudlib.json` 比 `.gz` 新，於是 CI checkout 出來
    # 就是一組對不上的 manifest 與 blob，driver 報
    # 「simul_efun 與 master 必須 loadable」——完全指不到真因。
    # 【判準】manifest 是索引、`.gz` 是內容，索引改了內容就必須跟著重生。
    # 【WHY 只在**內容也對不上**時才報】mtime 差幾秒是 checkout 的寫入順序造成的，
    # 不代表不同步——實測 hymud 在 worktree 裡 `.gz` 比 `mudlib.json` 舊 1 秒，
    # 而 totalBytes 與解壓後的長度完全一致（129583612）。
    # 時間戳只是**線索**，內容才是事實。用線索當判準會製造假陽性，
    # 而假陽性會讓整個健檢失去公信力——下次真的壞了也沒人相信。
    if mj.exists() and gz.exists() and gz.stat().st_mtime < mj.stat().st_mtime - 60:
        try:
            man0 = json.loads(mj.read_text("utf-8"))
            if man0.get("totalBytes") != len(gzip.decompress(gz.read_bytes())):
                bad.append("mudlib.data.gz 比 mudlib.json 舊，且 totalBytes 對不上"
                           "（索引與內容來自不同時間點，CI 會載到對不上的組合）")
        except Exception:
            pass

    # ① .gz 不可比 .data 舊
    if data.exists() and gz.exists() and gz.stat().st_mtime < data.stat().st_mtime - 1:
        bad.append(f"mudlib.data.gz 比 .data 舊 {int(data.stat().st_mtime - gz.stat().st_mtime)} 秒"
                   "（driver 會載到舊映像）")

    # ⑤ 不可以帶著 --debug 建置出貨
    try:
        import gzip as _gz
        man5 = json.loads(mj.read_text("utf-8"))
        blob = None
        if data.exists():
            blob = data.read_bytes()
        elif gz.exists():
            blob = _gz.decompress(gz.read_bytes())
        if blob:
            for f in man5.get("files", []):
                if "logind" not in f["path"]:
                    continue
                chunk = blob[f["at"]:f["at"] + f["size"]]
                if b"#define ZJ_DEBUG" in chunk:
                    bad.append(f"{f['path']} 帶著 #define ZJ_DEBUG"
                               "——這是 --debug 建置，會把 DBG 訊息噴給真的玩家")
                    break
    except Exception:
        pass

    # ④ 目錄與檔案不可同名
    try:
        man4 = json.loads(mj.read_text("utf-8"))
        paths = {f["path"] for f in man4.get("files", [])}
        clash = sorted(d for d in man4.get("dirs", []) if d in paths)
        if clash:
            bad.append(f"目錄與檔案同名 {len(clash)} 處（{', '.join(clash[:3])}）"
                       "——載入端會在 mkdir 之後寫不進去，errno 31")
    except Exception:
        pass

    # ② manifest 與 blob 對得上（抽樣）
    try:
        man = json.loads(mj.read_text("utf-8"))
        # ★ 有 `.gz` 就**兩份都驗**。
        #
        # 【WHY】原本 `.data` 存在時就只驗 `.data`——而 CI 拿到的是 `.gz`。
        # 實測 zhongjidiyu：`.data` 與 manifest 完全一致（本機全過），
        # 但 git 裡的 `.gz` 比 manifest 少 3 bytes 且內容偏移，
        # CI 一 checkout 就開不了機（`simul_efun 與 master 必須 loadable`）。
        # **健檢要驗的是「會被載入的那份」，而那在不同環境下是不同的檔案。**
        blobs = []
        if data.exists():
            blobs.append(("mudlib.data", data.read_bytes()))
        if gz.exists():
            blobs.append(("mudlib.data.gz", gzip.decompress(gz.read_bytes())))
        blob = blobs[0][1] if blobs else b""
        for name, b in blobs[1:]:
            if len(b) != len(blob):
                bad.append(f"{name} 解出來 {len(b)} bytes，與 mudlib.data 的 {len(blob)} 不符"
                           "（兩份不同步，CI 會載到錯的那份）")
        files = man.get("files", [])
        if files:
            total = man.get("totalBytes")
            if total is not None and total != len(blob):
                bad.append(f"totalBytes={total} 與實際 blob {len(blob)} 不符")
            step = max(1, len(files) // 8)
            for f in files[::step][:8]:
                end = f["at"] + f["size"]
                if end > len(blob):
                    bad.append(f"{f['path']} 的範圍超出 blob 尾端")
                    break
            # 內容抽驗：找一個一定是文字的檔，看解出來像不像它自己
            for f in files:
                if f["path"].endswith("include/globals.h"):
                    seg = blob[f["at"]: f["at"] + min(f["size"], 200)]
                    txt = seg.decode("utf-8", "replace")
                    # globals.h 開頭應該是註解或 #define/#include，不會是句子中段
                    if txt and not txt.lstrip().startswith(("/", "#", "\n")):
                        bad.append(f"globals.h 的內容看起來錯位：{txt[:40]!r}")
                    break
    except Exception as e:
        bad.append(f"讀取失敗：{type(e).__name__}: {e}")
    return bad
