# 匯入與 WASM 落差紀錄 — zhijianxing

> 由 `node webclient/tools/import-lib.mjs` 自動產生，改動皆可重跑複現。

## 來源

| 項目 | 值 |
|------|-----|
| 收藏目錄 | `/mnt/g/GameDevZ/700600_ZJMUD_ALL/zjmud-collection-master/执剑行(7.0)` |
| mudlib 根 | `执剑行/td-hell4` |
| 設定檔 | `（找不到）` |
| 匯入檔數 | 8873（13.3 MB） |
| 略過 | 2 個檔案／目錄（執行檔、備份、日誌、OBJ_DUMP…） |

## 編碼

GBK → UTF-8 轉換 **8667** 個檔案。WASM build 只帶演算法式字集，表格式字集（GBK/BIG5）會 raise error，所以整個 lib 必須是 UTF-8。

## 隱私與憑證

未發現含密碼欄的玩家存檔。

掃描的憑證高風險檔案中未命中特徵。

<!-- boot-test:begin -->
## WASM 開機測試（由建置產生，勿手改）

driver `v2026.0729.0`　最後測試：2026-08-01

分級：**playable** — 註冊 → 建角 → 進世界整條走得完

> 註冊→建角→進世界完成，收到 10 種 opcode

| 項目 | 值 |
|------|-----|
| 映像 | 8871 檔 / 13.3 MB |
| 收到 | 275 行，耗時 4080 ms |
| 握手 | `ver1.0,$6$z8i6SWGEv6wSy64d$AbhSkTjnW.g909DuE9aQoa2NaJzfNy.3f51LQTCWYjQce2m7E10np/TEwNTmQl8d5d3Da.J7shZWYMDKL.zIn.` |
| 方言 | dmjh |
| opcode | 000 002 003 004 005 006 012 021 022 100 |

### 載入失敗的物件

WASM build 關掉了 sockets/db/external/ffi/crypto/async/compress，用到那些 efun 的檔案會在載入時編譯失敗。driver 仍會繼續開機，只是那些物件不存在（多半是對外連線用的 daemon，在沒有網路的分頁裡本來就沒有意義）。

- `/adm/daemons/payd`

缺少的 efun：`socket_create`、`socket_bind`、`socket_close`

<!-- boot-test:end -->
