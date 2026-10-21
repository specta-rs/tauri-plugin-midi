# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-21

### Added

- **Web MIDI now works inside same-origin iframes.** The polyfill is injected
  into every frame, and a subframe that has no Tauri IPC bridges its calls to the
  top frame over `postMessage` — gated on same-origin, with a handshake token and
  an explicit command allowlist. Cross-origin and opaque-origin frames are left
  completely untouched. `example/iframe-check.html` +
  `example/IFRAME-CHECKLIST.md` cover the manual cross-platform check that the
  Node tests cannot. ([#7])
- A JS test suite that drives the real polyfill against a fake Tauri IPC layer,
  run with `pnpm test`, with a regression test per fix below. ([#16])
- A `specta` cargo feature: `tauri-specta`/`specta` are now optional and off by
  default, so a normal build no longer compiles or bundles them. Type generation
  is preserved — `cargo test --features specta` still regenerates
  `guest-js/bindings.ts` from the Rust definitions. ([#5])

### Changed

- `port.open()` and `port.close()` now reject with a `DOMException` (for example
  `NotAllowedError`) carrying the backend message, rather than a bare string, and
  `output.send()` throws `DOMException`/`TypeError` as the Web MIDI spec
  requires. A failed `output_send` is logged instead of surfacing as an unhandled
  rejection. ([#12])
- `MIDIPort.state`/`connection` now match Chrome across disconnect and reconnect,
  including reusing the same `MIDIPort` instance so listeners survive a hotplug
  cycle. ([#13])

### Fixed

- An input port that is opened and never closed no longer roots its `MIDIAccess`
  — and every port and listener it owns — for the lifetime of the webview. The
  per-port `midi-message` listener is replaced by a single module-level listener
  routed through the weak instance set. ([#24])
- `navigator.requestMIDIAccess()` no longer retains every instance in a strong
  `Set`. ([#10])
- The plugin no longer panics at startup when registering for MIDI device-update
  notifications fails; device detection is handled by polling alone. ([#14])

[Unreleased]: https://github.com/specta-rs/tauri-plugin-midi/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/specta-rs/tauri-plugin-midi/compare/v0.2.0...v0.3.0
[#5]: https://github.com/specta-rs/tauri-plugin-midi/pull/21
[#7]: https://github.com/specta-rs/tauri-plugin-midi/issues/7
[#10]: https://github.com/specta-rs/tauri-plugin-midi/issues/10
[#12]: https://github.com/specta-rs/tauri-plugin-midi/issues/12
[#13]: https://github.com/specta-rs/tauri-plugin-midi/issues/13
[#14]: https://github.com/specta-rs/tauri-plugin-midi/issues/14
[#16]: https://github.com/specta-rs/tauri-plugin-midi/pull/16
[#24]: https://github.com/specta-rs/tauri-plugin-midi/issues/24
