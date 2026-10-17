import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildSession, ChildSessionFactory, ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import { createPlacementAwareChildSessionFactory, herdrRunJournalDir, HERDR_MAX_OWNED_PANES, type HerdrRunIdentity, type PlacedRunOwner } from "../../src/runs/shared/herdr-placed-run.ts";
import { HERDR_PI_MODE_ENV } from "../../src/runs/shared/herdr-pi-protocol.ts";
import {
	classifyLocalTabFallback,
	createHerdrLocalTabSession,
	HERDR_LOCAL_TAB_LABEL_PREFIX,
	HERDR_LOCAL_TAB_MAX_CEILING,
	HERDR_LOCAL_TABS_ENV,
	HerdrLocalTabCapError,
	HerdrLocalTabUnavailable,
	parseHerdrLocalTabSettings,
	pruneLocalRuntimeDirs,
	readEnabledLocalTabPolicy,
	readHerdrLocalTabSettings,
	reapHerdrLocalTabs,
	resolveHerdrLocalTabIntent,
} from "../../src/runs/shared/herdr-local-tabs.ts";
import { herdrPiRuntimeRoot, validateHerdrPiRunId } from "../../src/runs/shared/herdr-pi-protocol.ts";
import { getAgentDir } from "../../src/shared/utils.ts";

const RUN_ID = "run_12345678";
const runtime = { runId: "op-run-1", agent: "worker", childIndex: 0, fanoutChild: false, depth: 1, maxDepth: 1, inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: false, fast: false, waitTool: { enabled: true } };
const child = (id = "local"): ChildSession => ({ subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, followUp: async () => {}, abort: async () => {}, dispose: async () => {}, messages: [], sessionFile: undefined, sessionId: id, modelId: "provider/model" });
const localFactory: ChildSessionFactory = { async create() { return child(); }, async dispose() {} };
const tabLaunch = (extra: Partial<ChildSessionLaunch> = {}): ChildSessionLaunch => ({ cwd: process.cwd(), placement: "tab", remoteResources: { agent: "worker" }, storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: true, hooks: [], noSkills: true, noContextFiles: true, tools: ["read"], runtime, ...extra });
const herdrEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_SOCKET_PATH: "/home/example/.config/herdr/herdr.sock", ...extra });
const snapshotResponse = (snapshot: Record<string, unknown>): unknown => ({ type: "session_snapshot", snapshot });
const rpc = (snapshot: Record<string, unknown>, calls: Array<{ method: string; params?: unknown }>, onCall?: (method: string) => unknown): never => ({ async call(method: string, params?: unknown) { calls.push({ method, ...(params === undefined ? {} : { params }) }); if (onCall) { const value = onCall(method); if (value !== undefined) return value; } if (method === "session.snapshot") return snapshotResponse(snapshot); return {}; } }) as never;
const journalRecord = (label: string, tabId: string, paneId: string, updatedAt: number, runId = RUN_ID): string => path.join(herdrRunJournalDir(), `${runId}.json`);

function withTempAgentDir(action: () => void | Promise<void>): Promise<void> {
	const previous = process.env.PI_CODING_AGENT_DIR, directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	return Promise.resolve(action()).finally(() => { previous === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = previous; fs.rmSync(directory, { recursive: true, force: true }); });
}

