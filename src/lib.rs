//! A WebMIDI-compatible plugin for Tauri
//!
//! Refer to the [init](fn.init.html) function for more information on how to use this plugin or checkout [the example](https://github.com/specta-rs/tauri-plugin-midi/tree/main/example).

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, PoisonError},
    thread::spawn,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use midir::{MidiInput, MidiOutput};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Emitter, Manager, Runtime,
};
use tokio::time::sleep_until;

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
#[cfg_attr(feature = "specta", specta::specta)]
fn open_input<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<State>,
    id: String,
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
                    let epoch = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .expect("System time is before epoch")
                        .as_millis();

                    if let Err(err) = app.emit(
                        "plugin:midi:midi-message",
                        MIDIMessage(id.to_string(), epoch.to_string(), msg.to_vec()),
                    ) {
                        eprintln!("Failed to emit MIDI message: {err}");
                    }
                }
            },
            (),
        )
        .map_err(|e| format!("Failed to open MIDI input to id '{id}': {e}"))?;

    state.input_connections.insert(id, connection);

    Ok(())
}

#[tauri::command(async)]
#[cfg_attr(feature = "specta", specta::specta)]
fn close_input(state: tauri::State<State>, id: String) {
    let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);

    if let Some(connection) = state.input_connections.remove(&id) {
        connection.close();
    }
}

#[tauri::command(async)]
#[cfg_attr(feature = "specta", specta::specta)]
fn open_output(state: tauri::State<State>, id: String) -> Result<(), String> {
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
#[cfg_attr(feature = "specta", specta::specta)]
fn close_output(state: tauri::State<State>, id: String) {
    let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);

    if let Some(connection) = state.output_connections.remove(&id) {
        connection.close();
    }
}

#[tauri::command(async)]
#[cfg_attr(feature = "specta", specta::specta)]
fn output_send(
    tstate: tauri::State<State>,
    id: String,
    msg: Vec<u8>,
    timestamp: Option<String>,
) -> Result<(), String> {
    let timestamp = timestamp
        .map(|s| {
            s.parse::<u128>()
                .map_err(|e| format!("Failed to parse timestamp: {e}"))
        })
        .transpose()?;

    let mut state = tstate.lock().unwrap_or_else(PoisonError::into_inner);
    let connection = state
        .output_connections
        .get_mut(&id)
        .ok_or_else(|| format!("Failed to find output connection by name '{id}'"))?;

    // TODO: Support this with OS timers properly: https://github.com/Boddlnagg/midir/issues/45
    if let Some(timestamp) = timestamp {
        drop(state);
        let tstate = (*tstate).clone();
        tauri::async_runtime::spawn(async move {
            let current_epoch = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("SystemTime is before epoch")
                .as_millis();

            let delay_ms = timestamp.saturating_sub(current_epoch);
            let until = Instant::now() + Duration::from_millis(delay_ms as u64);
            sleep_until(until.into()).await;

            let mut state = tstate.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(connection) = state.output_connections.get_mut(&id) {
                connection.send(&msg).ok();
            }
        });
    } else {
        connection
            .send(&msg)
            .map_err(|err| format!("Failed to send MIDI message to port '{id}': {err}"))?;
    }

    Ok(())
}

#[derive(serde::Serialize, Clone, Debug)]
#[cfg_attr(feature = "specta", derive(specta::Type, tauri_specta::Event))]
struct StateChange {
    inputs: Vec<(String, String)>,
    outputs: Vec<(String, String)>,
}

#[derive(serde::Serialize, Clone)]
#[cfg_attr(feature = "specta", derive(specta::Type, tauri_specta::Event))]
struct MIDIMessage(String, String, Vec<u8>);

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
/// The polyfill is injected into every frame (not just the main frame) so that it can be
/// used from within iframes. Tauri itself only injects `__TAURI_INTERNALS__` and the IPC
/// bridge into the main frame (and, on Windows, into subframes too), so in a same-origin
/// subframe on macOS/Linux the polyfill bridges its IPC calls to the top frame over
/// `postMessage`. See [issue #7](https://github.com/specta-rs/tauri-plugin-midi/issues/7).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    // Tauri did a breaking change in 2.7.0 so we do this outside to ensure backwards compatibility
    let polyfill: String = RUNTIME_POLYFILL.into();

    Builder::new(PLUGIN_NAME)
        .invoke_handler(tauri::generate_handler![
            open_input,
            close_input,
            open_output,
            close_output,
            output_send
        ])
        // Inject into all frames, not just the main frame. The polyfill is frame-aware: it
        // only activates in the top frame or in a same-origin child frame of it. Tauri's own
        // `__TAURI_INTERNALS__`/IPC scripts remain main-frame-only on macOS and Linux, which is
        // why subframes need the `postMessage` bridge rather than the IPC bridge directly.
        .js_init_script_on_all_frames(polyfill)
        .setup(move |app, _| {
            app.manage(State::default());

            let app = app.clone();

            spawn(move || loop {
                // Creating a MIDI client can fail transiently (e.g. the OS is
                // still tearing down a previous client). Never let that kill
                // device detection for the rest of the process - log it and
                // retry instead.
                let midi_in = match midir::MidiInput::new("tauri-plugin-midi blank input") {
                    Ok(midi_in) => midi_in,
                    Err(e) => {
                        eprintln!("Failed to create MIDI input: {e}");
                        std::thread::sleep(Duration::from_millis(1000));
                        continue;
                    }
                };
                let midi_out = match midir::MidiOutput::new("tauri-plugin-midi blank output") {
                    Ok(midi_out) => midi_out,
                    Err(e) => {
                        eprintln!("Failed to create MIDI output: {e}");
                        std::thread::sleep(Duration::from_millis(1000));
                        continue;
                    }
                };

                loop {
                    let state_change = StateChange {
                        inputs: get_inputs(&midi_in).unwrap_or_default(),
                        outputs: get_outputs(&midi_out).unwrap_or_default(),
                    };
                    if let Err(err) = app.emit("plugin:midi:state-change", state_change) {
                        eprintln!("Failed to emit MIDI state change: {err}");
                    }

                    std::thread::sleep(Duration::from_millis(1000));
                }
            });

            Ok(())
        })
        .build()
}

#[cfg(all(test, feature = "specta"))]
mod test {
    use super::*;

    #[test]
    fn export_types() {
        tauri_specta::Builder::<tauri::Wry>::new()
            .plugin_name(PLUGIN_NAME)
            .commands(tauri_specta::collect_commands![
                open_input::<tauri::Wry>,
                close_input,
                open_output,
                close_output,
                output_send
            ])
            .events(tauri_specta::collect_events![StateChange, MIDIMessage])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(
                specta_typescript::Typescript::default(),
                "./guest-js/bindings.ts",
            )
            .unwrap();
    }
}
