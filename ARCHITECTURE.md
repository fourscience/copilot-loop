# Copilot Loop: Architecture

## Principles

1. **Controller-first.** A deterministic controller owns state, transitions, validation, limits, routing, completion and safety. Agents are workers it calls inside a phase. They never drive the loop.
2. **Framework-independent core.** Everything except `src/extension.ts`, `src/ui/*`, `src/copilot/chat.ts` and `src/copilot/tools.ts` is plain TypeScript with no `vscode` import. An ESLint rule and a unit test enforce this. The whole loop runs in Vitest with `MockCopilotClient`.
3. **Ports and adapters.** The core depends on interfaces: `CopilotClient`, `GateRunner`, `StateStore`, `RunLock`, `Repository`, `Git`, `ProcessRunner`, `Clock`, `Logger`.
4. **Explicit state machine.** Every transition is checked against a table. An illegal transition is a thrown error, never a silent no-op.
5. **Small modules.** No module is a god object. The controller delegates each state to a phase handler that returns an outcome; the controller applies the transition and persists it.

## Layers

```
┌──────────────────────────── VS Code adapters ────────────────────────────┐
│ extension.ts (commands, lifecycle)  ui/{output,status,dashboard}.ts       │
│ copilot/chat.ts (vscode.lm client)   copilot/tools.ts (LM tool mapping)   │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ bootstrap.ts (composition root, no vscode)
┌───────────────▼──────────────────────── core ────────────────────────────┐
│ controller/  loop-controller · state-machine · phases · completion ·      │
│              iteration · agent-invoker                                    │
│ agents/      agent-registry · agent-router · agent-runner · agent-context │
│              agent-tools · agent-output · model-selector                  │
│ diagnosis/   failure-analyzer · failure-fingerprint · failure-classifier  │
│ gates/       gate-types · gate-registry · gate-runner · gate-parser       │
│ tasks/       task-schema · task-loader · task-validator                   │
│ persistence/ models · state-store                                         │
│ core/        errors · ports · text · redact                               │
└───────────────┬──────────────────────────────────────────────────────────┘
                │
┌───────────────▼─────────────── infrastructure adapters ──────────────────┐
│ workspace/process.ts (spawn, no shell, kill tree) · workspace/git.ts      │
│ workspace/repository.ts (git ls-files/grep, fallback walk) · files.ts     │
└──────────────────────────────────────────────────────────────────────────┘
```

## State machine

```
          ┌─────────┐
          │ INTAKE  │ preflight: gates executable? agents complete? Copilot models? baseline snapshot
          └────┬────┘
               ▼
          ┌─────────┐
          │  PLAN   │ architect → plan (skipped when a plan already exists)
          └────┬────┘
               ▼
          ┌──────────┐
          │IMPLEMENT │ claims an iteration; implementer
          └────┬─────┘
               ▼
          ┌──────────┐  all clean   ┌────────┐ complete ┌──────┐
     ┌───►│ VALIDATE ├─────────────►│ REVIEW ├─────────►│ DONE │
     │    └────┬─────┘              └───┬────┘          └──────┘
     │         │ failures               │ FAIL / unmet criteria
     │         ▼                        │ (workspace changed → VALIDATE, bounded)
     │    ┌──────────┐◄─────────────────┘
     │    │ DIAGNOSE │ deterministic router (+ diagnoser for unknown/stagnation)
     │    └────┬─────┘
     │         ▼
     │    ┌──────────┐
     └────┤   FIX    │ claims an iteration; specialists in priority order, persisted one by one
          └──────────┘

Any active state → BLOCKED (with ErrorCode) · PAUSED (remembers pausedFrom) · STOPPED
PAUSED → pausedFrom | STOPPED        BLOCKED → VALIDATE | INTAKE (Retry) | STOPPED
DONE, STOPPED: terminal
```

The table lives in `src/controller/state-machine.ts`. Tests cover every legal transition and assert that every other pair throws.

## One controller step

```
loop:
  if stop requested            → STOPPED
  if pause requested           → PAUSED
  if step guard exceeded       → BLOCKED(LOOP_LIMIT)
  if workspace missing         → BLOCKED(WORKSPACE_ERROR)
  outcome = PHASES[state](ctx, record)          // may persist intermediate progress
    on USER_CANCELLED          → STOPPED (stop) or PAUSED (interrupt)
    on any other LoopError     → BLOCKED(code)
  record = transition(outcome.record, outcome.next)
  append history record(s); save state (atomic)
```

