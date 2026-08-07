#!/usr/bin/env bash
#
# inkpanel — Proxmox VE LXC installer
#
# Creates an unprivileged Debian LXC, installs inkpanel natively (no Docker),
# and registers it as a systemd service.
#
# Run on the PROXMOX HOST as root:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/CtrlAltcouk/inkpanel/main/scripts/proxmox/inkpanel-lxc.sh)"
#
# This script runs as root and creates containers. Read it before running it —
# that advice applies to every installer of this shape, including this one.
#
# Overrides, all optional:
#   CTID=910 CT_HOSTNAME=inkpanel CORES=2 RAM=1024 DISK=12
#   BRIDGE=vmbr0 STORAGE=local-lvm TEMPLATE_STORAGE=local
#   REPO_URL=https://github.com/CtrlAltcouk/inkpanel.git BRANCH=main
#   UNPRIVILEGED=1 START_ON_BOOT=1
#
set -Eeuo pipefail

readonly APP="inkpanel"
readonly APP_PORT=8080
readonly NODE_MAJOR=22
readonly APP_DIR="/opt/${APP}"

# ---------------------------------------------------------------- presentation

if [[ -t 1 ]]; then
  readonly C_RESET=$'\033[0m' C_DIM=$'\033[2m' C_PINK=$'\033[38;5;217m'
  readonly C_RED=$'\033[31m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m'
else
  readonly C_RESET='' C_DIM='' C_PINK='' C_RED='' C_GREEN='' C_YELLOW=''
fi

info()  { printf '%s\n' "${C_PINK}==>${C_RESET} $*"; }
step()  { printf '%s\n' "  ${C_DIM}-${C_RESET} $*"; }
warn()  { printf '%s\n' "${C_YELLOW}warning:${C_RESET} $*" >&2; }
ok()    { printf '%s\n' "${C_GREEN}✓${C_RESET} $*"; }
die()   { printf '%s\n' "${C_RED}error:${C_RESET} $*" >&2; exit 1; }

on_error() {
  local line=$1
  printf '\n%s\n' "${C_RED}Failed at line ${line}.${C_RESET}" >&2
  if [[ -n "${CREATED_CTID:-}" ]]; then
    warn "container ${CREATED_CTID} was created but setup did not finish."
    warn "inspect it with:  pct enter ${CREATED_CTID}"
    warn "or remove it with: pct stop ${CREATED_CTID} && pct destroy ${CREATED_CTID}"
  fi
}
trap 'on_error $LINENO' ERR

# ------------------------------------------------------------------- preflight

[[ $EUID -eq 0 ]] || die "must run as root on the Proxmox host"
command -v pct >/dev/null 2>&1 || die "pct not found — this must run on a Proxmox VE host"
command -v pvesm >/dev/null 2>&1 || die "pvesm not found — this must run on a Proxmox VE host"

info "inkpanel LXC installer"
step "Proxmox: $(pveversion | head -1)"

# ------------------------------------------------------------------- settings

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
CT_HOSTNAME="${CT_HOSTNAME:-inkpanel}"
CORES="${CORES:-2}"
RAM="${RAM:-1024}"
DISK="${DISK:-12}"
BRIDGE="${BRIDGE:-vmbr0}"
UNPRIVILEGED="${UNPRIVILEGED:-1}"
START_ON_BOOT="${START_ON_BOOT:-1}"
REPO_URL="${REPO_URL:-https://github.com/CtrlAltcouk/inkpanel.git}"
BRANCH="${BRANCH:-main}"

if pct status "$CTID" >/dev/null 2>&1; then
  die "container $CTID already exists — set CTID to something free"
fi

# Pick a storage that can hold container rootfs, unless told otherwise.
pick_storage() {
  local content=$1
  pvesm status -content "$content" 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}'
}

STORAGE="${STORAGE:-$(pick_storage rootdir)}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-$(pick_storage vztmpl)}"

[[ -n "$STORAGE" ]] || die "no active storage for container rootfs — set STORAGE=..."
[[ -n "$TEMPLATE_STORAGE" ]] || die "no active storage for templates — set TEMPLATE_STORAGE=..."

step "CTID ${CTID}, hostname ${CT_HOSTNAME}"
step "${CORES} cores, ${RAM} MB RAM, ${DISK} GB disk on ${STORAGE}"
step "network: ${BRIDGE}, DHCP"

