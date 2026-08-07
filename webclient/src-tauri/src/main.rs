// ZJMUD Web 客戶端 — Tauri 外殼。
//
// 選擇 Tauri 而非純瀏覽器版的唯一理由：ZJMUD 協議是原生 TCP，
// 瀏覽器開不了 raw socket。Rust 端直接連，使用者不需要另外跑橋接程序。
// 詳見 docs/ZJMUD_CLIENT_LOGIC_DESIGN.md §1.1。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mud;
mod telnet;

use mud::MudState;
use tauri::Manager;

#[tauri::command]
async fn mud_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, MudState>,
    host: String,
    port: u16,
) -> Result<(), String> {
    state.connect(app, host, port).await
}

#[tauri::command]
async fn mud_send(state: tauri::State<'_, MudState>, line: String) -> Result<(), String> {
    state.send(line).await
}

#[tauri::command]
async fn mud_disconnect(state: tauri::State<'_, MudState>) -> Result<(), String> {
    state.disconnect().await;
    Ok(())
}

#[tauri::command]
async fn mud_is_connected(state: tauri::State<'_, MudState>) -> Result<bool, String> {
    Ok(state.is_connected().await)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(MudState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mud_connect,
            mud_send,
            mud_disconnect,
            mud_is_connected
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 應用啟動失敗");
}
