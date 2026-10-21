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

## Releasing

Publishing to [crates.io](https://crates.io/crates/tauri-plugin-midi) uses
[crates.io trusted publishing](https://crates.io/docs/trusted-publishing): the
`release` workflow exchanges its GitHub OIDC identity for a short-lived crates.io
token, so **no long-lived `CARGO_REGISTRY_TOKEN` is stored** in this repository or
in Actions secrets.

**One-time setup** — a crate owner adds a trusted publisher in the crates.io UI
(the crate's **Settings → Trusted Publishing**). These values must match
`.github/workflows/release.yml` exactly, or the token exchange is refused:

| Field | Value |
| --- | --- |
| Owner | `specta-rs` |
| Repository | `tauri-plugin-midi` |
| Workflow filename | `release.yml` |
| Environment | `release` |

Adding required reviewers to the `release` GitHub environment is recommended: it
turns publishing into an approved action rather than something any tag push does.

**Cutting a release:**

1. Bump `version` in `Cargo.toml`, add a `CHANGELOG.md` entry, and merge both to
   `main`.
2. Tag the merge commit and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The `release` workflow then verifies the release (the tag matches `Cargo.toml`;
`src/polyfill.js` and `guest-js/bindings.ts` regenerate without changes; the JS
and Rust tests pass), publishes to crates.io, and creates the GitHub release.

## Iframe support

Web MIDI works in same-origin iframes; the plugin injects its polyfill into every
frame and bridges a subframe's calls to the top frame. Because that bridge depends
on how the webview serialises the Tauri custom-scheme origin — which cannot be
tested from Node — it has a manual check:
`example/iframe-check.html` plus `example/IFRAME-CHECKLIST.md`.

