// 记忆库宠物桌面壳 —— Tauri v2
// 核心在 memory-lib（127.0.0.1:8787），本壳只负责桌面窗口与本地宠物 UI。
// 依赖：核心服务需在运行（node server.mjs 或开机自启任务）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let webview_url = match std::env::var("PET_URL") {
                Ok(url) => WebviewUrl::External(url.parse().expect("PET_URL must be a valid URL")),
                Err(_) => WebviewUrl::App("index.html".into()),
            };
            WebviewWindowBuilder::new(app, "pet", webview_url)
                .title("记忆库宠物")
                .inner_size(420.0, 620.0)
                .min_inner_size(360.0, 520.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .resizable(true)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
