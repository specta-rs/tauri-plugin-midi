import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { StateChange, MIDIMessage } from "./bindings.js";

// Hand-written runtime for the wire protocol. `bindings.ts` above is generated
// by `cargo test --features specta` and only used here for its types, so that
// the specta runtime does not end up in the bundled polyfill.
const commands = {
  openInput: (id: string) => invoke("plugin:midi|open_input", { id }),
  closeInput: (id: string) => invoke("plugin:midi|close_input", { id }),
  openOutput: (id: string) => invoke("plugin:midi|open_output", { id }),
  closeOutput: (id: string) => invoke("plugin:midi|close_output", { id }),
  outputSend: (id: string, msg: number[], timestamp: string | null) =>
    invoke("plugin:midi|output_send", { id, msg, timestamp }),
};

const events = {
  midiMessage: {
    listen: (cb: (event: { payload: MIDIMessage }) => void): Promise<UnlistenFn> =>
      listen("plugin:midi:midi-message", cb as any),
  },
  stateChange: {
    listen: (cb: (event: { payload: StateChange }) => void): Promise<UnlistenFn> =>
      listen("plugin:midi:state-change", cb as any),
  },
};

// https://webaudio.github.io/web-midi-api
//
// ── Iframes (https://github.com/specta-rs/tauri-plugin-midi/issues/7) ───────
//
// The plugin registers this polyfill for *every* frame, but Tauri only injects
// `window.__TAURI_INTERNALS__` (the IPC invoke bridge) and the event plugin into
// the main frame. WebView2 cannot scope an init script to a single frame, so on
// Windows subframes get the whole IPC as well.
//
// So a frame can be in one of three states:
//
//   * `main`   — it has the Tauri IPC. It behaves exactly as this plugin always
//                has, and additionally relays traffic to any child frame that
//                asks for it.
//   * `relay`  — it has no Tauri IPC but is same-origin with the top frame (a
//                macOS/Linux subframe). It talks to the top frame over
//                `postMessage`, which forwards its calls into the real IPC.
//   * `inactive` — anything else. In particular a *cross-origin* frame gets
//                nothing: Tauri capabilities are scoped to the webview's window
//                label rather than to a frame, so bridging one would hand the
//                app's IPC surface to a foreign origin. Leaving the frame alone
//                also preserves that page's own native Web MIDI implementation.

const BRIDGE_TAG = "tauri-plugin-midi/frame-bridge";
/** How often a child frame re-announces itself to the top frame while handshaking. */
const BRIDGE_HELLO_RETRY_MS = 50;
/** How many times it tries before giving up (~1s in total). */
const BRIDGE_HELLO_ATTEMPTS = 20;

type PortList = [string, string][];
type MidiMessagePayload = [string, string, number[]];

/** The subset of plugin commands a bridged frame is allowed to invoke. */
type BridgedCommand = "openInput" | "closeInput" | "openOutput" | "closeOutput" | "outputSend";

const BRIDGED_COMMANDS: Record<BridgedCommand, (...args: any[]) => Promise<any>> = {
  openInput: commands.openInput,
  closeInput: commands.closeInput,
  openOutput: commands.openOutput,
  closeOutput: commands.closeOutput,
  outputSend: commands.outputSend,
};

type BridgeEvent = "state-change" | "midi-message";

// Routing of backend traffic. Both are assigned once at startup, before any
// instance can be constructed.
let callCommand: (command: BridgedCommand, args: unknown[]) => Promise<unknown>;
let listenMidiMessage: (cb: (payload: MidiMessagePayload) => void) => Promise<UnlistenFn>;
/** Set on frames that serve child frames. */
let relay: FrameRelay | null = null;

// Backend errors arrive as plain strings; Web MIDI consumers expect DOMExceptions.
function toMidiError(err: unknown, name: string): Error {
  if (err instanceof Error) return err;
  return new DOMException(String(err), name);
}

// Deliberately settled by `bootstrap()`. The rejection is only meant for
// callers of `requestMIDIAccess()`; attaching a handler here keeps the timeout
// from surfacing as an unhandled rejection in frames that never bridge.
let resolve: () => void;
const ready = new Promise((r, reject) => {
  const timeout = setTimeout(
    () => reject(new DOMException("Failed to initialise WebMIDI", "NotSupportedError")),
    10_000
  );
  resolve = () => {
    clearTimeout(timeout);
    r(void 0);
  };
});
ready.catch(() => {});

