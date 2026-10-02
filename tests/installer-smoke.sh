#!/bin/bash
# Smoke test for install.sh (macOS / Linux): runs the real installer unattended against the fake Odoo,
# inside an isolated HOME, and checks what it produced. Nothing on the machine is touched.
#
#   bash tests/installer-smoke.sh                 (uses the node already on PATH)
#   bash tests/installer-smoke.sh --download-node (hides node from PATH so the installer downloads its own)
#   bash tests/installer-smoke.sh --site https://odoo-app.netlify.app
#       (runs the installer exactly as a teammate does: fetched from the live site with curl, downloading from its default address)
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)
DOWNLOAD_NODE=no
SITE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --download-node) DOWNLOAD_NODE=yes ;;
    --site) SITE="${2%/}"; shift ;;
  esac
  shift
done
MOCK_PORT=47311
REPO_PORT=47312
TESTHOME=$(mktemp -d 2>/dev/null || mktemp -d -t odooapp)
export HOME="$TESTHOME"
export XDG_CONFIG_HOME="$TESTHOME/.config"
mkdir -p "$HOME"

cleanup() {
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null
  [ -n "${REPO_PID:-}" ] && kill "$REPO_PID" 2>/dev/null
  rm -rf "$TESTHOME"
}
trap cleanup EXIT

SYSTEM_NODE=$(command -v node)
MOCK_PORT=$MOCK_PORT MOCK_DBS=smoke-db "$SYSTEM_NODE" tests/mock-odoo.mjs > "$TESTHOME/mock.log" & MOCK_PID=$!
PORT=$REPO_PORT "$SYSTEM_NODE" tests/serve-repo.mjs > "$TESTHOME/repo.log" & REPO_PID=$!
sleep 2

export ODOO_CLAUDE_HOME="$TESTHOME/.odoo-claude"
if [ -n "$SITE" ]; then unset ODOO_CLAUDE_BASE_URL; else export ODOO_CLAUDE_BASE_URL="http://127.0.0.1:$REPO_PORT"; fi
export ODOO_CLAUDE_NO_LAUNCH=1
export ODOO_URL="http://127.0.0.1:$MOCK_PORT"
export ODOO_LOGIN="admin@example.com"
export ODOO_PASSWORD="secret"
export ODOO_DB=""
if [ "$DOWNLOAD_NODE" = "yes" ]; then
  NEWPATH=""
  IFS=: read -r -a parts <<< "$PATH"
  for p in "${parts[@]}"; do [ -x "$p/node" ] || NEWPATH="${NEWPATH:+$NEWPATH:}$p"; done
  export PATH="$NEWPATH"
  if command -v node >/dev/null 2>&1; then echo "could not hide node from PATH"; exit 1; fi
fi

# run_installer [args]: the local file, or the live one fetched the way the guide's command does it
run_installer() {
  # ${1+"$@"}: plain "$@" is an error under "set -u" in the bash 3.2 that ships with macOS when there are no arguments
  if [ -n "$SITE" ]; then /bin/bash -c "$(curl -fsSL "$SITE/install.sh")" -- ${1+"$@"}; else bash "$ROOT/install.sh" ${1+"$@"}; fi
}

echo "=== running install.sh unattended (download-node=$DOWNLOAD_NODE, site=${SITE:-local}) ==="
run_installer
RC=$?
[ "$RC" = "0" ] || { echo "install.sh exited with $RC"; exit 1; }

echo "=== checking results ==="
case "$(uname -s)" in
  Darwin) DESKTOP_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
  *) DESKTOP_CFG="$XDG_CONFIG_HOME/Claude/claude_desktop_config.json" ;;
esac
[ -f "$ODOO_CLAUDE_HOME/config.json" ] || { echo "config.json missing"; exit 1; }
if [ "$(uname -s)" = "Darwin" ]; then PERMS=$(stat -f '%Lp' "$ODOO_CLAUDE_HOME/config.json"); else PERMS=$(stat -c '%a' "$ODOO_CLAUDE_HOME/config.json"); fi
[ "$PERMS" = "600" ] || { echo "config.json permissions are $PERMS, expected 600"; exit 1; }
echo "  config.json ok (mode $PERMS)"
[ -f "$DESKTOP_CFG" ] || { echo "claude_desktop_config.json missing at $DESKTOP_CFG"; exit 1; }
CMD=$("$SYSTEM_NODE" -e "const c=require(process.argv[1]).mcpServers.odoo; if(!c) process.exit(1); console.log(c.command+'\n'+c.args[0]+'\n'+c.env.ODOO_CONFIG_FILE)" "$DESKTOP_CFG") || { echo "no odoo entry in $DESKTOP_CFG"; exit 1; }
NODE_CMD=$(printf '%s\n' "$CMD" | sed -n 1p); SERVER_ARG=$(printf '%s\n' "$CMD" | sed -n 2p); CFG_ARG=$(printf '%s\n' "$CMD" | sed -n 3p)
[ -x "$NODE_CMD" ] || { echo "node command not executable: $NODE_CMD"; exit 1; }
[ -f "$SERVER_ARG" ] || { echo "server file missing: $SERVER_ARG"; exit 1; }
[ "$CFG_ARG" = "$ODOO_CLAUDE_HOME/config.json" ] || { echo "ODOO_CONFIG_FILE wrong: $CFG_ARG"; exit 1; }
echo "  claude_desktop_config.json ok: $NODE_CMD $SERVER_ARG"
if [ "$DOWNLOAD_NODE" = "yes" ]; then
  case "$NODE_CMD" in "$ODOO_CLAUDE_HOME/node/bin/node") ;; *) echo "expected the private node to be used, got $NODE_CMD"; exit 1 ;; esac
fi

# Run the registered command exactly as Claude Desktop would (config file only, no env vars)
unset ODOO_URL ODOO_LOGIN ODOO_PASSWORD ODOO_DB
OUT=$(ODOO_CONFIG_FILE="$CFG_ARG" "$NODE_CMD" "$SERVER_ARG" --test --json) || { echo "registered command failed: $OUT"; exit 1; }
printf '%s' "$OUT" | grep -q '"database":"smoke-db"' || { echo "unexpected --test result: $OUT"; exit 1; }
echo "  registered command connects: $OUT"

echo "=== uninstall ==="
run_installer --uninstall || { echo "uninstall failed"; exit 1; }
[ -d "$ODOO_CLAUDE_HOME" ] && { echo "app dir still exists"; exit 1; }
"$SYSTEM_NODE" -e "const c=require(process.argv[1]).mcpServers; if(c.odoo) process.exit(1)" "$DESKTOP_CFG" || { echo "odoo entry not removed from Claude Desktop config"; exit 1; }
echo "  uninstall ok"
echo "INSTALLER SMOKE TEST PASSED"
