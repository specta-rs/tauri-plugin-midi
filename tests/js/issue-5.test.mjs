// Wire-protocol pin for the hand-written runtime in `guest-js/index.ts`.
//
// Before #5 the polyfill imported `commands`/`events` from the generated
// `guest-js/bindings.ts`, which kept the command and event names in sync with
// the Rust plugin at the type level. The polyfill now only imports *types* from
// the generated file and wires the protocol by hand, so nothing at the type
// level stops the two sides from drifting. These assertions pin the exact
// strings (and the payload shapes) so a rename on either side fails loudly.
//
// The test harness does not expose the fake IPC layer's listener map, so the
// event names are pinned by (a) scanning the bundled polyfill for the exact
// literals it wires up, and (b) driving the real delivery path: the harness only
// ever delivers `plugin:midi:state-change` / `plugin:midi:midi-message`, so if
// the polyfill listened on any other name `requestMIDIAccess()` would never
// settle and the messages would never arrive.
//
// The expected names are read out of the generated `guest-js/bindings.ts`
// instead of being hardcoded here. That file is the contract with the Rust
// plugin (`cargo test --features specta` produces it from `src/lib.rs`), so a
// rename applied to `src/lib.rs` and `guest-js/index.ts` but never regenerated
// into the bindings makes the hand-wired runtime and the contract disagree and
// fails the comparison below - without touching this test.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, polyfillSource, repoRoot, tick } from "./harness.mjs";

const BINDINGS = fs.readFileSync(path.join(repoRoot, "guest-js", "bindings.ts"), "utf8");

/** The `plugin:midi|...` wire names the generated bindings invoke. */
function bindingsCommands() {
  return [...BINDINGS.matchAll(/__TAURI_INVOKE(?:<[^>]*>)?\(\s*["'](plugin:midi\|[^"']+)["']/g)].map(
    (m) => m[1]
  );
}

/** The `plugin:midi:...` wire names the generated bindings listen on. */
function bindingsEvents() {
  return [...BINDINGS.matchAll(/makeEvent(?:<[^>]*>)?\(\s*["'](plugin:midi:[^"']+)["']/g)].map(
    (m) => m[1]
  );
}

/** The camelCase keys the generated `commands`/`events` objects expose. */
function bindingsKeys(block) {
  const match = BINDINGS.match(new RegExp(`export const ${block} = \\{([\\s\\S]*?)\\n\\};`));
  assert.ok(match, `bindings.ts has no '${block}' object`);
  return [...match[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
}

test("bundled polyfill wires exactly the names in the generated bindings", async () => {
  const source = await polyfillSource();

  const commands = bindingsCommands();
  const events = bindingsEvents();

  // Guard the parsers: a contract we failed to read would make the comparisons
  // below pass vacuously.
  assert.ok(commands.length > 0, "bindings.ts declares no commands");
  assert.ok(events.length > 0, "bindings.ts declares no events");

  const invoked = [...source.matchAll(/invoke\(\s*["'](plugin:midi\|[^"']+)["']/g)].map((m) => m[1]);
  const listened = [...source.matchAll(/listen\(\s*["'](plugin:midi:[^"']+)["']/g)].map((m) => m[1]);

  assert.deepEqual([...invoked].sort(), [...commands].sort());
  assert.deepEqual([...listened].sort(), [...events].sort());

  // The runtime's API surface must mirror the bindings' keys too, so a key
  // renamed on the Rust side (and regenerated) but not here is caught.
  for (const key of bindingsKeys("commands")) {
    assert.match(source, new RegExp(`\\b${key}:`), `runtime is missing command '${key}'`);
  }
  for (const key of bindingsKeys("events")) {
    assert.match(source, new RegExp(`\\b${key}:`), `runtime is missing event '${key}'`);
  }
});

test("state-change arrives on plugin:midi:state-change and populates the maps", async () => {
  const env = await makeEnv({
    initial: { inputs: [["in-1", "Keyboard"]], outputs: [["out-1", "Synth"]] },
  });
  assert.equal(env.loadError, null);

  // `makeEnv` only delivered `plugin:midi:state-change`; a wrong listener name
  // here would leave this pending until the 10s init timeout rejects.
  const access = await env.requestAccess();
  assert.deepEqual([...access.inputs.keys()], ["in-1"]);
  assert.deepEqual([...access.outputs.keys()], ["out-1"]);
  assert.equal(access.inputs.get("in-1").name, "Keyboard");
  assert.equal(access.outputs.get("out-1").name, "Synth");

  env.stateChange([["in-1", "Keyboard"], ["in-2", "Pad"]], [["out-1", "Synth"]]);
  await tick();
  assert.deepEqual([...access.inputs.keys()], ["in-1", "in-2"]);
  assert.equal(access.inputs.get("in-2").name, "Pad");
});

test("midi-message is listened for on plugin:midi:midi-message and reaches onmidimessage", async () => {
  const env = await makeEnv();
  env.stateChange([["in-1", "Keyboard"]], []);
  const access = await env.requestAccess();
  const input = access.inputs.get("in-1");

  // The harness hides the fake IPC layer's listener map, so observe the
  // `plugin:event|listen` call the polyfill makes when the port is opened.
  const registered = [];
  const unregistered = [];
  const internals = env.ipc.internals;
  const originalInvoke = internals.invoke;
  internals.invoke = (command, args) => {
    if (command === "plugin:event|listen") registered.push(args.event);
    if (command === "plugin:event|unlisten") unregistered.push(args.event);
    return originalInvoke(command, args);
  };

  const received = [];
  input.onmidimessage = (event) => received.push([...event.data]);
  await tick();

  assert.deepEqual(registered, ["plugin:midi:midi-message"]);

  env.midiMessage("in-1", 1234, [0x90, 0x40, 0x7f]);
  await tick();
  assert.deepEqual(received, [[0x90, 0x40, 0x7f]]);

  await input.close();
  await tick();
  assert.deepEqual(unregistered, ["plugin:midi:midi-message"]);
});

test("the polyfill invokes the exact plugin:midi| command names", async () => {
  const env = await makeEnv();
  env.stateChange([["in-1", "Keyboard"]], [["out-1", "Synth"]]);
  const access = await env.requestAccess();

  await access.inputs.get("in-1").open();
  await access.inputs.get("in-1").close();

  const output = access.outputs.get("out-1");
  await output.open();
  output.send([0x90, 0x40, 0x7f]);
  await tick();
  await output.close();

  assert.deepEqual(
    env.ipc.midiCalls.map((call) => call.command),
    [
      "plugin:midi|open_input",
      "plugin:midi|close_input",
      "plugin:midi|open_output",
      "plugin:midi|output_send",
      "plugin:midi|close_output",
    ]
  );

  const send = env.ipc.midiCalls.find((call) => call.command === "plugin:midi|output_send");
  assert.equal(send.args.id, "out-1");
  assert.deepEqual([...send.args.msg], [0x90, 0x40, 0x7f]);
  assert.equal(send.args.timestamp, null);
});