let _inputs: PortList = [];
let _outputs: PortList = [];

// Hold weak references so MIDIAccess instances can be garbage collected. A plain
// Set<TauriMIDIAccess> keeps every instance (and its ports and event listeners)
// alive forever, which leaks on every requestMIDIAccess() call.
const midiInstances = new Set<WeakRef<TauriMIDIAccess>>();
const midiInstanceRegistry = new FinalizationRegistry<WeakRef<TauriMIDIAccess>>((ref) =>
  midiInstances.delete(ref)
);

function trackMidiInstance(instance: TauriMIDIAccess) {
  const ref = new WeakRef(instance);
  midiInstances.add(ref);
  midiInstanceRegistry.register(instance, ref);
}

function forEachMidiInstance(fn: (instance: TauriMIDIAccess) => void) {
  for (const ref of midiInstances) {
    const instance = ref.deref();
    if (instance) fn(instance);
    else midiInstances.delete(ref);
  }
}

function handleStateChange(inputs: PortList, outputs: PortList) {
  // We cache the last values so any new instances can be created without waiting.
  _inputs = inputs;
  _outputs = outputs;

  // The new instance will use the values above
  resolve();

  // Invoke the state change on all instances
  forEachMidiInstance((instance) => instance.__tauri_statechange(inputs, outputs));

  // Let any child frames see the same state.
  relay?.stateChange(inputs, outputs);
}

// Route one `midi-message` to the matching open input port of every live
// instance. There is exactly one subscription to `plugin:midi:midi-message` per
// frame — registered from `bootstrap()` through the frame-aware
// `listenMidiMessage` (the real IPC in the main frame, the relay in a bridged
// child). Routing through the weak instance set rather than registering a
// listener per port means no event registration ever closes over a port, so
// opening a port and never closing it can no longer root its `MIDIAccess` (and
// ports, and listeners) for the lifetime of the webview (#24).
function handleMidiMessage(payload: MidiMessagePayload) {
  const [inputName, timestampRaw, data] = payload;

  forEachMidiInstance((access) => {
    // Only live input ports receive messages. Looking the id up in `inputs` (as
    // opposed to outputs) also handles an id that exists as both.
    const port = access.inputs.get(inputName);
    if (!port || port.type !== "input") return;
    // `onmidimessage`/`addEventListener` open the port implicitly and `close()`
    // stops delivery, so only an open input receives messages (as in Chrome).
    if (port.connection !== "open") return;

    const timestamp = parseInt(timestampRaw);
    const midiEvent = new TauriMIDIMessageEvent("midimessage", {
      data: new Uint8Array(data),
    });

    Object.defineProperty(midiEvent, "timeStamp", { value: timestamp });
    // This is deprecated in spec but we'll keep it anyway for compatibility
    Object.defineProperty(midiEvent, "receivedTime", { value: timestamp });

    port.dispatchEvent(midiEvent);
  });

  // ...and on to any bridged child frames.
  relay?.midiMessage(payload);
}

class TauriMIDIConnectionEvent extends Event implements MIDIConnectionEvent {
  readonly port: MIDIPort;

  constructor(type: string, eventInitDict?: MIDIConnectionEventInit) {
    super(type, eventInitDict);
    this.port = (eventInitDict?.port || null)!;
  }
}

class TauriMIDIAccess extends EventTarget implements MIDIAccess {
  sysexEnabled = true;

  inputs = new Map<string, TauriMIDIInput>();
  outputs = new Map<string, TauriMIDIOutput>();

  // Ports are retained across a disconnect/reconnect so listeners survive, mirroring
  // Chrome's behaviour. Keyed by `${type}:${id}`.
  private portMap = new Map<string, TauriMIDIPort>();

  onstatechange: ((this: MIDIAccess, ev: Event) => any) | null = null;

  addEventListener<K extends keyof MIDIAccessEventMap>(
    type: K,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) {
    super.addEventListener(type, listener, options);
  }

  removeEventListener<K extends keyof MIDIAccessEventMap>(
    type: K,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ) {
    super.removeEventListener(type, listener, options);
  }

