"""打包：產生瀏覽器實際會下載的那份位元組。"""
from __future__ import annotations

from .base import PHASE_PACK, rule


@rule(
    id="pack-gzip",
    phase=PHASE_PACK,
    desc="產生 mudlib.data.gz（瀏覽器用 DecompressionStream 串流解壓）",
    why="LPC 原始碼實測壓到 23-24%。97 台原始碼共 3.7 GB 而 GitHub Pages 上限 1 GB——"
        "不壓縮就放不下；手機上 85 MB 的映像也是最痛的一環，壓到 20 MB 快四倍。",
    verify=lambda img: (img.root / "mudlib.data.gz").exists(),
)
def pack(img, ctx):
    img.save(gzip_too=True)
    raw = (img.root / "mudlib.data").stat().st_size
    gz = (img.root / "mudlib.data.gz").stat().st_size
    return f"{raw // 1048576} MB → {gz // 1048576} MB（{gz * 100 // max(raw, 1)}%）"
