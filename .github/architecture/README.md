# Architecture rules: Copilot Loop repository

These rules apply to this repository (the extension itself). For a Flutter project's constitution, see
`examples/flutter-constitution/` and README section 13.

| Rule | Enforced by |
|---|---|
| Core is framework-independent: no `vscode` import outside `src/extension.ts`, `src/ui/`, `src/copilot/chat.ts`, `src/copilot/tools.ts` | `eslint.config.mjs` (`no-restricted-imports`), `test/safety.test.ts` |
| State changes only via the explicit transition table | `src/controller/state-machine.ts`, `test/state-machine.test.ts` |
| No publishing git operations | `src/workspace/git.ts` allow-list, `test/safety.test.ts` |
| Agents cannot exceed controller tool policy | `AGENT_POLICY`, `test/agents.test.ts` |
| Completion requires gates + tracked criteria + reviewer PASS on the validated tree | `src/controller/completion.ts`, `test/completion.test.ts`, `test/loop-controller.test.ts` |

In a workspace where Copilot Loop runs, `.github/architecture/` is a protected path: agents can read it but never modify it.
