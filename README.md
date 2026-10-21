# tauri-plugin-midi

A [Tauri](https://tauri.app) plugin designed to emulate the [WebMIDI API](https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API).

[Documentation](https://docs.rs/tauri-plugin-midi)

## Contributing

To run the example:

```bash
pnpm i
pnpm build

cd example/
pnpm tauri dev
```

To run the tests:

```bash
pnpm i
pnpm test
```

`pnpm test` bundles the Web MIDI polyfill and drives it against a fake Tauri IPC
layer, so the polyfill's behaviour can be asserted from Node.
