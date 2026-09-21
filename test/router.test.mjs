import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { run as cli } from '../src/cli.mjs';
import { RouteError, routeTask } from '../src/router.mjs';
import { aggregateUsage } from '../src/usage.mjs';

const execFile = promisify(execFileCallback);
async function git(args, cwd) { return (await execFile('git', args, { cwd })).stdout.trim(); }
const task = (overrides = {}) => ({ task_id: 'route-1', caps_required: ['code'], difficulty: 5, ...overrides });
const driver = (name, overrides = {}) => ({ name, kind: 'headless', caps: ['code'], cost: 'free-tier', quota_probe: null, host: 'local', platform: 'linux', timeout_min: 1, model_tier: 'mid', launch: 'node -e "process.exit(0)"', ...overrides });
const fleet = (...drivers) => ({ drivers });
const state = (drivers) => ({ drivers });

test('router excludes a driver missing required caps', () => {
  const plan = routeTask(task(), fleet(driver('good'), driver('bad', { caps: ['docs'] })), state({}));
  assert.equal(plan.suggestions[0].driver, 'good'); assert.match(plan.excluded[0].reason, /能力缺少: code/);
});

test('router excludes offline and FAIL drivers', () => {
  const plan = routeTask(task(), fleet(driver('good'), driver('off'), driver('fail')), state({ off: { health: 'offline' }, fail: { status: 'FAIL' } }));
  assert.equal(plan.excluded.length, 2); assert.ok(plan.excluded.every((item) => /状态/.test(item.reason)));
});

test('router excludes free-tier driver below quota waterline', () => {
  const plan = routeTask(task(), fleet(driver('good'), driver('low')), state({ low: { quota: { value: 0.15 } } }));
  assert.match(plan.excluded.find((item) => item.driver === 'low').reason, /水位0\.15<0\.20/);
});

test('--to cannot bypass hard gates', () => {
  assert.throws(() => routeTask(task(), fleet(driver('low')), state({ low: { quota: { value: 0.1 } } }), { to: 'low' }), (error) => error instanceof RouteError && error.code === 'ROUTE_INELIGIBLE');
});

test('same input always produces stable sorted output', () => {
  const inputFleet = fleet(driver('a'), driver('b', { kind: 'manual' }), driver('c', { cost: 'paid-fixed' })); const inputState = state({ a: { recent_results: [true, true, false, true, true] }, b: { recent_results: [true, true, true, true, true] }, c: { recent_results: [true, true, true, true, true] } });
  assert.deepEqual(routeTask(task(), inputFleet, inputState), routeTask(task(), inputFleet, inputState)); assert.equal(routeTask(task(), inputFleet, inputState).suggestions[0].driver, 'b');
});

test('reasons cite recent failures and numeric factors', () => {
  const plan = routeTask(task(), fleet(driver('a')), state({ a: { recent_results: [true, true, true, false, false], quota: { value: 0.8 } } }));
  assert.ok(plan.suggestions[0].reasons.some((reason) => reason.includes('近5败2→0.60'))); assert.ok(plan.suggestions[0].reasons.some((reason) => reason.includes('水位0.80')));
});

test('difficulty gives deterministic high and low model bonuses', () => {
  const high = routeTask(task({ difficulty: 9 }), fleet(driver('high', { model_tier: 'high' }), driver('mid')), state({}));
  assert.equal(high.suggestions[0].driver, 'high'); assert.equal(high.suggestions[0].score, 1.2);
  const low = routeTask(task({ difficulty: 2 }), fleet(driver('low', { model_tier: 'low' }), driver('mid')), state({})); assert.equal(low.suggestions[0].driver, 'low'); assert.equal(low.suggestions[0].score, 1.1);
});

test('fewer than three samples uses success factor 1.00', () => {
  const plan = routeTask(task(), fleet(driver('a')), state({ a: { recent_results: [false, false] } }));
  assert.equal(plan.suggestions[0].score, 1); assert.ok(plan.suggestions[0].reasons.some((reason) => reason.includes('样本2<3')));
});

test('route CLI returns exit 4 when no candidates remain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zh-route-')); const fleetFile = join(root, 'fleet.json'); const taskFile = join(root, 'task.json'); const data = join(root, 'state');
  await writeFile(fleetFile, JSON.stringify(fleet(driver('low')))); await writeFile(taskFile, JSON.stringify(task())); await execFile('mkdir', ['-p', data]); await writeFile(join(data, 'state.json'), JSON.stringify(state({ low: { quota: { value: 0.1 } } })));
  assert.equal(await cli(['route', taskFile, '--fleet', fleetFile, '--data', data], { out: () => {}, err: () => {} }), 4);
});

