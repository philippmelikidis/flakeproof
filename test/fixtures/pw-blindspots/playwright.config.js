// outputFile is anchored to this config file's own directory rather than
// left relative, so the json reporter always lands in the same place
// regardless of the invoking process's cwd - measureBlindspots needs to
// know exactly where to read it back from.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default {
  testDir: '.',
  reporter: [['json', { outputFile: join(here, 'results.json') }]],
  workers: 1,
  use: { headless: true },
};
