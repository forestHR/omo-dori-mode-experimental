#!/usr/bin/env bun
// omo-login-share: one omo login (zzangdori, oriclaw) borrowed by okdori, moodori, yoodori, gongdori and soodori.
// Only this account redeems refresh grants; borrowers receive access tokens with the refresh
// replaced by a placeholder, so no copy can rotate a grant out from under the others.
// Tokens travel on stdin only (never argv, env, logs or the state dir).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chooseLoginMethod } from "./login-method.js";

const HOME = homedir();
const BORROWERS = ["okdori", "moodori", "yoodori", "gongdori", "soodori"] as const;
const SOURCE_AUTH = process.env.OLS_SOURCE_AUTH ?? join(HOME, ".omo/agent/auth.json");
const GLOBAL = join(HOME, ".bun/install/global/node_modules");
const SENPI = join(GLOBAL, "@code-yeongyu/senpi/dist");
const PIAI = join(GLOBAL, "@earendil-works/pi-ai/dist");
const STATE_DIR = process.env.OLS_STATE_DIR ?? join(HOME, ".dori/state/omo-shared-login");
const LOGIN_DIR = join(STATE_DIR, "login");
const NODE_DORI_DO = join(HOME, ".local/bin/node-dori-do");
const DORI = join(HOME, ".bun/bin/dori");
const UNIT_PATH = `${HOME}/.bun/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`;
const REFRESH_AHEAD_MS = 90 * 60_000;
const ALERT_REPEAT_MS = 6 * 3600_000;
const LOGIN_TIMEOUT_MS = 30 * 60_000;
const UNITS = ["omo-login-share.service", "omo-login-share.timer", "omo-login-share.path", "omo-login-share-failed.service"];

type Json = Record<string, any>;
type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
	const positional: string[] = [];
	const flags: Flags = {};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === undefined) continue;
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const name = arg.slice(2);
		const value = argv[index + 1];
		if (value !== undefined && !value.startsWith("--")) {
			flags[name] = value;
			index++;
		} else flags[name] = true;
	}
	return { positional, flags };
}

const kst = (ms: number | undefined) =>
	typeof ms === "number" && Number.isFinite(ms)
		? new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(5, 16) + " KST"
		: "-";
