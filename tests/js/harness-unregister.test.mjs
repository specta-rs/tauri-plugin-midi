import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, collectGarbage } from "./harness.mjs";

// Anchor environments for the lifetime of the process. The fake IPC's registry
// lives on the environment, so if the whole `env` graph were collectable a port's
// `MIDIAccess` would be freed regardless of its state and the assertions below
// would pass vacuously. Referencing `env` here keeps the registry (and therefore
// any genuinely retained callback) reachable across the forced GC.
const liveEnvironments = [];

// Regression test for the fake IPC's event registry.
//
// The fake `__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener` used to be a
// no-op, so `port.close()` dropped the id from the fake `listeners` map but the
// transformed callback stayed in the `callbacks` map forever. Because that
// callback closes over the port (which holds its `MIDIAccess`), the instance
// looked permanently retained even though the real webview releases it.
//
// That produced false positives in leak probes — a "open() then close()" case
// reported as leaking — so this test pins the corrected behaviour.
test("closing a port releases its MIDIAccess instance", async () => {
  const env = await makeEnv();
  liveEnvironments.push(env);

  // Keep no binding to the access on the test frame; only the WeakRef escapes.
  const weak = await (async () => {
    const access = await env.requestAccess();
    env.stateChange([["in1", "Input 1"]], []);
    const port = access.inputs.get("in1");
    await port.open();
    await port.close();
    return new env.sandbox.WeakRef(access);
  })();

  assert.equal(await collectGarbage(), true, "test must run with --expose-gc");
  assert.equal(
    weak.deref(),
    undefined,
    "instance should be collectable once its port is closed",
  );
});