  constructor() {
    super();

    // Populate and send out the events for the initial state
    this.__tauri_statechange(_inputs, _outputs);

    // Register for events
    trackMidiInstance(this);

    // For some reason the `EventTarget` stuff isn't triggering this correctly.
    this.addEventListener("statechange", (event) => {
      if (this.onstatechange) return this.onstatechange(event);
    });
  }

  private __tauri_get_or_create_port(type: MIDIPortType, id: string, name: string): TauriMIDIPort {
    const key = `${type}:${id}`;
    let port = this.portMap.get(key);
    if (!port) {
      port = type === "input" ? new TauriMIDIInput(this, id, name) : new TauriMIDIOutput(this, id, name);
      this.portMap.set(key, port);
    }
    return port;
  }

  __tauri_statechange(inputs: PortList, outputs: PortList) {
    let ports: TauriMIDIPort[] = [];

    // Delete any disconnected inputs
    for (const [id, input] of this.inputs) {
      if (!inputs.find(([i, _]) => i === id)) {
        this.inputs.delete(id);
        if (!input.__tauri_set_device_state("disconnected")) ports.push(input);
      }
    }

    // Delete any disconnected outputs
    for (const [id, output] of this.outputs) {
      if (!outputs.find(([i, _]) => i === id)) {
        this.outputs.delete(id);
        if (!output.__tauri_set_device_state("disconnected")) ports.push(output);
      }
    }

    // Add any new inputs
    for (const [id, name] of inputs) {
      if (this.inputs.has(id)) continue;
      const input = this.__tauri_get_or_create_port("input", id, name) as TauriMIDIInput;
      this.inputs.set(id, input);
      if (!input.__tauri_set_device_state("connected")) ports.push(input);
    }

    // Add any new outputs
    for (const [id, name] of outputs) {
      if (this.outputs.has(id)) continue;
      const output = this.__tauri_get_or_create_port("output", id, name) as TauriMIDIOutput;
      this.outputs.set(id, output);
      if (!output.__tauri_set_device_state("connected")) ports.push(output);
    }

    // We delay so the consumer has a chance to attach event listeners
    setTimeout(() => ports.forEach((port) => port.__tauri_dispatch_statechange()), 0);
  }
}

class TauriMIDIPort extends EventTarget implements MIDIPort {
  connection: MIDIPortConnectionState = "closed";
  readonly id: string;
  manufacturer = null;
  onstatechange: ((this: MIDIPort, ev: Event) => any) | null = null;
  state: MIDIPortDeviceState = "disconnected";
  readonly version = null;

  constructor(
    private access: TauriMIDIAccess,
    public identifier: string,
    public name: string,
    public readonly type: MIDIPortType
  ) {
    super();
    this.id = identifier;
    this.name = name;

    this.addEventListener("statechange", (event) => {
      if (this.onstatechange) return this.onstatechange(event);
    });
  }

  __tauri_dispatch_statechange() {
    this.dispatchEvent(new TauriMIDIConnectionEvent("statechange", { port: this }));
    this.access.dispatchEvent(new TauriMIDIConnectionEvent("statechange", { port: this }));
  }

  // Bumped whenever a port transition starts. An asynchronous open records the
  // generation it began under and only applies its result while that generation is
  // still current, so a superseded attempt can never clobber a newer transition
  // (a reconnect, a disconnect, or an explicit open()/close()).
  private __tauri_generation = 0;

  // Mirrors Blink's MIDIPort::SetState so `state`/`connection` (and the statechange
  // event that reports them) match Chrome. Returns true when this call already
  // dispatched a statechange.
  __tauri_set_device_state(state: MIDIPortDeviceState): boolean {
    if (state === "disconnected") {
      this.__tauri_generation++;
      this.connection =
        this.connection === "open" || this.connection === "pending" ? "pending" : "closed";
      this.state = "disconnected";
      return false;
    }

    if (this.connection === "pending") {
      this.state = "connected";
      // Reopening is asynchronous. If the backend refuses (for example because the
      // device is already gone), only `connection` settles: the device is still
      // connected (that is why the reopen was attempted), so `state` remains
      // "connected" and the port stays in `access.inputs`, matching the spec. A
      // later open() then reaches the backend again. Blink's SetState(CONNECTED)
      // followed by a failed OpenAsynchronously ends at (connected, closed).
      const reopen = this.open();
      // open() bumps the generation synchronously before it first awaits, so this
      // is the generation of the attempt we just started.
      const attempt = this.__tauri_generation;
      reopen.catch(() => {
        // A newer transition (another reconnect, a disconnect, or an explicit
        // open()/close()) supersedes this failure; its result owns the port now.
        if (attempt !== this.__tauri_generation) return;
        if (this.connection === "pending") {
          this.connection = "closed";
          this.__tauri_dispatch_statechange();
        }
      });
      return true;
    }

    this.state = "connected";
    return false;
  }

