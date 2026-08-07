# 匯入與 WASM 落差紀錄 — shuiyuzhengfeng

> 由 `node webclient/tools/import-lib.mjs` 自動產生，改動皆可重跑複現。

## 來源

| 項目 | 值 |
|------|-----|
| 收藏目錄 | `/mnt/g/GameDevZ/700600_ZJMUD_ALL/zjmud-collection-master/谁与争锋(原版zj)` |
| mudlib 根 | `hell` |
| 設定檔 | `（找不到）` |
| 匯入檔數 | 8345（12.2 MB） |
| 略過 | 3 個檔案／目錄（執行檔、備份、日誌、OBJ_DUMP…） |

## 編碼

GBK → UTF-8 轉換 **8138** 個檔案。WASM build 只帶演算法式字集，表格式字集（GBK/BIG5）會 raise error，所以整個 lib 必須是 UTF-8。

## 隱私與憑證

未發現含密碼欄的玩家存檔。

掃描的憑證高風險檔案中未命中特徵。

<!-- boot-test:begin -->
## WASM 開機測試（由建置產生，勿手改）

driver `v2026.0729.0`　最後測試：2026-08-01

分級：**playable** — 註冊 → 建角 → 進世界整條走得完

> 註冊→建角→進世界完成，收到 8 種 opcode

| 項目 | 值 |
|------|-----|
| 映像 | 8344 檔 / 12.2 MB |
| 收到 | 406 行，耗時 4121 ms |
| 握手 | `ver1.0,$6$/FKOpYPNx6YtOuMD$c2aT/JPEpujL3/p9zu3ok1o4.IBwmPU.ckmhIO9LlJ7iM..Z16s5Ayml/4WHX79WFpLqkFvQEzdpoc.Uf.NJb0` |
| 方言 | dmjh |
| opcode | 000 002 003 004 005 006 012 021 |

### 載入失敗的物件

WASM build 關掉了 sockets/db/external/ffi/crypto/async/compress，用到那些 efun 的檔案會在載入時編譯失敗。driver 仍會繼續開機，只是那些物件不存在（多半是對外連線用的 daemon，在沒有網路的分頁裡本來就沒有意義）。

- `/adm/daemons/payd`

缺少的 efun：`socket_create`、`socket_bind`、`socket_close`

<!-- boot-test:end -->
