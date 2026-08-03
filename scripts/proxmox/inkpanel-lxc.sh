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
#   CTID=910 CT_HOSTNAME=inkpanel CORES=2 RAM=1024 DISK=8
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
DISK="${DISK:-8}"
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
TEMPLATE_NAME="$(pveam available --section system \
  | awk '{print $2}' \
  | grep -E '^debian-1[0-9]+-standard' \
  | sort -V | tail -1)"
[[ -n "$TEMPLATE_NAME" ]] || die "no Debian standard template found in pveam"

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
run() { pct exec "$CTID" -- env LC_ALL=C.UTF-8 LANG=C.UTF-8 bash -c "$1"; }

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
run "cat > ${APP_DIR}/inkpanel.env <<ENVFILE
# Address panels use to reach this server. Shown on the enrolment screen.
PUBLIC_BASE_URL=http://${CT_IP}:${APP_PORT}
ENVFILE
chown ${APP}:${APP} ${APP_DIR}/inkpanel.env"

run "systemctl daemon-reload && systemctl enable --now ${APP}.service >/dev/null 2>&1"

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
  printf '  %s\n' "Update:    pct exec ${CTID} -- bash -c 'cd ${APP_DIR}/app && git pull && npm ci --omit=dev && systemctl restart ${APP}'"
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
