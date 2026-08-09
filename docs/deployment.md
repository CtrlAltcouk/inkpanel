# Deployment

> **LXC installer: verified.** Tested on Proxmox VE 9.1.9 (kernel 6.17.13-2-pve)
> with the Debian 13.6 template and Node v22.23.2. Installed and reached a
> healthy service on the first run.
>
> **Docker image: not verified.** Written but never built — Docker was
> unavailable where it was authored. See "If the build fails" below.

## Proxmox LXC — automatic

Run on the **Proxmox host** as root:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/CtrlAltcouk/inkpanel/main/scripts/proxmox/inkpanel-lxc.sh)"
```

It creates an unprivileged Debian LXC, installs Node and Chromium, clones the
repo, registers a systemd service, and prints the URL. No Docker involved —
running the app natively in the LXC avoids nesting containers.

Defaults are 2 cores, 1 GB RAM, 12 GB disk on the first active storage, DHCP on
`vmbr0`, and the next free CTID. The disk default accounts for the ESP32
firmware toolchain the installer sets up alongside Node and Chromium, so the
[Flash tab](flashing.md) has something to serve without any extra setup.
Override any of them:

```bash
CTID=910 CT_HOSTNAME=inkpanel RAM=2048 STORAGE=local-lvm BRIDGE=vmbr1 \
  bash -c "$(curl -fsSL .../inkpanel-lxc.sh)"
