import { describe, expect, it } from 'vitest';
import { LoopError } from '../src/core/errors';
import { allowedTransitions, canTransition, transition } from '../src/controller/state-machine';
import { LOOP_STATES, type LoopRecord, type LoopState } from '../src/persistence/models';
import { FakeClock } from './helpers';

function record(state: LoopState, pausedFrom?: LoopState): LoopRecord {
  return { state, ...(pausedFrom ? { pausedFrom } : {}), transitions: [], updatedAt: '' } as unknown as LoopRecord;
}

const LEGAL: [LoopState, LoopState][] = [
  ['INTAKE', 'PLAN'],
  ['PLAN', 'IMPLEMENT'],
  ['IMPLEMENT', 'VALIDATE'],
  ['VALIDATE', 'REVIEW'],
  ['VALIDATE', 'DIAGNOSE'],
  ['DIAGNOSE', 'FIX'],
  ['FIX', 'VALIDATE'],
  ['REVIEW', 'DONE'],
  ['REVIEW', 'DIAGNOSE'],
  ['REVIEW', 'VALIDATE'],
  ['BLOCKED', 'VALIDATE'],
  ['BLOCKED', 'INTAKE'],
];

describe('state machine', () => {
  it.each(LEGAL)('allows %s → %s', (from, to) => {
    expect(canTransition(record(from), to)).toBe(true);
    expect(transition(record(from), to, 'test', new FakeClock()).state).toBe(to);
  });

  it('allows every active state to block, pause and stop', () => {
    for (const s of ['INTAKE', 'PLAN', 'IMPLEMENT', 'VALIDATE', 'DIAGNOSE', 'FIX', 'REVIEW'] as const) {
      expect(canTransition(record(s), 'BLOCKED')).toBe(true);
      expect(canTransition(record(s), 'PAUSED')).toBe(true);
      expect(canTransition(record(s), 'STOPPED')).toBe(true);
    }
  });

  it('rejects every transition not in the table', () => {
    let illegal = 0;
    for (const from of LOOP_STATES) {
      for (const to of LOOP_STATES) {
        if (!allowedTransitions(from).includes(to)) {
          illegal++;
          expect(canTransition(record(from), to)).toBe(false);
          expect(() => transition(record(from), to, 'illegal', new FakeClock())).toThrow(LoopError);
        }
      }
    }
    expect(illegal).toBeGreaterThan(50);
  });

  it('rejects shortcuts that skip validation', () => {
    expect(canTransition(record('IMPLEMENT'), 'REVIEW')).toBe(false);
    expect(canTransition(record('FIX'), 'DONE')).toBe(false);
    expect(canTransition(record('VALIDATE'), 'DONE')).toBe(false);
    expect(canTransition(record('DIAGNOSE'), 'DONE')).toBe(false);
  });

  it('treats DONE and STOPPED as terminal', () => {
    expect(allowedTransitions('DONE')).toEqual([]);
    expect(allowedTransitions('STOPPED')).toEqual([]);
  });

  it('pause remembers the state and resume only returns to it', () => {
    const paused = transition(record('FIX'), 'PAUSED', 'user', new FakeClock());
    expect(paused.pausedFrom).toBe('FIX');
    expect(canTransition(paused, 'FIX')).toBe(true);
    expect(canTransition(paused, 'VALIDATE')).toBe(false);
    expect(canTransition(paused, 'STOPPED')).toBe(true);
    const resumed = transition(paused, 'FIX', 'resume', new FakeClock());
    expect(resumed.pausedFrom).toBeUndefined();
  });

  it('records transition history and clears the blocked reason when leaving BLOCKED', () => {
    const blocked = { ...transition(record('VALIDATE'), 'BLOCKED', 'limit', new FakeClock()), blocked: { code: 'LOOP_LIMIT' as const, message: 'x' } };
    const retried = transition(blocked, 'VALIDATE', 'retry', new FakeClock());
    expect(retried.blocked).toBeUndefined();
    expect(retried.transitions.map((t) => `${t.from}->${t.to}`)).toEqual(['VALIDATE->BLOCKED', 'BLOCKED->VALIDATE']);
  });
});
