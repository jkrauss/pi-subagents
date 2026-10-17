import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { HERDR_PI_MODE_ENV, herdrPiRuntimeRoot } from "../runs/shared/herdr-pi-protocol.ts";
import { getAgentDir, getProjectConfigDir } from "./utils.ts";

/**
 * The local-tab policy surface lives on its own so that read-only consumers
 * (the doctor report) can describe placement without loading the transport.
 */

/** Every tab this feature creates carries this label prefix; nothing else is ever reaped. */
export const HERDR_LOCAL_TAB_LABEL_PREFIX = "subagent-";
export const HERDR_LOCAL_TAB_MAX_DEFAULT = 4;
/** Mirrors `HERDR_MAX_OWNED_PANES` in `herdr-placed-run.ts`; a unit test keeps both in sync. */
export const HERDR_LOCAL_TAB_PANE_BUDGET = 20;
/** Hard ceiling under the pane budget, even when settings ask for more. */
export const HERDR_LOCAL_TAB_MAX_CEILING = Math.min(12, HERDR_LOCAL_TAB_PANE_BUDGET - 4);
export const HERDR_LOCAL_TAB_STALE_DEFAULT_MINUTES = 30;
export const HERDR_LOCAL_TABS_ENV = "PI_SUBAGENTS_HERDR_TABS";
export const SAFE_LOCAL_TAB_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface HerdrLocalTabSettings {
	mode: "off" | "on";
	agents?: string[];
	maxTabs: number;
	staleAfterMinutes: number;
}

export const DEFAULT_HERDR_LOCAL_TAB_SETTINGS: HerdrLocalTabSettings = { mode: "off", maxTabs: HERDR_LOCAL_TAB_MAX_DEFAULT, staleAfterMinutes: HERDR_LOCAL_TAB_STALE_DEFAULT_MINUTES };

/** Shared journal directory; saved-machine and local placements record their identity here. */
export function herdrRunJournalDir(): string { return path.join(getAgentDir(), "pi-subagents", "herdr-run-journal"); }

function readJsonObject(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
	} catch (error) {
		throw new Error(`Failed to read settings file '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
	}
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

/** Validated `subagents.herdrLocalTabs` overrides; only present fields, so project settings can beat user settings field by field. */
export function parseHerdrLocalTabOverrides(settings: Record<string, unknown>, filePath: string): Partial<HerdrLocalTabSettings> | undefined {
	const subagents = settings.subagents;
	if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return undefined;
	const raw = (subagents as Record<string, unknown>).herdrLocalTabs;
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Subagent settings in '${filePath}' have invalid 'herdrLocalTabs'; expected an object with 'mode', optional 'agents', 'maxTabs', and 'staleAfterMinutes'.`);
	const record = raw as Record<string, unknown>, overrides: Partial<HerdrLocalTabSettings> = {};
	if (record.mode !== undefined) {
		if (record.mode !== "off" && record.mode !== "on") throw new Error(`Subagent settings in '${filePath}' have invalid 'herdrLocalTabs.mode'; expected "off" or "on".`);
		overrides.mode = record.mode;
	}
	if (record.agents !== undefined) {
		if (!Array.isArray(record.agents) || record.agents.some((name) => typeof name !== "string" || !SAFE_LOCAL_TAB_AGENT_NAME.test(name))) throw new Error(`Subagent settings in '${filePath}' have invalid 'herdrLocalTabs.agents'; expected an array of agent names.`);
		// An empty allow-list is literal: nobody is allowed, so placement stays off.
		overrides.agents = [...(record.agents as string[])];
	}
	if (record.maxTabs !== undefined) {
		if (typeof record.maxTabs !== "number" || !Number.isSafeInteger(record.maxTabs) || record.maxTabs < 1 || record.maxTabs > HERDR_LOCAL_TAB_MAX_CEILING) throw new Error(`Subagent settings in '${filePath}' have invalid 'herdrLocalTabs.maxTabs'; expected an integer from 1 to ${HERDR_LOCAL_TAB_MAX_CEILING}.`);
		overrides.maxTabs = record.maxTabs;
	}
	if (record.staleAfterMinutes !== undefined) {
		if (typeof record.staleAfterMinutes !== "number" || !Number.isFinite(record.staleAfterMinutes) || record.staleAfterMinutes < 1 || record.staleAfterMinutes > 24 * 60) throw new Error(`Subagent settings in '${filePath}' have invalid 'herdrLocalTabs.staleAfterMinutes'; expected a number from 1 to 1440.`);
		overrides.staleAfterMinutes = record.staleAfterMinutes;
	}
	return overrides;
}

