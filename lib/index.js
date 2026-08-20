import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

/**
 * Run a command without capturing output, resolving on exit code 0.
 * Uses `stdio: 'ignore'` so it works even where pipe-based stdio is denied
 * (constrained sandboxes); failures surface as thrown Errors with the code.
 */
function runCommand(command, args, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { ...options, stdio: "ignore" });
		const onError = (error) => {
			child.kill();
			reject(error);
		};
		child.once("error", onError);
		child.once("exit", (code) => {
			child.removeListener("error", onError);
			if (code === 0) resolve(void 0);
			else reject(new Error(`${command} exited with code ${code}`));
		});
	});
}

/**
 * dsh-tool-github: model-facing GitHub REST API tools for DeepSeek Harness.
 *
 * Registers `github_*` tools on `ctx.tools` that call the GitHub REST API
 * through Node's global fetch. Authentication comes from the credential seam
 * (`GITHUB_TOKEN` reference stored via `github_bind`), the plugin config
 * `token`, or the `GITHUB_TOKEN` environment variable; without a token the
 * tools operate anonymously (rate-limited) for public data.
 *
 * Account binding persists the token through `ctx.get("credentials")` so the Models
 * page and `github_bind` share one secret source; workspace integration
 * clones a repository into `~/.dsh/github-workspaces` and registers it with
 * `ctx.get("workspaceRegistry")` so it appears in the workspace picker.
 *
 * @module dsh-tool-github
 */
const name = "tool-github";
const inject = ["tools", "systemPrompt", "credentials", "commands"];

/** The credential reference this plugin binds a GitHub token to. */
const GITHUB_TOKEN_REF = "GITHUB_TOKEN";

/** Default local root where GitHub repos are cloned as workspaces. */
function defaultWorkspaceRoot() {
	return join(homedir(), ".dsh", "github-workspaces");
}

/** Sanitize a repo name for use as a directory segment. */
function safeSegment(value) {
	return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** Schemastery configuration: token, API base URL, timeout, result caps, and workspace root. */
const Config = z.object({
	token: z.string().default(""),
	baseUrl: z.string().default("https://api.github.com"),
	timeoutMs: z.number().default(3e4),
	maxResults: z.number().default(10),
	workspaceRoot: z.string().default("")
});

/**
 * Resolve the effective GitHub token: credential seam (bound account) first,
 * then plugin config `token`, then the `GITHUB_TOKEN` environment variable.
 */
async function resolveToken(ctx, config) {
	if (ctx.get("credentials") !== void 0) {
		const hit = await ctx.get("credentials").resolve(credentialRef(GITHUB_TOKEN_REF));
		if (hit !== void 0 && hit.value.length > 0) return hit.value;
	}
	if (config.token.length > 0) return config.token;
	return process.env.GITHUB_TOKEN ?? "";
}

/** Describe the token source for the bound-account tool, without revealing the value. */
async function describeToken(ctx, config) {
	if (ctx.get("credentials") !== void 0) {
		const info = await ctx.get("credentials").describe(credentialRef(GITHUB_TOKEN_REF));
		if (info !== void 0 && info.configured) return info.source ?? "credential-store";
	}
	if (config.token.length > 0) return "plugin-config";
	if (process.env.GITHUB_TOKEN !== void 0 && process.env.GITHUB_TOKEN.length > 0) return "environment";
	return "none";
}

/** Assert positive integer config fields. */
function assertPositiveInteger(name, value) {
	if (!Number.isInteger(value) || value < 1) throw new Error(`tool-github: ${name} must be a positive integer`);
}

/**
 * One GitHub REST API request. Returns the parsed JSON body for 2xx; throws a
 * structured Error carrying the GitHub message and status for errors.
 */
async function ghRequest(baseUrl, token, pathname, options, signal) {
	const url = `${baseUrl.replace(/\/+$/, "")}${pathname}`;
	const headers = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28"
	};
	if (token.length > 0) headers.Authorization = `Bearer ${token}`;
	if (options?.body !== void 0) headers["Content-Type"] = "application/json";
	const response = await fetch(url, {
		method: options?.method ?? "GET",
		headers,
		body: options?.body !== void 0 ? JSON.stringify(options.body) : void 0,
		signal
	});
	const text = await response.text();
	let data;
	try {
		data = text.length > 0 ? JSON.parse(text) : {};
	} catch {
		data = { message: text };
	}
	if (!response.ok) {
		const message = typeof data.message === "string" ? data.message : `GitHub API error (HTTP ${response.status})`;
		throw new Error(`${message} (HTTP ${response.status})`);
	}
	return data;
}

