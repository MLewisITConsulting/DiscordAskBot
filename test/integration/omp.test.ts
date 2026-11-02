/**
 * `/admin/omp` end to end (AGT-20, AGT-23, WEB-33, UPD-02, UPD-03, UPD-10): the web page over the orchestrator's `/omp*`
 * admin API, a real vault, and the omp updater against a fake npm registry.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmpRoutes } from "../../src/orchestrator/api/omp";
import type { CopyInstaller } from "../../src/orchestrator/omp/runtime";
import { createOmpUpdater, type OmpUpdater } from "../../src/orchestrator/omp/updates";
import { dbPath, openDb } from "../../src/orchestrator/store/db";
import { openVault, type Vault } from "../../src/orchestrator/store/vault";
import type { OmpUpdateView } from "../../src/shared/adminOmp";
import { listSettings } from "../../src/shared/ompconfig";
import { OMP_PACKAGE } from "../../src/shared/ompPins";
import { OMP_SAVED, ompPages } from "../../src/web/ompPage";
import { eventually, type PageStack, startPageStack } from "../fakes/adminPages";
import { outsideImageUpdater, TEST_IDENTITY } from "../fakes/ompUpdates";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface Harness {
	stack: PageStack;
	vault: Vault;
}

async function start(opts: { locked?: boolean } = {}): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), "askbot-omp-"));
	const db = openDb(dbPath(dir));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => db.close());
	const setup = await openVault(db);
	await setup.initialize("admin", "correct horse battery");
	// A restarted orchestrator's vault stays locked until the admin logs in.
	const vault = opts.locked ? await openVault(db) : setup;
	const stack = await startPageStack(createOmpRoutes({ vault, updates: outsideImageUpdater(db) }), ompPages);
	return { stack, vault };
}

async function save(h: Harness, fields: Record<string, string> | [string, string][]): Promise<Response> {
	return h.stack.post("/admin/omp", fields);
}

async function saved(h: Harness, fields: Record<string, string> | [string, string][]): Promise<void> {
	const res = await save(h, fields);
	if (res.status !== 303) throw new Error(`save refused (${res.status}): ${(await res.text()).match(/role="alert">([^<]*)/)?.[1]}`);
	expect(res.headers.get("location")).toBe("/admin/omp");
}

/** The error shown on a refused save. */
async function refusal(res: Response): Promise<string> {
	expect(res.status).toBe(400);
	const page = await res.text();
	const message = page.match(/class="error"[^>]*>([^<]*)</)?.[1];
	if (!message) throw new Error("no error shown");
	return message.replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}

