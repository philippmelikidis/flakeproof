import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MARKER,
  resolvePrNumber,
  buildAbstainBanner,
  buildCommentBody,
  findExistingComment,
  upsertComment,
} from '../action/scripts/post-comment.js';

test('resolvePrNumber reads pull_request events', () => {
  assert.equal(resolvePrNumber({ pull_request: { number: 42 } }), 42);
});

test('resolvePrNumber reads issue_comment-style events as a fallback', () => {
  assert.equal(resolvePrNumber({ issue: { number: 7 } }), 7);
});

test('resolvePrNumber is null for a plain push event', () => {
  assert.equal(resolvePrNumber({ ref: 'refs/heads/main' }), null);
  assert.equal(resolvePrNumber({}), null);
});

test('no abstain banner for a clean run', () => {
  assert.equal(buildAbstainBanner({ blind: false, failures: 1, verdictCounts: { fragile: 1 } }), '');
  assert.equal(buildAbstainBanner(null), '');
});

test('abstain banner names the count when flakeproof could not tell which tests failed', () => {
  const banner = buildAbstainBanner({ blind: true });
  assert.match(banner, /flakeproof abstained/);
});

test('abstain banner names the count when a verdict itself is inconclusive', () => {
  const banner = buildAbstainBanner({ blind: false, failures: 3, verdictCounts: { fragile: 1, unclear: 1, 'no-anchor': 1 } });
  assert.match(banner, /abstained on 2 of 3/);
});

test('comment body carries the marker at both ends so a later run can find and replace it', () => {
  const body = buildCommentBody({ markdown: '# flakeproof run\n', summary: { blind: false, failures: 0, verdictCounts: {} } });
  const marks = body.split(DEFAULT_MARKER).length - 1;
  assert.equal(marks, 2);
});

test('comment body links the artifact when a url is given, and omits the line otherwise', () => {
  const withArtifact = buildCommentBody({ markdown: 'x', summary: null, artifactUrl: 'https://example.test/artifact' });
  assert.match(withArtifact, /\[Full HTML report\]\(https:\/\/example\.test\/artifact\)/);
  const without = buildCommentBody({ markdown: 'x', summary: null });
  assert.doesNotMatch(without, /Full HTML report/);
});

test('findExistingComment matches only comments carrying the marker', () => {
  const comments = [{ id: 1, body: 'unrelated comment' }, { id: 2, body: `${DEFAULT_MARKER}\nold report\n${DEFAULT_MARKER}` }];
  assert.equal(findExistingComment(comments)?.id, 2);
  assert.equal(findExistingComment([{ id: 3, body: 'no marker here' }]), undefined);
});

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET' });
    const key = `${opts.method ?? 'GET'} ${new URL(url).pathname}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected request: ${key}`);
    return route;
  };
  impl.calls = calls;
  return impl;
}

test('upsertComment creates a new comment when no marked comment exists yet', async () => {
  const fetchImpl = fakeFetch({
    'GET /repos/o/r/issues/5/comments': { ok: true, json: async () => [{ id: 1, body: 'hello' }] },
    'POST /repos/o/r/issues/5/comments': { ok: true, json: async () => ({ id: 99 }) },
  });
  const result = await upsertComment({ fetchImpl, owner: 'o', repo: 'r', prNumber: 5, token: 't', body: 'report body' });
  assert.deepEqual(result, { action: 'created', id: 99 });
  assert.ok(fetchImpl.calls.some((c) => c.method === 'POST'));
});

test('upsertComment updates the existing marked comment instead of creating a second one', async () => {
  const marked = `${DEFAULT_MARKER}\nold\n${DEFAULT_MARKER}`;
  const fetchImpl = fakeFetch({
    'GET /repos/o/r/issues/5/comments': { ok: true, json: async () => [{ id: 1, body: marked }] },
    'PATCH /repos/o/r/issues/comments/1': { ok: true, json: async () => ({ id: 1 }) },
  });
  const result = await upsertComment({ fetchImpl, owner: 'o', repo: 'r', prNumber: 5, token: 't', body: 'new report body' });
  assert.deepEqual(result, { action: 'updated', id: 1 });
  assert.ok(!fetchImpl.calls.some((c) => c.method === 'POST'));
});

test('upsertComment surfaces the GitHub API error instead of swallowing it', async () => {
  const fetchImpl = fakeFetch({
    'GET /repos/o/r/issues/5/comments': { ok: false, status: 403, text: async () => 'nope' },
  });
  await assert.rejects(
    () => upsertComment({ fetchImpl, owner: 'o', repo: 'r', prNumber: 5, token: 't', body: 'x' }),
    /listing pull request comments failed: 403/,
  );
});

test('upsertComment paginates through more than one page of comments looking for the marker', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, body: 'noise' }));
  const marked = `${DEFAULT_MARKER}\nold\n${DEFAULT_MARKER}`;
  // Pagination needs the same path/method to return different bodies on
  // page 1 vs page 2, which fakeFetch's static route table cannot express,
  // so this one drives it directly by query string instead.
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const page = u.searchParams.get('page');
    if (page === '1') return { ok: true, json: async () => page1 };
    if (page === '2') return { ok: true, json: async () => [{ id: 200, body: marked }] };
    throw new Error(`unexpected page ${page}`);
  };
  const result = await upsertComment({
    fetchImpl: async (url, opts = {}) => {
      if ((opts.method ?? 'GET') === 'PATCH') return { ok: true, json: async () => ({ id: 200 }) };
      return impl(url);
    },
    owner: 'o',
    repo: 'r',
    prNumber: 5,
    token: 't',
    body: 'x',
  });
  assert.deepEqual(result, { action: 'updated', id: 200 });
  assert.ok(calls.length >= 2);
});
