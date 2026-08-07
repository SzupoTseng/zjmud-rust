<!-- generated -->
# 剑影江湖

| 項目 | 值 |
|------|-----|
| 現況 | ✅ 可玩（註冊 → 建角 → 進世界整條走得完） |
| 收藏來源 | `剑影江湖` |
| 設定檔 | `config.hell` |
| 方言 | dmjh |
| 映像 | 15.9 MB |

## 授權與出處

這份 mudlib **不是本 fork 的著作**。它來自公開流傳的 zjmud 收藏，
原作者與授權條款以 mudlib 內的檔頭註解與說明檔為準；本倉庫未變更、
也未主張任何著作權。若你是原作者且不希望它出現在這裡，開一個 issue，我會移除。

本 fork 對它做過的事只有三類，全部逐項記在 [`NOTES.md`](NOTES.md)：

1. **轉碼**：GBK → UTF-8（WASM driver 沒有表格式字集）
2. **去識別化**：刪除含密碼欄的玩家存檔、遮蔽寫死的憑證
3. **相容性修正**：讓它能在現代 FluffOS 的 WASM build 上開機

## 重建

```bash
# 從收藏重新匯入（來源對應表在 webclient/tools/import-all.mjs）
node webclient/tools/import-all.mjs --slug jianyingjianghu --force
# 解開映像來看 LPC 原始碼
node webclient/tools/unpack-lib.mjs libs/jianyingjianghu --out /tmp/jianyingjianghu
```
