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
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, polyfillSource, tick } from "./harness.mjs";

const COMMANDS = [
  "plugin:midi|open_input",
  "plugin:midi|close_input",
  "plugin:midi|open_output",
  "plugin:midi|close_output",
  "plugin:midi|output_send",
];

const EVENTS = ["plugin:midi:state-change", "plugin:midi:midi-message"];

test("bundled polyfill wires exactly the plugin's command and event names", async () => {
  const source = await polyfillSource();

  const invoked = [...source.matchAll(/invoke\(\s*["'](plugin:midi\|[^"']+)["']/g)].map((m) => m[1]);
  const listened = [...source.matchAll(/listen\(\s*["'](plugin:midi:[^"']+)["']/g)].map((m) => m[1]);

  assert.deepEqual([...invoked].sort(), [...COMMANDS].sort());
  assert.deepEqual([...listened].sort(), [...EVENTS].sort());
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