# -------------------------------------------------------------------- template

info "Preparing Debian template"
pveam update >/dev/null 2>&1 || warn "pveam update failed; using cached template list"

# Prefer the newest Debian standard template available.
# Debian's own mirror publishes both amd64 and arm64 builds under names that
# differ only in that suffix (debian-13-standard_13.6-1_arm64.tar.zst vs.
# ..._amd64.tar.zst). An unfiltered `sort -V | tail -1` compares the whole
# filename, and "arm64" can sort after "amd64" — which downloads a template
# LXC cannot boot on this host at all: the container creates successfully and
# then fails at `pct start` with no clearer signal than that. Filtering to
# the host's own dpkg architecture is what pct create itself requires anyway.
HOST_ARCH="$(dpkg --print-architecture)"
TEMPLATE_NAME="$(pveam available --section system \
  | awk '{print $2}' \
  | grep -E "^debian-1[0-9]+-standard_[^_]+_${HOST_ARCH}\.tar\.(gz|zst)\$" \
  | sort -V | tail -1)"
[[ -n "$TEMPLATE_NAME" ]] || die "no Debian standard template for ${HOST_ARCH} found in pveam"

if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE_NAME"; then
  step "downloading ${TEMPLATE_NAME}"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE_NAME" >/dev/null
else
  step "using cached ${TEMPLATE_NAME}"
fi

TEMPLATE_REF="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE_NAME}"

# ------------------------------------------------------------------- container

info "Creating container ${CTID}"
pct create "$CTID" "$TEMPLATE_REF" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CORES" \
  --memory "$RAM" \
  --swap 512 \
  --rootfs "${STORAGE}:${DISK}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
  --unprivileged "$UNPRIVILEGED" \
  --onboot "$START_ON_BOOT" \
  --features nesting=1 \
  --description "inkpanel — e-paper dashboard server" \
  >/dev/null

CREATED_CTID="$CTID"

step "starting"
pct start "$CTID" >/dev/null

# Wait for the container to get a working network before touching apt.
step "waiting for network"
for _ in $(seq 1 30); do
  if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then break; fi
  sleep 2
done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 \
  || die "container has no DNS/network — check bridge ${BRIDGE} and DHCP"

ok "container running"

# --------------------------------------------------------------------- install

