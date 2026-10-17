/**
 * Local Herdr tab placement for native Pi children.
 *
 * A child that would otherwise run invisibly inside the detached runner process
 * runs instead in a visible tab of the operator's current Herdr workspace. The
 * transport is the local Herdr socket, and the child is an ordinary local `pi`
 * process, so cwd, Git evidence, and file mutations keep their local semantics.
 *
 * Placement is an optimization, never a gate: every failure below (unsupported
 * launch shape, missing Herdr, protocol drift, tab cap, handshake) falls back to
 * the in-process child and records why. Only an explicit saved-machine launch
 * fails closed, because a machine is an operator instruction, not a convenience.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import packageJson from "../../../package.json" with { type: "json" };
import {
	HERDR_LOCAL_TAB_LABEL_PREFIX,
	HERDR_LOCAL_TAB_MAX_CEILING,
	HERDR_LOCAL_TAB_STALE_DEFAULT_MINUTES,
	SAFE_LOCAL_TAB_AGENT_NAME,
	readEnabledLocalTabPolicy,
} from "../../shared/herdr-local-tab-settings.ts";
import { getAgentDir } from "../../shared/utils.ts";
import type { ChildSession, ChildSessionLaunch, LocalTabPlacementOutcome } from "./child-session.ts";
import type { HerdrEndpoint, HerdrForwardedConnection, HerdrRpcClient } from "./herdr-connection.ts";
import { parseHerdrEndpoint, SocketRpcClient } from "./herdr-connection.ts";
import { HERDR_PI_MODE_ENV, HERDR_PI_PROTOCOL, HERDR_PI_RUN_ENV, HERDR_PI_RUNTIME_DIR_ENV, herdrPiRuntimeRoot, validateHerdrPiRunId } from "./herdr-pi-protocol.ts";
import {
	BridgeChannel,
	closeOwnedHerdrPane,
	HERDR_MAX_OWNED_PANES,
	HerdrPiSession,
	herdrPaneAllocationKey,
	herdrRunJournalDir,
	herdrRunState,
	herdrSnapshotAgents,
	herdrStatusSubscriptions,
	ownsHerdrPane,
	parseHerdrAgent,
	parseHerdrCreated,
	parseHerdrSessionSnapshot,
	serializeHerdrPiLaunch,
	waitForReadyBridgeFrame,
	withHerdrPaneAllocationLock,
	type HerdrRunIdentity,
	type HerdrRunSnapshot,
	type PlacedRunOwner,
} from "./herdr-placed-run.ts";

export {
	HERDR_LOCAL_TAB_LABEL_PREFIX,
	HERDR_LOCAL_TAB_MAX_CEILING,
	HERDR_LOCAL_TAB_MAX_DEFAULT,
	HERDR_LOCAL_TAB_STALE_DEFAULT_MINUTES,
	HERDR_LOCAL_TABS_ENV,
	parseHerdrLocalTabOverrides,
	parseHerdrLocalTabSettings,
	readEnabledLocalTabPolicy,
	readHerdrLocalTabSettings,
} from "../../shared/herdr-local-tab-settings.ts";
export type { HerdrLocalTabSettings } from "../../shared/herdr-local-tab-settings.ts";

/** A fresh pane may need seconds before its shell is an available agent target (slow shell init). */
export const HERDR_LOCAL_SHELL_TIMEOUT_MS = 45_000;
const SLOW_SHELL_WARNING_MS = 10_000;
const MANIFEST_NAME = "manifest.json";
const SOCKET_NAME = "bridge.sock";
const ENDPOINT_TIMEOUT_MS = 10_000;
const DISCOVERY_ATTEMPTS = 180;
const DISCOVERY_POLL_MS = 500;
const START_TIMEOUT_MS = 45_000;
const SAFE_RUN_DIR_NAME = /^[A-Za-z0-9_-]{8,96}$/u;
const SAFE_AGENT_NAME = SAFE_LOCAL_TAB_AGENT_NAME;

export interface HerdrLocalTabIntent {
	workspaceId: string;
	socketPath: string;
	maxTabs: number;
	staleAfterMs: number;
}

/** Deterministic "this launch can never be placed" marker, kept apart from transport failures. */
export class HerdrLocalTabUnavailable extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "HerdrLocalTabUnavailable";
	}
}

export class HerdrLocalTabCapError extends Error {
	readonly owned: number;
	readonly maxTabs: number;
	constructor(owned: number, maxTabs: number) {
		super(`Herdr local tab cap of ${maxTabs} is reached (${owned} owned tabs); close one or raise subagents.herdrLocalTabs.maxTabs.`);
		this.name = "HerdrLocalTabCapError";
		this.owned = owned;
		this.maxTabs = maxTabs;
	}
}

/**
 * Decides whether this launch may run in a local tab. A negative answer is a
 * reason, never an error: the caller falls back in-process.
 */
export function resolveHerdrLocalTabIntent(input: { agent: string; cwd: string; machine?: unknown; env?: NodeJS.ProcessEnv }): { ok: true; intent: HerdrLocalTabIntent } | { ok: false; reason: string } {
	const env = input.env ?? process.env;
	if (input.machine !== undefined) return { ok: false, reason: "saved-machine placement takes precedence" };
	const policy = readEnabledLocalTabPolicy({ cwd: input.cwd, env });
	if (!policy.enabled) return { ok: false, reason: policy.reason };
	const settings = policy.settings;
	if (settings.agents && !settings.agents.includes(input.agent)) return { ok: false, reason: `agent '${input.agent}' is not listed in subagents.herdrLocalTabs.agents` };
	if (env.HERDR_ENV !== "1") return { ok: false, reason: "not running inside a Herdr session" };
	const workspaceId = env.HERDR_WORKSPACE_ID?.trim();
	if (!workspaceId) return { ok: false, reason: "Herdr workspace identity is missing" };
	const socketPath = env.HERDR_SOCKET_PATH?.trim();
	if (!socketPath || !path.isAbsolute(socketPath)) return { ok: false, reason: "Herdr socket identity is missing" };
	return { ok: true, intent: { workspaceId, socketPath, maxTabs: Math.min(settings.maxTabs, HERDR_LOCAL_TAB_MAX_CEILING), staleAfterMs: settings.staleAfterMinutes * 60_000 } };
}

