# Copilot Loop

A **controller-first, deterministic multi-agent engineering loop** for VS Code. You give it a task contract (goal, constraints, acceptance criteria and validation gates). It assigns work to specialised GitHub Copilot agents through the **VS Code Language Model API** and keeps going until every required criterion is met, or until it stops with a clear reason.

> The LLM never decides that the task is complete. The controller does.

A task is complete only when **all** of these hold:

1. Every required deterministic gate passes (the gates run as real processes, outside the LLM).
2. Every required acceptance criterion is `verified`, with evidence that exists in the workspace.
3. The reviewer agent returns `PASS`.
4. No safety or iteration limit has been exceeded, and the workspace is byte-identical to the tree that was validated.

An agent saying "done" has no effect.

```
TASK CONTRACT
      │
      ▼
  ARCHITECT ──► plan
      │
      ▼
 IMPLEMENTER ──► code changes
      │
      ▼
DETERMINISTIC VALIDATION  (dart analyze · flutter test · DCM · OpenGrep · architecture · security …)
      │
      ├── PASS ──► REVIEWER ──► PASS ──► DONE
      │                  └────► FAIL ──┐
      └── FAIL                         │
            ▼                          ▼
        DIAGNOSE  ◄────────────────────┘
   (deterministic router; diagnoser agent for unknown/stuck failures)
            │
   ┌────────┼──────────┬──────────┬───────────┐
 DEBUG    TEST       ARCH        SEC        QUALITY
(debugger)(test-eng.)(arch-fixer)(security)(refactoring)
   └────────┴──────────┴──────────┴───────────┘
            │
            ▼
   DETERMINISTIC VALIDATION ──► loop (bounded by limits, fingerprints, no-progress detection)
```

---

## Contents

