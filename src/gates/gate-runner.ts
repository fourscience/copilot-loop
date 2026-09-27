import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LoopError, isLoopError } from '../core/errors';
import type { Clock, Logger } from '../core/ports';
import { truncateTail } from '../core/text';
import type { ProcessRunner } from '../workspace/process';
import { PARSERS } from './gate-parser';
import type { GateRegistry } from './gate-registry';
import type { Diagnostic, GateContext, GateDefinition, GateResult, ValidationGate } from './gate-types';

export const DEFAULT_GATE_TIMEOUT_MS = 15 * 60 * 1000;
/** Raw output kept in results/history; parsers still see the full output. */
const MAX_STORED_OUTPUT = 64 * 1024;

export interface GateRunner {
  /** Checks that every gate is defined and its executable is resolvable. Returns problems (empty = ok). */
  preflight(gateIds: readonly string[], workspaceRoot: string): Promise<string[]>;
  /** Runs gates sequentially in the given order. Throws USER_CANCELLED on cancellation. */
  runAll(gateIds: readonly string[], context: GateContext): Promise<GateResult[]>;
  run(gateId: string, context: GateContext): Promise<GateResult>;
}

/** A gate backed by an external command. Executes outside the LLM, never through a shell. */
export class CommandGate implements ValidationGate {
  constructor(
    private readonly definition: GateDefinition,
    private readonly processes: ProcessRunner,
    private readonly clock: Clock,
    private readonly defaultTimeoutMs = DEFAULT_GATE_TIMEOUT_MS,
  ) {}

  get id(): string { return this.definition.id; }
  get name(): string { return this.definition.name; }
  get category(): GateDefinition['category'] { return this.definition.category; }

  async run(context: GateContext): Promise<GateResult> {
    const def = this.definition;
    const startedAt = this.clock.now().toISOString();
    const cwd = path.resolve(context.workspaceRoot, def.cwd ?? '.');
    const base = { gateId: def.id, gateName: def.name, category: def.category, startedAt };
    const args = [...def.args, ...(def.acceptsPathArgument && context.extraArgs ? context.extraArgs : [])];

    let result;
    try {
      result = await this.processes.run(def.command, args, {
        cwd,
        ...(def.env ? { env: def.env } : {}),
        timeoutMs: context.timeoutMs ?? def.timeoutMs ?? this.defaultTimeoutMs,
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      if (isLoopError(error) && error.code === 'CONFIGURATION_ERROR') {
        // Never a false PASS: a gate that cannot execute is an error, which blocks the loop.
        return { ...base, status: 'error', passed: false, exitCode: -1, stdout: '', stderr: '', diagnostics: [], warningsBlock: false, metrics: {}, durationMs: 0, timedOut: false, error: { code: error.code, message: `Gate '${def.id}': ${error.message}` } };
      }
      throw error;
    }
    if (result.cancelled) {
      throw new LoopError('USER_CANCELLED', `Gate '${def.id}' was cancelled`);
    }

    const parsed = await PARSERS[def.parser]({
      gate: def,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      workspaceRoot: context.workspaceRoot,
      cwd,
      readFile: async (rel) => {
        const target = path.resolve(cwd, rel);
        const inside = path.relative(context.workspaceRoot, target);
        if (inside.startsWith('..') || path.isAbsolute(inside)) return undefined;
        try {
          return await fs.readFile(target, 'utf8');
        } catch {
          return undefined;
        }
      },
    });
    const diagnostics: Diagnostic[] = [...parsed.diagnostics];
    const exitOk = def.successExitCodes.includes(result.exitCode);
    const hasErrors = diagnostics.some((d) => d.severity === 'error');
    // If the tool failed and only reported warnings, the tool itself treated them as fatal.
    const warningsBlock = def.failOnWarnings || (!exitOk && !hasErrors);

    if (result.timedOut) {
      diagnostics.push({ gate: def.id, category: def.category, severity: 'error', rule: 'gate_timeout', message: `Gate '${def.name}' timed out; output tail:\n${truncateTail(result.stderr || result.stdout, 1500)}` });
    } else if (!exitOk && !diagnostics.some((d) => d.severity === 'error' || (warningsBlock && d.severity === 'warning'))) {
      // The tool failed but produced nothing we could parse: surface a synthetic diagnostic so the failure is never lost.
      diagnostics.push({ gate: def.id, category: def.category, severity: 'error', rule: 'nonzero_exit', message: `'${def.command}' exited with code ${result.exitCode}; output tail:\n${truncateTail(result.stderr || result.stdout, 1500)}` });
    }
    const blocking = diagnostics.some((d) => d.severity === 'error' || (warningsBlock && d.severity === 'warning'));
    const passed = exitOk && !result.timedOut && !blocking;
    return {
      ...base,
      status: passed ? 'passed' : 'failed',
      passed,
      exitCode: result.exitCode,
      stdout: truncateTail(result.stdout, MAX_STORED_OUTPUT),
      stderr: truncateTail(result.stderr, MAX_STORED_OUTPUT),
      diagnostics,
      warningsBlock,
      metrics: parsed.metrics,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
    };
  }
}

export class DefaultGateRunner implements GateRunner {
  constructor(
    private readonly registry: GateRegistry,
    private readonly processes: ProcessRunner,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly defaultTimeoutMs = DEFAULT_GATE_TIMEOUT_MS,
  ) {}

  async preflight(gateIds: readonly string[], workspaceRoot: string): Promise<string[]> {
    const problems: string[] = [];
    for (const id of gateIds) {
      const def = this.registry.get(id);
      if (!def) {
        problems.push(`Gate '${id}' is not defined`);
        continue;
      }
      const cwd = path.resolve(workspaceRoot, def.cwd ?? '.');
      try {
        const stat = await fs.stat(cwd);
        if (!stat.isDirectory()) problems.push(`Gate '${id}' working directory '${def.cwd}' is not a directory`);
      } catch {
        problems.push(`Gate '${id}' working directory '${def.cwd ?? '.'}' does not exist`);
        continue;
      }
      if (!(await this.processes.resolve(def.command, cwd))) {
        problems.push(`Gate '${id}' requires '${def.command}' which was not found on PATH`);
      }
    }
    return problems;
  }

  async run(gateId: string, context: GateContext): Promise<GateResult> {
    const gate = new CommandGate(this.registry.require(gateId), this.processes, this.clock, this.defaultTimeoutMs);
    this.logger.info(`Gate '${gateId}' started`);
    const result = await gate.run(context);
    this.logger.info(`Gate '${gateId}' ${result.status}`, { exitCode: result.exitCode, durationMs: result.durationMs, diagnostics: result.diagnostics.length, ...(result.error ? { error: result.error.message } : {}) });
    return result;
  }

  async runAll(gateIds: readonly string[], context: GateContext): Promise<GateResult[]> {
    const results: GateResult[] = [];
    for (const id of gateIds) {
      if (context.signal?.aborted) {
        throw new LoopError('USER_CANCELLED', 'Validation cancelled');
      }
      results.push(await this.run(id, context));
    }
    return results;
  }
}
