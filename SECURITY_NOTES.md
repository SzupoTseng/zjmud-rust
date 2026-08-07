# 交付前的資料清理紀錄

> 本專案基於開源 MUD 伺服器（LPMud-Name）改寫。上游原始碼裡帶有**原營運者的真實憑證與
> 伺服器位址**。公開前已全部替換為佔位值，本檔記錄改了什麼、為什麼、以及你要自己填什麼。

---

## 1. 已移除的憑證（**不要用 git 歷史把它們找回來**）

| 檔案 | 原本是什麼 | 現況 |
|------|-----------|------|
| `LPMud-Name/world/adm/etc/config` | QQ 郵箱 SMTP 帳號與授權碼（16 碼，是可用的憑證） | `CHANGE_ME` |
| `LPMud-Name/world/include/mysql.h` | 指向真實 IP 的 MySQL **root 密碼** | `CHANGE_ME`（本檔未被任何程式引用） |
| `LPMud-Name/world/adm/daemons/network/cmwhod.c` | MUD 互聯網路的共享密碼 | `CHANGE_ME` |

要啟用郵件／資料庫／MUD 互聯，請自行填入**你自己的**憑證。
`mysql.h` 裡已附上正確做法（改讀 `config("DB_HOST")` 之類的外部設定），建議照那個走，
不要把憑證寫死在原始碼裡。

---

## 2. ★ 已切斷的對外連線（安全性問題，不只是隱私）

上游程式碼有一條**把玩家憑證送到第三方伺服器**的路徑：

```c
// world/cmds/usr/api_mail.c
return link_ob->query("data_id") + "-" + link_ob->query("data_password")
     + "-" + ob->query("data_email");     // → POST 到原營運者的伺服器 :80
```

也就是說，只要照原樣架起來，**每一次註冊都會把帳號、密碼、email 明文送到原營運者的機器**。

已把三處指向原營運者伺服器 IP 的設定改為 `127.0.0.1`：

| 檔案 | 用途 |
|------|------|
| `world/include/zjmud.h` | `ZJIP` / `NAME_PAY`——20 餘處引用的來源（充值網站連結、`telnet` 跳轉、離線任務購買頁…） |
| `world/cmds/usr/api_mail.c` | 另外硬編了一份，且是上述外送路徑的實作 |
| `www/www/main.js` | 網頁前端的 `api.php` 端點 |

**改成 `127.0.0.1` 的意思是「什麼都不會送出去」，不是「已經修好了」。**
如果你要啟用這些功能，請指向**你自己的**服務，並且**先把明文密碼外送這件事改掉**。

---

## 3. 已刪除的執行期資料

| 路徑 | 內容 | 為什麼刪 |
|------|------|---------|
| `world/data/login/t/*.o` | 測試帳號存檔，**含明文密碼** | 開發期產物 |
| `world/backup/2026-7-29/` | 伺服器自動備份，同樣含上述存檔 | 刪帳號檔卻留備份等於沒刪 |
| `world/log/debug.log` | 8.6 MB，其中 51,253 行是一次重連風暴造成的警告 | 只保留 321 行伺服器自身的啟動警告 |
| `world/log/adms/logon` | 50,687 筆登入紀錄（其中 50,679 筆來自同一次事故） | 只保留上游原有的 9 筆 |

這些路徑都已列入 `.gitignore`，之後不會再被帶進版控。

---

## 4. 刻意保留的東西

| 項目 | 為什麼留 |
|------|---------|
| 上游作者的 email（`pc-feng@163.com`、`ken@chinesemud.net`、`jds@math.okstate.edu` 等） | 是原始碼的**署名與致謝**，出現在檔頭註解與 FTP/驅動程式說明中。移除等於抹掉出處 |
| `mudlist1 : 47.105.53.153`（`adm/etc/config`） | 上游的 MUD 互聯清單，屬於公開的社群名錄 |
| `test001` / `abc123` 等測試字串（`webclient/test/`） | 測試 fixture，指向本機測試伺服器，不是真實憑證 |
| `webclient` 把帳密以明文存在 `localStorage` | **刻意的設計取捨**：協議本身即明文傳輸，本地加密只會製造安全感。已設成 opt-in（`rememberAccount` 預設 `false`）。詳見書中 §025 |

---

## 5. 交付前自我檢查（可重複執行）

> ⚠️ **這一節刻意不列出被移除的密碼原文。**
> 第一版曾經寫成 `grep -rl "<真實密碼>"` 這種「檢查密碼是否還在」的指令——
> 結果就是**這份說明文件本身變成了洩漏來源**，而且它會被 commit。
> 掃描腳本抓到的唯一命中就是這個檔案。
> **凡是要留在版控裡的檢查，一律用「正向確認佔位值在」，不要用「反向確認密碼不在」。**

```bash
# ① 三處憑證都必須是佔位值（各應回報 ≥1）
grep -c CHANGE_ME LPMud-Name/world/adm/etc/config
grep -c CHANGE_ME LPMud-Name/world/include/mysql.h
grep -c CHANGE_ME LPMud-Name/world/adm/daemons/network/cmwhod.c

# ② 對外位址都指向本機（應回報 3 個檔）
grep -rl "127.0.0.1" LPMud-Name/world/include/zjmud.h \
                     LPMud-Name/world/cmds/usr/api_mail.c \
                     LPMud-Name/www/www/main.js

# ③ 不得有任何存檔帶密碼欄（應回報 0）
find . -name "*.o" -not -path "./webclient/node_modules/*" \
  | xargs grep -l '"password"' 2>/dev/null | wc -l

# ④ 泛用機密特徵掃描（不綁定特定值，之後新增的憑證也抓得到）
grep -rInE '(password|passwd|secret|api_?key|token)[[:space:]]*[=:"][[:space:]]*"?[A-Za-z0-9._-]{8,}' \
  --exclude-dir=node_modules --exclude-dir=.git --exclude=SECURITY_NOTES.md . \
  | grep -v CHANGE_ME
```

④ 是唯一值得長期保留的一條：**它不認識任何特定密碼，只認得「密碼長什麼樣」**，
所以下次有人不小心寫死新憑證時它仍然抓得到。前三條只驗證本次的清理結果。

> **提醒**：如果這個目錄曾經以含憑證的狀態 commit 過，改檔案是不夠的——
> 憑證仍在 git 歷史裡。那種情況下唯一可靠的做法是**視為已外洩並更換憑證**，
> 而不是嘗試改寫歷史。本專案是全新 check-in，沒有這個問題。
