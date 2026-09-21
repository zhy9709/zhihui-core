import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { run as cli } from '../src/cli.mjs';
import { DispatchError, attach, launch, prepare, registerManual, renderLaunch, worktreePath } from '../src/runner.mjs';
import { TaskStore } from '../src/tasks.mjs';

const execFile = promisify(execFileCallback);
async function git(args, cwd) { return (await execFile('git', args, { cwd })).stdout.trim(); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zh-runner-')); const repo = join(root, 'repo'); const workspaces = join(root, 'workspaces');
  await mkdir(repo); await git(['init', '-b', 'main'], repo); await git(['config', 'user.email', 'test@example.com'], repo); await git(['config', 'user.name', 'Test'], repo);
  await writeFile(join(repo, 'README.md'), 'base\n'); await git(['add', 'README.md'], repo); await git(['commit', '-m', 'base'], repo);
  return { root, repo, workspaces, data: join(root, 'state') };
}
const driver = (overrides = {}) => ({ name: 'fake', kind: 'headless', host: 'local', platform: 'linux', timeout_min: 1, caps: ['test'], cost: 'free', quota_probe: null, launch: `node -e "require('fs').writeFileSync('agent.txt','ok');require('child_process').execFileSync('git',['add','agent.txt']);require('child_process').execFileSync('git',['commit','-m','agent'])"`, ...overrides });
const payload = (repo, workspaces, taskId = 'job-1') => ({ task_id: taskId, repo_path: repo, base_ref: 'main', workspaces_root: workspaces, brief: 'do work' });
async function lockedTask(data, spec) { const store = new TaskStore(data); const task = await store.create({ task_id: spec.task_id, payload: spec }); await store.transition(task.task_id, 'locked'); return { store, task }; }

test('prepare creates an isolated git worktree and fleet branch', async () => {
  const env = await fixture(); const spec = payload(env.repo, env.workspaces); const { task } = await lockedTask(env.data, spec);
  const ctx = await prepare(task, driver(), { workspacesRoot: env.workspaces });
  assert.equal(await git(['branch', '--show-current'], ctx.worktree), 'fleet/job-1');
  assert.equal((await readFile(join(ctx.worktree, 'README.md'), 'utf8')).trim(), 'base');
});

test('prepare refuses an existing fleet branch/worktree conflict', async () => {
  const env = await fixture(); const spec = payload(env.repo, env.workspaces); const { task } = await lockedTask(env.data, spec);
  await prepare(task, driver(), { workspacesRoot: env.workspaces });
  await assert.rejects(prepare(task, driver(), { workspacesRoot: env.workspaces }), /already exists|fatal/);
});

test('prepare rejects when max_worktrees is reached without deleting anything', async () => {
  const env = await fixture(); await mkdir(join(env.workspaces, 'occupied'), { recursive: true }); const spec = payload(env.repo, env.workspaces); const { task } = await lockedTask(env.data, spec);
  await assert.rejects(prepare(task, driver(), { workspacesRoot: env.workspaces, maxWorktrees: 1 }), /max_worktrees/);
  await stat(join(env.workspaces, 'occupied'));
});

test('launch templates replace every required placeholder safely', () => {
  const command = renderLaunch(driver({ launch: 'agent {brief} {worktree} {log}' }), { payload: { brief: 'two words' } }, { worktree: '/tmp/a b', logFile: '/tmp/log file' });
  assert.equal(command, "agent 'two words' '/tmp/a b' '/tmp/log file'");
});

test('Windows launch templates use Windows quoting without a Windows host', () => {
  const command = renderLaunch(driver({ platform: 'win', launch: 'agent {brief}' }), { payload: { brief: 'a b' } }, { worktree: 'x', logFile: 'y' });
  assert.equal(command, 'agent "a b"');
});

test('a fake headless agent commits in its worktree and succeeds', async () => {
  const env = await fixture(); const spec = payload(env.repo, env.workspaces); const { store, task } = await lockedTask(env.data, spec); const ctx = await prepare(task, driver(), { workspacesRoot: env.workspaces });
  const result = await launch(driver(), task, { store, ...ctx, timeoutMs: 5_000 });
  assert.equal(result.ok, true); assert.equal((await store.get(task.task_id)).status, 'succeeded'); assert.match((await store.get(task.task_id)).commit, /^[0-9a-f]{40}$/);
});

test('exit zero without a new commit is failed as noop', async () => {
  const env = await fixture(); const spec = payload(env.repo, env.workspaces); const { store, task } = await lockedTask(env.data, spec); const ctx = await prepare(task, driver({ launch: 'node -e ""' }), { workspacesRoot: env.workspaces });
  await launch(driver({ launch: 'node -e ""' }), task, { store, ...ctx, timeoutMs: 5_000 });
  assert.equal((await store.get(task.task_id)).reason, 'noop');
});

test('non-zero fake agent exit is failed', async () => {
  const env = await fixture(); const spec = payload(env.repo, env.workspaces); const { store, task } = await lockedTask(env.data, spec); const bad = driver({ launch: 'node -e "process.exit(7)"' }); const ctx = await prepare(task, bad, { workspacesRoot: env.workspaces });
  await launch(bad, task, { store, ...ctx, timeoutMs: 5_000 });
  const taskAfter = await store.get(task.task_id); assert.equal(taskAfter.status, 'failed'); assert.equal(taskAfter.exit_code, 7);
});