test('dispatch with multiple drivers selects route winner and prints basis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zh-dispatch-route-')); const fleetFile = join(root, 'fleet.json'); const taskFile = join(root, 'task.json'); const data = join(root, 'state'); const output = [];
  await writeFile(fleetFile, JSON.stringify(fleet(driver('winner', { kind: 'manual', model_tier: 'high' }), driver('other', { kind: 'manual' })))); await writeFile(taskFile, JSON.stringify(task({ task_id: 'auto', difficulty: 9 })));
  assert.equal(await cli(['dispatch', taskFile, '--fleet', fleetFile, '--data', data], { out: (value) => output.push(value), err: () => {} }), 0); assert.ok(output.join('').includes('路由依据')); assert.ok(output.join('').includes('任务书已登记待粘贴'));
});

test('single candidate dispatches directly without route-basis line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zh-dispatch-one-')); const fleetFile = join(root, 'fleet.json'); const taskFile = join(root, 'task.json'); const output = [];
  await writeFile(fleetFile, JSON.stringify(fleet(driver('manual', { kind: 'manual' })))); await writeFile(taskFile, JSON.stringify(task({ task_id: 'one' })));
  assert.equal(await cli(['dispatch', taskFile, '--fleet', fleetFile, '--data', join(root, 'state')], { out: (value) => output.push(value), err: () => {} }), 0); assert.equal(output.join('').includes('路由依据'), false);
});

test('usage aggregates tasks, outcomes, duration, and paid rate-limit facts', () => {
  const drivers = fleet(driver('free'), driver('paid', { cost: 'paid-fixed', rate_limit_note: '5h window' })); const events = [
    { type: 'task.created', task_id: 'a', at: '2026-01-01T00:00:00Z' }, { type: 'task.transition', task_id: 'a', at: '2026-01-01T00:00:01Z', status: 'locked', driver: 'free' }, { type: 'task.transition', task_id: 'a', at: '2026-01-01T00:00:11Z', status: 'succeeded' },
    { type: 'task.created', task_id: 'b', at: '2026-01-01T00:00:00Z' }, { type: 'task.transition', task_id: 'b', at: '2026-01-01T00:00:02Z', status: 'locked', driver: 'paid' }, { type: 'task.transition', task_id: 'b', at: '2026-01-01T00:00:08Z', status: 'failed' }
  ]; const rows = aggregateUsage(events, drivers, { nowMs: Date.parse('2026-01-02T00:00:00Z') });
  assert.deepEqual(rows.find((row) => row.driver === 'free').tasks, 1); assert.equal(rows.find((row) => row.driver === 'free').duration_seconds, 10); assert.equal(rows.find((row) => row.driver === 'paid').rate_limit_note, '5h window'); assert.equal(JSON.stringify(rows).includes('unlimited'), false);
});

test('failed headless dispatch records blacklist suggestion but does not retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zh-blacklist-')); const repo = join(root, 'repo'); const workspaces = join(root, 'workspaces'); const data = join(root, 'state'); const fleetFile = join(root, 'fleet.json'); const taskFile = join(root, 'task.json');
  await execFile('git', ['init', '-b', 'main', repo]); await git(['config', 'user.email', 'test@example.com'], repo); await git(['config', 'user.name', 'Test'], repo); await writeFile(join(repo, 'README.md'), 'base'); await git(['add', '.'], repo); await git(['commit', '-m', 'base'], repo);
  await writeFile(fleetFile, JSON.stringify({ workspaces_root: workspaces, drivers: [driver('bad', { launch: 'node -e "process.exit(1)"' })] })); await writeFile(taskFile, JSON.stringify(task({ task_id: 'bad-1', repo_path: repo, base_ref: 'main', workspaces_root: workspaces })));
  assert.equal(await cli(['dispatch', taskFile, '--fleet', fleetFile, '--data', data], { out: () => {}, err: () => {} }), 0); const events = await readFile(join(data, 'events.ndjson'), 'utf8'); assert.match(events, /route\.blacklist_suggestion/); assert.equal((events.match(/route\.blacklist_suggestion/g) || []).length, 1);
});
