import { LoopError } from '../core/errors';
import type { Clock } from '../core/ports';
import type { LoopRecord, LoopState, TransitionRecord } from '../persistence/models';

/**
 * Explicit transition table. Anything not listed is illegal.
 * PAUSED can only resume into the state it was paused from (checked separately).
 */
const TRANSITIONS: Readonly<Record<LoopState, readonly LoopState[]>> = {
  INTAKE: ['PLAN', 'BLOCKED', 'PAUSED', 'STOPPED'],
  PLAN: ['IMPLEMENT', 'BLOCKED', 'PAUSED', 'STOPPED'],
  IMPLEMENT: ['VALIDATE', 'BLOCKED', 'PAUSED', 'STOPPED'],
  VALIDATE: ['REVIEW', 'DIAGNOSE', 'BLOCKED', 'PAUSED', 'STOPPED'],
  DIAGNOSE: ['FIX', 'BLOCKED', 'PAUSED', 'STOPPED'],
  FIX: ['VALIDATE', 'BLOCKED', 'PAUSED', 'STOPPED'],
  REVIEW: ['DONE', 'VALIDATE', 'DIAGNOSE', 'BLOCKED', 'PAUSED', 'STOPPED'],
  PAUSED: ['INTAKE', 'PLAN', 'IMPLEMENT', 'VALIDATE', 'DIAGNOSE', 'FIX', 'REVIEW', 'STOPPED'],
  BLOCKED: ['INTAKE', 'VALIDATE', 'STOPPED'],
  DONE: [],
  STOPPED: [],
};

export const TERMINAL_STATES: readonly LoopState[] = ['DONE', 'STOPPED'];
/** States in which the controller does not advance on its own. */
export const IDLE_STATES: readonly LoopState[] = ['DONE', 'STOPPED', 'BLOCKED', 'PAUSED'];
export const ACTIVE_STATES: readonly LoopState[] = ['INTAKE', 'PLAN', 'IMPLEMENT', 'VALIDATE', 'DIAGNOSE', 'FIX', 'REVIEW'];

export function isTerminal(state: LoopState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isActive(state: LoopState): boolean {
  return ACTIVE_STATES.includes(state);
}

export function allowedTransitions(from: LoopState): readonly LoopState[] {
  return TRANSITIONS[from];
}

export function canTransition(record: Pick<LoopRecord, 'state' | 'pausedFrom'>, to: LoopState): boolean {
  if (!TRANSITIONS[record.state].includes(to)) {
    return false;
  }
  if (record.state === 'PAUSED' && to !== 'STOPPED') {
    return record.pausedFrom === to;
  }
  return true;
}

const MAX_TRANSITIONS_KEPT = 200;

/**
 * Applies a transition to a record, returning a new record. Throws on an
 * illegal transition: that is a controller bug and must never be silently ignored.
 */
export function transition(record: LoopRecord, to: LoopState, reason: string, clock: Clock): LoopRecord {
  if (!canTransition(record, to)) {
    throw new LoopError('CONFIGURATION_ERROR', `Illegal state transition ${record.state} → ${to} (${reason})`, { from: record.state, to });
  }
  const at = clock.now().toISOString();
  const entry: TransitionRecord = { from: record.state, to, at, reason };
  const next: LoopRecord = {
    ...record,
    state: to,
    transitions: [...record.transitions, entry].slice(-MAX_TRANSITIONS_KEPT),
    updatedAt: at,
  };
  if (to === 'PAUSED') {
    next.pausedFrom = record.state;
  } else {
    delete next.pausedFrom;
  }
  if (to !== 'BLOCKED') {
    delete next.blocked;
  }
  return next;
}
