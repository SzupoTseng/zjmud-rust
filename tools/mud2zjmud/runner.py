"""跑規則、驗規則、報告。

【WHY 要記錄「沒動」的規則】報告只列有改動的，就看不出
「這條規則根本沒被觸發」與「這條規則判斷不需要改」的差別——
前者往往是 bug（副檔名寫錯、路徑找不到），後者是正常。
兩者在報告上長得一樣，就是靜默失效的溫床。
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .image import MudlibImage
from .rules.base import PHASE_NAMES, SKIP_PREFIX, all_rules


@dataclass
class RunResult:
    slug: str
    applied: list = field(default_factory=list)     # (id, note)
    skipped: list = field(default_factory=list)
    failed: list = field(default_factory=list)      # (id, err)
    unverified: list = field(default_factory=list)  # 跑了但 verify() 說沒生效
    declined: list = field(default_factory=list)    # 規則自己判斷「不該動」（見 SKIP_PREFIX）

    @property
    def ok(self):
        return not self.failed and not self.unverified

    def render(self):
        out = [f"=== {self.slug} ==="]
        for rid, note in self.applied:
            out.append(f"  ✔ {rid:<22} {note}")
        for rid, note in self.declined:
            out.append(f"  ⊘ {rid:<22} {note}")
        for rid in self.unverified:
            out.append(f"  ⚠ {rid:<22} 執行了但驗證沒過——**規則靜默失效**")
        for rid, err in self.failed:
            out.append(f"  ✘ {rid:<22} {err}")
        if self.skipped:
            out.append(f"  · 未觸發 {len(self.skipped)} 條：{' '.join(self.skipped)}")
        return "\n".join(out)


def build(lib_dir, ctx=None, only=None, dry_run=False):
    ctx = dict(ctx or {})
    ctx.setdefault("slug", lib_dir.name)
    img = MudlibImage.load(lib_dir) if (lib_dir / "mudlib.json").exists() else None
    res = RunResult(slug=ctx["slug"])

    for r in all_rules():
        if only and r.id not in only:
            continue
        # 有些規則（匯入／委派）會**在子行程裡直接改映像**，
        # 之後必須重讀，否則後面的規則是在改一份過期的記憶體副本，
        # 存回去就把前面的成果覆蓋掉——這種錯不會報錯，只會「東西不見了」。
        # 【WHY 要容許 img 是 None】第一次建置時映像**還不存在**——
        # 它是 import 規則產生出來的。無條件先載入會直接 FileNotFoundError，
        # 而錯誤訊息指向 image.py，看起來像 I/O 壞了，
        # 其實是「規則的前置條件沒被表達出來」。
        if ctx.pop("reload", False) or (img is None and (lib_dir / "mudlib.json").exists()):
            img = MudlibImage.load(lib_dir)
        if img is None and r.phase > 10:
            res.failed.append((r.id, "映像不存在——匯入階段沒有成功"))
            continue
        try:
            note = r.fn(img, ctx)
        except Exception as e:
            res.failed.append((r.id, f"{type(e).__name__}: {e}"))
            continue
        if note and note.startswith(SKIP_PREFIX):
            # 刻意跳過：不算成功也不算失敗，更**不要**送去 verify()
            # ——見 rules/base.py SKIP_PREFIX 的說明。
            res.declined.append((r.id, note))
            continue
        if note:
            res.applied.append((r.id, note))
            if not dry_run and not ctx.get("reload"):
                img.save()
            if r.verify:
                probe = MudlibImage.load(lib_dir) if ctx.get("reload") else img
                if not r.verify(probe):
                    res.unverified.append(r.id)
        else:
            res.skipped.append(r.id)

    # ★ 只要動過映像，就一定要重新產生 .gz。
    #
    # 【WHY】瀏覽器與開機測試都**優先讀 mudlib.data.gz**（那才是實際發佈的位元組）。
    # 局部執行（`--only`）若沒重新打包，.gz 就停在舊版——
    # 於是「改了之後重測」測到的是改之前的東西。
    # 實測症狀：只跑登入規則後開機變成 `fluffos_boot 回傳 -1`，
    # 因為 .gz 裡的 logind 與 mudlib.data 裡的已經不是同一份。
    # 這是本專案 CLAUDE.md §1 的同一條——**看線上產物，不是看 CI 綠燈**。
    if res.applied and not dry_run:
        # ★ 收工前若還有 pending reload，必須先重讀。
        #
        # 【WHY】委派規則（compat／protocol）是在**子行程**裡改磁碟的，改完設
        # ctx["reload"]。那個旗標原本只在「下一條規則開始時」才被消化——
        # 但如果它是最後一條（例如 --only protocol-panels），就沒有下一條了，
        # 於是最後的強制重新打包把**改動前的記憶體映像**寫回去，
        # 直接蓋掉子行程剛產生的 daemon。
        # 【症狀】規則報告成功、JS 也確實寫了檔，但產物裡什麼都沒變——
        # 我因此三度以為「模板沒生效」，每次都白查一輪。
        if ctx.pop("reload", False):
            img = MudlibImage.load(lib_dir)
        if img is not None:
            img.save(gzip_too=True)
    return res, img
