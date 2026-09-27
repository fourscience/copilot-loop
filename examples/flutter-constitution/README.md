# Flutter constitution example

This directory is a self-contained example of the "gate" configuration you
copy into a **target Flutter repository** managed by Copilot Loop. It is not
consumed by copilot-loop itself; nothing here is loaded by the extension at
runtime. Copy the pieces you need into the Flutter project's own repo root.

## What's here

| File | Copy to (in the Flutter repo) | Purpose |
| --- | --- | --- |
| `.github/architecture/opengrep.yml` | `.github/architecture/opengrep.yml` | OpenGrep rules for MVVM/vertical-slice/dependency-direction checks. |
| `.github/security/opengrep.yml` | `.github/security/opengrep.yml` | OpenGrep rules for PII-in-logs, hardcoded secrets, insecure HTTP/storage/TLS. |
| `tool/architecture_validator.dart` | `tool/architecture_validator.dart` | A small dart:io-only CLI that does deeper, path-resolution-aware architecture checks that regex-based OpenGrep rules can't (e.g. "does this relative import actually cross a feature boundary?"). |

## Running the tools locally

```bash
# From the Flutter repo root, after copying the files above in place:

opengrep scan --config .github/architecture/opengrep.yml --json --error --metrics=off .
opengrep scan --config .github/security/opengrep.yml --json --error --metrics=off .

dart run tool/architecture_validator.dart
```

`architecture_validator.dart` exits `0` with no output when clean, and exits
`1` while printing one line per violation in the form:

```
lib/features/auth/presentation/views/login_view.dart:12:1: error: View must not import the data layer directly [mvvm]
```

## Mapping rule ids into a task's `requirements:`

Copilot Loop tasks reference gate rule ids under `requirements:`, matched by
id suffix (so `opengrep.domain_flutter` matches the OpenGrep rule id
`domain_flutter`, and `architecture.mvvm` matches the validator's `mvvm`
rule id). Example task snippet:

```yaml
requirements:
  - id: opengrep.domain_flutter
    description: Domain layer must stay free of Flutter/dart:ui imports.
  - id: opengrep.forbidden_dependencies
    description: No direct flutter_bloc/riverpod/bloc imports under lib/.
  - id: architecture.mvvm
    description: Views must not import data/; view models must stay widget-free.
  - id: architecture.vertical_slice
    description: Cross-feature imports must go through public.dart barrels.
  - id: security.no_pii_in_logs
    description: Logging calls must not leak email/phone/password/token/etc.
```

The `opengrep.*` ids resolve against rule ids defined in
`.github/architecture/opengrep.yml` and `.github/security/opengrep.yml`. The
`architecture.*` ids resolve against rule ids emitted by
`tool/architecture_validator.dart`. `security.*` ids resolve the same way as
`opengrep.*` but conventionally point at the security config.

## Rules are protected files

Copilot Loop protects `.github/architecture/`, `.github/security/`, and any
config file a gate references (including
`tool/architecture_validator.dart` once a task's gate config points at it)
from edits by the Copilot agent under orchestration. This is what keeps an
agent from "fixing" a failing gate by loosening the rule that catches it —
agents can only make the underlying code compliant, not rewrite the
constitution. If you need to change a rule, do it yourself, outside the
agent loop.

## Caveats

- Dart's grammar support in Semgrep/OpenGrep engines is limited, so the
  OpenGrep rules here mostly use `pattern-regex` against import lines. They
  handle the common single-line `import '...';` case well but can miss
  multi-line imports, `show`/`hide` combinators split across lines, or
  heavily obfuscated string construction.
- `vertical_slice` in both the OpenGrep config and the Dart validator is an
  approximation. The OpenGrep version flags any import path containing
  `features/<name>/(data|domain|presentation)/`; the Dart validator resolves
  relative imports properly and additionally allows the feature's own
  `public.dart` barrel. Review and tighten both for your actual repo layout
  (e.g. package name, barrel file name/location) before relying on them for
  a large codebase.
- `insecure_http`, `hardcoded_secret`, and `insecure_storage` are heuristics
  based on identifier and literal naming conventions; they are not a
  replacement for a dedicated secrets scanner.
