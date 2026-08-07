# 江湖论剑（LPMud-Name）

| 項目 | 值 |
|------|-----|
| 出處 | 本倉庫 fork 的上游伺服器，原封保留在 `LPMud-Name/`（**不複製一份**，`mud.json` 的 `work` 直接指過去） |
| 授權 | Academic Free License 3.0（倉庫根目錄 `LICENSE`） |
| 編碼 | UTF-8（`config.ini` 的 `external_port_1 : telnet 5001` 就是 UTF-8 埠） |
| 方言 | classic（27 個核心 opcode）；握手行是 `ver1.0:<crypt>` |

## 為什麼 `work` 是指標而不是複本

其他 mud 是從收藏匯入的，各自有一份 `work/`。這一個不同：它本來就是這個倉庫的
一部分（README 有專門一節解釋 `LPMud-Name/world/driver.exe` 為什麼進版控）。
再複製 44 MB 到 `libs/lpmudname/work/` 只會讓倉庫肥一倍，而且兩份會漸行漸遠。

## WASM 上的已知落差

見 `NOTES.md`。
