import Ajv, { type ValidateFunction } from 'ajv';
import { LoopError } from '../core/errors';
import { DIAGNOSTIC_CATEGORIES, PARSER_IDS, type GateDefinition } from './gate-types';

const GATE_DEFINITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'category', 'command', 'parser'],
  properties: {
    $schema: { type: 'string' },
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' },
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    category: { enum: [...DIAGNOSTIC_CATEGORIES] },
    command: { type: 'string', minLength: 1 },
    args: { type: 'array', items: { type: 'string' } },
    cwd: { type: 'string' },
    env: { type: 'object', additionalProperties: { type: 'string' } },
    timeoutMs: { type: 'integer', minimum: 1000 },
    parser: { enum: [...PARSER_IDS] },
    parserOptions: {
      type: 'object',
      additionalProperties: false,
      properties: { lcovPath: { type: 'string' }, minCoverage: { type: 'number', minimum: 0, maximum: 100 } },
    },
    successExitCodes: { type: 'array', items: { type: 'integer' }, minItems: 1 },
    failOnWarnings: { type: 'boolean' },
    acceptsPathArgument: { type: 'boolean' },
  },
} as const;

let validator: ValidateFunction | undefined;
function getValidator(): ValidateFunction {
  validator ??= new Ajv({ allErrors: true, strict: false }).compile(GATE_DEFINITION_SCHEMA);
  return validator;
}

/** Validates a raw gate definition object (e.g. parsed from gates/*.json). */
export function parseGateDefinition(raw: unknown, source: string): GateDefinition {
  const validate = getValidator();
  if (!validate(raw)) {
    const problems = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ');
    throw new LoopError('CONFIGURATION_ERROR', `Invalid gate definition in ${source}: ${problems}`, { source });
  }
  const r = raw as Omit<GateDefinition, 'args' | 'successExitCodes' | 'failOnWarnings' | 'acceptsPathArgument'> & Partial<GateDefinition>;
  if (r.cwd && (r.cwd.startsWith('/') || /^[A-Za-z]:/.test(r.cwd) || r.cwd.split(/[\\/]/).includes('..'))) {
    throw new LoopError('CONFIGURATION_ERROR', `Gate '${r.id}' cwd must be workspace-relative (${source})`, { source });
  }
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    ...(r.description !== undefined ? { description: r.description } : {}),
    command: r.command,
    args: r.args ?? [],
    ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
    ...(r.env !== undefined ? { env: r.env } : {}),
    ...(r.timeoutMs !== undefined ? { timeoutMs: r.timeoutMs } : {}),
    parser: r.parser,
    ...(r.parserOptions !== undefined ? { parserOptions: r.parserOptions } : {}),
    successExitCodes: r.successExitCodes ?? [0],
    failOnWarnings: r.failOnWarnings ?? false,
    acceptsPathArgument: r.acceptsPathArgument ?? false,
    source,
  };
}

export interface GateDefinitionSource {
  /** Returns `[sourceName, parsedJson]` pairs; later sources override earlier ones by id. */
  load(): Promise<{ source: string; raw: unknown }[]>;
}

/**
 * Holds gate definitions. Definitions are controller policy: agents can never
 * register or modify gates; the protected-path policy forbids editing their files.
 */
export class GateRegistry {
  private readonly gates = new Map<string, GateDefinition>();

  register(definition: GateDefinition): void {
    this.gates.set(definition.id, definition);
  }

  get(id: string): GateDefinition | undefined {
    return this.gates.get(id);
  }

  require(id: string): GateDefinition {
    const gate = this.gates.get(id);
    if (!gate) {
      throw new LoopError('CONFIGURATION_ERROR', `Gate '${id}' is not defined`, { gate: id });
    }
    return gate;
  }

  ids(): Set<string> {
    return new Set(this.gates.keys());
  }

  all(): GateDefinition[] {
    return [...this.gates.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  static async fromSources(sources: GateDefinitionSource[]): Promise<GateRegistry> {
    const registry = new GateRegistry();
    for (const source of sources) {
      for (const { source: name, raw } of await source.load()) {
        registry.register(parseGateDefinition(raw, name));
      }
    }
    return registry;
  }
}
