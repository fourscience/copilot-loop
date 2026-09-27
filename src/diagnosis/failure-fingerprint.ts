import { sha256 } from '../core/text';
import type { Diagnostic } from '../gates/gate-types';

export interface FailureFingerprint {
  gate: string;
  rule?: string;
  file?: string;
  line?: number;
  messageHash: string;
}

/**
 * Normalises a diagnostic message so that cosmetic differences between runs
 * (absolute paths, durations, timestamps, memory addresses, stack frames,
 * whitespace) do not produce different fingerprints.
 */
export function normaliseMessage(message: string): string {
  const firstLines = message
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0 && !/^\s*(#\d+\s|at\s|package:|dart:)/.test(l))
    .slice(0, 4)
    .join(' ');
  return firstLines
    .toLowerCase()
    .replace(/file:\/\/\S+/g, '<path>')
    .replace(/(?:[a-z]:)?(?:[\\/][\w.@-]+){2,}/gi, '<path>')
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/g, '<time>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '<time>')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|milliseconds)\b/g, '<duration>')
    .replace(/0x[0-9a-f]+/g, '<addr>')
    .replace(/#[0-9a-f]{6,}/g, '<hash>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function fingerprint(diagnostic: Diagnostic): FailureFingerprint {
  const fp: FailureFingerprint = { gate: diagnostic.gate, messageHash: sha256(normaliseMessage(diagnostic.message)).slice(0, 16) };
  if (diagnostic.rule) fp.rule = diagnostic.rule;
  if (diagnostic.file) fp.file = diagnostic.file;
  if (diagnostic.line) fp.line = diagnostic.line;
  return fp;
}

/**
 * Stable key for a fingerprint. By default the line number is excluded because
 * edits above a failure shift its line without changing the failure itself;
 * pass `includeLine` for an exact identity.
 */
export function fingerprintKey(fp: FailureFingerprint, options: { includeLine?: boolean } = {}): string {
  return [fp.gate, fp.rule ?? '', fp.file ?? '', options.includeLine ? String(fp.line ?? '') : '', fp.messageHash].join('|');
}

export function sameFailure(a: Diagnostic, b: Diagnostic): boolean {
  return fingerprintKey(fingerprint(a)) === fingerprintKey(fingerprint(b));
}
