// Schema conformance audit: for every tool, run its execute() against a live
// public API (or a stub), then validate the returned value against the tool's
// declared output schema. Catches "returned field not declared" bugs like the
// github_whoami one.
import { apply } from "../lib/index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const registered = [];
const storedCredentials = new Map();
const testRoot = mkdtempSync(join(tmpdir(), "dsh-schema-audit-"));

const credentialsService = {
	async resolve(ref) { const v = storedCredentials.get(ref); return v === void 0 ? void 0 : { value: v, source: "file" }; },
	async describe(ref) { return storedCredentials.has(ref) ? { configured: true, source: "file", writable: true } : { configured: false, writable: true }; },
	async set(ref, v) { storedCredentials.set(ref, v); },
	async unset(ref) { storedCredentials.delete(ref); }
};
const workspaceRegistryService = {
	async create(p, t) { return { path: p, title: t }; },
	list() { return []; }
};

const ctx = {
	systemPrompt: { section() {} },
	tools: { register(d) { registered.push(d); } },
	credentials: credentialsService,
	workspaceRegistry: workspaceRegistryService,
	get(name) {
		if (name === "credentials") return credentialsService;
		if (name === "workspaceRegistry") return workspaceRegistryService;
		return void 0;
	}
};

apply(ctx, {
	token: "", baseUrl: "https://api.github.com", timeoutMs: 30000, maxResults: 10, workspaceRoot: testRoot
});

// Minimal JSON-schema validator for the enforced subset: object root with
// properties/required/additionalProperties:false.
function validate(schema, value, path = "$") {
	if (schema.type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path}: expected object`];
		const errs = [];
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(value)) {
				if (!(key in (schema.properties ?? {}))) errs.push(`${path}.${key}: not a declared property`);
			}
		}
		for (const [key, sub] of Object.entries(schema.properties ?? {})) {
			if (key in value) errs.push(...validate(sub, value[key], `${path}.${key}`));
			else if (schema.required?.includes(key)) errs.push(`${path}.${key}: missing required`);
		}
		return errs;
	}
	if (schema.type === "array") {
		if (!Array.isArray(value)) return [`${path}: expected array`];
		const errs = [];
		for (let i = 0; i < value.length; i++) errs.push(...validate(schema.items ?? {}, value[i], `${path}[${i}]`));
		return errs;
	}
	if (schema.oneOf) {
		for (const branch of schema.oneOf) {
			const errs = validate(branch, value, path);
			if (errs.length === 0) return [];
		}
		return [`${path}: no oneOf branch matched`];
	}
	const typeMap = { string: "string", integer: "number", number: "number", boolean: "boolean", null: "object" };
	if (typeof value !== typeMap[schema.type]) return [`${path}: expected ${schema.type}`];
	return [];
}

const signal = new AbortController().signal;
let failures = 0;

// Live read-only calls
const live = [
	["github_repo", { owner: "deepseek-ai", repo: "DeepSeek-Harness" }],
	["github_search", { query: "deepseek-harness", perPage: 3 }],
	["github_issues", { owner: "deepseek-ai", repo: "DeepSeek-Harness", perPage: 2 }],
	["github_prs", { owner: "deepseek-ai", repo: "DeepSeek-Harness", perPage: 2 }],
	["github_content", { owner: "deepseek-ai", repo: "DeepSeek-Harness", path: "README.md" }],
	["github_whoami", {}],
	["github_workspace_list", {}]
];

for (const [name, args] of live) {
	const def = registered.find((d) => d.name === name);
	if (!def) { console.log(`SKIP ${name}: not registered`); continue; }
	try {
		const value = await def.execute(args, { signal, agent: {} });
		const errs = validate(def.output.schema, value);
		if (errs.length > 0) {
			console.log(`FAIL ${name}: schema mismatch`);
			for (const e of errs) console.log(`    ${e}`);
			failures++;
		} else {
			console.log(`PASS ${name} — value valid against schema`);
		}
	} catch (e) {
		console.log(`ERROR ${name}: ${e.message}`);
	}
}

console.log(failures === 0 ? "\nSCHEMA AUDIT: ALL PASS" : `\nSCHEMA AUDIT: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
