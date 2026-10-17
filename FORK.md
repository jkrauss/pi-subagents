# Fork: local Herdr tab placement

This is a fork of [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) that adds a
**local tab placement backend**: native Pi subagents are started as real Pi processes in
[Herdr](https://herdr.dev) tabs on the same host, behind `subagents.herdrLocalTabs` (default off).

- Base: `v0.79.0` (`1e272e942bd8d2e6446494ce5de7a21a3f58ab55`)
- Fork tag: `v0.79.0-herdr-local-tabs.2` (`ae607d925793487768d8c90586c49df35a8415fb`)
- See [docs/agents.md](docs/agents.md) → *Running native Pi children in local Herdr tabs* and
  [docs/configuration.md](docs/configuration.md) → `subagents.herdrLocalTabs`.

## Installing this fork (pinned revision)

```bash
pi remove npm:pi-subagents                                        # avoid two copies
pi install "git:github.com/jkrauss/pi-subagents#<commit-sha>"     # pin the fork revision
```

A local checkout is equivalent and easier to rebase: `pi install /path/to/pi-subagents`.

## Why this fork exists

Upstream starts children in-process. Operators who run Pi inside Herdr want to *watch* a long child
(supervision, steering, reading its transcript) instead of waiting for a summary. The backend is a
placement optimization, never a gate: every reason a launch cannot be placed — placement disabled,
no Herdr socket, incompatible protocol, tab cap reached, bridge handshake or tool-contract mismatch —
falls back to the ordinary in-process child and records the reason in
`~/.pi/agent/pi-subagents/herdr-run-journal/<runId>.placement.json`. Only an explicit saved-machine
launch (`machine`) fails closed.

## Revision notes

`.2` — **the started agent must be addressable before anything is committed.** Herdr answers
`agent.start` before the agent is registered, so a prompt sent in that window fails with
`agent <name> is not an active named agent`; because that happened after the placement record was
written, a placed run died instead of falling back in-process, which silently turned placement into
a gate. `start()` now waits for `agent.get {target: <name>}` to report the exact requested `name`,
the owned `pane_id` and `interactive_ready === true` (bounded by `readyTimeoutMs`, 20s by default;
a name now bound to a foreign pane fails closed), and a transiently rejected start adopts the agent
it already started instead of starting a second one (busy-shell retries back off 400ms).

`.1` — initial local tab placement backend (local Herdr socket, reaper, tab cap, doctor preflight,
owner-based dir safety, runnable contract check).

## Divergence from upstream

`git log --oneline 1e272e94..HEAD` — placement backend, launch plumbing, doctor preflight, docs,
and tests. Nothing outside the placement feature is changed, so `git rebase 1e272e94` onto a newer
upstream tag is a normal rebase (see the runbook in the `herdr-subagent-tabs` skill).
