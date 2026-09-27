import { blockingDiagnostics, type Diagnostic, type GateResult } from '../gates/gate-types';
import { classifyAll } from './failure-classifier';
import { fingerprint, fingerprintKey, type FailureFingerprint } from './failure-fingerprint';

export interface FailureSnapshot {
  /** Blocking diagnostics from failed gates, classified. */
  failures: Diagnostic[];
  fingerprints: { key: string; fingerprint: FailureFingerprint }[];
  passingGates: string[];
  failingGates: string[];
  /** Gates that could not execute (configuration errors). */
  erroredGates: { gateId: string; message: string }[];
}

export function analyseGateResults(results: readonly GateResult[]): FailureSnapshot {
  const failures: Diagnostic[] = [];
  const passingGates: string[] = [];
  const failingGates: string[] = [];
  const erroredGates: { gateId: string; message: string }[] = [];
  for (const r of results) {
    if (r.status === 'passed') {
      passingGates.push(r.gateId);
    } else if (r.status === 'error') {
      erroredGates.push({ gateId: r.gateId, message: r.error?.message ?? 'gate could not execute' });
    } else {
      failingGates.push(r.gateId);
      failures.push(...classifyAll(blockingDiagnostics(r)));
    }
  }
  const seen = new Set<string>();
  const fingerprints: { key: string; fingerprint: FailureFingerprint }[] = [];
  for (const d of failures) {
    const fp = fingerprint(d);
    const key = fingerprintKey(fp);
    if (!seen.has(key)) {
      seen.add(key);
      fingerprints.push({ key, fingerprint: fp });
    }
  }
  return { failures, fingerprints, passingGates, failingGates, erroredGates };
}

// ---------------------------------------------------------------------------
// Repetition tracking
// ---------------------------------------------------------------------------

export interface FingerprintRecord {
  fingerprint: FailureFingerprint;
  /** Consecutive validations in which this failure appeared. */
  consecutive: number;
  total: number;
  firstSeenIteration: number;
  lastSeenIteration: number;
}

/**
 * Updates repetition counters: failures present in this validation increment
 * their consecutive count, failures that disappeared reset to zero.
 */
export function updateFingerprints(
  previous: Readonly<Record<string, FingerprintRecord>>,
  snapshot: FailureSnapshot,
  iteration: number,
): Record<string, FingerprintRecord> {
  const next: Record<string, FingerprintRecord> = {};
  const present = new Set(snapshot.fingerprints.map((f) => f.key));
  for (const [key, record] of Object.entries(previous)) {
    if (!present.has(key)) {
      next[key] = { ...record, consecutive: 0 };
    }
  }
  for (const { key, fingerprint: fp } of snapshot.fingerprints) {
    const prior = previous[key];
    next[key] = prior
      ? { ...prior, fingerprint: fp, consecutive: prior.consecutive + 1, total: prior.total + 1, lastSeenIteration: iteration }
      : { fingerprint: fp, consecutive: 1, total: 1, firstSeenIteration: iteration, lastSeenIteration: iteration };
  }
  return next;
}

export function repeatedFailures(records: Readonly<Record<string, FingerprintRecord>>, maxSameFailure: number): FingerprintRecord[] {
  return Object.values(records).filter((r) => r.consecutive >= maxSameFailure);
}

// ---------------------------------------------------------------------------
// Progress / stagnation
// ---------------------------------------------------------------------------

export interface ProgressSample {
  iteration: number;
  failureCount: number;
  passingGateCount: number;
  changedFileCount: number;
  /** Sorted fingerprint keys (bounded). */
  fingerprintKeys: string[];
  agent?: string;
}

export function makeProgressSample(iteration: number, snapshot: FailureSnapshot, changedFileCount: number, agent?: string): ProgressSample {
  return {
    iteration,
    failureCount: snapshot.fingerprints.length,
    passingGateCount: snapshot.passingGates.length,
    changedFileCount,
    fingerprintKeys: snapshot.fingerprints.map((f) => f.key).sort().slice(0, 500),
    ...(agent ? { agent } : {}),
  };
}

/**
 * True when `current` is measurably better than `previous`: more gates pass or
 * fewer distinct failures remain. Swapping one failure for another is not progress.
 */
export function improved(previous: ProgressSample, current: ProgressSample): boolean {
  return current.passingGateCount > previous.passingGateCount || current.failureCount < previous.failureCount;
}

/**
 * Number of trailing validations without improvement over the best sample
 * seen before them. 0 means the latest sample improved.
 */
export function stagnationLength(samples: readonly ProgressSample[]): number {
  if (samples.length < 2) return 0;
  let count = 0;
  for (let i = samples.length - 1; i > 0; i--) {
    const current = samples[i];
    const previous = samples[i - 1];
    if (!current || !previous || improved(previous, current)) break;
    count++;
  }
  return count;
}
