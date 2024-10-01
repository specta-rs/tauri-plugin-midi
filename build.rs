const COMMANDS: &[&str] = &[
    "open_input",
    "close_input",
    "open_output",
    "close_output",
    "output_send",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .global_api_script_path("./src/polyfill.js")
        .build();
}
