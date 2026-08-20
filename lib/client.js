/**
 * dsh-tool-github client bundle (browser half).
 *
 * Pure-DOM GitHub panel for the DSH web GUI: injects a GitHub icon into the
 * sidebar rail and, on click, opens a panel showing the bound account status,
 * registered GitHub workspaces, and quick actions (bind / unbind / add
 * workspace). All data flows through the host `/github-*` commands via
 * `ctx.remote.commands.execute`, so this bundle carries no GitHub token and
 * never touches the GitHub API directly.
 *
 * The bundle follows the shell's module-loader contract:
 * window.__ModuleLoader__.load({ id, factory }) — `factory` receives the
 * module-table `require`; exports `inject` (cordis service keys) and `apply`
 * (client plugin body). Every DOM write is tracked and removed by the Cordis
 * effect disposer returned from `apply`.
 */
window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-tool-github",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** Cordis services this client plugin needs. */
		const inject = ["remote", "remote.commands", "sessions"];

		/** Plugin id used for DOM markers and effect scoping. */
		const PLUGIN_ID = "dsh-tool-github";

		/** Inline SVG GitHub mark (octocat) — no external asset dependency. */
		const GITHUB_ICON_SVG = [
			'<svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">',
			'<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>',
			'</svg>'
		].join("");

		/** Escape text for safe HTML insertion. */
		function esc(value) {
			return String(value).replace(/[&<>"']/g, (ch) => ({
				"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
			})[ch]);
		}

		/**
		 * Resolve the active session id from the `sessions` service.
		 * The sessions service exposes `list` as a SnapshotStore whose state
		 * carries `current` (the persisted selection). Falls back to the first
		 * listed session when nothing is selected.
		 * @returns the selected session id, or undefined when none is open.
		 */
		function activeSessionId(sessions) {
			try {
				const snapshot = sessions?.list?.getSnapshot?.();
				if (snapshot?.current !== void 0) return snapshot.current;
				if (Array.isArray(snapshot?.ids) && snapshot.ids.length > 0) return snapshot.ids[0];
			} catch {
				// fall through
			}
			return void 0;
		}

		/** Run one host command through the commands Remote, returning its text. */
		async function runCommand(ctx, line) {
			const sessionId = activeSessionId(ctx.sessions);
			if (sessionId === void 0) throw new Error("no active session — open a session first, then retry");
			const result = await ctx.remote.commands.execute(sessionId, line);
			if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
			if (result.value === void 0) return `unknown command: ${line}`;
			return result.value.result?.text ?? "(no output)";
		}

		/** Show status text inside the panel body. */
		function showStatus(body, text) {
			body.replaceChildren();
			const pre = document.createElement("pre");
			pre.className = "dsh-github-panel-pre";
			pre.textContent = text;
			body.append(pre);
		}

		/** Refresh the panel body with /github-status output. */
		async function refreshPanel(ctx, body) {
			body.replaceChildren();
			const loading = document.createElement("span");
			loading.textContent = "Loading…";
			body.append(loading);
			try {
				const text = await runCommand(ctx, "/github-status");
				showStatus(body, text);
			} catch (error) {
				showStatus(body, error instanceof Error ? error.message : String(error));
			}
		}

		/**
		 * Mount an inline action form (input + button) into the panel body.
		 * Uses a real <input> instead of window.prompt, which some embedded
		 * environments disable.
		 * @param body - panel body element.
		 * @param placeholder - input placeholder text.
		 * @param buttonLabel - submit button label.
		 * @param onSubmit - async (value) => string; returned text is shown.
		 */
		function mountInlineForm(body, placeholder, buttonLabel, onSubmit) {
			body.replaceChildren();
			const row = document.createElement("div");
			row.className = "dsh-github-panel-form";

			const input = document.createElement("input");
			input.type = "text";
			input.className = "dsh-github-panel-input";
			input.placeholder = placeholder;
			input.autocomplete = "off";
			input.spellcheck = false;

			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "dsh-github-panel-submit";
			btn.textContent = buttonLabel;

			const back = document.createElement("button");
			back.type = "button";
			back.className = "dsh-github-panel-back";
			back.textContent = "Back";

			const run = async () => {
				const value = input.value.trim();
				if (value.length === 0) return;
				btn.disabled = true;
				body.replaceChildren();
				const working = document.createElement("span");
				working.textContent = "Working…";
				body.append(working);
				try {
					const text = await onSubmit(value);
					showStatus(body, text);
				} catch (error) {
					showStatus(body, error instanceof Error ? error.message : String(error));
				}
			};
			btn.addEventListener("click", run);
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") run();
			});
			back.addEventListener("click", () => refreshPanel(ctx, body));

			row.append(input, btn, back);
			body.append(row);
			input.focus();
		}

		/**
		 * Mount the "My repositories" list view: fetch the bound account's repos
		 * via /github-my-repos, render each as a clickable row that adds it as a
		 * workspace on click. Includes a back button to return to status.
		 * @param ctx - client cordis root context.
		 * @param body - panel body element.
		 */
		async function mountReposList(ctx, body) {
			body.replaceChildren();
			const loading = document.createElement("span");
			loading.textContent = "Loading repositories…";
			body.append(loading);
			let text;
			try {
				text = await runCommand(ctx, "/github-my-repos");
			} catch (error) {
				showStatus(body, error instanceof Error ? error.message : String(error));
				return;
			}
			body.replaceChildren();

			// Parse the plain-text repo list into { fullName, marker } rows.
			// Lines look like: `- owner/repo [public] (N★, Lang) — desc`
			const rows = [];
			for (const line of text.split("\n")) {
				const m = /^-\s+([^\s]+)\s+(\[[^\]]+\])/.exec(line.trim());
				if (m) rows.push({ fullName: m[1], meta: m[2], raw: line.trim() });
			}
			if (rows.length === 0) {
				showStatus(body, text);
				return;
			}

			const header = document.createElement("div");
			header.className = "dsh-github-panel-list-header";
			header.textContent = `My repositories (${rows.length}) — click to add as workspace`;

			const list = document.createElement("div");
			list.className = "dsh-github-panel-list";

			for (const row of rows) {
				const item = document.createElement("button");
				item.type = "button";
				item.className = "dsh-github-panel-repo";
				item.title = `Add ${row.fullName} as workspace`;
				const label = document.createElement("span");
				label.className = "dsh-github-panel-repo-name";
				label.textContent = row.fullName;
				const meta = document.createElement("span");
				meta.className = "dsh-github-panel-repo-meta";
				meta.textContent = row.meta;
				item.append(label, meta);
				item.addEventListener("click", () => {
					body.replaceChildren();
					const working = document.createElement("span");
					working.textContent = `Adding ${row.fullName} as workspace…`;
					body.append(working);
					const [owner, repo] = row.fullName.split("/");
					runCommand(ctx, `/github-workspace-add ${owner} ${repo}`).then((t) => showStatus(body, t), (e) => showStatus(body, e instanceof Error ? e.message : String(e)));
				});
				list.append(item);
			}

			const back = document.createElement("button");
			back.type = "button";
			back.className = "dsh-github-panel-back";
			back.textContent = "Back";
			back.addEventListener("click", () => refreshPanel(ctx, body));

			body.append(header, list, back);
		}

		/** Mount the GitHub panel DOM: header, body, and action buttons. */
		function mountPanel(ctx, panelRoot) {
			const header = document.createElement("div");
			header.className = "dsh-github-panel-header";
			header.textContent = "GitHub";

			const body = document.createElement("div");
			body.className = "dsh-github-panel-body";
			body.textContent = "Open the panel to load status.";

			const actions = document.createElement("div");
			actions.className = "dsh-github-panel-actions";

			const refresh = document.createElement("button");
			refresh.type = "button";
			refresh.textContent = "Refresh";
			refresh.addEventListener("click", () => refreshPanel(ctx, body));

			const bindBtn = document.createElement("button");
			bindBtn.type = "button";
			bindBtn.textContent = "Bind account…";
			bindBtn.addEventListener("click", () => mountInlineForm(
				body,
				"GitHub personal access token (ghp_… / github_pat_…)",
				"Bind",
				(token) => runCommand(ctx, `/github-bind ${token}`)
			));

			const addWs = document.createElement("button");
			addWs.type = "button";
			addWs.textContent = "Add workspace…";
			addWs.addEventListener("click", () => mountInlineForm(
				body,
				"owner/repo (or: owner repo [branch])",
				"Add",
				(spec) => {
					const parts = spec.includes("/") && !/\s/.test(spec) ? spec.split("/") : spec.split(/\s+/).filter(Boolean);
					const [owner, repo, branch] = parts.length >= 2 ? parts : [];
					if (!owner || !repo) throw new Error("Usage: owner/repo or \"owner repo [branch]\"");
					return runCommand(ctx, `/github-workspace-add ${owner} ${repo}${branch ? ` ${branch}` : ""}`);
				}
			));

			const myReposBtn = document.createElement("button");
			myReposBtn.type = "button";
			myReposBtn.textContent = "My repos";
			myReposBtn.addEventListener("click", () => mountReposList(ctx, body));

			actions.append(refresh, bindBtn, addWs, myReposBtn);
			panelRoot.append(header, body, actions);

			return body;
		}

		/**
		 * Client plugin body: inject the sidebar GitHub button and panel.
		 * @param ctx - client cordis root context.
		 * @returns an effect disposer that removes every injected node.
		 */
		function apply(ctx) {
			const owned = new Set();

			const button = document.createElement("button");
			button.type = "button";
			button.className = "dsh-github-rail-button";
			button.dataset.plugin = PLUGIN_ID;
			button.title = "GitHub";
			button.setAttribute("aria-label", "GitHub");
			button.innerHTML = GITHUB_ICON_SVG;

			const panel = document.createElement("div");
			panel.className = "dsh-github-panel";
			panel.dataset.plugin = PLUGIN_ID;
			panel.hidden = true;

			const style = document.createElement("style");
			style.dataset.plugin = PLUGIN_ID;
			style.textContent = [
				".dsh-github-rail-button{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;margin:4px auto;padding:0;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary,#8a8f98);cursor:pointer;flex:none}",
				".dsh-github-rail-button:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e6e6e6)}",
				".dsh-github-rail-button[data-sidebar-rail]{width:38px;height:38px;margin:2px auto;border-radius:50%}",
				".dsh-github-rail-button svg{display:block}",
				".dsh-github-panel{position:fixed;top:60px;right:16px;z-index:1000;width:340px;max-height:70vh;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));border-radius:12px;background:var(--dsw-alias-bg-base,#1a1b1e);box-shadow:0 8px 32px rgba(0,0,0,.4);color:var(--dsw-alias-label-primary,#e6e6e6);font:14px/1.5 system-ui,sans-serif;overflow:hidden}",
				".dsh-github-panel[hidden]{display:none}",
				".dsh-github-panel-header{padding:10px 14px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.06))}",
				".dsh-github-panel-body{padding:12px 14px;overflow:auto;flex:1}",
				".dsh-github-panel-pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.6 ui-monospace,Consolas,monospace}",
				".dsh-github-panel-actions{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.06))}",
				".dsh-github-panel-actions button{flex:1;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,.06));color:inherit;cursor:pointer;font:12px/1.4 system-ui,sans-serif}",
				".dsh-github-panel-actions button:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,.12))}",
				".dsh-github-panel-form{display:flex;flex-direction:column;gap:8px}",
				".dsh-github-panel-input{box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.15));border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,.06));color:inherit;font:12px/1.4 ui-monospace,Consolas,monospace}",
				".dsh-github-panel-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#5b8def)}",
				".dsh-github-panel-submit,.dsh-github-panel-back{padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,.06));color:inherit;cursor:pointer;font:12px/1.4 system-ui,sans-serif}",
				".dsh-github-panel-submit:hover,.dsh-github-panel-back:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,.12))}",
				".dsh-github-panel-submit{background:var(--dsw-alias-button-info-fill,rgba(91,141,239,.25))}",
				".dsh-github-panel-list{display:flex;flex-direction:column;gap:4px;margin:8px 0}",
				".dsh-github-panel-list-header{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:11px;line-height:1.4}",
				".dsh-github-panel-repo{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));border-radius:8px;background:transparent;color:inherit;cursor:pointer;text-align:left;font:12px/1.4 system-ui,sans-serif}",
				".dsh-github-panel-repo:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,.08))}",
				".dsh-github-panel-repo-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}",
				".dsh-github-panel-repo-meta{flex:none;color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:11px}"
			].join("\n");

			owned.add(button);
			owned.add(panel);
			owned.add(style);
			document.head.append(style);
			document.body.append(panel);
			const panelBody = mountPanel(ctx, panel);

			const togglePanel = () => {
				panel.hidden = !panel.hidden;
				if (!panel.hidden && panelBody) refreshPanel(ctx, panelBody);
			};
			button.addEventListener("click", togglePanel);

			// Find the sidebar: `[data-pane='sidebar']` is the stable root the
			// shipped sidebar and skin plugins both target (maid-atelier uses the
			// same selector). Prefer its footer area (settings row) so the icon
			// sits among the rail controls; fall back to the sidebar root.
			let mounted = false;
			const tryMount = () => {
				if (mounted) return;
				const sidebar = document.querySelector("[data-pane='sidebar']") ?? document.querySelector("[class*='sidebarCol']");
				if (!sidebar) return;
				const settingsSlot = sidebar.querySelector("[data-slot='sidebar.settings']");
				const collapsed = sidebar.closest?.("[data-sidebar-size='rail']") !== void 0 || document.body.dataset?.maidSidebarSize === "rail";
				if (collapsed || settingsSlot === null) button.dataset.sidebarRail = "";
				if (settingsSlot) {
					settingsSlot.parentElement?.insertBefore(button, settingsSlot);
				} else {
					sidebar.append(button);
				}
				mounted = true;
			};
			tryMount();
			if (!mounted) {
				const observer = new MutationObserver(() => tryMount());
				observer.observe(document.body, { childList: true, subtree: true });
				owned.add(observer);
			}

			return () => {
				for (const node of owned) {
					if (node instanceof MutationObserver) node.disconnect();
					else node.remove();
				}
				owned.clear();
			};
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
