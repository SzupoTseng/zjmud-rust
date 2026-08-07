# lpc_mud + ZJMUD Web/Desktop 客戶端

> **這是一個 fork。** 上游是《江湖论剑Mud》開源伺服器（原始說明完整保留在下方）。
> 本 fork 新增了一個**淨室重寫**的客戶端與一本設計書。

| 目錄／檔案 | 內容 |
|-----------|------|
| `webclient/` | ZJMUD 客戶端：桌面版（Tauri + Rust）、瀏覽器版（WebSocket 橋接）與 **WASM 版（伺服器就在分頁裡）共用同一份前端**。187 條測試 |
| `libs/` | **18 個可在瀏覽器裡跑起來的 mud**（17 可玩／1 待修）。含第一個**非 zjmud** 的 telnet lib（东方故事Ⅱ，經客戶端登入接應器）。佈局參考 [`fluffos/mudlibs`](https://github.com/fluffos/mudlibs) |
| `scripts/` | 發佈前的閘門：憑證掃描、分級檢查 |
| `designbook/` | 本書的舊版存放處。**已獨立成倉庫 → [TheMudReviewer](https://github.com/SzupoTseng/TheMudReviewer)** |
| `docs/` | 線路協議、邏輯架構、介面設計三份規格書，以及 [ZJMUD 遷移 SOP](docs/zjmud_migration_SOP.md) |
> ### 📖 姊妹倉庫：《泥巴考古學 · The MUD Reviewer》
>
> 這個專案的完整工程筆記已獨立成一本書，**14 篇 · 82 個單元 · 7 個附錄**：
> 前七篇從一個 1.1 MB 的 APK 逆向出 ZJMUD 協議並淨室重寫客戶端；
> 後七篇解剖 LPMud／MudOS／FluffOS／LDMud／DGD／CD 六支 driver 的技術史與設計。
>
> **[倉庫](https://github.com/SzupoTseng/TheMudReviewer)**　·　**[線上閱讀（繁體）](https://szupotseng.github.io/TheMudReviewer/TheMudReviewer.html)**　·　**[简体](https://szupotseng.github.io/TheMudReviewer/cn/TheMudReviewer.html)**
>
> 書中的 `webclient/`、`libs/`、`LPMud-Name/` 路徑指的就是**本倉庫**。

| `SECURITY_NOTES.md` | **公開前必讀**：上游程式碼帶有真實憑證與一條把玩家帳密外送第三方的路徑，已處理，本檔記錄改了什麼 |
| `LPMud-Name/` | 上游伺服器（LPC / FluffOS）。含 55 MB 的 `world/driver.exe`——見下方說明 |

> **下載約 35 MB，展開後約 90 MB**——差距來自上游隨附的 55 MB
> `LPMud-Name/world/driver.exe`（FluffOS，msys2/mingw 建置、未 strip，
> 所以帶著 DWARF 除錯資訊；也正因為是除錯資訊，它壓縮率極高）。
> 倉庫裡沒有 driver 的原始碼，所以它直接納入版控——clone 完就能跑，
> 不必先去別處找執行檔。想自己編請到 [FluffOS](https://github.com/fluffos/fluffos)。

## 在瀏覽器裡直接玩（WASM，不需要伺服器）

FluffOS 有官方的 WebAssembly build：**整台 driver 跑在分頁裡**，mudlib 是一份靜態映像，
沒有 socket、沒有橋接、沒有後端。本倉庫把它接上 zjmud 客戶端——第一個畫面不再問
「位址／埠號」，而是**列出可選的 mudlib**，選一個就在這個分頁裡把它跑起來。

```bash
cd webclient
npm install
node tools/fetch-driver.mjs      # 取得 WASM driver（官方 release，2.4 MB）
node tools/build-site.mjs        # 打包 libs/ 底下每個 mud + 跑開機測試
node tools/serve-site.mjs        # http://localhost:8080
```

| 特性 | 說明 |
|------|------|
| 伺服器 | **沒有**。driver 編成 wasm，`fluffos_boot/tick/connect/input` 就是全部的介面 |
| 多人 | 沒有。同一個分頁可以開多條連線，跨使用者不行 |
| 存檔 | 重整即消失（MEMFS）。這是展示站，不是正式服 |
| 每個 mud | 一份 `mudlib.data`（20-60 MB），下載後在記憶體裡展開 |
| 分級 | `playable` / `limited` / `noboot` 由 `tools/boot-test.mjs` **實際跑一次註冊→建角→進世界**決定，不是人工標的 |
| 目前狀態 | 收錄 **214 台**：`playable` **210** ／ `limited` 1 ／ `noboot` 3（可玩率 98.1%）。來源分為 **原生 zjmud 18 台**（本專案原本就有，未經轉換）與 **轉換 196 台**（由上游 telnet mudlib 原生化而來） |

### 驗證到哪裡（誠實揭露）

| 這一段 | 怎麼驗的 | 狀態 |
|--------|---------|------|
| driver ＋ 每個 mud 的映像 | node 直接載入真 driver，跑完「註冊 → 建角 → 進世界」 | ✅ 17 個 |
| **逐台真網頁路徑**（每台一個子行程）：選單 → 開機 → 登入 → 建角 → 進世界，斷言房間標題／訊息量／有內容的按鈕 | `webclient/tools/sweep-web.mjs`（CI 每次都跑） | ✅ 17 個 |
| telnet lib 的登入接應器（非 zjmud → zjmud 客戶端可玩） | 依提示逐行代答（`src/js/telnetlogin.js`），东方故事Ⅱ 實測 8 步建角全走完 | ✅ 1 個 |
| 客戶端的選單／啟動／連線流程 | jsdom 真的跑 `index.html` ＋ `main.js`，只有 driver 是替身 | ✅ |
| 映像的 HTTP 載入（含進度） | 起一台靜態伺服器，走與瀏覽器相同的 `fetchImage` 路徑 | ✅ |
| **全鏈路**：選 mud → 真 driver 開機 → 連線 → 登入 → 建角 → 進世界 → 換另一台 mud | `node webclient/tools/verify-fullstack.mjs`（真 DOM ＋ 真 wasm driver ＋ 真 HTTP，CI 每次都跑） | ✅ |
| 瀏覽器自己的 `<script src>` 與 `instantiateStreaming` | 本機沒有可用的 headless 瀏覽器（Edge `--dump-dom`／`--screenshot`／CDP 都起不來） | ⚠ 未驗 |

剩下的只有瀏覽器自己載入 glue 那一小段（WebAssembly 引擎、映像、DOM 行為在上面都已經是真的）。
要親眼確認的話：

```bash
node webclient/tools/serve-site.mjs      # http://localhost:8080
```

選一個 mud → 應該看到下載進度 → 進遊戲畫面出現登入視窗。

新增一個 mud：見 [`libs/README.md`](libs/README.md)。

---

## 快速啟動

| 指令 | 作用 |
|------|------|
| `START_SERVER.bat` | 只啟動 MUD 伺服器（:5001 UTF-8 / :5003 GBK） |
| `START_DESKTOP.bat` | 伺服器 ＋ 桌面版客戶端 |
| `START_WEB.bat` | 伺服器 ＋ 瀏覽器版橋接（:8080，手機也能連） |
| `START_WEB_WINDOW.bat` | 把瀏覽器版開成**獨立小視窗**（無分頁列／網址列）。需先跑 `START_WEB.bat` |
| `BUILD_ZJMUD.bat` | 建置桌面版 release |
| `STOP_ZJMUD.bat` | 全部停止 |

### ★ 第一次啟動：Windows 防火牆會跳提示，**不要按取消**

`driver.exe` 換一個路徑就等於一支新程式，Windows 會重新詢問是否允許連線。
按了取消／略過，Windows 會建立一條 **Block** 規則，症狀是：

- 本機瀏覽器連得上（`localhost` 不經防火牆）
- **但手機或區網其他電腦一律連不上**，看起來像「伺服器壞了」

診斷與修復（PowerShell，需系統管理員）：

```powershell
# 看目前規則（Action 若是 Block 就是踩到了）
Get-NetFirewallApplicationFilter | Where-Object { $_.Program -like '*driver.exe*' } |
  ForEach-Object { $r = $_ | Get-NetFirewallRule; "$($r.Action) $($r.Direction) $($_.Program)" }

# 移除 Block 後補一條 Allow（路徑換成你自己的）
New-NetFirewallRule -DisplayName 'ZJMUD driver' -Direction Inbound `
  -Program 'X:\你的路徑\LPMud-Name\world\driver.exe' -Action Allow -Profile Any
```

瀏覽器版的橋接（預設 :8080）也要放行，手機才連得到。

> 建置產物與 `node_modules` 不在版控內（見 `.gitignore`）。
> 第一次使用請先在 **Windows 端**執行 `npm install`——從 WSL 安裝會取得 Linux 版原生檔案，客戶端會起不來。

---

## 授權

本倉庫是**兩種授權的混合體**，界線就是目錄：

| 範圍 | 授權 | 授權檔 |
|------|------|--------|
| `LPMud-Name/` — 上游《江湖论剑Mud》伺服器（11,927 檔） | Academic Free License 3.0 | [`LICENSE`](LICENSE) |
| `libs/<slug>/work/` — 各自來自不同作者的 mudlib | **各自的上游條款**，逐一記在 `libs/<slug>/README.md` | 見各目錄 |

> ### ⚠ 站台會公開提供每一台的**完整原始碼**
>
> 這不是設定疏漏，是架構的必然：WASM driver 在**瀏覽器裡**跑 mudlib，
> 所以整份原始碼必須下載到使用者端才跑得起來。任何託管方式都一樣
> （GitHub Pages、Railway、自架都不會改變這一點）。
>
> 每台只要兩個檔就能完整還原：
>
> ```bash
> S=https://szupotseng.github.io/zjmud-rust/libs/sj
> curl -sO $S/mudlib.json      # 檔案清單（path / at / size）
> curl -sO $S/mudlib.data.gz   # gzip 過的整包內容
>
> # 或直接用本專案的工具（本機路徑或線上網址都可以）
> python3 tools/extract-image.py $S 還原目錄
> python3 tools/extract-image.py $S --cat cmds/std/look.lpc
> ```
>
> 實測 `sj`：**3500 檔 / 20 MB** 完整還原。
>
> **因此**：收錄任何一台之前，它的授權必須允許再散布——這就是
> `libs/<slug>/README.md` 逐台記錄出處與條款的原因，也是
> `scripts/privacy-scan.sh` 必須擋下玩家存檔（`data/**/*.o`，含明文密碼）
> 與硬編碼憑證的原因：**能被下載的東西，就等於已經公開了**。
| `webclient/`、`docs/`、`scripts/`、`*.bat`、`index.html` — 本 fork 新增 | MIT | [`LICENSE-MIT`](LICENSE-MIT) |

`libs/` 底下的每一個 mudlib 都是**別人的著作**，本 fork 只做了三件事：轉成 UTF-8、
移除玩家存檔與憑證、調整設定讓它能在 WASM driver 上開機——改了什麼逐項記在
各自的 `NOTES.md`。這些改動不構成新的著作權主張，原條款繼續適用。
若你是某個 mudlib 的作者且不希望它出現在這裡，開一個 issue，我會移除。

為什麼不用單一授權檔蓋掉全部：`LPMud-Name/` 的著作權不屬於本 fork，
把它一併宣告成 MIT 等於對別人的程式碼主張自己的著作權；而且 MIT 明文允許販售，
與上游自己聲明的「**开源项目严禁倒卖**」直接衝突。所以上游目錄維持上游的條款，
新增的部分才用 MIT。

客戶端為**淨室實作**：僅依對外部行為的觀察整理出互通性規格，未複製上游客戶端的
原始碼或資源。協議格式本身是互通所必需的事實資訊。

---

## 上游原始說明

####  **介绍** 
 _江湖论剑Mud开源仓库,本仓库不定时更新游戏功能！_ 

####  **使用方法** 
1.LPMUD-Name(江湖论剑Mud)项目使用utf-8编码的所以zj客户端也要做些操作,这里给提供一个改好的zj客户端下载后直接反编译修改客户端的ip/名字/包名/即可。

####  **其他说明** 
1.开源项目严禁倒卖！

2.如果你感觉本项目代码哪里需要改进的可以提交到本项目仓库。

3.有想实现的功能自己实现不了的也可以提交到项目仓库，我有时间会帮大家写也可以提供思路。

**_项目交流群:[471646693(点击加群)](https://jq.qq.com/?_wv=1027&k=ij0l0Zk7)_**

---

# 版控與體積規則

## 只有 `mudlib.data.gz` 進版控

```
libs/<slug>/mudlib.data      ← .gitignore（可還原，不進版控）
libs/<slug>/mudlib.data.gz   ← 版控裡的形態，也是瀏覽器實際下載的位元組
libs/<slug>/mudlib.json      ← 檔案索引
libs/<slug>/mud.json         ← 中繼資料（協議、家族、驗證結果）
```

`.data` 與 `.data.gz` 是**同一份資料的兩種形式**，而瀏覽器只需要 `.gz`
（載入端優先抓它，用 `DecompressionStream` 串流解壓）。兩份都進版控等於把
同樣的位元組存兩次——實測 97 台的 `.data` 是 **2.8 GB** 而 `.gz` 只有 **282 MB**，
多出來的 2.5 GB 純粹是重複。

| | 大小 |
|---|---|
| 只留 `.gz` ＋ 索引 ＋ 中繼資料 | **363 MB** |
| 連 `.data` 一起 | 3.1 GB |
| 上游 `fluffos/mudlibs` 參考值 | 1.08 GB |

`.data` 隨時可以從 `.gz` 還原（`MudlibImage.load()` 會自動退回），
`build-site.mjs` 也接受「只有 `.gz`」的情形。

> ⚠ 我一度誤以為「資料太大放不進 GitHub」而打算不收錄——
> 真相是**我自己多存了一份**。上游 1.08 GB 都進得去，我們 363 MB 當然可以。
> **先量清楚組成，再下「放不下」的結論。**

---

# zjmud lib builder

把一般（telnet）mudlib 自動轉成**原生 zjmud** mudlib——
轉換後 mudlib 自己說 zjmud 協議，標準 zjmud 客戶端直接可連。

```bash
cd tools
python3 -m mud2zjmud build --from <原始 mudlib>/work --slug <名字>   # 從原始樹一路到可玩
python3 -m mud2zjmud build ../libs/<slug>                            # 規則改良後重跑
python3 -m mud2zjmud build ../libs/<slug> --debug                    # 打開注入碼的診斷輸出
python3 -m mud2zjmud verify ../libs/<slug> ...                       # 只驗不改（結果寫回 mud.json）
python3 -m mud2zjmud rules -v                                        # 規則表與每條的理由
```

## 七個階段

```
匯入 → 設定檔把關 → 相容性 → 協議注入 → 原生登入 → 中繼資料 → 打包 → 開機驗證
```

## 三條核心規則

1. **不要假設，去觀察**——家族、look 位置、logind 位置、屬性欄位、起始房間
   全部從資料掃出來，不靠家族常數推論。同一血緣的 mudlib 簽名到處不同，
   猜錯的代價是整台編譯失敗而錯誤訊息指向別的地方。
2. **冪等**——注入的東西全放進同一個可辨識區塊，移除時整塊砍掉。
   驗收方式：**連跑兩次，結果必須完全一致**。
3. **能進世界的殘缺角色，遠比進不了世界的完整角色有用**——
   建角流程的五個中斷點全部 `catch()`，失敗只代表少了些預設值，
   不該讓整個建角作廢。

## 站台

```
site/index.html              目錄頁：一台一列一個直達連結
site/play.html               客戶端
site/play.html?mud=<slug>    直接開該台（沒有開場選單）
localStorage 命名空間         zjmud.prefs.v1.<slug>（各台分開，避免帳號互相污染）
```

完整規格與方法論見 `docs/zjmud-spec.MD`，閘門紀律見 `CLAUDE.md`。

---

# 收錄率（對照上游 fluffos/mudlibs）

```
上游 227 個目錄
  有 work/ 可展開  199   ← 收錄 198 台（99.5%），只有 hellxg 刻意不收 ★
  只有 meta.json    28   ← 不收（見下）
    not-mudlib      26     C++ 引擎、DikuMUD/Merc C 原始碼、PHP/ASP 網站、
                           Lua 客戶端、攻略文字集…都不是 LPC mudlib
                           （實測：這 28 個目錄裡連一個 .c/.lpc 都沒有）
    not-convertible  2     longyunmeng_binary（只有二進位發行版）、
                           yhwhckdm（片段參考碼，沒有 master object）
本專案 214 台
  playable 210 ／ limited 1 ／ noboot 3      ← 可玩率 98.1%
```

**四台非 playable，每一台的理由都追到底了**（不是「查不出來」）：

| slug | 分級 | 真因 |
|---|---|---|
| `nt7` | limited | 混血台：握手說 zjmud、帳號流程走 telnet，兩條登入路徑同時暴露而互相踩踏（spec §D33） |
| `dfgsitlzjwin` | noboot | WIN98 封存**少了整個 `include/`**（連 `globals.h` 都沒有）。實測 2290/2303 檔（99.4%）與 `es1_win` 同路徑，而上游查過剩下 213 個非共同檔「幾乎全是 `.old`/`.c~`/`.bak` 備份，沒有獨有內容」——修好也只是 `es1_win` 的較差副本（§D43） |
| `sgzmudsgz` | noboot | LIMA 基底，需要 `ARRAY_RESERVED_WORD`／`PACKAGE_PARSER` 等本專案 driver build 沒開的選項。停用它的自檢後立刻撞上 `array` 型別關鍵字——**那正是自檢在抱怨的東西**（§D43） |
| `ds386` | noboot | 英文 Dead Souls，非中文、非 zjmud 家族的獨立 mudlib；上游自己標 partial |


### 上游有、但**不收**的：hellxg

上游 `hellxg` 有 `work/`，看起來像漏收的一台。查了上游自己的判定：
「diff-only repack of the hell/zjdywzb family with no master object of its own
— not bootable」——它是 hell／zjdywzb 家族的**差異包**，沒有自己的 master object，
本來就開不了機。依收錄規則（上游標 noboot 就不收）不收，理由記在這裡。

⚠ 這台差點被永久漏掉：`libs/hellxg/` 是個**空目錄**，
而收錄清單是用目錄名算的（`comm -13 <(ls libs) <(ls 上游/libs)`），
於是它被當成「已收錄」。`mud2zjmud doctor` 現在有第六個不變式擋這件事。

### 沒能可玩的 6 台，各自的理由

| slug | 我們 | 上游 | 為什麼 |
|---|---|---|---|
| `chongshengdeshijie` | noboot | playable | RWlib kernel 血緣（與其餘武俠 lib 無關）。登入注入已能生效，但該 lib 大量使用本 WASM driver 沒有的 `socket_*` efun |
| `ds386` | noboot | partial | English Dead Souls——非中文、非 zjmud 家族。上游自己標 deprioritized |
| `dfgsitlzjwin` | noboot | noboot | 上游本身就開不了機 |
| `hy2` | noboot | noboot | 同上 |
| `sgzmudsgz` | noboot | noboot | 同上 |
| `nt7` | limited | — | 同上：`0007` 之後只回顯輸入（ESC014），輸入通道等於死的 |

**紀律**：上游本身非 playable 的台，我們不追——只收錄並如實記錄理由。
上游 playable 而我們不行的，才是我們的缺陷（見 `docs/zjmud-spec.MD` §D22–§D30
的追查記錄）。

**上游標記為可轉換的部分已 100% 收錄。** 未收的 28 台在上游本身就只有
`meta.json`、沒有原始碼——它們不是 mudlib，收不進來也不該假裝收得進來。

## 為什麼數字不會完全相等

| 差異 | 原因 |
|---|---|
| 我們 214 vs 上游可展開 199 | 收藏裡另有 **19 台原生 zjmud**（本專案原本就有的，不在上游）；上游 199 台裡有 4 台是同一份封存的不同 drop，合併後不重複計 |
| 上游 26 台 not-mudlib | C++ 引擎、破解版壓縮檔——上游只留 `meta.json` 存證 |

## 品質分布

`mud2zjmud verify` 的判準是**行為**（真登入、真進世界、真走一步），
不是「有沒有收到訊號」：

- 送滿 9 種以上 opcode：約 六成
- 7–8 種：多為起始房間沒有 NPC 或物件（**資料相依，不是缺陷**）
- 少數 limited：新手關卡未過、或該台本身在上游就標記 noboot

詳細判準與「哪些不該修」見 `docs/zjmud-spec.MD` §D19、§C5。

## 兩種來源，性質完全不同

目錄頁的「來源」欄把它們分開標示：

| 標記 | 意義 | 台數 |
|---|---|---|
| **原生** | 本專案原本就收的 zjmud mudlib——**作者當年就是為 zjmud 客戶端寫的**，我們一個位元組都沒改 | 19 |
| **轉換** | 上游 `fluffos/mudlibs` 的 telnet mudlib，由 `mud2zjmud` 注入 zjmud 登入與面板後才會說這個協議 | 195 |

**為什麼要標示**：不分開的話，使用者會以為 214 台都是「原本就這樣」——
而那 19 台的歷史價值（真正的 zjmud 時代遺物）就被淹沒了。
反過來說，轉換台若出現原作沒有的行為（例如我們注入的登入流程、
或依實際指令產生的快捷列），也該讓人知道**那是我們加的**。

> 技術上的差別也是實在的：原生台的 `logind` 裡本來就有
> `ver1.0` 握手與 `get_user`／`get_char`；轉換台的那一段是 builder 注入的
> （見 `docs/zjmud-spec.MD` §C2）。builder 會偵測並**跳過**已經是 zjmud 的台
> （§D8）——重複注入會讓兩套流程打架，實測把 nt7 從可連線弄成開不了機。
