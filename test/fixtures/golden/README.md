# Golden images

`dashboard.bin` is the packed 48,000-byte buffer for a fixed `DashboardData`
fixture. `dashboard.png` is the same thing made viewable — it is not used by the
test, only by whoever is looking at a failure.

**Neither is committed**, and the golden test **skips** when they are absent.
That is deliberate, not an oversight — see below.

## Generating one

```bash
UPDATE_GOLDENS=1 npm test
```

Both files land here and are gitignored, so a golden is local to whoever made
it.

## Why they are not committed

Font rasterisation varies between platforms and Chromium versions. A golden
generated on Windows does not match one generated on Linux — not by a few
pixels, but by thousands of scattered bytes. Committing one means everybody
except its author sees a permanent red failure, and a test that always fails is
a test everyone learns to ignore.

So the golden is opt-in per environment. Generate one where you actually work
and the test starts protecting you; do nothing and it stays skipped.

**If you want it in CI**, the canonical environment is the Linux runner. Trigger
the `Generate golden reference` workflow manually, download the `golden-linux`
artifact, drop it here, and force-add it:

```bash
git add -f test/fixtures/golden/dashboard.bin test/fixtures/golden/dashboard.png
```

For the shipped container specifically:

```bash
docker compose run --rm -e UPDATE_GOLDENS=1 inkpanel npm test
```

If this test fails immediately after cloning or after a Playwright upgrade,
check that before hunting for a layout bug. A failure that is only a
rasterisation difference will show thousands of scattered differing bytes;
a real layout regression shows a contiguous region.