/** Build a query string from a record of string/number values, skipping blanks. */
function toQuery(params) {
	const parts = [];
	for (const [key, value] of Object.entries(params)) {
		if (value === void 0 || value === null || value === "") continue;
		parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
	}
	return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/** Project a GitHub search/repo/issue/PR item into a stable plain record. */
function projectRepo(repo) {
	return {
		fullName: repo.full_name ?? "",
		description: repo.description ?? "",
		htmlUrl: repo.html_url ?? "",
		stars: repo.stargazers_count ?? 0,
		forks: repo.forks_count ?? 0,
		openIssues: repo.open_issues_count ?? 0,
		language: repo.language ?? "",
		license: repo.license?.spdx_id ?? "",
		defaultBranch: repo.default_branch ?? "",
		updatedAt: repo.updated_at ?? "",
		pushedAt: repo.pushed_at ?? "",
		topics: Array.isArray(repo.topics) ? repo.topics : []
	};
}

function projectIssue(issue) {
	return {
		number: issue.number ?? 0,
		title: issue.title ?? "",
		state: issue.state ?? "",
		htmlUrl: issue.html_url ?? "",
		labels: Array.isArray(issue.labels) ? issue.labels.map((label) => typeof label === "string" ? label : label.name ?? "") : [],
		user: issue.user?.login ?? "",
		createdAt: issue.created_at ?? "",
		updatedAt: issue.updated_at ?? "",
		comments: issue.comments ?? 0,
		body: (issue.body ?? "").slice(0, 2000)
	};
}

function projectPr(pr) {
	return {
		number: pr.number ?? 0,
		title: pr.title ?? "",
		state: pr.state ?? "",
		htmlUrl: pr.html_url ?? "",
		user: pr.user?.login ?? "",
		createdAt: pr.created_at ?? "",
		updatedAt: pr.updated_at ?? "",
		headRef: pr.head?.ref ?? "",
		baseRef: pr.base?.ref ?? "",
		merged: pr.merged ?? false,
		draft: pr.draft ?? false,
		body: (pr.body ?? "").slice(0, 2000)
	};
}

function projectContentItem(item) {
	return {
		name: item.name ?? "",
		path: item.path ?? "",
		type: item.type ?? "",
		size: item.size ?? 0,
		downloadUrl: item.download_url ?? ""
	};
}

/** Register the github_repo tool: repository metadata. */
function applyRepoTool(ctx, config) {
	ctx.tools.register(defineTool({
		name: "github_repo",
		description: "Get metadata for a GitHub repository (owner/repo): description, stars, forks, language, license, default branch, topics, and recent activity. Use when the user asks about a specific repository or wants repository details.",
		parameters: {
			owner: {
				type: "string",
				required: true,
				description: "Repository owner (user or organization)."
			},
			repo: {
				type: "string",
				required: true,
				description: "Repository name."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					fullName: { type: "string", required: true },
					description: { type: "string", required: true },
					htmlUrl: { type: "string", required: true },
					stars: { type: "integer", required: true },
					forks: { type: "integer", required: true },
					openIssues: { type: "integer", required: true },
					language: { type: "string", required: true },
					license: { type: "string", required: true },
					defaultBranch: { type: "string", required: true },
					updatedAt: { type: "string", required: true },
					pushedAt: { type: "string", required: true },
					topics: { type: "array", required: true, items: { type: "string" } }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: [
					`# ${value.fullName}`,
					value.description.length > 0 ? value.description : "",
					`- Stars: ${value.stars} · Forks: ${value.forks} · Open issues: ${value.openIssues}`,
					`- Language: ${value.language || "n/a"} · License: ${value.license || "n/a"}`,
					`- Default branch: ${value.defaultBranch}`,
					`- Updated: ${value.updatedAt} · Pushed: ${value.pushedAt}`,
					value.topics.length > 0 ? `- Topics: ${value.topics.join(", ")}` : "",
					`- ${value.htmlUrl}`
				].filter((line) => line.length > 0).join("\n")
			}]
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			return projectRepo(await ghRequest(config.baseUrl, resolveToken(ctx, config), `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}`, void 0, exec.signal));
		},
		presentCall: (args) => ({
			card: "generic",
			title: `${args.owner}/${args.repo}`,
			kind: "other",
			rawInput: `${args.owner}/${args.repo}`
		})
	}));
}

/** Register the github_search tool: search repositories, code, or issues. */
function applySearchTool(ctx, config) {
	ctx.tools.register(defineTool({
		name: "github_search",
		description: "Search GitHub for repositories, code, or issues. Returns the top matching items with metadata. Use when the user wants to find repositories, code snippets, or open issues on GitHub.",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "Search query, e.g. \"llm agent\", \"language:python stars:>100\", or \"repo:owner/name bug\"."
			},
			type: {
				type: "string",
				enum: ["repositories", "code", "issues"],
				description: "What to search: repositories (default), code, or issues."
			},
			sort: {
				type: "string",
				description: "Sort order: stars, forks, updated (repositories); best-match is default."
			},
			perPage: {
				type: "integer",
				description: "Max results, capped at the deployment maximum."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					totalCount: { type: "integer", required: true },
					items: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								fullName: { type: "string", required: true },
								description: { type: "string", required: true },
								htmlUrl: { type: "string", required: true },
								stars: { type: "integer", required: true },
								language: { type: "string", required: true }
							}
						}
					},
					truncated: { type: "boolean", required: true }
				}
			},
			render: (_args, value) => {
				const lines = [`Found ${value.totalCount} result(s).`];
				for (const item of value.items) {
					lines.push(`- **${item.fullName}** (${item.stars}★, ${item.language || "n/a"}) — ${item.description || "no description"} ${item.htmlUrl}`);
				}
				if (value.truncated) lines.push(`(Showing the first ${value.items.length} results. Refine the query for more.)`);
				return [{ type: "text", text: lines.join("\n") }];
			}
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const type = args.type ?? "repositories";
			const max = Math.min(args.perPage ?? config.maxResults, config.maxResults);
			const sort = args.sort ?? "";
			const params = { q: args.query, per_page: max };
			if (type === "repositories" && sort.length > 0) params.sort = sort;
			const endpoint = type === "issues" ? "/search/issues" : type === "code" ? "/search/code" : "/search/repositories";
			const data = await ghRequest(config.baseUrl, resolveToken(ctx, config), `${endpoint}${toQuery(params)}`, void 0, exec.signal);
			const items = (data.items ?? []).slice(0, max).map((item) => ({
				fullName: type === "issues" ? `${item.repository?.full_name ?? ""}#${item.number ?? ""}` : (item.full_name ?? item.name ?? ""),
				description: type === "issues" ? `${item.title ?? ""} [${item.state ?? ""}] ${item.html_url ?? ""}` : (item.description ?? ""),
				htmlUrl: item.html_url ?? "",
				stars: item.stargazers_count ?? 0,
				language: item.language ?? ""
			}));
			return {
				totalCount: data.total_count ?? items.length,
				items,
				truncated: (data.total_count ?? items.length) > items.length
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: args.query,
			kind: "search",
			rawInput: args.query
		})
	}));
}

/** Register the github_issues tool: list repository issues. */
function applyIssuesTool(ctx, config) {
	ctx.tools.register(defineTool({
		name: "github_issues",
		description: "List issues for a GitHub repository, optionally filtered by state and labels. Use when the user wants to see open/closed issues or track issue state in a repository.",
		parameters: {
			owner: {
				type: "string",
				required: true,
				description: "Repository owner."
			},
			repo: {
				type: "string",
				required: true,
				description: "Repository name."
			},
			state: {
				type: "string",
				enum: ["open", "closed", "all"],
				description: "Issue state filter (default: open)."
			},
			labels: {
				type: "string",
				description: "Comma-separated label filter, e.g. \"bug,help wanted\"."
			},
			perPage: {
				type: "integer",
				description: "Max results, capped at the deployment maximum."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					issues: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								number: { type: "integer", required: true },
								title: { type: "string", required: true },
								state: { type: "string", required: true },
								htmlUrl: { type: "string", required: true },
								labels: { type: "array", required: true, items: { type: "string" } },
								user: { type: "string", required: true },
								createdAt: { type: "string", required: true },
								comments: { type: "integer", required: true },
								body: { type: "string", required: true }
							}
						}
					},
					truncated: { type: "boolean", required: true }
				}
			},
			render: (_args, value) => {
				if (value.issues.length === 0) return [{ type: "text", text: "No issues found." }];
				const lines = value.issues.map((issue) => `- #${issue.number} [${issue.state}] ${issue.title} (${issue.labels.join(", ") || "no labels"}) — @${issue.user} ${issue.htmlUrl}`);
				if (value.truncated) lines.push(`(Showing the first ${value.issues.length} issues. Narrow the filters for more.)`);
				return [{ type: "text", text: lines.join("\n") }];
			}
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const max = Math.min(args.perPage ?? config.maxResults, config.maxResults);
			const params = {
				state: args.state ?? "open",
				labels: args.labels ?? "",
				per_page: max
			};
			const data = await ghRequest(config.baseUrl, resolveToken(ctx, config), `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues${toQuery(params)}`, void 0, exec.signal);
			const issues = (Array.isArray(data) ? data : []).filter((issue) => issue.pull_request === void 0).slice(0, max).map(projectIssue);
			return { issues, truncated: issues.length >= max };
		},
		presentCall: (args) => ({
			card: "generic",
			title: `${args.owner}/${args.repo} issues`,
			kind: "other",
			rawInput: `${args.owner}/${args.repo}`
		})
	}));
}