## Completion

`src/controller/completion.ts`:

```
evaluateCompletion(ctx, reviewer):
  preReviewCheck:  every task gate ran and passed
                   every requirement mapping (gate / gate.rule) satisfied
                   no controller diagnostics (missing required tests, removed tests)
                   no required criterion failed/blocked
  if not ok → NOT COMPLETE (the reviewer is not called)
  review = reviewer()                              // invalid output → BLOCKED
  criteria = mergeReview(criteria, review)         // reviewer can't override failures; evidence must exist
  finalCheck: preReviewCheck + all required criteria verified + verdict PASS
```

The REVIEW phase also checks that the workspace fingerprint (a git tree of the working copy, `.copilot-loop/` excluded) equals the fingerprint captured at validation, both before and after the review. The tree that completes is exactly the tree that was validated.

## Failure handling

- **Fingerprints** (`diagnosis/failure-fingerprint.ts`): `{gate, rule, file, line, messageHash}`. The message is normalised (paths, durations, timestamps, addresses, stack frames, whitespace). The repeat key excludes `line`.
- **Repetition** (`updateFingerprints`): consecutive-appearance counters. They reset when a failure disappears, and resolved entries are pruned to bound state size.
- **Stagnation** (`stagnationLength`): trailing validations where neither the failure count fell nor passing gates rose. `escalation = floor(stagnation / max_no_progress)`: 1 → diagnoser, 2 → switch specialist, 3 → BLOCKED.

## Agents

- `AGENT_POLICY` (code) sets each role's maximum tool set and output kind. Agent markdown can only narrow it.
- `agent-context.ts` builds the prompt: controller policy → role → tools → output contract (system part), then task contract → repository instructions (delimited, escaped) → context packet (delimited JSON, escaped) → assignment.
- `agent-runner.ts` runs a sequential tool-calling conversation. It never sends concurrent requests to the model. It checks the context budget before each request (and compacts old tool results), enforces the turn limit, validates the JSON result, and allows one repair round.
- `agent-tools.ts`: every tool has a JSON schema (inputs validated with Ajv), goes through the path policy, and has its output redacted and truncated. Tool failures become error results for the model; only cancellation propagates.

## Persistence

`.copilot-loop/`:

```
state.json         LoopRecord (task, state, iteration, criteria, fingerprints, progress, lastGateResults w/o raw output, …)
history/0001.json  IterationRecord per step (agent, model, timestamps, gates, diagnostics, transcript, gate output tails, result)
archive/<ts>-<run>/ previous runs
run.lock           owner pid, stale takeover
gates/*.json       optional workspace gate overrides
```

`StateStore` is an interface. `JsonStateStore` serialises writes through a queue and writes atomically (tmp + rename). A SQLite store can replace it without touching the controller.

## Design decisions (and why)

| Decision | Rationale |
|---|---|
| Pause is graceful; Stop and interrupt cancel | Pausing mid-edit risks half-applied changes. Stop is for "now". Shutdown uses interrupt, so the run stays resumable. |
| `max_agent_turns` = tool-calling turns per agent run | The contract also needs a total budget, which is `max_agent_runs` (default 120). |
| Iterations = IMPLEMENT + FIX steps | Diagnosis and review do not change code, so they do not consume the modification budget. |
| Compile failures are routed alone | They cascade into test and lint failures. Fixing them first avoids wasted specialist runs. |
| Tools are passed per request, not via `vscode.lm.registerTool` | Keeps tools private to the loop and scoped per agent. |
| Workspace fingerprint = git tree from a temporary index (copy of the real index for stat-cache speed) | Exact, cheap on large repos, and never touches the user's index, HEAD or branches. |
| Gate definitions are JSON with `command` + `args` (no shell) | Avoids shell injection and quoting differences. Windows `.bat`/`.cmd` go through `cmd.exe` with explicit quoting. |
| Requirement refs `gate.rule` use suffix rule matching | Semgrep/OpenGrep prefix `check_id` with the config path. |
| Reviewer evidence must exist on disk | Stops "PASS" from being backed by invented files. |
