import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoopError } from '../src/core/errors';
import { nullLogger } from '../src/core/ports';
import { GateRegistry, parseGateDefinition } from '../src/gates/gate-registry';
import { CommandGate, DefaultGateRunner } from '../src/gates/gate-runner';
import { NodeProcessRunner } from '../src/workspace/process';
import { FakeClock, nodeGate, tempDir } from './helpers';

const runner = new NodeProcessRunner();

async function run(script: string, overrides = {}, ctx: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  const root = await tempDir();
  return new CommandGate(nodeGate('g', script, overrides), runner, new FakeClock()).run({ workspaceRoot: root, ...ctx });
}

describe('gate runner', () => {
  it('passes on exit code 0 and captures stdout/stderr', async () => {
    const r = await run("process.stdout.write('hello'); process.stderr.write('warn')");
    expect(r).toMatchObject({ status: 'passed', passed: true, exitCode: 0, stdout: 'hello', stderr: 'warn', diagnostics: [] });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fails on a non-zero exit and never reports an empty failure', async () => {
    const r = await run("console.error('boom'); process.exit(3)");
    expect(r.status).toBe('failed');
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ rule: 'nonzero_exit', severity: 'error' });
    expect(r.diagnostics[0]?.message).toContain('boom');
  });

  it('parses structured diagnostics from output', async () => {
    const r = await run("console.log('lib/a.dart:3:5: error: Domain imports Flutter [domain_no_flutter]'); process.exit(1)");
    expect(r.diagnostics).toEqual([{ gate: 'g', category: 'test', severity: 'error', file: 'lib/a.dart', line: 3, column: 5, rule: 'domain_no_flutter', message: 'Domain imports Flutter' }]);
  });

  it('fails when exit code is 0 but error diagnostics were reported', async () => {
    const r = await run("console.log('lib/a.dart:1: error: bad')");
    expect(r.status).toBe('failed');
  });

  it('respects custom success exit codes', async () => {
    const r = await run('process.exit(2)', { successExitCodes: [0, 2] });
    expect(r.status).toBe('passed');
  });

  it('fails on timeout with a timeout diagnostic', async () => {
    const r = await run('setTimeout(() => {}, 20000)', {}, { timeoutMs: 300 });
    expect(r.status).toBe('failed');
    expect(r.timedOut).toBe(true);
    expect(r.diagnostics.some((d) => d.rule === 'gate_timeout')).toBe(true);
  });

  it('reports a missing executable as a configuration error, never a pass', async () => {
    const root = await tempDir();
    const def = parseGateDefinition({ id: 'missing', name: 'missing', category: 'lint', command: 'definitely-not-a-real-binary-xyz', parser: 'generic' }, 'test');
    const r = await new CommandGate(def, runner, new FakeClock()).run({ workspaceRoot: root });
    expect(r.status).toBe('error');
    expect(r.passed).toBe(false);
    expect(r.error?.code).toBe('CONFIGURATION_ERROR');
    expect(r.error?.message).toMatch(/not found/);
  });

  it('throws USER_CANCELLED when cancelled', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(run('setTimeout(() => {}, 20000)', {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'USER_CANCELLED' });
  });

  it('runs gates sequentially and supports preflight checks', async () => {
    const root = await tempDir();
    const registry = new GateRegistry();
    registry.register(nodeGate('a', 'process.exit(0)'));
    registry.register(nodeGate('b', 'process.exit(1)'));
    registry.register(parseGateDefinition({ id: 'c', name: 'c', category: 'lint', command: 'no-such-tool-abc', parser: 'generic' }, 't'));
    const gates = new DefaultGateRunner(registry, runner, new FakeClock(), nullLogger);
    expect(await gates.preflight(['a', 'b'], root)).toEqual([]);
    expect(await gates.preflight(['a', 'c', 'zzz'], root)).toEqual(["Gate 'c' requires 'no-such-tool-abc' which was not found on PATH", "Gate 'zzz' is not defined"]);
    const results = await gates.runAll(['a', 'b'], { workspaceRoot: root });
    expect(results.map((r) => r.status)).toEqual(['passed', 'failed']);
  });

  it('does not run later gates after cancellation', async () => {
    const registry = new GateRegistry();
    registry.register(nodeGate('a', 'process.exit(0)'));
    const gates = new DefaultGateRunner(registry, runner, new FakeClock(), nullLogger);
    const controller = new AbortController();
    controller.abort();
    await expect(gates.runAll(['a'], { workspaceRoot: await tempDir(), signal: controller.signal })).rejects.toBeInstanceOf(LoopError);
  });

  it('only appends path arguments for gates that accept them', async () => {
    const root = await tempDir();
    const echo = "console.log(JSON.stringify({message: process.argv.slice(1).join(',') || 'none', severity: 'info'}))";
    const withArgs = await new CommandGate(nodeGate('p', echo, { acceptsPathArgument: true }), runner, new FakeClock()).run({ workspaceRoot: root, extraArgs: ['test/a_test.dart'] });
    const without = await new CommandGate(nodeGate('p', echo), runner, new FakeClock()).run({ workspaceRoot: root, extraArgs: ['test/a_test.dart'] });
    expect(withArgs.diagnostics[0]?.message).toBe('test/a_test.dart');
    expect(without.diagnostics[0]?.message).toBe('none');
  });

  it('loads every bundled gate definition', async () => {
    const dir = path.resolve(__dirname, '../gates');
    for (const file of await fs.readdir(dir)) {
      const raw: unknown = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
      expect(() => parseGateDefinition(raw, file)).not.toThrow();
    }
  });

  it('rejects gate definitions escaping the workspace', () => {
    expect(() => parseGateDefinition({ id: 'x', name: 'x', category: 'lint', command: 'x', parser: 'generic', cwd: '../up' }, 't')).toThrow(/workspace-relative/);
  });
});