/** Register the github_create_issue tool. */
function applyCreateIssueTool(ctx, config) {
	ctx.tools.register(defineTool({
		name: "github_create_issue",
		description: "Create an issue in a GitHub repository. Requires a GITHUB_TOKEN with repo scope; without one the call fails with an authentication error. Use when the user wants to file a new issue.",
		parameters: {
			owner: {
				type: "string",
				required: true,
				description: "Repository owner."
			},
			repo: {
				type: "string",
				required: true,
				description: "Repository name."
			},
			title: {
				type: "string",
				required: true,
				description: "Issue title."
			},
			body: {
				type: "string",
				description: "Issue body (Markdown)."
			},
			labels: {
				type: "array",
				items: { type: "string" },
				description: "Labels to apply."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					number: { type: "integer", required: true },
					title: { type: "string", required: true },
					state: { type: "string", required: true },
					htmlUrl: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Created issue #${value.number}: ${value.title} [${value.state}] ${value.htmlUrl}`
			}]
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const body = {
				title: args.title,
				...(args.body !== void 0 ? { body: args.body } : {}),
				...(args.labels !== void 0 ? { labels: args.labels } : {})
			};
			const created = await ghRequest(config.baseUrl, resolveToken(ctx, config), `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues`, { method: "POST", body }, exec.signal);
			return {
				number: created.number ?? 0,
				title: created.title ?? "",
				state: created.state ?? "",
				htmlUrl: created.html_url ?? ""
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Create issue in ${args.owner}/${args.repo}`,
			kind: "other",
			rawInput: args.title
		})
	}));
}

/** Register the github_prs tool: list pull requests. */
function applyPrsTool(ctx, config) {
	ctx.tools.register(defineTool({
		name: "github_prs",
		description: "List pull requests for a GitHub repository, optionally filtered by state. Use when the user wants to see open/closed/merged pull requests or review PR activity.",
		parameters: {
			owner: {
				type: "string",
				required: true,
				description: "Repository owner."
			},
			repo: {
				type: "string",
				required: true,
				description: "Repository name."
			},
			state: {
				type: "string",
				enum: ["open", "closed", "all"],
				description: "PR state filter (default: open)."
			},
			perPage: {
				type: "integer",
				description: "Max results, capped at the deployment maximum."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					pulls: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								number: { type: "integer", required: true },
								title: { type: "string", required: true },
								state: { type: "string", required: true },
								htmlUrl: { type: "string", required: true },
								user: { type: "string", required: true },
								createdAt: { type: "string", required: true },
								headRef: { type: "string", required: true },
								baseRef: { type: "string", required: true },
								merged: { type: "boolean", required: true },
								draft: { type: "boolean", required: true },
								body: { type: "string", required: true }
							}
						}
					},
					truncated: { type: "boolean", required: true }
				}
			},
			render: (_args, value) => {
				if (value.pulls.length === 0) return [{ type: "text", text: "No pull requests found." }];
				const lines = value.pulls.map((pr) => `- !#${pr.number} [${pr.state}${pr.merged ? "/merged" : ""}${pr.draft ? "/draft" : ""}] ${pr.title} — ${pr.headRef} → ${pr.baseRef} by @${pr.user} ${pr.htmlUrl}`);
				if (value.truncated) lines.push(`(Showing the first ${value.pulls.length} PRs. Narrow the filters for more.)`);
				return [{ type: "text", text: lines.join("\n") }];
			}
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const max = Math.min(args.perPage ?? config.maxResults, config.maxResults);
			const params = { state: args.state ?? "open", per_page: max };
			const data = await ghRequest(config.baseUrl, resolveToken(ctx, config), `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls${toQuery(params)}`, void 0, exec.signal);
			const pulls = (Array.isArray(data) ? data : []).slice(0, max).map(projectPr);
			return { pulls, truncated: pulls.length >= max };
		},
		presentCall: (args) => ({
			card: "generic",
			title: `${args.owner}/${args.repo} PRs`,
			kind: "other",
			rawInput: `${args.owner}/${args.repo}`
		})
	}));
}

