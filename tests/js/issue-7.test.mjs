// Web MIDI inside iframes (https://github.com/specta-rs/tauri-plugin-midi/issues/7)
//
// The plugin runs its polyfill in every frame, but only the main frame gets the
// Tauri IPC. These tests drive a simulated top frame / child frame tree through
// the shared `postMessage` bus to check that:
//
//   * the main frame is unchanged, and only relays to children once one asks;
//   * a same-origin child without the IPC is bridged to the top frame, and
//     commands, port state and MIDI messages all flow across it;
//   * a frame that is not same-origin with the top frame gets nothing, and the
//     top frame refuses to serve it even if it asks;
//   * only the real top frame can drive a bridged child;
//   * an *opaque* origin (`"null"`) is never bridgeable on either end;
//   * a rejection that crosses the bridge arrives as the same named
//     `DOMException` it would have been in the top frame;
//   * a child that goes away is eventually dropped from the relay.
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, tick } from "./harness.mjs";

const BRIDGE_TAG = "tauri-plugin-midi/frame-bridge";

/** Let every queued microtask and timer callback in a frame tree settle. */
async function settle(ms = 5) {
  await tick(ms);
}

function bridgeMessage(extra) {
  return { [BRIDGE_TAG]: true, ...extra };
}

/** How many times something posted into `env`'s frame through the shared bus. */
function postsTo(env) {
  return env.frame.bus.posts.filter((post) => post.to === env.frame).length;
}

test("main frame behaviour is unchanged when it has no child frames", async () => {
  const env = await makeEnv({
    initial: { inputs: [["in-1", "Keyboard"]], outputs: [["out-1", "Synth"]] },
  });

  assert.equal(env.loadError, null);
  assert.equal(env.installed, true);

  const access = await env.requestAccess();
  assert.deepEqual([...access.inputs.keys()], ["in-1"]);
  assert.deepEqual([...access.outputs.keys()], ["out-1"]);

  await access.outputs.get("out-1").open();
  await access.outputs.get("out-1").send([0x90, 0x40, 0x7f]);

  assert.deepEqual(
    env.ipc.midiCalls.map((call) => call.command),
    ["plugin:midi|open_output", "plugin:midi|output_send"]
  );

  // Exactly two backend events, and bridging a child adds no third: `state-change`
  // is fanned out to live instances, and `midi-message` is the single routing
  // listener that serves both local input ports (#24) and bridged children.
  assert.deepEqual(env.ipc.eventListeners, [
    "plugin:midi:state-change",
    "plugin:midi:midi-message",
  ]);
});

test("a same-origin child frame is bridged to the top frame", async () => {
  const top = await makeEnv({
    initial: { inputs: [["in-1", "Keyboard"]], outputs: [["out-1", "Synth"]] },
  });
  const child = await makeEnv({ withInternals: false, top });
  await settle();

  assert.equal(child.loadError, null);
  assert.equal(child.installed, true);

  // `requestMIDIAccess()` settles from the state the top frame hands over.
  const access = await child.requestAccess();
  assert.deepEqual([...access.inputs.keys()], ["in-1"]);
  assert.deepEqual([...access.outputs.keys()], ["out-1"]);
  assert.equal(access.inputs.get("in-1").name, "Keyboard");

  // Opening a port in the child performs the IPC call in the top frame.
  const input = access.inputs.get("in-1");
  await input.open();
  assert.equal(input.connection, "open");
  assert.deepEqual(
    top.ipc.midiCalls.map((call) => call.command),
    ["plugin:midi|open_input"]
  );
  assert.deepEqual(child.ipc.midiCalls, []);

  // ...and the top frame now subscribes to MIDI messages on the child's behalf.
  assert.deepEqual(top.ipc.eventListeners, [
    "plugin:midi:state-change",
    "plugin:midi:midi-message",
  ]);

  // MIDI messages reach the child's listeners.
  const received = [];
  input.onmidimessage = (event) => received.push([...event.data]);
  top.midiMessage("in-1", 4321, [0x90, 0x3c, 0x7f]);
  await settle();
  assert.deepEqual(received, [[0x90, 0x3c, 0x7f]]);

  // Messages for other ports are ignored.
  top.midiMessage("in-2", 4321, [0x90, 0x3c, 0x7f]);
  await settle();
  assert.deepEqual(received, [[0x90, 0x3c, 0x7f]]);

  // Port list changes are forwarded too.
  top.stateChange(
    [
      ["in-1", "Keyboard"],
      ["in-2", "Pads"],
    ],
    [["out-1", "Synth"]]
  );
  await settle();
  assert.deepEqual([...access.inputs.keys()], ["in-1", "in-2"]);
  assert.equal(access.inputs.get("in-2").state, "connected");

  // A new instance in the child starts from the forwarded state.
  const second = await child.requestAccess();
  assert.deepEqual([...second.inputs.keys()], ["in-1", "in-2"]);

  // Outputs work over the bridge as well, including the timestamp argument.
  const output = access.outputs.get("out-1");
  await output.open();
  output.send([0x90, 0x40, 0x7f], 10);
  await settle();
  assert.deepEqual(
    top.ipc.midiCalls.map((call) => call.command),
    ["plugin:midi|open_input", "plugin:midi|open_output", "plugin:midi|output_send"]
  );
  const send = top.ipc.midiCalls.at(-1).args;
  assert.equal(send.id, "out-1");
  assert.deepEqual(send.msg, [0x90, 0x40, 0x7f]);
  assert.equal(typeof send.timestamp, "string");
});

