# Publishing checklist

flakeproof is **not published to npm**. `package.json` still has `"private": true`,
which is deliberate: publishing is an irreversible, outward-facing decision for the
repository owner to make, not something a change like this one should do on its own.
This file is the checklist for whenever that decision is made. Everything on it was
verified locally without publishing anything.

## Already done (this repository is publish-ready, minus the actual publish)

- [x] Real version: `"version": "0.1.0"` (was `"0.0.0"`).
- [x] `"license": "MIT"` in `package.json`, plus a `LICENSE` file at the repository root.
      MIT was picked as the common permissive default for a CLI tool like this one;
      confirm it is actually the license you want before publishing; changing it later
      is possible but a version that already shipped under MIT stays MIT.
- [x] `"files"` allowlist: `["bin", "src", "README.md", "LICENSE"]`. Verified with
      `npm pack --dry-run` (see below) - `test/`, `docs/`, `examples/`, `spikes/`,
      `action/`, `action.yml` and `.github/` are all excluded from the tarball.
- [x] `"repository"`, `"bugs"` and `"homepage"` fields, pointing at
      `github.com/philippmelikidis/flakeproof`.
- [x] `bin/flakeproof.js` has a `#!/usr/bin/env node` shebang and is executable
      (`-rwxr-xr-x`, verified with `ls -la bin/flakeproof.js`).
- [x] Name availability: `npm view flakeproof` returns `404 Not Found` (registry has
      never seen this name), so `flakeproof` is available. If that changes by the time
      you publish, checked-off alternatives to consider: `flakeproof-cli`,
      `@philippmelikidis/flakeproof`, `flakeproof-e2e`.

## `npm pack --dry-run` result (reproduce with the same command)

34 files, 77.8 kB packed / 244.6 kB unpacked:

```
LICENSE
README.md
bin/flakeproof.js
package.json
src/adapters/robot.js
src/blindspots/ack.js
src/blindspots/measure.js
src/blindspots/report.js
src/config.js
src/inject/playwright.js
src/probe/catalogs/cosmetic.js
src/probe/catalogs/proving.js
src/probe/catalogs/semantic.js
src/probe/mutation-script.js
src/probe/serialize.js
src/probe/snippet.js
src/probe/temporal.js
src/report-html.js
src/report-summary.js
src/report.js
src/runner/index.js
src/runner/read-playwright.js
src/runner/run-tests.js
src/snapshot.js
src/triage/anchor.js
src/triage/candidates.js
src/triage/classify.js
src/triage/engine.js
src/triage/match.js
src/triage/prove.js
src/triage/rerun.js
src/triage/temporal-probe.js
src/triage/temporal-target.js
src/triage/tree.js
```

`npm view flakeproof` output at the time this was written:

```
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/flakeproof - Not found
```

## What is left, and is the owner's call

1. **Decide to publish.** Nothing above commits you to it; it only means the metadata
   is ready when you do.
2. **Confirm the license choice.** MIT was chosen as a placeholder default; change
   `"license"` and `LICENSE` first if you want something else (Apache-2.0, ISC, a
   proprietary license, etc.).
3. **Remove `"private": true`** from `package.json`. This is the one field this
   change deliberately left in place so a stray `npm publish` could not slip through.
4. **Decide the npm account/org** that will own the package (`npm whoami`, or set up
   an org first if you want scoped ownership or multiple maintainers with publish
   rights).
5. **Bump the version if `0.1.0` is not what you want as the first published
   version** - `0.1.0` was chosen here simply as "a real, non-`0.0.0` semver version
   that signals a working CLI", not as a claim about API stability.
6. **Dry-run again right before publishing** (`npm pack --dry-run`) in case anything
   changed since this checklist was written, then `npm publish`.
7. **Tag the release in git** (`git tag vX.Y.Z && git push --tags`) so the published
   version and the source it came from stay traceable.
8. **Update the GitHub Action reference** in the README's usage example
   (`uses: philippmelikidis/flakeproof@main`) to a pinned release tag once one exists,
   the same way any other third-party action should be pinned.
9. **Only after that**, update the README's "Installation" section to show
   `npx flakeproof ...` again - not before, or the docs go back to promising
   something that does not exist yet, which is the exact problem this change fixed.

None of steps 1-9 were performed as part of this change. `npm publish` was not run,
repository visibility was not touched, and `"private": true` was left in place.