# pct exec inherits LANG from the Proxmox host, but a fresh Debian template has
# no generated locales, so perl and apt-listchanges emit a wall of warnings.
# C.UTF-8 always exists and needs no locale-gen.
#
# PATH is set explicitly for the same class of reason: pct exec's bash -c does
# not carry the full PATH an interactive login shell would. Node/npm/git/curl
# all install into /usr/bin via apt, which is on it regardless, so this went
# unnoticed until arduino-cli, which installs into /usr/local/bin. The real
# failure was confusing — the arduino-cli install itself succeeded, but its
# own internal `command -v` check (and this script's, right after it) both
# reported "not found" for a binary that was genuinely sitting on disk,
# because neither lookup ever had /usr/local/bin to search. This is the
# standard Debian secure_path, not a guess at what might be missing.
run() { pct exec "$CTID" -- env LC_ALL=C.UTF-8 LANG=C.UTF-8 PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" bash -c "$1"; }

info "Installing dependencies"
step "base packages"
run "export DEBIAN_FRONTEND=noninteractive
     apt-get update -qq
     apt-get install -y -qq curl ca-certificates git gnupg >/dev/null"

step "Node.js ${NODE_MAJOR}"
run "export DEBIAN_FRONTEND=noninteractive
     curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - >/dev/null 2>&1
     apt-get install -y -qq nodejs >/dev/null"
step "node $(run 'node --version' | tr -d '\r')"

info "Installing ${APP}"
step "creating service user"
run "id -u ${APP} >/dev/null 2>&1 || useradd --system --create-home --home-dir ${APP_DIR} --shell /usr/sbin/nologin ${APP}"

step "cloning ${REPO_URL} (${BRANCH})"
run "rm -rf ${APP_DIR}/app
     git clone --depth 1 --branch ${BRANCH} ${REPO_URL} ${APP_DIR}/app >/dev/null 2>&1
     chown -R ${APP}:${APP} ${APP_DIR}"

step "npm dependencies"
run "cd ${APP_DIR}/app && runuser -u ${APP} -- npm ci --omit=dev --silent >/dev/null 2>&1"

# Chromium's shared libraries must go in as root; the browser itself belongs to
# the service user, so PLAYWRIGHT_BROWSERS_PATH points inside its home.
step "Chromium system libraries"
run "cd ${APP_DIR}/app && npx --yes playwright install-deps chromium >/dev/null 2>&1"

step "Chromium browser (this takes a minute)"
run "cd ${APP_DIR}/app && runuser -u ${APP} -- env PLAYWRIGHT_BROWSERS_PATH=${APP_DIR}/.cache/ms-playwright npx playwright install chromium >/dev/null 2>&1"

# ------------------------------------------------------------ firmware toolchain

# So the Flash tab has something to serve from a fresh install, not just after
# the first update. The ESP32 core and its Xtensa toolchain land in the app
# user's home (arduino-cli follows $HOME), same as Playwright's browser above.
#
# arduino-cli itself and the ESP32 core are treated as toolchain infrastructure
# — fatal if they fail to install, same as Node or Chromium above. Actually
# compiling this project's firmware with them is application-level and must
# not be: see the non-fatal wrapping on the build step below and the matching
# comment in scripts/proxmox/files/inkpanel-update.
info "Installing firmware toolchain"

# Checked from inside the container, after Node/Chromium already used some of
# it, so this reflects what is actually left. ~1.5-2.5 GB is the core plus its
# toolchain; 3 GB leaves headroom rather than cutting it fine.
step "checking disk space"
MIN_FREE_MB=3072
AVAIL_MB="$(run "df --output=avail -m / | tail -1" | tr -d '[:space:]')"
if [[ -z "$AVAIL_MB" ]] || (( AVAIL_MB < MIN_FREE_MB )); then
  die "only ${AVAIL_MB:-0} MB free in container ${CTID}, need at least ${MIN_FREE_MB} MB for the ESP32 firmware toolchain — resize first: pct resize ${CTID} rootfs +6G"
fi
step "${AVAIL_MB} MB free"

step "arduino-cli"
# Deliberately NOT redirected to /dev/null like most steps above: this is the
# one install step that talks to an external host other than the Debian/Node
# mirrors already proven reachable, so a network hiccup here is real and not
# hypothetical — the first live run of this script hit exactly that, and with
# output suppressed the failure surfaced two steps later as a bare "arduino-cli:
# command not found", with nothing to say why. Letting the install script's own
# progress output show means a real failure is visible at the point it happens.
run "curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR=/usr/local/bin sh"
# A second, explicit check: the install script can exit 0 having installed
# nothing, if curl returned an empty or truncated body that "sh" then executed
# as a no-op script. That failure mode produces no error of its own — only this
# check catches it.
run "command -v arduino-cli >/dev/null" \
  || die "arduino-cli did not end up on the PATH after installing — check the container has network access to downloads.arduino.cc, then retry (pct stop ${CTID} && pct destroy ${CTID}, then re-run this installer)"
step "arduino-cli $(run 'arduino-cli version' | tr -d '\r')"

step "ESP32 board core (this takes a minute)"
run "runuser -u ${APP} -- arduino-cli config init --additional-urls https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json --overwrite >/dev/null 2>&1
     runuser -u ${APP} -- arduino-cli core update-index >/dev/null 2>&1
     runuser -u ${APP} -- arduino-cli core install esp32:esp32 >/dev/null 2>&1"

# Non-fatal, deliberately: unlike the toolchain install above, a failure here
# means only that the Flash tab starts out with nothing to serve — the server
# itself is unaffected and there is nothing to roll back. The next update that
# touches firmware/ will try again (see inkpanel-update).
step "initial firmware build"
run "cd ${APP_DIR}/app && runuser -u ${APP} -- ./scripts/build-firmware.sh >/dev/null 2>&1" \
  || warn "firmware build failed — the Flash tab will report no build available until the next successful build"

# ---------------------------------------------------------------------- service

info "Configuring service"

CT_IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}' | tr -d '\r')"
[[ -n "$CT_IP" ]] || die "could not determine container IP"

