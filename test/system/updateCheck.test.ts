import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRefs, checkForUpdate } from '../../src/system/updateCheck.ts';

test('identical refs are current', () => {
  assert.equal(compareRefs('abc123', 'abc123').state, 'current');
});

test('differing refs mean an update is available', () => {
  assert.equal(compareRefs('abc123', 'def456').state, 'behind');
});

test('a missing ref is unknown, never "current"', () => {
  assert.equal(compareRefs(null, 'def456').state, 'unknown');
  assert.equal(compareRefs('abc123', null).state, 'unknown');
  assert.equal(compareRefs(null, null).state, 'unknown');
});

test('short and long forms of the same commit are current', () => {
  assert.equal(compareRefs('abc1234', 'abc1234def567890').state, 'current',
    'git rev-parse --short and ls-remote return different lengths');
});

// checkForUpdate shells out to git on a cold cache. Several requests landing
// while that is in flight must share the one check rather than each spawning
// their own `git ls-remote`. Calling it twice back-to-back, with no `await`
// in between, lands both calls inside the same cold window; if they were not
// coalesced each would build and return its own freshly-constructed info
// object, so referential equality here is proof of sharing, not coincidence.
test('concurrent calls on a cold cache share one in-flight check', async () => {
  const [a, b] = await Promise.all([checkForUpdate(), checkForUpdate()]);
  assert.equal(a, b, 'both callers must resolve to the exact same info object');
});

// The coalescing test above just warmed the cache. This confirms `force`
// still does its job afterwards — bypassing a warm cache to produce a
// genuinely fresh result — rather than the refactor having quietly made
// every call, forced or not, settle for whatever is cached.
test('force bypasses a warm cache rather than replaying it', async () => {
  const cached = await checkForUpdate();
  const forced = await checkForUpdate(true);
  assert.notEqual(forced, cached, 'force must trigger a real recheck, not hand back the cached object');
  assert.ok(['current', 'behind', 'unknown'].includes(forced.state));
});
