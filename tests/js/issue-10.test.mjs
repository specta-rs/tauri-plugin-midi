// Regression test for https://github.com/specta-rs/tauri-plugin-midi/issues/10
//
// Every `navigator.requestMIDIAccess()` call used to push the new MIDIAccess
// instance into a strong `Set<TauriMIDIAccess>` that was never pruned, so each
// instance (plus its ports, event listeners and cached maps) stayed reachable
// forever. That set only exists to fan out backend `state-change` events to the
// live instances, so the fix keeps weak references to the instances in the set
// and removes each entry once the instance is garbage collected.
//
// A plain `Set<TauriMIDIAccess>` cannot be collected: a strong Set holds a
// strong reference to every member, so the instances are always reachable from
// a live root and GC never frees them. Replacing the members with `WeakRef`s
// (and pruning them via a `FinalizationRegistry`) is what makes collection
// possible, which is exactly what this test measures.
import test from "node:test";
import assert from "node:assert/strict";
import { collectGarbage, makeEnv } from "./harness.mjs";

test("MIDIAccess instances do not leak on every requestMIDIAccess() call", async () => {
  const N = 100;

  const env = await makeEnv({ observeFanout: true });

  // Create many instances and drop every strong reference to them immediately,
  // other than the ones the polyfill retains internally.
  for (let i = 0; i < N; i++) {
    await env.requestAccess();
  }

  // With the leak all N instances are still strongly held; after the fix only
  // the weak refs remain and the instances are collected.
  const collected = await collectGarbage();
  assert.equal(collected, true, "test must run with --expose-gc");

  // A backend state change fans out to every instance the polyfill still holds
  // a strong reference to.
  env.resetFanout();
  env.stateChange([["x", "y"]], []);

  // Exactly N with the leak; well under half with weak references.
  assert.ok(
    env.fanout < N / 2,
    `expected fewer than ${N / 2} live instances after GC, saw ${env.fanout} (all ${N} leaked?)`
  );
});
