# Golden images

`dashboard.bin` is the packed 48,000-byte buffer for a fixed `DashboardData`
fixture. `dashboard.png` is the same thing made viewable — it is not used by the
test, only by whoever is looking at a failure.

## Regenerating

```bash
UPDATE_GOLDENS=1 npm test
```

## These are environment-specific

Font rasterisation varies between platforms and Chromium versions, so a golden
generated on Windows will not match one generated in the Linux container.

**The canonical golden is the one generated inside the container image the
project ships**, since that is what actually renders frames in production:

```bash
docker compose run --rm -e UPDATE_GOLDENS=1 inkpanel npm test
```

If this test fails immediately after cloning or after a Playwright upgrade,
check that before hunting for a layout bug. A failure that is only a
rasterisation difference will show thousands of scattered differing bytes;
a real layout regression shows a contiguous region.
