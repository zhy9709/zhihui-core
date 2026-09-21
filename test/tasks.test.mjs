import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskConflictError, TaskStore } from '../src/tasks.mjs';
import { atomicWriteJson, readJson } from '../src/state.mjs';

async function store() { return new TaskStore(await mkdtemp(join(tmpdir(), 'zh-task-')), { now: () => '2026-01-01T00:00:00.000Z' }); }

test('task-id is a unique idempotency key', async () => {
  const tasks = await store(); await tasks.create({ task_id: 'T-1' });
  await assert.rejects(tasks.create({ task_id: 'T-1' }), TaskConflictError);
  assert.equal((await tasks.get('T-1')).status, 'queued');
});

test('task transitions follow the state machine', async () => {
  const tasks = await store(); await tasks.create({ task_id: 'T-2' });
  await tasks.transition('T-2', 'locked'); await tasks.transition('T-2', 'running'); await tasks.transition('T-2', 'done');
  assert.equal((await tasks.get('T-2')).status, 'done');
  await assert.rejects(tasks.transition('T-2', 'running'), /invalid transition/);
});

test('recover marks stale running locks as unknown', async () => {
  const tasks = new TaskStore(await mkdtemp(join(tmpdir(), 'zh-recover-')), { now: () => '2020-01-01T00:00:00.000Z' });
  await tasks.create({ task_id: 'T-3' }); await tasks.transition('T-3', 'locked'); await tasks.transition('T-3', 'running');
  assert.deepEqual(await tasks.recover({ staleAfterMs: 1000, nowMs: Date.parse('2020-01-01T00:00:10.000Z') }), ['T-3']);
  assert.equal((await tasks.get('T-3')).status, 'unknown');
});

test('recover keeps a fresh running task', async () => {
  const tasks = new TaskStore(await mkdtemp(join(tmpdir(), 'zh-fresh-')), { now: () => '2020-01-01T00:00:00.000Z' });
  await tasks.create({ task_id: 'T-4' }); await tasks.transition('T-4', 'locked'); await tasks.transition('T-4', 'running');
  assert.deepEqual(await tasks.recover({ staleAfterMs: 60_000, nowMs: Date.parse('2020-01-01T00:00:10.000Z') }), []);
  assert.equal((await tasks.get('T-4')).status, 'running');
});

test('atomic writes leave a crash residue out of the official JSON file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zh-atomic-')); const file = join(directory, 'state.json');
  await atomicWriteJson(file, { safe: true });
  await writeFile(join(directory, '.state.json.interrupted.tmp'), '{"safe": false');
  assert.deepEqual(await readJson(file), { safe: true });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).safe, true);
});

test('events are persisted as newline-delimited JSON', async () => {
  const tasks = await store(); await tasks.create({ task_id: 'T-5' });
  const lines = (await readFile(tasks.eventsFile, 'utf8')).trim().split('\n');
  assert.equal(JSON.parse(lines[0]).type, 'task.created');
});
