// Shared test harness for the Web MIDI polyfill.
//
// The polyfill in `guest-js/index.ts` talks to the webview through
// `@tauri-apps/api`, which in turn needs `window.__TAURI_INTERNALS__`. This
// harness bundles the real polyfill (with the Tauri API modules swapped for
// stubs) and evaluates it inside a fresh `vm` context wired up to a fake Tauri
// IPC layer, so the polyfill's behaviour can be driven and asserted from Node.
//
// It can also model more than one frame at a time: each environment gets a
// `frame` handle and frames can be linked into a top frame / child frame tree
// whose `postMessage` traffic is routed through a shared bus that enforces the
// same target-origin and cross-origin-location rules a browser would.
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/** Origin used for frames unless a test says otherwise. */
export const DEFAULT_ORIGIN = "tauri://localhost";

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
    // Mirrors Tauri's `__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener`, which
    // deletes the transformed callback from the registry. Dropping the listener
    // record is the `plugin:event|unlisten` command's job (handled above), so this
    // only clears the callback — without it the registry retains every callback
    // forever and leak probes that close a port report false positives.
    unregisterListener(_event, id) {
      callbacks.delete(id);
    },
    /** Names of the backend events this frame has subscribed to. */
    get eventListeners() {
      return [...listeners.keys()];
    },
    setFailure(command, error) {
      failure = { command, error };
    },
    clearFailure() {
      failure = null;
    },
  };
}

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

/**
 * A `postMessage` bus shared by the frames of one tree. Messages are cloned and
 * delivered asynchronously, and `targetOrigin` is honoured the way a browser
 * would (a mismatched target origin drops the message).
 */
export function createFrameBus() {
  const frames = new Set();
  return {
    frames,
    /**
     * Every `postMessage` attempted through this bus, in order, *including* the
     * ones the bus then drops (mismatched target origin, detached receiver). Lets
     * a test tell "the sender never posted" apart from "the bus discarded it".
     */
    posts: [],
    register(frame) {
      frames.add(frame);
    },
    post(from, to, data, targetOrigin) {
      if (!to) return;
      this.posts.push({ from, to, data, targetOrigin });
      if (targetOrigin !== "*" && targetOrigin !== to.origin) return;
      // A detached frame stops accepting messages. A browser discards the post
      // silently rather than raising, which is exactly why the relay has to prune
      // detached children itself.
      if (to.closed) return;
      const event = { data: clone(data), origin: from.origin, source: proxyFor(to, from) };
      to.received.push(event);
      queueMicrotask(() => {
        for (const listener of [...to.listeners]) {
          try {
            listener(event);
          } catch (error) {
            to.errors.push(error);
          }
        }
      });
    },
  };
}

/**
 * The object frame `receiver` sees for frame `other` (a `WindowProxy`). Its
 * `postMessage` delivers to `other`, reading `location` throws when the two
 * frames are cross-origin, and `closed` reports whether `other` has been
 * detached — exactly like the real thing.
 */
function proxyFor(receiver, other) {
  let proxy = receiver.known.get(other);
  if (proxy) return proxy;
  proxy = {
    postMessage(data, targetOrigin) {
      receiver.bus.post(receiver, other, data, targetOrigin);
    },
    get location() {
      if (receiver.origin !== other.origin) {
        throw new Error("SecurityError: blocked a cross-origin frame from reading location");
      }
      return other.location;
    },
    get closed() {
      return other.closed;
    },
  };
  receiver.known.set(other, proxy);
  return proxy;
}

const SKIPPED_GLOBALS = new Set([
  "globalThis",
  "window",
  "self",
  "top",
  "parent",
  "location",
  "postMessage",
  "addEventListener",
  "removeEventListener",
]);

function makeSandbox({ withInternals, ipc, frame, topProxy }) {
  const sandbox = {};
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    if (SKIPPED_GLOBALS.has(key)) continue;
    try {
      sandbox[key] = globalThis[key];
    } catch {
      // Some host globals are getters that throw; skip them.
    }
  }
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = topProxy ?? sandbox;
  sandbox.parent = sandbox.top;
  Object.defineProperty(sandbox, "location", {
    value: frame.location,
    writable: true,
    configurable: true,
  });
  sandbox.postMessage = (data, targetOrigin) => frame.bus.post(frame, frame, data, targetOrigin);
  sandbox.addEventListener = (type, listener) => {
    if (type === "message") {
      frame.listeners.add(listener);
      return;
    }
    let listeners = frame.windowListeners.get(type);
    if (!listeners) {
      listeners = new Set();
      frame.windowListeners.set(type, listeners);
    }
    listeners.add(listener);
  };
  sandbox.removeEventListener = (type, listener) => {
    if (type === "message") frame.listeners.delete(listener);
    else frame.windowListeners.get(type)?.delete(listener);
  };
  if (withInternals) {
    sandbox.__TAURI_INTERNALS__ = ipc.internals;
    sandbox.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (event, id) => ipc.unregisterListener(event, id),
    };
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
 *   initial?: { inputs?: [string, string][], outputs?: [string, string][] },
 *   origin?: string,
 *   top?: { frame: object } | null,
 *   bus?: object | null
 * }} [options]
 */
export async function makeEnv({
  withInternals = true,
  observeFanout = false,
  initial = {},
  origin = DEFAULT_ORIGIN,
  top: topEnv = null,
  bus = null,
} = {}) {
  const source = await polyfillSource();
  const ipc = makeIpc();
  const frameBus = bus ?? topEnv?.frame?.bus ?? createFrameBus();
  const frame = {
    bus: frameBus,
    origin,
    location: { href: `${origin}/`, origin },
    listeners: new Set(),
    /** Window-level (non-`message`) listeners, keyed by event type. */
    windowListeners: new Map(),
    /** Set when the frame is detached from the document (like removing an iframe). */
    closed: false,
    /** Every message event posted *to* this frame, in order. */
    received: [],
    /** Errors thrown by this frame's message listeners. */
    errors: [],
    known: new Map(),
    sandbox: null,
  };

  const topProxy = topEnv ? proxyFor(frame, topEnv.frame) : null;
  const sandbox = makeSandbox({ withInternals, ipc, frame, topProxy });
  frame.sandbox = sandbox;
  frameBus.register(frame);
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
    frame,
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
    /** Message events delivered to this frame. */
    get messages() {
      return frame.received;
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
    /** Post a raw message from this frame into another one. */
    postTo(target, data, targetOrigin = target.frame.origin) {
      frameBus.post(frame, target.frame, data, targetOrigin);
    },
    /** Fire a window-level event (e.g. `pagehide`) inside this frame. */
    dispatch(type, init = {}) {
      for (const listener of [...(frame.windowListeners.get(type) ?? [])]) {
        listener({ type, ...init });
      }
    },
    /**
     * Detach this frame from the document without unloading it, the way removing
     * an `<iframe>` from the DOM does. The frame itself stays alive (it is what
     * the top frame still holds a handle to) but no longer accepts messages.
     */
    detach() {
      frame.closed = true;
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
