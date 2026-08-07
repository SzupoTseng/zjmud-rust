# 匯入與 WASM 落差紀錄 — nitan7

> 由 `node webclient/tools/import-lib.mjs` 自動產生，改動皆可重跑複現。

## 來源

| 項目 | 值 |
|------|-----|
| 收藏目錄 | `/mnt/g/GameDevZ/700600_ZJMUD_ALL/zjmud-collection-master/泥潭七(去后门zj)` |
| mudlib 根 | `nt` |
| 設定檔 | `config.cfg` |
| 匯入檔數 | 29007（85.0 MB） |
| 略過 | 7 個檔案／目錄（執行檔、備份、日誌、OBJ_DUMP…） |

## 編碼

GBK → UTF-8 轉換 **28206** 個檔案。WASM build 只帶演算法式字集，表格式字集（GBK/BIG5）會 raise error，所以整個 lib 必須是 UTF-8。

## 隱私與憑證

**移除 1 個含密碼欄的玩家存檔**（`data/**/*.o`）。
這些是原營運者的真實玩家資料，對展示站沒有用途，留著只是外洩風險。

- `data/login/h/hasee.o`

掃描的憑證高風險檔案中未命中特徵。

<!-- boot-test:begin -->
## WASM 開機測試（由建置產生，勿手改）

driver `v2026.0729.0`　最後測試：2026-08-01

分級：**playable** — 註冊 → 建角 → 進世界整條走得完

> 註冊→建角→進世界完成，收到 1 種 opcode

| 項目 | 值 |
|------|-----|
| 映像 | 29009 檔 / 85 MB |
| 收到 | 180 行，耗時 4805 ms |
| 握手 | `ver1.0,123456789abcd` |
| 方言 | dmjh |
| opcode | 000 |

<!-- boot-test:end -->