describe("omp settings (AGT-20)", () => {
	test("the page shows the version, the pinned settings and the searchable reference", async () => {
		const h = await start();
		const res = await h.stack.get("/admin/omp");
		expect(res.status).toBe(200);
		const page = await res.text();
		expect(page).toContain("Running omp <code>18.12.1</code> (the image's), used by the orchestrator and by workers.");
		expect(page).toContain(`All omp settings (${listSettings().length})`);
		expect(page).toContain('id="omp-ref-filter"');
		for (const [id, value] of [
			["tools.approvalMode", '"yolo"'],
			["ask.timeout", "0"],
			["async.enabled", "false"],
		]) {
			expect(page).toContain(`<td><code>${id}</code> <span class="badge">PINNED</span></td><td><code>${value.replaceAll('"', "&quot;")}</code></td>`);
			// Not offered for overriding.
			expect(page).not.toContain(`<option value="${id}">`);
		}
		expect(page).toContain('<option value="git.enabled">');
	});

	test("overrides are saved through omp's parser; invalid values, unknown and pinned settings are refused", async () => {
		const h = await start();
		await saved(h, { "setting.new.id": "git.enabled", "setting.new.value": "false" });
		expect(await (await h.stack.get("/admin/omp")).text()).toContain(OMP_SAVED);
		expect(h.vault.readOmpConfig()).toEqual({ settings: { "git.enabled": false } });

		const keep = { "setting.0.id": "git.enabled", "setting.0.value": "false" };
		const invalid = await save(h, { ...keep, "setting.new.id": "loop.conditionTimeoutMs", "setting.new.value": "soon" });
		expect(await refusal(invalid)).toStartWith("loop.conditionTimeoutMs: ");
		expect(await refusal(await save(h, { ...keep, "setting.new.id": "symbolPreset", "setting.new.value": "emoji" }))).toStartWith("symbolPreset: ");
		expect(await refusal(await save(h, { ...keep, "setting.new.id": "no.such.setting", "setting.new.value": "1" }))).toBe('Unknown omp setting "no.such.setting"');
		expect(await refusal(await save(h, { ...keep, "setting.new.id": "tools.approvalMode", "setting.new.value": "ask" }))).toStartWith("tools.approvalMode is managed by AskBot");
		expect(await refusal(await save(h, { ...keep, "setting.new.id": "ask.timeout", "setting.new.value": "30" }))).toStartWith("ask.timeout is managed by AskBot");
		// The rejected submission is echoed for correction; nothing was stored.
		const echoed = await (await save(h, { ...keep, "setting.new.id": "loop.conditionTimeoutMs", "setting.new.value": "soon" })).text();
		expect(echoed).toContain('name="setting.new.id" list="omp-setting-ids" placeholder="add setting id" value="loop.conditionTimeoutMs"');
		expect(echoed).toContain(">soon</textarea>");
		expect(h.vault.readOmpConfig()).toEqual({ settings: { "git.enabled": false } });
		// The API refuses pinned settings too.
		expect((await h.stack.api("PUT", "/omp", { settings: [{ id: "async.enabled", value: "true" }] })).status).toBe(400);

		await saved(h, { ...keep, "setting.new.id": "loop.conditionTimeoutMs", "setting.new.value": "45000" });
		expect(h.vault.readOmpConfig()).toEqual({ settings: { "git.enabled": false, "loop.conditionTimeoutMs": 45000 } });
		// Removing a row drops the override.
		await saved(h, { ...keep, "setting.0.remove": "on", "setting.1.id": "loop.conditionTimeoutMs", "setting.1.value": "45000" });
		expect(h.vault.readOmpConfig()).toEqual({ settings: { "loop.conditionTimeoutMs": 45000 } });
	});

	test("credential settings are write-only: never shown, kept when left blank", async () => {
		const h = await start();
		await saved(h, { "setting.new.id": "searxng.token", "setting.new.value": "searx-secret-token" });
		const page = await (await h.stack.get("/admin/omp")).text();
		expect(page).not.toContain("searx-secret-token");
		expect(page).toContain('<input type="password" name="setting.0.value" autocomplete="off" placeholder="blank keeps current"> <span class="hint">set</span>');

		await saved(h, { "setting.0.id": "searxng.token", "setting.0.value": "", "setting.new.id": "git.enabled", "setting.new.value": "true" });
		expect(h.vault.readOmpConfig()).toEqual({ settings: { "searxng.token": "searx-secret-token", "git.enabled": true } });
		// A rejected save doesn't echo a typed credential.
		const refused = await save(h, { "setting.0.id": "searxng.token", "setting.0.value": "typed-new-secret", "setting.new.id": "symbolPreset", "setting.new.value": "emoji" });
		expect(refused.status).toBe(400);
		expect(await refused.text()).not.toContain("typed-new-secret");
		await saved(h, { "setting.0.id": "searxng.token", "setting.0.value": "rotated-token" });
		expect(h.vault.readOmpConfig()).toEqual({ settings: { "searxng.token": "rotated-token" } });
	});

	test("a stored configuration that no longer validates shows the stored overrides, and a save replaces it", async () => {
		const h = await start();
		h.vault.writeOmpConfig({ settings: { "git.enabled": false, "gone.in.this.omp": 1 } });
		const page = await (await h.stack.get("/admin/omp")).text();
		expect(page).toContain("The stored omp configuration no longer validates");
		expect(page).toContain('value="gone.in.this.omp" readonly');
		await saved(h, { "setting.0.id": "git.enabled", "setting.0.value": "false" });
		expect(h.vault.readOmpConfig()).toEqual({ settings: { "git.enabled": false } });
	});

	test("a locked vault is reported, not served", async () => {
		const h = await start({ locked: true });
		const res = await h.stack.get("/admin/omp");
		expect(res.status).toBe(409);
		expect(await res.text()).toContain("Settings are locked");
		expect((await save(h, { "setting.new.id": "git.enabled", "setting.new.value": "true" })).status).toBe(409);
	});
});