1. [Installation](#1-installation)
2. [VS Code requirements](#2-vs-code-requirements)
3. [Copilot requirements](#3-copilot-requirements)
4. [Organization requirements](#4-organization-requirements)
5. [Creating a task](#5-creating-a-task)
6. [How agents work](#6-how-agents-work)
7. [How gates work](#7-how-gates-work)
8. [How routing works](#8-how-routing-works)
9. [Adding an agent](#9-adding-an-agent)
10. [Adding a gate](#10-adding-a-gate)
11. [Integrating OpenGrep](#11-integrating-opengrep)
12. [Integrating DCM](#12-integrating-dcm)
13. [Integrating the Flutter Constitution](#13-integrating-the-flutter-constitution)
14. [Debugging the loop](#14-debugging-the-loop)
15. [Resuming after a restart](#15-resuming-after-a-restart)
16. [Safety limitations](#16-safety-limitations)

Also see [ARCHITECTURE.md](ARCHITECTURE.md) for design and module structure.

---

## 1. Installation

From source:

```bash
npm ci
npm run check          # typecheck + lint + tests + build
npx @vscode/vsce package   # produces copilot-loop-<version>.vsix
code --install-extension copilot-loop-0.1.0.vsix
```

For development, open the folder in VS Code and press <kbd>F5</kbd> (Extension Development Host). The extension compiles to `out/`, and `npm run watch` rebuilds on change.

The extension needs **no Copilot CLI**. It talks only to the VS Code Language Model API (`vscode.lm.selectChatModels`, `LanguageModelChat.sendRequest`, streaming responses and LM tool calling).

## 2. VS Code requirements

- VS Code **1.95 or newer**, which has the stable Language Model API with tool calling (`LanguageModelChatTool`, `LanguageModelToolCallPart`, `LanguageModelToolResultPart`).
- A **trusted** local folder workspace. The extension runs validation commands and lets agents edit files, so it refuses untrusted and virtual workspaces.
- `git` on `PATH` (recommended). It enables precise change tracking, diffs for agents, workspace fingerprints and optional checkpoints. Without git the loop still works, with reduced precision.
- The tools your gates call (`dart`, `flutter`, `dcm`, `opengrep`, …) must be on `PATH` for the VS Code process.

## 3. Copilot requirements

- The **GitHub Copilot Chat** extension, installed and signed in.
- At least one Copilot chat model visible to `vscode.lm.selectChatModels({ vendor: 'copilot' })`.
- The first request shows VS Code's consent prompt ("Copilot Loop wants to use the language model…"). Allow it.

If no Copilot model is available, the loop goes to `BLOCKED (MODEL_UNAVAILABLE)` and says why. It **never** falls back to another provider.

## 4. Organization requirements

- Copilot Chat must be enabled for the user by the organization's Copilot policy.
- **Copilot CLI is not required and not used.** This is designed for organizations that disable it.
- The models your organization enables determine what the model selector can choose from. The selector is capability-based and never hard-codes a model id. You can steer it per agent with the `copilotLoop.modelPreferences` setting.
- Everything runs locally in the user's VS Code. Nothing is pushed, committed or published (see [safety](#16-safety-limitations)).

## 5. Creating a task

A task contract is a YAML file validated against [`schemas/task.schema.json`](schemas/task.schema.json) with a real YAML parser (`yaml`) and a JSON-Schema validator (`ajv`). Invalid contracts are rejected with every problem listed. Unknown keys, duplicate keys and malformed values all count as errors.

```yaml
id: AUTH-142
title: Implement biometric re-authentication
goal: >
  Implement biometric re-authentication after inactivity
  while preserving the existing authentication architecture.

constraints:
  - no new third-party dependencies
  - no BLoC
  - MVVM
  - domain must not depend on Flutter

acceptance:                                   # strings get ids AC-001, AC-002, …
  - id: AC-001
    description: biometric authentication is requested after inactivity
    evidence:
      tests: [test/auth/biometric_reauth_test.dart]   # must exist and pass
  - id: AC-007
    description: architecture validation passes
    evidence:
      gates: [architecture, opengrep]                 # must pass
  - cancellation does not crash the application      # verified by reviewer + evidence

required_tests:
  - test/auth/biometric_reauth_test.dart

gates: [dart_analyze, flutter_test, dcm, opengrep, architecture, security]

requirements:                                 # requirement → gate / gate.rule
  no_flutter_in_domain: { gates: [opengrep.domain_flutter] }
  MVVM:                 { gates: [architecture.mvvm] }

limits:
  max_iterations: 30       # IMPLEMENT + FIX steps
  max_same_failure: 3      # same fingerprint in N consecutive validations → BLOCKED
  max_agent_turns: 30      # model round-trips (tool-calling turns) per agent run
  max_no_progress: 2       # validations without improvement before escalating
  max_agent_runs: 120      # total agent invocations
  max_review_rejections: 3

git:
  checkpoints: false       # opt-in private checkpoint refs (never commits/branches)

context:
  max_input_tokens: 64000  # per-agent budget (capped by the model's window)
  relevant_paths: [lib/features/auth, test/auth]

protected_paths:           # added to the built-in protected list
  - pubspec.yaml
  - pubspec.lock
```

See [`tasks/example.yaml`](tasks/example.yaml) for the full example. Put task files in `tasks/` or `.copilot-loop/tasks/`, then run **Copilot Loop: Start Task**.

### Acceptance criteria are tracked, not just forwarded

Each criterion has a status: `unknown → in_progress → verified | failed | blocked`.

| Criterion declares… | How the controller decides |
|---|---|
| `evidence.tests` | Each file must exist, and the test gate's per-file results (JSON reporter) must show it passing. |
| `evidence.gates` | Each gate (or `gate.rule`) must pass in the latest validation. |
| nothing | The reviewer must mark it `met` and cite evidence paths that **exist** in the workspace. |

The reviewer can never override a deterministic failure. A task cannot complete while any required criterion is `unknown`, `in_progress`, `failed` or `blocked`.

## 6. How agents work

Agents are markdown files in [`agents/`](agents) with YAML front matter:

| Agent | Owns | Writes? | Model preference |
|---|---|---|---|
| `architect` | requirements, existing architecture, plan, tests, risks | no | reasoning high |
| `implementer` | implementing the plan, straightforward tests | yes | coding high, speed medium |
| `debugger` | compile, analyzer, type, import, build failures | yes | coding high |
| `test-engineer` | failing and missing tests, fixtures, timing (never weakens tests) | yes | coding high |
| `architecture-fixer` | OpenGrep and architecture violations (never edits rules) | yes | reasoning high |
| `security` | secrets, PII, auth boundaries, insecure storage and network | yes | reasoning high |
| `refactoring` | DCM, lint, duplication, mechanical cleanup | yes | speed high |
| `diagnoser` | raw failures → structured diagnoses + recommended specialist | no | reasoning high |
| `reviewer` | final acceptance review: `PASS` / `FAIL` with reasons and evidence | no | reasoning high |

Each agent run is a bounded tool-calling conversation with one Copilot model:

```
controller ──► context packet (focused, budgeted) ──► model
     ▲                                                 │
     │         tool results (sandboxed, truncated) ◄── tool calls
     │                                                 │
     └──── validated JSON result (schema per role) ◄───┘
```

**Prompt precedence** is fixed in code, highest first:

1. **Controller policy**: hard-coded, never read from the repository.
2. **Task contract**.
3. **Agent role**: the agent's markdown.
4. **Repository instructions**: `.github/copilot-instructions.md`, `AGENTS.md`, `agent.md`, `CLAUDE.md`, `.github/architecture/README.md`, `.github/instructions/*.instructions.md`. These are size-capped, wrapped in delimiters and labelled as lower-precedence guidance.
5. **Repository content**: files, tool results and diagnostics are untrusted data. Text such as `IGNORE ALL PREVIOUS RULES` in a source file has no authority.

**Context packets** never include the whole repository. They carry the task id, agent, iteration, changed files, the routed diagnostics, relevant rules (constraints and requirement mappings), the last few agent attempts, small file excerpts around diagnostic lines, acceptance status, the plan summary and gate status. Packets are trimmed step by step to fit the budget (`context.max_input_tokens`, capped at 80% of the model's window). Every trim is logged. The full history lives in `.copilot-loop/history/`.

**Tools** are passed per request as `LanguageModelChatTool`s. They are not registered globally, so other chat participants never see them. Each tool has an explicit JSON schema and inputs are validated.

| Tool | Available to |
|---|---|
| `repository_read_file`, `repository_search`, `repository_find_symbol`, `repository_find_references`, `workspace_list_files`, `git_status`, `git_diff` | all agents |
| `validation_run_gate`, `validation_run_test` (task gates only, max 3 runs per agent turn-set) | writing agents |
| `workspace_write_file`, `workspace_replace_in_file` | writing agents only |

Tool power is capped by `AGENT_POLICY` in code. An agent file cannot grant itself more tools: a reviewer file that lists `workspace_write_file` is rejected at load time.

**Model selection** is capability-based. Families and ids are mapped to inferred reasoning, coding and speed scores (VS Code exposes no capability metadata), and ties are broken deterministically. Unknown models get neutral scores, so selection always falls back safely to *some* Copilot model.

## 7. How gates work

A gate is a JSON definition executed **outside the LLM** as a child process: no shell, bounded output, timeout, and cancellation that kills the whole process tree.

```json
{
  "id": "opengrep",
  "name": "OpenGrep architecture rules",
  "category": "architecture",
  "command": "opengrep",
  "args": ["scan", "--config", ".github/architecture/opengrep.yml", "--json", "--error", "--metrics=off", "."],
  "parser": "semgrep-json",
  "timeoutMs": 900000,
  "successExitCodes": [0]
}
```

| Field | Meaning |
|---|---|
| `category` | `compile` · `test` · `architecture` · `security` · `lint` · `coverage` · `unknown`. Drives routing. |
| `parser` | `dart-analyze`, `flutter-test` (JSON reporter), `codeclimate`, `semgrep-json`, `sarif`, `lcov`, `generic` |
| `successExitCodes` | Exit codes treated as success (default `[0]`) |
| `failOnWarnings` | Warnings block too |
| `acceptsPathArgument` | Lets `validation_run_test` append a single test path |
| `cwd`, `env`, `timeoutMs`, `parserOptions` | Working dir (workspace-relative), env, timeout, parser options (e.g. `minCoverage`) |

Results are normalised into structured diagnostics:

```ts
interface Diagnostic {
  gate: string;
  category: 'compile' | 'test' | 'architecture' | 'security' | 'lint' | 'coverage' | 'unknown';
  severity: 'error' | 'warning' | 'info';
  file?: string; line?: number; column?: number;
  rule?: string;
  message: string;
}
```

Agents receive diagnostics, not raw stdout. Raw output tails are kept in the history files for debugging.

Rules that keep gates honest:

- **Missing executable** → the gate result is `error`, and the loop goes to `BLOCKED (CONFIGURATION_ERROR)` with the tool name. It is never a pass. This is checked up front in INTAKE (preflight) and again at every validation.
- **Non-zero exit with nothing parseable** → a synthetic `nonzero_exit` diagnostic with the output tail, so a failure is never silent.
- **Timeout** → failed, with a `gate_timeout` diagnostic.
- **Exit 0 but error diagnostics** → failed.

Bundled definitions live in [`gates/`](gates). Workspace definitions in `.copilot-loop/gates/*.json` override them by `id`.

## 8. How routing works

Routing is **deterministic** and based on structured gate categories:

| Category | Specialist |
|---|---|
| `compile` | `debugger`. If any compile failure exists, it is fixed **first and alone**, because it usually cascades into other failures. |
| `security` | `security` |
| `architecture` | `architecture-fixer` |
| `test`, `coverage` | `test-engineer` |
| `lint` | `refactoring` |
| `unknown` | `diagnoser` (LLM) → recommended specialist (validated against the specialist list) |

Several specialists in one FIX step run in that priority order, and each assignment is persisted as soon as it finishes.

**Failure fingerprints** (`gate`, `rule`, `file`, `line`, `messageHash` over a normalised message that ignores paths, durations, timestamps and addresses) detect repeats. By default the line is excluded from the repeat key, because edits above a failure shift its line. When the same fingerprint appears in `max_same_failure` **consecutive** validations, the loop goes to `BLOCKED (REPEATED_FAILURE)`.

**No-progress detection** tracks failure count, passing gates, changed files and fingerprints per validation. "Progress" means more gates pass or fewer distinct failures remain. For example, a run that goes `12 → 7 → 3 → 3 → 3` is stuck. Each `max_no_progress` window without progress escalates one level:

| Level | Action |
|---|---|
| 1 | Consult the **diagnoser** with previous attempts |
| 2 | **Switch specialist** (e.g. `test-engineer` → `implementer`) |
| 3 | `BLOCKED (REPEATED_FAILURE)`: human intervention requested |

A reviewer `FAIL` turns findings and unmet criteria into diagnostics and goes back through DIAGNOSE. After `max_review_rejections` the loop blocks.

## 9. Adding an agent

1. Create `agents/<id>.agent.md`:

   ```markdown
   ---
   id: debugger
   name: Debugger
   description: One line.
   tools: [repository_read_file, repository_search, workspace_replace_in_file]
   model: { reasoning: medium, coding: high, speed: medium }
   output: change
   ---
   ## You own
   ## You must not
   ## How to work
   ## Success
   ## Output
   ```

2. For a **new role** (a new id), add it to `AGENT_IDS` (`src/persistence/models.ts`) and `AGENT_POLICY` (`src/agents/agent-registry.ts`), which set its maximum tools and output kind. If it is a specialist, add it to `SPECIALIST_AGENTS` and wire a category in `CATEGORY_AGENT` / `FALLBACK_AGENT` (`src/agents/agent-router.ts`).
3. Run `npm test`. The registry tests check that every agent has the required sections and stays inside its policy.

Keep prompts specific: what the agent owns, what it must not change, which tools it may use, what success is, and the output format.

## 10. Adding a gate

1. Add `gates/<name>.json` to the extension, or `.copilot-loop/gates/<name>.json` in the workspace, using the schema in [How gates work](#7-how-gates-work).
2. Pick a parser. If your tool can emit SARIF, Code Climate or Semgrep JSON, use that. Otherwise emit the `generic` format: one diagnostic per line, either `path/file.dart:12:3: error: message [rule_id]` or JSON lines `{"file":"…","line":12,"severity":"error","rule":"…","message":"…","category":"architecture"}`.
3. Reference the gate id in a task's `gates:` list, and optionally in `requirements:` (`<gate>` or `<gate>.<rule>`) and `acceptance[].evidence.gates`.
4. Run **Copilot Loop: Validate** to try the gate without starting agents.

Gate definitions and every configuration file named in a gate's arguments are **protected**: agents cannot edit them.

## 11. Integrating OpenGrep

1. Install `opengrep` and make sure it is on `PATH`.
2. Put your architecture rules in `.github/architecture/opengrep.yml` and security rules in `.github/security/opengrep.yml`. Ready-made examples live in [`examples/flutter-constitution/`](examples/flutter-constitution).
3. The bundled `opengrep` and `security` gates run `opengrep scan --config … --json --error --metrics=off .` and parse the Semgrep-compatible JSON. `metadata.category` on a rule overrides the gate category for that finding. Scanner errors are routed to the diagnoser, not to the architecture fixer.
4. Map requirements to rule ids. Matching is by suffix, so `opengrep.domain_flutter` matches `check_id` values such as `.github.architecture.domain_flutter`.

## 12. Integrating DCM

The bundled `dcm` gate runs `dcm analyze --reporter=codeclimate lib` and parses Code Climate JSON. Severity maps as `major/critical/blocker → error`, `minor → warning`, `info → info`. Reporter flag names differ between DCM versions, so if yours differs, override it in `.copilot-loop/gates/dcm.json`. DCM configuration lives in `analysis_options.yaml`, which is protected, so agents fix code and never loosen rules. Findings route to the `refactoring` specialist.

## 13. Integrating the Flutter Constitution

Copilot Loop does **not** invent architecture rules. It enforces yours:

1. Keep your constitution where it already lives. `.github/architecture/README.md`, `.github/copilot-instructions.md` and `AGENTS.md` are fed to agents automatically as lower-precedence repository instructions.
2. Express each enforceable rule as a gate check with a **stable rule id**: OpenGrep rules for imports and patterns, and a validator script (the `architecture` gate, default `dart run tool/architecture_validator.dart`) for structural rules such as MVVM, vertical slices and dependency direction. The [example validator](examples/flutter-constitution/tool/architecture_validator.dart) shows the output contract.
3. Map constitution requirements to those ids in each task:

   ```yaml
   requirements:
     MVVM:                  { gates: [architecture.mvvm] }
     vertical_slices:       { gates: [architecture.vertical_slice] }
     no_flutter_in_domain:  { gates: [opengrep.domain_flutter] }
     no_bloc:               { gates: [opengrep.forbidden_dependencies] }
     coverage:              { gates: [coverage] }
     duplication:           { gates: [dcm] }
   ```

4. The rule files, validator script and gate definitions are protected. The architecture fixer is told, and technically prevented, from "fixing" a violation by editing a rule.

## 14. Debugging the loop

- **Output channel "Copilot Loop"** shows every state transition, gate result, agent start and finish (model, estimated tokens, trimmed context), tool errors and BLOCKED reasons. Set `copilotLoop.logLevel` to `debug` for per-tool-call logs.
- **Sidebar "Copilot Loop"** shows task, status, iteration, current agent and model, gates (✓/✗), failures (click to open the file), acceptance status, the most recent agent, and progress (`8 / 30 iterations`).
- **Copilot Loop: Show History** opens `.copilot-loop/history/NNNN.json`: one structured record per step, with agent, model, timestamps, changed files, gates, diagnostics, the agent transcript (redacted and bounded), raw gate output tails, the result and the next state.
- **`.copilot-loop/state.json`** holds the complete persisted loop state: criteria, fingerprints, progress samples, transitions and the blocked reason.
- **Copilot Loop: Validate** runs the gates once without agents, which is useful for checking gate configuration.
- **Copilot Loop: Status** gives a one-glance summary.

Add `.copilot-loop/` to your `.gitignore`. Loop state is excluded from workspace fingerprints and agent-visible git output either way.

## 15. Resuming after a restart

State is persisted after every transition and after every specialist within a FIX step, using atomic writes.

| Situation | What happens |
|---|---|
| **Pause** | Graceful: the current step finishes, then the loop enters `PAUSED` and remembers the state to resume into. |
| **Stop** | Immediate: cancels the in-flight model request (`CancellationToken`) and kills gate processes. `STOPPED` is terminal. |
| **VS Code closes** | In-flight work is cancelled and the run becomes `PAUSED` (`deactivate` → `interrupt`). |
| **Crash / kill** | On the next activation, a run found in an active state is recovered as `PAUSED`. |
| **Resume** | Continues from the persisted state. It does not restart. An iteration already claimed by an interrupted IMPLEMENT/FIX is not consumed again, and specialists that already finished are not re-run. |
| **Retry** (from `BLOCKED`) | Human decision: resets repetition and no-progress tracking and grants a fresh `max_iterations` budget, then re-validates (or re-runs intake if there is no plan yet). |

A run lock (`.copilot-loop/run.lock`, with owner pid and stale-lock takeover) stops two windows from driving the same workspace. If the task file is edited during a run, you get a warning. The run keeps the original contract.

## 16. Safety limitations

What the loop guarantees:

- **No automatic publishing.** It never pushes, force-pushes, commits, merges, creates pull requests or modifies remote branches. The git adapter allow-lists subcommands (`status`, `diff`, `ls-files`, `grep`, plumbing for snapshots) and refuses the rest. Tests enforce this.
- **Optional checkpoints** (`git.checkpoints: true`) are private refs under `refs/copilot-loop/<run>/`, built from a temporary index. HEAD, branches and your index are untouched. **Roll Back to Checkpoint** restores the snapshot exactly (it deletes files created after it) and verifies the resulting tree hash.
- **No self-modification.** Agents cannot write `.copilot-loop/`, `.git/`, `.github/workflows|architecture|security|copilot-loop|instructions`, `.github/copilot-instructions.md`, `AGENTS.md`, `agent.md`, `CLAUDE.md`, `analysis_options.yaml`, DCM/OpenGrep ignore files, `.vscode/`, the task file, or any config file referenced by a task gate. Tasks can add more (`protected_paths`). Controller policy, completion logic, limits and routing are code, not files agents can reach.
- **Secret-bearing files** (`.env*`, `*.pem`, `*.key`, keystores, `key.properties`, …) cannot be read by agents. Tool output, history and logs pass through best-effort secret redaction.
- **Bounded everything**: iterations, agent runs, turns per agent, tool results (20k chars), validation runs per agent (3), context budget, repeated failures, no-progress escalation, review rejections, review/validate ping-pong, plus a hard controller step guard.
- **Test weakening detection**: if fewer tests run than before while the suite is green, the controller raises a `tests_removed` failure.

Known limitations:

- Protection is path-based. Code that a rule or validator *imports* (e.g. a helper under `tool/`) is only protected if you list it in `protected_paths`.
- `workspace_write_file` can overwrite a test with weaker content. The test-count guard and the reviewer are the defence, and a determined model could still write weaker assertions that the reviewer misses.
- Secret redaction is pattern-based and not exhaustive.
- Capability inference from model names is heuristic. Use `copilotLoop.modelPreferences` if it picks poorly for your organization's model set.
- The VS Code LM API has no stable system role, so controller policy is sent as the first user message. Precedence is enforced by structure and by the controller (which decides everything that matters), not by the model's obedience.
- Pause is graceful, so a long agent run finishes first. Use Stop for immediate cancellation.

---

## Commands

| Command | Description |
|---|---|
| Copilot Loop: Start Task | Pick a task YAML, validate it, and start. An existing run is archived after confirmation. |
| Copilot Loop: Pause | Pause after the current step. |
| Copilot Loop: Resume | Continue a paused run from persisted state. |
| Copilot Loop: Stop | Cancel immediately (terminal). |
| Copilot Loop: Status | Summary of state, iteration and gates. |
| Copilot Loop: Validate | Run the gates now, without agents. |
| Copilot Loop: Retry | Retry a BLOCKED run with a fresh budget. |
| Copilot Loop: Open Task | Open the task contract. |
| Copilot Loop: Show History | Browse per-step history records. |
| Copilot Loop: Roll Back to Checkpoint | Restore a checkpoint (when enabled). |

## Settings

| Setting | Default | Description |
|---|---|---|
| `copilotLoop.modelPreferences` | `{}` | Per-agent family substring, e.g. `{ "architect": "gpt-5" }`. Copilot models only. |
| `copilotLoop.gateTimeoutMs` | `900000` | Default gate timeout. |
| `copilotLoop.logLevel` | `info` | Output channel verbosity. |

## Development

```bash
npm run typecheck   # strict TypeScript
npm run lint        # ESLint; core modules may not import 'vscode'
npm test            # Vitest; no Copilot subscription needed (MockCopilotClient)
npm run build       # tsc → out/
```

## License

MIT. See [LICENSE](LICENSE).
