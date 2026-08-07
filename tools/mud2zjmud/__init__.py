"""mud2zjmud —— 把一般（telnet）mudlib 自動轉成**原生 zjmud** mudlib。

「原生」＝ 轉換後 mudlib **自己**說 zjmud 協議：握手、帳號欄位、建角欄位、
狀態碼、面板 opcode 全由伺服器端發出。標準 zjmud 客戶端直接可連，
不需要任何客戶端的 telnet 對話接應器（那是嫁接，不是轉換）。

整條流水線都在這個 package 裡：
    原始 mudlib 目錄 → 匯入 → 相容性修正 → 協議注入 → 原生登入 → 打包 → 驗證
"""
__version__ = "0.2.0"