/** Register the github_create_pr tool. */
function applyCreatePrTool(ctx, config) {
	ctx.tools.register(defineTool({
		name: "github_create_pr",
		description: "Create a pull request in a GitHub repository. Requires a GITHUB_TOKEN with repo scope. Use when the user wants to open a pull request between two branches.",
		parameters: {
			owner: {
				type: "string",
				required: true,
				description: "Repository owner."
			},
			repo: {
				type: "string",
				required: true,
				description: "Repository name."
			},
			title: {
				type: "string",
				required: true,
				description: "Pull request title."
			},
			head: {
				type: "string",
				required: true,
				description: "The branch (or owner:branch) containing the changes."
			},
			base: {
				type: "string",
				required: true,
				description: "The branch the changes are merged into."
			},
			body: {
				type: "string",
				description: "Pull request body (Markdown)."
			},
			draft: {
				type: "boolean",
				description: "Whether to create the PR as a draft."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					number: { type: "integer", required: true },
					title: { type: "string", required: true },
					state: { type: "string", required: true },
					htmlUrl: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Created PR #${value.number}: ${value.title} [${value.state}] ${value.htmlUrl}`
			}]
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const body = {
				title: args.title,
				head: args.head,
				base: args.base,
				...(args.body !== void 0 ? { body: args.body } : {}),
				...(args.draft !== void 0 ? { draft: args.draft } : {})
			};
			const created = await ghRequest(config.baseUrl, resolveToken(ctx, config), `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls`, { method: "POST", body }, exec.signal);
			return {
				number: created.number ?? 0,
				title: created.title ?? "",
				state: created.state ?? "",
				htmlUrl: created.html_url ?? ""
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Create PR in ${args.owner}/${args.repo}`,
			kind: "other",
			rawInput: args.title
		})
	}));
}

/** Register the github_content tool: read a file or list a directory. */
function applyContentTool(ctx, config) {
	ctx.tools.register(defineTool({
		name: "github_content",
		description: "Read a file or list a directory in a GitHub repository at a given ref (branch/tag/commit). File contents are decoded and returned as text; directories return an entry list. Use when the user wants to inspect files in a repository.",
		parameters: {
			owner: {
				type: "string",
				required: true,
				description: "Repository owner."
			},
			repo: {
				type: "string",
				required: true,
				description: "Repository name."
			},
			path: {
				type: "string",
				description: "Path within the repository (default: repo root)."
			},
			ref: {
				type: "string",
				description: "Branch, tag, or commit SHA (default: default branch)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", required: true },
					type: { type: "string", required: true },
					content: { type: "string", required: true },
					entries: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string", required: true },
								path: { type: "string", required: true },
								type: { type: "string", required: true },
								size: { type: "integer", required: true },
								downloadUrl: { type: "string", required: true }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				if (value.type === "dir") {
					if (value.entries.length === 0) return [{ type: "text", text: `Directory ${value.path || "/"} is empty.` }];
					const lines = value.entries.map((entry) => `- [${entry.type}] ${entry.name}${entry.type === "file" ? ` (${entry.size} bytes)` : ""}`);
					return [{ type: "text", text: `Directory ${value.path || "/"}:\n${lines.join("\n")}` }];
				}
				return [{ type: "text", text: `File ${value.path}:\n\n${value.content.slice(0, 30000)}${value.content.length > 30000 ? "\n\n(Content truncated.)" : ""}` }];
			}
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const path = args.path ?? "";
			const params = args.ref !== void 0 ? { ref: args.ref } : {};
			const data = await ghRequest(config.baseUrl, resolveToken(ctx, config), `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}${toQuery(params)}`, void 0, exec.signal);
			if (Array.isArray(data)) {
				return {
					path,
					type: "dir",
					content: "",
					entries: data.map(projectContentItem)
				};
			}
			let content = "";
			if (typeof data.content === "string" && data.encoding === "base64") {
				content = Buffer.from(data.content, "base64").toString("utf8");
			}
			return {
				path: data.path ?? path,
				type: data.type ?? "file",
				content,
				entries: []
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `${args.owner}/${args.repo} ${args.path ?? "/"}`,
			kind: "other",
			rawInput: args.path ?? "/"
		})
	}));
}

/** Register the github_comment tool: comment on an issue or PR. */
function applyCommentTool(ctx, config) {
	ctx.tools.register(defineTool({
		name: "github_comment",
		description: "Add a comment to an issue or pull request. Requires a GITHUB_TOKEN with repo scope. Use when the user wants to reply to or comment on an issue or PR.",
		parameters: {
			owner: {
				type: "string",
				required: true,
				description: "Repository owner."
			},
			repo: {
				type: "string",
				required: true,
				description: "Repository name."
			},
			issueNumber: {
				type: "integer",
				required: true,
				description: "Issue or pull request number."
			},
			body: {
				type: "string",
				required: true,
				description: "Comment body (Markdown)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "integer", required: true },
					htmlUrl: { type: "string", required: true },
					createdAt: { type: "string", required: true },
					user: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Commented on #${_args.issueNumber} by @${value.user} at ${value.createdAt}: ${value.htmlUrl}`
			}]
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const created = await ghRequest(config.baseUrl, resolveToken(ctx, config), `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues/${args.issueNumber}/comments`, { method: "POST", body: { body: args.body } }, exec.signal);
			return {
				id: created.id ?? 0,
				htmlUrl: created.html_url ?? "",
				createdAt: created.created_at ?? "",
				user: created.user?.login ?? ""
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Comment on ${args.owner}/${args.repo}#${args.issueNumber}`,
			kind: "other",
			rawInput: args.body
		})
	}));
}

/** Project a GitHub user object into a stable plain record. */
function projectUser(user) {
	return {
		login: user.login ?? "",
		name: user.name ?? "",
		htmlUrl: user.html_url ?? "",
		avatarUrl: user.avatar_url ?? "",
		bio: user.bio ?? "",
		company: user.company ?? "",
		publicRepos: user.public_repos ?? 0,
		followers: user.followers ?? 0,
		createdAt: user.created_at ?? ""
	};
}

/**
 * Register the github_bind tool: validate a token against the API and persist
 * it to the credential seam so every other github_* tool authenticates with
 * the bound account.
 */
function applyBindTool(ctx, config) {
	ctx.tools.register(defineTool({
		name: "github_bind",
		description: "Bind a GitHub account to this DeepSeek Harness by validating a personal access token against the GitHub API and persisting it through the credential store. After binding, every github_* tool uses the bound account automatically. Use when the user wants to connect/log in their GitHub account, or when a write operation reports an authentication error. The token must have the scopes the user wants to use (repo for private-repo writes, public_repo for public writes, read-only for public reads).",
		parameters: {
			token: {
				type: "string",
				required: true,
				description: "A GitHub personal access token (classic: ghp_…, fine-grained: github_pat_…)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					login: { type: "string", required: true },
					name: { type: "string", required: true },
					htmlUrl: { type: "string", required: true },
					bound: { type: "boolean", required: true }
				}
			},
			render: (_args, value) => value.bound ? [{
				type: "text",
				text: `Bound GitHub account @${value.login}${value.name.length > 0 ? ` (${value.name})` : ""}. ${value.htmlUrl}`
			}] : [{
				type: "text",
				text: "Binding failed; the token was not stored."
			}]
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const user = await ghRequest(config.baseUrl, args.token, "/user", void 0, exec.signal);
			if (ctx.get("credentials") === void 0) throw new Error("github_bind: credential store is unavailable; set GITHUB_TOKEN in the environment or the plugin config `token` instead");
			await ctx.get("credentials").set(credentialRef(GITHUB_TOKEN_REF), args.token);
			return {
				login: user.login ?? "",
				name: user.name ?? "",
				htmlUrl: user.html_url ?? "",
				bound: true
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Bind GitHub account",
			kind: "other",
			rawInput: args.token ? `${args.token.slice(0, 8)}…` : ""
		})
	}));
}