export function classifyLocalTabFallback(error: unknown): { kind: "unsupported" | "failed"; reason: string } {
	const reason = error instanceof Error ? error.message : String(error);
	return { kind: error instanceof HerdrLocalTabUnavailable ? "unsupported" : "failed", reason };
}

export function discoverHerdrLocalEndpoint(options: { env?: NodeJS.ProcessEnv; herdrBin?: string } = {}): HerdrEndpoint {
	const env = options.env ?? process.env;
	const bin = options.herdrBin ?? env.HERDR_BIN_PATH ?? env.HERDR_BIN ?? "herdr";
	const result = spawnSync(bin, ["status", "server", "--json"], { env, encoding: "utf-8", maxBuffer: 256 * 1024, timeout: ENDPOINT_TIMEOUT_MS, windowsHide: true });
	if (result.error) {
		if ((result.error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Herdr CLI '${bin}' was not found; local tab placement needs Herdr installed locally.`);
		throw new Error(`Failed to run herdr status server --json: ${result.error.message}`);
	}
	if (result.status !== 0) throw new Error(`herdr status server --json exited with code ${result.status}: ${(result.stderr || result.stdout).trim()}`);
	const endpoint = parseHerdrEndpoint(result.stdout, env.HERDR_SESSION);
	const expected = env.HERDR_SOCKET_PATH?.trim();
	if (expected && endpoint.socket !== expected) throw new Error(`Herdr socket identity mismatch: the pane reported ${expected}, the server answered on ${endpoint.socket}.`);
	if (!endpoint.running) throw new HerdrLocalTabUnavailable("The local Herdr server is not running.");
	if (endpoint.compatible === false) throw new HerdrLocalTabUnavailable(`The local Herdr server speaks an incompatible protocol (v${endpoint.protocol ?? "?"}); this pi-subagents build is validated against the protocol Herdr reports as compatible.`);
	return endpoint;
}

/**
 * Local transport: the Herdr socket is already local, so bridge forwarding is a
 * validated no-op instead of an SSH StreamLocal tunnel.
 */
export async function connectHerdrLocal(options: { env?: NodeJS.ProcessEnv; herdrBin?: string } = {}): Promise<HerdrForwardedConnection> {
	const endpoint = discoverHerdrLocalEndpoint(options);
	const runtimeRoot = herdrPiRuntimeRoot(getAgentDir());
	const forwardRemoteSocket = async (socketPath: string) => {
		const directory = path.dirname(socketPath);
		if (!path.isAbsolute(socketPath) || (directory !== runtimeRoot && !directory.startsWith(`${runtimeRoot}${path.sep}`))) throw new Error("Local bridge sockets may only be forwarded from the owned run runtime tree.");
		const stat = fs.lstatSync(socketPath);
		if (stat.isSymbolicLink() || !stat.isSocket()) throw new Error("The local bridge path is not an owned Unix socket.");
		return { socketPath, close: async () => {} };
	};
	return { endpoint, socketPath: endpoint.socket, client: new SocketRpcClient(endpoint.socket), forwardRemoteSocket, close: async () => {} };
}

function assertPrivateDir(directory: string): void {
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("The local tab runtime path is not a mode-0700 owned directory.");
}

/** Run-private directory in which the placed child hosts its socket and manifest. */
export function createLocalRuntimeDir(runId: string): string {
	const root = herdrPiRuntimeRoot(getAgentDir());
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	assertPrivateDir(root);
	const directory = path.join(root, validateHerdrPiRunId(runId));
	try {
		fs.mkdirSync(directory, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	assertPrivateDir(directory);
	// A leftover artifact from an earlier launch of the same run would make manifest discovery ambiguous.
	for (const name of [MANIFEST_NAME, SOCKET_NAME]) {
		const candidate = path.join(directory, name);
		try {
			const stat = fs.lstatSync(candidate);
			if (stat.isSymbolicLink()) throw new Error(`Refusing to use a symlinked bridge artifact at '${candidate}'.`);
			fs.rmSync(candidate, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return directory;
}

export function removeLocalRuntimeDir(runtimeDir: string): void {
	const root = herdrPiRuntimeRoot(getAgentDir());
	if (path.dirname(runtimeDir) !== root || !SAFE_RUN_DIR_NAME.test(path.basename(runtimeDir))) throw new Error("Refusing to remove a path that is not an owned run runtime directory.");
	const stat = fs.lstatSync(runtimeDir);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Refusing to remove a path that is not an owned directory.");
	fs.rmSync(runtimeDir, { recursive: true, force: true });
}

function isProcessAlive(pid: unknown): boolean | undefined {
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readManifest(runtimeDir: string): Record<string, unknown> | undefined {
	try {
		const stat = fs.lstatSync(path.join(runtimeDir, MANIFEST_NAME));
		if (stat.isSymbolicLink()) throw new Error("The local bridge manifest must not be a symlink.");
		return JSON.parse(fs.readFileSync(path.join(runtimeDir, MANIFEST_NAME), "utf8")) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

export interface LocalBridgeManifest {
	socketPath: string;
	nativeSessionId: string;
	packageVersion: string;
	protocol: number;
}

/**
 * Integration preflight captured in the placement artifact: which Herdr spoke to
 * this run, under which protocol, and whether the Pi integration that titles the
 * tab was current at that moment. Recorded, never used as a gate.
 */
export interface LocalTabEvidence {
	packageVersion: string;
	manifestProtocol: number;
	serverVersion?: string;
	serverProtocol?: number;
	serverCompatible?: boolean;
	piIntegration?: string;
}

/** One `herdr integration status` call; any failure is reported as text instead of thrown. */
export function collectLocalTabEvidence(endpoint: { version?: string; protocol?: number; compatible?: boolean }, options: { env?: NodeJS.ProcessEnv; herdrBin?: string } = {}): LocalTabEvidence {
	const env = options.env ?? process.env;
	const bin = options.herdrBin ?? env.HERDR_BIN_PATH ?? env.HERDR_BIN ?? "herdr";
	const evidence: LocalTabEvidence = { packageVersion: packageJson.version, manifestProtocol: HERDR_PI_PROTOCOL, ...(endpoint.version === undefined ? {} : { serverVersion: endpoint.version }), ...(endpoint.protocol === undefined ? {} : { serverProtocol: endpoint.protocol }), ...(endpoint.compatible === undefined ? {} : { serverCompatible: endpoint.compatible }) };
	try {
		const result = spawnSync(bin, ["integration", "status"], { env, encoding: "utf-8", maxBuffer: 256 * 1024, timeout: ENDPOINT_TIMEOUT_MS, windowsHide: true });
		if (result.error) evidence.piIntegration = `unavailable: ${result.error.message}`;
		else if (result.status !== 0) evidence.piIntegration = `unavailable: exit ${result.status}`;
		else evidence.piIntegration = String(result.stdout).split("\n").find((line) => line.startsWith("pi:"))?.trim().slice(0, 200) ?? "not reported";
	} catch (error) {
		evidence.piIntegration = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
	}
	return evidence;
}

/**
 * Waits for the child's own manifest. A partial or stale manifest never passes
 * identity checks: only a manifest naming this run, this runtime directory, and a
 * live process is accepted.
 */
export async function discoverLocalBridgeManifest(runId: string, runtimeDir: string, options: { attempts?: number; pollMs?: number } = {}): Promise<LocalBridgeManifest> {
	const attempts = options.attempts ?? DISCOVERY_ATTEMPTS;
	const pollMs = options.pollMs ?? DISCOVERY_POLL_MS;
	for (let attempt = 0; attempt < attempts; attempt++) {
		const value = readManifest(runtimeDir);
		if (value !== undefined) {
			if (value.runId !== runId || typeof value.socketPath !== "string" || path.dirname(value.socketPath) !== runtimeDir || typeof value.nativeSessionId !== "string" || typeof value.packageVersion !== "string" || typeof value.protocol !== "number") throw new Error("The local bridge manifest identity is incomplete or outside its owned runtime directory.");
			if (isProcessAlive(value.pid) === false) throw new Error("The local bridge manifest names a process that has already exited.");
			return { socketPath: value.socketPath, nativeSessionId: value.nativeSessionId, packageVersion: value.packageVersion, protocol: value.protocol };
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	throw new Error("The local Pi tab did not expose the packaged pi-subagents bridge in time; install the same pi-subagents version as an ambient Pi extension.");
}

function journalPath(runId: string): string {
	return path.join(herdrRunJournalDir(), `${validateHerdrPiRunId(runId)}.json`);
}

interface LocalTabJournalRecord {
	version: 1;
	placement: "local-tab";
	runId: string;
	label: string;
	tabId: string;
	paneId: string;
	terminalId: string;
	workspaceId: string;
	evidence?: LocalTabEvidence;
	updatedAt: number;
}

/** The ownership journal is what makes a tab ours; without it, no tab is ever touched. */
function writeLocalTabJournal(identity: HerdrRunIdentity, label: string, at = Date.now(), evidence?: LocalTabEvidence): void {
	const directory = herdrRunJournalDir();
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const record: LocalTabJournalRecord = { version: 1, placement: "local-tab", runId: identity.runId, label, tabId: identity.tabId, paneId: identity.paneId, terminalId: identity.terminalId, workspaceId: identity.workspaceId, ...(evidence === undefined ? {} : { evidence }), updatedAt: at };
	fs.writeFileSync(journalPath(identity.runId), JSON.stringify(record), { mode: 0o600 });
}

function writePlacementRecord(runId: string, outcome: LocalTabPlacementOutcome, extra: Record<string, unknown>): void {
	try {
		const directory = herdrRunJournalDir();
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(directory, `${validateHerdrPiRunId(runId)}.placement.json`), JSON.stringify({ version: 1, at: Date.now(), ...extra, ...outcome }), { mode: 0o600 });
	} catch {
		// Diagnostic only: a placement record never fails a run.
	}
}

function readJournals(): Map<string, LocalTabJournalRecord> {
	const records = new Map<string, LocalTabJournalRecord>();
	let names: string[] = [];
	try {
		names = fs.readdirSync(herdrRunJournalDir());
	} catch {
		return records;
	}
	for (const name of names) {
		if (!name.endsWith(".json") || name.endsWith(".placement.json")) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(herdrRunJournalDir(), name), "utf8")) as Partial<LocalTabJournalRecord>;
			if (parsed.version !== 1 || parsed.placement !== "local-tab" || typeof parsed.runId !== "string" || typeof parsed.label !== "string" || !parsed.label.startsWith(HERDR_LOCAL_TAB_LABEL_PREFIX) || typeof parsed.tabId !== "string" || typeof parsed.paneId !== "string" || typeof parsed.terminalId !== "string" || typeof parsed.workspaceId !== "string" || typeof parsed.updatedAt !== "number") continue;
			records.set(parsed.label, parsed as LocalTabJournalRecord);
		} catch {
			// An unreadable journal never authorizes a destructive action.
		}
	}
	return records;
}

interface SnapshotTab {
	tabId: string;
	workspaceId: string;
	label?: string;
}

interface SnapshotPane {
	paneId: string;
	tabId?: string;
	terminalId?: string;
	agent?: unknown;
	agentSession?: unknown;
	agentStatus?: unknown;
}

function snapshotTabs(snapshot: Record<string, unknown>): SnapshotTab[] {	const tabs = snapshot.tabs;
	if (!Array.isArray(tabs)) return [];
	return tabs.flatMap((tab) => {
		if (!tab || typeof tab !== "object") return [];
		const record = tab as Record<string, unknown>;
		if (typeof record.tab_id !== "string" || typeof record.workspace_id !== "string") return [];
		return [{ tabId: record.tab_id, workspaceId: record.workspace_id, ...(typeof record.label === "string" ? { label: record.label } : {}) }];
	});
}

function snapshotPanes(snapshot: Record<string, unknown>): SnapshotPane[] {
	const panes = snapshot.panes;
	if (!Array.isArray(panes)) return [];
	return panes.flatMap((pane) => {
		if (!pane || typeof pane !== "object") return [];
		const record = pane as Record<string, unknown>;
		if (typeof record.pane_id !== "string") return [];
		return [{
			paneId: record.pane_id,
			...(typeof record.tab_id === "string" ? { tabId: record.tab_id } : {}),
			...(typeof record.terminal_id === "string" ? { terminalId: record.terminal_id } : {}),
			agent: record.agent,
			agentSession: record.agent_session,
			agentStatus: record.agent_status,
		}];
	});
}

function snapshotWorkspaces(snapshot: Record<string, unknown>): Array<{ workspaceId: string }> {
	const workspaces = snapshot.workspaces;
	if (!Array.isArray(workspaces)) return [];
	return workspaces.flatMap((workspace) => {
		if (!workspace || typeof workspace !== "object") return [];
		const record = workspace as Record<string, unknown>;
		return typeof record.workspace_id === "string" ? [{ workspaceId: record.workspace_id }] : [];
	});
}

/** A workspace is gone only when the snapshot positively lists workspaces without it. */
function workspaceExists(snapshot: Record<string, unknown>, workspaceId: string, tabs: SnapshotTab[]): boolean {
	const workspaces = snapshotWorkspaces(snapshot);
	return workspaces.length > 0 ? workspaces.some((workspace) => workspace.workspaceId === workspaceId) : tabs.some((tab) => tab.workspaceId === workspaceId);
}

function paneRunsAnAgent(pane: SnapshotPane): boolean {
	return pane.agent != null || pane.agentSession != null;
}

function envelope(value: unknown, type: string, key: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || (value as Record<string, unknown>).type !== type) throw new Error(`Herdr returned an invalid ${type} envelope.`);
	const nested = (value as Record<string, unknown>)[key];
	if (!nested || typeof nested !== "object") throw new Error(`Herdr returned an invalid ${type} payload.`);
	return nested as Record<string, unknown>;
}

function requireId(value: unknown, key: string): string {
	const found = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
	if (typeof found !== "string" || !found) throw new Error(`Herdr did not return ${key}.`);
	return found;
}

export interface HerdrLocalTabReapResult {
	closed: string[];
	kept: Array<{ tabId: string; reason: string }>;
	runtimeDirsRemoved: string[];
}

/**
 * Reclaims only tabs whose run is provably gone. Evidence, strongest first: the
 * recorded child process is dead, or the pane vanished. A pane that still holds
 * an agent is kept unless that process is provably dead, and a run without a
 * manifest is reclaimed only once its journal is stale and its pane is empty.
 * An inconsistent snapshot fails closed instead of guessing.
 */
export async function reapHerdrLocalTabs(input: { client: HerdrRpcClient; workspaceId?: string; dryRun?: boolean; limit?: number; staleAfterMs?: number; now?: number }): Promise<HerdrLocalTabReapResult> {
	const now = input.now ?? Date.now();
	const staleAfterMs = input.staleAfterMs ?? HERDR_LOCAL_TAB_STALE_DEFAULT_MINUTES * 60_000;
	const snapshot = parseHerdrSessionSnapshot(await input.client.call("session.snapshot"));
	const allTabs = snapshotTabs(snapshot);
	const tabs = allTabs.filter((tab) => tab.label !== undefined && tab.label.startsWith(HERDR_LOCAL_TAB_LABEL_PREFIX) && (input.workspaceId === undefined || tab.workspaceId === input.workspaceId));
	const panes = snapshotPanes(snapshot);
	// Occupancy comes from the pane record and from Herdr's own agent list, which is authoritative.
	const occupiedPanes = new Set([...panes.filter(paneRunsAnAgent).map((pane) => pane.paneId), ...herdrSnapshotAgents(snapshot).flatMap((agent) => (agent.pane_id ? [agent.pane_id] : []))]);
	const paneOccupied = (paneId: string) => occupiedPanes.has(paneId);
	const journals = readJournals();
	const closed: string[] = [];
	const kept: Array<{ tabId: string; reason: string }> = [];
	if (tabs.length > 0 && panes.length === 0) return { closed, kept: tabs.map((tab) => ({ tabId: tab.tabId, reason: "Herdr reported owned tabs but no panes; refusing to reap" })), runtimeDirsRemoved: [] };
	for (const tab of tabs) {
		const journal = tab.label ? journals.get(tab.label) : undefined;
		if (!journal || journal.tabId !== tab.tabId || journal.paneId.length === 0 || (input.workspaceId !== undefined && journal.workspaceId !== input.workspaceId)) {
			kept.push({ tabId: tab.tabId, reason: "no matching ownership journal" });
			continue;
		}
		const pane = panes.find((candidate) => candidate.paneId === journal.paneId);
		if (pane === undefined) {
			// Nothing left to close; the stale sweep below prunes the run directory.
			kept.push({ tabId: tab.tabId, reason: "owned pane is already gone" });
			continue;
		}
		const manifest = readManifest(path.join(herdrPiRuntimeRoot(getAgentDir()), journal.runId));
		const alive = isProcessAlive(manifest?.pid);
		const occupied = paneOccupied(pane.paneId);
		const evidence = alive === false
			? "the recorded child process has exited"
			: alive === undefined && now - journal.updatedAt > staleAfterMs && !occupied ? "the bridge manifest is gone and the journal is stale" : undefined;
		if (!evidence) {
			kept.push({ tabId: tab.tabId, reason: occupied ? "owned pane still runs an agent" : alive === true ? "the recorded child process is still alive" : "the run is not provably finished" });
			continue;
		}
		if (input.dryRun) {
			kept.push({ tabId: tab.tabId, reason: `would close: ${evidence}` });
			continue;
		}
		if (closed.length >= (input.limit ?? 8)) {
			kept.push({ tabId: tab.tabId, reason: "reap limit reached" });
			continue;
		}
		try {
			await input.client.call("pane.close", { pane_id: journal.paneId });
			fs.rmSync(journalPath(journal.runId), { force: true });
			closed.push(tab.tabId);
		} catch (error) {
			kept.push({ tabId: tab.tabId, reason: `close failed: ${error instanceof Error ? error.message : String(error)}` });
		}
	}
	return { closed, kept, runtimeDirsRemoved: pruneLocalRuntimeDirs(now, staleAfterMs) };
}

/** Removes run directories whose owning process is gone and whose bridge never came back. */
export function pruneLocalRuntimeDirs(now = Date.now(), staleAfterMs = HERDR_LOCAL_TAB_STALE_DEFAULT_MINUTES * 60_000): string[] {
	const root = herdrPiRuntimeRoot(getAgentDir());
	const removed: string[] = [];
	let names: string[] = [];
	try {
		names = fs.readdirSync(root);
	} catch {
		return removed;
	}
	for (const name of names) {
		if (!SAFE_RUN_DIR_NAME.test(name)) continue;
		const directory = path.join(root, name);
		try {
			const stat = fs.lstatSync(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
			const manifest = readManifest(directory);
			const alive = isProcessAlive(manifest?.pid);
			if (alive === true) continue;
			if (alive === undefined && now - stat.mtimeMs <= staleAfterMs) continue;
			fs.rmSync(directory, { recursive: true, force: true });
			removed.push(directory);
		} catch {
			// Pruning is best effort and never fails a run.
		}
	}
	return removed;
}

/**
 * Creates the tab under the shared cross-process allocation lock, after one
 * bounded reap attempt, and verifies the identity Herdr returns.
 */
export async function provisionHerdrLocalTab(client: HerdrRpcClient, input: { workspaceId: string; cwd: string; runId: string; runtimeDir: string; maxTabs: number; staleAfterMs: number }, environment?: Record<string, string>): Promise<{ workspaceId: string; tabId: string; paneId: string }> {
	return withHerdrPaneAllocationLock(herdrPaneAllocationKey("local-tab", "local", input.workspaceId), async () => {
		const snapshot = parseHerdrSessionSnapshot(await client.call("session.snapshot"));
		const allTabs = snapshotTabs(snapshot);
		if (!workspaceExists(snapshot, input.workspaceId, allTabs)) throw new Error("The Herdr workspace that owns this session no longer exists.");
		const owned = allTabs.filter((tab) => tab.label !== undefined && tab.label.startsWith(HERDR_LOCAL_TAB_LABEL_PREFIX));
		const ownedLabel = `${HERDR_LOCAL_TAB_LABEL_PREFIX}${input.runId.slice(-8)}`;
		if (owned.some((tab) => tab.label === ownedLabel)) throw new Error("Refusing to create a second local tab for the same run identity.");
		if (owned.filter((tab) => tab.workspaceId === input.workspaceId).length >= input.maxTabs) {
			await reapHerdrLocalTabs({ client, staleAfterMs: input.staleAfterMs, now: Date.now() });
			const refreshed = snapshotTabs(parseHerdrSessionSnapshot(await client.call("session.snapshot"))).filter((tab) => tab.label !== undefined && tab.label.startsWith(HERDR_LOCAL_TAB_LABEL_PREFIX) && tab.workspaceId === input.workspaceId);
			if (refreshed.length >= input.maxTabs) throw new HerdrLocalTabCapError(refreshed.length, input.maxTabs);
		}
		if (owned.length >= HERDR_MAX_OWNED_PANES) throw new Error("Refusing to exceed the Herdr pane budget with owned local tabs.");
		const env = environment ?? { [HERDR_PI_MODE_ENV]: "1", [HERDR_PI_RUN_ENV]: input.runId, [HERDR_PI_RUNTIME_DIR_ENV]: input.runtimeDir };
		const response = (await client.call("tab.create", { workspace_id: input.workspaceId, cwd: input.cwd, label: ownedLabel, env, focus: false })) as Record<string, unknown>;
		const created = parseHerdrCreated(response, "tab_created");
		const tab = envelope(response, "tab_created", "tab");
		const pane = envelope(response, "tab_created", "root_pane");
		if (tab.workspace_id !== input.workspaceId) throw new Error("Herdr created the local tab in an unexpected workspace.");
		if (tab.tab_id !== created.tabId || requireId(pane, "pane_id") !== created.paneId || pane.tab_id !== created.tabId || pane.workspace_id !== input.workspaceId) throw new Error("Herdr returned an inconsistent local tab identity.");
		return { workspaceId: input.workspaceId, tabId: created.tabId, paneId: created.paneId };
	});
}

/**
 * Single private owner for one local placed run: runtime directory, tab,
 * subscription, and cleanup. It mirrors the saved-machine owner so the shared
 * `HerdrPiSession` transport can drive either backend.
 */
export class HerdrLocalTabOwner implements PlacedRunOwner {
	readonly runId: string;
	readonly runtimeDir: string;
	readonly cwd: string;
	readonly workspaceId: string;
	readonly maxTabs: number;
	readonly staleAfterMs: number;
	readonly label: string;
	connection: HerdrForwardedConnection;
	owned?: { workspaceId: string; tabId: string; paneId: string };
	terminalId?: string;
	agentName?: string;
	startedArgv?: string[];
	identity?: HerdrRunIdentity;
	#evidence?: LocalTabEvidence;
	#unsubscribe = () => {};
	#snapshot: HerdrRunSnapshot = { connection: "connected", state: "ready", revision: 0 };
	#cleanupPromise?: Promise<void>;

	private constructor(input: { runId: string; runtimeDir: string; cwd: string; workspaceId: string; maxTabs: number; staleAfterMs: number; connection: HerdrForwardedConnection }) {
		this.runId = input.runId;
		this.runtimeDir = input.runtimeDir;
		this.cwd = input.cwd;
		this.workspaceId = input.workspaceId;
		this.maxTabs = input.maxTabs;
		this.staleAfterMs = input.staleAfterMs;
		this.connection = input.connection;
		this.label = `${HERDR_LOCAL_TAB_LABEL_PREFIX}${input.runId.slice(-8)}`;
	}

	static async create(input: { runId: string; cwd: string; workspaceId: string; maxTabs: number; staleAfterMs: number; env?: NodeJS.ProcessEnv }): Promise<HerdrLocalTabOwner> {
		const runtimeDir = createLocalRuntimeDir(input.runId);
		let connection: HerdrForwardedConnection | undefined;
		try {
			connection = await connectHerdrLocal({ env: input.env });
			const owner = new HerdrLocalTabOwner({ runId: input.runId, runtimeDir, cwd: input.cwd, workspaceId: input.workspaceId, maxTabs: input.maxTabs, staleAfterMs: input.staleAfterMs, connection });
			// Preflight evidence is captured once per placed run and lands in the placement artifact.
			owner.#evidence = collectLocalTabEvidence(connection.endpoint, input.env === undefined ? {} : { env: input.env });
			return owner;
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			try {
				await connection?.close();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			try {
				removeLocalRuntimeDir(runtimeDir);
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "Local tab owner creation failed and cleanup also failed.", { cause: error });
			throw error;
		}
	}

	observeEvent(event: unknown): void {
		const data = event && typeof event === "object" ? (event as { data?: Record<string, unknown> }).data : undefined;
		if (data && (!this.terminalId || data.terminal_id === this.terminalId || data.pane_id === this.owned?.paneId)) this.#snapshot = { ...this.#snapshot, revision: this.#snapshot.revision + 1, state: herdrRunState(data.agent_status, this.#snapshot.state) };
	}

	markConnectionUnknown(observed: HerdrForwardedConnection): boolean {
		if (this.connection !== observed) return false;
		this.#snapshot = { ...this.#snapshot, connection: "unknown", state: "unknown", revision: this.#snapshot.revision + 1 };
		return true;
	}

	statusSubscriptions(paneId = this.owned?.paneId): unknown[] {
		if (!paneId) throw new Error("Herdr status subscription requires a provisioned pane.");
		return herdrStatusSubscriptions(paneId);
	}

	async subscribe(listener: (event: unknown) => void, disconnected: (error: Error) => void): Promise<void> {
		const observed = this.connection;
		let adopted = false;
		let candidateLost: Error | undefined;
		const unsubscribe = await observed.client.subscribe(this.statusSubscriptions(), (event) => {
			this.observeEvent(event);
			listener(event);
		}, (error) => {
			if (!adopted) {
				candidateLost ??= error;
				return;
			}
			if (!this.markConnectionUnknown(observed)) return;
			disconnected(error);
		});
		if (candidateLost) {
			unsubscribe();
			throw candidateLost;
		}
		this.#unsubscribe = unsubscribe;
		adopted = true;
	}

	async provision(environment?: Record<string, string>): Promise<{ workspaceId: string; tabId: string; paneId: string }> {
		this.owned = await provisionHerdrLocalTab(this.connection.client, { workspaceId: this.workspaceId, cwd: this.cwd, runId: this.runId, runtimeDir: this.runtimeDir, maxTabs: this.maxTabs, staleAfterMs: this.staleAfterMs }, environment);
		return this.owned;
	}

	async start(name: string, args: string[], options: { timeoutMs?: number; pollMs?: number; clock?: { now(): number; wait(ms: number): Promise<void> } } = {}): Promise<{ terminalId: string; paneId: string; argv: string[] }> {
		if (!this.owned) throw new Error("Herdr local placement owner has not provisioned its tab.");
		const owned = this.owned;
		const clock = options.clock ?? { now: () => Date.now(), wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
		const deadline = clock.now() + (options.timeoutMs ?? 5_000);
		const pollMs = options.pollMs ?? 50;
		let response: unknown;
		for (;;) {
			try {
				response = await this.connection.client.call("agent.start", { name, kind: "pi", pane_id: owned.paneId, args, timeout_ms: START_TIMEOUT_MS }, START_TIMEOUT_MS + 15_000);
				break;
			} catch (error) {
				if (!(error instanceof Error) || !error.message.includes("is not an available shell")) throw error;
				const pane = envelope(await this.connection.client.call("pane.get", { pane_id: owned.paneId }), "pane_info", "pane");
				if (pane.pane_id !== owned.paneId || pane.workspace_id !== owned.workspaceId || pane.tab_id !== owned.tabId) throw new Error("Herdr startup pane identity changed after a transient start rejection.", { cause: error });
				if (pane.agent != null || pane.agent_session != null) throw new Error("Herdr startup pane became occupied after a transient start rejection.", { cause: error });
				if (clock.now() >= deadline) throw new Error("Herdr owned pane remained unavailable until the startup deadline.", { cause: error });
				await clock.wait(Math.min(pollMs, deadline - clock.now()));
			}
		}
		const started = parseHerdrAgent(response, "agent_started");
		const terminalId = requireId(started, "terminal_id");
		const paneId = requireId(started, "pane_id");
		if (paneId !== owned.paneId) throw new Error("Herdr started the native agent in an unexpected pane.");
		this.agentName = name;
		this.terminalId = terminalId;
		this.startedArgv = ["pi", ...args];
		return { terminalId, paneId, argv: this.startedArgv };
	}

	journal(identity: HerdrRunIdentity): void {
		this.identity = identity;
		this.#snapshot = { ...this.#snapshot, identity };
		writeLocalTabJournal(identity, this.label, Date.now(), this.#evidence);
	}

	get snapshot(): HerdrRunSnapshot {
		return this.#snapshot;
	}

	get evidence(): LocalTabEvidence | undefined {
		return this.#evidence;
	}

	async replaceConnection(input: { connection: HerdrForwardedConnection; unsubscribe: () => void; paneId: string; state: HerdrRunSnapshot["state"] }): Promise<void> {
		const oldConnection = this.connection;
		const oldUnsubscribe = this.#unsubscribe;
		this.connection = input.connection;
		this.#unsubscribe = input.unsubscribe;
		if (this.identity) this.identity = { ...this.identity, paneId: input.paneId };
		this.#snapshot = { connection: "connected", state: input.state, identity: this.identity, revision: this.#snapshot.revision + 1 };
		oldUnsubscribe();
		await oldConnection.close();
	}

	/** A local owned tab is always reclaimed: leftover tabs in the operator's own workspace are clutter. */
	cleanup(_closeStartedPane = true): Promise<void> {
		return (this.#cleanupPromise ??= this.#performCleanup(true));
	}

	async #performCleanup(closeStartedPane: boolean): Promise<void> {
		const owned = this.owned;
		let failure: unknown;
		let paneReclaimed = true;
		try {
			if (closeStartedPane && owned) await closeOwnedHerdrPane({ client: this.connection.client, owned, ...(this.terminalId ? { terminalId: this.terminalId } : {}), ...(this.agentName ? { agentName: this.agentName } : {}) });
		} catch (error) {
			paneReclaimed = false;
			failure = error;
		}
		try {
			this.#unsubscribe();
			await this.connection.close();
			removeLocalRuntimeDir(this.runtimeDir);
			if (paneReclaimed) fs.rmSync(journalPath(this.runId), { force: true });
		} catch (error) {
			failure ??= error;
		}
		this.#snapshot = { ...this.#snapshot, connection: "closed", revision: this.#snapshot.revision + 1 };
		if (failure) throw failure;
	}
}

/** Reclaims leftover owned tabs and run directories; safe to call at session start. */
export async function maintainHerdrLocalTabs(input: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<HerdrLocalTabReapResult | undefined> {
	const env = input.env ?? process.env;
	const policy = readEnabledLocalTabPolicy({ cwd: input.cwd, env });
	if (!policy.enabled) return undefined;
	const workspaceId = env.HERDR_WORKSPACE_ID?.trim();
	if (!workspaceId) return undefined;
	const connection = await connectHerdrLocal({ env });
	try {
		return await reapHerdrLocalTabs({ client: connection.client, workspaceId, staleAfterMs: policy.settings.staleAfterMinutes * 60_000 });
	} finally {
		await connection.close();
	}
}

/** Records why a launch fell back; the run artifact reports it. */
export function recordLocalTabFallback(launch: ChildSessionLaunch, outcome: LocalTabPlacementOutcome): void {
	if (outcome.placed || !launch.runtime.runId) return;
	try {
		writePlacementRecord(launch.runtime.runId, outcome, { requested: "tab", agent: launch.remoteResources?.agent, cwd: launch.cwd });
	} catch {
		// Diagnostic only.
	}
	try {
		console.warn(`pi-subagents: local Herdr tab placement fell back to an in-process child (${outcome.kind}): ${outcome.reason}`);
	} catch {
		// A warning must never fail a run.
	}
}

/**
 * Attaches the placement outcome to the child so the run artifact can report it.
 * The child sessions are plain objects or class instances today; a frozen child
 * keeps the placement record as its only trace.
 */
export function withLocalTabOutcome(session: ChildSession, outcome: LocalTabPlacementOutcome): ChildSession {
	try {
		(session as { localTabPlacement?: LocalTabPlacementOutcome }).localTabPlacement = outcome;
	} catch {
		// Diagnostic only.
	}
	return session;
}

/** Places one native Pi child in a visible local tab, or throws for the caller to fall back. */
export async function createHerdrLocalTabSession(launch: ChildSessionLaunch, options: { startTimeoutMs?: number } = {}): Promise<ChildSession> {
	if (launch.machine) throw new HerdrLocalTabUnavailable("Local tab placement cannot be combined with a saved machine.");
	const agent = launch.remoteResources?.agent;
	if (agent === undefined || !SAFE_AGENT_NAME.test(agent)) throw new HerdrLocalTabUnavailable("Local tab placement requires a bounded logical agent name.");
	const resolved = resolveHerdrLocalTabIntent({ agent, cwd: launch.cwd, machine: launch.machine, env: process.env });
	if (!resolved.ok) throw new HerdrLocalTabUnavailable(`Local tab placement is unavailable: ${resolved.reason}.`);
	if (!path.isAbsolute(launch.cwd) || !fs.existsSync(launch.cwd)) throw new HerdrLocalTabUnavailable(`Local tab placement requires an existing absolute cwd (${launch.cwd}).`);
	const runId = launch.runtime.runId;
	if (!runId) throw new HerdrLocalTabUnavailable("Local tab placement requires a run identity.");
	let policy: ReturnType<typeof serializeHerdrPiLaunch>;
	try {
		policy = serializeHerdrPiLaunch(launch, { scope: "local-tab" });
	} catch (error) {
		throw new HerdrLocalTabUnavailable(error instanceof Error ? error.message : String(error), { cause: error });
	}
	const owner = await HerdrLocalTabOwner.create({ runId: validateHerdrPiRunId(runId), cwd: launch.cwd, workspaceId: resolved.intent.workspaceId, maxTabs: resolved.intent.maxTabs, staleAfterMs: resolved.intent.staleAfterMs });
	try {
		let session: HerdrPiSession | undefined;
		let observeHerdr: ((event: unknown) => void) | undefined;
		await owner.provision();
		await owner.subscribe((event) => observeHerdr?.(event), () => {
			// Without a reconnect backend the pane subscription only feeds status; the bridge stays authoritative.
		});
		const agentName = `pi-${owner.runId.slice(-20)}`;
		const startedAt = Date.now();
		const { terminalId } = await owner.start(agentName, policy.args, { timeoutMs: options.startTimeoutMs ?? HERDR_LOCAL_SHELL_TIMEOUT_MS });
		if (Date.now() - startedAt > SLOW_SHELL_WARNING_MS) console.warn(`pi-subagents: the Herdr pane for ${owner.label} needed ${Math.round((Date.now() - startedAt) / 1000)}s before its shell accepted the agent; check for slow shell startup (for example a stale pyenv rehash lock).`);
		const manifest = await discoverLocalBridgeManifest(owner.runId, owner.runtimeDir);
		if (manifest.protocol !== HERDR_PI_PROTOCOL || manifest.packageVersion !== packageJson.version) throw new Error(`Local pi-subagents bridge version mismatch (tab ${manifest.packageVersion}, local ${packageJson.version}).`);
		const bridgeForward = await owner.connection.forwardRemoteSocket(manifest.socketPath, "bridge");
		const bridge = new BridgeChannel(bridgeForward.socketPath, owner.runId);
		const ready = await waitForReadyBridgeFrame(bridge, 15_000, "Local Pi tab bridge handshake timed out.");
		if (ready.packageVersion !== packageJson.version || ready.nativeSessionId !== manifest.nativeSessionId || ready.cwd !== launch.cwd) throw new Error("Local Pi tab bridge handshake identity mismatch.");
		const configured = await Promise.race([bridge.configure(policy.resources), bridge.failure]);
		if (configured.nativeSessionId !== manifest.nativeSessionId || configured.agent !== policy.resources.agent) throw new Error("Local Pi resource resolution identity mismatch.");
		if (!Array.isArray(configured.tools) || (policy.resources.toolCeiling && (configured.tools as unknown[]).some((tool) => !policy.resources.toolCeiling!.includes(String(tool))))) throw new Error("Local Pi active-tool ceiling acknowledgement mismatch.");
		if (launch.model && configured.model !== launch.model.split(":")[0]) throw new Error(`Local Pi model '${launch.model}' did not resolve to the requested provider/model.`);
		const identity: HerdrRunIdentity = { runId: owner.runId, target: "local", session: owner.connection.endpoint.session, workspaceId: owner.owned!.workspaceId, tabId: owner.owned!.tabId, paneId: owner.owned!.paneId, terminalId, agentName, nativeSessionId: manifest.nativeSessionId, cwd: launch.cwd, runtimeDir: owner.runtimeDir, label: owner.label };
		owner.journal(identity);
		// Durable placement artifact: the ownership journal is removed with the tab, this record stays.
		writePlacementRecord(owner.runId, { placed: true }, { requested: "tab", agent, cwd: launch.cwd, tabId: identity.tabId, paneId: identity.paneId, ...(owner.evidence === undefined ? {} : { evidence: owner.evidence }) });
		session = new HerdrPiSession(owner, bridgeForward, bridge, configured.tools as string[] | undefined, typeof ready.model === "string" ? ready.model : undefined, launch.runtime);
		observeHerdr = (event) => session?.observeHerdr(event);
		return session;
	} catch (error) {
		await owner.cleanup();
		throw error;
	}
}
