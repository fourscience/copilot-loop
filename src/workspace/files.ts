import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LoopError } from '../core/errors';
import { toPosixPath } from '../core/text';

/** Minimal glob → RegExp: supports `**`, `*`, `?`. Matching is against workspace-relative POSIX paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  const g = toPosixPath(glob).replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g.charAt(i);
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Matches a glob, a directory prefix (`dir/` or `dir`), or an exact path. */
export function matchesPattern(relPath: string, pattern: string): boolean {
  const p = toPosixPath(pattern).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!/[*?]/.test(p)) {
    return relPath === p || relPath.startsWith(`${p}/`);
  }
  return globToRegExp(p).test(relPath);
}

/**
 * Controller-owned policy: files that agents may never write because they
 * define the loop's own rules (gates, architecture rules, lint configuration,
 * agent instructions, loop state) or are secret-bearing.
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  '.git',
  '.copilot-loop',
  '.github/workflows',
  '.github/architecture',
  '.github/security',
  '.github/copilot-loop',
  '.github/copilot-instructions.md',
  '.github/instructions',
  'AGENTS.md',
  'agent.md',
  'CLAUDE.md',
  '**/analysis_options.yaml',
  '**/dcm_options.yaml',
  '**/.semgrepignore',
  '**/.opengrepignore',
  '.vscode',
];

/** Files agents may not read (secret-bearing). Their content never reaches a model. */
export const DEFAULT_SECRET_PATHS: readonly string[] = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/key.properties',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.netrc',
  '**/.npmrc',
  '**/credentials.json',
  '**/service-account*.json',
];

export class PathPolicy {
  private readonly protectedPaths: () => readonly string[];

  /** `protectedPaths` may be a function so the list can follow the active task. */
  constructor(
    readonly root: string,
    protectedPaths: readonly string[] | (() => readonly string[]),
    private readonly secretPaths: readonly string[] = DEFAULT_SECRET_PATHS,
  ) {
    this.protectedPaths = typeof protectedPaths === 'function' ? protectedPaths : () => protectedPaths;
  }

  protectedList(): readonly string[] {
    return this.protectedPaths();
  }

  /** Returns a normalised workspace-relative POSIX path or throws TOOL_FAILED. */
  normalise(input: string): string {
    if (typeof input !== 'string' || input.trim() === '' || input.includes('\0')) {
      throw new LoopError('TOOL_FAILED', 'A non-empty path is required');
    }
    const absolute = path.resolve(this.root, input);
    const rel = path.relative(this.root, absolute);
    if (rel === '' ) return '.';
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new LoopError('TOOL_FAILED', `Path '${input}' is outside the workspace`);
    }
    return toPosixPath(rel);
  }

  isProtected(rel: string): boolean {
    return this.protectedPaths().some((p) => matchesPattern(rel, p));
  }

  isSecret(rel: string): boolean {
    return this.secretPaths.some((p) => matchesPattern(rel, p));
  }

  assertReadable(input: string): string {
    const rel = this.normalise(input);
    if (rel === '.git' || rel.startsWith('.git/') || rel === '.copilot-loop' || rel.startsWith('.copilot-loop/')) {
      throw new LoopError('TOOL_FAILED', `Reading '${rel}' is not permitted`);
    }
    if (this.isSecret(rel)) {
      throw new LoopError('TOOL_FAILED', `'${rel}' may contain secrets and cannot be read by agents`);
    }
    return rel;
  }

  assertWritable(input: string): string {
    const rel = this.normalise(input);
    if (rel === '.') throw new LoopError('TOOL_FAILED', 'Cannot write the workspace root');
    if (this.isProtected(rel)) {
      throw new LoopError('TOOL_FAILED', `'${rel}' is protected by controller policy (gate/rule/instruction/state files cannot be modified by agents)`);
    }
    if (this.isSecret(rel)) {
      throw new LoopError('TOOL_FAILED', `'${rel}' is a secret-bearing file and cannot be written by agents`);
    }
    return rel;
  }

  /** Verifies that the real (symlink-resolved) location stays inside the workspace. */
  async assertRealPathInside(rel: string): Promise<string> {
    const rootReal = await fs.realpath(this.root);
    let probe = path.resolve(this.root, rel);
    // Walk up to the nearest existing ancestor (the file may not exist yet).
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        const inside = path.relative(rootReal, real);
        if (inside.startsWith('..') || path.isAbsolute(inside)) {
          throw new LoopError('TOOL_FAILED', `Path '${rel}' resolves outside the workspace`);
        }
        return path.resolve(this.root, rel);
      } catch (error) {
        if (error instanceof LoopError) throw error;
        const parent = path.dirname(probe);
        if (parent === probe) throw new LoopError('TOOL_FAILED', `Path '${rel}' cannot be resolved`);
        probe = parent;
      }
    }
  }
}

/** Builds the protected-path list for a task: defaults + task additions + task file + gate config files. */
export function buildProtectedPaths(options: { taskPath?: string; taskProtected: readonly string[]; gateArgs: readonly string[]; root: string }): string[] {
  const list = [...DEFAULT_PROTECTED_PATHS, ...options.taskProtected];
  if (options.taskPath) {
    const rel = path.relative(options.root, path.resolve(options.root, options.taskPath));
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) list.push(toPosixPath(rel));
  }
  for (const arg of options.gateArgs) {
    // Configuration files referenced by gate commands (rule sets, validator scripts) are policy.
    if (/\.(ya?ml|json|dart|sh|py|js|mjs|toml|xml)$/i.test(arg) && !arg.startsWith('-') && !path.isAbsolute(arg) && !arg.split(/[\\/]/).includes('..')) {
      list.push(toPosixPath(arg).replace(/^\.\//, ''));
    }
  }
  return [...new Set(list)];
}
