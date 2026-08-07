//! ZJMUD TCP 連線管理。
//!
//! 協議是原生 TCP、UTF-8、以換行分幀，外層再包一層 telnet 選項協商
//! （詳見 docs/ZJMUD_CLIENT_PROTOCOL.md §1 與 telnet.rs）。
//! 本模組只負責「把位元組串流變成一行一行的字串」與「把字串送出去」，
//! 完全不解析協議語意 —— opcode 與樣式解析都在前端 JS。
//!
//! 設計取捨：
//!   * 讀取用 async 任務 + emit 事件，不做輪詢（原 Android 客戶端是 sleep 輪詢）。
//!   * 寫入走 mpsc channel 由單一 writer 任務消化，避免每送一條指令就開一條執行緒；
//!     通道型別是 `Vec<u8>` 而非 `String`，因為 telnet 協商回覆是二進位。
//!   * 讀取在**位元組層**分行，不用 `read_line` —— 原因見 spawn_reader 的說明。

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};

use crate::telnet;

/// 單行上限。防止異常伺服器送出無限長的一行把記憶體吃光。
const MAX_LINE_BYTES: usize = 64 * 1024;

/// 送出佇列深度。
const SEND_QUEUE_DEPTH: usize = 256;

pub const EVENT_LINE: &str = "mud://line";
pub const EVENT_STATE: &str = "mud://state";

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum ConnState {
    Open { host: String, port: u16 },
    Closed { reason: String },
    Error { message: String },
}

/// 連線控制代碼。`None` 表示目前沒有連線。
#[derive(Default)]
pub struct MudState {
    inner: Arc<Mutex<Option<Handle>>>,
}

struct Handle {
    /// 送往 writer 任務的佇列（已經是要寫進 socket 的原始位元組）。
    tx: mpsc::Sender<Vec<u8>>,
    /// 送出停止訊號會讓讀取任務結束；附帶的 StopReason 決定要不要通知前端。
    shutdown: Option<tokio::sync::oneshot::Sender<StopReason>>,
}

/// 讀取任務為什麼結束。**這個區分是必要的，不是分類癖。**
///
/// 【WHY】使用者回報「登入成功的提示狂跳、伺服器 log 每秒多一次登入」。
/// 實測：關掉客戶端後伺服器 debug.log 立刻停止增長，累計已寫入 50,251 次登入。
///
/// 【推理】`connect()` 會先斷開舊連線再開新的。舊連線的讀取任務結束時無條件
/// emit `Closed`，前端 `handleClosed()` 把它當成「非預期斷線」→ `scheduleReconnect()`
/// → 一秒後又 `connect()` → 又斷舊的 → 又 emit Closed……形成 1 Hz 無限迴圈。
/// 退避序列（1/2/4/8/16/30 秒）從未升上去，因為每次重連都**成功**並把 retries 歸零，
/// 所以永遠停在第一級的 1 秒 —— 與 log 實測的每秒一次完全吻合。
/// 曾誤判為「伺服器重複送 ver1.0: 挑戰行」，但 logind.c:70 `logon()` 只在**新連線**時送，
/// 反而證明了每一行挑戰 = 一條新 TCP。
///
/// 【證據】LPMud-Name `world/adm/daemons/logind.c:82` 於 logon() 送出挑戰；
/// `world/clone/user/user.c:346` reconnect() 印「重新连接成功。」；
/// 伺服器 `world/log/debug.log` 每秒新增一組 crypt 警告（每組 = 一次 get_user 驗證）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopReason {
    /// 使用者/前端主動斷線 —— 要通知前端。
    UserClose,
    /// 被新的 connect() 取代 —— **不可**通知前端，否則觸發上述重連迴圈。
    Replaced,
}

impl MudState {
    pub fn new() -> Self {
        Self::default()
    }

    /// 建立連線。若已有連線會先關閉（且**不**通知前端，見 StopReason）。
    pub async fn connect(&self, app: AppHandle, host: String, port: u16) -> Result<(), String> {
        // 先斷開舊連線，避免兩條 socket 同時往前端 emit 事件。
        // ★ 用 Replaced 而非 UserClose：這次關閉是我們自己造成的，
        //   前端不該把它當成「伺服器把我踢了」而啟動重連。
        self.stop(StopReason::Replaced).await;

        let stream = TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|e| format!("無法連線到 {host}:{port} — {e}"))?;

        // MUD 是互動式的，每次送出都是短指令，延遲比吞吐重要。
        stream
            .set_nodelay(true)
            .map_err(|e| format!("設定 TCP_NODELAY 失敗：{e}"))?;

        let (read_half, write_half) = stream.into_split();
        let (tx, rx) = mpsc::channel::<Vec<u8>>(SEND_QUEUE_DEPTH);
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<StopReason>();

        spawn_writer(write_half, rx);
        spawn_reader(app.clone(), read_half, shutdown_rx, tx.clone());

        *self.inner.lock().await = Some(Handle {
            tx,
            shutdown: Some(shutdown_tx),
        });

