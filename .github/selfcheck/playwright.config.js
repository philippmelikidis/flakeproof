export default {
  testDir: '.',
  reporter: [['json', { outputFile: 'results.json' }]],
  use: { headless: true },
  // One run, no retries: flakeproof is supposed to explain a red test, not
  // be handed a green one because the runner tried again.
  retries: 0,
};
