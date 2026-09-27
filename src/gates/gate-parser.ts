import * as path from 'node:path';
import { toPosixPath } from '../core/text';
import { DIAGNOSTIC_CATEGORIES, type Diagnostic, type DiagnosticCategory, type GateDefinition, type GateMetrics, type ParserId, type Severity } from './gate-types';

export interface ParseInput {
  gate: GateDefinition;
  stdout: string;
  stderr: string;
  exitCode: number;
  workspaceRoot: string;
  /** Absolute working directory the gate ran in. */
  cwd: string;
  /** Reads a file relative to cwd; returns undefined when missing. */
  readFile: (relativeToCwd: string) => Promise<string | undefined>;
}

export interface ParseOutput {
  diagnostics: Diagnostic[];
  metrics: GateMetrics;
}

export type GateOutputParser = (input: ParseInput) => Promise<ParseOutput>;

/** Converts absolute paths, file:// URIs and cwd-relative paths into workspace-relative POSIX paths. */
export function normaliseFilePath(raw: string | undefined, workspaceRoot: string, cwd: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  let value = raw.trim();
  if (value.startsWith('file://')) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
      if (/^\/[A-Za-z]:/.test(value)) {
        value = value.slice(1);
      }
    } catch {
      /* keep raw value */
    }
  }
  const absolute = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  const relative = path.relative(workspaceRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return toPosixPath(value);
  }
  return toPosixPath(relative);
}

function toInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function severityFrom(value: string | undefined, fallback: Severity = 'error'): Severity {
  const v = (value ?? '').toLowerCase();
  if (['error', 'err', 'fatal', 'critical', 'blocker', 'major', 'high'].includes(v)) {
    return 'error';
  }
  if (['warning', 'warn', 'minor', 'medium'].includes(v)) {
    return 'warning';
  }
  if (['info', 'information', 'hint', 'note', 'low', 'none'].includes(v)) {
    return 'info';
  }
  return fallback;
}

