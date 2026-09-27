/**
 * Best-effort redaction of credentials before anything is persisted or sent
 * to a model. This is a safety net, not a guarantee.
 */
const PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(authorization\s*[:=]\s*)(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /((?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*)(["']?)[^\s"',;]{6,}\2/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match: string, prefix?: string) => (typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return out;
}
