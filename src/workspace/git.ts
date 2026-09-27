import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LoopError } from '../core/errors';
import { sha256, toPosixPath } from '../core/text';
import type { ProcessRunner } from './process';

export interface GitStatusEntry {
  path: string;
  /** Two-letter porcelain status, e.g. ' M', '??', 'A '. */
  status: string;
}

/**
 * Git port. Deliberately has no push/commit/merge/branch operations: the loop
 * must never publish or rewrite history. Checkpoints are stored as private
 * refs under refs/copilot-loop/ and never touch branches, HEAD or the index.
 */
export interface Git {
  isRepository(): Promise<boolean>;
  status(signal?: AbortSignal): Promise<GitStatusEntry[]>;
  diff(options?: { path?: string; maxBytes?: number; signal?: AbortSignal }): Promise<string>;
  /** Content fingerprint of the working tree (tracked + untracked, ignoring .gitignore'd files). */
  workspaceFingerprint(signal?: AbortSignal): Promise<string>;
  /** Files that differ between two fingerprints produced by snapshot(). */
  changedBetween(fromTree: string, toTree: string): Promise<string[]>;
  snapshot(signal?: AbortSignal): Promise<string>;
  createCheckpoint(runId: string, label: string): Promise<string>;
  restoreCheckpoint(ref: string): Promise<string[]>;
}

/** Subcommands the adapter may run. Anything else (push, commit, merge, reset, …) is refused. */
export const ALLOWED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(['status', 'diff', 'rev-parse', 'ls-files', 'grep', 'add', 'write-tree', 'commit-tree', 'update-ref', 'restore', 'read-tree', 'cat-file']);
export const FORBIDDEN_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(['push', 'commit', 'merge', 'rebase', 'reset', 'checkout', 'switch', 'branch', 'tag', 'pull', 'fetch', 'remote', 'clean', 'stash', 'cherry-pick', 'revert', 'am', 'apply', 'gc', 'filter-branch', 'config']);

export function assertGitCommandAllowed(args: readonly string[]): void {
  const sub = args[0] ?? '';
  if (FORBIDDEN_GIT_SUBCOMMANDS.has(sub) || !ALLOWED_GIT_SUBCOMMANDS.has(sub)) {
    throw new LoopError('WORKSPACE_ERROR', `git ${sub} is not permitted by Copilot Loop safety policy`);
  }
  if (sub === 'update-ref' && !args.slice(1).some((a) => a.startsWith('refs/copilot-loop/'))) {
    throw new LoopError('WORKSPACE_ERROR', 'git update-ref is only permitted for refs/copilot-loop/*');
  }
  if (sub === 'restore' && (args.includes('--staged') || args.includes('-S') || !args.includes('--worktree'))) {
    throw new LoopError('WORKSPACE_ERROR', 'git restore is only permitted for the working tree');
  }
}

/** Paths never included in snapshots, fingerprints or change lists. */
export const SNAPSHOT_EXCLUDES: readonly string[] = [':(exclude).copilot-loop'];

export class GitCli implements Git {
  constructor(
    private readonly root: string,
    private readonly processes: ProcessRunner,
  ) {}

