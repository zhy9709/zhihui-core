import { readFile } from 'node:fs/promises';
import { addDriver, collectStatus, doctor, loadFleet, validateFleet } from './fleet.mjs';
import { TaskStore } from './tasks.mjs';
import { attach, launch, prepare, registerManual, renderLaunch, worktreePath } from './runner.mjs';
import { collect, history, prune } from './collector.mjs';
import { routeTask } from './router.mjs';
import { usageFromEvents } from './usage.mjs';
import { readJson, stateFile } from './state.mjs';

function option(args, name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
function print(value, out) { out(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`); }
function positional(args) { const optionsWithValue = new Set(['--fleet', '--data', '--to', '--branch', '--task-id']); return args.filter((value, index) => !value.startsWith('--') && !optionsWithValue.has(args[index - 1])); }
function findDriver(fleet, name) { const driver = fleet.drivers.find((item) => item.name === name); if (!driver) throw new Error(`driver ${name} not found`); return driver; }

export async function run(argv, { out = process.stdout.write.bind(process.stdout), err = process.stderr.write.bind(process.stderr), probe, now, runnerOptions = {}, collectorOptions = {} } = {}) {
  const [command, ...args] = argv;
  const fleetFile = option(args, '--fleet', 'fleet.json');
  const dataDir = option(args, '--data', 'state');
  try {
    if (command === 'validate') { validateFleet(await loadFleet(fleetFile), fleetFile); print('PASS fleet valid', out); return 0; }
    if (command === 'list') { const fleet = await loadFleet(fleetFile); validateFleet(fleet, fleetFile); print(fleet.drivers.map(({ name, kind, host, platform }) => ({ name, kind, host, platform })), out); return 0; }
    if (command === 'add') { const file = args.find((arg) => !arg.startsWith('--')); if (!file) throw new Error('usage: zh add driver.json [--fleet fleet.json]'); const driver = JSON.parse(await readFile(file, 'utf8')); await addDriver(fleetFile, driver); print(`PASS added ${driver.name}`, out); return 0; }
    if (command === 'doctor') { const result = await doctor(await loadFleet(fleetFile), { file: fleetFile, probe }); print(result, out); return result.exitCode; }
    if (command === 'status') { const result = await collectStatus(await loadFleet(fleetFile), { dataDir, probe, now }); print(result, out); return result.health.exitCode; }
    if (command === 'task-create') { const taskId = option(args, '--task-id'); if (!taskId) throw new Error('usage: zh task-create --task-id ID'); const task = await new TaskStore(dataDir, { now }).create({ task_id: taskId }); print(task, out); return 0; }
    if (command === 'route') {
      const taskFile = positional(args)[0]; if (!taskFile) throw new Error('usage: zh route task.json [--to driver]');
      const payload = JSON.parse(await readFile(taskFile, 'utf8')); const fleet = await loadFleet(fleetFile); validateFleet(fleet, fleetFile);
      const plan = routeTask(payload, fleet, await readJson(stateFile(dataDir), { drivers: {} }), { to: option(args, '--to', null) });
      print(args.includes('--explain') ? plan : plan.suggestions, out); return 0;
    }
    if (command === 'usage') {
      const fleet = await loadFleet(fleetFile); validateFleet(fleet, fleetFile); const week = option(args, '--week', null);
      print(await usageFromEvents(new TaskStore(dataDir, { now }).eventsFile, fleet, { week: week == null ? null : Number(week), nowMs: now ? Date.parse(now()) : Date.now() }), out); return 0;
    }
    if (command === 'dispatch') {
      const taskFile = positional(args)[0]; if (!taskFile) throw new Error('usage: zh dispatch task.json --to driver [--dry]');
      const payload = JSON.parse(await readFile(taskFile, 'utf8')); const taskId = payload.task_id || payload['task-id'];
      if (!taskId) throw new Error('task JSON requires task_id');
      const fleet = await loadFleet(fleetFile); validateFleet(fleet, fleetFile);
      const requested = option(args, '--to', payload.driver || null); const plan = routeTask(payload, fleet, await readJson(stateFile(dataDir), { drivers: {} }), { to: requested });
      const chosen = plan.suggestions[0]; const driver = findDriver(fleet, chosen.driver); const root = fleet.workspaces_root || payload.workspaces_root;
      const routeReason = !requested && fleet.drivers.length >= 2 ? chosen.reasons.join('；') : null;
      if (args.includes('--dry')) {
        const context = { worktree: root ? worktreePath(root, taskId) : '<worktree>', logFile: '<log>' };
        print({ dry: true, driver: driver.name, route_reasons: routeReason, command: driver.kind === 'manual' ? '任务书已登记待粘贴' : renderLaunch(driver, { payload }, context) }, out);
        return 0;
      }
      const store = new TaskStore(dataDir, { now }); const task = await store.create({ task_id: taskId, payload });
      await store.transition(taskId, 'locked', { driver: driver.name });
      if (routeReason) out(`路由依据: ${routeReason}\n`);
      if (driver.kind === 'manual') { print(await registerManual(driver, task, store), out); return 0; }
      const context = await prepare(task, driver, { workspacesRoot: root, maxWorktrees: fleet.max_worktrees, ...runnerOptions });
      const result = await launch(driver, task, { store, ...context, ...runnerOptions });
      const finalTask = await store.get(taskId); if (finalTask.status === 'failed') await store.event('route.blacklist_suggestion', taskId, { driver: driver.name, reason: finalTask.reason || 'failed' });
      print(result, out); return 0;
    }
    if (command === 'attach') { const taskId = positional(args)[0]; const branch = option(args, '--branch'); if (!taskId || !branch) throw new Error('usage: zh attach task-id --branch ref'); print(await attach(taskId, branch, new TaskStore(dataDir, { now })), out); return 0; }
    if (command === 'tasks') { const tasks = await new TaskStore(dataDir, { now }).list(); print(tasks.map(({ task_id, status, driver, commit }) => ({ task_id, status, driver: driver || null, commit: commit || null })), out); return 0; }
    if (command === 'dispatch-done') { const taskId = positional(args)[0]; if (!taskId) throw new Error('usage: zh dispatch-done task-id [--failed]'); const status = args.includes('--failed') ? 'failed' : 'done'; print(await new TaskStore(dataDir, { now }).transition(taskId, status, { reason: 'manual-verdict' }), out); return 0; }
    if (command === 'recover') { const recovered = await new TaskStore(dataDir, { now }).recover({ staleAfterMs: 30_000 }); print({ recovered }, out); return 0; }
    if (command === 'collect') { const taskId = positional(args)[0]; if (!taskId) throw new Error('usage: zh collect task-id'); print(await collect(taskId, { store: new TaskStore(dataDir, { now }), ...collectorOptions }), out); return 0; }
    if (command === 'prune') { print({ pruned: await prune(new TaskStore(dataDir, { now }), collectorOptions) }, out); return 0; }
    if (command === 'history') { const taskId = positional(args)[0]; if (!taskId) throw new Error('usage: zh history task-id'); print(await history(new TaskStore(dataDir, { now }), taskId), out); return 0; }
    throw new Error('usage: zh <validate|add|list|doctor|status|task-create|route|usage|dispatch|attach|tasks|dispatch-done|collect|prune|history>');
  } catch (error) { err(`FAIL ${error.message}\n`); return error.code === 'IDEMPOTENCY_CONFLICT' ? 3 : error.code === 'ROUTE_EMPTY' ? 4 : 2; }
}

export async function main(argv) { process.exitCode = await run(argv); }
