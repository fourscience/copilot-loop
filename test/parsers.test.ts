import { describe, expect, it } from 'vitest';
import { PARSERS, normaliseFilePath } from '../src/gates/gate-parser';
import { parseGateDefinition } from '../src/gates/gate-registry';
import type { GateDefinition, ParserId } from '../src/gates/gate-types';

const ROOT = '/work/app';
function parse(parser: ParserId, stdout: string, opts: Partial<GateDefinition> = {}, files: Record<string, string> = {}, stderr = '') {
  const gate = { ...parseGateDefinition({ id: 'g', name: 'g', category: 'lint', command: 'x', parser }, 't'), ...opts };
  return PARSERS[parser]({ gate, stdout, stderr, exitCode: 1, workspaceRoot: ROOT, cwd: ROOT, readFile: async (p) => files[p] });
}

describe('gate output parsers', () => {
  it('parses dart analyze machine format', async () => {
    const out = [
      'ERROR|COMPILE_TIME_ERROR|UNDEFINED_IDENTIFIER|/work/app/lib/features/auth/domain/session.dart|12|5|3|Undefined name \'foo\'.',
      'INFO|LINT|PREFER_CONST_CONSTRUCTORS|/work/app/lib/main.dart|3|1|4|Use \'const\' with the constructor\\|really.',
    ].join('\n');
    const { diagnostics } = await parse('dart-analyze', out);
    expect(diagnostics).toEqual([
      { gate: 'g', category: 'compile', severity: 'error', file: 'lib/features/auth/domain/session.dart', line: 12, column: 5, rule: 'undefined_identifier', message: "Undefined name 'foo'." },
      { gate: 'g', category: 'lint', severity: 'info', file: 'lib/main.dart', line: 3, column: 1, rule: 'prefer_const_constructors', message: "Use 'const' with the constructor|really." },
    ]);
  });

  it('parses dart analyze human format', async () => {
    const { diagnostics } = await parse('dart-analyze', "  error - lib/a.dart:3:8 - Target of URI doesn't exist: 'package:x/x.dart'. - uri_does_not_exist\n");
    expect(diagnostics[0]).toMatchObject({ category: 'compile', severity: 'error', file: 'lib/a.dart', line: 3, column: 8, rule: 'uri_does_not_exist' });
  });

  it('parses flutter test JSON reporter output with per-file results', async () => {
    const events = [
      { type: 'suite', suite: { id: 0, path: '/work/app/test/auth/biometric_reauth_test.dart' } },
      { type: 'suite', suite: { id: 1, path: '/work/app/test/ok_test.dart' } },
      { type: 'testStart', test: { id: 1, name: 'reauth after inactivity', suiteID: 0, line: 20 } },
      { type: 'error', testID: 1, error: 'Expected: true\n  Actual: false', stackTrace: '' },
      { type: 'testDone', testID: 1, result: 'failure', hidden: false },
      { type: 'testStart', test: { id: 2, name: 'ok', suiteID: 1, line: 3 } },
      { type: 'testDone', testID: 2, result: 'success', hidden: false },
      { type: 'testStart', test: { id: 3, name: 'loading /work/app/test/x_test.dart', suiteID: 1 } },
      { type: 'testDone', testID: 3, result: 'success', hidden: true },
    ].map((e) => JSON.stringify(e)).join('\n');
    const { diagnostics, metrics } = await parse('flutter-test', events);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ category: 'test', file: 'test/auth/biometric_reauth_test.dart', line: 20, rule: 'reauth after inactivity' });
    expect(metrics).toMatchObject({ testsPassed: 1, testsFailed: 1, passedTestFiles: ['test/ok_test.dart'], failedTestFiles: ['test/auth/biometric_reauth_test.dart'] });
  });

  it('classifies flutter test compile errors as compile failures', async () => {
    const { diagnostics } = await parse('flutter-test', '', {}, {}, "lib/a.dart:4:3: Error: Method not found: 'foo'.");
    expect(diagnostics[0]).toMatchObject({ category: 'compile', file: 'lib/a.dart', line: 4 });
  });

  it('parses OpenGrep/Semgrep JSON, routing scanner errors to diagnosis', async () => {
    const out = JSON.stringify({
      results: [{ check_id: '.github.architecture.domain_flutter', path: 'lib/features/auth/domain/session.dart', start: { line: 1, col: 1 }, extra: { message: 'Domain must not import Flutter', severity: 'ERROR' } }],
      errors: [{ message: 'Invalid rule', level: 'error' }],
    });
    const { diagnostics } = await parse('semgrep-json', `noise\n${out}`, { category: 'architecture' });
    expect(diagnostics[0]).toMatchObject({ category: 'architecture', severity: 'error', rule: '.github.architecture.domain_flutter', file: 'lib/features/auth/domain/session.dart' });
    expect(diagnostics[1]).toMatchObject({ category: 'unknown', rule: 'scanner_error' });
  });

  it('parses Code Climate JSON (DCM)', async () => {
    const out = JSON.stringify([{ type: 'issue', check_name: 'avoid-duplicate-code', description: 'Duplicate code', severity: 'major', location: { path: 'lib/a.dart', positions: { begin: { line: 7, column: 2 } } } }]);
    const { diagnostics } = await parse('codeclimate', out);
    expect(diagnostics[0]).toMatchObject({ category: 'lint', severity: 'error', rule: 'avoid-duplicate-code', file: 'lib/a.dart', line: 7, column: 2 });
  });

  it('parses SARIF', async () => {
    const out = JSON.stringify({ runs: [{ results: [{ ruleId: 'R1', level: 'error', message: { text: 'bad' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'lib/a.dart' }, region: { startLine: 2 } } }] }] }] });
    expect((await parse('sarif', out)).diagnostics[0]).toMatchObject({ rule: 'R1', severity: 'error', file: 'lib/a.dart', line: 2 });
  });

  it('enforces LCOV coverage thresholds and reports a missing report', async () => {
    const lcov = 'SF:lib/a.dart\nLF:10\nLH:7\nend_of_record\n';
    const low = await parse('lcov', '', { parserOptions: { minCoverage: 80 } }, { 'coverage/lcov.info': lcov });
    expect(low.metrics.coveragePercent).toBe(70);
    expect(low.diagnostics[0]).toMatchObject({ category: 'coverage', rule: 'coverage_threshold' });
    const ok = await parse('lcov', '', { parserOptions: { minCoverage: 60 } }, { 'coverage/lcov.info': lcov });
    expect(ok.diagnostics).toEqual([]);
    const missing = await parse('lcov', '', {}, {});
    expect(missing.diagnostics[0]?.rule).toBe('coverage_missing');
  });

  it('parses the generic line and JSON-lines formats', async () => {
    const out = 'lib/features/auth/ui/view.dart:10:3: error: View contains business logic [mvvm]\n{"file":"lib/x.dart","line":2,"rule":"vertical_slice","message":"cross-slice import","category":"architecture"}\nrandom text';
    const { diagnostics } = await parse('generic', out, { category: 'architecture' });
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ file: 'lib/features/auth/ui/view.dart', line: 10, column: 3, rule: 'mvvm' });
    expect(diagnostics[1]).toMatchObject({ file: 'lib/x.dart', rule: 'vertical_slice', category: 'architecture' });
  });

  it('normalises paths relative to the workspace', () => {
    expect(normaliseFilePath('file:///work/app/lib/a.dart', ROOT, ROOT)).toBe('lib/a.dart');
    expect(normaliseFilePath('a.dart', ROOT, `${ROOT}/pkg`)).toBe('pkg/a.dart');
    expect(normaliseFilePath('/elsewhere/a.dart', ROOT, ROOT)).toBe('/elsewhere/a.dart');
  });
});