/** Register the github_whoami tool: show the bound account. */
function applyWhoamiTool(ctx, config) {
	ctx.tools.register(defineTool({
		name: "github_whoami",
		description: "Show which GitHub account is currently bound to this DeepSeek Harness, where the token comes from (credential store, plugin config, or environment), and the account's public profile. Use when the user asks who is logged in, whether GitHub is connected, or which account the tools will act as.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					authenticated: { type: "boolean", required: true },
					source: { type: "string", required: true },
					login: { type: "string", required: true },
					name: { type: "string", required: true },
					htmlUrl: { type: "string", required: true },
					bio: { type: "string", required: true },
					publicRepos: { type: "integer", required: true },
					followers: { type: "integer", required: true }
				}
			},
			render: (_args, value) => {
				if (!value.authenticated) return [{ type: "text", text: "No GitHub account is bound. Run github_bind with a personal access token, or set GITHUB_TOKEN (environment / plugin config) to connect." }];
				return [{
					type: "text",
					text: `Bound GitHub account: @${value.login}${value.name.length > 0 ? ` (${value.name})` : ""} — token source: ${value.source}${value.bio.length > 0 ? `\nBio: ${value.bio}` : ""}\nRepos: ${value.publicRepos} · Followers: ${value.followers}\n${value.htmlUrl}`
				}];
			}
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => true,
		async execute(_args, exec) {
			const token = await resolveToken(ctx, config);
			if (token.length === 0) {
				return {
					authenticated: false,
					source: "none",
					login: "",
					name: "",
					htmlUrl: "",
					bio: "",
					publicRepos: 0,
					followers: 0
				};
			}
			const user = await ghRequest(config.baseUrl, token, "/user", void 0, exec.signal);
			return {
				authenticated: true,
				source: await describeToken(ctx, config),
				login: user.login ?? "",
				name: user.name ?? "",
				htmlUrl: user.html_url ?? "",
				bio: user.bio ?? "",
				publicRepos: user.public_repos ?? 0,
				followers: user.followers ?? 0
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "Check bound GitHub account",
			kind: "other",
			rawInput: ""
		})
	}));
}

/** Register the github_unbind tool: remove the stored token. */
function applyUnbindTool(ctx, config) {
	ctx.tools.register(defineTool({
		name: "github_unbind",
		description: "Unbind the GitHub account from this DeepSeek Harness by removing the stored token from the credential store. Environment or plugin-config tokens cannot be removed here (they are read-only sources); only a credential-store binding is cleared. Use when the user wants to disconnect their GitHub account.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					removed: { type: "boolean", required: true },
					source: { type: "string", required: true }
				}
			},
			render: (_args, value) => value.removed ? [{
				type: "text",
				text: "GitHub account unbound; the stored token was removed."
			}] : [{
				type: "text",
				text: `Nothing removed. The active token comes from ${value.source}, which is read-only here; remove it from that source directly.`
			}]
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => true,
		async execute(_args, _exec) {
			if (ctx.get("credentials") === void 0) return { removed: false, source: "unavailable" };
			const info = await ctx.get("credentials").describe(credentialRef(GITHUB_TOKEN_REF));
			if (info === void 0 || !info.configured) return { removed: false, source: await describeToken(ctx, config) };
			if (info.source === "file") {
				await ctx.get("credentials").unset(credentialRef(GITHUB_TOKEN_REF));
				return { removed: true, source: "file" };
			}
			return { removed: false, source: info.source ?? "unknown" };
		},
		presentCall: () => ({
			card: "generic",
			title: "Unbind GitHub account",
			kind: "other",
			rawInput: ""
		})
	}));
}

/** Resolve the configured workspace root, creating it on first use. */
function resolveWorkspaceRoot(config) {
	const root = config.workspaceRoot.length > 0 ? config.workspaceRoot : defaultWorkspaceRoot();
	if (!existsSync(root)) mkdirSync(root, { recursive: true });
	return root;
}

/**
 * Download a repository tarball via the GitHub codeload endpoint and extract
 * it with the system tar. Used as a fallback when `git` cannot reach the
 * remote (e.g. schannel TLS unavailable in constrained environments). The
 * clone has no `.git` history; a later `git init` can re-seed it.
 */
