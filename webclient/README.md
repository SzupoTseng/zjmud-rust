# ZJMUD Web 客戶端

原 Android 手機客戶端的**淨室重寫**版本：功能與互動完整移植，視覺重新設計，
**不含任何原客戶端的原始碼、圖片或資源**。

- 協議規格：[`../../../docs/ZJMUD_CLIENT_PROTOCOL.md`](../../../docs/ZJMUD_CLIENT_PROTOCOL.md)
- 邏輯設計：[`../../../docs/ZJMUD_CLIENT_LOGIC_DESIGN.md`](../../../docs/ZJMUD_CLIENT_LOGIC_DESIGN.md)
- 介面設計：[`../../../docs/ZJMUD_CLIENT_UI_DESIGN.md`](../../../docs/ZJMUD_CLIENT_UI_DESIGN.md)

---

## 為什麼是 Tauri 而不是純網頁

ZJMUD 協議是**原生 TCP**，瀏覽器開不了 raw socket。
Tauri 的 Rust 端直接連 TCP，使用者不必額外部署 WebSocket 橋接程序。

前端本身是**純 HTML/CSS/JS、無框架、無建置步驟**，
所以日後若要出瀏覽器版，只需在 `src/js/net.js` 補一個 `WebSocketTransport`，
其餘程式碼完全不動。

---

## 環境需求

| 項目 | 版本 | 用途 |
|------|------|------|
| Node.js | ≥ 18 | 跑測試與假伺服器（**執行客戶端本身不需要**） |
| Rust / Cargo | ≥ 1.77 | 編譯 Tauri 外殼 |
| Tauri 系統相依 | 見官方文件 | Windows 需要 WebView2；Linux 需要 webkit2gtk |

> Rust 安裝：<https://rustup.rs>
> Tauri 前置需求：<https://tauri.app/start/prerequisites/>

---

## 快速開始

### 最簡單：用批次檔（專案根目錄）

| 檔案 | 用途 |
|------|------|
| **`START_ZJMUD.bat`** | 啟動 MUD 伺服器（等 5001 就緒）+ 客戶端 |
| `STOP_ZJMUD.bat` | 停止兩者 |
| `BUILD_ZJMUD.bat` | `npm install` → `npm test` → `tauri build`，產出可獨立執行的 release |

第一次用請先跑 `BUILD_ZJMUD.bat`（約 5 分鐘），之後 `START_ZJMUD.bat` 秒開。

> ⚠️ **`npm install` 一定要在 Windows 端跑**（批次檔已處理）。
> 從 WSL 跑會裝到 Linux 版的 Tauri 原生 binary，客戶端會起不來。

### 手動

```bash
npm install            # ← 必須在 Windows 端
npm run fake-server    # 選用：假 MUD 伺服器，監聽 127.0.0.1:6666
npm run dev            # tauri dev
```

> ⚠️ **debug 版 exe 不能單獨雙擊執行。** `tauri dev` 會另起一個本機靜態伺服器供應前端，
> debug binary 內嵌的是那個 URL，單獨執行會顯示 `ERR_CONNECTION_REFUSED`。
> 要可獨立執行的版本請用 `tauri build`（release 會把前端打包進 exe）。

### 連真實伺服器

本專案內附的 **LPMud-Name（江湖论剑）** 就是這個協議的原生伺服器：

```bash
# Windows 端啟動（會開 5001/5003/5004 三個埠）
cd zjmud\lpc_mud-master\LPMud-Name\world
driver.exe config.ini
```

| 埠 | 編碼 | 用途 |
|----|------|------|
| **5001** | **UTF-8** | ← **客戶端連這個** |
| 5003 | GBK | 傳統 telnet 客戶端用，連到會整頁亂碼 |
| 5004 | UTF-8 | driver 內建 websocket |

另一個 `800100` Docker 容器（指间夺宝）的 telnet 埠是 6666。

