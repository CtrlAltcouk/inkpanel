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

Defaults are 2 cores, 1 GB RAM, 8 GB disk on the first active storage, DHCP on
`vmbr0`, and the next free CTID. Override any of them:

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
pct exec <CTID> -- bash -c 'cd /opt/inkpanel/app && git pull && npm ci --omit=dev && systemctl restart inkpanel'
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
