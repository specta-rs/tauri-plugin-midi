// Shared test harness for the Web MIDI polyfill.
//
// The polyfill in `guest-js/index.ts` talks to the webview through
// `@tauri-apps/api`, which in turn needs `window.__TAURI_INTERNALS__`. This
// harness bundles the real polyfill (with the Tauri API modules swapped for
// stubs) and evaluates it inside a fresh `vm` context wired up to a fake Tauri
// IPC layer, so the polyfill's behaviour can be driven and asserted from Node.
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

let bundlePromise;
/** Bundle the polyfill once per process and cache the resulting IIFE source. */
export function polyfillSource() {
  bundlePromise ??= esbuild
    .build({
      entryPoints: [path.join(repoRoot, "guest-js", "index.ts")],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2020",
      write: false,
      logLevel: "silent",
      alias: {
        "@tauri-apps/api/core": path.join(here, "stubs", "core.ts"),
        "@tauri-apps/api/event": path.join(here, "stubs", "event.ts"),
      },
    })
    .then((result) => result.outputFiles[0].text);
  return bundlePromise;
}

/** A fake Tauri IPC layer: command invocation plus the event plugin. */
function makeIpc() {
  let callbackId = 0;
  const callbacks = new Map(); // callback id -> fn
  const listeners = new Map(); // event name -> Set<callback id>
  const midiCalls = [];
  let failure = null; // { command, error }

  const internals = {
    transformCallback(fn) {
      const id = ++callbackId;
      callbacks.set(id, fn);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    async invoke(command, args) {
      if (command === "plugin:event|listen") {
        if (!listeners.has(args.event)) listeners.set(args.event, new Set());
        listeners.get(args.event).add(args.handler);
        return args.handler;
      }
      if (command === "plugin:event|unlisten") {
        listeners.get(args.event)?.delete(args.eventId);
        return null;
      }
      if (command === "plugin:event|emit") {
        deliver(args.event, args.payload);
        return null;
      }
      if (command.startsWith("plugin:midi|")) {
        midiCalls.push({ command, args });
        if (failure && failure.command === command) throw failure.error;
        return null;
      }
      throw new Error(`unexpected command: ${command}`);
    },
  };

  function deliver(event, payload) {
    for (const id of listeners.get(event) ?? []) {
      const callback = callbacks.get(id);
      if (callback) callback({ event, id, payload });
    }
  }

  return {
    internals,
    midiCalls,
    deliver,
    setFailure(command, error) {
      failure = { command, error };
    },
    clearFailure() {
      failure = null;
    },
  };
}

function makeSandbox({ withInternals, ipc }) {
  const sandbox = {};
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    if (key === "globalThis" || key === "window" || key === "self") continue;
    try {
      sandbox[key] = globalThis[key];
    } catch {
      // Some host globals are getters that throw; skip them.
    }
  }
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  if (withInternals) {
    sandbox.__TAURI_INTERNALS__ = ipc.internals;
    sandbox.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  }
  Object.defineProperty(sandbox, "navigator", {
    value: {},
    writable: true,
    configurable: true,
  });
  return sandbox;
}

/**
 * Build an isolated environment with the polyfill loaded.
 *
 * @param {{
 *   withInternals?: boolean,
 *   observeFanout?: boolean,
 *   initial?: { inputs?: [string, string][], outputs?: [string, string][] }
 * }} [options]
 */
export async function makeEnv({
  withInternals = true,
  observeFanout = false,
  initial = {},
} = {}) {
  const source = await polyfillSource();
  const ipc = makeIpc();
  const sandbox = makeSandbox({ withInternals, ipc });
  vm.createContext(sandbox);

  let loadError = null;
  try {
    vm.runInContext(source, sandbox, { filename: "polyfill.js" });
  } catch (error) {
    loadError = error;
  }

  // The backend emits its first `state-change` as soon as the plugin is up;
  // do the same so `requestMIDIAccess()` settles.
  if (withInternals) {
    ipc.deliver("plugin:midi:state-change", {
      inputs: initial.inputs ?? [],
      outputs: initial.outputs ?? [],
    });
  }

  let fanout = 0;
  if (observeFanout && sandbox.MIDIAccess) {
    const original = sandbox.MIDIAccess.prototype.__tauri_statechange;
    sandbox.MIDIAccess.prototype.__tauri_statechange = function (...args) {
      fanout++;
      return original.apply(this, args);
    };
  }

  return {
    sandbox,
    ipc,
    loadError,
    get fanout() {
      return fanout;
    },
    resetFanout() {
      fanout = 0;
    },
    /** True when the polyfill installed `navigator.requestMIDIAccess`. */
    get installed() {
      return typeof sandbox.navigator.requestMIDIAccess === "function";
    },
    /** Simulate the backend's periodic `state-change` event. */
    stateChange(inputs = [], outputs = []) {
      ipc.deliver("plugin:midi:state-change", { inputs, outputs });
    },
    /** Simulate an inbound `midi-message` event. */
    midiMessage(id, timestamp, data) {
      ipc.deliver("plugin:midi:midi-message", [id, String(timestamp), data]);
    },
    requestAccess() {
      return sandbox.navigator.requestMIDIAccess();
    },
  };
}

/** Let queued microtasks and `setTimeout(..., 0)` callbacks run. */
export function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Force a GC cycle when the process was started with `--expose-gc`. */
export async function collectGarbage() {
  if (typeof global.gc !== "function") return false;
  global.gc();
  await tick(50);
  global.gc();
  return true;
}

export { repoRoot };
