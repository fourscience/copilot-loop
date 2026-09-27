import * as vscode from 'vscode';
import type { LogLevel, Logger } from '../core/ports';
import { redactSecrets } from '../core/redact';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Logger writing to the "Copilot Loop" output channel. */
export class OutputChannelLogger implements Logger, vscode.Disposable {
  readonly channel: vscode.OutputChannel;
  constructor(private level: LogLevel = 'info') {
    this.channel = vscode.window.createOutputChannel('Copilot Loop');
  }
  setLevel(level: LogLevel): void {
    this.level = level;
  }
  private write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const suffix = data && Object.keys(data).length ? ` ${JSON.stringify(data)}` : '';
    this.channel.appendLine(redactSecrets(`${new Date().toISOString()} [${level.toUpperCase()}] ${message}${suffix}`));
  }
  debug(message: string, data?: Record<string, unknown>): void { this.write('debug', message, data); }
  info(message: string, data?: Record<string, unknown>): void { this.write('info', message, data); }
  warn(message: string, data?: Record<string, unknown>): void { this.write('warn', message, data); }
  error(message: string, data?: Record<string, unknown>): void { this.write('error', message, data); }
  show(): void { this.channel.show(true); }
  dispose(): void { this.channel.dispose(); }
}
