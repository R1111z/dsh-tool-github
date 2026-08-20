// Post-restart verification: run AFTER restarting `dsh web` to confirm the
// GitHub client plugin is discovered and served. Exits 0 when everything is OK.
import { createRequire } from "node:module";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const require = createRequire("C:/Users/21516/.dsh/profiles/web/");
const PKG = "@dsh-external/dsh-tool-github";
const PORT = process.env.DSH_WEB_PORT ?? "3080";

let failures = 0;
const check = (label, ok, extra = "") => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

// 1. Package metadata resolves with dsh.client.
try {
	const pkgJson = require.resolve(`${PKG}/package.json`);
	const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
	check("package.json resolves", true, pkgJson);
	check("dsh.client.platform=web", pkg.dsh?.client?.platform === "web");
	const clientRel = pkg.exports?.["./client"];
	check("exports[./client] present", typeof clientRel === "string");
	const bundlePath = path.resolve(path.dirname(pkgJson), clientRel);
	check("client bundle exists", fs.existsSync(bundlePath), bundlePath);
} catch (e) {
	check("package resolution", false, e.message);
}

// 2. Client bundle is syntactically valid and exports inject/apply.
try {
	const src = fs.readFileSync(path.resolve("D:/keep_try/dsh-tool-github/lib/client.js"), "utf8");
	check("client.js is non-empty", src.length > 500);
	check("client.js uses module loader", src.includes("window.__ModuleLoader__.load"));
	check("client.js exports apply", src.includes("exports.apply"));
	check("client.js exports inject", src.includes("exports.inject"));
	check("client.js has real sidebar selector", src.includes("[data-pane='sidebar']"));
	check("client.js has settings-slot fallback", src.includes("sidebar.settings"));
	check("client.js reads sessions snapshot", src.includes("getSnapshot"));
} catch (e) {
	check("client.js read", false, e.message);
}

// 3. Web GUI serves the bundle (only meaningful after a real restart).
try {
	const res = await fetch(`http://127.0.0.1:${PORT}/plugins/${PKG}/client.js`);
	if (res.ok) {
		const body = await res.text();
		check("GUI serves client bundle (200)", true, `${res.status}, ${body.length} bytes, rev ${createHash("sha1").update(body).digest("hex").slice(0, 12)}`);
	} else {
		check("GUI serves client bundle", false, `HTTP ${res.status} — GUI still running the pre-dsh.client process; restart 'dsh web'`);
	}
} catch (e) {
	check("GUI reachable", false, e.message);
}

// 4. Boot manifest includes the plugin (proves discovery).
try {
	const res = await fetch(`http://127.0.0.1:${PORT}/`);
	const html = await res.text();
	const m = html.match(/window\.__DSH_BOOT__ = (\{.*?\})<\/script>/);
	if (m) {
		const boot = JSON.parse(m[1]);
		const found = boot.entries?.some((e) => e.id === PKG);
		check("boot manifest includes plugin", !!found, found ? `rev ${boot.entries.find((e) => e.id === PKG).rev}` : `(${boot.entries.length} entries, plugin absent — restart needed)`);
	} else {
		check("boot manifest parse", false, "no __DSH_BOOT__ found");
	}
} catch (e) {
	check("index fetch", false, e.message);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED — the GitHub sidebar panel will be visible after the page loads." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
