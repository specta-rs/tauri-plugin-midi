// Regression tests for issue #13:
// "`TauriMIDIConnectionEvent` `event.port.connection` doesn't match Chrome's behavior"
//
// On disconnect the polyfill used to only set `state = "disconnected"`, leaving
// `connection` untouched, so an opened port still reported `connection === "open"`
// in the `statechange` event. Chrome (Blink `MIDIPort::SetState`) instead moves an
// open/pending port to `"pending"`, keeps a closed port `"closed"`, and retains the
// `MIDIPort` object across a disconnect so it can be reopened on reconnect.
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, tick } from "./harness.mjs";

test("a disconnected open port reports connection 'pending'", async () => {
  const env = await makeEnv();
  env.stateChange([["in-1", "Keyboard"]], []);
  const access = await env.requestAccess();
  const input = access.inputs.get("in-1");

  await input.open();
  assert.equal(input.connection, "open");

  const events = [];
  input.addEventListener("statechange", (event) => {
    events.push({ state: event.port.state, connection: event.port.connection });
  });

  env.stateChange([], []);
  await tick();

  assert.equal(input.state, "disconnected");
  assert.equal(input.connection, "pending");
  assert.deepEqual(events.at(-1), { state: "disconnected", connection: "pending" });
});

test("a disconnected port is removed from access.inputs", async () => {
  const env = await makeEnv();
  env.stateChange([["in-1", "Keyboard"]], []);
  const access = await env.requestAccess();
  const input = access.inputs.get("in-1");

  await input.open();
  assert.equal(access.inputs.has("in-1"), true);

  env.stateChange([], []);
  await tick();

  assert.equal(access.inputs.has("in-1"), false);
});

test("reconnecting reuses the same MIDIPort and reopens it", async () => {
  const env = await makeEnv();
  env.stateChange([["in-1", "Keyboard"]], []);
  const access = await env.requestAccess();
  const input = access.inputs.get("in-1");

  await input.open();

  env.stateChange([], []);
  await tick();
  assert.equal(access.inputs.has("in-1"), false);

  env.stateChange([["in-1", "Keyboard"]], []);
  await tick();

  const reconnected = access.inputs.get("in-1");
  assert.equal(reconnected, input);
  assert.equal(reconnected.state, "connected");
  assert.equal(reconnected.connection, "open");
});

test("an output that was never opened becomes 'closed' when disconnected", async () => {
  const env = await makeEnv();
  env.stateChange([], [["out-1", "Synth"]]);
  const access = await env.requestAccess();
  const output = access.outputs.get("out-1");

  assert.equal(output.connection, "closed");

  env.stateChange([], []);
  await tick();

  assert.equal(output.state, "disconnected");
  assert.equal(output.connection, "closed");
  assert.equal(access.outputs.has("out-1"), false);
});

// MAJOR 1: a disconnect during an in-flight reopen must not leave the port
// claiming to be open. Blink switches on the device state once the backend open
// completes and, when the port went away, ends at (disconnected, pending).
test("a disconnect during an in-flight reopen leaves the port 'pending', not 'open'", async () => {
  const env = await makeEnv();
  env.stateChange([["in-1", "Keyboard"]], []);
  const access = await env.requestAccess();
  const input = access.inputs.get("in-1");

  // 1. Open the port.
  await input.open();
  assert.equal(input.connection, "open");

  // 2. Unplug it; the port stays open from the consumer's point of view but is
  //    reported as pending.
  env.stateChange([], []);
  await tick();
  assert.equal(input.state, "disconnected");
  assert.equal(input.connection, "pending");

  const events = [];
  input.addEventListener("statechange", (event) => {
    events.push({ state: event.port.state, connection: event.port.connection });
  });

  // 3. Re-plug it. The polyfill calls open() to reopen and the backend
  //    round-trip is still in flight.
  env.stateChange([["in-1", "Keyboard"]], []);
  // 4. Unplug it again *before* open_input resolves.
  env.stateChange([], []);
  await tick(20);

  assert.equal(input.state, "disconnected");
  assert.notEqual(input.connection, "open", "a disconnected port must not report 'open'");
  assert.deepEqual(events.at(-1), { state: "disconnected", connection: "pending" });
});

// MAJOR 2: a failed reopen must still report a terminal state. The backend
// rejects when the device is already gone, and the port used to be left at
// (connected, pending) with no event and an unhandled rejection.
test("a failing reopen dispatches a terminal statechange and does not strand the port", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    const env = await makeEnv();
    env.stateChange([["in-1", "Keyboard"]], []);
    const access = await env.requestAccess();
    const input = access.inputs.get("in-1");

    await input.open();
    env.stateChange([], []);
    await tick();
    assert.equal(input.connection, "pending");

    const events = [];
    input.addEventListener("statechange", (event) => {
      events.push({ state: event.port.state, connection: event.port.connection });
    });

    // The device is gone by the time the reconnect tries to reopen it.
    env.ipc.setFailure("plugin:midi|open_input", "Failed to find port by id 'in-1'");
    env.stateChange([["in-1", "Keyboard"]], []);
    await tick(20);

    assert.equal(events.length, 1, "expected exactly one statechange for the failed reopen");
    assert.deepEqual(events.at(-1), { state: "disconnected", connection: "closed" });
    assert.ok(
      !(input.state === "connected" && input.connection === "pending"),
      "the port must not be stranded at connected/pending"
    );
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// MINOR 3: opening a port that is already pending is a no-op. Calling open()
// twice used to fire two identical disconnected/pending events; Blink fires none
// for the redundant call.
test("calling open() twice on a disconnected port dispatches exactly one event", async () => {
  const env = await makeEnv();
  env.stateChange([["in-1", "Keyboard"]], []);
  const access = await env.requestAccess();
  const input = access.inputs.get("in-1");

  // Disconnect without ever opening it, so `connection` is "closed".
  env.stateChange([], []);
  await tick();
  assert.equal(input.state, "disconnected");
  assert.equal(input.connection, "closed");

  const events = [];
  input.addEventListener("statechange", (event) => {
    events.push({ state: event.port.state, connection: event.port.connection });
  });

  await input.open();
  await input.open();
  await tick();

  assert.equal(events.length, 1, "open() on an already-pending port must not dispatch again");
  assert.deepEqual(events[0], { state: "disconnected", connection: "pending" });
});

// Guard the "exactly one event per transition" property on the happy path: a
// reconnect that succeeds must notify consumers exactly once.
test("a successful reconnect dispatches exactly one statechange", async () => {
  const env = await makeEnv();
  env.stateChange([["in-1", "Keyboard"]], []);
  const access = await env.requestAccess();
  const input = access.inputs.get("in-1");

  await input.open();
  env.stateChange([], []);
  await tick();

  const events = [];
  input.addEventListener("statechange", (event) => {
    events.push({ state: event.port.state, connection: event.port.connection });
  });

  env.stateChange([["in-1", "Keyboard"]], []);
  await tick(20);

  assert.equal(events.length, 1, "expected exactly one statechange for the reopen");
  assert.deepEqual(events[0], { state: "connected", connection: "open" });
});