function diag(input: ParseInput, fields: Omit<Diagnostic, 'gate' | 'category'> & { category?: DiagnosticCategory }): Diagnostic {
  const d: Diagnostic = {
    gate: input.gate.id,
    category: fields.category ?? input.gate.category,
    severity: fields.severity,
    message: fields.message.trim() || '(no message)',
  };
  const file = normaliseFilePath(fields.file, input.workspaceRoot, input.cwd);
  if (file) d.file = file;
  if (fields.line) d.line = fields.line;
  if (fields.column) d.column = fields.column;
  if (fields.rule) d.rule = fields.rule;
  return d;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// dart analyze (machine: SEVERITY|TYPE|CODE|FILE|LINE|COL|LENGTH|MESSAGE, or human)
// ---------------------------------------------------------------------------

const DART_HUMAN = /^\s*(error|warning|info|hint|lint)\s+[-•]\s+(.+?):(\d+):(\d+)\s+[-•]\s+(.*?)(?:\s+[-•]\s+([a-z0-9_]+))?\s*$/i;
const DART_HUMAN_OLD = /^\s*(error|warning|info|hint|lint)\s+•\s+(.*?)\s+•\s+(.+?):(\d+):(\d+)\s+•\s+([a-z0-9_]+)\s*$/i;

export const parseDartAnalyze: GateOutputParser = async (input) => {
  const diagnostics: Diagnostic[] = [];
  for (const line of lines(`${input.stdout}\n${input.stderr}`)) {
    const parts = line.split(/(?<!\\)\|/);
    if (parts.length >= 8 && /^(ERROR|WARNING|INFO)$/.test(parts[0] ?? '')) {
      const [severity, type, code, file, ln, col, , ...rest] = parts;
      const isLint = /^(LINT|HINT)$/.test(type ?? '');
      diagnostics.push(
        diag(input, {
          category: isLint ? 'lint' : 'compile',
          severity: severityFrom(severity),
          file,
          line: toInt(ln),
          column: toInt(col),
          rule: code?.toLowerCase(),
          message: rest.join('|').replace(/\\\|/g, '|'),
        }),
      );
      continue;
    }
    let m = DART_HUMAN_OLD.exec(line);
    if (m) {
      const kind = (m[1] ?? '').toLowerCase();
      diagnostics.push(diag(input, { category: kind === 'lint' || kind === 'hint' || kind === 'info' ? 'lint' : 'compile', severity: severityFrom(kind === 'lint' || kind === 'hint' ? 'info' : kind), file: m[3], line: toInt(m[4]), column: toInt(m[5]), rule: m[6], message: m[2] ?? '' }));
      continue;
    }
    m = DART_HUMAN.exec(line);
    if (m) {
      const kind = (m[1] ?? '').toLowerCase();
      diagnostics.push(diag(input, { category: kind === 'lint' || kind === 'hint' || kind === 'info' ? 'lint' : 'compile', severity: severityFrom(kind === 'lint' || kind === 'hint' ? 'info' : kind), file: m[2], line: toInt(m[3]), column: toInt(m[4]), ...(m[6] ? { rule: m[6] } : {}), message: m[5] ?? '' }));
    }
  }
  return { diagnostics, metrics: {} };
};

// ---------------------------------------------------------------------------
// flutter test / dart test JSON reporter (`--reporter json` / `--machine`)
// ---------------------------------------------------------------------------

const DART_COMPILE_ERROR = /^(.+?\.dart):(\d+):(\d+):\s+Error:\s+(.*)$/;

interface TestInfo { name: string; suiteID?: number; line?: number; url?: string }

export const parseFlutterTest: GateOutputParser = async (input) => {
  const diagnostics: Diagnostic[] = [];
  const suites = new Map<number, string>();
  const tests = new Map<number, TestInfo>();
  const errors = new Map<number, string[]>();
  const suiteStats = new Map<string, { passed: number; failed: number }>();
  let passed = 0;
  let failed = 0;
  let sawJson = false;

  for (const line of lines(`${input.stdout}\n${input.stderr}`)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[{')) {
      let event: unknown;
      try {
        event = JSON.parse(trimmed.startsWith('[') ? trimmed.slice(1, -1) : trimmed);
      } catch {
        event = undefined;
      }
      if (event && typeof event === 'object') {
        sawJson = true;
        handleEvent(event as Record<string, unknown>);
        continue;
      }
    }
    const m = DART_COMPILE_ERROR.exec(trimmed);
    if (m) {
      diagnostics.push(diag(input, { category: 'compile', severity: 'error', file: m[1], line: toInt(m[2]), column: toInt(m[3]), rule: 'compile_error', message: m[4] ?? '' }));
    }
  }

  function handleEvent(event: Record<string, unknown>): void {
    const type = event.type;
    if (type === 'suite') {
      const suite = event.suite as { id?: number; path?: string } | undefined;
      if (suite?.id !== undefined && suite.path) suites.set(suite.id, suite.path);
    } else if (type === 'testStart') {
      const test = event.test as { id?: number; name?: string; suiteID?: number; line?: number; root_line?: number; url?: string; root_url?: string } | undefined;
      if (test?.id !== undefined) {
        const info: TestInfo = { name: test.name ?? `test ${test.id}` };
        if (test.suiteID !== undefined) info.suiteID = test.suiteID;
        const ln = test.root_line ?? test.line;
        if (ln) info.line = ln;
        const url = test.root_url ?? test.url;
        if (url) info.url = url;
        tests.set(test.id, info);
      }
    } else if (type === 'error') {
      const id = event.testID as number | undefined;
      if (id !== undefined) {
        const list = errors.get(id) ?? [];
        list.push(String(event.error ?? 'unknown error'));
        errors.set(id, list);
      }
    } else if (type === 'testDone') {
      const id = event.testID as number | undefined;
      if (id === undefined || event.hidden === true) return;
      const test = tests.get(id);
      const suitePath = test?.suiteID !== undefined ? suites.get(test.suiteID) : undefined;
      const suiteKey = suitePath ? normaliseFilePath(suitePath, input.workspaceRoot, input.cwd) ?? suitePath : undefined;
      const stats = suiteKey ? suiteStats.get(suiteKey) ?? { passed: 0, failed: 0 } : undefined;
      if (event.result === 'success' && event.skipped !== true) {
        passed++;
        if (stats) stats.passed++;
      } else if (event.result === 'failure' || event.result === 'error') {
        failed++;
        if (stats) stats.failed++;
        const name = test?.name ?? `test ${id}`;
        const isLoad = name.startsWith('loading ');
        const errorText = (errors.get(id) ?? ['test failed']).join('\n');
        const firstLines = errorText.split(/\r?\n/).filter((l) => l.trim()).slice(0, 6).join('\n');
        diagnostics.push(
          diag(input, {
            category: isLoad ? 'compile' : 'test',
            severity: 'error',
            file: suitePath ?? test?.url,
            line: test?.line,
            rule: isLoad ? 'test_load_failure' : name,
            message: isLoad ? `Failed to load test suite: ${firstLines}` : `${name}: ${firstLines}`,
          }),
        );
      }
      if (suiteKey && stats) suiteStats.set(suiteKey, stats);
    }
  }

  if (!sawJson && input.exitCode !== 0 && diagnostics.length === 0) {
    // Non-JSON reporter: fall back to the common "Some tests failed." summary.
    for (const line of lines(input.stdout)) {
      const m = /^\s*\d\d:\d\d \+\d+(?: ~\d+)? -(\d+): (.+?) \[E\]\s*$/.exec(line);
      if (m) {
        diagnostics.push(diag(input, { category: 'test', severity: 'error', rule: m[2], message: `${m[2] ?? ''} failed` }));
      }
    }
  }

  const passedTestFiles = [...suiteStats.entries()].filter(([, s]) => s.passed > 0 && s.failed === 0).map(([f]) => f).sort();
  const failedTestFiles = [...suiteStats.entries()].filter(([, s]) => s.failed > 0).map(([f]) => f).sort();
  const metrics: GateMetrics = sawJson ? { testsPassed: passed, testsFailed: failed, passedTestFiles, failedTestFiles } : {};
  return { diagnostics, metrics };
};

// ---------------------------------------------------------------------------
// Code Climate JSON (DCM `--reporter=code-climate`, many linters)
// ---------------------------------------------------------------------------

interface CodeClimateIssue {
  type?: string;
  check_name?: string;
  description?: string;
  severity?: string;
  categories?: string[];
  location?: { path?: string; lines?: { begin?: number }; positions?: { begin?: { line?: number; column?: number } } };
}

function parseJsonObjects(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Code Climate spec allows NUL- or newline-separated objects.
    const out: unknown[] = [];
    for (const chunk of trimmed.split(/\0|\r?\n/)) {
      const c = chunk.trim();
      if (!c.startsWith('{')) continue;
      try {
        out.push(JSON.parse(c));
      } catch {
        /* ignore non-JSON noise */
      }
    }
    return out;
  }
}

export const parseCodeClimate: GateOutputParser = async (input) => {
  const diagnostics: Diagnostic[] = [];
  for (const item of parseJsonObjects(input.stdout)) {
    const issue = item as CodeClimateIssue;
    if (!issue || typeof issue !== 'object' || (issue.type && issue.type.toLowerCase() !== 'issue')) continue;
    const loc = issue.location;
    diagnostics.push(
      diag(input, {
        severity: severityFrom(issue.severity, 'warning'),
        file: loc?.path,
        line: toInt(loc?.positions?.begin?.line ?? loc?.lines?.begin),
        column: toInt(loc?.positions?.begin?.column),
        rule: issue.check_name,
        message: issue.description ?? issue.check_name ?? 'issue',
      }),
    );
  }
  return { diagnostics, metrics: {} };
};

// ---------------------------------------------------------------------------
// OpenGrep / Semgrep JSON (`--json`)
// ---------------------------------------------------------------------------

interface SemgrepOutput {
  results?: { check_id?: string; path?: string; start?: { line?: number; col?: number }; extra?: { message?: string; severity?: string; metadata?: { category?: string } } }[];
  errors?: { message?: string; level?: string; type?: string | unknown[]; path?: string }[];
}

export const parseSemgrepJson: GateOutputParser = async (input) => {
  const diagnostics: Diagnostic[] = [];
  const start = input.stdout.indexOf('{');
  if (start < 0) return { diagnostics, metrics: {} };
  let output: SemgrepOutput;
  try {
    output = JSON.parse(input.stdout.slice(start)) as SemgrepOutput;
  } catch {
    return { diagnostics, metrics: {} };
  }
  for (const r of output.results ?? []) {
    const metaCategory = r.extra?.metadata?.category?.toLowerCase();
    const category = metaCategory && (DIAGNOSTIC_CATEGORIES as readonly string[]).includes(metaCategory) ? (metaCategory as DiagnosticCategory) : undefined;
    diagnostics.push(
      diag(input, {
        ...(category ? { category } : {}),
        severity: severityFrom(r.extra?.severity, 'error'),
        file: r.path,
        line: toInt(r.start?.line),
        column: toInt(r.start?.col),
        rule: r.check_id,
        message: r.extra?.message ?? r.check_id ?? 'rule violation',
      }),
    );
  }
  for (const e of output.errors ?? []) {
    // Scanner errors (bad config, parse failures) are not code violations; route them to diagnosis.
    diagnostics.push(diag(input, { category: 'unknown', severity: severityFrom(e.level, 'error'), file: e.path, rule: 'scanner_error', message: e.message ?? 'scanner error' }));
  }
  return { diagnostics, metrics: {} };
};

// ---------------------------------------------------------------------------
// SARIF 2.1.0
// ---------------------------------------------------------------------------

interface SarifLog {
  runs?: { results?: { ruleId?: string; level?: string; message?: { text?: string }; locations?: { physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number; startColumn?: number } } }[] }[] }[];
}