  async open(): Promise<MIDIPort> {
    const generation = ++this.__tauri_generation;

    if (this.connection === "open") return this;

    if (this.state === "disconnected") {
      // A port that is already pending has already notified consumers; opening it
      // again is a no-op (Blink emits no event for a redundant open).
      if (this.connection === "pending") return this;

      this.connection = "pending";

      this.__tauri_dispatch_statechange();

      return this;
    }

    try {
      if (this.type === "input") await callCommand("openInput", [this.id]);
      else await callCommand("openOutput", [this.id]);
    } catch (err) {
      throw toMidiError(err, "NotAllowedError");
    }

    // A newer transition superseded this open while the backend round-trip was in
    // flight; it owns the port's state now.
    if (generation !== this.__tauri_generation) return this;

    // The device may have gone away while the backend round-trip was in flight.
    // Blink re-checks the device state once the backend open completes and, when
    // the port is gone, ends at (disconnected, pending) instead of reporting a
    // disconnected port as "open". The comparison is made against the declared
    // union because the state can change across the await above.
    const next: MIDIPortConnectionState =
      (this.state as MIDIPortDeviceState) === "disconnected" ? "pending" : "open";
    if (this.connection !== next) {
      this.connection = next;
      this.__tauri_dispatch_statechange();
    }

    return this;
  }

  async close(): Promise<MIDIPort> {
    const generation = ++this.__tauri_generation;

    if (this.connection === "closed") return this;

    try {
      if (this.type === "input") await callCommand("closeInput", [this.id]);
      else await callCommand("closeOutput", [this.id]);
    } catch (err) {
      throw toMidiError(err, "NotAllowedError");
    }

    if (generation !== this.__tauri_generation) return this;

    this.connection = "closed";

    this.__tauri_dispatch_statechange();

    return this;
  }
}

class TauriMIDIMessageEvent extends Event implements MIDIMessageEvent {
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/MIDIMessageEvent/data) */
  readonly data: Uint8Array<ArrayBuffer>;

  constructor(type: string, eventInitDict?: MIDIMessageEventInit) {
    super(type, eventInitDict);

    this.data = eventInitDict?.data ?? new Uint8Array(new ArrayBuffer(0));
  }
}

class TauriMIDIInput extends TauriMIDIPort implements MIDIInput {
  constructor(access: TauriMIDIAccess, id: string, name: string) {
    super(access, id, name, "input");

    this.addEventListener("midimessage", (event) => {
      if (this.onmidimessage) return this.onmidimessage(event);
    });
  }


  private _onmidimessage: ((this: MIDIInput, ev: Event) => any) | null = null;

  get onmidimessage() {
    return this._onmidimessage;
  }

  set onmidimessage(cb: ((this: MIDIInput, ev: Event) => any) | null) {
    this._onmidimessage = cb;
    if (cb && this.connection !== "open") this.open();
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) {
    super.addEventListener(type, listener, options);
    if (type === "midimessage" && listener && this.state === "connected" && this.connection !== "open") {
      this.open();
    }
  }
}

class TauriMIDIOutput extends TauriMIDIPort implements MIDIOutput {
  constructor(access: TauriMIDIAccess, id: string, name: string) {
    super(access, id, name, "output");
  }