const digest = (value: unknown) =>
	typeof value === "string" && value !== "" ? createHash("sha256").update(value).digest("hex").slice(0, 8) : null;
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function loadState(): Json {
	try {
		return JSON.parse(readFileSync(join(STATE_DIR, "state.json"), "utf-8"));
	} catch {
		return { alerts: {}, rejectedGrants: {} };
	}
}
function saveState(state: Json) {
	mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	writeFileSync(join(STATE_DIR, "state.json"), JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function senpi() {
	const auth = await import(join(SENPI, "core/auth-storage.js"));
	const failure = await import(join(SENPI, "core/extensions/builtin/anthropic-subscription/refresh-failure.js"));
	const refresh = await import(join(PIAI, "auth/oauth-refresh.js"));
	const providers = await import(join(PIAI, "providers/all.js"));
	const anthropic = await import(join(PIAI, "auth/oauth/anthropic.js"));
	return { auth, failure, refresh, providers, anthropic };
}

function oauthFor(lib: Awaited<ReturnType<typeof senpi>>, providerId: string) {
	if (providerId === "anthropic-subscription") return lib.anthropic.anthropicOAuth;
	return lib.providers.builtinProviders().find((provider: Json) => provider.id === providerId)?.auth?.oauth;
}

async function readSource(lib: Awaited<ReturnType<typeof senpi>>): Promise<Json> {
	const backend = new lib.auth.FileAuthStorageBackend(SOURCE_AUTH);
	const text = await backend.withLockAsync(async (current: string | undefined) => ({ result: current }));
	return text ? JSON.parse(text) : {};
}

function refreshableSlots(entry: Json): { slotName: string | undefined; refresh: string; expires: number }[] {
	if (entry?.type !== "oauth") return [];
	const slots = Array.isArray(entry.accounts) && entry.accounts.length > 0 ? entry.accounts : undefined;
	const list = slots
		? slots.map((slot: Json) => ({ slotName: slot.name, refresh: slot.refresh, expires: slot.expires, source: slot.source }))
		: [{ slotName: undefined, refresh: entry.refresh, expires: entry.expires, source: "login" }];
	return list.filter(
		(slot: Json) =>
			slot.source !== "env" &&
			typeof slot.refresh === "string" &&
			slot.refresh !== "" &&
			!slot.refresh.endsWith("-managed") &&
			typeof slot.expires === "number",
	);
}

async function refreshAhead(lib: Awaited<ReturnType<typeof senpi>>, state: Json, force: Set<string>) {
	const store = lib.auth.AuthStorage.create(SOURCE_AUTH);
	const source = await readSource(lib);
	const refreshed: string[] = [];
	const failures: { key: string; rejected: boolean; message: string }[] = [];
	for (const [providerId, entry] of Object.entries(source)) {
		for (const slot of refreshableSlots(entry as Json)) {
			const key = `${providerId}/${slot.slotName ?? "default"}`;
			const forced = force.has(key);
			if (!forced && Date.now() < slot.expires - REFRESH_AHEAD_MS) continue;
			const grant = digest(slot.refresh) as string;
			if (!forced && state.rejectedGrants[key] === grant) {
				failures.push({ key, rejected: true, message: "grant rejected earlier; waiting for a new login" });
				continue;
			}
			const oauth = oauthFor(lib, providerId);
			if (!oauth?.refresh) continue;
			const view = (credential: Json) =>
				slot.slotName === undefined ? credential : lib.refresh.projectOAuthSlot(credential, slot.slotName);
			const stale = view(entry as Json);
			try {
				await lib.refresh.refreshOAuthCredential({
					credentials: store,
					providerId,
					slotName: slot.slotName,
					oauth,
					stale,
					isStale: (current: Json) =>
						forced ? current.refresh === stale.refresh : Date.now() >= current.expires - REFRESH_AHEAD_MS,
					signal: AbortSignal.timeout(60_000),
					owning: true,
				});
				refreshed.push(key);
				delete state.rejectedGrants[key];
			} catch (error: any) {
				const cause = error?.cause ?? error;
				const rejected = lib.failure.isGrantRejected(cause);
				if (rejected) state.rejectedGrants[key] = grant;
				failures.push({ key, rejected, message: (String(cause?.message ?? cause).split("\n")[0] ?? "").slice(0, 160) });
			}
		}
	}
	return { refreshed, failures };
}

let remoteCodeCache: string | undefined;
function remoteCode(): string {
	if (remoteCodeCache) return remoteCodeCache;
	const borrow = readFileSync(join(import.meta.dir, "borrow.js"), "utf-8").replace(/^export /gm, "");
	const remote = readFileSync(join(import.meta.dir, "remote.js"), "utf-8").replace(
		/^import \{[^}]*\} from "\.\/borrow\.js";\n/m,
		"",
	);
	const imports = (remote.match(/^import .*;$/gm) ?? []).join("\n");
	remoteCodeCache = `${imports}\n${borrow}\n${remote.replace(/^import .*;\n/gm, "")}`;
	return remoteCodeCache;
}

const REMOTE_BOOT =
	'const m=JSON.parse(await Bun.stdin.text());globalThis.__OLS_INPUT=m.input;await import("data:text/javascript;base64,"+m.code)';

async function runRemote(account: string, payload: Json): Promise<Json> {
	const child = Bun.spawn([NODE_DORI_DO, account, "bun", "-e", REMOTE_BOOT], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		cwd: "/tmp",
	});
	child.stdin.write(JSON.stringify({ code: Buffer.from(remoteCode()).toString("base64"), input: payload }));
	child.stdin.end();
	const [out, err, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exit !== 0) {
		const lines = err.split("\n").map((line) => line.trim()).filter(Boolean);
		const reason = lines.findLast((line) => /\b\w*Error\b|error:/i.test(line)) ?? lines.at(-1) ?? `exit ${exit}`;
		return { ok: false, account, error: reason.slice(0, 200) };
	}
	return JSON.parse(out.trim().split("\n").pop() as string);
}

