import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LoopError } from '../core/errors';
import { redactSecrets } from '../core/redact';
import { RECORD_SCHEMA_VERSION, type IterationRecord, type LoopRecord } from './models';

/**
 * Persistence port. The JSON implementation below can later be replaced by
 * SQLite without touching the controller.
 */
export interface StateStore {
  load(): Promise<LoopRecord | undefined>;
  save(record: LoopRecord): Promise<void>;
  appendHistory(entry: IterationRecord): Promise<void>;
  listHistory(): Promise<number[]>;
  readHistory(sequence: number): Promise<IterationRecord | undefined>;
  /** Moves the current run (state + history) into the archive. */
  archiveCurrent(): Promise<string | undefined>;
  /** Directory where history is stored (for "Show History"). */
  readonly location: string;
}

/** Exclusive run lock so two VS Code windows never drive the same workspace loop. */
export interface RunLock {
  acquire(owner: string): Promise<void>;
  release(): Promise<void>;
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new LoopError('WORKSPACE_ERROR', `Cannot read ${file}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new LoopError('WORKSPACE_ERROR', `State file ${file} is corrupted: ${(error as Error).message}. Move it aside to start fresh.`);
  }
}

export class JsonStateStore implements StateStore {
  readonly location: string;
  private readonly stateFile: string;
  private readonly historyDir: string;
  /** Serialises writes so concurrent saves can never interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(rootDir: string) {
    this.location = rootDir;
    this.stateFile = path.join(rootDir, 'state.json');
    this.historyDir = path.join(rootDir, 'history');
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async load(): Promise<LoopRecord | undefined> {
    await this.queue;
    const record = await readJson<LoopRecord>(this.stateFile);
    if (record && record.schemaVersion !== RECORD_SCHEMA_VERSION) {
      throw new LoopError('WORKSPACE_ERROR', `Unsupported state schema version ${String(record.schemaVersion)} in ${this.stateFile}`);
    }
    return record;
  }

  save(record: LoopRecord): Promise<void> {
    const content = JSON.stringify(record, null, 2);
    return this.enqueue(() => writeAtomic(this.stateFile, content));
  }

  appendHistory(entry: IterationRecord): Promise<void> {
    const file = path.join(this.historyDir, `${String(entry.sequence).padStart(4, '0')}.json`);
    const content = redactSecrets(JSON.stringify(entry, null, 2));
    return this.enqueue(() => writeAtomic(file, content));
  }

  async listHistory(): Promise<number[]> {
    await this.queue;
    try {
      const files = await fs.readdir(this.historyDir);
      return files
        .map((f) => /^(\d+)\.json$/.exec(f)?.[1])
        .filter((n): n is string => n !== undefined)
        .map((n) => Number.parseInt(n, 10))
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  async readHistory(sequence: number): Promise<IterationRecord | undefined> {
    await this.queue;
    return readJson<IterationRecord>(path.join(this.historyDir, `${String(sequence).padStart(4, '0')}.json`));
  }

  historyFile(sequence: number): string {
    return path.join(this.historyDir, `${String(sequence).padStart(4, '0')}.json`);
  }

  archiveCurrent(): Promise<string | undefined> {
    return this.enqueue(async () => {
      const record = await readJson<LoopRecord>(this.stateFile);
      if (!record) return undefined;
      const target = path.join(this.location, 'archive', `${record.createdAt.replace(/[:.]/g, '-')}-${record.runId}`);
      await fs.mkdir(target, { recursive: true });
      await fs.rename(this.stateFile, path.join(target, 'state.json'));
      try {
        await fs.rename(this.historyDir, path.join(target, 'history'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return target;
    });
  }
}

/** Lock file with owner pid; a lock held by a dead process is considered stale and taken over. */
export class FileRunLock implements RunLock {
  private held = false;
  constructor(private readonly file: string) {}

  async acquire(owner: string): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const payload = JSON.stringify({ pid: process.pid, owner, at: new Date().toISOString() });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.writeFile(this.file, payload, { flag: 'wx' });
        this.held = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await readJson<{ pid?: number; owner?: string }>(this.file).catch(() => undefined);
        if (existing?.pid === process.pid) {
          this.held = true;
          return;
        }
        if (existing?.pid !== undefined && isAlive(existing.pid)) {
          throw new LoopError('WORKSPACE_ERROR', `Another Copilot Loop instance (pid ${existing.pid}, ${existing.owner ?? 'unknown'}) is running in this workspace`);
        }
        await fs.rm(this.file, { force: true });
      }
    }
    throw new LoopError('WORKSPACE_ERROR', 'Could not acquire the Copilot Loop run lock');
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    await fs.rm(this.file, { force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** In-memory store for tests. */
export class MemoryStateStore implements StateStore {
  readonly location = '<memory>';
  record: LoopRecord | undefined;
  history: IterationRecord[] = [];
  saves = 0;

  async load(): Promise<LoopRecord | undefined> {
    return this.record ? structuredClone(this.record) : undefined;
  }
  async save(record: LoopRecord): Promise<void> {
    this.saves++;
    this.record = structuredClone(record);
  }
  async appendHistory(entry: IterationRecord): Promise<void> {
    this.history.push(structuredClone(entry));
  }
  async listHistory(): Promise<number[]> {
    return this.history.map((h) => h.sequence);
  }
  async readHistory(sequence: number): Promise<IterationRecord | undefined> {
    return this.history.find((h) => h.sequence === sequence);
  }
  async archiveCurrent(): Promise<string | undefined> {
    const had = this.record !== undefined;
    this.record = undefined;
    this.history = [];
    return had ? '<archived>' : undefined;
  }
}
