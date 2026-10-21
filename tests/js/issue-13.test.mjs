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
