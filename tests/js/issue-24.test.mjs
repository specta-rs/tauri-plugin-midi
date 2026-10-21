// Regression test for https://github.com/specta-rs/tauri-plugin-midi/issues/24
//
// `TauriMIDIInput.open()` used to register a process-wide `midi-message`
// listener whose callback closed over the port. The port holds `this.access`
// (its `MIDIAccess`), and Tauri's event registry holds that callback until the
// `UnlistenFn` returned by `close()` runs. So a port that was opened and never
// closed rooted its whole `MIDIAccess` — plus every port and listener it owns —
// for the lifetime of the webview. This is trivially hit: setting
// `onmidimessage` or adding a `midimessage` listener implicitly opens the port.
//
// The fix moves the routing to a single module-level listener that fans out
// through the existing weak instance set, so no event registration closes over a
// port and nothing is retained per access.
import test from "node:test";
import assert from "node:assert/strict";
import { collectGarbage, makeEnv, tick } from "./harness.mjs";

// Anchor environments for the lifetime of the process. The fake IPC registry
// lives on the environment, so if the whole `env` graph were collectable a
// genuinely retained callback (and therefore the port and its `MIDIAccess`)
// would be freed regardless of the bug and the leak assertion would pass
// vacuously. Referencing `env` here keeps the registry reachable across GC.
const liveEnvironments = [];

test("an opened, never-closed input does not retain its MIDIAccess", async () => {
  const env = await makeEnv();
  liveEnvironments.push(env);

  // Create the instance inside a helper so no binding to it survives on the test
  // frame; only the `WeakRef` escapes. This is exactly the pattern that leaked.
  const weak = await (async () => {
    const access = await env.requestAccess();
    env.stateChange([["in1", "Input 1"]], []);
    const port = access.inputs.get("in1");
    await port.open();
    assert.equal(port.connection, "open", "port should be open for the probe");
    return new env.sandbox.WeakRef(access);
  })();

  assert.equal(await collectGarbage(), true, "test must run with --expose-gc");
  assert.equal(
    weak.deref(),
    undefined,
    "an input that is opened and never closed must not retain its MIDIAccess",
  );
});

test("a message reaches onmidimessage and midimessage listeners while the input is open", async () => {
  const env = await makeEnv();
  liveEnvironments.push(env);

  const access = await env.requestAccess();
  env.stateChange([["in1", "Input 1"]], []);
  const port = access.inputs.get("in1");

  const viaProperty = [];
  const viaListener = [];
  port.onmidimessage = (event) => viaProperty.push(event);
  port.addEventListener("midimessage", (event) => viaListener.push(event));

  // Both attachment paths implicitly open the port.
  await tick();
  assert.equal(port.connection, "open", "attaching a handler implicitly opens the port");

  env.midiMessage("in1", 1234, [0x90, 0x3c, 0x64]);

  assert.equal(viaProperty.length, 1, "onmidimessage should receive the message");
  assert.equal(viaListener.length, 1, "addEventListener listener should receive the message");

  const event = viaProperty[0];
  assert.deepEqual(Array.from(event.data), [0x90, 0x3c, 0x64]);
  assert.equal(event.timeStamp, 1234);
  assert.equal(event.receivedTime, 1234);
});

test("a message for an input that is not open is not delivered", async () => {
  const env = await makeEnv();
  liveEnvironments.push(env);

  const access = await env.requestAccess();
  env.stateChange([["in1", "Input 1"]], []);
  const port = access.inputs.get("in1");

  const received = [];
  port.addEventListener("midimessage", (event) => received.push(event));
  await tick();
  assert.equal(port.connection, "open");

  // Control: while open, the message is delivered.
  env.midiMessage("in1", 1, [0x90, 0x01, 0x02]);
  assert.equal(received.length, 1);

  // Once closed, the same port must stop receiving messages.
  await port.close();
  assert.equal(port.connection, "closed");
  env.midiMessage("in1", 2, [0x90, 0x03, 0x04]);
  assert.equal(received.length, 1, "a closed input must not receive messages");
});

test("a message is routed to the input, not an output sharing its id", async () => {
  const env = await makeEnv();
  liveEnvironments.push(env);

  const access = await env.requestAccess();
  env.stateChange([["dup", "Input dup"]], [["dup", "Output dup"]]);
  const input = access.inputs.get("dup");
  const output = access.outputs.get("dup");

  const inputSeen = [];
  const outputSeen = [];
  input.onmidimessage = (event) => inputSeen.push(event);
  output.addEventListener("midimessage", (event) => outputSeen.push(event));
  await tick();

  env.midiMessage("dup", 5, [0x90, 0x07, 0x08]);

  assert.equal(inputSeen.length, 1, "the input should receive the message");
  assert.equal(outputSeen.length, 0, "an output with the same id must not receive messages");
});
