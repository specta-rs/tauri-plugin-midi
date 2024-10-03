//! A WebMIDI-compatible plugin for Tauri
//!
//! Refer to the [init](fn.init.html) function for more information on how to use this plugin or checkout [the example](https://github.com/specta-rs/tauri-plugin-midi/tree/main/example).

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, PoisonError},
    thread::spawn,
    time::Duration,
};

use midir::{MidiInput, MidiOutput};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};
use tauri_specta::Event;

#[derive(Default)]
struct MidiState {
    input_connections: BTreeMap<String, midir::MidiInputConnection<()>>,
    output_connections: BTreeMap<String, midir::MidiOutputConnection>,
}

type State = Arc<Mutex<MidiState>>;

const PLUGIN_NAME: &str = "midi";
const RUNTIME_POLYFILL: &str = include_str!("polyfill.js");

fn get_inputs(midi_in: &midir::MidiInput) -> Result<Vec<(String, String)>, String> {
    midi_in
        .ports()
        .iter()
        .map(|p| {
            Ok((
                p.id(),
                midi_in
                    .port_name(p)
                    .map_err(|e| format!("Failed to get port name: {e}"))?,
            ))
        })
        .collect()
}

fn get_outputs(midi_out: &midir::MidiOutput) -> Result<Vec<(String, String)>, String> {
    midi_out
        .ports()
        .iter()
        .map(|p| {
            Ok((
                p.id(),
                midi_out
                    .port_name(p)
                    .map_err(|e| format!("Failed to get port name: {e}"))?,
            ))
        })
        .collect()
}

#[tauri::command(async)]
#[specta::specta]
fn open_input<R: tauri::Runtime>(
    id: String,
    state: tauri::State<State>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);

    if state.input_connections.contains_key(&id) {
        return Ok(());
    }

    let mut midi_in = MidiInput::new("").unwrap();
    midi_in.ignore(midir::Ignore::None);

    let ports = midi_in.ports();
    let port = ports
        .iter()
        .find(|p| p.id() == id)
        .ok_or_else(|| format!("Failed to find port by id '{id}'"))?;

    let connection = midi_in
        .connect(
            &port,
            "",
            {
                let id = id.clone();
                move |_, msg, _| {
                    MIDIMessage(id.to_string(), msg.to_vec())
                        .emit(&app)
                        .unwrap();
                }
            },
            (),
        )
        .map_err(|e| format!("Failed to open MIDI input to id '{id}': {e}"))?;

    state.input_connections.insert(id, connection);

    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
fn close_input(id: String, state: tauri::State<State>) {
    let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);

    if let Some(connection) = state.input_connections.remove(&id) {
        connection.close();
    }
}

#[tauri::command(async)]
#[specta::specta]
fn open_output(id: String, state: tauri::State<State>) -> Result<(), String> {
    let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);

    if state.output_connections.contains_key(&id) {
        return Ok(());
    }

    let midi_out = MidiOutput::new("").map_err(|e| format!("Failed to create MIDI output: {e}"))?;

    let ports = midi_out.ports();
    let port = ports
        .iter()
        .find(|p| p.id() == id)
        .ok_or_else(|| format!("Failed to find port by id '{id}'"))?;

    let connection = midi_out
        .connect(&port, "")
        .map_err(|e| format!("Failed to open MIDI output to id '{id}': {e}"))?;

    state.output_connections.insert(id, connection);

    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
fn close_output(id: String, state: tauri::State<State>) {
    let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);

    if let Some(connection) = state.output_connections.remove(&id) {
        connection.close();
    }
}

#[tauri::command(async)]
#[specta::specta]
fn output_send(id: String, msg: Vec<u8>, state: tauri::State<State>) -> Result<(), String> {
    let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);

    let connection = state
        .output_connections
        .get_mut(&id)
        .ok_or_else(|| format!("Failed to find output connection by name '{id}'"))?;

    connection
        .send(&msg)
        .map_err(|err| format!("Failed to send MIDI message to port '{id}': {err}"))?;

    Ok(())
}

#[derive(serde::Serialize, specta::Type, tauri_specta::Event, Clone, Debug)]
struct StateChange {
    inputs: Vec<(String, String)>,
    outputs: Vec<(String, String)>,
}

#[derive(serde::Serialize, specta::Type, tauri_specta::Event, Clone)]
struct MIDIMessage(String, Vec<u8>);

fn builder<R: Runtime>() -> tauri_specta::Builder<R> {
    tauri_specta::Builder::<R>::new()
        .plugin_name(PLUGIN_NAME)
        .commands(tauri_specta::collect_commands![
            open_input::<tauri::Wry>,
            close_input,
            open_output,
            close_output,
            output_send
        ])
        .events(tauri_specta::collect_events![StateChange, MIDIMessage])
}

/// Initialise the plugin which will take care of polyfilling WebMIDI into any Tauri webview.
///
/// # Usage
///
/// Using this plugin is very simple. Just add it to your Tauri builder:
///
/// ```rust
///  tauri::Builder::default()
///        .plugin(tauri_plugin_midi::init()) // <- This bit here
/// # ;
///        // .... rest of your builder
/// ```
///
/// Then give permissions to the plugin by adding the `midi:default` permissions to your application.
///
/// This can be done by modifying the `capabilities/default.json` file:
/// ```json
/// {
///   "$schema": "../gen/schemas/desktop-schema.json",
///   "identifier": "default",
///   "description": "Capability for the main window",
///   "windows": ["main"],
///   "permissions": ["core:default", "midi:default"] // <- add `midi:default` into here
/// }
/// ```
///
/// and now you can use the regular [WebMIDI API](https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API) from within your webview.
///
/// ## Known issues
///
/// - This plugin doesn't work within iframes at the moment. It's being tracked as [#7](https://github.com/specta-rs/tauri-plugin-midi/issues/7)
///
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = builder::<R>();

    Builder::new(PLUGIN_NAME)
        .invoke_handler(builder.invoke_handler())
        .js_init_script(RUNTIME_POLYFILL.into())
        .setup(move |app, _| {
            app.manage(State::default());

            builder.mount_events(app);

            let app = app.clone();

            #[cfg(target_os = "macos")]
            coremidi_hotplug_notification::receive_device_updates(|| {})
                .expect("Failed to register for MIDI device updates");

            spawn(move || {
                let midi_in = midir::MidiInput::new("tauri-plugin-midi blank input")
                    .map_err(|e| format!("Failed to create MIDI input: {e}"))
                    .unwrap();
                let midi_out = midir::MidiOutput::new("tauri-plugin-midi blank output")
                    .map_err(|e| format!("Failed to create MIDI output: {e}"))
                    .unwrap();

                loop {
                    StateChange {
                        inputs: get_inputs(&midi_in).unwrap_or_default(),
                        outputs: get_outputs(&midi_out).unwrap_or_default(),
                    }
                    .emit(&app)
                    .unwrap();

                    std::thread::sleep(Duration::from_millis(1000));
                }
            });

            Ok(())
        })
        .build()
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn export_types() {
        builder::<tauri::Wry>()
            .error_handling(tauri_specta::ErrorHandlingMode::Result)
            .export(
                specta_typescript::Typescript::default(),
                "./guest-js/bindings.ts",
            )
            .unwrap();
    }
}
