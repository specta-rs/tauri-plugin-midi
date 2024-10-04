"use strict";(()=>{var b,P,N,W;function E(t,n=!1){return window.__TAURI_INTERNALS__.transformCallback(t,n)}b=new WeakMap,P=new WeakMap,N=new WeakMap;async function c(t,n={},e){return window.__TAURI_INTERNALS__.invoke(t,n,e)}W=new WeakMap;var y;(function(t){t.WINDOW_RESIZED="tauri://resize",t.WINDOW_MOVED="tauri://move",t.WINDOW_CLOSE_REQUESTED="tauri://close-requested",t.WINDOW_DESTROYED="tauri://destroyed",t.WINDOW_FOCUS="tauri://focus",t.WINDOW_BLUR="tauri://blur",t.WINDOW_SCALE_FACTOR_CHANGED="tauri://scale-change",t.WINDOW_THEME_CHANGED="tauri://theme-changed",t.WINDOW_CREATED="tauri://window-created",t.WEBVIEW_CREATED="tauri://webview-created",t.DRAG_ENTER="tauri://drag-enter",t.DRAG_OVER="tauri://drag-over",t.DRAG_DROP="tauri://drag-drop",t.DRAG_LEAVE="tauri://drag-leave"})(y||(y={}));async function v(t,n){await c("plugin:event|unlisten",{event:t,eventId:n})}async function m(t,n,e){var s;let r=typeof e?.target=="string"?{kind:"AnyLabel",label:e.target}:(s=e?.target)!==null&&s!==void 0?s:{kind:"Any"};return c("plugin:event|listen",{event:t,target:r,handler:E(n)}).then(i=>async()=>v(t,i))}async function w(t,n,e){return m(t,s=>{v(t,s.id),n(s)},e)}async function T(t,n){await c("plugin:event|emit",{event:t,payload:n})}var l={async openInput(t){try{return{status:"ok",data:await c("plugin:midi|open_input",{id:t})}}catch(n){if(n instanceof Error)throw n;return{status:"error",error:n}}},async closeInput(t){await c("plugin:midi|close_input",{id:t})},async openOutput(t){try{return{status:"ok",data:await c("plugin:midi|open_output",{id:t})}}catch(n){if(n instanceof Error)throw n;return{status:"error",error:n}}},async closeOutput(t){await c("plugin:midi|close_output",{id:t})},async outputSend(t,n){try{return{status:"ok",data:await c("plugin:midi|output_send",{id:t,msg:n})}}catch(e){if(e instanceof Error)throw e;return{status:"error",error:e}}}},f=C({midiMessage:"plugin:midi:midi-message",stateChange:"plugin:midi:state-change"});function C(t){return new Proxy({},{get:(n,e)=>{let s=t[e];return new Proxy(()=>{},{apply:(r,i,[o])=>({listen:a=>o.listen(s,a),once:a=>o.once(s,a),emit:a=>o.emit(s,a)}),get:(r,i)=>{switch(i){case"listen":return o=>m(s,o);case"once":return o=>w(s,o);case"emit":return o=>T(s,o)}}})}})}var A,k=new Promise((t,n)=>{A=()=>t(void 0),setTimeout(()=>n(new Error("Failed to initialise WebMIDI")),1e4)}),M=[],D=[],p=new Set;f.stateChange.listen(t=>{let{inputs:n,outputs:e}=t.payload;M=n,D=e,A();for(let s of p)s.__tauri_statechange(n,e)});var u=class extends Event{constructor(n,e){super("statechange",e),this.port=e?.port||null}};globalThis.MIDIConnectionEvent=u;var h=class extends EventTarget{constructor(){super();this.sysexEnabled=!0;this.inputs=new Map;this.outputs=new Map;this.onstatechange=null;this.__tauri_statechange(M,D)}addEventListener(e,s,r){super.addEventListener(e,s,r)}removeEventListener(e,s,r){super.removeEventListener(e,s,r)}__tauri_statechange(e,s){let r=[];for(let[i,o]of this.inputs)e.find(([a,R])=>a===i)||(this.inputs.delete(i),o.state="disconnected",r.push(new u("disconnected",{port:o})));for(let[i,o]of this.outputs)s.find(([a,R])=>a===i)||(this.outputs.delete(i),o.state="disconnected",r.push(new u("disconnected",{port:o})));for(let[i,o]of e){if(this.inputs.has(i))continue;let a=new g(i,o);a.state="connected",this.inputs.set(i,a),r.push(new u("connected",{port:a}))}for(let[i,o]of s){if(this.outputs.has(i))continue;let a=new I(i,o);a.state="connected",this.outputs.set(i,a),r.push(new u("connected",{port:a}))}console.log("EMITTING",r),r.forEach(i=>this.dispatchEvent(i))}};globalThis.MIDIAccess=h;var d=class extends EventTarget{constructor(e,s,r){super();this.identifier=e;this.name=s;this.type=r;this.connection="closed";this.manufacturer=null;this.onstatechange=null;this.state="disconnected";this.version=null;this.id=e,this.name=s}async open(){if(this.connection==="open"||this.connection==="pending")return this;if(this.state==="disconnected"){this.connection="pending";for(let e of p)e.dispatchEvent(new Event("statechange"));return this.dispatchEvent(new Event("statechange")),this}this.type==="input"?await l.openInput(this.id):await l.openOutput(this.id),this.connection="open";for(let e of p)e.dispatchEvent(new Event("statechange"));return this.dispatchEvent(new Event("statechange")),this}async close(){if(this.connection==="closed")return this;this.type==="input"?await l.closeInput(this.id):await l.closeOutput(this.id),this.connection="closed";for(let e of p)e.dispatchEvent(new Event("statechange"));return this.dispatchEvent(new Event("statechange")),this}};globalThis.MIDIPort=d;var _=class extends Event{constructor(n,e){super(n,e),this.data=e?.data}};globalThis.MIDIMessageEvent=_;var g=class extends d{constructor(e,s){super(e,s,"input");this._onmidimessage=null;this.addEventListener("midimessage",r=>{this.onmidimessage&&this.onmidimessage(r)})}open(){return this.stopListening||(this.stopListening=f.midiMessage.listen(e=>{let[s,r]=e.payload;s===this.id&&this.dispatchEvent(new _("midimessage",{data:new Uint8Array(r)}))})),super.open()}close(){return this.stopListening?.then(e=>e()),super.close()}get onmidimessage(){return this._onmidimessage}set onmidimessage(e){this._onmidimessage=e,this.connection!=="open"&&this.open()}};globalThis.MIDIInput=g;var I=class extends d{constructor(n,e){super(n,e,"output")}send(n){if(this.state==="disconnected")throw new Error("MIDIOutput is disconnected");(this.state==="connected"&&this.connection==="closed"?this.open():Promise.resolve()).then(()=>l.outputSend(this.id,n))}};globalThis.MIDIOutput=I;navigator.requestMIDIAccess=()=>k.then(()=>{let t=new h;return p.add(t),t});})();