  private async git(args: string[], options: { env?: Record<string, string>; signal?: AbortSignal; allowFailure?: boolean; maxOutputBytes?: number } = {}): Promise<string> {
    assertGitCommandAllowed(args);
    const result = await this.processes.run('git', ['-c', 'core.quotepath=off', ...args], {
      cwd: this.root,
      timeoutMs: 120_000,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...options.env },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
    });
    if (result.cancelled) throw new LoopError('USER_CANCELLED', 'git cancelled');
    if (result.exitCode !== 0 && !options.allowFailure) {
      throw new LoopError('WORKSPACE_ERROR', `git ${args[0] ?? ''} failed (${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`);
    }
    return result.stdout;
  }

  async isRepository(): Promise<boolean> {
    try {
      return (await this.git(['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
    } catch {
      return false;
    }
  }

  async status(signal?: AbortSignal): Promise<GitStatusEntry[]> {
    const out = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal ? { signal } : {});
    const entries: GitStatusEntry[] = [];
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const item = parts[i] as string;
      if (item.length < 4) continue;
      const status = item.slice(0, 2);
      entries.push({ status, path: toPosixPath(item.slice(3)) });
      if (status.startsWith('R') || status.startsWith('C')) i++; // skip rename source
    }
    return entries;
  }

  async diff(options: { path?: string; maxBytes?: number; signal?: AbortSignal } = {}): Promise<string> {
    const args = ['diff', 'HEAD', '--no-color', '--no-ext-diff'];
    if (options.path) args.push('--', options.path);
    const hasHead = (await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true })).trim() !== '';
    const out = await this.git(hasHead ? args : args.filter((a) => a !== 'HEAD'), { ...(options.signal ? { signal: options.signal } : {}), maxOutputBytes: options.maxBytes ?? 1024 * 1024 });
    return out;
  }

  /**
   * Stages the full working tree into a temporary index and writes a tree
   * object. The real index, HEAD and branches are untouched.
   */
  async snapshot(signal?: AbortSignal): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-loop-index-'));
    const index = path.join(dir, 'index');
    try {
      const env = { GIT_INDEX_FILE: index };
      // Start from a copy of the real index so its stat cache avoids re-hashing unchanged files
      // (important for very large repositories). The real index is never modified.
      const realIndex = path.resolve(this.root, (await this.git(['rev-parse', '--git-path', 'index'])).trim());
      let copied = false;
      try {
        await fs.copyFile(realIndex, index);
        copied = true;
      } catch {
        copied = false;
      }
      const hasHead = (await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true })).trim() !== '';
      if (!copied && hasHead) await this.git(['read-tree', 'HEAD'], { env, ...(signal ? { signal } : {}) });
      // Loop state is excluded: it changes on every save and is not part of the work product.
      await this.git(['add', '-A', '--', '.', ...SNAPSHOT_EXCLUDES], { env, ...(signal ? { signal } : {}) });
      return (await this.git(['write-tree'], { env })).trim();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async workspaceFingerprint(signal?: AbortSignal): Promise<string> {
    return this.snapshot(signal);
  }

  async changedBetween(fromTree: string, toTree: string): Promise<string[]> {
    if (fromTree === toTree) return [];
    const out = await this.git(['diff', '--name-only', '-z', '--no-renames', fromTree, toTree, '--', '.', ...SNAPSHOT_EXCLUDES]);
    return out.split('\0').filter(Boolean).map(toPosixPath).sort();
  }

  async createCheckpoint(runId: string, label: string): Promise<string> {
    const tree = await this.snapshot();
    const env = { GIT_AUTHOR_NAME: 'Copilot Loop', GIT_AUTHOR_EMAIL: 'copilot-loop@localhost', GIT_COMMITTER_NAME: 'Copilot Loop', GIT_COMMITTER_EMAIL: 'copilot-loop@localhost' };
    const commit = (await this.git(['commit-tree', tree, '-m', `copilot-loop checkpoint: ${label}`], { env })).trim();
    const safeRun = runId.replace(/[^A-Za-z0-9._-]/g, '_');
    const ref = `refs/copilot-loop/${safeRun}/${label.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    await this.git(['update-ref', ref, commit]);
    return ref;
  }

  /**
   * Deterministic rollback: restores every file to its checkpoint content and
   * deletes files that were created after the checkpoint. Ignored files are
   * left alone. Returns the list of paths that changed.
   */
  async restoreCheckpoint(ref: string): Promise<string[]> {
    if (!ref.startsWith('refs/copilot-loop/')) throw new LoopError('WORKSPACE_ERROR', `Not a Copilot Loop checkpoint: ${ref}`);
    const target = (await this.git(['rev-parse', '--verify', `${ref}^{tree}`])).trim();
    const current = await this.snapshot();
    const added = (await this.git(['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', target, current])).split('\0').filter(Boolean);
    const changed = await this.changedBetween(target, current);
    await this.git(['restore', `--source=${ref}`, '--worktree', '--', '.']);
    for (const file of added) {
      await fs.rm(path.join(this.root, file), { force: true });
    }
    const after = await this.snapshot();
    if (after !== target) {
      throw new LoopError('WORKSPACE_ERROR', `Rollback to ${ref} did not reproduce the checkpoint exactly (expected tree ${target}, got ${after})`);
    }
    return changed;
  }
}

/** Fallback for workspaces that are not git repositories. */
export class NoGit implements Git {
  constructor(private readonly listFiles: () => Promise<{ path: string; size: number; mtimeMs: number }[]>) {}
  async isRepository(): Promise<boolean> { return false; }
  async status(): Promise<GitStatusEntry[]> { return []; }
  async diff(): Promise<string> { return '(workspace is not a git repository; diff unavailable)'; }
  async snapshot(): Promise<string> {
    const files = await this.listFiles();
    return sha256(files.map((f) => `${f.path}:${f.size}:${f.mtimeMs}`).sort().join('\n'));
  }
  async workspaceFingerprint(): Promise<string> { return this.snapshot(); }
  async changedBetween(): Promise<string[]> { return []; }
  async createCheckpoint(): Promise<string> { throw new LoopError('CONFIGURATION_ERROR', 'Checkpoints require a git repository'); }
  async restoreCheckpoint(): Promise<string[]> { throw new LoopError('CONFIGURATION_ERROR', 'Checkpoints require a git repository'); }
}
