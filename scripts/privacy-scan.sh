#!/usr/bin/env bash
# 憑證與隱私掃描 —— 發佈前的硬閘門。
#
# 【WHY】本倉庫的 SECURITY_NOTES.md 記錄過一次教訓：上游 mudlib 帶著營運者的
# SMTP 授權碼、MySQL root 密碼、互聯密碼，以及含明文密碼的玩家存檔。
# libs/ 底下每一個 mud 都來自同一個生態，預設假定它們也有。
#
# 【推理】這支刻意**不認識任何特定密碼**，只認得「密碼長什麼樣」與「存檔長什麼樣」。
# 理由同 SECURITY_NOTES.md §5：把「檢查某個密碼還在不在」寫進版控，等於讓這份
# 檢查腳本自己變成洩漏來源。所以規則一律是正向特徵比對。
#
# 【證據】SECURITY_NOTES.md §1、§3、§5 ④。
#
# 用法：bash scripts/privacy-scan.sh [目錄...]   預設掃 libs/ 與 LPMud-Name/

set -uo pipefail
cd "$(dirname "$0")/.."

TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=(libs LPMud-Name)
fi

fail=0

echo "── ⓪ 映像**內部**的玩家存檔（發佈出去的就是這一份）──"
# 【WHY 這一節要放最前面】底下第 ① 節用 `find … -name '*.o'` 掃磁碟，
# 而 libs/ 底下每一台只有三個檔（mud.json / mudlib.json / mudlib.data.gz）——
# 真正發佈的內容全部打包在那個 blob 裡。實測：184 台的映像帶著 45,692 個
# 真人玩家存檔（含 crypt 密碼雜湊、姓名、上線紀錄），而第 ① 節一路回報乾淨。
# **閘門看的地方，跟產品發佈的東西不是同一個**（CLAUDE.md 核心原則）。
if ! node scripts/scan-images.mjs; then
  fail=1
fi

echo
echo "── ① 玩家存檔（*.o 含密碼欄）──────────────────"
saves=$(find "${TARGETS[@]}" -name '*.o' -type f 2>/dev/null \
  | xargs grep -l -i 'password' 2>/dev/null | head -50)
if [ -n "$saves" ]; then
  echo "$saves" | sed 's/^/  ✗ /'
  echo "  → 這些是玩家存檔，含密碼欄。請刪除（import-lib.mjs 會自動丟棄，手動加入的要自己顧）。"
  fail=1
else
  echo "  ✓ 沒有含密碼欄的存檔"
fi

echo
echo "── ② 寫死的憑證（泛用特徵，不綁定特定值）──────"
hits=$(grep -rInE '(password|passwd|pwd|secret|api_?key|token|授权码|授權碼)[[:space:]]*[:=][[:space:]]*"[A-Za-z0-9._@+-]{6,}"' \
  "${TARGETS[@]}" 2>/dev/null \
  | grep -v CHANGE_ME \
  | grep -vE '\.(md|html):' \
  | head -50)
if [ -n "$hits" ]; then
  echo "$hits" | sed 's/^/  ✗ /'
  echo "  → 請改成 CHANGE_ME 或改讀外部設定。"
  fail=1
else
  echo "  ✓ 沒有寫死的憑證"
fi

echo
echo "── ③ 指向外部主機的位址（應為 127.0.0.1）──────"
ips=$(grep -rInE '"([0-9]{1,3}\.){3}[0-9]{1,3}"' "${TARGETS[@]}" 2>/dev/null \
  | grep -vE '"(127\.0\.0\.1|0\.0\.0\.0|255\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' \
  | grep -vE '\.(md|html):' \
  | head -30)
if [ -n "$ips" ]; then
  echo "$ips" | sed 's/^/  ! /'
  echo "  → 這些是對外位址。展示站不該連出去；確認過就留著，否則改 127.0.0.1。"
  # 位址只警告不擋：有些是註解裡的範例或 MUD 互聯公開名錄（見 SECURITY_NOTES §4）
else
  echo "  ✓ 沒有對外位址"
fi

echo
if [ $fail -ne 0 ]; then
  echo "掃描結果：✗ 有必須處理的項目"
  exit 1
fi
echo "掃描結果：✓ 通過"