test("a child frame without the IPC does not touch the Tauri API directly", async () => {
  const top = await makeEnv();
  const child = await makeEnv({ withInternals: false, top });
  await settle();

  // The bundled `@tauri-apps/api` would throw if the child ever called it; the
  // polyfill only ever goes through the bridge.
  assert.equal(child.sandbox.__TAURI_INTERNALS__, undefined);
  const access = await child.requestAccess();
  const error = child.frame.errors[0];
  assert.equal(error, undefined);
  assert.equal(access.sysexEnabled, true);
});

test("same-origin inherited-origin children (srcdoc, about:blank, blob:) are bridged", async () => {
  // `srcdoc`, `about:blank` and `blob:` documents inherit the origin of whoever
  // embedded them, so they are indistinguishable from any other same-origin
  // child (the harness models a frame by its origin, which is the only thing the
  // gate looks at). They are bridged on purpose: the app wrote that markup, and
  // the document already has the same DOM access to the top frame that a
  // bridged child gets.
  const top = await makeEnv({ initial: { inputs: [["in-1", "Keyboard"]] } });
  const inherited = await makeEnv({ withInternals: false, top });
  await settle();

  assert.equal(inherited.installed, true);
  const access = await inherited.requestAccess();
  assert.deepEqual([...access.inputs.keys()], ["in-1"]);
  await access.inputs.get("in-1").open();
  assert.deepEqual(
    top.ipc.midiCalls.map((call) => call.command),
    ["plugin:midi|open_input"]
  );
});

test("a cross-origin child frame is not given the polyfill or the IPC", async () => {
  const top = await makeEnv({ initial: { inputs: [["in-1", "Keyboard"]] } });
  const remote = await makeEnv({
    withInternals: false,
    top,
    origin: "https://evil.example",
  });
  await settle();

  // The frame is left completely alone, so the page keeps its own Web MIDI.
  assert.equal(remote.installed, false);
  assert.equal(remote.sandbox.MIDIAccess, undefined);

  // Even if the frame tries to talk to the top frame, it gets nothing back.
  remote.sandbox.top.postMessage(bridgeMessage({ kind: "hello", client: "remote" }), "*");
  remote.sandbox.top.postMessage(
    bridgeMessage({
      kind: "invoke",
      client: "remote",
      token: "guessed",
      id: "1",
      command: "openInput",
      args: ["in-1"],
    }),
    "*"
  );
  await settle();

  assert.deepEqual(top.ipc.midiCalls, []);
  assert.deepEqual(remote.messages, []);
});

test("a sandboxed/opaque child stays inert under a normal top frame", async () => {
  // `sandbox` without `allow-same-origin`, and `data:` documents, get an opaque
  // origin that serialises to "null". Such a frame must never receive the
  // polyfill (so its own native Web MIDI, if any, is untouched) and must never
  // be served by the top frame.
  const top = await makeEnv({ initial: { inputs: [["in-1", "Keyboard"]] } });
  const sandboxed = await makeEnv({ withInternals: false, top, origin: "null" });
  await settle();

  assert.equal(sandboxed.installed, false);
  assert.equal(sandboxed.sandbox.MIDIAccess, undefined);

  sandboxed.sandbox.top.postMessage(bridgeMessage({ kind: "hello", client: "opaque" }), "*");
  sandboxed.sandbox.top.postMessage(
    bridgeMessage({
      kind: "invoke",
      client: "opaque",
      token: "guessed",
      id: "1",
      command: "openInput",
      args: ["in-1"],
    }),
    "*"
  );
  await settle();

  assert.deepEqual(top.ipc.midiCalls, []);
  assert.deepEqual(sandboxed.messages, []);
});

