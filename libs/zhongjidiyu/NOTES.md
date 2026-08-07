# 匯入與 WASM 落差紀錄 — zhongjidiyu

> 由 `node webclient/tools/import-lib.mjs` 自動產生，改動皆可重跑複現。

## 來源

| 項目 | 值 |
|------|-----|
| 收藏目錄 | `/mnt/g/GameDevZ/700600_ZJMUD_ALL/zjmud-collection-master/终极地狱(zj)` |
| mudlib 根 | `地狱/hekk` |
| 設定檔 | `（找不到）` |
| 匯入檔數 | 13979（28.8 MB） |
| 略過 | 7 個檔案／目錄（執行檔、備份、日誌、OBJ_DUMP…） |

## 編碼

GBK → UTF-8 轉換 **13708** 個檔案。WASM build 只帶演算法式字集，表格式字集（GBK/BIG5）會 raise error，所以整個 lib 必須是 UTF-8。

## 隱私與憑證

未發現含密碼欄的玩家存檔。

掃描的憑證高風險檔案中未命中特徵。

<!-- boot-test:begin -->
## WASM 開機測試（由建置產生，勿手改）

driver `v2026.0729.0`　最後測試：2026-07-30

分級：**playable** — 註冊 → 建角 → 進世界整條走得完

> 註冊→建角→進世界完成，收到 4 種 opcode

| 項目 | 值 |
|------|-----|
| 映像 | 13978 檔 / 28.8 MB |
| 收到 | 263 行，耗時 4204 ms |
| 握手 | `ver1.0,$6$nvc7M6W7S5AMdU6l$Lhv60nsfM/AuYeMzOxTPb8kYq72n0TYABltshpfqrbZWRbgKjBmzGTud6VS6uV8EKr9ySTgY46Y4KTe0f1Xkf1` |
| 方言 | dmjh |
| opcode | 000 006 012 021 |

### 載入失敗的物件

WASM build 關掉了 sockets/db/external/ffi/crypto/async/compress，用到那些 efun 的檔案會在載入時編譯失敗。driver 仍會繼續開機，只是那些物件不存在（多半是對外連線用的 daemon，在沒有網路的分頁裡本來就沒有意義）。

- `/adm/daemons/payd`

缺少的 efun：`socket_create`、`socket_bind`、`socket_close`

<!-- boot-test:end -->
