import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileRunLock, JsonStateStore } from '../src/persistence/state-store';
import type { IterationRecord, LoopRecord } from '../src/persistence/models';
import { tempDir } from './helpers';

function fakeRecord(): LoopRecord {
  return { schemaVersion: 1, runId: 'r1', state: 'FIX', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '' } as unknown as LoopRecord;
}

describe('JSON state store', () => {
  it('round-trips state and survives concurrent saves', async () => {
    const dir = await tempDir();
    const store = new JsonStateStore(path.join(dir, '.copilot-loop'));
    expect(await store.load()).toBeUndefined();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.save({ ...fakeRecord(), iteration: i })));
    const loaded = await store.load();
    expect(loaded?.iteration).toBe(19);
    const files = await fs.readdir(path.join(dir, '.copilot-loop'));
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('writes numbered, redacted history files', async () => {
    const dir = await tempDir();
    const store = new JsonStateStore(path.join(dir, '.copilot-loop'));
    const entry = { sequence: 1, notes: ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789'] } as unknown as IterationRecord;
    await store.appendHistory(entry);
    await store.appendHistory({ ...entry, sequence: 2 });
    expect(await store.listHistory()).toEqual([1, 2]);
    const text = await fs.readFile(path.join(dir, '.copilot-loop/history/0001.json'), 'utf8');
    expect(text).not.toContain('ghp_');
    expect(text).toContain('[REDACTED]');
  });

  it('reports corrupted state clearly', async () => {
    const dir = await tempDir();
    await fs.mkdir(path.join(dir, '.copilot-loop'));
    await fs.writeFile(path.join(dir, '.copilot-loop/state.json'), '{not json');
    await expect(new JsonStateStore(path.join(dir, '.copilot-loop')).load()).rejects.toMatchObject({ code: 'WORKSPACE_ERROR' });
  });

  it('archives the current run', async () => {
    const dir = await tempDir();
    const store = new JsonStateStore(path.join(dir, '.copilot-loop'));
    await store.save(fakeRecord());
    await store.appendHistory({ sequence: 1 } as unknown as IterationRecord);
    const target = await store.archiveCurrent();
    expect(target).toBeDefined();
    expect(await store.load()).toBeUndefined();
    expect(await store.listHistory()).toEqual([]);
    expect(await fs.readdir(target as string)).toEqual(['history', 'state.json']);
  });

  it('run lock excludes live owners and takes over stale locks', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'lock');
    await fs.writeFile(file, JSON.stringify({ pid: 1, owner: 'init' }));
    // pid 1 is alive (init) but owned by another user → EPERM means alive → must refuse.
    await expect(new FileRunLock(file).acquire('me')).rejects.toMatchObject({ code: 'WORKSPACE_ERROR' });
    await fs.writeFile(file, JSON.stringify({ pid: 999999999, owner: 'dead' }));
    const lock = new FileRunLock(file);
    await lock.acquire('me');
    await lock.release();
    await expect(fs.stat(file)).rejects.toThrow();
  });
});