> ⚠️ 從 WSL 連 Windows 上的伺服器要用主機 IP，不是 `127.0.0.1`：
> `ip route show default | awk '{print $3}'`

### 打包

```bash
npm run build     # 產出 src-tauri/target/release/bundle/
```

---

## 測試

```bash
npm test
```

涵蓋 152 個測試，分六層：

| 層 | 檔案 | 數量 | 內容 |
|----|------|------|------|
| 1 純函式 | `protocol.test.mjs` | 57 | 樣式方言、每個 opcode 的 payload、對話框、輸入樣板、畸形輸入 |
| 2 狀態 | `store.test.mjs` | 8 | 訂閱通知上下傳播、容量裁切 |
| 3 對照真伺服器 | `server-fixtures.test.mjs`<br>`live-capture.test.mjs` | 11+14 | 伺服器原始碼巨集展開的輸出；**實機擷取的原始封包** |
| 4 傳輸整合 | `integration.test.mjs` | 8 | 真開 TCP：假伺服器 → 分行 → 解析 → store |
| **5 UI 冒煙** | **`ui-smoke.test.mjs`** | **23** | **jsdom 真載入 index.html、真跑 main.js、真派發 click** |
| 6 方言相容 | `dialects.test.mjs`<br>`bridge.test.mjs` | 20+11 | 擴充 opcode 解析；WebSocket 橋接端到端 |

**第 5 層不可省。** 前四層曾經全綠，但實機「按連線沒反應」——
因為它們全都繞過了 HTML + main.js 這層，也就是使用者唯一會碰到的那層。
補上當天就抓到兩個 bug。詳見 `../../../docs/ZJMUD_CLIENT_LOGIC_DESIGN.md` §11 事故記錄。

### 視覺驗證（jsdom 抓不到的）

jsdom 不做完整 CSS 級聯：`panel.hidden = true` 斷言會過，
但真實瀏覽器中若作者樣式設了 `display`，`[hidden]` 會被蓋掉而畫面完全沒變。
涉及顯示/隱藏或版面的改動，用 `tools/win/` 的截圖工具看一眼：

```powershell
powershell -File tools\win\shot.ps1     # 擷取視窗 → C:\Windows\Temp\zjmud_shot.png
powershell -File tools\win\drive.ps1    # 用剪貼簿逐行送指令（可送中文與 ║）
```

### 實機驗證工具

```bash
# 對真實伺服器連線並統計 opcode 分佈、檢查解析失敗
node tools/live-login-probe.mjs <主機IP> 5001 24 測試名
```

假伺服器（`tools/fake-server.mjs`）會播放涵蓋**全部 opcode** 的腳本，
並支援這些測試指令：

```
help        列出所有測試指令
look xiaoer 互動面板（詳情 + 兩組動作列 + 內嵌彈出選單）
menu        NPC 對話框（含數量輸入與 $N 替換）
pop         彈出選單
fight       戰鬥訊息 + 傷害飄字 + 血條變動
map         地圖疊層
colors      全部色彩／樣式／連結測試
prompt      數量輸入面板
malformed   故意送畸形封包，驗證降級不崩潰
north/east/up/out  移動換房間
```

---

## 目錄結構