/** Validates `subagents.herdrLocalTabs`; a malformed block is reported rather than guessed. */
export function parseHerdrLocalTabSettings(settings: Record<string, unknown>, filePath: string): HerdrLocalTabSettings | undefined {
	const overrides = parseHerdrLocalTabOverrides(settings, filePath);
	return overrides === undefined ? undefined : { ...DEFAULT_HERDR_LOCAL_TAB_SETTINGS, ...overrides };
}

export function findProjectSettingsRoot(cwd: string): string {
	let current = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(getProjectConfigDir(current), "settings.json"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(cwd);
		current = parent;
	}
}

/** Project settings beat user settings, field by field, like every other subagent setting. */
export function readHerdrLocalTabSettings(cwd: string): HerdrLocalTabSettings {
	const userPath = path.join(getAgentDir(), "settings.json");
	const projectPath = path.join(getProjectConfigDir(findProjectSettingsRoot(cwd)), "settings.json");
	const user = parseHerdrLocalTabOverrides(readJsonObject(userPath), userPath);
	const project = projectPath === userPath ? undefined : parseHerdrLocalTabOverrides(readJsonObject(projectPath), projectPath);
	return { ...DEFAULT_HERDR_LOCAL_TAB_SETTINGS, ...user, ...project };
}

export function envFlag(env: NodeJS.ProcessEnv, names: readonly string[]): boolean {
	const value = env[HERDR_LOCAL_TABS_ENV]?.trim().toLowerCase();
	return value !== undefined && names.includes(value);
}

let settingsWarningLogged = false;

/**
 * Whether local tabs are enabled at all, ignoring the per-agent filter. The
 * maintenance reaper uses this so that cleaning up leftovers never depends on
 * which agent happens to be running.
 */
export function readEnabledLocalTabPolicy(input: { cwd: string; env?: NodeJS.ProcessEnv }): { enabled: false; reason: string } | { enabled: true; settings: HerdrLocalTabSettings } {
	const env = input.env ?? process.env;
	if (env[HERDR_PI_MODE_ENV] === "1") return { enabled: false, reason: "a placed child never places its own tabs" };
	if (envFlag(env, ["0", "off", "false", "no"])) return { enabled: false, reason: `disabled by ${HERDR_LOCAL_TABS_ENV}` };
	let settings: HerdrLocalTabSettings;
	try {
		settings = readHerdrLocalTabSettings(input.cwd);
	} catch (error) {
		if (!settingsWarningLogged) {
			settingsWarningLogged = true;
			console.warn(`pi-subagents: ${error instanceof Error ? error.message : String(error)} Local tab placement stays off.`);
		}
		return { enabled: false, reason: error instanceof Error ? error.message : String(error) };
	}
	if (!envFlag(env, ["1", "on", "true", "yes"]) && settings.mode !== "on") return { enabled: false, reason: "local tabs are off in subagents.herdrLocalTabs (set mode to \"on\")" };
	return { enabled: true, settings };
}

function countOwnedJournals(): number {
	try {
		return fs.readdirSync(herdrRunJournalDir()).filter((name) => name.endsWith(".json") && !name.endsWith(".placement.json")).length;
	} catch {
		return 0;
	}
}

function countStaleRunDirs(staleAfterMs: number, now: number): number {
	try {
		return fs.readdirSync(herdrPiRuntimeRoot(getAgentDir())).filter((name) => {
			try {
				return now - fs.statSync(path.join(herdrPiRuntimeRoot(getAgentDir()), name)).mtimeMs > staleAfterMs;
			} catch {
				return false;
			}
		}).length;
	} catch {
		return 0;
	}
}

