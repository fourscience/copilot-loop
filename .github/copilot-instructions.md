# Copilot instructions for the Copilot Loop repository

This repository is the Copilot Loop VS Code extension (TypeScript, strict mode).

- Core modules (`src/**` except `src/extension.ts`, `src/ui/**`, `src/copilot/chat.ts`, `src/copilot/tools.ts`) must not import `vscode`. Add an adapter instead.
- Depend on the ports (`CopilotClient`, `GateRunner`, `StateStore`, `Repository`, `Git`, `ProcessRunner`, `Clock`, `Logger`), not on concrete implementations.
- Every loop state change goes through `transition()` in `src/controller/state-machine.ts`. Add new transitions to the table and to `test/state-machine.test.ts`.
- Completion is decided only in `src/controller/completion.ts`. Never let agent output mark a task complete.
- Never add code that runs `git push`, `git commit`, merges, or creates pull requests. `assertGitCommandAllowed` and `test/safety.test.ts` enforce this.
- Agent tool power is set by `AGENT_POLICY` in code. Agent markdown may only narrow it.
- Errors are `LoopError` with an `ErrorCode`. Do not swallow errors; log them with context.
- No `any` (ESLint enforces this). Prefer small modules and pure functions.
- Before pushing, run `npm run check` (typecheck, lint, tests, build).
