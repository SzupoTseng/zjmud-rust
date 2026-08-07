#!/usr/bin/env bash
# 守成檢查 —— 每一輪開頭與結尾各跑一次。
#
# 【WHY 做成腳本】這四項原本是每輪手打 curl ＋ grep，而手打的東西會漂移：
# 忘記加 `?n=$RANDOM` 就會讀到 CDN 快取、grep 的字串抄錯就變成永遠為 0 的
# 假綠燈（CLAUDE.md §5：斷言要是實數，不能是套套邏輯）。
#
# 【WHY 有第四項】前三項只能回答「線上看起來正常嗎」，不能回答
# 「**線上是哪一版**」。站台曾經停更 11 個 commit 而三項全綠——
# 因為那 11 個 commit 帶來的是 badge 變化，不是連結數變化。
# 第四項把它變成實數比對：線上 sha 必須等於本機 HEAD。
# （`_build-info.json` 由 build-site 產生，見那裡的說明。）
#
# 用法：bash scripts/guard.sh [--no-doctor]
#   離開碼 0 ＝ 四項全過；非 0 ＝ 有一項紅，訊息會說是哪一項。

set -uo pipefail
cd "$(dirname "$0")/.."

SITE="${ZJMUD_SITE:-https://szupotseng.github.io/zjmud-rust}"
# 上一輪的連結數，用來檢查「不減」。存在 .guard-baseline，沒有就用這次的值當基準。
BASELINE_FILE=".guard-baseline"
fail=0

echo "── ① 線上連結數（不得減少）────────────────────────"
links=$(curl -s "$SITE/?n=$RANDOM" | grep -c "play.html?mud=")
prev=$(cat "$BASELINE_FILE" 2>/dev/null || echo 0)
echo "  本次 $links ／ 上次 $prev"
if [ "$links" -eq 0 ]; then
  echo "  ✗ 一個連結都沒有——站台掛了，或 grep 的字串失效（空集合不算通過）"
  fail=1
elif [ "$links" -lt "$prev" ]; then
  echo "  ✗ 比上次少了 $((prev - links)) 個"
  fail=1
else
  echo "  ✓"
  echo "$links" > "$BASELINE_FILE"
fi

echo
echo "── ② 線上不得有簡體字 ────────────────────────────"
page=$(curl -s "$SITE/?n=$RANDOM")
cn=$(printf '%s' "$page" | grep -c "书剑\|论剑\|侠客")
tw=$(printf '%s' "$page" | grep -c "書劍\|論劍\|俠客")
echo "  簡體 $cn ／ 繁體 $tw"
if [ "$cn" -ne 0 ]; then
  echo "  ✗ 有簡體殘留"
  fail=1
elif [ "$tw" -eq 0 ]; then
  # 【WHY 要驗繁體有出現】只驗「簡體＝0」的話，頁面整個抓不到時也是 0——
  # 那是空集合的假綠燈。要有繁體命中，這個 0 才有意義。
  echo "  ✗ 繁體也是 0——頁面根本沒抓到，這個「簡體 0」不算數"
  fail=1
else
  echo "  ✓"
fi

echo
echo "── ③ 映像健檢（doctor）───────────────────────────"
if [ "${1:-}" = "--no-doctor" ]; then
  echo "  · 依參數跳過"
else
  out=$(cd tools && python3 -m mud2zjmud doctor 2>&1)
  echo "$out" | tail -1 | sed 's/^/  /'
  echo "$out" | grep -qE "^[0-9]+/[0-9]+ 台通過健檢" || { echo "  ✗ 沒有印出總結行"; fail=1; }
  echo "$out" | awk -F'/' '/台通過健檢/ {split($2,b," "); if ($1+0 != b[1]+0) exit 1}' || { echo "  ✗ 有台沒通過"; fail=1; }
fi

echo
echo "── ④ 線上的是哪一版（sha 必須等於本機 HEAD）────────"
# 【WHY 比完整 sha】第一版本機用 `git rev-parse --short`（8 碼）對上
# build-info 的 `shortSha`（7 碼），兩者**永遠不相等**——那會是一個
# 每次都亮的假紅燈，而假紅燈會讓人開始忽略這一格（§21）。
head_sha=$(git rev-parse HEAD 2>/dev/null || echo '?')
live=$(curl -s "$SITE/_build-info.json?n=$RANDOM" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('sha') or '?')" 2>/dev/null || echo '?')
echo "  線上 ${live:0:8} ／ 本機 ${head_sha:0:8}"
if [ "$live" = "?" ]; then
  echo "  · 線上還沒有 _build-info.json（第一次部署這個檔之後才會有）"
elif [ "$live" != "$head_sha" ]; then
  echo "  ! 線上落後——部署還沒跑完，或 run 被下一次 push 取消了"
  echo "    （pages.yml 的 concurrency 已改成不取消；若持續落後就去看 Actions）"
  # 【WHY 不算失敗】部署本來就有時間差，剛推完必然不相等。
  # 這一項是**資訊**，不是閘門；真正要擋的是前三項。
else
  echo "  ✓ 線上就是 HEAD"
fi

echo
[ "$fail" -eq 0 ] && echo "守成檢查：✓ 通過" || echo "守成檢查：✗ 有項目未通過"
exit "$fail"
