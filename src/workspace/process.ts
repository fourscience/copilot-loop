import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LoopError } from '../core/errors';

export interface ProcessOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Output beyond this many bytes per stream is dropped (head is kept, tail is kept). */
  maxOutputBytes?: number;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

/** Port for executing external commands. Never runs through a shell. */
export interface ProcessRunner {
  /** Resolves an executable on PATH (or an explicit path). Returns undefined when not found. */
  resolve(command: string, cwd: string): Promise<string | undefined>;
  /** Runs a command. Throws CONFIGURATION_ERROR if the executable cannot be found. */
  run(command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult>;
}

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;

class BoundedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private dropped = 0;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    if (this.size + chunk.length <= this.limit) {
      this.chunks.push(chunk);
      this.size += chunk.length;
    } else {
      this.dropped += chunk.length;
    }
  }
  toString(): string {
    const text = Buffer.concat(this.chunks).toString('utf8');
    return this.dropped > 0 ? `${text}\n…[${this.dropped} bytes of output dropped]` : text;
  }
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform !== 'win32') {
      await fs.access(candidate, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export class NodeProcessRunner implements ProcessRunner {
  constructor(private readonly baseEnv: NodeJS.ProcessEnv = process.env) {}

  async resolve(command: string, cwd: string): Promise<string | undefined> {
    const isWindows = process.platform === 'win32';
    const extensions = isWindows ? (this.baseEnv.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
    const withExt = (base: string): string[] =>
      isWindows && path.extname(base) === '' ? extensions.map((e) => base + e.toLowerCase()).concat(extensions.map((e) => base + e)) : [base];

    if (command.includes('/') || command.includes('\\')) {
      const absolute = path.resolve(cwd, command);
      for (const candidate of withExt(absolute)) {
        if (await isExecutableFile(candidate)) {
          return candidate;
        }
      }
      return undefined;
    }
    const pathVar = this.baseEnv.PATH ?? this.baseEnv.Path ?? '';
    for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
      for (const candidate of withExt(path.join(dir, command))) {
        if (await isExecutableFile(candidate)) {
          return candidate;
        }
      }
    }
    return undefined;
  }

  async run(command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
    const resolved = await this.resolve(command, options.cwd);
    if (!resolved) {
      throw new LoopError('CONFIGURATION_ERROR', `Executable '${command}' was not found on PATH`, { command });
    }
    if (options.signal?.aborted) {
      return { exitCode: -1, stdout: '', stderr: '', timedOut: false, cancelled: true, durationMs: 0 };
    }
    const started = Date.now();
    const isWindows = process.platform === 'win32';
    const isBatch = isWindows && /\.(bat|cmd)$/i.test(resolved);
    // Batch files cannot be spawned directly on Windows; run them through cmd.exe with quoted arguments.
    const spawnCommand = isBatch ? (this.baseEnv.ComSpec ?? 'cmd.exe') : resolved;
    const spawnArgs = isBatch ? ['/d', '/s', '/c', `"${[resolved, ...args].map(quoteWindowsArg).join(' ')}"`] : [...args];
    const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

    return new Promise<ProcessResult>((resolve, reject) => {
      const stdout = new BoundedBuffer(limit);
      const stderr = new BoundedBuffer(limit);
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const child = spawn(spawnCommand, spawnArgs, {
        cwd: options.cwd,
        env: { ...this.baseEnv, ...options.env },
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: isBatch,
        // A separate process group lets us kill the whole tree on POSIX.
        detached: !isWindows,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const kill = (): void => {
        if (child.pid === undefined || child.exitCode !== null) {
          return;
        }
        try {
          if (isWindows) {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          } else {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          child.kill('SIGKILL');
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs);
      const onAbort = (): void => {
        cancelled = true;
        kill();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (exitCode: number): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve({ exitCode, stdout: stdout.toString(), stderr: stderr.toString(), timedOut, cancelled, durationMs: Date.now() - started });
      };

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (error.code === 'ENOENT' || error.code === 'EACCES') {
          reject(new LoopError('CONFIGURATION_ERROR', `Executable '${command}' could not be started: ${error.message}`, { command }));
        } else {
          reject(new LoopError('WORKSPACE_ERROR', `Process '${command}' failed to start: ${error.message}`, { command }));
        }
      });
      child.on('close', (code, signal) => finish(code ?? (signal ? 128 : -1)));
    });
  }
}

function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>^%]/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}
