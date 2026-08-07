# 匯入與 WASM 落差紀錄 — nt7

> 由 `node webclient/tools/import-lib.mjs` 自動產生，改動皆可重跑複現。

## 來源

| 項目 | 值 |
|------|-----|
| 收藏目錄 | `/mnt/g/GameDevZ/700600_ZJMUD_ALL/zjmud-collection-master/nt7-main` |
| mudlib 根 | `nt7-main` |
| 設定檔 | `（找不到）` |
| 匯入檔數 | 13151（62.5 MB） |
| 略過 | 5 個檔案／目錄（執行檔、備份、日誌、OBJ_DUMP…） |

## 編碼

GBK → UTF-8 轉換 **2** 個檔案。WASM build 只帶演算法式字集，表格式字集（GBK/BIG5）會 raise error，所以整個 lib 必須是 UTF-8。

另有 1 處 `set_encoding("非UTF")` 已改成 `set_encoding("UTF-8")`：

- `adm/kernel/master.c`

## 隱私與憑證

**移除 630 個含密碼欄的玩家存檔**（`data/**/*.o`）。
這些是原營運者的真實玩家資料，對展示站沒有用途，留著只是外洩風險。

- `data/login/a/a113619.o`
- `data/login/a/a1230230.o`
- `data/login/a/a12378900.o`
- `data/login/a/a1324.o`
- `data/login/a/a1324402208.o`
- `data/login/a/a13277473270.o`
- `data/login/a/a13950162525.o`
- `data/login/a/a14615789.o`
- `data/login/a/a147258000.o`
- `data/login/a/a147258388.o`
- …共 630 個

掃描的憑證高風險檔案中未命中特徵。

<!-- boot-test:begin -->
## WASM 開機測試（由建置產生，勿手改）

driver `v2026.0729.0`　最後測試：2026-08-01

分級：**limited** — 開得起來，但登入流程沒走完

> telnet 登入未走完（24 行）

| 項目 | 值 |
|------|-----|
| 映像 | 29288 檔 / 84.4 MB |
| 收到 | 24 行，耗時 31116 ms |
| 握手 | `（telnet：無 zjmud 握手）` |
| 方言 | telnet |
| opcode | （無） |

<!-- boot-test:end -->
