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

The installer places that script in the container. Do not run `git pull` as root
in `/opt/inkpanel/app` — the repo belongs to the `inkpanel` service user, so git
refuses with *"detected dubious ownership"*, and a root `npm ci` would leave
root-owned `node_modules` behind. The script runs both as the right user.

Containers created before this script existed will not have it. Either re-run
the installer for a fresh container, or update by hand once:

```bash
pct exec <CTID> -- bash -c 'cd /opt/inkpanel/app \
  && runuser -u inkpanel -- git pull --ff-only \
  && runuser -u inkpanel -- npm ci --omit=dev \
  && systemctl restart inkpanel'
```

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

`npm ci` runs only when `package-lock.json` changed, and **a failed update does
not restart the service** — the running process keeps serving and the UI reports
the failure.

**The risk worth knowing:** self-update can break the service, and the UI that
would fix it *is* the service. If an update leaves it unable to start, recover
from the command line:

```bash
pct exec <CTID> -- journalctl -u inkpanel -n 50 --no-pager
pct exec <CTID> -- cat /opt/inkpanel/data/update-status.json
pct exec <CTID> -- bash -c 'cd /opt/inkpanel/app && runuser -u inkpanel -- git reset --hard HEAD~1 && systemctl restart inkpanel'
```

If the updater itself was interrupted mid-run (a reboot, `systemctl stop`, an OOM
kill) rather than failing normally, its own exit trap should have already
written a `failed` status explaining that — but if it was killed in a way no
trap can catch (`SIGKILL`), the status file can be left stuck at `running`,
which makes `POST /api/system/update` return 409 forever with no way to
recover from the UI. Clear it by hand:

```bash
pct exec <CTID> -- rm /opt/inkpanel/data/update-status.json
```
