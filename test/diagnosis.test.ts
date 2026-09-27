import { describe, expect, it } from 'vitest';
import { analyseGateResults, improved, makeProgressSample, repeatedFailures, stagnationLength, updateFingerprints, type ProgressSample } from '../src/diagnosis/failure-analyzer';
import { classify } from '../src/diagnosis/failure-classifier';
import { fingerprint, fingerprintKey, normaliseMessage } from '../src/diagnosis/failure-fingerprint';
import type { Diagnostic, GateResult } from '../src/gates/gate-types';

const base: Diagnostic = { gate: 'flutter_test', category: 'test', severity: 'error', file: 'test/a_test.dart', line: 12, rule: 'login works', message: 'Expected: true\n  Actual: false\n#0 main (file:///home/u/app/test/a_test.dart:12:5)' };

describe('failure fingerprints', () => {
  it('equivalent failures produce the same fingerprint', () => {
    const variant: Diagnostic = { ...base, message: 'Expected: true\n  Actual: false\n#0 main (file:///tmp/other/test/a_test.dart:12:5)' };
    expect(fingerprint(variant)).toEqual(fingerprint(base));
  });

  it('ignores durations, timestamps, addresses and whitespace', () => {
    expect(normaliseMessage('Timed out after 30s at 2026-01-01T10:00:00Z (0xdeadbeef)   now')).toBe(normaliseMessage('Timed  out after 45 s at 2026-02-03T11:12:13Z (0xcafe) now'));
  });

  it('line shifts keep the default key but change the exact key', () => {
    const shifted = { ...base, line: 40 };
    expect(fingerprintKey(fingerprint(shifted))).toBe(fingerprintKey(fingerprint(base)));
    expect(fingerprintKey(fingerprint(shifted), { includeLine: true })).not.toBe(fingerprintKey(fingerprint(base), { includeLine: true }));
  });

  it('different rules, files or messages differ', () => {
    expect(fingerprintKey(fingerprint({ ...base, rule: 'other' }))).not.toBe(fingerprintKey(fingerprint(base)));
    expect(fingerprintKey(fingerprint({ ...base, file: 'test/b_test.dart' }))).not.toBe(fingerprintKey(fingerprint(base)));
    expect(fingerprintKey(fingerprint({ ...base, message: 'Expected: 1' }))).not.toBe(fingerprintKey(fingerprint(base)));
  });

  it('includes gate, rule, file, line and a message hash', () => {
    expect(fingerprint(base)).toMatchObject({ gate: 'flutter_test', rule: 'login works', file: 'test/a_test.dart', line: 12 });
    expect(fingerprint(base).messageHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

function result(id: string, diags: Diagnostic[], status: GateResult['status'] = diags.length ? 'failed' : 'passed'): GateResult {
  return { gateId: id, gateName: id, category: 'test', status, passed: status === 'passed', exitCode: 0, stdout: '', stderr: '', diagnostics: diags, warningsBlock: false, metrics: {}, durationMs: 0, timedOut: false, startedAt: '' };
}

describe('repetition and progress', () => {
  it('counts consecutive repeats and resets when a failure disappears', () => {
    let fps = {};
    const withFailure = analyseGateResults([result('t', [base])]);
    const clean = analyseGateResults([result('t', [])]);
    fps = updateFingerprints(fps, withFailure, 1);
    fps = updateFingerprints(fps, withFailure, 2);
    expect(repeatedFailures(fps, 3)).toHaveLength(0);
    fps = updateFingerprints(fps, clean, 3);
    fps = updateFingerprints(fps, withFailure, 4);
    fps = updateFingerprints(fps, withFailure, 5);
    expect(repeatedFailures(fps, 3)).toHaveLength(0);
    fps = updateFingerprints(fps, withFailure, 6);
    expect(repeatedFailures(fps, 3)).toHaveLength(1);
  });

  it('only counts blocking diagnostics of failed gates', () => {
    const warn: Diagnostic = { ...base, severity: 'warning' };
    expect(analyseGateResults([result('t', [warn], 'passed')]).failures).toHaveLength(0);
    expect(analyseGateResults([result('t', [warn, base])]).failures).toHaveLength(1);
    expect(analyseGateResults([result('t', [], 'error')]).erroredGates).toHaveLength(1);
  });

  it('detects the 12 → 7 → 3 → 3 → 3 stagnation pattern', () => {
    const sample = (i: number, n: number): ProgressSample => ({ iteration: i, failureCount: n, passingGateCount: 3, changedFileCount: 1, fingerprintKeys: Array.from({ length: n }, (_, k) => `k${i}-${k}`) });
    const samples = [sample(1, 12), sample(2, 7), sample(3, 3)];
    expect(stagnationLength(samples)).toBe(0);
    samples.push(sample(4, 3));
    expect(stagnationLength(samples)).toBe(1);
    samples.push(sample(5, 3));
    expect(stagnationLength(samples)).toBe(2);
    expect(improved(sample(5, 3), { ...sample(6, 3), passingGateCount: 4 })).toBe(true);
    expect(makeProgressSample(1, analyseGateResults([result('t', [base])]), 2).failureCount).toBe(1);
  });

  it('classifies unknown diagnostics heuristically, never overriding gate categories', () => {
    expect(classify({ ...base, category: 'unknown', message: 'Hard-coded API key found' })).toBe('security');
    expect(classify({ ...base, category: 'unknown', message: "Undefined name 'foo'" })).toBe('compile');
    expect(classify({ ...base, category: 'lint', message: 'password' })).toBe('lint');
    expect(classify({ ...base, category: 'unknown', message: 'something odd' })).toBe('unknown');
  });
});
