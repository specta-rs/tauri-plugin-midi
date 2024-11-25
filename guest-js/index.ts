import type { UnlistenFn } from "@tauri-apps/api/event";
import { events, commands } from "./bindings.js";

// https://webaudio.github.io/web-midi-api

let resolve: () => void;
const ready = new Promise((r, reject) => {
  resolve = () => r(void 0);
  setTimeout(() => reject(new Error("Failed to initialise WebMIDI")), 10_000);
});

let _inputs: [string, string][] = [];
let _outputs: [string, string][] = [];

// TODO: https://github.com/specta-rs/tauri-plugin-midi/issues/10
const midiInstances = new Set<TauriMIDIAccess>();

events.stateChange.listen((event) => {
  const { inputs, outputs } = event.payload;

  // We cache the last values so any new instances can be created without waiting.
  _inputs = inputs;
  _outputs = outputs;

  // The new instance will use the values above
  resolve();

  // Invoke the state change on all instances
  for (const instance of midiInstances) {
    instance.__tauri_statechange(inputs, outputs);
  }
});

class TauriMIDIConnectionEvent extends Event implements MIDIConnectionEvent {
  readonly port: MIDIPort;

  constructor(type: string, eventInitDict?: MIDIConnectionEventInit) {
    super("statechange", eventInitDict);
    this.port = (eventInitDict?.port || null)!;
  }
}

globalThis.MIDIConnectionEvent = TauriMIDIConnectionEvent;

class TauriMIDIAccess extends EventTarget implements MIDIAccess {
  sysexEnabled = true;

  inputs = new Map<string, TauriMIDIInput>();
  outputs = new Map<string, TauriMIDIOutput>();

  onstatechange: ((this: MIDIAccess, ev: Event) => any) | null = null;

  addEventListener<K extends keyof MIDIAccessEventMap>(
    type: K,
    listener: (this: MIDIAccess, ev: MIDIAccessEventMap[K]) => any,
    options?: boolean | AddEventListenerOptions
  ) {
    super.addEventListener(type, listener, options);
  }

  removeEventListener<K extends keyof MIDIAccessEventMap>(
    type: K,
    listener: (this: MIDIAccess, ev: MIDIAccessEventMap[K]) => any,
    options?: boolean | EventListenerOptions
  ) {
    super.removeEventListener(type, listener, options);
  }

  constructor() {
    super();

    // Populate and send out the events for the initial state
    this.__tauri_statechange(_inputs, _outputs);

    // Register for events
    midiInstances.add(this);

    // For some reason the `EventTarget` stuff isn't triggering this correctly.
    this.addEventListener("statechange", (event) => {
      if (this.onstatechange) return this.onstatechange(event);
    });
  }

  __tauri_statechange(inputs: [string, string][], outputs: [string, string][]) {
    let events: TauriMIDIConnectionEvent[] = [];

    // Delete any disconnected inputs
    for (const [id, input] of this.inputs) {
      if (!inputs.find(([i, _]) => i === id)) {
        this.inputs.delete(id);
        input.state = "disconnected";
        events.push(
          new TauriMIDIConnectionEvent("disconnected", {
            port: input,
          })
        );
      }
    }

    // Delete any disconnected outputs
    for (const [id, output] of this.outputs) {
      if (!outputs.find(([i, _]) => i === id)) {
        this.outputs.delete(id);
        output.state = "disconnected";
        events.push(
          new TauriMIDIConnectionEvent("disconnected", {
            port: output,
          })
        );
      }
    }

    // Add any new inputs
    for (const [id, name] of inputs) {
      if (this.inputs.has(id)) continue;
      const input = new TauriMIDIInput(id, name);
      input.state = "connected";
      this.inputs.set(id, input);
      events.push(
        new TauriMIDIConnectionEvent("connected", {
          port: input,
        })
      );
    }

    // Add any new outputs
    for (const [id, name] of outputs) {
      if (this.outputs.has(id)) continue;
      const output = new TauriMIDIOutput(id, name);
      output.state = "connected";
      this.outputs.set(id, output);
      events.push(
        new TauriMIDIConnectionEvent("connected", {
          port: output,
        })
      );
    }

    // We delay so the consumer has a chance to attach event listeners
    setTimeout(() => events.forEach((event) => this.dispatchEvent(event)), 0);
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
    public identifier: string,
    public name: string,
    public readonly type: MIDIPortType
  ) {
    super();
    this.id = identifier;
    this.name = name;
  }

