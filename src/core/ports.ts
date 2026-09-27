/**
 * Small infrastructure ports used by the framework-independent core.
 * Adapters (VS Code, Node, test fakes) implement these.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Logger that records entries in memory; used by tests and diagnostics. */
export class MemoryLogger implements Logger {
  readonly entries: { level: LogLevel; message: string; data?: Record<string, unknown> }[] = [];
  debug(message: string, data?: Record<string, unknown>): void { this.entries.push({ level: 'debug', message, ...(data ? { data } : {}) }); }
  info(message: string, data?: Record<string, unknown>): void { this.entries.push({ level: 'info', message, ...(data ? { data } : {}) }); }
  warn(message: string, data?: Record<string, unknown>): void { this.entries.push({ level: 'warn', message, ...(data ? { data } : {}) }); }
  error(message: string, data?: Record<string, unknown>): void { this.entries.push({ level: 'error', message, ...(data ? { data } : {}) }); }
}
