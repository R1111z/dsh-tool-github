// Self-test: load the plugin with a mock ctx and verify tool registration.
import { apply, Config, name, inject } from "../lib/index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testWorkspaceRoot = mkdtempSync(join(tmpdir(), "dsh-github-test-"));

const registered = [];
const storedCredentials = new Map();
const workspaces = [];

const credentialsService = {
	async resolve(ref) {
		const value = storedCredentials.get(ref);
		return value === void 0 ? void 0 : { value, source: "file" };
	},
	async describe(ref) {
		const value = storedCredentials.get(ref);
		return value === void 0 ? { configured: false, writable: true } : { configured: true, source: "file", writable: true };
	},
	async set(ref, value) {
		storedCredentials.set(ref, value);
	},
	async unset(ref) {
		storedCredentials.delete(ref);
	}
};
const workspaceRegistryService = {
	async create(path, title) {
		workspaces.push({ path, title });
		return { path, title };
	},
	list() {
		return workspaces.map((ws, i) => ({ id: String(i), path: ws.path, title: ws.title }));
	}
};

const ctx = {
	systemPrompt: {
		section(entry) {
			console.log(`[prompt section] ${entry.name} order=${entry.order}`);
		}
	},
	tools: {
		register(def) {
			registered.push(def);
		}
	},
	credentials: credentialsService,
	workspaceRegistry: workspaceRegistryService,
	get(name) {
		if (name === "credentials") return credentialsService;
		if (name === "workspaceRegistry") return workspaceRegistryService;
		return void 0;
	}
};

console.log(`plugin name: ${name}`);
console.log(`inject: ${inject.join(", ")}`);
console.log(`config keys: ${Object.keys(Config.dict ?? {}).join(", ")}`);

apply(ctx, {
	token: "",
	baseUrl: "https://api.github.com",
	timeoutMs: 30000,
	maxResults: 10,
	workspaceRoot: testWorkspaceRoot
});

console.log(`\nregistered ${registered.length} tools:`);
for (const def of registered) {
	console.log(`- ${def.name} | timeout=${def.timeoutMs} | concurrencySafe=${def.isConcurrencySafe ? "yes" : "no"}`);
	const compiled = def.parameters ?? {};
	const props = compiled.properties ?? {};
	const required = Array.isArray(compiled.required) ? compiled.required : [];
	console.log(`    compiled params: ${Object.keys(props).join(", ")} (required: ${required.join(", ") || "none"})`);
}

// Validate output schema shape sanity for each tool
for (const def of registered) {
	const schema = def.output?.schema;
	if (!schema || schema.type !== "object") {
		console.log(`!! ${def.name}: output schema missing or not object`);
		process.exitCode = 1;
	}
}

// --- Account binding flow (mock, no network) ---
const bindDef = registered.find((d) => d.name === "github_bind");
if (bindDef) {
	console.log(`\n[UNIT] github_bind defined with params: ${Object.keys((bindDef.parameters ?? {}).properties ?? {}).join(", ")}`);
}
const whoamiDef = registered.find((d) => d.name === "github_whoami");
if (whoamiDef) {
	const result = await whoamiDef.execute({}, { signal: new AbortController().signal });
	console.log(`[UNIT] github_whoami with no token: authenticated=${result.authenticated} source=${result.source}`);
}
const unbindDef = registered.find((d) => d.name === "github_unbind");
if (unbindDef) {
	const result = await unbindDef.execute({}, { signal: new AbortController().signal });
	console.log(`[UNIT] github_unbind with no token: removed=${result.removed} source=${result.source}`);
}

// --- Workspace list (no clones yet) ---
const wsListDef = registered.find((d) => d.name === "github_workspace_list");
if (wsListDef) {
	const result = await wsListDef.execute({}, { signal: new AbortController().signal });
	console.log(`[UNIT] github_workspace_list: ${result.workspaces.length} workspace(s)`);
}

// --- Live read-only API call ---
const repoDef = registered.find((d) => d.name === "github_repo");
if (repoDef) {
	try {
		const result = await repoDef.execute({ owner: "deepseek-ai", repo: "DeepSeek-Harness" }, { signal: new AbortController().signal });
		console.log(`\n[LIVE] github_repo OK: ${result.fullName} stars=${result.stars} defaultBranch=${result.defaultBranch}`);
	} catch (error) {
		console.log(`\n[LIVE] github_repo failed (network may be blocked): ${error.message}`);
	}
}

console.log("\nSelf-test complete.");
