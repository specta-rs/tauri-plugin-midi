"use strict";
(() => {
  // node_modules/.pnpm/@tauri-apps+api@2.0.0-rc.6/node_modules/@tauri-apps/api/core.js
  var _Channel_onmessage;
  var _Channel_nextMessageId;
  var _Channel_pendingMessages;
  var _Resource_rid;
  function transformCallback(callback, once2 = false) {
    return window.__TAURI_INTERNALS__.transformCallback(callback, once2);
  }
  _Channel_onmessage = /* @__PURE__ */ new WeakMap(), _Channel_nextMessageId = /* @__PURE__ */ new WeakMap(), _Channel_pendingMessages = /* @__PURE__ */ new WeakMap();
  async function invoke(cmd, args = {}, options) {
    return window.__TAURI_INTERNALS__.invoke(cmd, args, options);
  }
  _Resource_rid = /* @__PURE__ */ new WeakMap();

  // node_modules/.pnpm/@tauri-apps+api@2.0.0-rc.6/node_modules/@tauri-apps/api/event.js
  var TauriEvent;
  (function(TauriEvent2) {
    TauriEvent2["WINDOW_RESIZED"] = "tauri://resize";
    TauriEvent2["WINDOW_MOVED"] = "tauri://move";
    TauriEvent2["WINDOW_CLOSE_REQUESTED"] = "tauri://close-requested";
    TauriEvent2["WINDOW_DESTROYED"] = "tauri://destroyed";
    TauriEvent2["WINDOW_FOCUS"] = "tauri://focus";
    TauriEvent2["WINDOW_BLUR"] = "tauri://blur";
    TauriEvent2["WINDOW_SCALE_FACTOR_CHANGED"] = "tauri://scale-change";
    TauriEvent2["WINDOW_THEME_CHANGED"] = "tauri://theme-changed";
    TauriEvent2["WINDOW_CREATED"] = "tauri://window-created";
    TauriEvent2["WEBVIEW_CREATED"] = "tauri://webview-created";
    TauriEvent2["DRAG_ENTER"] = "tauri://drag-enter";
    TauriEvent2["DRAG_OVER"] = "tauri://drag-over";
    TauriEvent2["DRAG_DROP"] = "tauri://drag-drop";
    TauriEvent2["DRAG_LEAVE"] = "tauri://drag-leave";
  })(TauriEvent || (TauriEvent = {}));
  async function _unlisten(event, eventId) {
    await invoke("plugin:event|unlisten", {
      event,
      eventId
    });
  }
  async function listen(event, handler, options) {
    var _a;
    const target = typeof (options === null || options === void 0 ? void 0 : options.target) === "string" ? { kind: "AnyLabel", label: options.target } : (_a = options === null || options === void 0 ? void 0 : options.target) !== null && _a !== void 0 ? _a : { kind: "Any" };
    return invoke("plugin:event|listen", {
      event,
      target,
      handler: transformCallback(handler)
    }).then((eventId) => {
      return async () => _unlisten(event, eventId);
    });
  }
  async function once(event, handler, options) {
    return listen(event, (eventData) => {
      _unlisten(event, eventData.id);
      handler(eventData);
    }, options);
  }
  async function emit(event, payload) {
    await invoke("plugin:event|emit", {
      event,
      payload
    });
  }

  // guest-js/bindings.ts
  var commands = {
    async openInput(name) {
      await invoke("plugin:midi|open_input", { name });
    },
    async closeInput(name) {
      await invoke("plugin:midi|close_input", { name });
    },
    async openOutput(name) {
      await invoke("plugin:midi|open_output", { name });
    },
    async closeOutput(name) {
      await invoke("plugin:midi|close_output", { name });
    },
    async outputSend(name, msg) {
      await invoke("plugin:midi|output_send", { name, msg });
    }
  };
  var events = __makeEvents__({
    midiMessage: "plugin:midi:midi-message",
    stateChange: "plugin:midi:state-change"
  });
  function __makeEvents__(mappings) {
    return new Proxy(
      {},
      {
        get: (_, event) => {
          const name = mappings[event];
          return new Proxy(() => {
          }, {
            apply: (_2, __, [window2]) => ({
              listen: (arg) => window2.listen(name, arg),
              once: (arg) => window2.once(name, arg),
              // @ts-expect-error
              emit: (arg) => window2.emit(name, arg)
            }),
            get: (_2, command) => {
              switch (command) {
                case "listen":
                  return (arg) => listen(name, arg);
                case "once":
                  return (arg) => once(name, arg);
                case "emit":
                  return (arg) => emit(name, arg);
              }
            }
          });
        }
      }
    );
  }

  // guest-js/index.ts
  var TauriMIDIAccess = class extends EventTarget {
    constructor() {
      super();
      this.sysexEnabled = true;
      this.inputs = /* @__PURE__ */ new Map();
      this.outputs = /* @__PURE__ */ new Map();
      this.onstatechange = null;
      events.stateChange.listen((event) => {
        const { inputs, outputs } = event.payload;
        let dirty = false;
        for (const [id, input] of this.inputs) {
          if (!inputs.includes(id)) {
            this.inputs.delete(id);
            input.state = "disconnected";
            dirty = true;
          }
        }
        for (const inputName of inputs) {
          if (this.inputs.has(inputName)) continue;
          const input = new TauriMIDIInput(inputName);
          input.state = "connected";
          this.inputs.set(inputName, input);
          dirty = true;
        }
        for (const [id, output] of this.outputs) {
          if (!outputs.includes(id)) {
            this.outputs.delete(id);
            output.state = "disconnected";
            dirty = true;
          }
        }
        for (const outputName of outputs) {
          if (this.outputs.has(outputName)) continue;
          const output = new TauriMIDIOutput(outputName);
          output.state = "connected";
          this.outputs.set(outputName, output);
          dirty = true;
        }
        if (dirty) this.dispatchEvent(new Event("statechange"));
      });
    }
    addEventListener(type, listener, options) {
      super.addEventListener(type, listener, options);
    }
    removeEventListener(type, listener, options) {
      super.removeEventListener(type, listener, options);
    }
  };
  var TauriMIDIPort = class extends EventTarget {
    constructor(name, type) {
      super();
      this.name = name;
      this.type = type;
      this.connection = "closed";
      this.manufacturer = null;
      this.onstatechange = null;
      this.state = "disconnected";
      this.version = null;
      this.id = name;
    }
    async open() {
      if (this.connection === "open" || this.connection === "pending")
        return this;
      if (this.state === "disconnected") {
        this.connection = "pending";
        access.dispatchEvent(new Event("statechange"));
        this.dispatchEvent(new Event("statechange"));
        return this;
      }
      if (this.type === "input") await commands.openInput(this.id);
      else await commands.openOutput(this.id);
      this.connection = "open";
      access.dispatchEvent(new Event("statechange"));
      this.dispatchEvent(new Event("statechange"));
      return this;
    }
    async close() {
      if (this.connection === "closed") return this;
      if (this.type === "input") await commands.closeInput(this.id);
      else await commands.closeOutput(this.id);
      this.connection = "closed";
      access.dispatchEvent(new Event("statechange"));
      this.dispatchEvent(new Event("statechange"));
      return this;
    }
  };
  var TauriMIDIMessageEvent = class extends Event {
    constructor(type, eventInitDict) {
      super(type, eventInitDict);
      this.data = eventInitDict?.data;
    }
  };
  var TauriMIDIInput = class extends TauriMIDIPort {
    constructor(name) {
      super(name, "input");
      this._onmidimessage = null;
    }
    open() {
      if (!this.stopListening)
        this.stopListening = events.midiMessage.listen((event) => {
          const [inputName, data] = event.payload;
          if (inputName !== this.name) return;
          this.dispatchEvent(
            new TauriMIDIMessageEvent("midimessage", {
              data: new Uint8Array(data)
            })
          );
        });
      return super.open();
    }
    close() {
      this.stopListening?.then((cb) => cb());
      return super.close();
    }
    get onmidimessage() {
      return this._onmidimessage;
    }
    set onmidimessage(cb) {
      this._onmidimessage = cb;
      if (this.connection !== "open") this.open();
    }
  };
  var TauriMIDIOutput = class extends TauriMIDIPort {
    constructor(name) {
      super(name, "output");
    }
    send(data) {
      if (this.state === "disconnected")
        throw new Error("MIDIOutput is disconnected");
      const p = this.state === "connected" && this.connection === "closed" ? this.open() : Promise.resolve();
      p.then(() => commands.outputSend(this.name, data));
    }
  };
  var access = new TauriMIDIAccess();
  navigator.requestMIDIAccess = () => Promise.resolve(access);
})();
