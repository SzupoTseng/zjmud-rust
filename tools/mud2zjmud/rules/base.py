"""規則框架。

【WHY 一條規則一個具名單元】原本這些邏輯散在幾支腳本裡，用執行順序隱含相依。
後果實測過三次：`fixLogDirs` 只掃 `.c|.h` 對 `.lpc` 的 lib 靜默失效；
`fixIsChinese` 連漏三次；放寬一條規則讓 14 台一起退步而總數看起來只是「沒進步」。
共同原因是**看不見規則的全貌**——不知道有哪些、各自管什麼、這次跑了哪幾條。

【推理】框架只做四件事，但每件都硬性：
  ① 每條規則有 id、一句話說明、明確 phase（順序由 phase 決定，不靠檔案位置）
  ② run() 回傳「做了什麼」，沒動就回 None → 報告自動產生
  ③ 每條規則可宣告 verify()：轉換完自己檢查有沒有真的生效
  ④ 註冊表可列印、可過濾 → `mud2zjmud rules` 一眼看完
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

PHASE_IMPORT = 10    # 從原始 mudlib 目錄收成映像
PHASE_CONFIG = 20    # 設定檔（名稱、路徑、port）
PHASE_COMPAT = 30    # LPC／driver 相容性
PHASE_CONFIG2 = 35   # 設定檔的最後把關（必須在相容性修正**之後**）
PHASE_PROTOCOL = 40  # zjmud 協議注入（面板）
PHASE_LOGIN = 50     # 原生 zjmud 登入
PHASE_META = 60      # mud.json
PHASE_PACK = 70      # 打包（gzip）

PHASE_NAMES = {
    PHASE_IMPORT: "匯入", PHASE_CONFIG: "設定檔", PHASE_COMPAT: "相容性", PHASE_CONFIG2: "設定檔把關",
    PHASE_PROTOCOL: "協議注入", PHASE_LOGIN: "原生登入",
    PHASE_META: "中繼資料", PHASE_PACK: "打包",
}


@dataclass
class Rule:
    id: str
    phase: int
    desc: str
    fn: Callable
    # 【WHY 需要 why】每條規則都是某個具體故障的解藥。沒有這一欄，
    # 半年後沒人敢刪任何一條——因為不知道拿掉會壞什麼。
    why: str = ""
    # 【WHY 需要 verify】規則「有沒有跑」與「有沒有生效」是兩件事。
    # 靜默失效比明顯失敗危險：不報錯、不警告、報告上一切正常。
    verify: Optional[Callable] = None


REGISTRY: list[Rule] = []


def rule(id, phase, desc, why="", verify=None):
    def deco(fn):
        REGISTRY.append(Rule(id=id, phase=phase, desc=desc, fn=fn, why=why, verify=verify))
        return fn
    return deco


def all_rules() -> list[Rule]:
    return sorted(REGISTRY, key=lambda r: (r.phase, REGISTRY.index(r)))

# ★ 規則「刻意不做」時，note 要以這個字首開頭。
#
# 【WHY】runner 的自驗把「跑了但沒生效」報成 **規則靜默失效** —— 那是很重要的
# 一格（副檔名寫錯、路徑找不到都靠它抓）。但「刻意跳過」會走同一條路：
# 規則回了 note（進 applied）→ verify() 當然說沒生效 → 報告寫「靜默失效」，
# 而且退出碼非零。實測 7 台**原生 zjmud** 就是這樣被報成失敗的
# （hhsj nt7 shujian3 wdxtym wxddym xfbhh zjmudhell）——
# 它們正是 CLAUDE.md §16 要保護的那種「本來就不該被動」的東西。
# 閘門一旦會對正確行為報紅，下一次真的紅了就沒人信。
# 【判準】刻意跳過＝不驗證、不算失敗，但**要在報告上看得見**（列成「⊘ 刻意跳過」）。
SKIP_PREFIX = "跳過："