function agentDirFor(account: string, flags: Flags): string | undefined {
	return typeof flags["test-dir"] === "string" ? join("/home", account, flags["test-dir"]) : undefined;
}

function targets(flags: Flags): string[] {
	const only = typeof flags.only === "string" ? flags.only.split(",") : [...BORROWERS];
	for (const account of only) if (!(BORROWERS as readonly string[]).includes(account)) throw new Error(`unknown account ${account}`);
	return only;
}

async function leadPane(): Promise<string | undefined> {
	const result = await Bun.$`${DORI} lead`.nothrow().quiet();
	return result.stdout.toString().trim().split(/\s+/)[1];
}

async function notifyLead(text: string): Promise<boolean> {
	const clean = text.replace(/[`]/g, "'").replace(/\$\(/g, "(");
	const pane = await leadPane();
	if (!pane) {
		console.error(`NOTIFY_FAILED no lead pane: ${clean}`);
		return false;
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = await Bun.$`${DORI} type ${pane} --text ${clean}`.nothrow().quiet();
		if (result.stdout.toString().includes("SUBMITTED") && result.exitCode === 0) {
			console.error(`NOTIFIED ${pane}: ${clean.slice(0, 120)}`);
			return true;
		}
	}
	console.error(`NOTIFY_FAILED ${pane}: ${clean}`);
	return false;
}

async function alert(state: Json, key: string, active: boolean, text: string, onFirst?: () => Promise<void>) {
	const last = state.alerts[key];
	if (active) {
		if (last && Date.now() - last < ALERT_REPEAT_MS) return;
		state.alerts[key] = Date.now();
		await notifyLead(`[ALERT] omo-shared-login | ${text}`);
		if (!last && onFirst) await onFirst();
	} else if (last) {
		await notifyLead(`[ALERT] omo-shared-login | 회복: ${key}`);
		delete state.alerts[key];
	}
}

async function startLoginUnit(providerId: string, slotName: string | undefined) {
	const unit = `omo-login-share-login-${providerId}-${slotName ?? "default"}`.replace(/[^A-Za-z0-9_-]/g, "-");
	const args = [join(HOME, ".bun/bin/bun"), join(import.meta.dir, "omo-login-share.ts"), "login", providerId, "--notify"];
	if (slotName) args.push("--account", slotName);
	const setenv = ["--setenv", `PATH=${UNIT_PATH}`];
	for (const name of ["OLS_SOURCE_AUTH", "OLS_STATE_DIR"])
		if (process.env[name]) setenv.push("--setenv", `${name}=${process.env[name]}`);
	await Bun.$`systemd-run --user --collect --unit ${unit} ${setenv} ${args}`.nothrow().quiet();
}

async function sync(flags: Flags) {
	const lib = await senpi();
	const state = loadState();
	state.alerts ??= {};
	state.rejectedGrants ??= {};
	const force = new Set(typeof flags["force-refresh"] === "string" ? flags["force-refresh"].split(",") : []);
	const ahead = flags["no-refresh"] ? { refreshed: [], failures: [] } : await refreshAhead(lib, state, force);
	const source = await readSource(lib);
	const pushes: Json = {};
	const at = stamp();
	for (const account of targets(flags)) {
		const result = await runRemote(account, { action: "push", agentDir: agentDirFor(account, flags), source, stamp: at });
		pushes[account] = result;
	}
	const report = {
		at: new Date().toISOString(),
		refreshed: ahead.refreshed,
		refreshFailures: ahead.failures,
		pushes: Object.fromEntries(
			Object.entries(pushes).map(([account, result]) => [
				account,
				result.ok
					? { ok: true, changed: result.changed, holdsNoGrant: result.holdsNoGrant, removed: result.removed, backup: result.backup, agentDir: result.agentDir }
					: { ok: false, error: result.error },
			]),
		),
	};
	if (!flags["no-alert"]) {
		for (const failure of ahead.failures) {
			const [providerId = "", slotName] = failure.key.split("/");
			await alert(
				state,
				`needs_login:${failure.key}`,
				failure.rejected,
				`짱돌 로그인 풀림: ${failure.key} 갱신 거부(${failure.message}). 로그인 링크를 리드에게 보냅니다(omo-login-share login). 형이 승인하면 다섯 도리에 자동 반영됩니다.`,
				() => startLoginUnit(providerId, slotName === "default" && !Array.isArray((source[providerId] as Json)?.accounts) ? undefined : slotName),
			);
			const entry = source[providerId] as Json;
			const slot = refreshableSlots(entry).find((candidate) => (candidate.slotName ?? "default") === slotName);
			await alert(
				state,
				`refresh_failing:${failure.key}`,
				!failure.rejected && slot !== undefined && slot.expires - Date.now() < 30 * 60_000,
				`짱돌 토큰 갱신이 계속 실패(${failure.message}), ${failure.key} 만료 ${kst(slot?.expires)}.`,
			);
		}
		for (const key of Object.keys(state.alerts)) {
			const [kind, rest] = [key.split(":")[0], key.slice(key.indexOf(":") + 1)];
			if (kind === "needs_login" && !ahead.failures.some((failure) => failure.rejected && failure.key === rest))
				await alert(state, key, false, "");
			if (kind === "refresh_failing" && !ahead.failures.some((failure) => !failure.rejected && failure.key === rest))
				await alert(state, key, false, "");
		}
		for (const account of BORROWERS) {
			const result = pushes[account];
			if (!result) continue;
			await alert(state, `push_failed:${account}`, !result.ok || result.holdsNoGrant === false, `${account}에 로그인 반영 실패: ${result.error ?? "refresh 값이 남아 있음"}.`);
		}
	}
	if (!flags["test-dir"]) state.lastSync = report;
	saveState(state);
	if (!flags.quiet) console.log(JSON.stringify(report, null, 2));
	const failed = Object.values(report.pushes).some((push: Json) => !push.ok);
	if (failed) process.exitCode = 1;
}

function sourceRows(source: Json) {
	const rows: Json[] = [];
	for (const [providerId, entry] of Object.entries(source)) {
		if ((entry as Json)?.type !== "oauth") continue;
		const slots = Array.isArray((entry as Json).accounts) ? (entry as Json).accounts : [{ name: "(flat)", ...(entry as Json) }];
		for (const slot of slots) rows.push({ providerId, name: slot.name, access: digest(slot.access), expires: slot.expires, blockReason: slot.blockReason ?? null });
	}
	return rows;
}

async function status(flags: Flags) {
	const lib = await senpi();
	const source = await readSource(lib);
	const rows = sourceRows(source);
	const remote: Json = {};
	for (const account of targets(flags)) remote[account] = await runRemote(account, { action: "status", agentDir: agentDirFor(account, flags) });
	const lines = [`source oriclaw ${SOURCE_AUTH}`];
	for (const row of rows) lines.push(`  ${`${row.providerId}/${row.name}`.padEnd(38)} access ${row.access} 만료 ${kst(row.expires)}${row.blockReason ? ` [${row.blockReason}]` : ""}`);
	let allBorrowed = true;
	for (const [account, result] of Object.entries(remote)) {
		if (!result.ok) {
			allBorrowed = false;
			lines.push(`${account}: ERROR ${result.error}`);
			continue;
		}
		lines.push(`${account} ${result.agentDir} holdsNoGrant=${result.holdsNoGrant} backups=${result.backups.length}`);
		for (const row of rows) {
			const slots = result.state[row.providerId]?.slots ?? [];
			const mine = slots.find((slot: Json) => slot.name === row.name);
			const same = mine?.access === row.access && mine?.refresh === "placeholder";
			if (!same) allBorrowed = false;
			lines.push(`  ${`${row.providerId}/${row.name}`.padEnd(38)} ${same ? "BORROWED" : "DIFFERENT"} access ${mine?.access ?? "-"} refresh ${mine?.refresh ?? "-"}${mine?.blockReason ? ` [${mine.blockReason}]` : ""}`);
		}
	}
	const state = loadState();
	lines.push(`last sync ${state.lastSync?.at ?? "-"}; open alerts ${Object.keys(state.alerts ?? {}).join(", ") || "none"}`);
	lines.push(allBorrowed ? "STATUS_ALL_BORROWED" : "STATUS_NOT_ALL_BORROWED");
	console.log(lines.join("\n"));
	if (!allBorrowed) process.exitCode = 1;
}

function unitText(): Record<string, string> {
	const bun = join(HOME, ".bun/bin/bun");
	const script = join(import.meta.dir, "omo-login-share.ts");
	const env = `Environment=PATH=${UNIT_PATH}\n`;
	return {
		"omo-login-share.service": `[Unit]\nDescription=omo shared login: refresh zzangdori's login ahead and lend it to okdori, moodori, yoodori, gongdori, soodori\nOnFailure=omo-login-share-failed.service\n\n[Service]\nType=oneshot\n${env}ExecStart=${bun} ${script} sync --quiet\n`,
		"omo-login-share.timer": `[Unit]\nDescription=omo shared login every 3 minutes\n\n[Timer]\nOnBootSec=1min\nOnUnitActiveSec=3min\nAccuracySec=15s\n\n[Install]\nWantedBy=timers.target\n`,
		"omo-login-share.path": `[Unit]\nDescription=omo shared login on every change of zzangdori's auth.json\n\n[Path]\nPathChanged=${SOURCE_AUTH}\nUnit=omo-login-share.service\nTriggerLimitIntervalSec=60\nTriggerLimitBurst=20\n\n[Install]\nWantedBy=default.target\n`,
		"omo-login-share-failed.service": `[Unit]\nDescription=omo shared login failure alert to the lead\n\n[Service]\nType=oneshot\n${env}ExecStart=${bun} ${script} alert-failed\n`,
	};
}

async function enable(flags: Flags) {
	const dir = join(HOME, ".config/systemd/user");
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(unitText())) writeFileSync(join(dir, name), text);
	await sync({ ...flags, quiet: false });
	await Bun.$`systemctl --user daemon-reload`.quiet();
	await Bun.$`systemctl --user enable --now omo-login-share.timer omo-login-share.path`.quiet();
	const active = await Bun.$`systemctl --user is-active omo-login-share.timer omo-login-share.path`.nothrow().quiet();
	console.log(`units: ${active.stdout.toString().trim().replace(/\n/g, " ")}`);
	console.log("ENABLED (rollback: omo-login-share disable)");
}

