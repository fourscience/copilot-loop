export const DIAGNOSTIC_CATEGORIES = ['compile', 'test', 'architecture', 'security', 'lint', 'coverage', 'unknown'] as const;
export type DiagnosticCategory = (typeof DIAGNOSTIC_CATEGORIES)[number];
export type GateCategory = DiagnosticCategory;
export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  gate: string;
  category: DiagnosticCategory;
  severity: Severity;
  /** Workspace-relative POSIX path. */
  file?: string;
  line?: number;
  column?: number;
  rule?: string;
  message: string;
}

export const PARSER_IDS = ['dart-analyze', 'flutter-test', 'codeclimate', 'sarif', 'semgrep-json', 'lcov', 'generic'] as const;
export type ParserId = (typeof PARSER_IDS)[number];

export interface GateDefinition {
  id: string;
  name: string;
  category: GateCategory;
  description?: string;
  command: string;
  args: string[];
  /** Workspace-relative working directory. */
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  parser: ParserId;
  parserOptions?: {
    /** lcov: path to the lcov file relative to cwd. */
    lcovPath?: string;
    /** lcov: minimum line coverage percentage. */
    minCoverage?: number;
  };
  successExitCodes: number[];
  /** Treat warnings as failures. */
  failOnWarnings: boolean;
  /** When true, `validation_run_test` may append a single test path argument. */
  acceptsPathArgument: boolean;
  /** Where the definition came from (bundle or workspace file). */
  source?: string;
}

export interface GateContext {
  workspaceRoot: string;
  signal?: AbortSignal;
  /** Overrides the gate timeout. */
  timeoutMs?: number;
  /** Extra arguments appended (only honoured if the gate accepts path arguments). */
  extraArgs?: string[];
}

export type GateStatus = 'passed' | 'failed' | 'error';

export interface GateMetrics {
  coveragePercent?: number;
  testsPassed?: number;
  testsFailed?: number;
  /** Workspace-relative test files that had at least one test and no failures. */
  passedTestFiles?: string[];
  failedTestFiles?: string[];
}

export interface GateResult {
  gateId: string;
  gateName: string;
  category: GateCategory;
  /** passed: executed and clean. failed: executed with failures. error: could not execute (configuration). */
  status: GateStatus;
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  diagnostics: Diagnostic[];
  /**
   * Effective policy for this run: warnings block when the gate is configured
   * with failOnWarnings, or when the tool itself failed without reporting errors.
   */
  warningsBlock: boolean;
  metrics: GateMetrics;
  durationMs: number;
  timedOut: boolean;
  /** Set when status === 'error'. */
  error?: { code: string; message: string };
  startedAt: string;
}

export interface ValidationGate {
  id: string;
  name: string;
  category: GateCategory;
  run(context: GateContext): Promise<GateResult>;
}

/** The diagnostics that caused a gate to fail (empty for passing gates). */
export function blockingDiagnostics(result: GateResult): Diagnostic[] {
  if (result.status !== 'failed') {
    return [];
  }
  return result.diagnostics.filter((d) => d.severity === 'error' || (result.warningsBlock && d.severity === 'warning'));
}