async function downloadTarball(baseUrl, token, owner, repo, branch, repoPath, signal) {
	let ref = branch;
	if (ref === void 0) {
		// Resolve the default branch through the API (codeload needs a concrete ref).
		const meta = await ghRequest(baseUrl, token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, void 0, signal);
		ref = meta.default_branch ?? "master";
	}
	const url = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tar.gz/refs/heads/${encodeURIComponent(ref)}`;
	const response = await fetch(url, { signal });
	if (!response.ok) throw new Error(`tool-github: tarball download failed for ${owner}/${repo}@${ref} (HTTP ${response.status})`);
	const buffer = Buffer.from(await response.arrayBuffer());
	const tmpArchive = `${repoPath}.tar.gz`;
	mkdirSync(repoPath, { recursive: true });
	const { writeFile } = await import("node:fs/promises");
	await writeFile(tmpArchive, buffer);
	// bsdtar strips the single top-level folder; extract with --strip-components=1
	await runCommand("tar", ["-xzf", tmpArchive, "-C", repoPath, "--strip-components=1"], { signal, timeout: 6e4 });
	const { unlink } = await import("node:fs/promises");
	await unlink(tmpArchive);
	// Not a git worktree; initialize so tooling expecting .git still works.
	await runCommand("git", ["init", "--quiet", repoPath], { signal, timeout: 3e4 }).catch(() => {});
}

/** Clone a repository into the workspace root; returns the clone directory. */
async function cloneRepo(baseUrl, token, owner, repo, branch, workspaceRoot, signal) {
	const repoPath = join(workspaceRoot, safeSegment(owner), safeSegment(repo));
	if (existsSync(repoPath)) {
		if (branch !== void 0) {
			try {
				await runCommand("git", ["-C", repoPath, "fetch", "--quiet", "origin", branch], { signal, timeout: 6e4 });
				await runCommand("git", ["-C", repoPath, "checkout", "--quiet", branch], { signal, timeout: 6e4 });
			} catch {
				// fetch/checkout failed; leave the existing checkout untouched
			}
		}
		return repoPath;
	}
	try {
		await runCommand("git", ["clone", "--quiet", ...(branch !== void 0 ? ["--branch", branch, "--single-branch"] : []), `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`, repoPath], { signal, timeout: 9e4 });
	} catch {
		// git failed (network policy, schannel, auth) — fall back to tarball.
		await downloadTarball(baseUrl, token, owner, repo, branch, repoPath, signal);
	}
	return repoPath;
}

/**
 * Register the github_workspace_add tool: clone a GitHub repository into the
 * local workspace root and register it with the harness workspace registry so
 * it appears in the workspace picker and can be selected as the working
 * directory for sessions.
 */
function applyWorkspaceAddTool(ctx, config) {
	ctx.tools.register(defineTool({
		name: "github_workspace_add",
		description: "Clone a GitHub repository into a local workspace folder and register it with DeepSeek Harness as a selectable workspace. After this runs, the repository appears in the workspace picker (sidebar / new-session hero), so the user can choose it as the working directory. Use when the user wants to work on a GitHub repository as a workspace, e.g. \"add deepseek-ai/DeepSeek-Harness as a workspace\", \"工作区选这个仓库\", or \"clone xxx and open it as a workspace\".",
		parameters: {
			owner: {
				type: "string",
				required: true,
				description: "Repository owner (user or organization)."
			},
			repo: {
				type: "string",
				required: true,
				description: "Repository name."
			},
			branch: {
				type: "string",
				description: "Branch to clone (default: the repository default branch)."
			},
			title: {
				type: "string",
				description: "Display title for the workspace (default: \"owner/repo\")."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", required: true },
					title: { type: "string", required: true },
					registered: { type: "boolean", required: true },
					cloned: { type: "boolean", required: true }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `${value.registered ? "Registered" : "Available as"} GitHub workspace "${value.title}" at ${value.path}${value.cloned ? " (freshly cloned)" : ""}. It now appears in the workspace picker — select it to work inside the repository.`
			}]
		},
		timeoutMs: Math.max(config.timeoutMs, 9e4),
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const root = resolveWorkspaceRoot(config);
			const cloned = !existsSync(join(root, safeSegment(args.owner), safeSegment(args.repo)));
			const token = await resolveToken(ctx, config);
			const repoPath = await cloneRepo(config.baseUrl, token, args.owner, args.repo, args.branch, root, exec.signal);
			const title = args.title ?? `${args.owner}/${args.repo}`;
			if (ctx.get("workspaceRegistry") !== void 0) {
				await ctx.get("workspaceRegistry").create(repoPath, title);
				return { path: repoPath, title, registered: true, cloned };
			}
			return { path: repoPath, title, registered: false, cloned };
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Add ${args.owner}/${args.repo} as workspace`,
			kind: "other",
			rawInput: `${args.owner}/${args.repo}`
		})
	}));
}

/** Register the github_workspace_list tool: list GitHub-cloned workspaces. */
function applyWorkspaceListTool(ctx, config) {
	ctx.tools.register(defineTool({
		name: "github_workspace_list",
		description: "List the GitHub repositories that have been cloned and registered as DeepSeek Harness workspaces by github_workspace_add, with their local paths and registered titles. Use when the user asks which GitHub repos are available as workspaces, or where a cloned repo lives on disk.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					workspaces: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								title: { type: "string", required: true },
								path: { type: "string", required: true },
								registered: { type: "boolean", required: true }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				if (value.workspaces.length === 0) return [{ type: "text", text: "No GitHub workspaces yet. Run github_workspace_add with an owner and repo to clone and register one." }];
				return [{
					type: "text",
					text: value.workspaces.map((ws) => `- **${ws.title}** — ${ws.path}${ws.registered ? " (registered in workspace picker)" : " (on disk, not registered)"}`).join("\n")
				}];
			}
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => true,
		async execute(_args, _exec) {
			const root = resolveWorkspaceRoot(config);
			const workspaces = [];
			const ownerDirs = existsSync(root) ? await import("node:fs/promises").then((fs) => fs.readdir(root, { withFileTypes: true }).catch(() => [])) : [];
			for (const ownerDir of ownerDirs) {
				if (!ownerDir.isDirectory()) continue;
				const ownerPath = join(root, ownerDir.name);
				const repoDirs = await import("node:fs/promises").then((fs) => fs.readdir(ownerPath, { withFileTypes: true }).catch(() => []));
				for (const repoDir of repoDirs) {
					if (!repoDir.isDirectory()) continue;
					const repoPath = join(ownerPath, repoDir.name);
					const title = `${ownerDir.name}/${repoDir.name}`;
					let registered = false;
					if (ctx.get("workspaceRegistry") !== void 0) {
						registered = ctx.get("workspaceRegistry").list().some((ws) => ws.path === repoPath);
					}
					workspaces.push({ title, path: repoPath, registered });
				}
			}
			return { workspaces };
		},
		presentCall: () => ({
			card: "generic",
			title: "List GitHub workspaces",
			kind: "other",
			rawInput: ""
		})
	}));
}

/**
 * Register the github_my_repos tool: list the bound account's repositories.
 * Requires a bound account (or GITHUB_TOKEN); the list is the authenticated
 * user's own repos, private ones included when the token has the scope.
 */