describe("local Herdr tab settings", () => {
	it("reads an absent block as undefined and rejects malformed values with the file path", () => {
		assert.equal(parseHerdrLocalTabSettings({}, "/s.json"), undefined);
		assert.equal(parseHerdrLocalTabSettings({ subagents: {} }, "/s.json"), undefined);
		assert.deepEqual(parseHerdrLocalTabSettings({ subagents: { herdrLocalTabs: { mode: "on" } } }, "/s.json"), { mode: "on", maxTabs: 4, staleAfterMinutes: 30 });
		assert.deepEqual(parseHerdrLocalTabSettings({ subagents: { herdrLocalTabs: { mode: "on", agents: ["worker", "reviewer"], maxTabs: 2, staleAfterMinutes: 5 } } }, "/s.json"), { mode: "on", agents: ["worker", "reviewer"], maxTabs: 2, staleAfterMinutes: 5 });
		// An empty allow-list means nobody may be placed, not everybody.
		assert.deepEqual(parseHerdrLocalTabSettings({ subagents: { herdrLocalTabs: { mode: "on", agents: [] } } }, "/s.json"), { mode: "on", agents: [], maxTabs: 4, staleAfterMinutes: 30 });
		for (const value of [{ mode: "maybe" }, { maxTabs: 0 }, { maxTabs: HERDR_LOCAL_TAB_MAX_CEILING + 1 }, { maxTabs: 1.5 }, { staleAfterMinutes: 0 }, { agents: "worker" }, { agents: ["../evil"] }, { agents: [1] }]) {
			assert.throws(() => parseHerdrLocalTabSettings({ subagents: { herdrLocalTabs: value } }, "/s.json"), /'\/s\.json'/u, JSON.stringify(value));
		}
		assert.throws(() => parseHerdrLocalTabSettings({ subagents: { herdrLocalTabs: [] } }, "/s.json"), /herdrLocalTabs/u);
	});
	it("merges project settings over user settings field by field", async () => {
		await withTempAgentDir(async () => {
			const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
			try {
				fs.mkdirSync(path.join(getAgentDir()), { recursive: true });
				fs.writeFileSync(path.join(getAgentDir(), "settings.json"), JSON.stringify({ subagents: { herdrLocalTabs: { mode: "on", maxTabs: 3 } } }));
				fs.mkdirSync(path.join(project, ".pi"));
				fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ subagents: { herdrLocalTabs: { mode: "off", staleAfterMinutes: 5 } } }));
				const nested = path.join(project, "packages", "app");
				fs.mkdirSync(nested, { recursive: true });
				assert.deepEqual(readHerdrLocalTabSettings(nested), { mode: "off", maxTabs: 3, staleAfterMinutes: 5 });
				assert.deepEqual(readHerdrLocalTabSettings(os.tmpdir()), { mode: "on", maxTabs: 3, staleAfterMinutes: 30 });
			} finally {
				fs.rmSync(project, { recursive: true, force: true });
			}
		});
	});
	it("warns once instead of throwing on a malformed block", () => withTempAgentDir(() => {
		fs.mkdirSync(getAgentDir(), { recursive: true });
		fs.writeFileSync(path.join(getAgentDir(), "settings.json"), JSON.stringify({ subagents: { herdrLocalTabs: { mode: "sometimes" } } }));
		const warnings: string[] = [], previous = console.warn;
		console.warn = (message?: unknown) => void warnings.push(String(message));
		try {
			assert.deepEqual(readEnabledLocalTabPolicy({ cwd: process.cwd() }), { enabled: false, reason: "Subagent settings in '" + path.join(getAgentDir(), "settings.json") + "' have invalid 'herdrLocalTabs.mode'; expected \"off\" or \"on\"." });
			assert.deepEqual(readEnabledLocalTabPolicy({ cwd: process.cwd() }), { enabled: false, reason: "Subagent settings in '" + path.join(getAgentDir(), "settings.json") + "' have invalid 'herdrLocalTabs.mode'; expected \"off\" or \"on\"." });
		} finally { console.warn = previous; }
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /herdrLocalTabs\.mode/u);
	}));
});