export const parseSarif: GateOutputParser = async (input) => {
  const diagnostics: Diagnostic[] = [];
  const start = input.stdout.indexOf('{');
  if (start < 0) return { diagnostics, metrics: {} };
  let log: SarifLog;
  try {
    log = JSON.parse(input.stdout.slice(start)) as SarifLog;
  } catch {
    return { diagnostics, metrics: {} };
  }
  for (const run of log.runs ?? []) {
    for (const r of run.results ?? []) {
      const loc = r.locations?.[0]?.physicalLocation;
      diagnostics.push(diag(input, { severity: severityFrom(r.level, 'warning'), file: loc?.artifactLocation?.uri, line: toInt(loc?.region?.startLine), column: toInt(loc?.region?.startColumn), rule: r.ruleId, message: r.message?.text ?? r.ruleId ?? 'finding' }));
    }
  }
  return { diagnostics, metrics: {} };
};

// ---------------------------------------------------------------------------
// LCOV coverage
// ---------------------------------------------------------------------------

export const parseLcov: GateOutputParser = async (input) => {
  const lcovPath = input.gate.parserOptions?.lcovPath ?? 'coverage/lcov.info';
  const min = input.gate.parserOptions?.minCoverage ?? 0;
  const content = await input.readFile(lcovPath);
  if (content === undefined) {
    return { diagnostics: [diag(input, { category: 'coverage', severity: 'error', rule: 'coverage_missing', message: `Coverage report '${lcovPath}' was not produced` })], metrics: {} };
  }
  let found = 0;
  let hit = 0;
  for (const line of lines(content)) {
    if (line.startsWith('LF:')) found += Number.parseInt(line.slice(3), 10) || 0;
    else if (line.startsWith('LH:')) hit += Number.parseInt(line.slice(3), 10) || 0;
  }
  const percent = found === 0 ? 0 : Math.round((hit / found) * 10000) / 100;
  const diagnostics: Diagnostic[] = [];
  if (percent < min) {
    diagnostics.push(diag(input, { category: 'coverage', severity: 'error', rule: 'coverage_threshold', message: `Line coverage ${percent}% is below the required ${min}%` }));
  }
  return { diagnostics, metrics: { coveragePercent: percent } };
};