async function disable(flags: Flags) {
	await Bun.$`systemctl --user disable --now omo-login-share.timer omo-login-share.path`.nothrow().quiet();
	const at = stamp();
	let allRestored = true;
	for (const account of targets(flags)) {
		const result = await runRemote(account, { action: "restore", agentDir: agentDirFor(account, flags), stamp: at });
		if (!result.ok || !result.restored) allRestored = false;
		console.log(`${account}: ${result.ok ? (result.restored ? `restored ${result.backup} identical=${result.identical}` : result.reason) : `ERROR ${result.error}`}`);
	}
	if (!flags["test-dir"]) {
		const dir = join(HOME, ".config/systemd/user");
		for (const name of UNITS) rmSync(join(dir, name), { force: true });
		await Bun.$`systemctl --user daemon-reload`.nothrow().quiet();
	}
	console.log(allRestored ? "DISABLED" : "DISABLED_WITH_ERRORS");
	if (!allRestored) process.exitCode = 1;
}

function waitForCode(id: string, signal: AbortSignal): Promise<string> {
	const path = join(LOGIN_DIR, `${id}.code`);
	return new Promise((resolve, reject) => {
		const take = () => {
			if (!existsSync(path)) return false;
			const code = readFileSync(path, "utf-8").trim();
			rmSync(path, { force: true });
			watcher.close();
			clearTimeout(timer);
			resolve(code);
			return true;
		};
		const watcher = watch(LOGIN_DIR, () => void take());
		const timer = setTimeout(() => {
			watcher.close();
			reject(new Error("login timed out waiting for the pasted code"));
		}, LOGIN_TIMEOUT_MS);
		signal.addEventListener("abort", () => {
			watcher.close();
			clearTimeout(timer);
			reject(signal.reason);
		});
		take();
	});
}