describe("local Herdr tab intent", () => {
	it("requires an opt-in, a Herdr session, and an eligible agent", async () => {
		await withTempAgentDir(() => {
			fs.mkdirSync(getAgentDir(), { recursive: true });
			fs.writeFileSync(path.join(getAgentDir(), "settings.json"), JSON.stringify({ subagents: { herdrLocalTabs: { mode: "on", agents: ["worker"] } } }));
			assert.deepEqual(resolveHerdrLocalTabIntent({ agent: "worker", cwd: process.cwd(), env: herdrEnv() }).ok, true);
			const intent = resolveHerdrLocalTabIntent({ agent: "worker", cwd: process.cwd(), env: herdrEnv() });
			if (intent.ok) assert.deepEqual(intent.intent, { workspaceId: "w1", socketPath: "/home/example/.config/herdr/herdr.sock", maxTabs: 4, staleAfterMs: 30 * 60_000 });
			const foreign = resolveHerdrLocalTabIntent({ agent: "scout", cwd: process.cwd(), env: herdrEnv() });
			assert.equal(foreign.ok, false);
			if (!foreign.ok) assert.match(foreign.reason, /not listed/u);
			const outside = resolveHerdrLocalTabIntent({ agent: "worker", cwd: process.cwd(), env: {} });
			assert.equal(outside.ok, false);
			if (!outside.ok) assert.match(outside.reason, /not running inside a Herdr session/u);
			const noWorkspace = resolveHerdrLocalTabIntent({ agent: "worker", cwd: process.cwd(), env: herdrEnv({ HERDR_WORKSPACE_ID: "" }) });
			assert.equal(noWorkspace.ok, false);
			const relativeSocket = resolveHerdrLocalTabIntent({ agent: "worker", cwd: process.cwd(), env: herdrEnv({ HERDR_SOCKET_PATH: "herdr.sock" }) });
			assert.equal(relativeSocket.ok, false);
			if (!relativeSocket.ok) assert.match(relativeSocket.reason, /socket identity/u);
			const off = readEnabledLocalTabPolicy({ cwd: process.cwd(), env: herdrEnv({ [HERDR_LOCAL_TABS_ENV]: "0" }) });
			assert.equal(off.enabled, false);
			if (!off.enabled) assert.match(off.reason, new RegExp(HERDR_LOCAL_TABS_ENV, "u"));
			const forced = resolveHerdrLocalTabIntent({ agent: "worker", cwd: process.cwd(), env: herdrEnv({ [HERDR_LOCAL_TABS_ENV]: "on" }) });
			assert.equal(forced.ok, true);
			assert.equal(resolveHerdrLocalTabIntent({ agent: "worker", cwd: process.cwd(), machine: { id: "m1" }, env: herdrEnv() }).ok, false);
			assert.equal(resolveHerdrLocalTabIntent({ agent: "worker", cwd: process.cwd(), env: herdrEnv({ [HERDR_PI_MODE_ENV]: "1" }) }).ok, false);
		});
	});
	it("clamps a configured tab cap to the ceiling and treats unknown failures as failures", async () => {
		await withTempAgentDir(() => {
			fs.mkdirSync(getAgentDir(), { recursive: true });
			fs.writeFileSync(path.join(getAgentDir(), "settings.json"), JSON.stringify({ subagents: { herdrLocalTabs: { mode: "on", maxTabs: HERDR_LOCAL_TAB_MAX_CEILING } } }));
			const intent = resolveHerdrLocalTabIntent({ agent: "worker", cwd: process.cwd(), env: herdrEnv() });
			assert.equal(intent.ok, true);
			if (intent.ok) assert.equal(intent.intent.maxTabs, HERDR_LOCAL_TAB_MAX_CEILING);
			assert.deepEqual(classifyLocalTabFallback(new HerdrLocalTabUnavailable("nope")), { kind: "unsupported", reason: "nope" });
			assert.deepEqual(classifyLocalTabFallback(new Error("boom")), { kind: "failed", reason: "boom" });
			assert.deepEqual(classifyLocalTabFallback("plain"), { kind: "failed", reason: "plain" });
		});
	});
});

