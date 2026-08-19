export default {
  testDir: '.',
  reporter: [['json', { outputFile: 'results.json' }]],
  use: { headless: true },
};