```
webclient/
├── src/                     前端（Tauri 的 frontendDist）
│   ├── index.html
│   ├── css/
│   │   ├── tokens.css       設計 token + 三套主題
│   │   └── app.css          版面與元件
│   └── js/
│       ├── ansi.js          樣式方言解析（純函式）
│       ├── protocol.js      opcode 解析（純函式）
│       ├── store.js         狀態容器 + pub/sub
│       ├── net.js           傳輸抽象 + Tauri IPC
│       ├── ui.js            DOM 元件
│       ├── prefs.js         本地偏好
│       └── main.js          組裝與 reducer
├── src-tauri/
│   ├── src/main.rs          Tauri 指令
│   ├── src/mud.rs           TCP 連線管理（位元組層分行）
│   ├── src/telnet.rs        telnet IAC 剝除／拒絕協商（含單元測試）
│   ├── icons/
│   ├── Cargo.toml
│   └── tauri.conf.json
├── test/
│   ├── protocol.test.mjs      樣式與 opcode 單元測試
│   ├── store.test.mjs         狀態容器
│   ├── server-fixtures.test.mjs  伺服器原始碼展開的 fixtures
│   ├── live-capture.test.mjs  ★ 真實伺服器擷取的封包
│   └── integration.test.mjs   真開 TCP 的整合測試
└── tools/
    ├── fake-server.mjs        假 MUD 伺服器
    ├── live-probe.mjs         實機探針（不登入）
    └── live-login-probe.mjs   實機探針（完整登入）
```

**依賴方向是嚴格單向的**：`ansi.js` 與 `protocol.js` 不依賴任何模組，
所以能在 Node 裡直接測試，不需要瀏覽器或 DOM。

---

## 功能對照

| 原版功能 | 狀態 |
|----------|------|
| 房間標題／描述／出口／物件 | ✅ |
| 八方向盤 + 額外出口 | ✅ |
| 物件雙層血條 | ✅ |
| 屬性條群（含可點擊） | ✅ |
| 自訂快捷鈕 b1–b17（長按／右鍵設定） | ✅ |
| 主訊息／聊天／系統／戰鬥 四個訊息區 | ✅ |
| 互動面板（詳情 + 雙動作列 + 數量輸入） | ✅ |
| NPC 對話框（$exp#／$god#／$obj#／$N） | ✅ |
| 彈出選單 | ✅ |
| 地圖疊層 | ✅ |
| 長文本疊層 | ✅ |
| 傷害飄字 / 頂部橫幅 | ✅ |
| ANSI 擴充方言（含連結、字級、全形） | ✅ |
| 三種顯示模式（夜／日／終端） | ✅ |
| 換伺服器（ESC900）／單多行模式（997/998） | ✅ |
| 指令歷史（↑↓） | ✅ **新增** |
| 斷線指數退避重連 | ✅ **新增** |
| 響應式版面（桌面三欄／手機單欄） | ✅ **新增** |
| 可調字級、訊息可選取複製 | ✅ **新增** |
| 語音錄製／播放 | ⬜ 留介面未實作（見 UI 文件 §10） |
| 帳號 HTTP API／註冊／充值 | ⬜ 未實作（原版端點是 `127.0.0.1` 佔位值） |
| 內嵌網頁（ESC045） | ⚠️ 改為以外部瀏覽器開啟（CSP 限制） |

---

## 已知限制

1. **僅桌面**：選了 Tauri 直連 TCP，瀏覽器版需另加橋接（`net.js` 已預留介面）。
2. **登入仍是文字流程**：連上之後帳號、密碼、選角都在遊戲畫面內以文字進行，
   沒有做原版那個 HTTP 帳號中心。這對自架伺服器通常是夠用的。
3. **屬性條（`ESC012`）尚未實機驗證**：測試角色還沒投胎，伺服器不送這個封包。
   解析器有單元測試與伺服器 fixture 覆蓋，但畫面呈現未經實機確認。
4. **AV 誤判**：新編譯的無簽章 Rust exe 常被防毒軟體誤判。
   把 `src-tauri\target`、`%USERPROFILE%\.cargo`、`.rustup` 加入排除清單即可。

---

## 授權與來源

本客戶端為**淨室實作**：僅依據對原客戶端外部行為的觀察所整理出的
**互通性規格**（協議格式）撰寫，未複製原始碼或資源檔。
協議格式本身是互通所必需的事實資訊。

原 MUD 伺服器原始碼（`zjmud/`、`zjmud_指间争锋MUD－书剑江湖/`、`800100/`）
的授權條款請見各自倉庫，其中明載「**開源代碼嚴禁出售**」。
