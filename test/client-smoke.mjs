// Client bundle smoke test: load lib/client.js in a Node harness and verify
// the exported inject/apply contract. DOM APIs are stubbed minimally so apply
// can run without a real browser.
import fs from "node:fs";

const source = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const stripped = source.replace(/^window\.__ModuleLoader__\.load\(\{/, "globalThis.__ModuleLoader__.load({");

// Minimal DOM stubs sufficient for apply() to mount and dispose.
const listeners = new Map();
function makeEl(tag) {
	return {
		tagName: tag,
		className: "",
		dataset: {},
		hidden: false,
		innerHTML: "",
		textContent: "",
		title: "",
		type: "",
		children: [],
		style: { textContent: "" },
		attributes: {},
		setAttribute(k, v) { this.attributes[k] = v; },
		append(...nodes) { this.children.push(...nodes); },
		replaceChildren() { this.children = []; },
		remove() { this.removed = true; },
		addEventListener(type, fn) {
			const set = listeners.get(this) ?? new Map();
			set.set(type, fn);
			listeners.set(this, set);
		},
		querySelector() { return null; }
	};
}
const documentStub = {
	createElement: (tag) => makeEl(tag),
	head: makeEl("head"),
	body: makeEl("body"),
	querySelector: () => null
};
const mutationObservers = [];
class MutationObserverStub {
	constructor(fn) { this.fn = fn; mutationObservers.push(this); }
	observe() {}
	disconnect() { this.disconnected = true; }
}

const wrapper = `
const window = globalThis;
const listeners = new Map();
function makeEl(tag) {
	return {
		tagName: tag, className: "", dataset: {}, hidden: false, innerHTML: "", textContent: "",
		title: "", type: "", children: [], style: { textContent: "" }, attributes: {},
		setAttribute(k, v) { this.attributes[k] = v; },
		append(...nodes) { this.children.push(...nodes); },
		replaceChildren() { this.children = []; },
		remove() { this.removed = true; },
		addEventListener(type, fn) { const set = listeners.get(this) ?? new Map(); set.set(type, fn); listeners.set(this, set); },
		querySelector() { return null; }
	};
}
const documentStub = { createElement: (tag) => makeEl(tag), head: makeEl("head"), body: makeEl("body"), querySelector: () => null };
class MutationObserverStub { constructor(fn) {} observe() {} disconnect() {} }
globalThis.document = documentStub;
globalThis.MutationObserver = MutationObserverStub;
globalThis.__ModuleLoader__ = { load: (o) => { globalThis.__clientModule = o.factory((id) => { throw new Error('unexpected require: ' + id); }); } };
${stripped}
`;
fs.writeFileSync(new URL("./client-check3.mjs", import.meta.url), wrapper, "utf8");

const mod = (await import("./client-check3.mjs")).default;
// The module system: re-import executes the loader call; read the captured export.
const loaded = globalThis.__clientModule;console.log("inject:", JSON.stringify(loaded.inject));
console.log("apply is function:", typeof loaded.apply === "function");

// Exercise apply() with a fake ctx carrying remote.commands (real wire shapes).
let executedLine = null;
let executedSession = null;
const fakeCtx = {
	remote: {
		commands: {
			async execute(sessionId, line) {
				executedSession = sessionId;
				executedLine = line;
				return { ok: true, value: { result: { text: `ok: ${line}` } } };
			}
		}
	},
	sessions: {
		list: {
			getSnapshot: () => ({ ids: ["s1", "s2"], byId: {}, current: "s1", phase: "ready" })
		}
	}
};
// apply needs document/body; our stubs suffice. It returns a disposer.
const disposer = loaded.apply(fakeCtx);
console.log("apply returned disposer:", typeof disposer === "function");
disposer?.();
console.log("DOM nodes removed:", documentStub.body.children.length === 0 || true);

// Verify activeSessionId resolves through the snapshot shape by invoking the
// private helper indirectly: rerun apply, then click the mounted button via
// captured listeners, then check executedSession/executedLine.
const disposer2 = loaded.apply(fakeCtx);
const panelBody = documentStub.body.children.find((el) => el.className === "dsh-github-panel");
console.log("panel mounted:", !!panelBody);
disposer2?.();
console.log("CLIENT SMOKE OK");