describe("local Herdr tab fallback", () => {
	it("downgrades an unavailable tab to the in-process child and records the reason", async () => withTempAgentDir(async () => {
		const session = await createPlacementAwareChildSessionFactory(localFactory, undefined, async () => { throw new HerdrLocalTabUnavailable("Herdr is not installed."); }).create(tabLaunch());
		assert.equal(session.sessionId, "local");
		assert.deepEqual(session.localTabPlacement, { placed: false, kind: "unsupported", reason: "Herdr is not installed." });
		const record = JSON.parse(fs.readFileSync(path.join(herdrRunJournalDir(), `${runtime.runId}.placement.json`), "utf8")) as Record<string, unknown>;
		assert.deepEqual({ ...record, at: "ignored" }, { version: 1, at: "ignored", requested: "tab", agent: "worker", cwd: process.cwd(), placed: false, kind: "unsupported", reason: "Herdr is not installed." });
	}));
	it("keeps the local child when a placement attempt fails unexpectedly", async () => withTempAgentDir(async () => {
		const session = await createPlacementAwareChildSessionFactory(localFactory, undefined, async () => { throw new Error("socket explosion"); }).create(tabLaunch());
		assert.equal(session.sessionId, "local");
		assert.deepEqual(session.localTabPlacement, { placed: false, kind: "failed", reason: "socket explosion" });
	}));
	it("uses the placed child and never the local factory when placement succeeds", async () => {
		let localCalls = 0, placedCalls = 0;
		const placed = child("placed");
		const factory = createPlacementAwareChildSessionFactory({ async create() { localCalls++; return child(); }, async dispose() {} }, undefined, async () => { placedCalls++; return placed; });
		const session = await factory.create(tabLaunch());
		assert.equal(session, placed);
		assert.deepEqual(session.localTabPlacement, { placed: true });
		assert.deepEqual([localCalls, placedCalls], [0, 1]);
	});
	it("leaves non-tab and saved-machine launches untouched", async () => {
		let remoteCalls = 0, localTabs = 0;
		const factory = createPlacementAwareChildSessionFactory(localFactory, async () => { remoteCalls++; return child("remote"); }, async () => { localTabs++; return child(); });
		const plain = await factory.create({ ...tabLaunch(), placement: undefined });
		assert.equal(plain.sessionId, "local");
		assert.equal(plain.localTabPlacement, undefined);
		const placed = await factory.create(tabLaunch({ machine: { provider: "herdr", id: "m1", label: "mac", target: "host", cwd: "/remote" }, cwd: "/remote" }));
		assert.equal(placed.sessionId, "remote");
		assert.deepEqual([remoteCalls, localTabs], [1, 0]);
	});
	it("refuses to place a launch shape that has no local bridge equivalent", async () => {
		await assert.rejects(() => createHerdrLocalTabSession(tabLaunch({ machine: { provider: "herdr", id: "m1", label: "mac", target: "host", cwd: "/remote" } })), HerdrLocalTabUnavailable);
		await assert.rejects(() => createHerdrLocalTabSession({ ...tabLaunch(), remoteResources: { agent: "../evil" } }), HerdrLocalTabUnavailable);
		await assert.rejects(() => createHerdrLocalTabSession(tabLaunch({ runtime: { ...runtime, depth: 2 } })), HerdrLocalTabUnavailable);
		await assert.rejects(() => createHerdrLocalTabSession(tabLaunch({ storage: { kind: "file", sessionDir: "/sessions" } })), HerdrLocalTabUnavailable);
		await assert.rejects(() => createHerdrLocalTabSession({ ...tabLaunch(), cwd: "/does/not/exist" }), HerdrLocalTabUnavailable);
	});
});