async function login(positional: string[], flags: Flags) {
	const providerId = positional[0];
	if (!providerId) throw new Error("usage: omo-login-share login <anthropic-subscription|chatgpt-subscription|xai> [--account NAME] [--notify]");
	const account = typeof flags.account === "string" ? flags.account : undefined;
	const lib = await senpi();
	mkdirSync(LOGIN_DIR, { recursive: true, mode: 0o700 });
	const id = `${providerId}-${account ?? "new"}-${Date.now()}`;
	writeFileSync(join(LOGIN_DIR, `${id}.pending`), JSON.stringify({ providerId, account, pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
	const controller = new AbortController();
	for (const signal of ["SIGTERM", "SIGINT"] as const)
		process.once(signal, () => controller.abort(new Error(`login cancelled (${signal})`)));
	const say = async (text: string) => {
		console.log(text);
		if (flags.notify) await notifyLead(text);
	};
	const pasteHint = `형이 승인한 뒤 브라우저에 나온 코드(또는 마지막 주소)를 스레드에 붙여 주면 짱돌에서 omo-login-share code 붙인값 을 실행.`;
	const interaction = {
		signal: controller.signal,
		notify: async (event: Json) => {
			if (event.type === "auth_url") await say(`[LOGIN] omo-shared-login | ${providerId}${account ? `/${account}` : ""} 형에게 보낼 링크: ${event.url} -- ${pasteHint}`);
			else if (event.type === "device_code") await say(`[LOGIN] omo-shared-login | ${providerId}${account ? `/${account}` : ""} 형에게 보낼 링크: ${event.verificationUri} (코드 ${event.userCode}) -- 형은 링크를 열고 승인만 하면 끝.`);
			else if (event.message) console.log(event.message);
		},
		prompt: async (prompt: Json) => {
			if (prompt.type === "manual_code") return waitForCode(id, prompt.signal ?? controller.signal);
			if (prompt.type === "select") return chooseLoginMethod(providerId, prompt.options);
			throw new Error(`login needs interactive input (${prompt.type}); run /login in zzangdori's omo instead`);
		},
	};
	try {
		if (providerId === "anthropic-subscription") {
			const accounts = await import(join(SENPI, "core/extensions/builtin/anthropic-subscription/accounts.js"));
			const credential = await lib.anthropic.anthropicOAuth.login(interaction);
			const store = lib.auth.AuthStorage.create(SOURCE_AUTH);
			await store.modify(providerId, async (current: Json | undefined) => {
				const base = current?.type === "oauth" ? current : accounts.emptyCredential();
				const existing = Array.isArray(base.accounts) ? base.accounts : [];
				const blocked = existing.filter((slot: Json) => slot.blockReason === "auth_error");
				const name = account ?? (blocked.length === 1 ? blocked[0].name : existing.length === 0 ? "default" : `account-${existing.length + 1}`);
				return accounts.upsertAccount(base, { name, access: credential.access, refresh: credential.refresh, expires: credential.expires, source: "login" });
			});
		} else {
			const oauth = oauthFor(lib, providerId);
			if (!oauth?.login) throw new Error(`no OAuth login for ${providerId}`);
			const credential = await oauth.login(interaction);
			const store = lib.auth.AuthStorage.create(SOURCE_AUTH);
			if (account) await store.modify(providerId, async (current: Json | undefined) => replaceSlot(current, account, credential));
			else store.set(providerId, credential);
		}
		const state = loadState();
		for (const key of Object.keys(state.rejectedGrants ?? {})) if (key.startsWith(`${providerId}/`)) delete state.rejectedGrants[key];
		saveState(state);
		await sync({ "no-refresh": true, quiet: true });
		await say(`[LOGIN] omo-shared-login | ${providerId}${account ? `/${account}` : ""} 로그인 완료, 옥돌·무돌·유돌·공돌에 반영함.`);
	} catch (error) {
		const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
		if (flags.notify)
			await notifyLead(`[ALERT] omo-shared-login | ${providerId}${account ? `/${account}` : ""} 로그인이 끝나지 못함: ${message}. 다시 하려면 omo-login-share login ${providerId}${account ? ` --account ${account}` : ""} --notify`);
		throw error;
	} finally {
		rmSync(join(LOGIN_DIR, `${id}.pending`), { force: true });
	}
}

function replaceSlot(current: Json | undefined, name: string, credential: Json): Json {
	const { type: _type, accounts: _accounts, pinned: _pinned, ...material } = credential;
	if (current?.type !== "oauth" || !Array.isArray(current.accounts)) return credential;
	const exists = current.accounts.some((slot: Json) => slot.name === name);
	const accounts = exists
		? current.accounts.map((slot: Json) => {
				if (slot.name !== name) return slot;
				const { blockedUntil: _b, blockReason: _r, modelBlocks: _m, authRecoveryGrant: _g, ...identity } = slot;
				return { ...identity, ...material, source: "login" };
			})
		: [...current.accounts, { name, ...material, source: "login" }];
	const target = current.accounts.find((slot: Json) => slot.name === name);
	const mirrorsFlat = target && (target.access === current.access || target.refresh === current.refresh);
	return mirrorsFlat ? { ...current, ...material, accounts } : { ...current, accounts };
}

function code(positional: string[]) {
	const value = positional.join(" ").trim() || readFileSync(0, "utf-8").trim();
	if (!value) throw new Error("usage: omo-login-share code <pasted code or redirect URL>");
	const pending = existsSync(LOGIN_DIR)
		? readdirSync(LOGIN_DIR).filter((name) => name.endsWith(".pending")).sort()
		: [];
	if (pending.length === 0) throw new Error("no login is waiting for a code");
	const id = (pending.at(-1) as string).replace(/\.pending$/, "");
	writeFileSync(join(LOGIN_DIR, `${id}.code`), value, { mode: 0o600 });
	console.log(`CODE_DELIVERED ${id}`);
}

async function main() {
	const [command, ...rest] = process.argv.slice(2);
	const { positional, flags } = parseArgs(rest);
	if (command === "sync") return sync(flags);
	if (command === "status") return status(flags);
	if (command === "enable") return enable(flags);
	if (command === "disable") return disable(flags);
	if (command === "login") return login(positional, flags);
	if (command === "code") return code(positional);
	if (command === "alert-failed") {
		await notifyLead("[ALERT] omo-shared-login | omo-login-share sync 실패. journalctl --user -u omo-login-share 확인 필요.");
		return;
	}
	console.log(
		[
			"omo-login-share status              다섯 도리가 짱돌 로그인을 빌려 쓰는지 표로 보여 줌",
			"omo-login-share sync [--no-refresh] [--force-refresh P/slot] [--only a,b] [--test-dir REL] [--no-alert] [--quiet]",
			"omo-login-share enable              백업 후 반영하고 3분 타이머 + auth.json 감시를 켬",
			"omo-login-share disable             되돌리기: 타이머를 끄고 빌려 쓰는 계정들의 auth.json을 적용 전 백업으로 복원",
			"omo-login-share login <provider> [--account NAME] [--notify]   짱돌에 로그인(링크는 리드에게)",
			"omo-login-share code <붙인 값>       기다리는 로그인에 형이 붙인 코드를 넘김",
		].join("\n"),
	);
	if (command) process.exitCode = 2;
}

await main();
