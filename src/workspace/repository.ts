import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LoopError } from '../core/errors';
import { toPosixPath } from '../core/text';
import { globToRegExp, type PathPolicy } from './files';
import type { ProcessRunner } from './process';

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

export interface Repository {
  readonly root: string;
  exists(rel: string): Promise<boolean>;
  readFile(rel: string): Promise<string>;
  writeFile(rel: string, content: string): Promise<void>;
  listFiles(options?: { directory?: string; glob?: string; max?: number; signal?: AbortSignal }): Promise<{ files: string[]; truncated: boolean }>;
  search(options: { query: string; regex?: boolean; glob?: string; max?: number; wordBoundary?: boolean; signal?: AbortSignal }): Promise<{ matches: SearchMatch[]; truncated: boolean }>;
}

const WALK_IGNORES = new Set(['.git', 'node_modules', '.dart_tool', 'build', '.copilot-loop', '.idea', '.gradle', 'Pods', '.pub-cache', 'out', 'coverage']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WALK_FILES = 200_000;

/**
 * Filesystem-backed repository. Uses `git ls-files` / `git grep` when the
 * workspace is a git repository (fast on very large repositories) and falls
 * back to a bounded directory walk otherwise.
 */
export class NodeRepository implements Repository {
  constructor(
    readonly root: string,
    private readonly policy: PathPolicy,
    private readonly processes: ProcessRunner,
  ) {}

  async exists(rel: string): Promise<boolean> {
    try {
      await fs.access(path.resolve(this.root, this.policy.normalise(rel)));
      return true;
    } catch {
      return false;
    }
  }

  async readFile(rel: string): Promise<string> {
    const safe = this.policy.assertReadable(rel);
    const absolute = await this.policy.assertRealPathInside(safe);
    const stat = await fs.stat(absolute).catch(() => undefined);
    if (!stat?.isFile()) throw new LoopError('TOOL_FAILED', `File '${safe}' does not exist`);
    if (stat.size > MAX_FILE_BYTES) throw new LoopError('TOOL_FAILED', `File '${safe}' is too large (${stat.size} bytes)`);
    return fs.readFile(absolute, 'utf8');
  }

  async writeFile(rel: string, content: string): Promise<void> {
    const safe = this.policy.assertWritable(rel);
    const absolute = await this.policy.assertRealPathInside(safe);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }

  private async gitAvailable(): Promise<boolean> {
    try {
      await fs.access(path.join(this.root, '.git'));
      return (await this.processes.resolve('git', this.root)) !== undefined;
    } catch {
      return false;
    }
  }

  async listFiles(options: { directory?: string; glob?: string; max?: number; signal?: AbortSignal } = {}): Promise<{ files: string[]; truncated: boolean }> {
    const max = Math.min(options.max ?? 500, 5000);
    const dir = options.directory ? this.policy.assertReadable(options.directory) : '.';
    const glob = options.glob ? globToRegExp(options.glob) : undefined;
    let all: string[];
    if (await this.gitAvailable()) {
      const result = await this.processes.run('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', dir === '.' ? '.' : dir], { cwd: this.root, timeoutMs: 60_000, ...(options.signal ? { signal: options.signal } : {}), maxOutputBytes: 64 * 1024 * 1024 });
      all = result.stdout.split('\0').filter(Boolean).map(toPosixPath);
    } else {
      all = await this.walk(dir, options.signal);
    }
    const filtered = all.filter((f) => (!glob || glob.test(f)) && !this.policy.isSecret(f) && !f.startsWith('.copilot-loop/')).sort();
    return { files: filtered.slice(0, max), truncated: filtered.length > max };
  }

  private async walk(start: string, signal?: AbortSignal): Promise<string[]> {
    const out: string[] = [];
    const stack = [start === '.' ? '' : start];
    while (stack.length > 0 && out.length < MAX_WALK_FILES) {
      if (signal?.aborted) throw new LoopError('USER_CANCELLED', 'Listing cancelled');
      const rel = stack.pop() as string;
      let entries;
      try {
        entries = await fs.readdir(path.join(this.root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (WALK_IGNORES.has(e.name)) continue;
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) stack.push(child);
        else if (e.isFile()) out.push(child);
      }
    }
    return out;
  }

  async search(options: { query: string; regex?: boolean; glob?: string; max?: number; wordBoundary?: boolean; signal?: AbortSignal }): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
    const max = Math.min(options.max ?? 100, 1000);
    if (!options.query) throw new LoopError('TOOL_FAILED', 'Search query must not be empty');
    let pattern: RegExp;
    try {
      const source = options.regex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pattern = new RegExp(options.wordBoundary ? `\\b(?:${source})\\b` : source);
    } catch (error) {
      throw new LoopError('TOOL_FAILED', `Invalid search pattern: ${(error as Error).message}`);
    }
    const matches: SearchMatch[] = [];
    const glob = options.glob ? globToRegExp(options.glob) : undefined;

    if (await this.gitAvailable()) {
      const args = ['grep', '-n', '-I', '--untracked', '--no-color', options.regex ? '-E' : '-F'];
      if (options.wordBoundary) args.push('-w');
      args.push('-e', options.query, '--', '.');
      const result = await this.processes.run('git', args, { cwd: this.root, timeoutMs: 120_000, ...(options.signal ? { signal: options.signal } : {}), maxOutputBytes: 16 * 1024 * 1024 });
      if (result.exitCode > 1) {
        throw new LoopError('TOOL_FAILED', `Search failed: ${result.stderr.trim().slice(0, 500)}`);
      }
      for (const line of result.stdout.split('\n')) {
        const m = /^(.+?):(\d+):(.*)$/.exec(line);
        if (!m) continue;
        const file = toPosixPath(m[1] as string);
        if ((glob && !glob.test(file)) || this.policy.isSecret(file) || file.startsWith('.copilot-loop/')) continue;
        matches.push({ file, line: Number(m[2]), text: (m[3] as string).slice(0, 300) });
        if (matches.length > max) break;
      }
    } else {
      const { files } = await this.listFiles({ max: 5000, ...(options.signal ? { signal: options.signal } : {}) });
      outer: for (const file of files) {
        if (glob && !glob.test(file)) continue;
        let text: string;
        try {
          const abs = path.join(this.root, file);
          const stat = await fs.stat(abs);
          if (stat.size > MAX_FILE_BYTES) continue;
          text = await fs.readFile(abs, 'utf8');
        } catch {
          continue;
        }
        if (text.includes('\0')) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i] as string)) {
            matches.push({ file, line: i + 1, text: (lines[i] as string).slice(0, 300) });
            if (matches.length > max) break outer;
          }
        }
      }
    }
    return { matches: matches.slice(0, max), truncated: matches.length > max };
  }
}