  async open(): Promise<MIDIPort> {
    if (this.connection === "open" || this.connection === "pending")
      return this;

    if (this.state === "disconnected") {
      this.connection = "pending";

      //   for (const instance of midiInstances) {
      //     instance.dispatchEvent(new Event("statechange"));
      //   }
      this.dispatchEvent(new Event("statechange"));

      return this;
    }

    if (this.type === "input") await commands.openInput(this.id);
    else await commands.openOutput(this.id);

    this.connection = "open";

    // for (const instance of midiInstances) {
    //   instance.dispatchEvent(new Event("statechange"));
    // }
    this.dispatchEvent(new Event("statechange"));

    return this;
  }

  async close(): Promise<MIDIPort> {
    if (this.connection === "closed") return this;

    if (this.type === "input") await commands.closeInput(this.id);
    else await commands.closeOutput(this.id);

    this.connection = "closed";

    // for (const instance of midiInstances) {
    //   instance.dispatchEvent(new Event("statechange"));
    // }
    this.dispatchEvent(new Event("statechange"));

    return this;
  }
}

globalThis.MIDIPort = TauriMIDIPort as any; // TODO

class TauriMIDIMessageEvent extends Event implements MIDIMessageEvent {
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/MIDIMessageEvent/data) */
  readonly data: Uint8Array;

  constructor(type: string, eventInitDict?: MIDIMessageEventInit) {
    super(type, eventInitDict);

    this.data = eventInitDict?.data!;
  }
}

globalThis.MIDIMessageEvent = TauriMIDIMessageEvent as any; // TODO

class TauriMIDIInput extends TauriMIDIPort implements MIDIInput {
  constructor(id: string, name: string) {
    super(id, name, "input");

    this.addEventListener("midimessage", (event) => {
      if (this.onmidimessage) return this.onmidimessage(event);
    });
  }

  private stopListening?: Promise<UnlistenFn>;

  open() {
    if (!this.stopListening)
      this.stopListening = events.midiMessage.listen((event: any) => {
        const [inputName, data] = event.payload;

        if (inputName !== this.id) return;

        this.dispatchEvent(
          new TauriMIDIMessageEvent("midimessage", {
            data: new Uint8Array(data),
          })
        );
      });

    return super.open();
  }

  close() {
    this.stopListening?.then((cb) => cb());

    return super.close();
  }

  private _onmidimessage: ((this: MIDIInput, ev: Event) => any) | null = null;

  get onmidimessage() {
    return this._onmidimessage;
  }

  set onmidimessage(cb: ((this: MIDIInput, ev: Event) => any) | null) {
    this._onmidimessage = cb;
    if (this.connection !== "open") this.open();
  }
}

globalThis.MIDIInput = TauriMIDIInput as any; // TODO

class TauriMIDIOutput extends TauriMIDIPort implements MIDIOutput {
  constructor(id: string, name: string) {
    super(id, name, "output");
  }

  send(data: number[]) {
    if (this.state === "disconnected")
      throw new Error("MIDIOutput is disconnected");

    const p =
      this.state === "connected" && this.connection === "closed"
        ? this.open()
        : Promise.resolve();

    p.then(() => commands.outputSend(this.id, data));
  }
}

globalThis.MIDIOutput = TauriMIDIOutput as any; // TODO

navigator.requestMIDIAccess = () => ready.then(() => new TauriMIDIAccess());
