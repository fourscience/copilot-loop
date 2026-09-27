import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertGitCommandAllowed, GitCli } from '../src/workspace/git';
import { NodeProcessRunner } from '../src/workspace/process';
import { redactSecrets } from '../src/core/redact';
import { DEFAULT_PROTECTED_PATHS, PathPolicy, globToRegExp } from '../src/workspace/files';
import { REPO_ROOT, tempDir } from './helpers';

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sourceFiles(p)));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('architecture guards', () => {
  it('keeps the core free of VS Code imports', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(path.join(REPO_ROOT, 'src'))) {
      const rel = path.relative(path.join(REPO_ROOT, 'src'), file).replace(/\\/g, '/');
      if (rel === 'extension.ts' || rel.startsWith('ui/') || rel === 'copilot/chat.ts' || rel === 'copilot/tools.ts') continue;
      if (/from ['"]vscode['"]|require\(['"]vscode['"]\)/.test(await fs.readFile(file, 'utf8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('contains no code path that pushes, commits, merges or creates pull requests', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(path.join(REPO_ROOT, 'src'))) {
      const text = await fs.readFile(file, 'utf8');
      if (/['"](push|commit|merge|rebase|pull)['"]\s*[,\]]/.test(text.replace(/FORBIDDEN_GIT_SUBCOMMANDS[^\n]*\n/g, ''))) offenders.push(file);
      if (/createPullRequest|pulls\.create|gh pr create/i.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe('git safety', () => {
  it.each(['push', 'commit', 'merge', 'rebase', 'reset', 'checkout', 'branch', 'pull', 'fetch', 'remote', 'clean', 'stash', 'config', 'unknown-cmd'])('refuses git %s', (sub) => {
    expect(() => assertGitCommandAllowed([sub])).toThrow(/not permitted/);
  });

  it('restricts update-ref and restore to safe forms', () => {
    expect(() => assertGitCommandAllowed(['update-ref', 'refs/heads/main', 'abc'])).toThrow();
    expect(() => assertGitCommandAllowed(['update-ref', 'refs/copilot-loop/r/1', 'abc'])).not.toThrow();
    expect(() => assertGitCommandAllowed(['restore', '--staged', '.'])).toThrow();
    expect(() => assertGitCommandAllowed(['restore', '--source=x', '--worktree', '--', '.'])).not.toThrow();
  });

  it('creates checkpoints without touching HEAD, branches or the index, and rolls back deterministically', async () => {
    const root = await tempDir();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    await fs.writeFile(path.join(root, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    await fs.writeFile(path.join(root, 'a.txt'), 'two\n');
    await fs.writeFile(path.join(root, 'untracked.txt'), 'u\n');
    const head = git('rev-parse', 'HEAD');
    const status = git('status', '--porcelain');

    const cli = new GitCli(root, new NodeProcessRunner());
    const before = await cli.snapshot();
    const ref = await cli.createCheckpoint('run-1', 'iteration-0001');
    expect(ref).toBe('refs/copilot-loop/run-1/iteration-0001');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('status', '--porcelain')).toBe(status);
    expect(git('branch', '--list')).toMatch(/master|main/);

    // Agent changes after the checkpoint.
    await fs.writeFile(path.join(root, 'a.txt'), 'three\n');
    await fs.writeFile(path.join(root, 'new.txt'), 'n\n');
    await fs.rm(path.join(root, 'untracked.txt'));
    expect(await cli.changedBetween(before, await cli.snapshot())).toEqual(['a.txt', 'new.txt', 'untracked.txt']);

    const restored = await cli.restoreCheckpoint(ref);
    expect(restored.sort()).toEqual(['a.txt', 'new.txt', 'untracked.txt']);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('two\n');
    expect(await fs.readFile(path.join(root, 'untracked.txt'), 'utf8')).toBe('u\n');
    await expect(fs.stat(path.join(root, 'new.txt'))).rejects.toThrow();
    expect(await cli.snapshot()).toBe(before);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('log', '--oneline').split('\n')).toHaveLength(1);
  });
});

describe('path policy', () => {
  const policy = new PathPolicy('/w', DEFAULT_PROTECTED_PATHS);
  it('rejects traversal and protected paths', () => {
    expect(() => policy.assertWritable('../x')).toThrow(/outside/);
    expect(() => policy.assertWritable('/etc/passwd')).toThrow(/outside/);
    expect(() => policy.assertWritable('.git/config')).toThrow(/protected/);
    expect(() => policy.assertWritable('packages/app/analysis_options.yaml')).toThrow(/protected/);
    expect(() => policy.assertWritable('.github/workflows/ci.yml')).toThrow(/protected/);
    expect(() => policy.assertWritable('AGENTS.md')).toThrow(/protected/);
    expect(() => policy.assertReadable('config/.env.production')).toThrow(/secrets/);
    expect(() => policy.assertReadable('android/key.properties')).toThrow(/secrets/);
    expect(policy.assertWritable('lib/a.dart')).toBe('lib/a.dart');
  });

  it('refuses writes through symlinks that escape the workspace', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await fs.symlink(outside, path.join(root, 'link'));
    const p = new PathPolicy(root, []);
    await expect(p.assertRealPathInside('link/evil.txt')).rejects.toThrow(/outside the workspace/);
  });

  it('matches globs', () => {
    expect(globToRegExp('**/*.pem').test('a/b/c.pem')).toBe(true);
    expect(globToRegExp('**/*.pem').test('c.pem')).toBe(true);
    expect(globToRegExp('lib/*.dart').test('lib/a/b.dart')).toBe(false);
  });

  it('redacts common secrets', () => {
    const text = redactSecrets('token=ghp_0123456789abcdefghijABCDEFGHIJ password: "hunter2hunter2" Authorization: Bearer abcdefghijklmnop');
    expect(text).not.toMatch(/ghp_|hunter2|abcdefghijklmnop/);
  });
});

describe('repository sanity', () => {
  it('ships no workflow or code that publishes to remotes', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(Object.values(pkg.scripts).join(' ')).not.toMatch(/git push|vsce publish/);
  });
});