  send(data: number[], timestamp?: DOMHighResTimeStamp) {
    if (this.state === "disconnected")
      throw new DOMException("MIDIOutput is disconnected", "InvalidStateError");

    if (!Array.isArray(data) && !ArrayBuffer.isView(data))
      throw new TypeError("MIDIOutput.send() expects an array of MIDI bytes");

    const p =
      this.state === "connected" && this.connection === "closed"
        ? this.open()
        : Promise.resolve();

    const epoch = timestamp ? Math.trunc(performance.timeOrigin + timestamp): null;
    // `send()` returns `undefined` and the spec defines no rejection channel for it,
    // so a backend failure cannot be reported back to the caller. Log it rather than
    // letting it escape as an unhandled rejection; the port's `statechange` is the
    // only spec-legal signal a consumer can observe.
    p.then(() => callCommand("outputSend", [this.id, data, epoch ? epoch.toString() : null])).catch((err) => {
      console.error("Failed to send MIDI message:", err);
    });
  }
}

function installPolyfill() {
  globalThis.MIDIConnectionEvent = TauriMIDIConnectionEvent;
  globalThis.MIDIAccess = TauriMIDIAccess;
  globalThis.MIDIPort = TauriMIDIPort as any; // TODO
  globalThis.MIDIMessageEvent = TauriMIDIMessageEvent as any; // TODO
  globalThis.MIDIInput = TauriMIDIInput as any; // TODO
  globalThis.MIDIOutput = TauriMIDIOutput as any; // TODO

  navigator.requestMIDIAccess = () => ready.then(() => new TauriMIDIAccess());
}

// ── Frame bridge ───────────────────────────────────────────────────────────

