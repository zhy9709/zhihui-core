import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

export async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`cannot read JSON ${file}: ${error.message}`);
  }
}

export async function atomicWriteFile(file, content) {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, file);
  } catch (error) {
    throw new Error(`atomic write failed for ${file}: ${error.message}`);
  }
}

export async function atomicWriteJson(file, value) {
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

// The file remains an NDJSON stream while each update is published atomically.
export async function appendEvent(file, event) {
  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await atomicWriteFile(file, `${existing}${JSON.stringify(event)}\n`);
}

export function stateFile(dataDir) {
  return join(dataDir, 'state.json');
}
