import type { UnlistenFn } from "@tauri-apps/api/event";
import { events, commands } from "./bindings.js";

// https://webaudio.github.io/web-midi-api

// Backend errors arrive as plain strings; Web MIDI consumers expect DOMExceptions.
function toMidiError(err: unknown, name: string): Error {
  if (err instanceof Error) return err;
  return new DOMException(String(err), name);
}

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

let _inputs: [string, string][] = [];
let _outputs: [string, string][] = [];

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

events.stateChange.listen((event) => {
  const { inputs, outputs } = event.payload;

  // We cache the last values so any new instances can be created without waiting.
  _inputs = inputs;
  _outputs = outputs;

  // The new instance will use the values above
  resolve();

  // Invoke the state change on all instances
  forEachMidiInstance((instance) => instance.__tauri_statechange(inputs, outputs));
});

class TauriMIDIConnectionEvent extends Event implements MIDIConnectionEvent {
  readonly port: MIDIPort;

  constructor(type: string, eventInitDict?: MIDIConnectionEventInit) {
    super(type, eventInitDict);
    this.port = (eventInitDict?.port || null)!;
  }
}

globalThis.MIDIConnectionEvent = TauriMIDIConnectionEvent;

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

  __tauri_statechange(inputs: [string, string][], outputs: [string, string][]) {
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

globalThis.MIDIAccess = TauriMIDIAccess;

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

  // Mirrors Blink's MIDIPort::SetState so `state`/`connection` (and the statechange
  // event that reports them) match Chrome. Returns true when this call already
  // dispatched a statechange.
  __tauri_set_device_state(state: MIDIPortDeviceState): boolean {
    if (state === "disconnected") {
      this.connection =
        this.connection === "open" || this.connection === "pending" ? "pending" : "closed";
      this.state = "disconnected";
      return false;
    }

    if (this.connection === "pending") {
      this.state = "connected";
      // Reopening is asynchronous. If the backend refuses (for example because the
      // device is already gone), end in a terminal closed state and dispatch, so
      // consumers observe the failure instead of a port left stranded at
      // (connected, pending) with no event and an unhandled rejection.
      this.open().catch(() => {
        this.state = "disconnected";
        this.connection = "closed";
        this.__tauri_dispatch_statechange();
      });
      return true;
    }

    this.state = "connected";
    return false;
  }

  async open(): Promise<MIDIPort> {
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
      if (this.type === "input") await commands.openInput(this.id);
      else await commands.openOutput(this.id);
    } catch (err) {
      throw toMidiError(err, "NotAllowedError");
    }

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
    if (this.connection === "closed") return this;

    try {
      if (this.type === "input") await commands.closeInput(this.id);
      else await commands.closeOutput(this.id);
    } catch (err) {
      throw toMidiError(err, "NotAllowedError");
    }

    this.connection = "closed";

    this.__tauri_dispatch_statechange();

    return this;
  }
}

globalThis.MIDIPort = TauriMIDIPort as any; // TODO

class TauriMIDIMessageEvent extends Event implements MIDIMessageEvent {
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/MIDIMessageEvent/data) */
  readonly data: Uint8Array<ArrayBuffer>;

  constructor(type: string, eventInitDict?: MIDIMessageEventInit) {
    super(type, eventInitDict);

    this.data = eventInitDict?.data ?? new Uint8Array(new ArrayBuffer(0));
  }
}

globalThis.MIDIMessageEvent = TauriMIDIMessageEvent as any; // TODO

class TauriMIDIInput extends TauriMIDIPort implements MIDIInput {
  constructor(access: TauriMIDIAccess, id: string, name: string) {
    super(access, id, name, "input");

    this.addEventListener("midimessage", (event) => {
      if (this.onmidimessage) return this.onmidimessage(event);
    });
  }

  private stopListening?: Promise<UnlistenFn>;

  open() {
    if (!this.stopListening)
      this.stopListening = events.midiMessage.listen((event) => {
        const [inputName, timestampRaw, data] = event.payload;

        if (inputName !== this.id) return;

        const timestamp = parseInt(timestampRaw);
        const midiEvent = new TauriMIDIMessageEvent("midimessage", {
          data: new Uint8Array(data),
        });

        Object.defineProperty(midiEvent, 'timeStamp', { value: timestamp });
        // This is deprecated in spec but we'll keep it anyway for compatibility
        Object.defineProperty(midiEvent, 'receivedTime', { value: timestamp });

        this.dispatchEvent(midiEvent);
      });

    return super.open();
  }

  close() {
    if (this.stopListening) {
      this.stopListening?.then((cb) => cb());
      this.stopListening = undefined;
    }

    return super.close();
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

globalThis.MIDIInput = TauriMIDIInput as any; // TODO

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
    p.then(() => commands.outputSend(this.id, data, epoch ? epoch.toString() : null)).catch((err) => {
      console.error("Failed to send MIDI message:", err);
    });
  }
}

globalThis.MIDIOutput = TauriMIDIOutput as any; // TODO

navigator.requestMIDIAccess = () => ready.then(() => new TauriMIDIAccess());
