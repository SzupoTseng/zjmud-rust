# 上游有、但**刻意不收**的台

收錄清單是用目錄名算的：

```bash
comm -13 <(ls libs | sort) <(ls …/mudlibs-upstream/libs | sort)
```

所以「決定不收」如果只留在腦子裡或某份 commit 訊息裡，**下一輪會重新發現它一次**，
然後重新查一次上游、重新得到同一個結論。這份檔案就是讓那個決定留在清單旁邊。

（不要用空目錄來「佔位」——那會讓它被當成**已收錄**，
連查都不會去查。詳 `CLAUDE.md` §42。）

| slug | 上游 wasm_status | 不收的理由 |
|---|---|---|
| `hellxg` | `noboot` | hell／zjdywzb 家族的**差異包**，沒有自己的 master object，本來就開不了機（上游原話：diff-only repack … not bootable） |
