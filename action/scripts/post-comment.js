// Posts (or updates) the flakeproof markdown summary as a pull request
// comment, via the plain GitHub REST API over fetch - no octokit dependency,
// since the project takes no new runtime dependencies. The functions below
// are pure or take an injectable fetch implementation, so the comment logic
// (marker matching, update-vs-create, abstain banner) is unit-testable
// without ever making a real HTTP call.
export const DEFAULT_MARKER = '<!-- flakeproof-gate:report -->';

export function resolvePrNumber(eventPayload) {
  return eventPayload?.pull_request?.number ?? eventPayload?.issue?.number ?? null;
}

// Puts a plain-language callout in front of the report whenever flakeproof
// did not reach a verdict, so a reader scanning only the top of the comment
// still sees that nothing was actually concluded, rather than confusing
// silence with an all-clear.
export function buildAbstainBanner(summary) {
  if (!summary) return '';
  if (summary.blind) {
    return '> **flakeproof abstained.** It ran, but could not determine which tests failed - see the notes below before treating this run as clean.\n\n';
  }
  const abstainVerdicts = ['unclear', 'no-anchor', 'nondeterministic'];
  const abstainCount = Object.entries(summary.verdictCounts ?? {})
    .filter(([verdict]) => abstainVerdicts.includes(verdict))
    .reduce((sum, [, n]) => sum + n, 0);
  if (abstainCount > 0) {
    return `> **flakeproof abstained on ${abstainCount} of ${summary.failures} failed test(s).** A verdict of unclear, no-anchor or nondeterministic means flakeproof did not have enough evidence to call it - that is an honest "do not know", not a clean bill of health.\n\n`;
  }
  return '';
}

export function buildCommentBody({ markdown, summary, artifactUrl, marker = DEFAULT_MARKER }) {
  const banner = buildAbstainBanner(summary);
  const artifactLine = artifactUrl ? `\n\n[Full HTML report](${artifactUrl}) (uploaded as a workflow artifact).\n` : '';
  return `${marker}\n${banner}${markdown}${artifactLine}\n${marker}\n`;
}

export function findExistingComment(comments, marker = DEFAULT_MARKER) {
  return comments.find((c) => typeof c.body === 'string' && c.body.includes(marker));
}

async function listAllComments({ fetchImpl, apiBase, owner, repo, prNumber, token }) {
  const comments = [];
  let page = 1;
  // A pull request accumulating more than a handful of pages of comments
  // from other participants is not the common case; this is a safety cap,
  // not an expected limit.
  const maxPages = 20;
  while (page <= maxPages) {
    const res = await fetchImpl(`${apiBase}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!res.ok) throw new Error(`listing pull request comments failed: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    comments.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return comments;
}

export async function upsertComment({ fetchImpl = globalThis.fetch, apiBase = 'https://api.github.com', owner, repo, prNumber, token, body, marker = DEFAULT_MARKER }) {
  const comments = await listAllComments({ fetchImpl, apiBase, owner, repo, prNumber, token });
  const existing = findExistingComment(comments, marker);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };

  if (existing) {
    const res = await fetchImpl(`${apiBase}/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`updating pull request comment failed: ${res.status} ${await res.text()}`);
    return { action: 'updated', id: existing.id };
  }

  const res = await fetchImpl(`${apiBase}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`creating pull request comment failed: ${res.status} ${await res.text()}`);
  const created = await res.json();
  return { action: 'created', id: created.id };
}

async function main() {
  const token = process.env.INPUT_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('no github token available (github-token input was empty)');

  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) throw new Error(`could not parse owner/repo from GITHUB_REPOSITORY="${repository}"`);

  const { readFile } = await import('node:fs/promises');
  let eventPayload = {};
  if (process.env.GITHUB_EVENT_PATH) {
    try {
      eventPayload = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    } catch (err) {
      console.error(`could not read GITHUB_EVENT_PATH: ${err.message}`);
    }
  }

  const prNumber = resolvePrNumber(eventPayload);
  if (!prNumber) {
    console.log('flakeproof action: not running in a pull request context, skipping the comment step.');
    return;
  }

  const markdown = await readFile(process.env.FLAKEPROOF_SUMMARY_PATH ?? 'flakeproof-summary.md', 'utf8');
  const summary = {
    blind: process.env.FLAKEPROOF_BLIND === 'true',
    failures: Number(process.env.FLAKEPROOF_FAILURES ?? 0),
    verdictCounts: JSON.parse(process.env.FLAKEPROOF_VERDICT_COUNTS ?? '{}'),
  };
  const body = buildCommentBody({ markdown, summary, artifactUrl: process.env.FLAKEPROOF_ARTIFACT_URL || undefined });

  const result = await upsertComment({ owner, repo, prNumber, token, body });
  console.log(`flakeproof action: ${result.action} pull request comment #${result.id}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
