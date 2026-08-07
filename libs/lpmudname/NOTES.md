# WASM 落差紀錄 — 江湖论剑

> 由 `node webclient/tools/boot-test.mjs` 實測，非人工推測。

## 分級：playable

註冊 → 建角 → 進世界整條走得完，收到 opcode `000` / `006` / `021`。

## 載入失敗的物件（3 個）

WASM build 沒有 `package sockets`，以下 preload daemon 在載入時編譯失敗
（`Undefined function socket_create` 等共 13 處）：

| 物件 | 原本做什麼 | 在 WASM 上的後果 |
|------|-----------|-----------------|
| `/adm/daemons/kuafu` | 跨服連線（socket 監聽） | 跨服功能不存在 |
| `/adm/daemons/qqd` | QQ 相關對外服務 | 不存在 |
| `/adm/daemons/miraid` | 對外通報 | 不存在 |

driver **照常完成開機**——這三個是 `preload` 清單裡的項目，載入失敗只會讓那個
物件不存在，不會中止啟動。這正是 `limited` 與 `playable` 的分界：看的是「進不進得了世界」。

> 這三個 daemon 本來就只在有對外網路時才有意義，而 WASM 版整個沒有網路，
> 所以**不打算修**——修了也沒有對象可連。

## 沒有踩到的坑

- **GBK**：`master.c:14` 有 `if (port == 5003) set_encoding("GBK")`，而 WASM 版
  只帶演算法式字集，真的走進去會 raise error。實際不會發生：driver 的
  `wasm_console_connect()` 把連線標成「來自第一個 external_port」
  （`src/wasm/comm_wasm.cc:124-126`），也就是 `config.ini` 的 `telnet 5001`（UTF-8）。
  **打包規則因此是：第一個 external_port 必須是 UTF-8 的那個。**
- **crypt()**：屬 core（`src/packages/core/core.spec:191`），不受 crypto package 關閉影響。
  只會看到 `old crypt() password detected` 警告。

<!-- boot-test:begin -->
## WASM 開機測試（由建置產生，勿手改）

driver `v2026.0729.0`　最後測試：2026-08-01

分級：**playable** — 註冊 → 建角 → 進世界整條走得完

> 註冊→建角→進世界完成，收到 3 種 opcode

| 項目 | 值 |
|------|-----|
| 映像 | 12051 檔 / 31.5 MB |
| 收到 | 537 行，耗時 4372 ms |
| 握手 | `ver1.0:byz0rmpISExtQ` |
| 方言 | dmjh |
| opcode | 000 006 021 |

### 載入失敗的物件

WASM build 關掉了 sockets/db/external/ffi/crypto/async/compress，用到那些 efun 的檔案會在載入時編譯失敗。driver 仍會繼續開機，只是那些物件不存在（多半是對外連線用的 daemon，在沒有網路的分頁裡本來就沒有意義）。

- `/adm/daemons/kuafu`
- `/adm/daemons/qqd`
- `/adm/daemons/miraid`

缺少的 efun：`socket_create`、`socket_bind`、`socket_close`、`socket_write`

<!-- boot-test:end -->
