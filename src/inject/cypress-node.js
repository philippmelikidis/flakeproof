// Node-side half of the Cypress temporal hook: registers the `cy.task()`
// handler that src/inject/cypress.js's browser-side `installTemporal` calls
// into, since a support-file callback running inside the AUT's window has no
// other way to reach the filesystem. Call `registerTemporalTask(on)` from
// `setupNodeEvents` in cypress.config.js - see src/inject/cypress.js's header
// comment for the full two-file setup.
//
// Kept in its own file (rather than alongside `installTemporal`) because
// this one imports Node builtins through src/inject/shared/ack.js; Cypress
// bundles the support file for the BROWSER, and pulling those imports into
// that bundle breaks it (see src/inject/cypress.js's header comment for the
// exact error this produced).
import { writeTemporalAck } from './shared/ack.js';
import { TEMPORAL_ACK_TASK } from './cypress.js';

export function registerTemporalTask(on) {
  on('task', {
    async [TEMPORAL_ACK_TASK](payload) {
      await writeTemporalAck(process.env.FLAKEPROOF_TEMPORAL_ACK, payload);
      // cy.task() rejects a handler that resolves to `undefined`.
      return null;
    },
  });
}