function applyMyReposTool(ctx, config) {
	ctx.tools.register(defineTool({
		name: "github_my_repos",
		description: "List the GitHub repositories of the currently bound account (@whoami), with stars, language, visibility, and URLs. Use when the user asks \"what repos do I have\", \"我的仓库\", \"list my repositories\", or wants to pick one of their existing repositories to work on or add as a workspace.",
		parameters: {
			perPage: {
				type: "integer",
				description: "Max results, capped at the deployment maximum."
			},
			type: {
				type: "string",
				enum: ["all", "owner", "public", "private", "member"],
				description: "Repository type filter (default: all)."
			},
			sort: {
				type: "string",
				enum: ["created", "updated", "pushed", "full_name"],
				description: "Sort order (default: updated)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					login: { type: "string", required: true },
					repos: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								fullName: { type: "string", required: true },
								description: { type: "string", required: true },
								htmlUrl: { type: "string", required: true },
								stars: { type: "integer", required: true },
								language: { type: "string", required: true },
								private: { type: "boolean", required: true },
								defaultBranch: { type: "string", required: true },
								updatedAt: { type: "string", required: true },
								isWorkspace: { type: "boolean", required: true }
							}
						}
					},
					truncated: { type: "boolean", required: true }
				}
			},
			render: (_args, value) => {
				if (value.repos.length === 0) return [{ type: "text", text: `@${value.login} has no repositories.` }];
				const lines = [`Repositories of @${value.login}:`];
				for (const repo of value.repos) {
					const vis = repo.private ? "private" : "public";
					lines.push(`- **${repo.fullName}** [${vis}] (${repo.stars}★, ${repo.language || "n/a"})${repo.isWorkspace ? " — already a workspace" : ""} — ${repo.description || "no description"} ${repo.htmlUrl}`);
				}
				if (value.truncated) lines.push(`(Showing the first ${value.repos.length} repositories. Narrow the filters for more.)`);
				return [{ type: "text", text: lines.join("\n") }];
			}
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const token = await resolveToken(ctx, config);
			if (token.length === 0) throw new Error("github_my_repos requires a bound account; run github_bind with a token first, or set GITHUB_TOKEN");
			const user = await ghRequest(config.baseUrl, token, "/user", void 0, exec.signal);
			const max = Math.min(args.perPage ?? config.maxResults, config.maxResults);
			const params = {
				affiliation: args.type === "all" ? "owner,collaborator,organization_member" : args.type === "owner" ? "owner" : args.type === "member" ? "organization_member" : "owner",
				sort: args.sort ?? "updated",
				per_page: max
			};
			const data = await ghRequest(config.baseUrl, token, `/user/repos${toQuery(params)}`, void 0, exec.signal);
			const workspacePaths = new Set();
			if (ctx.get("workspaceRegistry") !== void 0) {
				for (const ws of ctx.get("workspaceRegistry").list()) workspacePaths.add(ws.path);
			}
			const root = config.workspaceRoot.length > 0 ? config.workspaceRoot : defaultWorkspaceRoot();
			const repos = (Array.isArray(data) ? data : []).slice(0, max).map((repo) => {
				const localPath = join(root, safeSegment(repo.owner?.login ?? user.login ?? ""), safeSegment(repo.name ?? ""));
				return {
					fullName: repo.full_name ?? "",
					description: repo.description ?? "",
					htmlUrl: repo.html_url ?? "",
					stars: repo.stargazers_count ?? 0,
					language: repo.language ?? "",
					private: repo.private ?? false,
					defaultBranch: repo.default_branch ?? "",
					updatedAt: repo.updated_at ?? "",
					isWorkspace: existsSync(localPath) && workspacePaths.has(localPath)
				};
			});
			return {
				login: user.login ?? "",
				repos,
				truncated: (Array.isArray(data) ? data.length : 0) > repos.length
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "List my GitHub repositories",
			kind: "other",
			rawInput: args.type ?? "all"
		})
	}));
}

/**
 * Register all GitHub tools and a system-prompt section describing when to use
 * them. Requires `tools`, `systemPrompt`, and `credentials` services; the
 * optional `workspaceRegistry` service enables workspace registration.
 */
function apply(ctx, config) {
	const resolved = config;
	assertPositiveInteger("timeoutMs", resolved.timeoutMs);
	assertPositiveInteger("maxResults", resolved.maxResults);
	ctx.systemPrompt.section({
		name: "tool:github",
		order: 112,
		text: "Use the github_repo, github_search, github_issues, github_prs, github_content, github_create_issue, github_create_pr, and github_comment tools to work with GitHub: repositories, code search, issues, pull requests, and file content. Bind a GitHub account once with github_bind (validates and stores the token), check it with github_whoami, and remove it with github_unbind. Write-only operations (github_create_issue, github_create_pr, github_comment) require a bound account or GITHUB_TOKEN and will fail with an authentication error otherwise. Use github_workspace_add to clone a repository into a local workspace and register it in the workspace picker, and github_workspace_list to see which repositories are available as workspaces."
	});
	applyRepoTool(ctx, resolved);
	applySearchTool(ctx, resolved);
	applyIssuesTool(ctx, resolved);
	applyCreateIssueTool(ctx, resolved);
	applyPrsTool(ctx, resolved);
	applyCreatePrTool(ctx, resolved);
	applyContentTool(ctx, resolved);
	applyCommentTool(ctx, resolved);
	applyBindTool(ctx, resolved);
	applyWhoamiTool(ctx, resolved);
	applyUnbindTool(ctx, resolved);
	applyWorkspaceAddTool(ctx, resolved);
	applyWorkspaceListTool(ctx, resolved);
	applyMyReposTool(ctx, resolved);
	applyGithubCommands(ctx, resolved);
}

/**
 * Register human-facing `/github-*` commands consumed by the Web UI (and the
 * client plugin's sidebar panel). Each command reuses the same GitHub logic as
 * the model-facing tools and returns plain text rendered directly by the UI.
 */
