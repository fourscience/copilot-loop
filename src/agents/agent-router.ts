import type { Diagnostic, DiagnosticCategory } from '../gates/gate-types';
import type { Assignment, SpecialistAgentId } from '../persistence/models';
import type { DiagnosisOutput } from './agent-output';

/** Deterministic category → specialist mapping. `unknown` goes to the diagnoser first. */
export const CATEGORY_AGENT: Readonly<Record<Exclude<DiagnosticCategory, 'unknown'>, SpecialistAgentId>> = {
  compile: 'debugger',
  test: 'test-engineer',
  coverage: 'test-engineer',
  architecture: 'architecture-fixer',
  security: 'security',
  lint: 'refactoring',
};

/** Order in which specialists run within one FIX step. */
export const CATEGORY_PRIORITY: readonly DiagnosticCategory[] = ['compile', 'security', 'architecture', 'test', 'coverage', 'lint', 'unknown'];

/** Alternative specialist used when the primary one is not making progress. */
export const FALLBACK_AGENT: Readonly<Record<SpecialistAgentId, SpecialistAgentId>> = {
  debugger: 'implementer',
  'test-engineer': 'implementer',
  'architecture-fixer': 'implementer',
  security: 'implementer',
  refactoring: 'implementer',
  implementer: 'debugger',
};

const MAX_DIAGNOSTICS_PER_ASSIGNMENT = 40;

export interface RoutingDecision {
  assignments: Assignment[];
  /** Failures the deterministic router could not place (category unknown). */
  unrouted: Diagnostic[];
  /** Whether the controller should consult the diagnoser before fixing. */
  consultDiagnoser: boolean;
}

export interface RoutingOptions {
  /** 0 = normal, 1 = consult diagnoser, ≥2 = switch specialists. */
  escalation: number;
  /** Specialists used for the previous fix attempt. */
  previousAgents: readonly SpecialistAgentId[];
}

function sortDiagnostics(list: Diagnostic[]): Diagnostic[] {
  const sev = { error: 0, warning: 1, info: 2 } as const;
  return [...list].sort((a, b) => sev[a.severity] - sev[b.severity] || (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0));
}

/**
 * Routes failures using structured gate categories. Compile failures are fixed
 * first and alone, because they usually cascade into test/lint failures.
 */
export function routeFailures(failures: readonly Diagnostic[], options: RoutingOptions = { escalation: 0, previousAgents: [] }): RoutingDecision {
  const byCategory = new Map<DiagnosticCategory, Diagnostic[]>();
  for (const d of failures) {
    const list = byCategory.get(d.category) ?? [];
    list.push(d);
    byCategory.set(d.category, list);
  }
  const unrouted = byCategory.get('unknown') ?? [];
  const categories = byCategory.has('compile') ? (['compile'] as DiagnosticCategory[]) : CATEGORY_PRIORITY.filter((c) => c !== 'unknown' && byCategory.has(c));

  const merged = new Map<SpecialistAgentId, Assignment>();
  for (const category of categories) {
    let agent = CATEGORY_AGENT[category as Exclude<DiagnosticCategory, 'unknown'>];
    let reason = `${category} failures → ${agent}`;
    if (options.escalation >= 2 && options.previousAgents.includes(agent)) {
      const fallback = FALLBACK_AGENT[agent];
      reason = `${category} failures: ${agent} made no progress → switching to ${fallback}`;
      agent = fallback;
    }
    const diagnostics = byCategory.get(category) ?? [];
    const existing = merged.get(agent);
    if (existing) {
      existing.diagnostics.push(...diagnostics);
      existing.reason += `; ${reason}`;
    } else {
      merged.set(agent, { agent, category, diagnostics: [...diagnostics], reason });
    }
  }
  const assignments = [...merged.values()].map((a) => ({ ...a, diagnostics: sortDiagnostics(a.diagnostics).slice(0, MAX_DIAGNOSTICS_PER_ASSIGNMENT) }));
  return { assignments, unrouted, consultDiagnoser: unrouted.length > 0 || options.escalation === 1 };
}

/**
 * Merges a diagnoser result into routing. The diagnoser may only recommend
 * specialists (enforced by the output schema); diagnostics are attached by
 * affected file or category, and any diagnostics left over keep their
 * deterministic assignment.
 */
export function applyDiagnosis(decision: RoutingDecision, diagnosis: DiagnosisOutput, failures: readonly Diagnostic[]): Assignment[] {
  const byAgent = new Map<SpecialistAgentId, Assignment>();
  const claimed = new Set<Diagnostic>();
  for (const d of diagnosis.diagnoses) {
    const files = new Set(d.affectedFiles);
    const related = failures.filter((f) => (f.file && files.has(f.file)) || (d.rule && f.rule === d.rule) || (files.size === 0 && f.category === d.category));
    related.forEach((r) => claimed.add(r));
    const existing = byAgent.get(d.recommendedAgent);
    const reason = `diagnoser: ${d.rootCause}${d.affectedFiles.length ? ` (${d.affectedFiles.join(', ')})` : ''}`;
    if (existing) {
      existing.diagnostics.push(...related.filter((r) => !existing.diagnostics.includes(r)));
      existing.reason += `; ${reason}`;
    } else {
      byAgent.set(d.recommendedAgent, { agent: d.recommendedAgent, category: d.category, diagnostics: related, reason });
    }
  }
  for (const a of decision.assignments) {
    const rest = a.diagnostics.filter((d) => !claimed.has(d));
    if (rest.length === 0) continue;
    const existing = byAgent.get(a.agent);
    if (existing) existing.diagnostics.push(...rest);
    else byAgent.set(a.agent, { ...a, diagnostics: rest });
  }
  // Unknown failures the diagnoser did not claim go to the implementer as a last resort.
  const leftover = decision.unrouted.filter((d) => !claimed.has(d));
  if (leftover.length > 0) {
    const existing = byAgent.get('implementer');
    if (existing) existing.diagnostics.push(...leftover);
    else byAgent.set('implementer', { agent: 'implementer', category: 'unknown', diagnostics: leftover, reason: 'unclassified failures' });
  }
  const order = (a: Assignment): number => CATEGORY_PRIORITY.indexOf(a.category === 'review' ? 'unknown' : a.category);
  return [...byAgent.values()].sort((a, b) => order(a) - order(b)).map((a) => ({ ...a, diagnostics: sortDiagnostics(a.diagnostics).slice(0, MAX_DIAGNOSTICS_PER_ASSIGNMENT) }));
}