describe("local Herdr tab reaping", () => {
	const snapshot = (tabs: Array<Record<string, unknown>>, panes: Array<Record<string, unknown>>, agents: Array<Record<string, unknown>> = []) => ({ tabs, panes, agents });
	const writeJournal = (record: Record<string, unknown>, runId = RUN_ID): void => { fs.mkdirSync(herdrRunJournalDir(), { recursive: true }); fs.writeFileSync(journalRecord(record.label as string, record.tabId as string, record.paneId as string, 0, runId), JSON.stringify({ version: 1, placement: "local-tab", runId, terminalId: "term1", workspaceId: "w1", updatedAt: 0, ...record })); };
	it("closes only an owned tab whose run is gone, and never a tab without a matching journal", async () => withTempAgentDir(async () => {
		writeJournal({ label: `${HERDR_LOCAL_TAB_LABEL_PREFIX}12345678`, tabId: "t1", paneId: "p1" });
		const calls: Array<{ method: string; params?: unknown }> = [];
		const result = await reapHerdrLocalTabs({ client: rpc(snapshot([{ tab_id: "t1", workspace_id: "w1", label: `${HERDR_LOCAL_TAB_LABEL_PREFIX}12345678` }, { tab_id: "t2", workspace_id: "w1", label: `${HERDR_LOCAL_TAB_LABEL_PREFIX}deadbee1` }], [{ pane_id: "p1", tab_id: "t1" }]), calls), workspaceId: "w1", now: 10 * 60 * 60_000 });
		assert.deepEqual(result.closed, ["t1"]);
		assert.deepEqual(result.kept, [{ tabId: "t2", reason: "no matching ownership journal" }]);
		assert.deepEqual(calls.map((entry) => entry.method), ["session.snapshot", "pane.close"]);
		assert.equal(fs.existsSync(journalRecord(`${HERDR_LOCAL_TAB_LABEL_PREFIX}12345678`, "t1", "p1")), false);
	}));
	it("never closes a pane that still holds an agent, and never one whose process is alive", async () => withTempAgentDir(async () => {
		writeJournal({ label: `${HERDR_LOCAL_TAB_LABEL_PREFIX}12345678`, tabId: "t1", paneId: "p1" });
		const calls: Array<{ method: string }> = [];
		const tabs = [{ tab_id: "t1", workspace_id: "w1", label: `${HERDR_LOCAL_TAB_LABEL_PREFIX}12345678` }], panes = [{ pane_id: "p1", tab_id: "t1" }];
		const busy = await reapHerdrLocalTabs({ client: rpc(snapshot(tabs, panes, [{ terminal_id: "term1", pane_id: "p1", agent_status: "working" }]), calls), now: 10 * 60 * 60_000 });
		assert.deepEqual(busy.closed, []);
		assert.deepEqual(busy.kept, [{ tabId: "t1", reason: "owned pane still runs an agent" }]);
		const directory = path.join(herdrPiRuntimeRoot(getAgentDir()), RUN_ID);
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ runId: RUN_ID, pid: process.pid, socketPath: path.join(directory, "bridge.sock") }));
		const aliveInAgentPane = await reapHerdrLocalTabs({ client: rpc(snapshot(tabs, panes, [{ terminal_id: "term1", pane_id: "p1", agent_status: "settled" }]), calls), now: 10 * 60 * 60_000 });
		assert.deepEqual(aliveInAgentPane.kept, [{ tabId: "t1", reason: "owned pane still runs an agent" }]);
		const aliveInEmptyPane = await reapHerdrLocalTabs({ client: rpc(snapshot(tabs, panes), calls), now: 10 * 60 * 60_000 });
		assert.deepEqual(aliveInEmptyPane.kept, [{ tabId: "t1", reason: "the recorded child process is still alive" }]);
		assert.deepEqual(calls.map((entry) => entry.method), ["session.snapshot", "session.snapshot", "session.snapshot"]);
	}));
	it("reclaims a dead run with strong evidence, refuses an inconsistent snapshot, and honours dryRun", async () => withTempAgentDir(async () => {
		writeJournal({ label: `${HERDR_LOCAL_TAB_LABEL_PREFIX}12345678`, tabId: "t1", paneId: "p1" });
		const tabs = [{ tab_id: "t1", workspace_id: "w1", label: `${HERDR_LOCAL_TAB_LABEL_PREFIX}12345678` }], panes = [{ pane_id: "p1", tab_id: "t1" }];
		const directory = path.join(herdrPiRuntimeRoot(getAgentDir()), RUN_ID);
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ runId: RUN_ID, pid: 999_999_999, socketPath: path.join(directory, "bridge.sock") }));
		const calls: Array<{ method: string }> = [];
		const dry = await reapHerdrLocalTabs({ client: rpc(snapshot(tabs, panes), calls), dryRun: true, now: 10 * 60 * 60_000 });
		assert.deepEqual(dry.kept, [{ tabId: "t1", reason: "would close: the recorded child process has exited" }]);
		const inconsistent = await reapHerdrLocalTabs({ client: rpc(snapshot(tabs, []), calls), now: 10 * 60 * 60_000 });
		assert.deepEqual(inconsistent.kept, [{ tabId: "t1", reason: "Herdr reported owned tabs but no panes; refusing to reap" }]);
		assert.deepEqual(calls.map((entry) => entry.method), ["session.snapshot", "session.snapshot"]);
	}));
	it("prunes only run directories whose owning process is gone", async () => withTempAgentDir(() => {
		const root = herdrPiRuntimeRoot(getAgentDir());
		fs.mkdirSync(root, { recursive: true });
		const dead = path.join(root, validateHerdrPiRunId("run_deadbeef")), alive = path.join(root, validateHerdrPiRunId("run_alive001"));
		fs.mkdirSync(dead); fs.mkdirSync(alive);
		fs.writeFileSync(path.join(alive, "manifest.json"), JSON.stringify({ runId: "run_alive001", pid: process.pid, socketPath: path.join(alive, "bridge.sock") }));
		fs.writeFileSync(path.join(dead, "manifest.json"), JSON.stringify({ runId: "run_deadbeef", pid: 999_999_999, socketPath: path.join(dead, "bridge.sock") }));
		assert.deepEqual(pruneLocalRuntimeDirs(Date.now(), 60_000), [dead]);
		assert.deepEqual([fs.existsSync(dead), fs.existsSync(alive)], [false, true]);
	}));
});

