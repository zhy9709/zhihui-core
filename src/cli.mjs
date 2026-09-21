import { readFile } from 'node:fs/promises';
import { addDriver, collectStatus, doctor, loadFleet, validateFleet } from './fleet.mjs';
import { TaskStore } from './tasks.mjs';

function option(args, name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
function print(value, out) { out(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`); }

export async function run(argv, { out = process.stdout.write.bind(process.stdout), err = process.stderr.write.bind(process.stderr), probe, now } = {}) {
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
    if (command === 'recover') { const recovered = await new TaskStore(dataDir, { now }).recover(); print({ recovered }, out); return 0; }
    throw new Error('usage: zh <validate|add|list|doctor|status|task-create|recover>');
  } catch (error) { err(`FAIL ${error.message}\n`); return error.code === 'IDEMPOTENCY_CONFLICT' ? 3 : 2; }
}

export async function main(argv) { process.exitCode = await run(argv); }