test("an opaque top frame serves nobody, including a frame that shares its origin", async () => {
  // A `file://` or `data:` main document has an opaque origin. Its own MIDI must
  // keep working, but it must not act as a relay: every opaque origin serialises
  // to "null", so it cannot tell a sandboxed stranger from a frame the app meant
  // to bridge, and "null" must therefore never be used as an origin gate.
  const top = await makeEnv({ origin: "null", initial: { inputs: [["in-1", "Keyboard"]] } });
  assert.equal(top.installed, true);

  const access = await top.requestAccess();
  assert.deepEqual([...access.inputs.keys()], ["in-1"]);
  await access.inputs.get("in-1").open();
  assert.deepEqual(
    top.ipc.midiCalls.map((call) => call.command),
    ["plugin:midi|open_input"]
  );

  // A frame that shares the opaque origin must refuse to bridge (its own
  // `location` read cannot tell it apart from any other opaque frame)...
  const opaqueChild = await makeEnv({ withInternals: false, top, origin: "null" });
  await settle();
  assert.equal(opaqueChild.installed, false);

  // ...and if it asks anyway, the top frame must refuse to answer.
  opaqueChild.sandbox.top.postMessage(bridgeMessage({ kind: "hello", client: "opaque" }), "*");
  await settle();
  assert.equal(
    opaqueChild.messages.find((message) => message.data.kind === "welcome"),
    undefined,
    "an opaque top frame must not welcome a frame"
  );

  opaqueChild.sandbox.top.postMessage(
    bridgeMessage({
      kind: "invoke",
      client: "opaque",
      token: "guessed",
      id: "1",
      command: "openOutput",
      args: ["out-1"],
    }),
    "*"
  );
  await settle();
  assert.deepEqual(
    top.ipc.midiCalls.map((call) => call.command),
    ["plugin:midi|open_input"]
  );
});

test("only the top frame can drive a bridged child", async () => {
  const top = await makeEnv({
    initial: { inputs: [["in-1", "Keyboard"]], outputs: [] },
  });
  const child = await makeEnv({ withInternals: false, top });
  // Another same-origin frame in the same webview.
  const sibling = await makeEnv({ bus: top.frame.bus });
  await settle();

  const access = await child.requestAccess();
  assert.deepEqual([...access.inputs.keys()], ["in-1"]);

  // The handshake token is only meant for the top frame, but pretend the
  // attacker knows it: the child must still ignore anything that does not come
  // from `window.top` itself.
  const welcome = child.messages.find((message) => message.data.kind === "welcome");
  assert.ok(welcome, "the top frame should have welcomed the child");
  const token = welcome.data.token;

  sibling.postTo(
    child,
    bridgeMessage({
      kind: "event",
      name: "state-change",
      token,
      payload: { inputs: [["evil", "Impostor"]], outputs: [] },
    })
  );
  // A malformed event name must not blow up the child's message handling
  // either — `name` is used as a key into the listener table.
  sibling.postTo(child, bridgeMessage({ kind: "event", name: "__proto__", token, payload: {} }));
  await settle();

  assert.deepEqual([...access.inputs.keys()], ["in-1"]);
  assert.equal(typeof child.sandbox.MIDIAccess, "function");
  assert.deepEqual(child.frame.errors, []);
});

test("a bridged rejection is the same named DOMException the top frame would throw", async () => {
  const top = await makeEnv({ initial: { outputs: [["out-1", "Synth"]] } });
  const child = await makeEnv({ withInternals: false, top });
  await settle();

  const access = await child.requestAccess();
  const output = access.outputs.get("out-1");

  // `open()` rejects identically in both frames: the bridge must carry the
  // exception name across, not just its message, or consumers that branch on
  // `error.name` would behave differently inside an iframe.
  top.ipc.setFailure("plugin:midi|open_output", "Failed to open MIDI output to id 'out-1'");
  await assert.rejects(output.open(), (error) => {
    assert.ok(error instanceof child.sandbox.DOMException, `expected a DOMException, got ${error}`);
    assert.equal(error.name, "NotAllowedError");
    assert.match(error.message, /Failed to open MIDI output/);
    return true;
  });

  // A `close()` failure round-trips too.
  top.ipc.clearFailure();
  await output.open();
  assert.equal(output.connection, "open");
  top.ipc.setFailure("plugin:midi|close_output", "Failed to close MIDI output to id 'out-1'");
  await assert.rejects(output.close(), (error) => {
    assert.ok(error instanceof child.sandbox.DOMException, `expected a DOMException, got ${error}`);
    assert.equal(error.name, "NotAllowedError");
    assert.match(error.message, /Failed to close MIDI output/);
    return true;
  });
});

