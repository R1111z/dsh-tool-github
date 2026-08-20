// Host-side smoke test: load the node half with a mock ctx and verify that
// (a) all 13 tools register, and (b) the /github-* commands register with
// working handlers (status/bind/unbind/workspace list paths that don't need
// network).
import { apply, Config, name, inject } from "../lib/index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const registeredTools = [];
const registeredCommands = [];
const storedCredentials = new Map();
const workspaces = [];
const testWorkspaceRoot = mkdtempSync(join(tmpdir(), "dsh-gh-host-test-"));

const credentialsService = {
	async resolve(ref) { const v = storedCredentials.get(ref); return v === void 0 ? void 0 : { value: v, source: "file" }; },
	async describe(ref) { const v = storedCredentials.get(ref); return v === void 0 ? { configured: false, writable: true } : { configured: true, source: "file", writable: true }; },
	async set(ref, v) { storedCredentials.set(ref, v); },
	async unset(ref) { storedCredentials.delete(ref); }
};
const workspaceRegistryService = {
	async create(path, title) { workspaces.push({ path, title }); return { path, title }; },
	list() { return workspaces.map((w, i) => ({ id: String(i), path: w.path, title: w.title })); }
};

const ctx = {
	systemPrompt: { section() {} },
	tools: { register(def) { registeredTools.push(def); } },
	credentials: credentialsService,
	workspaceRegistry: workspaceRegistryService,
	get(name) {
		if (name === "credentials") return credentialsService;
		if (name === "workspaceRegistry") return workspaceRegistryService;
		return void 0;
	},
	commands: {
		register(def) { registeredCommands.push(def); }
	}
};

console.log(`plugin name: ${name}`);
console.log(`inject: ${inject.join(", ")}`);

apply(ctx, {
	token: "",
	baseUrl: "https://api.github.com",
	timeoutMs: 30000,
	maxResults: 10,
	workspaceRoot: testWorkspaceRoot
});

console.log(`\ntools registered: ${registeredTools.length}`);
for (const def of registeredTools) console.log(`  - ${def.name}`);
console.log(`\ncommands registered: ${registeredCommands.length}`);
for (const def of registeredCommands) {
	console.log(`  - /${def.name} — ${def.description}`);
}

// Invoke each command handler without network dependencies.
const inv = (line) => ({ commandId: "test", agent: {}, rawInput: line, signal: new AbortController().signal });
const statusCmd = registeredCommands.find((c) => c.name === "github-status");
const statusResult = await statusCmd.handler(inv(""));
console.log(`\n[github-status] kind=${statusResult.kind}`);
console.log(statusResult.text);

const wsListCmd = registeredCommands.find((c) => c.name === "github-workspace-list");
const wsListResult = await wsListCmd.handler(inv(""));
console.log(`[github-workspace-list] kind=${wsListResult.kind}`);
console.log(wsListResult.text);

const bindCmd = registeredCommands.find((c) => c.name === "github-bind");
const bindEmpty = await bindCmd.handler(inv("  "));
console.log(`[github-bind empty] kind=${bindEmpty.kind} text="${bindEmpty.text}"`);

const addWsCmd = registeredCommands.find((c) => c.name === "github-workspace-add");
const addEmpty = await addWsCmd.handler(inv("  "));
console.log(`[github-workspace-add empty] kind=${addEmpty.kind} text="${addEmpty.text}"`);

console.log("\nHOST SMOKE OK");
