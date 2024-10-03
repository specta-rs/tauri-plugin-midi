import type { UnlistenFn } from "@tauri-apps/api/event";
import { events, commands } from "./bindings.js";

// https://webaudio.github.io/web-midi-api

class TauriMIDIAccess extends EventTarget implements MIDIAccess {
	sysexEnabled = true;

	inputs = new Map<string, TauriMIDIInput>();
	outputs = new Map<string, TauriMIDIOutput>();

	onstatechange: ((this: MIDIAccess, ev: Event) => any) | null = null;

	addEventListener<K extends keyof MIDIAccessEventMap>(
		type: K,
		listener: (this: MIDIAccess, ev: MIDIAccessEventMap[K]) => any,
		options?: boolean | AddEventListenerOptions,
	) {
		super.addEventListener(type, listener, options);
	}

	removeEventListener<K extends keyof MIDIAccessEventMap>(
		type: K,
		listener: (this: MIDIAccess, ev: MIDIAccessEventMap[K]) => any,
		options?: boolean | EventListenerOptions,
	) {
		super.removeEventListener(type, listener, options);
	}

	constructor(resolve: () => void) {
		super();

		events.stateChange.listen((event) => {
			const { inputs, outputs } = event.payload;

			let dirty = false;

			// Delete any disconnected inputs
			for (const [id, input] of this.inputs) {
				if (!inputs.find(([i, _]) => i === id)) {
					this.inputs.delete(id);
					input.state = "disconnected";

					dirty = true;
				}
			}

			// Delete any disconnected outputs
			for (const [id, output] of this.outputs) {
				if (!outputs.find(([i, _]) => i === id)) {
					this.outputs.delete(id);
					output.state = "disconnected";

					dirty = true;
				}
			}

			// Add any new inputs
			for (const [id, name] of inputs) {
				if (this.inputs.has(id)) continue;

				const input = new TauriMIDIInput(id, name);
				input.state = "connected";

				this.inputs.set(id, input);

				dirty = true;
			}

			// Add any new outputs
			for (const [id, name] of outputs) {
				if (this.outputs.has(id)) continue;

				const output = new TauriMIDIOutput(id, name);
				output.state = "connected";

				this.outputs.set(id, output);

				dirty = true;
			}

			if (dirty) this.dispatchEvent(new Event("statechange"));
			resolve();
		});
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
		public identifier: string,
		public name: string,
		public readonly type: MIDIPortType,
	) {
		super();
		this.id = identifier;
		// this.name = name; // TODO
	}

	async open(): Promise<MIDIPort> {
		if (this.connection === "open" || this.connection === "pending")
			return this;

		if (this.state === "disconnected") {
			this.connection = "pending";

			(await access).dispatchEvent(new Event("statechange"));
			this.dispatchEvent(new Event("statechange"));

			return this;
		}

		console.log("Opening", this.id); // TODO
		if (this.type === "input") await commands.openInput(this.id);
		else await commands.openOutput(this.id);

		this.connection = "open";

		(await access).dispatchEvent(new Event("statechange"));
		this.dispatchEvent(new Event("statechange"));

		return this;
	}

	async close(): Promise<MIDIPort> {
		if (this.connection === "closed") return this;

		if (this.type === "input") await commands.closeInput(this.id);
		else await commands.closeOutput(this.id);

		this.connection = "closed";

		(await access).dispatchEvent(new Event("statechange"));
		this.dispatchEvent(new Event("statechange"));

		return this;
	}
}

class TauriMIDIMessageEvent extends Event implements MIDIMessageEvent {
	/** [MDN Reference](https://developer.mozilla.org/docs/Web/API/MIDIMessageEvent/data) */
	readonly data: Uint8Array;

	constructor(type: string, eventInitDict?: MIDIMessageEventInit) {
		super(type, eventInitDict);

		this.data = eventInitDict?.data!;
	}
}

class TauriMIDIInput extends TauriMIDIPort implements MIDIInput {
	constructor(id: string, name: string) {
		super(id, name, "input");
		this.addEventListener("midimessage", (cb) => {
			if (this.onmidimessage) this.onmidimessage(cb);
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
					}),
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

const access = new Promise<MIDIAccess>((r, reject) => {
	const access: TauriMIDIAccess = new TauriMIDIAccess(() => r(access));
	setTimeout(() => reject(new Error("Failed to initialise WebMIDI")), 10_000);
});

navigator.requestMIDIAccess = () => access;