```

**On piping a script into a root shell:** it is worth reading first, and the
same caution applies to every installer of this shape. Download it, read it,
then run it:

```bash
curl -fsSL -o inkpanel-lxc.sh https://raw.githubusercontent.com/CtrlAltcouk/inkpanel/main/scripts/proxmox/inkpanel-lxc.sh
less inkpanel-lxc.sh
bash inkpanel-lxc.sh
```

It is one self-contained file rather than a chain of remote includes, precisely
so that reading it is practical.

### Afterwards

```bash
pct exec <CTID> -- journalctl -u inkpanel -f                # logs
pct exec <CTID> -- systemctl restart inkpanel               # restart
nano /opt/inkpanel/inkpanel.env                             # PUBLIC_BASE_URL
```

To update:

```bash
pct exec <CTID> -- /usr/local/bin/inkpanel-update
```

**The full path matters here** — `pct exec` does not carry `/usr/local/bin` on
`PATH` the way an interactive login shell would, so the bare form
(`pct exec <CTID> -- inkpanel-update`) fails with "No such file or directory"
even when the script is genuinely installed and working. This only affects
running it by hand: the systemd path unit that triggers updates automatically
already invokes it by full path and is unaffected.

The installer places that script in the container. On a fresh install it copies
the privileged helper and systemd units from the pristine, root-owned clone,
then hands the checkout to the `inkpanel` account. A later self-update never
copies executable code from that app-owned checkout into a root-owned path.

Do not run `git pull` as root in `/opt/inkpanel/app` — the repo belongs to the
`inkpanel` service user, so git refuses with *"detected dubious ownership"*, and
a root `npm ci` would leave root-owned `node_modules` behind. The updater runs
Git, npm, and firmware builds as the service user; root is retained only for
systemd control and transaction snapshots.

Containers created before the transactional helper existed need a one-time,
explicit administrator refresh after this release is merged. Do this without
touching the live checkout: resolve one exact official `main` SHA, download both
helper files at that SHA into a root-only directory, inspect those exact local
files, and install the same bytes you inspected:

```bash
pct enter <CTID>
HELPER_DIR="$(mktemp -d /root/inkpanel-helper.XXXXXX)"
chmod 700 "$HELPER_DIR"
HELPER_REF="$(git ls-remote https://github.com/CtrlAltcouk/inkpanel.git refs/heads/main | awk '{print $1}')"
[[ "$HELPER_REF" =~ ^[0-9a-f]{40}$ ]] || { echo "Could not resolve official main" >&2; exit 1; }
curl -fL "https://raw.githubusercontent.com/CtrlAltcouk/inkpanel/$HELPER_REF/scripts/proxmox/files/inkpanel-update" -o "$HELPER_DIR/inkpanel-update"
curl -fL "https://raw.githubusercontent.com/CtrlAltcouk/inkpanel/$HELPER_REF/scripts/proxmox/files/write-status.mjs" -o "$HELPER_DIR/write-status.mjs"
sha256sum "$HELPER_DIR/inkpanel-update" "$HELPER_DIR/write-status.mjs"
less "$HELPER_DIR/inkpanel-update"
less "$HELPER_DIR/write-status.mjs"
install -o root -g root -m 755 "$HELPER_DIR/inkpanel-update" /usr/local/bin/inkpanel-update
install -o root -g root -m 644 "$HELPER_DIR/write-status.mjs" /usr/local/bin/write-status.mjs
rm -f "$HELPER_DIR/inkpanel-update" "$HELPER_DIR/write-status.mjs"
rmdir "$HELPER_DIR"
/usr/local/bin/inkpanel-update
exit
```

The download is pinned before either file is fetched, and installation uses the
same root-owned files that were inspected, avoiding an inspection/install race.
The live `/opt/inkpanel/app` HEAD and worktree remain unchanged until the new
transactional updater captures the true `COMMIT_BEFORE` and performs the pull.
This promotion is deliberately manual: the unprivileged application can ask
for an update, but cannot choose new root-executed code.

## Proxmox LXC — manual, with Docker

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

## Updating from the UI

**This is a Proxmox LXC feature, not a general one.** The Settings tab's Update
button works by creating a flag file that a systemd path unit watches — and
that path unit only exists because `scripts/proxmox/inkpanel-lxc.sh` installed
it. Nothing else in this repo creates it.

On the README's "Anywhere else" install (`git clone` + `npm start`), on the
manual-Docker LXC setup, and on TrueNAS, the server can still see a git
checkout, so the button is enabled — but pressing it only writes
`.update-requested` in the data directory. Nothing is watching for that file,
so it sits there permanently, and after three minutes the UI's own advice to
check `journalctl -u inkpanel` points at a systemd unit that was never
installed on that host. On those installs, update the way you installed:
`git pull --ff-only && npm ci` for a manual clone, or rebuild and redeploy the
image for Docker/TrueNAS.

The rest of this section describes the Proxmox LXC installer's behaviour only.

It works by creating a flag file that a systemd path unit watches; the update
itself runs as root in a separate unit the web application cannot modify. The
app is granted no privilege beyond writing a file in its own data directory.

Before pulling, the updater records the exact current commit and refuses to
continue if tracked files are modified or the current local `/health` endpoint
is not HTTP 200. `PORT` is read as validated numeric data from
`/opt/inkpanel/inkpanel.env` (default 8080); the environment file is never
sourced or executed.

Changed production dependencies are built with `npm ci --omit=dev` in a
same-filesystem staging directory while the current service is still running.
Only after that succeeds does the updater stop the service, snapshot the exact
bytes (or absence) of `config.json`, atomically exchange `node_modules`, and
start the candidate. A firmware build similarly preserves the previously
served `firmware/dist` package before publishing a successful replacement.

An update is successful only after systemd reports the candidate active and
`/health` returns HTTP 200 three consecutive times during the probation window.
If start-up or health validation fails, the updater automatically restores the
exact pre-update commit, dependencies, config bytes/absence, and firmware
package without running npm again. It restarts the old service and applies the
same health probation. The update remains terminally `failed` even when this
rollback succeeds, so the UI reports both the candidate failure and successful
recovery rather than claiming the update was installed.

Manual recovery should therefore be exceptional. If automatic rollback itself
cannot restore health, preserve the status and transaction artifacts and
inspect them from the command line:

```bash
pct exec <CTID> -- journalctl -u inkpanel -n 50 --no-pager
pct exec <CTID> -- cat /opt/inkpanel/data/update-status.json
pct exec <CTID> -- systemctl status inkpanel --no-pager
pct exec <CTID> -- ls -la /var/lib/inkpanel-update
```

The journal records the exact rollback baseline SHA. If intervention is
required, reset only to that recorded SHA after inspecting the retained
snapshots; do not guess with `HEAD~1`, because one pull may contain many commits.

If the updater itself was interrupted mid-run (a reboot, `systemctl stop`, an OOM
kill) rather than failing normally, its own exit trap should have already
written a `failed` status explaining that — but if it was killed in a way no
trap can catch (`SIGKILL`), the status file can be left stuck at `running`,
which makes `POST /api/system/update` return 409 forever with no way to
recover from the UI. Clear it by hand:

```bash
pct exec <CTID> -- rm /opt/inkpanel/data/update-status.json
```
