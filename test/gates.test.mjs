import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { collect, history, prune } from '../src/collector.mjs';
import { runAcceptance, safePath } from '../src/gates.mjs';
import { run as cli } from '../src/cli.mjs';
import { TaskStore } from '../src/tasks.mjs';

const execFile = promisify(execFileCallback);
async function git(args, cwd) { return (await execFile('git', args, { cwd })).stdout.trim(); }
async function fixture(taskId = 'accept-1') {
  const root = await mkdtemp(join(tmpdir(), 'zh-gates-')); const repo = join(root, 'repo'); const worktree = join(root, 'worktree'); const data = join(root, 'state');
  await execFile('git', ['init', '-b', 'main', repo]); await git(['config', 'user.email', 'test@example.com'], repo); await git(['config', 'user.name', 'Test'], repo);
  await writeFile(join(repo, 'README.md'), 'base\n'); await git(['add', '.'], repo); await git(['commit', '-m', 'base'], repo);
  await git(['worktree', 'add', '-b', `fleet/${taskId}`, worktree, 'main'], repo);
  return { root, repo, worktree, data, taskId };
}
function acceptance(overrides = {}) { return { merge_ref: 'main', checks: [{ name: 'unit', cmd: 'node', args: ['-e', 'process.exit(0)'], expect_exit: 0 }], assertions: [], ...overrides }; }
async function succeeded(env, config = acceptance(), patch = {}) {
  const store = new TaskStore(env.data); const payload = { repo_path: env.repo, base_ref: 'main', brief: 'normal brief', acceptance: config, ...patch };
  const task = await store.create({ task_id: env.taskId, payload }); await store.transition(env.taskId, 'locked'); await store.transition(env.taskId, 'running', { worktree: env.worktree }); await store.transition(env.taskId, 'succeeded', { commit: await git(['rev-parse', 'HEAD'], env.worktree) });
  return { store, task: await store.get(env.taskId) };
}
async function commitFile(env, name = 'WORKED.md', content = 'worked\n') { await writeFile(join(env.worktree, name), content); await git(['add', name], env.worktree); await git(['commit', '-m', `add ${name}`], env.worktree); }

test('gates run only configured cmd/args in the task worktree', async () => {
  const env = await fixture(); await writeFile(join(env.worktree, 'cwd.txt'), 'worktree'); const { task } = await succeeded(env, acceptance({ checks: [{ name: 'cwd', cmd: 'node', args: ['-e', "require('fs').accessSync('cwd.txt')"], expect_exit: 0 }], assertions: [] }), { brief: 'rm -rf /; never execute this', log: 'rm -rf /' });
  const result = await runAcceptance(task); assert.equal(result.pass, true); await assert.rejects(stat(join(env.repo, 'cwd.txt')));
});

test('assertions support exists, absent, and file-contains', async () => {
  const env = await fixture(); await writeFile(join(env.worktree, 'note.txt'), 'needle here'); const { task } = await succeeded(env, acceptance({ checks: [], assertions: [{ name: 'exists', path: 'note.txt', expect: 'exists' }, { name: 'absent', path: 'missing.txt', expect: 'absent' }, { name: 'contains', path: 'note.txt', expect: 'file-contains', substring: 'needle' }] }));
  assert.equal((await runAcceptance(task)).pass, true);
});

test('a missing substring rejects acceptance', async () => {
  const env = await fixture(); await writeFile(join(env.worktree, 'note.txt'), 'different'); const { task } = await succeeded(env, acceptance({ checks: [], assertions: [{ name: 'contains', path: 'note.txt', expect: 'file-contains', substring: 'needle' }] }));
  const result = await runAcceptance(task); assert.equal(result.pass, false); assert.match(result.results[0].detail, /missing substring/);
});

test('assertion paths cannot escape the worktree', () => assert.throws(() => safePath('/tmp/one', '../two'), /escapes worktree/));

test('timeout is reported by a check', async () => {
  const env = await fixture(); const { task } = await succeeded(env, acceptance({ timeout_sec: 0.02, checks: [{ name: 'slow', cmd: 'node', args: ['-e', 'setInterval(()=>{},1000)'], expect_exit: 0 }], assertions: [] }));
  const result = await runAcceptance(task); assert.equal(result.pass, false); assert.equal(result.results[0].timedOut, true);
});

test('collect PASS merges fleet branch, tags, and marks verified', async () => {
  const env = await fixture('pass-1'); await commitFile(env); const { store } = await succeeded(env, acceptance({ checks: [{ name: 'worked', cmd: 'node', args: ['-e', "require('fs').accessSync('WORKED.md')"], expect_exit: 0 }], assertions: [{ name: 'exists', path: 'WORKED.md', expect: 'exists' }] }));
  const result = await collect(env.taskId, { store, now: () => new Date('2026-01-01T00:00:00Z') });
  assert.equal(result.pass, true); assert.equal((await store.get(env.taskId)).status, 'verified'); assert.equal(await git(['tag', '--list', `verified/${env.taskId}`], env.repo), `verified/${env.taskId}`); assert.match(await readFile(join(env.repo, 'WORKED.md'), 'utf8'), /worked/);
});

