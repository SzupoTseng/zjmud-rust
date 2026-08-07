# Windows 端測試工具

這兩支腳本用來**實機驗證 UI** —— jsdom 測試驗不到「畫面上到底看不看得見」，
涉及顯示/隱藏或版面的改動一定要用截圖確認（見 LOGIC_DESIGN §8.3）。

## shot.ps1 — 擷取執行中的 app 視窗

```powershell
powershell -ExecutionPolicy Bypass -File tools\win\shot.ps1
# → C:\Windows\Temp\zjmud_shot.png
```

以 `Get-Process zjmud-client` 取得 MainWindowHandle，比 `FindWindow` 可靠。

## drive.ps1 — 用鍵盤驅動客戶端

把要送出的指令逐行寫進 `C:\Windows\Temp\login.txt`（**UTF-8**），然後：

```powershell
powershell -ExecutionPolicy Bypass -File tools\win\drive.ps1
```

它會點進指令輸入框，逐行以**剪貼簿貼上**再按 Enter。
用剪貼簿而不是 SendKeys 直接打字，是因為 SendKeys 送不了中文與 `║`(U+2551)。

### 典型登入序列

```
x
帳號║密碼║byname666║email
男║║角色名
```

> 伺服器對登入有時限（`您花在连线进入手续的时间太久了`），
> 所以三行要在同一次執行中連續送出，不要分次。

### 座標

輸入框位置以 1196×819 視窗下的 (543, 591) 為基準按比例換算。
版面若有大改（例如快捷鈕列變高），這個比例要跟著調。
