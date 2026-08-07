# libs/ — 可在瀏覽器裡跑起來的 mud 收藏

目錄佈局參考 [`fluffos/mudlibs`](https://github.com/fluffos/mudlibs)：一個 mud 一個資料夾，
建置時打包成靜態映像，瀏覽器下載後在分頁裡把 FluffOS 跑起來。

```
libs/
├─ <slug>/
│  ├─ mud.json          標題、來源、授權、設定檔名、方言
│  ├─ mudlib.data       ★ 整理過的 mudlib 映像（單一檔案）
│  ├─ mudlib.json       映像索引（檔名 → 位移／長度）
│  ├─ NOTES.md          匯入時改了什麼、WASM 上的落差（自動產生）
│  └─ work/             （選用、不進版控）解開的檔案樹，想直接看／改 LPC 時用
└─ README.md
```

## 為什麼版控裡是映像而不是檔案樹

`fluffos/mudlibs` checked in 的是 `work/` 檔案樹。本倉庫沒有照做，理由是**量出來的**：

| 操作 | 實測速度 |
|------|---------|
| 跨 WSL（9P）**讀取**小檔 | ~2,400 檔／分 |
| 跨 WSL（9P）**寫入**小檔 | **~28 檔／分** |

一個 mudlib 約一萬個檔案。以檔案樹進版控 = 每個 lib 寫入約 **5 小時**，16 個就是
**一整週**，而且之後每次 `git status` 都要 stat 十幾萬個檔案。改成單一映像後，
一個 lib 只要寫兩個檔，整批匯入從「不可行」變成「幾分鐘」。

**代價**：GitHub 網頁上看不到 LPC 原始碼，git diff 也只會顯示「二進位檔已變更」。
**補償**：映像格式是自訂但**極簡且有版本號**（`webclient/src/js/mudlibimage.js`），
任何人都能一行指令解開：

```bash
node webclient/tools/unpack-lib.mjs libs/<slug> --out /tmp/<slug>
```

而且整個匯入流程是可重跑的——來源在 `webclient/tools/import-all.mjs` 的對應表裡。

## mud.json

| 欄位 | 必要 | 說明 |
|------|------|------|
| `title` | ✔ | 選單上顯示的名字 |
| `config` | | driver 設定檔（相對於 mudlib 根）。預設 `config.ini` |
| `work` | | 改用檔案樹時的位置。`lpmudname` 用這個指回上游的 `LPMud-Name/world` |
| `dialect` | | `classic` / `dmjh` / `zymud`。留空則由握手行判斷 |
| `subtitle` `source` `license` `note` | | 顯示與出處紀錄 |

## 新增／更新一個 mud

```bash
cd webclient
node tools/import-all.mjs --slug <slug> --force   # 整理 → 轉碼 → 去識別 → 打包
node tools/build-site.mjs --only <slug>           # 開機測試 + 產生索引
bash ../scripts/privacy-scan.sh                   # 憑證掃描
```

## 三條硬規則

1. **第一個 `external_port` 必須是 UTF-8 的 telnet 埠。**
   driver 的 `wasm_console_connect()` 把連線標成「來自第一個 external_port」
   （`src/wasm/comm_wasm.cc:124-126`），mudlib 的 `master::connect(port)` 看到誰
   就決定要不要 `set_encoding()`。指到 GBK 埠 = 開機即 raise error。匯入工具會改。
2. **原始碼必須是 UTF-8。** WASM build 只帶演算法式字集（UTF-8/16/32、Latin-1、ASCII），
   GBK 這類表格式字集不存在。匯入工具會逐檔偵測並轉換。
3. **badge 由 boot-test 產生，不手寫。** 分級定義見 `webclient/tools/boot-test.mjs`：
   `playable`（註冊→建角→進世界走完）／ `limited`（開得起來但沒走完）／ `noboot`。

## 隱私

每個 mudlib 都來自真實營運過的伺服器，預設假定它帶著營運者的憑證與玩家存檔。
匯入時會**丟棄含密碼欄的 `data/**/*.o`**、把高風險檔案裡的憑證換成 `CHANGE_ME`，
並把結果寫進各自的 `NOTES.md`。發佈前還要通過 `scripts/privacy-scan.sh`。
根倉庫的 [`SECURITY_NOTES.md`](../SECURITY_NOTES.md) 記錄了上游同一批問題的處理。
