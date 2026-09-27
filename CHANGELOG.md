# Changelog

## 0.1.0

Initial release.

- Controller-first loop with an explicit state machine: INTAKE → PLAN → IMPLEMENT → VALIDATE → DIAGNOSE → FIX → REVIEW → DONE, plus BLOCKED, PAUSED and STOPPED.
- Nine specialised agents (architect, implementer, debugger, test-engineer, architecture-fixer, security, refactoring, diagnoser, reviewer). Their tool power is capped by controller policy.
- GitHub Copilot through the VS Code Language Model API only: capability-based model selection, streaming, per-request LM tool calling, and cancellation.
- Deterministic gates run as child processes with parsers for dart analyze, flutter test (JSON reporter), Code Climate (DCM), OpenGrep/Semgrep JSON, SARIF, LCOV and a generic format. A missing tool blocks the loop instead of passing.
- Deterministic routing by diagnostic category, a diagnoser for unknown failures, failure fingerprints, repeated-failure blocking and no-progress escalation.
- Completion evaluator: gates, then tracked acceptance criteria with evidence, then reviewer PASS, all on the exact validated tree.
- JSON persistence with atomic writes, per-step history, a run lock, restart recovery as PAUSED, and resume without repeating finished work.
- Git safety: no push, commit, merge or PR. Optional private checkpoint refs with verified, deterministic rollback.
- Protected policy paths, secret-file read blocking, secret redaction, test-weakening detection, and bounded context, tool output and loop steps.
- Sidebar dashboard, status bar item and "Copilot Loop" output channel.