/** Updater inside the "image" (a runtime dir), against a fake npm registry; the installer waits for `gate` when given. */
function imageUpdater(opts: { autoUpdate?: () => boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "askbot-omp-upd-"));
	const db = openDb(dbPath(dir));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => db.close());
	const registry = { answer: () => Response.json({ version: "99.2.0" }) };
	const npm = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => registry.answer() });
	cleanups.push(() => void npm.stop(true));
	const install = { gate: undefined as Promise<void> | undefined, fail: undefined as string | undefined };
	const installer: CopyInstaller = async ({ dir: app, version }) => {
		await install.gate;
		if (install.fail) return { output: "npm ERR! something broke", error: install.fail };
		for (const sub of ["src", join("node_modules", OMP_PACKAGE)]) mkdirSync(join(app, sub), { recursive: true });
		writeFileSync(join(app, "package.json"), "{}");
		writeFileSync(join(app, "bun.lock"), "");
		writeFileSync(join(app, "node_modules", OMP_PACKAGE, "package.json"), JSON.stringify({ version }));
		return { output: `installed ${version}` };
	};
	const updater = createOmpUpdater({
		db,
		runtimeDir: join(dir, "omp-runtime"),
		identity: TEST_IDENTITY,
		imageOmpVersion: "18.12.1",
		imageAppDir: dir,
		registryUrl: npm.url.href,
		installer,
		...(opts.autoUpdate ? { autoUpdate: opts.autoUpdate } : {}),
	});
	cleanups.push(() => updater.stop());
	return { db, updater, registry, install };
}

async function pageStack(updater: OmpUpdater): Promise<{ stack: PageStack; vault: Vault }> {
	const dir = mkdtempSync(join(tmpdir(), "askbot-omp-vault-"));
	const db = openDb(dbPath(dir));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => db.close());
	const vault = await openVault(db);
	await vault.initialize("admin", "correct horse battery");
	return { stack: await startPageStack(createOmpRoutes({ vault, updates: updater }), ompPages), vault };
}

/** Waits until no install runs. */
function installed(updater: OmpUpdater): Promise<OmpUpdateView> {
	return eventually(async () => (updater.status().installing ? undefined : updater.status()), "the install to end");
}