test("the relay drops a child that goes away", async () => {
  const top = await makeEnv({ initial: { inputs: [["in-1", "Keyboard"]] } });
  const child = await makeEnv({ withInternals: false, top });
  await settle();
  const access = await child.requestAccess();
  assert.deepEqual([...access.inputs.keys()], ["in-1"]);

  // Removing the iframe unloads its document, which announces itself. After
  // that the top frame must not keep re-posting every state change to it.
  child.dispatch("pagehide");
  await settle();

  const before = postsTo(child);
  top.stateChange([], [["out-1", "Synth"]]);
  await settle();
  assert.equal(postsTo(child), before, "a child that said goodbye must be dropped");

  // A frame that is detached without saying goodbye (the message raced the
  // unload, or the browser killed it) is also pruned: posting to a detached
  // frame is a silent no-op, so nothing else would ever notice.
  const second = await makeEnv({ withInternals: false, top });
  await settle();
  await second.requestAccess();

  second.detach();
  top.stateChange([], [["out-1", "Synth"]]); // the broadcast that prunes it
  await settle();

  const beforeSecond = postsTo(second);
  top.stateChange([], [["out-1", "Synth"]]);
  top.stateChange([], [["out-1", "Synth"]]);
  await settle();
  assert.equal(postsTo(second), beforeSecond, "a detached child must be dropped");
});

test("a bridged frame can only invoke the plugin's own commands", async () => {
  const top = await makeEnv({
    initial: { inputs: [["in-1", "Keyboard"]], outputs: [["out-1", "Synth"]] },
  });
  const child = await makeEnv({ withInternals: false, top });
  await settle();

  const welcome = child.messages.find((message) => message.data.kind === "welcome");
  const token = welcome.data.token;

  // A genuine token, but commands the bridge does not serve. These must be
  // dropped rather than resolved through `Object.prototype`.
  for (const command of ["constructor", "toString", "__proto__", "hasOwnProperty", "plugin:event|emit", "core:default"]) {
    child.sandbox.top.postMessage(
      bridgeMessage({ kind: "invoke", token, id: `forged:${command}`, command, args: [] }),
      "tauri://localhost"
    );
  }
  await settle();

  assert.deepEqual(top.ipc.midiCalls, []);
  assert.equal(
    child.messages.some((message) => String(message.data.id).startsWith("forged:")),
    false,
    "a refused command must not produce a response"
  );
  assert.deepEqual(top.frame.errors, []);

  // The allowlist still lets the real commands through.
  const access = await child.requestAccess();
  await access.outputs.get("out-1").open();
  assert.deepEqual(
    top.ipc.midiCalls.map((call) => call.command),
    ["plugin:midi|open_output"]
  );
});

test("a child restored from the back/forward cache keeps working", async () => {
  const top = await makeEnv({ initial: { outputs: [["out-1", "Synth"]] } });
  const child = await makeEnv({ withInternals: false, top });
  await settle();

  const access = await child.requestAccess();
  const output = access.outputs.get("out-1");
  await output.open();
  assert.deepEqual(
    top.ipc.midiCalls.map((call) => call.command),
    ["plugin:midi|open_output"]
  );

  // The document enters the back/forward cache: `pagehide` with `persisted: true`.
  // It is not gone and will be restored with its heap intact, so it must NOT
  // announce `bye` — doing so strands it, because a restored document never
  // re-handshakes.
  child.dispatch("pagehide", { persisted: true });
  await settle();

  // It is restored (`pageshow` with `persisted: true`) and re-announces itself.
  child.dispatch("pageshow", { persisted: true });
  await settle();

  // Still bridged: state changes arrive...
  top.stateChange([], [
    ["out-1", "Synth"],
    ["out-2", "Pads"],
  ]);
  await settle();
  assert.deepEqual([...access.outputs.keys()], ["out-1", "out-2"]);

  // ...and the backend is still reachable rather than hanging forever.
  await output.close();
  assert.equal(output.connection, "closed");
  assert.deepEqual(
    top.ipc.midiCalls.map((call) => call.command),
    ["plugin:midi|open_output", "plugin:midi|close_output"]
  );
});