// ---------------------------------------------------------------------------
// Generic: JSON-lines diagnostics or `file:line[:col]: [severity:] message [rule]`
// ---------------------------------------------------------------------------

const GENERIC_LINE = /^(?<file>[^\s:][^:]*?\.[A-Za-z0-9]+):(?<line>\d+)(?::(?<col>\d+))?:\s*(?:(?<sev>error|warning|info)\s*[:-]\s*)?(?<msg>.*?)(?:\s+\[(?<rule>[A-Za-z0-9_.\-/]+)\])?\s*$/i;

export const parseGeneric: GateOutputParser = async (input) => {
  const diagnostics: Diagnostic[] = [];
  for (const line of lines(`${input.stdout}\n${input.stderr}`)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof obj.message === 'string') {
          const cat = typeof obj.category === 'string' && (DIAGNOSTIC_CATEGORIES as readonly string[]).includes(obj.category) ? (obj.category as DiagnosticCategory) : undefined;
          diagnostics.push(diag(input, { ...(cat ? { category: cat } : {}), severity: severityFrom(typeof obj.severity === 'string' ? obj.severity : undefined), file: typeof obj.file === 'string' ? obj.file : undefined, line: toInt(obj.line), column: toInt(obj.column), rule: typeof obj.rule === 'string' ? obj.rule : undefined, message: obj.message }));
          continue;
        }
      } catch {
        /* not JSON */
      }
    }
    const m = GENERIC_LINE.exec(trimmed);
    if (m?.groups) {
      const g = m.groups;
      diagnostics.push(diag(input, { severity: severityFrom(g.sev, 'error'), file: g.file, line: toInt(g.line), column: toInt(g.col), rule: g.rule, message: g.msg ?? '' }));
    }
  }
  return { diagnostics, metrics: {} };
};

export const PARSERS: Readonly<Record<ParserId, GateOutputParser>> = {
  'dart-analyze': parseDartAnalyze,
  'flutter-test': parseFlutterTest,
  codeclimate: parseCodeClimate,
  'semgrep-json': parseSemgrepJson,
  sarif: parseSarif,
  lcov: parseLcov,
  generic: parseGeneric,
};
