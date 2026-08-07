//! Telnet IAC 協商處理。
//!
//! 【為什麼需要這個】
//! 原本以為 ZJMUD 是「純 TCP、沒有 telnet 協商」，實機測試推翻了這個假設：
//! FluffOS driver 一連上就送 6 組 IAC（實測 `ff fd 18 ff fd 1f ff fd 27
//! ff fb 56 ff fb 46 ff fb 2a`，即 DO TERMINAL-TYPE/NAWS/NEW-ENVIRON、
//! WILL MCCP2/MSSP/CHARSET）。不處理會有兩個致命後果：
//!
//!   1. `0xFF` 不是合法 UTF-8。若用 `read_line` 讀進 `String`，
//!      tokio 會回 `InvalidData` 而讓讀取任務直接結束 —— 連線一開始就死。
//!   2. 若誤答應 MCCP2（選項 86），伺服器之後會改送 zlib 壓縮串流，
//!      整條連線變成無法解讀的二進位。
//!
//! 因此本模組：以位元組層剝除所有 IAC 序列，並對協商**一律拒絕**
//! （對方 WILL → 我方 DONT；對方 DO → 我方 WONT），把串流維持成純文字。

pub const IAC: u8 = 255;
pub const DONT: u8 = 254;
pub const DO: u8 = 253;
pub const WONT: u8 = 252;
pub const WILL: u8 = 251;
pub const SB: u8 = 250;
pub const SE: u8 = 240;

/// 剝除結果。
pub struct Filtered {
    /// 去掉 IAC 之後的純資料位元組。
    pub data: Vec<u8>,
    /// 應該回送給伺服器的拒絕協商序列（可能為空）。
    pub reply: Vec<u8>,
}

/// 從一段位元組中剝除 telnet IAC 序列，並產生「全部拒絕」的回覆。
///
/// 注意：本函式假設 IAC 序列不會跨 TCP 分段被切斷。ZJMUD 的協商只在
/// 連線瞬間送出且只有 18 個位元組，實務上不會被切開；為求穩健，
/// 尾端若出現不完整的序列會被丟棄而非誤判成資料。
pub fn filter(buf: &[u8]) -> Filtered {
    let mut data = Vec::with_capacity(buf.len());
    let mut reply = Vec::new();
    let mut i = 0usize;

    while i < buf.len() {
        if buf[i] != IAC {
            data.push(buf[i]);
            i += 1;
            continue;
        }
        // buf[i] == IAC
        let Some(&cmd) = buf.get(i + 1) else { break }; // 不完整，丟棄

        match cmd {
            // IAC IAC =「一個真正的 0xFF 資料位元組」
            IAC => {
                data.push(IAC);
                i += 2;
            }
            // 子協商：一路吃到 IAC SE
            SB => {
                let mut j = i + 2;
                while j + 1 < buf.len() && !(buf[j] == IAC && buf[j + 1] == SE) {
                    j += 1;
                }
                i = j + 2;
            }
            // 對方說「我要啟用 X」→ 我方拒絕
            WILL => {
                if let Some(&opt) = buf.get(i + 2) {
                    reply.extend_from_slice(&[IAC, DONT, opt]);
                    i += 3;
                } else {
                    break;
                }
            }
            // 對方說「請你啟用 X」→ 我方拒絕
            DO => {
                if let Some(&opt) = buf.get(i + 2) {
                    reply.extend_from_slice(&[IAC, WONT, opt]);
                    i += 3;
                } else {
                    break;
                }
            }
            // 對方拒絕/停用：無須回覆，直接吃掉
            WONT | DONT => {
                if buf.get(i + 2).is_some() {
                    i += 3;
                } else {
                    break;
                }
            }
            // 其他兩位元組命令（NOP/AYT/GA…）
            _ => i += 2,
        }
    }

    Filtered { data, reply }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 實測從 LPMud-Name 伺服器收到的開場位元組。
    const REAL_GREETING: &[u8] = &[
        0xff, 0xfd, 0x18, // DO TERMINAL-TYPE
        0xff, 0xfd, 0x1f, // DO NAWS
        0xff, 0xfd, 0x27, // DO NEW-ENVIRON
        0xff, 0xfb, 0x56, // WILL MCCP2
        0xff, 0xfb, 0x46, // WILL MSSP
        0xff, 0xfb, 0x2a, // WILL CHARSET
        0x0d, 0x0a, b'v', b'e', b'r', b'1', b'.', b'0', b':', 0x0d, 0x0a,
    ];

    #[test]
    fn strips_real_server_greeting() {
        let out = filter(REAL_GREETING);
        assert_eq!(out.data, b"\r\nver1.0:\r\n");
    }

    #[test]
    fn refuses_every_negotiation() {
        let out = filter(REAL_GREETING);
        // 三個 DO → 三個 WONT；三個 WILL → 三個 DONT
        assert_eq!(
            out.reply,
            vec![
                IAC, WONT, 0x18,
                IAC, WONT, 0x1f,
                IAC, WONT, 0x27,
                IAC, DONT, 0x56, // 必須拒絕 MCCP2，否則之後全變 zlib 串流
                IAC, DONT, 0x46,
                IAC, DONT, 0x2a,
            ]
        );
    }

    #[test]
    fn passes_plain_text_through() {
        let out = filter("客棧大廳\n".as_bytes());
        assert_eq!(out.data, "客棧大廳\n".as_bytes());
        assert!(out.reply.is_empty());
    }

    #[test]
    fn escaped_ff_becomes_single_byte() {
        let out = filter(&[b'a', IAC, IAC, b'b']);
        assert_eq!(out.data, vec![b'a', 0xff, b'b']);
    }

    #[test]
    fn subnegotiation_is_dropped() {
        let out = filter(&[b'a', IAC, SB, 0x18, 0x01, IAC, SE, b'b']);
        assert_eq!(out.data, vec![b'a', b'b']);
    }

    #[test]
    fn truncated_sequence_is_dropped_not_leaked() {
        let out = filter(&[b'a', IAC, WILL]);
        assert_eq!(out.data, vec![b'a'], "不完整的序列不可外洩成資料");
    }
}
