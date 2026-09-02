// Optional project configuration so a run does not need long flags. Absent
// config is normal; broken config is not, and is reported rather than
// silently ignored.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_BASELINE = '.flakeproof/baseline.json';

export async function loadConfig(dir = process.cwd()) {
  const path = join(dir, 'flakeproof.config.json');
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`flakeproof.config.json is not valid json: ${err.message}`, { cause: err });
  }
}
