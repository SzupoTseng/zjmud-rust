"""mudlib 映像的讀寫（與瀏覽器端 mudlibimage.js 位元組相容）。

【WHY 自己定格式】官方 pack-mudlib.sh 需要整套 emsdk 才能跑 file_packager，
而我們要的只是「一堆檔案 → 一個 blob ＋ 一張表」。

【推理】這個檔案唯一的職責是忠實讀寫：不排序、不去重、不正規化路徑。
任何加工都屬於 rules，不屬於這裡——混在一起的話，
「是規則做的還是 I/O 做的」就再也分不清楚。
"""
from __future__ import annotations

import gzip
import json
from dataclasses import dataclass, field
from pathlib import Path

IMAGE_FORMAT = 1
# 這些目錄是別人伺服器的執行狀態／隱私，一律不收
SKIP_DIRS = {"log", "backup", "queue", "tmp", ".git", ".svn"}
SKIP_SUFFIX = (".o",)          # 玩家存檔（含明文密碼）


@dataclass
class MudlibImage:
    root: Path
    manifest: dict
    files: dict[str, bytes] = field(default_factory=dict)

    # ── 從既有映像讀 ──
    @classmethod
    def load(cls, root) -> "MudlibImage":
        root = Path(root)
        manifest = json.loads((root / "mudlib.json").read_text("utf-8"))
        # ★ `mudlib.data` 是**真相來源**，`.gz` 只是它的衍生物。
        #
        # 【WHY】原本優先讀 `.gz`，但委派給 JS 工具的步驟（fix-image／
        # convert-to-zjmud）**只寫 `mudlib.data`**。於是每次 JS 改完之後，
        # Python 重讀時拿到的是**舊的 .gz**，接著存檔就把 JS 的成果整個蓋掉。
        # 【症狀】規則報告成功、JS 也確實寫了檔，但產物裡什麼都沒變——
        # 這個 bug 讓我在好幾輪裡以為「模板沒生效」，反覆改同一個地方。
        # 【判準】只有在 `.data` 不存在時才回頭用 `.gz`。
        raw = root / "mudlib.data"
        gz = root / "mudlib.data.gz"
        blob = raw.read_bytes() if raw.exists() else gzip.decompress(gz.read_bytes())
        files = {f["path"]: blob[f["at"]: f["at"] + f["size"]] for f in manifest["files"]}
        return cls(root=root, manifest=manifest, files=files)

    # ── 從原始 mudlib 目錄匯入 ──
    @classmethod
    def from_tree(cls, src, out, *, mount="/mudlib") -> "MudlibImage":
        """走訪原始 mudlib 目錄，收成映像。

        【WHY 要跳過 data/**/*.o】那是玩家存檔，裡面有**明文密碼**。
        封存別人的 mudlib 可以，散播別人的帳號不行——
        這條在 `scripts/privacy-scan.sh` 也會再擋一次，兩道防線。
        """
        src, out = Path(src), Path(out)
        files: dict[str, bytes] = {}
        for p in sorted(src.rglob("*")):
            if not p.is_file():
                continue
            rel = p.relative_to(src).as_posix()
            parts = rel.split("/")
            if parts[0] in SKIP_DIRS or rel.endswith(SKIP_SUFFIX):
                continue
            files[rel] = p.read_bytes()
        out.mkdir(parents=True, exist_ok=True)
        return cls(root=out, manifest={"format": IMAGE_FORMAT, "mount": mount, "dirs": []}, files=files)

    # ── 寫回 ──
    def save(self, *, gzip_too: bool = False) -> None:
        # 【WHY 要自己補齊所有祖先目錄】載入端為了速度不會在寫檔前 mkdirp，
        # dirs 漏一層就拋 `ErrnoError errno 44`，而訊息裡連是哪個檔都沒有。
        dirs = set(self.manifest.get("dirs", []))
        for p in self.files:
            parts = p.split("/")
            for i in range(1, len(parts)):
                dirs.add("/".join(parts[:i]))

        # ★ 同一個名字不能既是目錄又是檔案。
        #
        # 【WHY】`login-readfile-targets` 會替 read_file() 的目標建空檔，
        # 而那個路徑在原始樹裡可能**本來就是目錄**（sje 的 open/freeze_list、
        # open/topten 就是）。dirs 照舊留著、files 又多一筆同名的，
        # 載入端先 mkdir 再寫檔 → `寫入 open/freeze_list 失敗（errno 31）`。
        # 【症狀有多難查】errno 31 是 EMLINK，訊息看起來像 driver 或 FS 壞了；
        # 而 doctor 的三個不變式（.gz 存在／不比 .data 舊／manifest 對得上 blob）
        # 全部通過——健檢說健康，實際一解包就炸。這一台害整個 build-site
        # 死在第 106 台，前面 105 台的結果全部沒寫進索引。
        # 【判準】檔案優先：既然有內容要寫，就把那個空的目錄項拿掉。
        # 只拿掉**沒有任何子項**的，有子項的代表是真目錄、衝突另有原因。
        clash = {d for d in dirs if d in self.files}
        for d in sorted(clash):
            if not any(f.startswith(d + "/") for f in self.files):
                dirs.discard(d)

        chunks, listing, at = [], [], 0
        for path, data in self.files.items():
            listing.append({"path": path, "at": at, "size": len(data)})
            chunks.append(data)
            at += len(data)
        blob = b"".join(chunks)

        m = dict(self.manifest)
        m.update(format=IMAGE_FORMAT, totalBytes=len(blob),
                 # 父目錄必須排在子目錄前面——載入端是照順序 mkdir 的
                 dirs=sorted(dirs, key=lambda d: (d.count("/"), d)), files=listing)
        (self.root / "mudlib.json").write_text(json.dumps(m, ensure_ascii=False, separators=(",", ":")), "utf-8")
        (self.root / "mudlib.data").write_bytes(blob)
        if gzip_too:
            # LPC 原始碼實測壓到 23-24%；GitHub Pages 上限 1 GB，不壓縮放不下
            (self.root / "mudlib.data.gz").write_bytes(gzip.compress(blob, 9))
        self.manifest = m

    # ── 便利存取 ──
    def text(self, path: str):
        raw = self.files.get(path)
        return None if raw is None else raw.decode("utf-8", "replace")

    def put(self, path: str, text: str) -> None:
        self.files[path] = text.encode("utf-8")

    def find(self, *suffixes: str):
        """找第一個以任一 suffix 結尾的路徑。

        【WHY 要多個 suffix】收藏裡有的用 `.c`、有的用 `.lpc`
        （mudlibs-main 整棵樹都是 `.lpc`）。只寫一種的規則會**靜默失效**：
        不報錯、不警告、報告上一切正常。本專案踩過三次。
        """
        for path in self.files:
            if any(path.endswith(s) for s in suffixes):
                return path
        return None

    def sources(self):
        """走訪所有 LPC 原始碼。副檔名一律含 `.lpc`（見 find()）。"""
        for path, data in self.files.items():
            if path.endswith((".c", ".h", ".lpc")):
                yield path, data
