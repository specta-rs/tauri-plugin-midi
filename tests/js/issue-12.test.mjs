// Regression tests for https://github.com/specta-rs/tauri-plugin-midi/issues/12
//
// Tauri commands reject with bare strings, and the polyfill used to leak them
// straight to consumers. Web MIDI consumers expect DOMExceptions with the names
// the spec defines for these paths.
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, tick } from "./harness.mjs";

test("open() surfaces a backend failure as a NotAllowedError DOMException", async () => {
  const env = await makeEnv();
  env.stateChange([["in-1", "Keyboard"]], []);
  const access = await env.requestAccess();
  const input = access.inputs.get("in-1");

  env.ipc.setFailure("plugin:midi|open_input", "Failed to find port by id 'in-1'");

  await assert.rejects(input.open(), (error) => {
    assert.ok(error instanceof DOMException, `expected a DOMException, got ${error}`);
    assert.equal(error.name, "NotAllowedError");
    return true;
  });
});

test("send() on a disconnected port throws an InvalidStateError DOMException", async () => {
  const env = await makeEnv();
  env.stateChange([], [["out-1", "Synth"]]);
  const access = await env.requestAccess();
  const output = access.outputs.get("out-1");

  // Drop the port from the backend; the held reference is now disconnected.
  env.stateChange([], []);
  await tick();
  assert.equal(output.state, "disconnected");

  assert.throws(
    () => output.send([0x90, 0x40, 0x7f]),
    (error) => {
      assert.ok(error instanceof DOMException, `expected a DOMException, got ${error}`);
      assert.equal(error.name, "InvalidStateError");
      return true;
    }
  );
});

test("send() rejects a payload that is not MIDI bytes with a TypeError", async () => {
  const env = await makeEnv();
  env.stateChange([], [["out-1", "Synth"]]);
  const access = await env.requestAccess();
  const output = access.outputs.get("out-1");

  assert.throws(
    () => output.send("not bytes"),
    (error) => {
      assert.ok(error instanceof TypeError, `expected a TypeError, got ${error}`);
      return true;
    }
  );
});

test("a failing output_send does not produce an unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    const env = await makeEnv();
    env.stateChange([], [["out-1", "Synth"]]);
    const access = await env.requestAccess();
    const output = access.outputs.get("out-1");
    await output.open();

    env.ipc.setFailure("plugin:midi|output_send", "backend send failed");
    output.send([0x90, 0x40, 0x7f]);

    await tick(50);

    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
