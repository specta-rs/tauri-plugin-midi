// Baseline behaviour of the Web MIDI polyfill that must keep working.
//
// These assertions describe behaviour that is already correct today; they exist
// to catch regressions from the fixes that follow.
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, tick } from "./harness.mjs";

test("installs navigator.requestMIDIAccess in the main frame", async () => {
  const env = await makeEnv();
  assert.equal(env.loadError, null);
  assert.equal(env.installed, true);
});

test("requestMIDIAccess resolves once the backend reports its ports", async () => {
  const env = await makeEnv({
    initial: { inputs: [["in-1", "Keyboard"]], outputs: [["out-1", "Synth"]] },
  });
  const access = await env.requestAccess();

  assert.deepEqual([...access.inputs.keys()], ["in-1"]);
  assert.deepEqual([...access.outputs.keys()], ["out-1"]);
  assert.equal(access.inputs.get("in-1").name, "Keyboard");
  assert.equal(access.inputs.get("in-1").state, "connected");
  assert.equal(access.inputs.get("in-1").type, "input");
  assert.equal(access.outputs.get("out-1").type, "output");
});

test("ports discovered after startup are added to an existing instance", async () => {
  const env = await makeEnv();
  const access = await env.requestAccess();

  assert.deepEqual([...access.inputs.keys()], []);

  env.stateChange([["in-1", "Keyboard"]], []);
  await tick();

  assert.deepEqual([...access.inputs.keys()], ["in-1"]);
  assert.equal(access.inputs.get("in-1").state, "connected");
});

test("open() marks a connected port as open and notifies both targets", async () => {
  const env = await makeEnv();
  env.stateChange([["in-1", "Keyboard"]], []);
  const access = await env.requestAccess();
  const input = access.inputs.get("in-1");

  const onPort = [];
  const onAccess = [];
  input.addEventListener("statechange", (e) => onPort.push(e.port.connection));
  access.addEventListener("statechange", (e) => onAccess.push(e.port.connection));

  await input.open();

  assert.equal(input.connection, "open");
  assert.deepEqual(env.ipc.midiCalls.map((c) => c.command), ["plugin:midi|open_input"]);
  assert.ok(onPort.includes("open"));
  assert.ok(onAccess.includes("open"));
});

test("close() marks a port as closed and calls the backend", async () => {
  const env = await makeEnv();
  env.stateChange([], [["out-1", "Synth"]]);
  const access = await env.requestAccess();
  const output = access.outputs.get("out-1");

  await output.open();
  assert.equal(output.connection, "open");

  await output.close();
  assert.equal(output.connection, "closed");
  assert.deepEqual(
    env.ipc.midiCalls.map((c) => c.command),
    ["plugin:midi|open_output", "plugin:midi|close_output"]
  );
});

test("disconnecting a port removes it from the maps", async () => {
  const env = await makeEnv();
  env.stateChange([["in-1", "Keyboard"]], [["out-1", "Synth"]]);
  const access = await env.requestAccess();

  env.stateChange([], []);
  await tick();

  assert.equal(access.inputs.has("in-1"), false);
  assert.equal(access.outputs.has("out-1"), false);
});

test("midi messages are dispatched to input listeners", async () => {
  const env = await makeEnv();
  env.stateChange([["in-1", "Keyboard"]], []);
  const access = await env.requestAccess();
  const input = access.inputs.get("in-1");

  const received = [];
  input.onmidimessage = (event) => received.push([...event.data]);

  // `onmidimessage` opens the port implicitly and `open()` is asynchronous, so
  // wait until the port is actually open before the backend delivers a message.
  // This matches Chrome, which only delivers messages to an open MIDIInput.
  await tick();
  assert.equal(input.connection, "open");

  env.midiMessage("in-1", 1234, [0x90, 0x40, 0x7f]);
  await tick();

  assert.deepEqual(received, [[0x90, 0x40, 0x7f]]);
});

test("state changes are delivered to every live MIDIAccess instance", async () => {
  const env = await makeEnv({ observeFanout: true });
  env.stateChange([], []);

  const first = await env.requestAccess();
  const second = await env.requestAccess();

  env.resetFanout();
  env.stateChange([["in-1", "Keyboard"]], []);

  assert.equal(env.fanout, 2);
  assert.ok(first.inputs.has("in-1"));
  assert.ok(second.inputs.has("in-1"));
});