describe("local Herdr tab provisioning", () => {
	const tabCreated = (workspaceId: string, tabId: string, paneId: string): unknown => ({ type: "tab_created", tab: { tab_id: tabId, workspace_id: workspaceId }, root_pane: { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId } });
	const input = { workspaceId: "w1", cwd: "/tmp", runId: RUN_ID, runtimeDir: "/tmp/run", maxTabs: 2, staleAfterMs: 60_000 };
	it("refuses a second tab for the same run identity and surfaces a structured cap error", async () => withTempAgentDir(async () => {
		const { provisionHerdrLocalTab } = await import("../../src/runs/shared/herdr-local-tabs.ts");
		const calls: Array<{ method: string; params?: unknown }> = [];
		const duplicate = rpc({ tabs: [{ tab_id: "t1", workspace_id: "w1", label: `${HERDR_LOCAL_TAB_LABEL_PREFIX}12345678` }], panes: [], agents: [] }, calls);
		await assert.rejects(() => provisionHerdrLocalTab(duplicate, input), /second local tab for the same run identity/u);
		const full = rpc({ tabs: [{ tab_id: "t1", workspace_id: "w1", label: `${HERDR_LOCAL_TAB_LABEL_PREFIX}aaaaaaaa` }, { tab_id: "t2", workspace_id: "w1", label: `${HERDR_LOCAL_TAB_LABEL_PREFIX}bbbbbbbb` }], panes: [], agents: [] }, calls);
		const error = await provisionHerdrLocalTab(full, input).catch((value: unknown) => value);
		assert.ok(error instanceof HerdrLocalTabCapError);
		assert.deepEqual([(error as HerdrLocalTabCapError).owned, (error as HerdrLocalTabCapError).maxTabs], [2, 2]);
		assert.match((error as Error).message, /herdrLocalTabs\.maxTabs/u);
	}));
	it("creates the tab with the ownership label, the bridge environment, and no focus steal", async () => withTempAgentDir(async () => {
		const { provisionHerdrLocalTab } = await import("../../src/runs/shared/herdr-local-tabs.ts");
		const calls: Array<{ method: string; params?: unknown }> = [];
		let state = { workspaces: [{ workspace_id: "w1" }], tabs: [] as Array<Record<string, unknown>>, panes: [] as Array<Record<string, unknown>>, agents: [] as Array<Record<string, unknown>> };
		const client = { async call(method: string, params?: unknown) { calls.push({ method, ...(params === undefined ? {} : { params }) }); if (method === "session.snapshot") return snapshotResponse(state); if (method === "tab.create") { state = { ...state, tabs: [{ tab_id: "t9", workspace_id: "w1", label: `${HERDR_LOCAL_TAB_LABEL_PREFIX}12345678` }], panes: [{ pane_id: "p9", tab_id: "t9" }] }; return tabCreated("w1", "t9", "p9"); } return {}; } } as never;
		assert.deepEqual(await provisionHerdrLocalTab(client, input), { workspaceId: "w1", tabId: "t9", paneId: "p9" });
		assert.deepEqual(calls.map((entry) => entry.method), ["session.snapshot", "tab.create"]);
		assert.deepEqual(calls[1]!.params, { workspace_id: "w1", cwd: "/tmp", label: `${HERDR_LOCAL_TAB_LABEL_PREFIX}12345678`, env: { [HERDR_PI_MODE_ENV]: "1", PI_SUBAGENTS_HERDR_RUN_ID: RUN_ID, PI_SUBAGENTS_HERDR_RUNTIME_DIR: "/tmp/run" }, focus: false });
	}));
	it("rejects an inconsistent identity and refuses a missing workspace", async () => withTempAgentDir(async () => {
		const { provisionHerdrLocalTab } = await import("../../src/runs/shared/herdr-local-tabs.ts");
		const calls: Array<{ method: string }> = [];
		const wrong = { async call(method: string) { calls.push({ method }); return method === "session.snapshot" ? snapshotResponse({ tabs: [{ tab_id: "t1", workspace_id: "w1" }], panes: [], agents: [] }) : tabCreated("w2", "t9", "p9"); } } as never;
		await assert.rejects(() => provisionHerdrLocalTab(wrong, input), /unexpected workspace/u);
		const absent = { async call() { return snapshotResponse({ tabs: [], panes: [], agents: [] }); } } as never;
		await assert.rejects(() => provisionHerdrLocalTab(absent, input), /no longer exists/u);
	}));
	it("refuses to exceed the pane budget with owned tabs", async () => withTempAgentDir(async () => {
		const { provisionHerdrLocalTab } = await import("../../src/runs/shared/herdr-local-tabs.ts");
		const tabs = Array.from({ length: HERDR_MAX_OWNED_PANES }, (_value, index) => ({ tab_id: `t${index}`, workspace_id: index < 3 ? "w1" : "w2", label: `${HERDR_LOCAL_TAB_LABEL_PREFIX}${index}` }));
		const client = { async call(method: string) { return snapshotResponse({ tabs, panes: [], agents: [] }); } } as never;
		await assert.rejects(() => provisionHerdrLocalTab(client, { ...input, maxTabs: 4 }), /pane budget/u);
	}));
	it("removes an owned run directory idempotently and refuses foreign paths", async () => withTempAgentDir(async () => {
		const { createLocalRuntimeDir, removeLocalRuntimeDir } = await import("../../src/runs/shared/herdr-local-tabs.ts");
		const directory = createLocalRuntimeDir("run_12345678");
		assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
		removeLocalRuntimeDir(directory);
		assert.equal(fs.existsSync(directory), false);
		// A second removal is a no-op, so a cleanup can never mask the placement error that caused it.
		removeLocalRuntimeDir(directory);
		assert.throws(() => removeLocalRuntimeDir("/tmp/not-ours"), /not an owned run runtime directory/u);
	}));

	it("requires the child to prove the exact tool contract", async () => {
		const { assertLocalToolContract } = await import("../../src/runs/shared/herdr-local-tabs.ts");
		assertLocalToolContract({ toolCeiling: ["read", "bash"], requiredTools: ["read"] }, ["read"]);
		assert.throws(() => assertLocalToolContract({ toolCeiling: ["read"] }, ["read", "bash"]), /ceiling acknowledgement mismatch/u);
		assert.throws(() => assertLocalToolContract({ requiredTools: ["read", "bash"] }, ["read"]), /did not activate required tool\(s\): bash/u);
		assert.throws(() => assertLocalToolContract({}, undefined), /active-tool acknowledgement mismatch/u);
	});

	it("keeps an owned run owner surface that a shared transport can drive", () => {
		const owner: PlacedRunOwner = { connection: { socketPath: "/tmp/x", client: { call: async () => ({}), subscribe: async () => () => {} }, close: async () => {} } as never, snapshot: { connection: "connected", state: "ready", revision: 0 }, observeEvent: () => {}, markConnectionUnknown: () => true, replaceConnection: async () => {}, cleanup: async () => {} };
		const identity: HerdrRunIdentity = { runId: RUN_ID, target: "local", session: null, workspaceId: "w1", tabId: "t1", paneId: "p1", terminalId: "term1", agentName: "pi-run", nativeSessionId: "native", cwd: "/tmp", runtimeDir: "/tmp/run", label: `${HERDR_LOCAL_TAB_LABEL_PREFIX}12345678` };
		assert.equal(owner.snapshot.state, "ready");
		assert.equal(identity.machineId, undefined);
	});
});