describe("the update panel (WEB-33)", () => {
	test("Check now, then Approve update installs the newer omp for workers, recorded with the admin; the page refreshes while it runs", async () => {
		const { updater, registry, install } = imageUpdater();
		const { stack } = await pageStack(updater);

		// Before any check: the image's omp only, no Approve button.
		let page = await (await stack.get("/admin/omp")).text();
		expect(page).toContain("Running omp <code>18.12.1</code> (the image's)");
		expect(page).toContain("<tr><th>Latest found</th><td>not checked yet</td></tr>");
		expect(page).toContain("<tr><th>Last check</th><td>never</td></tr>");
		expect(page).toContain('<form method="post" action="/admin/omp/update-check"><button type="submit">Check now</button></form>');
		expect(page).toContain("<tr><th>Automatic updates</th><td>off");
		expect(page).not.toContain("update-approve");

		// Check now: a newer omp is on offer.
		let res = await stack.post("/admin/omp/update-check", {});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/admin/omp");
		page = await (await stack.get("/admin/omp")).text();
		expect(page).toContain("Checked npm: the latest omp is 99.2.0. omp 99.2.0 is available for workers; approve it below.");
		expect(page).toContain("<tr><th>Latest found</th><td><code>99.2.0</code></td></tr>");
		expect(page).toContain("<tr><th>Update</th><td>omp 99.2.0 is available</td></tr>");
		expect(page).toContain('<input type="hidden" name="version" value="99.2.0"><button type="submit">Approve update to omp 99.2.0</button>');

		// Approve: the install runs; the page shows it, offers no second approval and polls until it ends.
		const gate = Promise.withResolvers<void>();
		install.gate = gate.promise;
		res = await stack.post("/admin/omp/update-approve", { version: "99.2.0" });
		expect(res.status).toBe(303);
		page = await (await stack.get("/admin/omp")).text();
		expect(page).toContain("Installing omp 99.2.0 for workers.");
		expect(page).toContain("installing omp 99.2.0 (approved by admin at");
		expect(page).toContain("<tr><th>Current attempt</th><td>omp 99.2.0 (from 18.12.1): <strong>installing</strong>; approved by admin,");
		expect(page).not.toContain("Approve update to");
		expect(page).toContain('fetch("/admin/omp/update.json"');
		// A second approval while it runs is refused (UPD-03).
		res = await stack.post("/admin/omp/update-approve", { version: "99.2.0" });
		page = await (await stack.get("/admin/omp")).text();
		expect(page).toContain("The update was not started: omp 99.2.0 is already being installed (approved by admin)");
		expect(((await (await stack.get("/admin/omp/update.json")).json()) as OmpUpdateView).installing).toMatchObject({ version: "99.2.0", by: "admin" });

		gate.resolve();
		await installed(updater);
		page = await (await stack.get("/admin/omp")).text();
		expect(page).toContain("Workers use omp <code>99.2.0</code>");
		expect(page).toContain("The orchestrator keeps the image's omp <code>18.12.1</code>");
		expect(page).toContain("<tr><th>Last attempt</th><td>omp 99.2.0 (from 18.12.1): <strong>installed</strong>; approved by admin,");
		expect(page).toContain("<pre>installed 99.2.0");
		expect(page).toContain("<tr><th>Update</th><td>up to date</td></tr>");
		expect(page).not.toContain('fetch("/admin/omp/update.json"');

		// A stale approval (the version is no longer on offer) is refused.
		res = await stack.post("/admin/omp/update-approve", { version: "99.2.0" });
		page = await (await stack.get("/admin/omp")).text();
		expect(page).toContain("The update was not started: omp 99.2.0 is no longer the update on offer");

		// A failed check is stored and shown, and the last good answer stays.
		registry.answer = () => new Response("down", { status: 502 });
		await stack.post("/admin/omp/update-check", {});
		page = await (await stack.get("/admin/omp")).text();
		expect(page).toContain("The npm check failed: the npm registry answered 502");
		expect(page).toContain('<tr><th>Check error</th><td><span class="error">the npm registry answered 502</span></td></tr>');
		expect(page).toContain("<tr><th>Latest found</th><td><code>99.2.0</code></td></tr>");
	});

	test("a failed install leaves the current omp, shows the error and output tail, and offers Approve again", async () => {
		const { updater, install } = imageUpdater();
		const { stack } = await pageStack(updater);
		await updater.check();
		install.fail = "bun install exited with code 1";
		await stack.post("/admin/omp/update-approve", { version: "99.2.0" });
		await installed(updater);
		const page = await (await stack.get("/admin/omp")).text();
		expect(page).toContain("Running omp <code>18.12.1</code> (the image's)");
		expect(page).toContain("<strong>failed</strong>; approved by admin,");
		expect(page).toContain('<div class="error">bun install exited with code 1</div>');
		expect(page).toContain("npm ERR! something broke");
		expect(page).toContain("Approve update to omp 99.2.0");
	});

	test("with omp.autoUpdate on, a check installs at once as auto-update; a version whose last attempt failed is not retried automatically (UPD-02, UPD-03)", async () => {
		let autoUpdate = true;
		const { updater, registry, install } = imageUpdater({ autoUpdate: () => autoUpdate });
		const { stack } = await pageStack(updater);
		install.fail = "smoke load failed";
		await stack.post("/admin/omp/update-check", {});
		await installed(updater);
		let page = await (await stack.get("/admin/omp")).text();
		expect(page).toContain("<tr><th>Automatic updates</th><td>on");
		expect(page).toContain("omp 99.2.0 (from 18.12.1): <strong>failed</strong>; started automatically,");
		expect(page).toContain("Approve update to omp 99.2.0");

		// The next check does not try the failed version again.
		install.fail = undefined;
		await updater.check();
		expect(updater.status().installing).toBeUndefined();
		expect(updater.status().attempt).toMatchObject({ version: "99.2.0", outcome: "failed", by: "auto-update" });

		// A newer version is tried automatically.
		registry.answer = () => Response.json({ version: "99.3.0" });
		await updater.check();
		expect(updater.status().installing).toMatchObject({ version: "99.3.0", by: "auto-update" });
		expect((await installed(updater)).attempt).toMatchObject({ version: "99.3.0", outcome: "installed", by: "auto-update" });
		page = await (await stack.get("/admin/omp")).text();
		expect(page).toContain("omp 99.3.0 (from 18.12.1): <strong>installed</strong>; started automatically,");
		expect(page).toContain("installed automatically");

		// Off: nothing installs by itself.
		autoUpdate = false;
		registry.answer = () => Response.json({ version: "99.4.0" });
		await updater.check();
		expect(updater.status()).toMatchObject({ autoUpdate: false, available: "99.4.0" });
		expect(updater.status().installing).toBeUndefined();
	});

	test("outside the image the panel says updates are refused (UPD-05) and offers no approval", async () => {
		const h = await start();
		const page = await (await h.stack.get("/admin/omp")).text();
		expect(page).toContain("omp updates run only in the container image");
		expect(page).not.toContain("update-approve");
	});
});