interface FrameRelay {
  stateChange(inputs: PortList, outputs: PortList): void;
  midiMessage(payload: MidiMessagePayload): void;
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  const crypto = (globalThis as any).crypto;
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * True for a serialised origin we can safely compare against. An *opaque* origin
 * serialises to `"null"` (some embedders use the empty string), and every opaque
 * origin in a webview serialises the same way — so it can never be used as a
 * gate: the top frame cannot tell a sandboxed stranger from a frame the app
 * meant to bridge, and a child cannot tell whether `window.top` is really
 * same-origin with it. Opaque origins are therefore not bridgeable on either end.
 */
function isUsableOrigin(origin: unknown): origin is string {
  return typeof origin === "string" && origin !== "" && origin !== "null";
}

/**
 * Main-frame side of the bridge: forwards the Tauri IPC to same-origin child
 * frames over `postMessage`.
 */
function createRelay(): FrameRelay {
  const win = globalThis as any;
  const selfOrigin = win.location.origin;
  // A top frame with an opaque origin serves nobody. Refusing here (rather than
  // in the caller) keeps the gate next to the check it guards.
  const bridgeable = isUsableOrigin(selfOrigin);

  // `event.source` -> the frame we are willing to serve.
  const children = new Map<any, { token: string; client: string; origin: string }>();
  let lastState: { inputs: PortList; outputs: PortList } | null = null;

  const reply = (source: any, origin: string, message: Record<string, unknown>) => {
    try {
      source.postMessage({ [BRIDGE_TAG]: true, ...message }, origin);
    } catch {
      // The frame is gone.
      children.delete(source);
    }
  };

  // A child frame that has been detached from the document stops accepting
  // messages, but posting to it is a silent no-op rather than an error, so
  // nothing else would ever evict it. Skip (and forget) closed frames so a
  // long-lived app does not accumulate a dead entry for every iframe it ever
  // created and re-post every 1 Hz state change to all of them.
  const evicted = (source: any) => {
    if (source?.closed === true) {
      children.delete(source);
      return true;
    }
    return false;
  };

  const broadcast = (name: BridgeEvent, payload: unknown) => {
    for (const [source, child] of children) {
      if (evicted(source)) continue;
      reply(source, child.origin, { kind: "event", token: child.token, name, payload });
    }
  };

  const onMessage = (event: any) => {
    const data = event?.data;
    if (!data || typeof data !== "object" || data[BRIDGE_TAG] !== true) return;
    // The Tauri capability set covers the whole webview, so only frames that
    // share our origin may use it. Everything else — including remote iframes
    // that happen to run this same init script — is ignored outright.
    if (!bridgeable || event.origin !== selfOrigin) return;
    const source = event.source;
    if (!source) return;

    if (data.kind === "hello") {
      if (typeof data.client !== "string") return;

      let child = children.get(source);
      if (!child) {
        child = { token: randomToken(), client: data.client, origin: selfOrigin };
        children.set(source, child);
      }

      reply(source, child.origin, {
        kind: "welcome",
        token: child.token,
        client: data.client,
        origin: selfOrigin,
      });

      // Hand over the current port list so the child doesn't have to wait for
      // the backend's next update before `requestMIDIAccess()` can settle.
      if (lastState) {
        reply(source, child.origin, {
          kind: "event",
          token: child.token,
          name: "state-change",
          payload: lastState,
        });
      }

      return;
    }

    // The child tells us when its document goes away, so we can drop it without
    // waiting for the next broadcast to notice it is closed. The token (or the
    // client id, before the handshake completed) has to match, so one frame
    // cannot evict another's bridged sibling.
    if (data.kind === "bye") {
      const child = children.get(source);
      if (
        child &&
        (data.token === child.token ||
          (typeof data.client === "string" && data.client === child.client))
      ) {
        children.delete(source);
      }
      return;
    }

    if (data.kind === "invoke") {
      const child = children.get(source);
      if (!child || child.token !== data.token) return;
      if (typeof data.id !== "string") return;

      const command = Object.prototype.hasOwnProperty.call(BRIDGED_COMMANDS, data.command)
        ? BRIDGED_COMMANDS[data.command as BridgedCommand]
        : undefined;
      if (!command) return;

      const args = Array.isArray(data.args) ? data.args : [];
      Promise.resolve()
        .then(() => command(...args))
        .then(
          (value) => reply(source, child!.origin, { kind: "result", token: child!.token, id: data.id, ok: true, value: value ?? null }),
          (error) => {
            // Relay the pieces a DOMException needs, not a stringified error:
            // otherwise the child cannot reconstruct `error.name`, and every
            // bridged rejection would surface as a nameless error instead of
            // the `NotAllowedError` a consumer expects.
            const message = String(error?.message ?? error);
            const name = error instanceof DOMException ? error.name : "NotAllowedError";
            reply(source, child!.origin, { kind: "result", token: child!.token, id: data.id, ok: false, message, name });
          }
        );
    }
  };

  win.addEventListener("message", onMessage);

  return {
    stateChange(inputs, outputs) {
      lastState = { inputs, outputs };
      broadcast("state-change", lastState);
    },
    midiMessage(payload) {
      broadcast("midi-message", payload);
    },
  };
}

interface FrameClient {
  invoke(command: BridgedCommand, args: unknown[]): Promise<unknown>;
  listen(name: BridgeEvent, cb: (payload: any) => void): UnlistenFn;
}

/**
 * Child-frame side of the bridge: relays everything through `window.top`.
 */
function createRelayClient(top: any, topOrigin: string): FrameClient {
  const win = globalThis as any;
  const client = randomToken();
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const queued: { command: BridgedCommand; args: unknown[]; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const listeners: Record<BridgeEvent, Set<(payload: any) => void>> = {
    "state-change": new Set(),
    "midi-message": new Set(),
  };
  // Only the top frame knows this value, so nobody else can pretend to be it
  // after the handshake.
  let token: string | null = null;
  let handshake: any = null;
  let attempts = 0;
  let nextRequestId = 0;

  const send = (message: Record<string, unknown>) => {
    try {
      top.postMessage({ [BRIDGE_TAG]: true, ...message }, topOrigin);
    } catch {
      // The top frame navigated away.
    }
  };

  const sayHello = () => {
    if (token || attempts >= BRIDGE_HELLO_ATTEMPTS) return;
    attempts++;
    send({ kind: "hello", client });
    if (!token) handshake = setTimeout(sayHello, BRIDGE_HELLO_RETRY_MS);
  };

  const flushQueued = () => {
    for (const request of queued.splice(0)) dispatch(request);
  };

  const dispatch = (request: { command: BridgedCommand; args: unknown[]; resolve: (value: unknown) => void; reject: (error: Error) => void }) => {
    const id = `${client}:${++nextRequestId}`;
    pending.set(id, { resolve: request.resolve, reject: request.reject });
    send({ kind: "invoke", token, id, command: request.command, args: request.args });
  };

  const onMessage = (event: any) => {
    const data = event?.data;
    if (!data || typeof data !== "object" || data[BRIDGE_TAG] !== true) return;
    // Only the top frame itself is allowed to answer us, and only if it is the
    // origin we handshook with.
    if (event.source !== top) return;
    if (event.origin !== topOrigin) return;

    if (data.kind === "welcome") {
      if (data.client !== client || typeof data.token !== "string") return;
      token = data.token;
      if (handshake) {
        clearTimeout(handshake);
        handshake = null;
      }
      flushQueued();
      return;
    }

    if (typeof token !== "string" || data.token !== token) return;

    if (data.kind === "event") {
      if (!Object.prototype.hasOwnProperty.call(listeners, data.name)) return;
      for (const listener of listeners[data.name as BridgeEvent]) {
        try {
          listener(data.payload);
        } catch {
          // A listener blowing up must not take the whole frame down.
        }
      }
      return;
    }

    if (data.kind === "result") {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      if (data.ok) request.resolve(data.value ?? null);
      else request.reject(new DOMException(String(data.message), String(data.name ?? "NotAllowedError")));
    }
  };

  win.addEventListener("message", onMessage);
  // Tell the top frame when this document really goes away, so it can drop us
  // instead of holding a dead entry until the next broadcast. A `pagehide` with
  // `persisted: true` means the document was put in the back/forward cache: it is
  // not gone, it will be restored with its heap (and its token) intact, and the
  // top frame keeps its entry. Announcing `bye` there would strand the frame
  // forever — the restored document never re-hellos — so it is skipped.
  win.addEventListener("pagehide", (event: any) => {
    if (event?.persisted) return;
    send({ kind: "bye", client, token });
  });
  // Restored from the back/forward cache. We may have missed state changes while
  // frozen, so re-announce to resynchronise (the top replies with `welcome` and
  // the current port list).
  win.addEventListener("pageshow", (event: any) => {
    if (!event?.persisted) return;
    send({ kind: "hello", client });
  });
  sayHello();

  return {
    invoke(command, args) {
      return new Promise((resolve, reject) => {
        const request = { command, args, resolve, reject };
        if (token) dispatch(request);
        else queued.push(request);
      });
    },
    listen(name, cb) {
      listeners[name].add(cb);
      return () => listeners[name].delete(cb);
    },
  };
}

/**
 * The top frame's origin, or `null` when this frame is not bridgeable to it.
 * Reading `location` across origins throws, and an opaque origin serialises to
 * `"null"`, which is not a usable gate — see [isUsableOrigin].
 */
function readTopOrigin(top: any): string | null {
  try {
    const origin = top.location.origin;
    return isUsableOrigin(origin) ? origin : null;
  } catch {
    return null;
  }
}

function bootstrap() {
  const win = globalThis as any;
  const hasInternals = !!(globalThis as any).__TAURI_INTERNALS__;

  let top: any = null;
  try {
    top = win.top;
  } catch {
    // Ignore — treated as the top frame.
  }
  const isTopFrame = !top || top === win.self || top === win;

  // A child frame may only relay the webview's IPC if it shares the top frame's
  // origin. Anything else is left untouched, including the page's own
  // `navigator.requestMIDIAccess` if the browser provides one.
  const topOrigin = isTopFrame ? null : readTopOrigin(top);
  if (!isTopFrame && topOrigin === null) return;

  // The main frame is guaranteed to have the Tauri IPC injected before this
  // script runs; without it there is nothing to talk to.
  if (isTopFrame && !hasInternals) return;

  if (hasInternals) {
    relay = createRelay();
    callCommand = (command, args) => BRIDGED_COMMANDS[command](...args);
    listenMidiMessage = (cb) => events.midiMessage.listen((event) => cb(event.payload));
    events.stateChange.listen((event) => handleStateChange(event.payload.inputs, event.payload.outputs));
  } else {
    const bridge = createRelayClient(top, topOrigin!);
    callCommand = (command, args) => bridge.invoke(command, args);
    listenMidiMessage = (cb) => Promise.resolve(bridge.listen("midi-message", cb));
    bridge.listen("state-change", (payload) => handleStateChange(payload.inputs, payload.outputs));
  }

  // Exactly one `midi-message` subscription per frame, via the frame-aware
  // indirection: the real Tauri event plugin in the main frame, the relay in a
  // bridged child. `handleMidiMessage` routes to local ports and also forwards to
  // child frames, so there is no second subscription on a child's behalf.
  listenMidiMessage(handleMidiMessage);

  installPolyfill();
}

bootstrap();