        let _ = app.emit(EVENT_STATE, ConnState::Open { host, port });
        Ok(())
    }

    /// 送出一行指令。呼叫端負責 multiline→`;` 的轉換（協議 §1.1），
    /// 這裡只補上換行符。
    pub async fn send(&self, line: String) -> Result<(), String> {
        let guard = self.inner.lock().await;
        let handle = guard.as_ref().ok_or("尚未連線")?;
        let mut buf = line.into_bytes();
        buf.push(b'\n');
        handle
            .tx
            .send(buf)
            .await
            .map_err(|_| "連線已關閉，指令未送出".to_string())
    }

    pub async fn disconnect(&self) {
        self.stop(StopReason::UserClose).await;
    }

    /// 停止目前連線。`reason` 決定讀取任務結束時要不要 emit `Closed` 給前端。
    async fn stop(&self, reason: StopReason) {
        if let Some(mut handle) = self.inner.lock().await.take() {
            // 丟掉 sender 會讓 writer 任務的 recv() 回傳 None 而結束。
            if let Some(sig) = handle.shutdown.take() {
                let _ = sig.send(reason);
            }
        }
    }

    pub async fn is_connected(&self) -> bool {
        self.inner.lock().await.is_some()
    }
}

/// 單一 writer 任務：串行化所有送出，避免交錯寫入把一行切斷。
fn spawn_writer(mut write_half: tokio::net::tcp::OwnedWriteHalf, mut rx: mpsc::Receiver<Vec<u8>>) {
    tokio::spawn(async move {
        while let Some(buf) = rx.recv().await {
            if write_half.write_all(&buf).await.is_err() {
                break;
            }
            if write_half.flush().await.is_err() {
                break;
            }
        }
        let _ = write_half.shutdown().await;
    });
}

/// 讀取任務：讀原始位元組 → 剝除 telnet IAC → 以 \n 分行 → 解碼後 emit。
///
/// 【為什麼不用 read_line】
/// 實機測試（LPMud-Name FluffOS，2026-07-28）證實伺服器一連上就送 6 組 telnet IAC 協商：
/// `ff fd 18 ff fd 1f ff fd 27 ff fb 56 ff fb 46 ff fb 2a`。
/// `0xFF` 不是合法 UTF-8，`BufReader::read_line` 會回 `InvalidData` 直接結束讀取任務 ——
/// 連線在第一個位元組就死。因此必須在位元組層處理，見 telnet.rs。
///
/// 解碼一律用 `from_utf8_lossy`：MUD 資料偶有壞位元組（例如 GBK 內容被送到 UTF-8 埠），
/// 壞一行不該讓整條連線斷掉，降級成替換字元即可。
fn spawn_reader(
    app: AppHandle,
    read_half: tokio::net::tcp::OwnedReadHalf,
    mut shutdown: tokio::sync::oneshot::Receiver<StopReason>,
    negotiate_tx: mpsc::Sender<Vec<u8>>,
) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(read_half);
        let mut chunk = vec![0u8; 8192];
        let mut pending: Vec<u8> = Vec::with_capacity(8192);

        let reason = loop {
            let read = tokio::select! {
                biased;
                stop = &mut shutdown => {
                    // 被新的 connect() 取代 → 靜靜退場，**不可** emit Closed。
                    // emit 了會讓前端啟動重連，而重連又會取代連線，形成 1 Hz 無限迴圈。
                    if stop == Ok(StopReason::Replaced) {
                        return;
                    }
                    break "使用者主動斷線".to_string();
                }
                r = reader.read(&mut chunk) => r,
            };

            let n = match read {
                Ok(0) => break "伺服器關閉連線".to_string(),
                Ok(n) => n,
                Err(e) => {
                    let _ = app.emit(EVENT_STATE, ConnState::Error { message: e.to_string() });
                    break format!("讀取錯誤：{e}");
                }
            };

            // 剝除 IAC，並把「拒絕協商」的回覆交給 writer 任務送出。
            let filtered = telnet::filter(&chunk[..n]);
            if !filtered.reply.is_empty() {
                let _ = negotiate_tx.try_send(filtered.reply);
            }
            pending.extend_from_slice(&filtered.data);

            // 以 \n 分行
            while let Some(idx) = pending.iter().position(|&b| b == b'\n') {
                let mut line: Vec<u8> = pending.drain(..=idx).collect();
                line.pop(); // 去掉 \n
                if line.last() == Some(&b'\r') {
                    line.pop(); // 伺服器可能送 \r\n
                }
                if line.len() > MAX_LINE_BYTES {
                    line.truncate(MAX_LINE_BYTES);
                }
                let text = String::from_utf8_lossy(&line);
                if app.emit(EVENT_LINE, text.as_ref()).is_err() {
                    return; // 前端已關閉
                }
            }

            // 沒有換行卻已超過上限：丟棄，避免異常伺服器把記憶體吃光。
            if pending.len() > MAX_LINE_BYTES {
                pending.clear();
            }
        };

        let _ = app.emit(EVENT_STATE, ConnState::Closed { reason });
    });
}
