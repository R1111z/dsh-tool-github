// Validate every command handler result against the real normalizeResult
// contract used by dsh-commands (kind: success|error + text).
import { apply } from "../lib/index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const registered = [];
const stored = new Map();
const testRoot = mkdtempSync(join(tmpdir(), "dsh-cmd-val-"));

const credentialsService = {
	async resolve(r) { const v = stored.get(r); return v === void 0 ? void 0 : { value: v, source: "file" }; },
	async describe(r) { return stored.has(r) ? { configured: true, source: "file", writable: true } : { configured: false, writable: true }; },
	async set(r, v) { stored.set(r, v); },
	async unset(r) { stored.delete(r); }
};
const workspaceRegistryService = { async create(p, t) { return {}; }, list() { return []; } };

const ctx = {
	systemPrompt: { section() {} },
	tools: { register(d) { registered.push(d); } },
	credentials: credentialsService,
	workspaceRegistry: workspaceRegistryService,
	get(name) {
		if (name === "credentials") return credentialsService;
		if (name === "workspaceRegistry") return workspaceRegistryService;
		return void 0;
	},
	commands: { register(d) { registered.push(d); } }
};

apply(ctx, { token: "", baseUrl: "https://api.github.com", timeoutMs: 30000, maxResults: 10, workspaceRoot: testRoot });

// Mirror of dsh-commands' normalizeResult strict validation.
function normalizeResult(command, value) {
	if (typeof value !== "object" || value === null || !("kind" in value)) throw new TypeError(`command "${command}" handler must return a CommandResult`);
	const result = value;
	if (result.kind === "success") {
		if (result.text !== void 0 && typeof result.text !== "string") throw new TypeError("success text must be string");
		return { kind: "success", text: result.text };
	}
	if (result.kind === "error") {
		if (typeof result.text !== "string" || result.text.trim().length === 0) throw new TypeError("error text must be non-empty");
		return { kind: "error", text: result.text };
	}
	throw new TypeError("unknown result kind");
}

const inv = (line) => ({ commandId: "t", agent: {}, rawInput: line, signal: new AbortController().signal });
let allOk = true;
for (const cmd of registered.filter((c) => c.handler)) {
	for (const line of ["", "  ", "github_pat_TEST", "octocat Hello-World"]) {
		try {
			const result = await cmd.handler(inv(line));
			normalizeResult(cmd.name, result);
		} catch (e) {
			allOk = false;
			console.log("VALIDATION FAIL:", cmd.name, JSON.stringify(line), "->", e.message);
		}
	}
}
console.log(allOk ? "ALL COMMAND RESULTS PASS normalizeResult CONTRACT ✅" : "FAILURES FOUND ❌");
process.exit(allOk ? 0 : 1);