describe("local Herdr tab preflight", () => {
	const stubHerdr = (directory: string, status: string, integration: string): string => {
		const script = path.join(directory, "herdr");
		fs.writeFileSync(script, `#!/usr/bin/env bash\ncase "$1 $2" in "status server") printf '%s' '${status}';; "integration status") printf '%s' '${integration}';; esac\nexit 0\n`);
		fs.chmodSync(script, 0o700);
		return script;
	};

	it("keeps the pane budget mirror in sync with the transport constant", async () => {
		const { HERDR_LOCAL_TAB_PANE_BUDGET } = await import("../../src/shared/herdr-local-tab-settings.ts");
		assert.equal(HERDR_LOCAL_TAB_PANE_BUDGET, HERDR_MAX_OWNED_PANES);
		assert.equal(HERDR_LOCAL_TAB_MAX_CEILING, Math.min(12, HERDR_MAX_OWNED_PANES - 4));
	});

	it("reports the policy, the Herdr protocol, the Pi integration, and owned leftovers", async () => withTempAgentDir(async () => {
		const { diagnoseHerdrLocalTabs } = await import("../../src/shared/herdr-local-tab-settings.ts");
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-doctor-"));
		try {
			fs.mkdirSync(path.join(getAgentDir()), { recursive: true });
			fs.writeFileSync(path.join(getAgentDir(), "settings.json"), JSON.stringify({ subagents: { herdrLocalTabs: { mode: "on", agents: ["worker"], maxTabs: 3 } } }));
			const socketPath = path.join(root, "herdr.sock");
			fs.writeFileSync(socketPath, "");
			const binary = stubHerdr(root, '{"running":true,"version":"0.9.1","protocol":22,"compatible":true}', "pi: current (v9)\nclaude: not installed\n");
			const lines = diagnoseHerdrLocalTabs({ cwd: root, env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_BIN_PATH: binary } });
			assert.match(lines.join("\n"), /- placement: enabled \(cap 3, stale after 30m, agents worker\)/u);
			assert.match(lines.join("\n"), /- kill switch: PI_SUBAGENTS_HERDR_TABS=unset/u);
			assert.match(lines.join("\n"), /- socket: .*herdr\.sock \(present\)/u);
			assert.match(lines.join("\n"), /- herdr server: running, version 0\.9\.1, protocol 22, compatible yes/u);
			assert.match(lines.join("\n"), /- pi integration: pi: current \(v9\)\n/u);
			assert.match(lines.join("\n"), /- owned records: 0 journals, 0 stale run directories/u);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}));

	it("stays silent about Herdr when this host has no endpoint, and explains a disabled policy", async () => withTempAgentDir(async () => {
		const { diagnoseHerdrLocalTabs } = await import("../../src/shared/herdr-local-tab-settings.ts");
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-doctor-absent-"));
		try {
			fs.mkdirSync(path.join(getAgentDir()), { recursive: true });
			fs.writeFileSync(path.join(getAgentDir(), "settings.json"), JSON.stringify({ subagents: { herdrLocalTabs: { mode: "off" } } }));
			const text = diagnoseHerdrLocalTabs({ cwd: root, env: { HOME: root } }).join("\n");
			assert.match(text, /- placement: disabled — local tabs are off in subagents\.herdrLocalTabs/u);
			assert.match(text, /- herdr server: not checked \(no Herdr endpoint on this host\)/u);
			assert.match(text, /- pi integration: not checked \(no Herdr endpoint on this host\)/u);
			assert.match(text, /- note: a placed run still falls back to the in-process child/u);
			const off = diagnoseHerdrLocalTabs({ cwd: root, env: { HOME: root, [HERDR_LOCAL_TABS_ENV]: "off" } }).join("\n");
			assert.match(off, /- placement: disabled — disabled by PI_SUBAGENTS_HERDR_TABS/u);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}));

	it("reports a stale Pi integration as actionable", async () => withTempAgentDir(async () => {
		const { diagnoseHerdrLocalTabs } = await import("../../src/shared/herdr-local-tab-settings.ts");
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-doctor-outdated-"));
		try {
			fs.mkdirSync(path.join(getAgentDir()), { recursive: true });
			fs.writeFileSync(path.join(getAgentDir(), "settings.json"), JSON.stringify({ subagents: { herdrLocalTabs: { mode: "on" } } }));
			const socketPath = path.join(root, "herdr.sock");
			fs.writeFileSync(socketPath, "");
			const binary = stubHerdr(root, '{"running":false,"version":"0.9.1","protocol":22,"compatible":false}', "pi: outdated (v8 < v9) (/tmp/herdr-agent-state.ts)\n");
			const text = diagnoseHerdrLocalTabs({ cwd: root, env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_BIN_PATH: binary } }).join("\n");
			assert.match(text, /- herdr server: not running, version 0\.9\.1, protocol 22, compatible no/u);
			assert.match(text, /- pi integration: .*outdated \(v8 < v9\).*run `herdr integration install pi`/u);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}));
});
