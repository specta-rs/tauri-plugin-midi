# Manual iframe check (issue #7)

The iframe support in `guest-js/index.ts` is a `postMessage` bridge from a
subframe to the top frame. It **cannot** be verified from Node — the shipped
tests substitute a fake `postMessage` bus, and the whole design rests on one
engine behaviour they cannot model:

> Does `MessageEvent.origin` for a document loaded from a Tauri custom scheme
> (`tauri://localhost` on macOS/Linux, `http://tauri.localhost` on Windows) equal
> that document's `location.origin`?

If it does not (for example if the engine serialises the custom scheme as
`"null"`), the bridge is correctly *disabled* — and the feature does not work, so
we must know that before shipping.

## How to run

```bash
cd example
pnpm tauri dev
```

Then open the **iframe check** link on the example's home page (or navigate to
`/iframe-check.html`). It loads the seven child frames below and prints, for
each, what the frame can see plus the result of a `postMessage` ping sent with
the top frame's own origin as `targetOrigin`.

## What a pass looks like

| Child | Expected |
| --- | --- |
| `same-origin src` | **bridged** — `requestMIDIAccess` resolves, `ports` non-zero, ping received, `child saw origin` equals the top's origin |
| `same-origin srcdoc` | **bridged** (same as above) |
| `same-origin blob:` | **bridged** (same as above) |
| `about:blank` | **bridged** (same as above) |
| `remote https://example.com` | **left alone** — the plugin must not install; if the engine has native Web MIDI it must be untouched |
| `sandbox=allow-scripts` | **left alone** — opaque origin, no polyfill, no bridge |
| `data: URL` | **left alone** — opaque origin, no polyfill, no bridge |

The `ping top→child` column is the load-bearing one. It sends a message with the
top frame's `location.origin` as `targetOrigin`. **If it reads `not yet` for a
same-origin frame, stop** — the bridge cannot receive either, and the feature
needs rework rather than a merge.

`__TAURI_INTERNALS__` is expected to be `no` in same-origin subframes on
**macOS and Linux** (Tauri injects the IPC into the main frame only, which is the
whole reason the bridge exists) and `yes` on **Windows** (WebView2 cannot scope an
init script to the main frame, so subframes take the "main" path and the bridge is
not used).

## Checklist

1. **macOS (WKWebView).** Same-origin rows bridge, opaque/remote rows are left
   alone, the ping column reads `received`, and `location.origin` is a real tuple
   origin (not `"null"`).
2. **Linux (WebKitGTK).** Same as (1).
3. **Windows (WebView2).** Same-origin rows bridge (via the "main" path, so
   `__TAURI_INTERNALS__` is `yes`); a cross-origin row is still left alone.
4. **MIDI actually flows.** In a bridged iframe: `navigator.requestMIDIAccess()`
   resolves, `inputs`/`outputs` list the devices, `open()`/`close()` work,
   `onmidimessage` fires from real hardware, and `send()` (with and without a
   timestamp) reaches the device.
5. **Rejection round-trip.** Unplug a device mid-`open()` inside the iframe; the
   rejection must be a `DOMException` with `name === "NotAllowedError"` and the
   backend message — not a plain `Error`.
6. **Hot-plug.** Plug/unplug a device with the iframe open; `statechange` must
   reach the iframe's `MIDIAccess` and the port maps must update.
7. **Back/forward cache.** With a bridged iframe open, trigger an in-app
   navigation and go back (or otherwise force the frame through bfcache); MIDI
   must keep working afterwards, not hang. (Covered by
   `a child restored from the back/forward cache keeps working` in
   `tests/js/issue-7.test.mjs`, but only against the fake bus.)
8. **Removing the iframe.** Remove it from the DOM; the top frame must stop
   posting to it (`children` is pruned rather than growing forever).
9. **Nested grandchild.** A frame inside a bridged frame must reach
   `window.top` and complete the handshake.
10. **Sibling forgery.** A same-origin sibling frame that knows the token must
    still be unable to drive a bridged child — only `window.top` is accepted.
11. **Non-Tauri top frame.** A bridged child whose top frame never answers must
    surface the intended `NotSupportedError` rejection after ~10s rather than
    hanging forever.
12. **Long-lived SPA.** A subframe that navigates within the same origin must
    re-handshake without leaking a `children` entry in the top frame.

If any same-origin check fails, collect the console output from both the top
frame and the child (the page prints its own report) before changing any code —
the failure is almost always in how the engine serialises the origin, not in the
bridge logic.