test('collect FAIL writes a three-section rework brief and rejects', async () => {
  const env = await fixture('fail-1'); const { store } = await succeeded(env, acceptance({ checks: [{ name: 'bad', cmd: 'node', args: ['-e', "console.error('bad');process.exit(3)"], expect_exit: 0 }], assertions: [] }), { brief: 'repair this' });
  const result = await collect(env.taskId, { store }); const content = await readFile(result.rework_file, 'utf8');
  assert.equal(result.pass, false); assert.equal((await store.get(env.taskId)).status, 'rejected'); assert.match(content, /## 1\. 原任务与验收配置/); assert.match(content, /## 2\. 实测问题/); assert.match(content, /## 3\. 期望行为与复验判据/);
});

test('rework stdout and stderr are truncated to 50 lines', async () => {
  const env = await fixture('tail-1'); const { store } = await succeeded(env, acceptance({ checks: [{ name: 'noisy', cmd: 'node', args: ['-e', "console.log(Array.from({length:70},(_,i)=>'out'+i).join('\\n'));console.error(Array.from({length:70},(_,i)=>'err'+i).join('\\n'));process.exit(1)"], expect_exit: 0 }], assertions: [] }));
  const result = await collect(env.taskId, { store }); const content = await readFile(result.rework_file, 'utf8');
  assert.equal(content.includes('out0'), false); assert.equal(content.includes('err0'), false); assert.equal(content.includes('out69'), true); assert.equal(content.includes('err69'), true);
});

test('all timed out checks classify failure as env', async () => {
  const env = await fixture('env-1'); const { store } = await succeeded(env, acceptance({ checks: [{ name: 'slow', cmd: 'node', args: ['-e', '0'], expect_exit: 0 }], assertions: [] }));
  const result = await collect(env.taskId, { store, gateContext: { runCheck: async () => ({ exit: null, stdout: '', stderr: '', timedOut: true }) } });
  assert.equal(result.fail_class, 'env');
});

test('ENOENT check failure classifies as auth-env', async () => {
  const env = await fixture('enoent-1'); const { store } = await succeeded(env, acceptance({ checks: [{ name: 'missing', cmd: 'not-installed', args: [], expect_exit: 0 }], assertions: [] }));
  const result = await collect(env.taskId, { store, gateContext: { runCheck: async () => ({ exit: null, stdout: '', stderr: '', errorCode: 'ENOENT' }) } });
  assert.equal(result.fail_class, 'auth-env');
});

test('collect rejects a running task with CLI exit 2', async () => {
  const env = await fixture('running-1'); const store = new TaskStore(env.data); await store.create({ task_id: env.taskId, payload: { repo_path: env.repo, acceptance: acceptance() } }); await store.transition(env.taskId, 'locked'); await store.transition(env.taskId, 'running', { worktree: env.worktree });
  assert.equal(await cli(['collect', env.taskId, '--data', env.data], { out: () => {}, err: () => {} }), 2);
});

test('history returns the complete event timeline for one task', async () => {
  const env = await fixture('history-1'); await commitFile(env); const { store } = await succeeded(env, acceptance({ checks: [], assertions: [] })); await collect(env.taskId, { store });
  const events = await history(store, env.taskId); assert.ok(events.some((event) => event.type === 'task.created')); assert.ok(events.some((event) => event.type === 'collect.verified')); assert.ok(events.every((event) => event.task_id === env.taskId));
});

test('prune removes only expired verified worktrees', async () => {
  const env = await fixture('old-1'); const { store } = await succeeded(env, acceptance({ checks: [], assertions: [] })); await store.transition(env.taskId, 'verified', { worktree_retained_until: '2020-01-01T00:00:00Z' });
  const future = await store.create({ task_id: 'future-1', payload: { repo_path: env.repo } }); await store.transition(future.task_id, 'locked'); await store.transition(future.task_id, 'running', { worktree: '/future' }); await store.transition(future.task_id, 'succeeded'); await store.transition(future.task_id, 'verified', { worktree: '/future', worktree_retained_until: '2999-01-01T00:00:00Z' });
  const commands = []; const removed = await prune(store, { nowMs: Date.parse('2026-01-01T00:00:00Z'), git: async (args) => { commands.push(args); } });
  assert.deepEqual(removed, ['old-1']); assert.equal(commands.length, 1); assert.ok((await store.get('old-1')).worktree_pruned_at); assert.equal((await store.get('future-1')).worktree_pruned_at, undefined);
});

test('attached manual dispatch is eligible for collect', async () => {
  const env = await fixture('manual-1'); await commitFile(env); const store = new TaskStore(env.data); await store.create({ task_id: env.taskId, payload: { repo_path: env.repo, acceptance: acceptance({ checks: [], assertions: [] }) } }); await store.transition(env.taskId, 'locked'); await store.transition(env.taskId, 'dispatched', { worktree: env.worktree, attached_branch: `fleet/${env.taskId}` });
  assert.equal((await collect(env.taskId, { store })).pass, true); assert.equal((await store.get(env.taskId)).status, 'verified');
});
