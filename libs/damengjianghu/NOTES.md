# 匯入與 WASM 落差紀錄 — damengjianghu

> 由 `node webclient/tools/import-lib.mjs` 自動產生，改動皆可重跑複現。

## 來源

| 項目 | 值 |
|------|-----|
| 收藏目錄 | `/mnt/g/GameDevZ/700600_ZJMUD_ALL/zjmud-collection-master/大梦江湖(新协议版)` |
| mudlib 根 | `dmjh` |
| 設定檔 | `（找不到）` |
| 匯入檔數 | 9357（14.7 MB） |
| 略過 | 4 個檔案／目錄（執行檔、備份、日誌、OBJ_DUMP…） |

## 編碼

GBK → UTF-8 轉換 **13** 個檔案。WASM build 只帶演算法式字集，表格式字集（GBK/BIG5）會 raise error，所以整個 lib 必須是 UTF-8。

## 隱私與憑證

**移除 54 個含密碼欄的玩家存檔**（`data/**/*.o`）。
這些是原營運者的真實玩家資料，對展示站沒有用途，留著只是外洩風險。

- `data/login/a/a111000a.o`
- `data/login/a/a15189378113.o`
- `data/login/a/a2099849153.o`
- `data/login/a/a243.o`
- `data/login/a/aa1354309.o`
- `data/login/a/asd123gyn.o`
- `data/login/a/asdf.o`
- `data/login/a/asdgao.o`
- `data/login/a/azxsa7.o`
- `data/login/b/beidao.o`
- …共 54 個

掃描的憑證高風險檔案中未命中特徵。

<!-- boot-test:begin -->
## WASM 開機測試（由建置產生，勿手改）

driver `v2026.0729.0`　最後測試：2026-08-01

分級：**playable** — 註冊 → 建角 → 進世界整條走得完

> 註冊→建角→進世界完成，收到 11 種 opcode

| 項目 | 值 |
|------|-----|
| 映像 | 9356 檔 / 14.7 MB |
| 收到 | 270 行，耗時 18763 ms |
| 握手 | `（此伺服器不送版本挑戰）` |
| 方言 | （未判定） |
| opcode | 000 002 003 004 005 014 111 234 517 604 605 |

<!-- boot-test:end -->