/**
 * Read-only integration preflight for placement: what the policy says, whether
 * Herdr itself is running with a compatible protocol, and whether the Pi
 * integration that feeds tab titles is current. Failures are reported, never thrown.
 */
export function diagnoseHerdrLocalTabs(input: { cwd: string; env?: NodeJS.ProcessEnv }): string[] {
	const env = input.env ?? process.env;
	const lines: string[] = [];
	let settings: HerdrLocalTabSettings | undefined;
	let enabled = false;
	try {
		const policy = readEnabledLocalTabPolicy({ cwd: input.cwd, env });
		enabled = policy.enabled;
		settings = policy.enabled ? policy.settings : readHerdrLocalTabSettings(input.cwd);
		lines.push(policy.enabled
			? `- placement: enabled (cap ${policy.settings.maxTabs}, stale after ${policy.settings.staleAfterMinutes}m, agents ${policy.settings.agents && policy.settings.agents.length > 0 ? policy.settings.agents.join(", ") : "any agent"})`
			: `- placement: disabled — ${policy.reason}`);
	} catch (error) {
		lines.push(`- placement: unreadable settings — ${error instanceof Error ? error.message : String(error)}`);
	}
	lines.push(`- kill switch: ${HERDR_LOCAL_TABS_ENV}=${env[HERDR_LOCAL_TABS_ENV]?.trim() || "unset"}`);
	const socketPath = env.HERDR_SOCKET_PATH?.trim() || path.join(env.XDG_CONFIG_HOME?.trim() || path.join(env.HOME ?? "", ".config"), "herdr", "herdr.sock");
	const socketPresent = fs.existsSync(socketPath);
	lines.push(`- socket: ${socketPath} (${socketPresent ? "present" : "missing"})`);
	if (!socketPresent && env.HERDR_ENV !== "1") {
		// No Herdr endpoint to ask, so the preflight stays silent instead of shelling out blindly.
		lines.push("- herdr server: not checked (no Herdr endpoint on this host)");
		lines.push("- pi integration: not checked (no Herdr endpoint on this host)");
	} else {
		const herdr = env.HERDR_BIN_PATH?.trim() || "herdr";
		try {
			const status = spawnSync(herdr, ["status", "server", "--json"], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
			if (status.error || status.status !== 0) {
				lines.push(`- herdr server: unavailable — ${status.error ? status.error.message : String(status.stderr).trim().slice(0, 200) || `exit ${status.status}`}`);
			} else {
				const value = JSON.parse(status.stdout) as Record<string, unknown>;
				lines.push(`- herdr server: ${value.running === true ? "running" : "not running"}, version ${String(value.version ?? "unknown")}, protocol ${String(value.protocol ?? "unknown")}, compatible ${value.compatible === true ? "yes" : "no"}`);
			}
		} catch (error) {
			lines.push(`- herdr server: unavailable — ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			const integration = spawnSync(herdr, ["integration", "status"], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
			const piLine = String(integration.stdout ?? "").split("\n").find((line) => line.startsWith("pi:"));
			if (integration.error || piLine === undefined) lines.push(`- pi integration: unavailable — ${integration.error ? integration.error.message : "no 'pi:' line reported"}`);
			else lines.push(`- pi integration: ${piLine.trim().slice(0, 200)}${piLine.includes("outdated") || piLine.includes("not installed") ? " — run `herdr integration install pi`" : ""}`);
		} catch (error) {
			lines.push(`- pi integration: unavailable — ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const staleAfterMs = (settings?.staleAfterMinutes ?? HERDR_LOCAL_TAB_STALE_DEFAULT_MINUTES) * 60_000;
	lines.push(`- owned records: ${countOwnedJournals()} journals, ${countStaleRunDirs(staleAfterMs, Date.now())} stale run directories`);
	if (!enabled && settings?.mode !== "on") lines.push("- note: a placed run still falls back to the in-process child whenever placement is unavailable");
	return lines;
}
