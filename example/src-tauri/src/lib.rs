#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // This is all that is required!
        .plugin(tauri_plugin_midi::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
