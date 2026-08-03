# Deployment

> **Not yet verified on real infrastructure.** The container definition here is
> written but has not been built or run — Docker was unavailable in the
> environment where it was authored. Expect to iterate on first deploy, and see
> "If the build fails" below for the likely causes.

## Proxmox LXC

1. Create a Debian 12 container: 2 cores, 1 GB RAM, 8 GB disk.
2. Install Docker inside it.
3. Clone this repo and `docker compose up -d`.
4. Set `PUBLIC_BASE_URL` in `docker-compose.yml` to the address panels reach the
   host on, for example `http://192.168.1.20:8080`.

An unprivileged LXC is fine. Chromium runs with `--no-sandbox`, which is
acceptable here because it only ever loads HTML this service generated itself —
it never visits the open web.

**Set `PUBLIC_BASE_URL` explicitly.** Left empty, the server auto-detects its own
address, which inside a container is the bridge network address and usually not
reachable from your LAN. That address gets printed on the enrolment screen, so a
wrong value means a panel telling you to visit somewhere that does not exist.

## TrueNAS

Works equally well as a Docker app. Map a dataset to `/data`.

## Resources

Chromium is the only heavy component and runs for a second or two per *changed*
render. Unchanged renders never launch it — the frame service serves the memo
instead. Idle memory is roughly 150 MB.

## Backups

Everything that matters is `/data/config.json`: device records, locations and
calendar URLs. `/data/cache` is disposable.

## Regenerating golden images

Font rasterisation differs between platforms, so the committed golden was
generated on the author's machine and **will not match** one rendered in this
container. Before wiring CI to the golden test, regenerate it here:

```bash
docker compose run --rm -e UPDATE_GOLDENS=1 inkpanel npm test
```

Then commit the updated `test/fixtures/golden/`.

## If the build fails

- **`Executable doesn't exist at .../chromium`** — the `FROM` tag and the
  `playwright` version in `package.json` have drifted apart. `npm test` has a
  check for exactly this; run it first.
- **`tsx: not found` at startup** — `npm ci --omit=dev` ran while `tsx` was in
  `devDependencies`. It belongs in `dependencies` because the service runs
  TypeScript directly.
- **Chromium crashes or hangs on launch** — `shm_size` is missing. Docker's 64 MB
  default for `/dev/shm` is not enough.
- **`EACCES` writing `/data`** — the Playwright image runs as a non-root user.
  Ensure the volume is writable by it.