run "mkdir -p ${APP_DIR}/data && chown ${APP}:${APP} ${APP_DIR}/data
cat > /etc/systemd/system/${APP}.service <<'UNIT'
[Unit]
Description=inkpanel e-paper dashboard server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP}
WorkingDirectory=${APP_DIR}/app
Environment=NODE_ENV=production
Environment=PORT=${APP_PORT}
Environment=DATA_DIR=${APP_DIR}/data
Environment=PLAYWRIGHT_BROWSERS_PATH=${APP_DIR}/.cache/ms-playwright
EnvironmentFile=-${APP_DIR}/inkpanel.env
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=on-failure
RestartSec=10

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT"

# PUBLIC_BASE_URL is printed on the panel's enrolment screen, so it must be an
# address the panel can actually reach — not the container's own idea of itself.
run "cat > ${APP_DIR}/${APP}.env <<ENVFILE
# Address panels use to reach this server. Shown on the enrolment screen.
PUBLIC_BASE_URL=http://${CT_IP}:${APP_PORT}

# Uncomment to require a password for the web UI. The panel's own endpoint stays
# open regardless, because firmware cannot log in.
#
# NOTE: this is plain HTTP. The password crosses your LAN in clear text. It
# guards against casual access, not against anyone capturing packets.
#INKPANEL_PASSWORD=change-me
ENVFILE
chown ${APP}:${APP} ${APP_DIR}/${APP}.env"

run "systemctl daemon-reload && systemctl enable --now ${APP}.service >/dev/null 2>&1"

# The update script and units are copied from the repo the container just
# cloned, so they stay in step with the application rather than being
# duplicated inside this installer.
#
# write-status.mjs must land beside the updater: the script resolves it via
# ${BASH_SOURCE[0]}, so a missing or misplaced copy breaks every update at
# runtime with nothing but an ENOENT in the journal.
step "installing update units"
run "install -o root -g root -m 755 ${APP_DIR}/app/scripts/proxmox/files/inkpanel-update /usr/local/bin/inkpanel-update
     install -o root -g root -m 644 ${APP_DIR}/app/scripts/proxmox/files/write-status.mjs /usr/local/bin/write-status.mjs
     chown root:root /usr/local/bin/inkpanel-update /usr/local/bin/write-status.mjs
     chmod 755 /usr/local/bin/inkpanel-update
     install -o root -g root -m 644 ${APP_DIR}/app/scripts/proxmox/files/inkpanel-update.path /etc/systemd/system/inkpanel-update.path
     install -o root -g root -m 644 ${APP_DIR}/app/scripts/proxmox/files/inkpanel-update.service /etc/systemd/system/inkpanel-update.service
     systemctl daemon-reload
     systemctl enable --now inkpanel-update.path >/dev/null 2>&1"

step "waiting for service"
HEALTHY=0
for _ in $(seq 1 30); do
  if run "curl -fsS http://127.0.0.1:${APP_PORT}/health >/dev/null 2>&1"; then HEALTHY=1; break; fi
  sleep 2
done

# ----------------------------------------------------------------------- report

printf '\n'
if [[ $HEALTHY -eq 1 ]]; then
  ok "inkpanel is running"
  printf '\n'
  printf '  %s\n' "Open:      ${C_PINK}http://${CT_IP}:${APP_PORT}${C_RESET}"
  printf '  %s\n' "Container: ${CTID} (${CT_HOSTNAME})"
  printf '  %s\n' "Logs:      pct exec ${CTID} -- journalctl -u ${APP} -f"
  printf '  %s\n' "Update:    pct exec ${CTID} -- ${APP}-update"
  printf '  %s\n' "Password:  edit ${APP_DIR}/${APP}.env, then: pct exec ${CTID} -- systemctl restart ${APP}"
  printf '\n'
  printf '  %s\n' "${C_DIM}Flash a panel and it will appear in the UI with setup"
  printf '  %s\n' "instructions shown on the panel itself.${C_RESET}"
  printf '\n'
  warn "there is no authentication — do not expose this to the internet"
else
  warn "container built but the service did not become healthy"
  printf '  %s\n' "Check: pct exec ${CTID} -- journalctl -u ${APP} -n 50 --no-pager"
  exit 1
fi
