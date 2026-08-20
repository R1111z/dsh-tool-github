// Client bundle integration test: mount the bundle, verify the GitHub button
// and panel are created, and verify the panel's refresh path calls
// ctx.remote.commands.execute with the current session id and /github-status.
import fs from "node:fs";

const source = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const stripped = source.replace(/^window\.__ModuleLoader__\.load\(\{/, "globalThis.__ModuleLoader__.load({");

// DOM stub: nodes carry event listeners; the loader test drives refresh by
// directly invoking the stored click handler on the Refresh button.
const eventListeners = new Map();
function makeEl(tag) {
	const node = {
		tagName: tag, className: "", dataset: {}, hidden: false, innerHTML: "", textContent: "",
		title: "", type: "", children: [], style: { textContent: "" }, attributes: {},
		setAttribute(k, v) { this.attributes[k] = v; },
		append(...nodes) { this.children.push(...nodes); },
		replaceChildren() { this.children = []; },
		remove() { this.removed = true; },
		addEventListener(type, fn) {
			const set = eventListeners.get(this) ?? new Map();
			set.set(type, fn);
			eventListeners.set(this, set);
		},
		querySelector() { return null; }
	};
	return node;
}
const documentStub = {
	createElement: (tag) => makeEl(tag),
	head: makeEl("head"),
	body: makeEl("body"),
	querySelector: (sel) => {
		// Simulate the real GUI DOM: a sidebar with a settings slot.
		if (sel === "[data-pane='sidebar']") return globalThis.__sidebar;
		if (sel === "[class*='sidebarCol']") return null;
		if (sel === "[data-slot='sidebar.settings']") return globalThis.__sidebarSettings;
		return null;
	}
};
class MutationObserverStub {
	constructor(fn) { this.fn = fn; MutationObserverStub.last = this; }
	observe() {}
	disconnect() {}
}

const wrapper = [
	"const window = globalThis;",
	"const eventListeners = new Map();",
	"globalThis.__eventListeners = eventListeners;",
	`function makeEl(tag) {
		const node = {
			tagName: tag, className: "", dataset: {}, hidden: false, innerHTML: "", textContent: "",
			title: "", type: "", value: "", children: [], style: { textContent: "" }, attributes: {},
			autocomplete: "", spellcheck: false, disabled: false,
			setAttribute(k, v) { this.attributes[k] = v; },
			append(...nodes) { this.children.push(...nodes); },
			replaceChildren() { this.children = []; },
			remove() { this.removed = true; },
			addEventListener(type, fn) { const set = globalThis.__eventListeners.get(this) ?? new Map(); set.set(type, fn); globalThis.__eventListeners.set(this, set); },
			querySelector() { return null; },
			focus() {}
		};
		return node;
	}`,
	"const documentStub = { createElement: (tag) => makeEl(tag), head: makeEl('head'), body: makeEl('body'), querySelector: (sel) => { if (sel === \"[data-pane='sidebar']\") return globalThis.__sidebar; if (sel === \"[class*='sidebarCol']\") return null; if (sel === \"[data-slot='sidebar.settings']\") return globalThis.__sidebarSettings; return null; } };",
	"const sidebar = makeEl('aside'); sidebar.dataset['pane'] = 'sidebar'; sidebar.closest = () => null;",
	"const settingsSlot = makeEl('div'); settingsSlot.dataset['slot'] = 'sidebar.settings'; settingsSlot.parentElement = sidebar;",
	"sidebar.children.push(settingsSlot);",
	"globalThis.__sidebar = sidebar;",
	"globalThis.__sidebarSettings = settingsSlot;",
	"class MutationObserverStub { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} }",
	"globalThis.document = documentStub;",
	"globalThis.MutationObserver = MutationObserverStub;",
	"globalThis.__ModuleLoader__ = { load: (o) => { globalThis.__clientModule = o.factory((id) => { throw new Error('unexpected require: ' + id); }); } };",
	"globalThis.__documentStub = documentStub;",
	stripped
].join("\n");

fs.writeFileSync(new URL("./client-int.mjs", import.meta.url), wrapper, "utf8");
await import("./client-int.mjs");
const loaded = globalThis.__clientModule;
const doc = globalThis.__documentStub;

console.log("inject:", JSON.stringify(loaded.inject));

const calls = [];
const fakeCtx = {
	remote: {
		commands: {
			async execute(sessionId, line) {
				calls.push({ sessionId, line });
				let text;
				if (line === "/github-my-repos") {
					text = "Repositories of @NEAZ71eve:\n- NEAZ71eve/bigdata-interview-bank [public] (0★, HTML) — data\n- NEAZ71eve/Feishu [public] (1★, Python) — feishu\n- NEAZ71eve/web_display [public] (0★, TypeScript) — web";
				} else {
					text = `result-of: ${line}`;
				}
				return { ok: true, value: { result: { text } } };
			}
		}
	},
	sessions: {
		list: {
			getSnapshot: () => ({ ids: ["s1", "s2"], byId: {}, current: "s1", phase: "ready" })
		}
	}
};

const disposer = loaded.apply(fakeCtx);

// Inspect what apply mounted: style in head, panel in body, button in sidebar.
const style = doc.head.children.find((el) => el.dataset?.plugin === "dsh-tool-github");
const panel = doc.body.children.find((el) => el.className === "dsh-github-panel");
const sidebar = globalThis.__sidebar;
const railButton = sidebar?.children.find((el) => el.className === "dsh-github-rail-button");
console.log("style injected:", !!style);
console.log("panel injected:", !!panel, panel ? `hidden=${panel.hidden}` : "");
console.log("rail button mounted in sidebar:", !!railButton);

// Drive refresh: find the Refresh button inside the panel's actions row.
const sharedListeners = globalThis.__eventListeners;
if (panel) {
	console.log("panel children:", panel.children.map((c) => `${c.className || c.tagName}[${c.children?.length ?? 0}]`).join(", "));
	const actions = panel.children.at(-1);
	console.log("actions children:", actions?.children.map((c) => `"${c.textContent}"`).join(", "));
	const refreshBtn = actions?.children.find((b) => b.textContent === "Refresh");
	if (refreshBtn) {
		console.log("refreshBtn found; listeners:", [...(sharedListeners.get(refreshBtn)?.keys() ?? [])]);
		const fn = sharedListeners.get(refreshBtn)?.get("click");
		await fn?.();
	}
}
await new Promise((r) => setTimeout(r, 10));
console.log("command calls:", JSON.stringify(calls));

// Test the inline Bind form: click "Bind account…", fill the input, submit.
let ok = calls.length === 1 && calls[0].sessionId === "s1" && calls[0].line === "/github-status";
if (panel) {
	const actions = panel.children.at(-1);
	const bindBtn = actions?.children.find((b) => b.textContent === "Bind account…");
	if (bindBtn) {
		const bindClick = sharedListeners.get(bindBtn)?.get("click");
		await bindClick?.();
		await new Promise((r) => setTimeout(r, 10));
		// body now contains the form: input + submit + back
		const body = panel.children.find((c) => c.className === "dsh-github-panel-body");
		console.log("body children after bind click:", body?.children.map((c) => c.className || c.tagName).join(", "));
		const formRow = body?.children.find((c) => c.className === "dsh-github-panel-form");
		console.log("form row children:", formRow?.children.map((c) => c.className || c.tagName).join(", "));
		const input = formRow?.children.find((c) => c.className === "dsh-github-panel-input");
		const submit = formRow?.children.find((c) => c.className === "dsh-github-panel-submit");
		console.log("bind form mounted:", !!input && !!submit);
		if (input && submit) {
			input.value = "github_pat_TESTTOKEN";
			const submitClick = sharedListeners.get(submit)?.get("click");
			await submitClick?.();
			await new Promise((r) => setTimeout(r, 10));
		}
	}
}
console.log("command calls after bind:", JSON.stringify(calls));
ok = ok && calls.some((c) => c.line === "/github-bind github_pat_TESTTOKEN");

// Test the "My repos" list view: click, wait for list render, click a repo.
if (panel) {
	const actions = panel.children.at(-1);
	const myReposBtn = actions?.children.find((b) => b.textContent === "My repos");
	if (myReposBtn) {
		const reposClick = sharedListeners.get(myReposBtn)?.get("click");
		await reposClick?.();
		await new Promise((r) => setTimeout(r, 30));
		const body = panel.children.find((c) => c.className === "dsh-github-panel-body");
		console.log("body children after repos click:", body?.children.map((c) => c.className || c.tagName).join(", "));
		const listEl = body?.children.find((c) => c.className === "dsh-github-panel-list");
		const repoRows = listEl?.children ?? [];
		console.log("repo rows rendered:", repoRows?.length ?? 0);
		if (repoRows && repoRows.length > 0) {
			const name = repoRows[0].children[0]?.textContent;
			console.log("first repo:", name);
			const repoClick = sharedListeners.get(repoRows[0])?.get("click");
			await repoClick?.();
			await new Promise((r) => setTimeout(r, 10));
		}
	}
}
console.log("command calls after repos:", JSON.stringify(calls));
ok = ok && calls.some((c) => c.line === "/github-workspace-add NEAZ71eve bigdata-interview-bank");
console.log("CLIENT INTEGRATION", ok ? "OK" : "FAILED");
disposer?.();
process.exit(ok ? 0 : 1);
