import { createHash } from 'node:crypto';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Rough, model-agnostic token estimate (≈4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncate(text: string, maxChars: number, marker = '\n…[truncated]'): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}

/** Keeps the tail of the text (useful for process output where the end matters most). */
export function truncateTail(text: string, maxChars: number, marker = '[truncated]…\n'): string {
  if (text.length <= maxChars) {
    return text;
  }
  return marker + text.slice(text.length - Math.max(0, maxChars - marker.length));
}

export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}