function applyGithubCommands(ctx, config) {
	if (ctx.commands === void 0) return;
	const commands = ctx.commands;
	const abortable = (signal) => {
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal.addEventListener("abort", onAbort, { once: true });
		return { signal: controller.signal, cleanup: () => signal.removeEventListener("abort", onAbort) };
	};
	const run = async (fn) => {
		try {
			return { kind: "success", text: await fn() };
		} catch (error) {
			return { kind: "error", text: error instanceof Error ? error.message : String(error) };
		}
	};

	commands.register({
		name: "github-status",
		description: "Show the bound GitHub account, token source, and registered GitHub workspaces",
		recordInput: false,
		handler: async (invocation) => {
			const { signal, cleanup } = abortable(invocation.signal);
			try {
				return await run(async () => {
					const token = await resolveToken(ctx, config);
					const lines = [];
					if (token.length === 0) {
						lines.push("No GitHub account is bound. Run /github-bind <token> to connect, or set GITHUB_TOKEN.");
					} else {
						const user = await ghRequest(config.baseUrl, token, "/user", void 0, signal);
						lines.push(`Bound GitHub account: @${user.login ?? ""}${user.name ? ` (${user.name})` : ""} — token source: ${await describeToken(ctx, config)}`);
					}
					const root = config.workspaceRoot.length > 0 ? config.workspaceRoot : defaultWorkspaceRoot();
					if (existsSync(root)) {
						const { readdir } = await import("node:fs/promises");
						const owners = await readdir(root, { withFileTypes: true }).catch(() => []);
						const repos = [];
						for (const ownerDir of owners) {
							if (!ownerDir.isDirectory()) continue;
							const subs = await readdir(join(root, ownerDir.name), { withFileTypes: true }).catch(() => []);
							for (const sub of subs) {
								if (sub.isDirectory()) repos.push(`${ownerDir.name}/${sub.name}`);
							}
						}
						if (repos.length > 0) lines.push(`GitHub workspaces (${repos.length}): ${repos.join(", ")}`);
						else lines.push("No GitHub workspaces yet. Run /github-workspace-add <owner> <repo> to clone one.");
					} else {
						lines.push("No GitHub workspaces yet. Run /github-workspace-add <owner> <repo> to clone one.");
					}
					return lines.join("\n");
				});
			} finally {
				cleanup();
			}
		}
	});

	commands.register({
		name: "github-bind",
		description: "Bind a GitHub account with a personal access token (/github-bind ghp_xxx)",
		input: { hint: "GitHub personal access token" },
		handler: async (invocation) => {
			const { signal, cleanup } = abortable(invocation.signal);
			try {
				return await run(async () => {
					const token = invocation.rawInput.trim();
					if (token.length === 0) throw new Error("Usage: /github-bind <token>");
					const user = await ghRequest(config.baseUrl, token, "/user", void 0, signal);
					if (ctx.get("credentials") === void 0) throw new Error("credential store unavailable; set GITHUB_TOKEN in the environment instead");
					await ctx.get("credentials").set(credentialRef(GITHUB_TOKEN_REF), token);
					return `Bound GitHub account @${user.login ?? ""}${user.name ? ` (${user.name})` : ""}. All github_* tools now act as this account.`;
				});
			} finally {
				cleanup();
			}
		}
	});

	commands.register({
		name: "github-unbind",
		description: "Remove the stored GitHub token and disconnect the account",
		recordInput: false,
		handler: async () => {
			return await run(async () => {
				if (ctx.get("credentials") === void 0) throw new Error("credential store unavailable");
				const info = await ctx.get("credentials").describe(credentialRef(GITHUB_TOKEN_REF));
				if (info === void 0 || !info.configured || info.source !== "file") {
					throw new Error(`no credential-store binding to remove (active source: ${info?.source ?? "none"})`);
				}
				await ctx.get("credentials").unset(credentialRef(GITHUB_TOKEN_REF));
				return "GitHub account unbound; the stored token was removed.";
			});
		}
	});

	commands.register({
		name: "github-workspace-add",
		description: "Clone a GitHub repository and register it as a workspace (/github-workspace-add owner repo [branch])",
		input: { hint: "owner repo [branch]" },
		handler: async (invocation) => {
			const { signal, cleanup } = abortable(invocation.signal);
			try {
				return await run(async () => {
					const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
					if (parts.length < 2) throw new Error("Usage: /github-workspace-add <owner> <repo> [branch]");
					const [owner, repo, branch] = parts;
					const root = resolveWorkspaceRoot(config);
					const existed = existsSync(join(root, safeSegment(owner), safeSegment(repo)));
					const token = await resolveToken(ctx, config);
					const repoPath = await cloneRepo(config.baseUrl, token, owner, repo, branch, root, signal);
					const title = `${owner}/${repo}`;
					let registered = false;
					if (ctx.get("workspaceRegistry") !== void 0) {
						await ctx.get("workspaceRegistry").create(repoPath, title);
						registered = true;
					}
					return `${registered ? "Registered" : "Available"} GitHub workspace "${title}" at ${repoPath}${existed ? "" : " (freshly cloned)"}${registered ? " — select it in the workspace picker." : ""}`;
				});
			} finally {
				cleanup();
			}
		}
	});

	commands.register({
		name: "github-workspace-list",
		description: "List GitHub repositories cloned as workspaces",
		recordInput: false,
		handler: async () => {
			return await run(async () => {
				const root = config.workspaceRoot.length > 0 ? config.workspaceRoot : defaultWorkspaceRoot();
				if (!existsSync(root)) return "No GitHub workspaces yet. Run /github-workspace-add <owner> <repo> to clone one.";
				const { readdir } = await import("node:fs/promises");
				const owners = await readdir(root, { withFileTypes: true }).catch(() => []);
				const repos = [];
				for (const ownerDir of owners) {
					if (!ownerDir.isDirectory()) continue;
					const subs = await readdir(join(root, ownerDir.name), { withFileTypes: true }).catch(() => []);
					for (const sub of subs) {
						if (!sub.isDirectory()) continue;
						const repoPath = join(root, ownerDir.name, sub.name);
						let registered = false;
						if (ctx.get("workspaceRegistry") !== void 0) {
							registered = ctx.get("workspaceRegistry").list().some((ws) => ws.path === repoPath);
						}
						repos.push(`${ownerDir.name}/${sub.name} — ${repoPath}${registered ? " (registered)" : ""}`);
					}
				}
				return repos.length > 0 ? repos.join("\n") : "No GitHub workspaces yet. Run /github-workspace-add <owner> <repo> to clone one.";
			});
		}
	});

	commands.register({
		name: "github-my-repos",
		description: "List the bound account's GitHub repositories (public and private, per token scope)",
		recordInput: false,
		handler: async (invocation) => {
			const { signal, cleanup } = abortable(invocation.signal);
			try {
				return await run(async () => {
					const token = await resolveToken(ctx, config);
					if (token.length === 0) throw new Error("No GitHub account is bound. Run /github-bind <token> to connect.");
					const user = await ghRequest(config.baseUrl, token, "/user", void 0, signal);
					const params = { affiliation: "owner,collaborator,organization_member", sort: "updated", per_page: config.maxResults };
					const data = await ghRequest(config.baseUrl, token, `/user/repos${toQuery(params)}`, void 0, signal);
					const repos = Array.isArray(data) ? data : [];
					if (repos.length === 0) return `@${user.login ?? ""} has no repositories.`;
					const root = config.workspaceRoot.length > 0 ? config.workspaceRoot : defaultWorkspaceRoot();
					const workspacePaths = new Set();
					if (ctx.get("workspaceRegistry") !== void 0) {
						for (const ws of ctx.get("workspaceRegistry").list()) workspacePaths.add(ws.path);
					}
					const lines = repos.map((repo) => {
						const vis = repo.private ? "private" : "public";
						const localPath = join(root, safeSegment(repo.owner?.login ?? user.login ?? ""), safeSegment(repo.name ?? ""));
						const ws = existsSync(localPath) && workspacePaths.has(localPath);
						return `- ${repo.full_name ?? ""} [${vis}] (${repo.stargazers_count ?? 0}★, ${repo.language ?? "n/a"})${ws ? " — workspace" : ""} — ${repo.description ?? ""}`;
					});
					return `Repositories of @${user.login ?? ""}:\n${lines.join("\n")}`;
				});
			} finally {
				cleanup();
			}
		}
	});
}

export { Config, apply, inject, name };
