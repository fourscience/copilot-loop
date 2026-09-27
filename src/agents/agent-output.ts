import Ajv, { type ValidateFunction } from 'ajv';
import { DIAGNOSTIC_CATEGORIES, type DiagnosticCategory } from '../gates/gate-types';
import { SPECIALIST_AGENTS, type PlanRecord, type SpecialistAgentId } from '../persistence/models';

export const OUTPUT_KINDS = ['plan', 'change', 'diagnosis', 'review'] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

export interface ChangeOutput {
  summary: string;
  filesChanged: string[];
  unresolved: string[];
}

export interface DiagnosisOutput {
  diagnoses: {
    category: DiagnosticCategory;
    severity: 'error' | 'warning' | 'info';
    rootCause: string;
    affectedFiles: string[];
    rule?: string;
    recommendedAgent: SpecialistAgentId;
  }[];
}

export interface ReviewOutput {
  verdict: 'PASS' | 'FAIL';
  reasons: string[];
  criteria: { id: string; status: 'met' | 'not_met'; evidence: string[] }[];
  findings: { category: DiagnosticCategory; message: string; file?: string; line?: number }[];
}

export type PlanOutput = PlanRecord;

export interface OutputTypes {
  plan: PlanOutput;
  change: ChangeOutput;
  diagnosis: DiagnosisOutput;
  review: ReviewOutput;
}

const str = { type: 'string' } as const;
const strArray = { type: 'array', items: str } as const;

const SCHEMAS: Record<OutputKind, object> = {
  plan: {
    type: 'object',
    required: ['summary', 'affectedFiles', 'steps', 'tests', 'risks', 'criteria'],
    properties: {
      summary: str,
      affectedFiles: strArray,
      steps: strArray,
      tests: strArray,
      risks: strArray,
      criteria: { type: 'array', items: { type: 'object', required: ['id', 'approach'], properties: { id: str, approach: str, evidence: strArray } } },
    },
  },
  change: {
    type: 'object',
    required: ['summary'],
    properties: { summary: str, filesChanged: strArray, unresolved: strArray },
  },
  diagnosis: {
    type: 'object',
    required: ['diagnoses'],
    properties: {
      diagnoses: {
        type: 'array',
        items: {
          type: 'object',
          required: ['category', 'rootCause', 'recommendedAgent'],
          properties: {
            category: { enum: [...DIAGNOSTIC_CATEGORIES] },
            severity: { enum: ['error', 'warning', 'info'] },
            rootCause: str,
            affectedFiles: strArray,
            rule: str,
            recommendedAgent: { enum: [...SPECIALIST_AGENTS] },
          },
        },
      },
    },
  },
  review: {
    type: 'object',
    required: ['verdict', 'reasons', 'criteria'],
    properties: {
      verdict: { enum: ['PASS', 'FAIL'] },
      reasons: strArray,
      criteria: { type: 'array', items: { type: 'object', required: ['id', 'status'], properties: { id: str, status: { enum: ['met', 'not_met'] }, evidence: strArray } } },
      findings: { type: 'array', items: { type: 'object', required: ['category', 'message'], properties: { category: { enum: [...DIAGNOSTIC_CATEGORIES] }, message: str, file: str, line: { type: 'integer' } } } },
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<OutputKind, ValidateFunction>();
function validatorFor(kind: OutputKind): ValidateFunction {
  let v = validators.get(kind);
  if (!v) {
    v = ajv.compile(SCHEMAS[kind]);
    validators.set(kind, v);
  }
  return v;
}

/** Returns the contents of the last ```json fenced block, or the last top-level JSON object in the text. */
export function extractJsonBlock(text: string): string | undefined {
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let last: string | undefined;
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    last = m[1];
  }
  if (last !== undefined) return last.trim();
  const end = text.lastIndexOf('}');
  if (end < 0) return undefined;
  // Walk backwards to the matching opening brace.
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const c = text[i];
    if (c === '}') depth++;
    else if (c === '{') {
      depth--;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return undefined;
}

export type ParseResult<K extends OutputKind> = { ok: true; value: OutputTypes[K] } | { ok: false; error: string };

export function parseAgentOutput<K extends OutputKind>(kind: K, text: string): ParseResult<K> {
  const block = extractJsonBlock(text);
  if (block === undefined) {
    return { ok: false, error: 'No JSON result block found. End your answer with a ```json fenced block.' };
  }
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch (error) {
    return { ok: false, error: `Result block is not valid JSON: ${(error as Error).message}` };
  }
  const validate = validatorFor(kind);
  if (!validate(value)) {
    return { ok: false, error: `Result does not match the required schema: ${(validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ')}` };
  }
  return { ok: true, value: normalise(kind, value) as OutputTypes[K] };
}

function normalise(kind: OutputKind, value: unknown): unknown {
  const v = value as Record<string, unknown>;
  switch (kind) {
    case 'plan':
      return { ...v, criteria: (v.criteria as { id: string; approach: string; evidence?: string[] }[]).map((c) => ({ id: c.id, approach: c.approach, evidence: c.evidence ?? [] })) };
    case 'change':
      return { summary: v.summary, filesChanged: v.filesChanged ?? [], unresolved: v.unresolved ?? [] };
    case 'diagnosis':
      return { diagnoses: (v.diagnoses as Record<string, unknown>[]).map((d) => ({ severity: 'error', affectedFiles: [], ...d })) };
    case 'review':
      return { ...v, criteria: (v.criteria as { id: string; status: string; evidence?: string[] }[]).map((c) => ({ ...c, evidence: c.evidence ?? [] })), findings: v.findings ?? [] };
  }
}

export function outputSchema(kind: OutputKind): object {
  return SCHEMAS[kind];
}