test('timeout kills the detached process group and records failure', async () => {
  const env = await fixture(); const spec = payload(env.repo, env.workspaces); const { store, task } = await lockedTask(env.data, spec); const slow = driver({ launch: 'node -e "setInterval(()=>{},1000)"' }); const ctx = await prepare(task, slow, { workspacesRoot: env.workspaces });
  await launch(slow, task, { store, ...ctx, timeoutMs: 80, heartbeatIntervalMs: 10 });
  assert.equal((await store.get(task.task_id)).reason, 'timeout');
});

test('manual dispatch records then attaches an external branch', async () => {
  const env = await fixture(); const spec = payload(env.repo, env.workspaces); const { store, task } = await lockedTask(env.data, spec); const manual = driver({ name: 'manual', kind: 'manual' });
  assert.equal(await registerManual(manual, task, store), '任务书已登记待粘贴'); await attach(task.task_id, 'agent/manual-1', store);
  const after = await store.get(task.task_id); assert.equal(after.status, 'dispatched'); assert.equal(after.attached_branch, 'agent/manual-1');
});

test('CLI dispatch duplicate task-id returns exit 3 with no second side effect', async () => {
  const env = await fixture(); const spec = payload(env.repo, env.workspaces, 'dup'); const fleet = join(env.root, 'fleet.json'); const taskFile = join(env.root, 'task.json');
  await writeFile(fleet, JSON.stringify({ workspaces_root: env.workspaces, drivers: [driver({ kind: 'manual', name: 'manual' })] })); await writeFile(taskFile, JSON.stringify(spec));
  const quiet = { out: () => {}, err: () => {} };
  assert.equal(await cli(['dispatch', taskFile, '--fleet', fleet, '--data', env.data], quiet), 0);
  assert.equal(await cli(['dispatch', taskFile, '--fleet', fleet, '--data', env.data], quiet), 3);
  assert.equal((await new TaskStore(env.data).list()).length, 1);
});

test('CLI dry dispatch creates neither task state nor worktree', async () => {
  const env = await fixture(); const spec = payload(env.repo, env.workspaces, 'dry'); const fleet = join(env.root, 'fleet.json'); const taskFile = join(env.root, 'task.json');
  await writeFile(fleet, JSON.stringify({ workspaces_root: env.workspaces, drivers: [driver()] })); await writeFile(taskFile, JSON.stringify(spec));
  assert.equal(await cli(['dispatch', taskFile, '--fleet', fleet, '--data', env.data, '--dry'], { out: () => {}, err: () => {} }), 0);
  assert.equal(await new TaskStore(env.data).get('dry'), null); await assert.rejects(stat(env.workspaces));
});

test('remote dispatch uses injected SSH runner and records returned commit', async () => {
  const env = await fixture(); const spec = payload(env.repo, env.workspaces, 'remote'); const { store, task } = await lockedTask(env.data, spec); const remote = driver({ host: 'worker-win', platform: 'win' });
  const result = await launch(remote, task, { store, worktree: 'remote-worktree', logFile: 'remote-log', sshRunner: async (request) => { assert.equal(request.platform, 'win'); return { code: 0, commit: 'abc123' }; } });
  assert.equal(result.result.commit, 'abc123'); assert.equal((await store.get(task.task_id)).status, 'succeeded');
});

test('remote timeout sends an injected cancel request and fails the task', async () => {
  const env = await fixture(); const spec = payload(env.repo, env.workspaces, 'remote-timeout'); const { store, task } = await lockedTask(env.data, spec); const remote = driver({ host: 'worker-win', platform: 'win' }); let cancelled = false;
  const result = await launch(remote, task, { store, worktree: 'remote-worktree', logFile: 'remote-log', timeoutMs: 20, sshRunner: async (request) => {
    if (request.operation === 'cancel') { cancelled = true; return { code: 0 }; }
    return new Promise(() => {});
  } });
  assert.equal(result.timedOut, true); assert.equal(cancelled, true); assert.equal((await store.get(task.task_id)).reason, 'timeout');
});

test('recover treats an expired worktree heartbeat as unknown and never re-dispatches', async () => {
  const env = await fixture(); const spec = payload(env.repo, env.workspaces, 'stale'); const { store, task } = await lockedTask(env.data, spec); await store.transition(task.task_id, 'running');
  const heartbeat = join(env.root, 'heartbeat'); await writeFile(heartbeat, 'old'); await utimes(heartbeat, new Date(0), new Date(0)); await store.annotate(task.task_id, { heartbeat_file: heartbeat });
  assert.deepEqual(await store.recover({ staleAfterMs: 30_000, nowMs: 60_000 }), ['stale']); assert.equal((await store.get(task.task_id)).status, 'unknown');
});

test('worktree path rejects traversal task ids', () => assert.throws(() => worktreePath('/tmp/workspaces', '../escape'), DispatchError));
