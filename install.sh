#!/bin/bash
# Odoo App - installer for macOS (also works on Linux).
# Connects Claude (Claude Desktop and Claude Code) to your Odoo.
#
# Run it with:
#   /bin/bash -c "$(curl -fsSL https://odoo-app.netlify.app/install.sh)"
#
# Remove it with:
#   /bin/bash -c "$(curl -fsSL https://odoo-app.netlify.app/install.sh)" -- --uninstall
#
# Unattended use (for IT): set ODOO_URL, ODOO_LOGIN, ODOO_PASSWORD (and optionally ODOO_DB, ODOO_READ_ONLY=true)
# in the environment before running; no questions are asked then.
#
# Other knobs: ODOO_CLAUDE_HOME (install folder, default ~/.odoo-claude), ODOO_CLAUDE_BASE_URL (where to download from),
#              ODOO_CLAUDE_NODE (use this Node.js binary instead of downloading one).
#
# What it does: 1) gets a private Node.js runtime if needed  2) downloads the Odoo connector  3) asks for your Odoo
# address, email and password and checks that they work  4) registers the connector in Claude Desktop and Claude Code
# 5) restarts Claude Desktop. Nothing else on your Mac is changed.

set -u

BASE_URL="${ODOO_CLAUDE_BASE_URL:-https://odoo-app.netlify.app}"
APP_DIR="${ODOO_CLAUDE_HOME:-$HOME/.odoo-claude}"
NODE_SERIES="v22"
READ_ONLY="${ODOO_READ_ONLY:-false}"
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    --read-only) READ_ONLY=true ;;
  esac
done

if [ -t 1 ]; then BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else BOLD=""; GREEN=""; RED=""; YELLOW=""; DIM=""; RESET=""; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s%s%s\n' "$BOLD" "$*" "$RESET"; }
ok()   { printf '  %s[ok]%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s[!]%s %s\n' "$YELLOW" "$RESET" "$*"; }
fail() { printf '\n%s[error]%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

if [ -r /dev/tty ] && [ -w /dev/tty ]; then TTY=/dev/tty; else TTY=""; fi
# ask VAR "question" "default" [secret]
ask() {
  local var="$1" prompt="$2" default="$3" secret="${4:-}" value=""
  if [ -z "$TTY" ]; then printf -v "$var" '%s' "$default"; return; fi
  if [ -n "$default" ] && [ -z "$secret" ]; then prompt="$prompt [$default]"; fi
  printf '  %s: ' "$prompt" > "$TTY"
  if [ -n "$secret" ]; then IFS= read -r -s value < "$TTY"; printf '\n' > "$TTY"; else IFS= read -r value < "$TTY"; fi
  if [ -z "$value" ]; then value="$default"; fi
  printf -v "$var" '%s' "$value"
}

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  MINGW*|MSYS*|CYGWIN*) fail "This is the Mac/Linux installer. On Windows open PowerShell and run:  irm https://odoo-app.netlify.app/install.ps1 | iex" ;;
  *) fail "Unsupported system: $(uname -s)" ;;
esac
command -v curl >/dev/null 2>&1 || fail "curl is required but was not found."

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null; }
find_node() {
  NODE_BIN=""
  if [ -n "${ODOO_CLAUDE_NODE:-}" ] && [ -x "$ODOO_CLAUDE_NODE" ]; then NODE_BIN="$ODOO_CLAUDE_NODE"; return; fi
  if [ -x "$APP_DIR/node/bin/node" ]; then NODE_BIN="$APP_DIR/node/bin/node"; return; fi
  local sys maj
  sys=$(command -v node 2>/dev/null || true)
  if [ -n "$sys" ]; then
    maj=$(node_major "$sys")
    if [ -n "$maj" ] && [ "$maj" -ge 18 ] 2>/dev/null; then NODE_BIN="$sys"; return; fi
  fi
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else echo ""; fi
}

install_node() {
  local arch file url sum tmp actual shasums
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) fail "Unsupported processor: $(uname -m)" ;;
  esac
  say "  Downloading a private copy of Node.js $NODE_SERIES for $OS-$arch (about 50 MB, only once)..."
  shasums=$(curl -fsSL "https://nodejs.org/dist/latest-$NODE_SERIES.x/SHASUMS256.txt") || fail "Could not reach nodejs.org to download Node.js. Check your internet connection."
  file=$(printf '%s\n' "$shasums" | grep -o "node-$NODE_SERIES[0-9.]*-$OS-$arch\.tar\.gz" | head -n 1)
  [ -n "$file" ] || fail "No Node.js download found for $OS-$arch."
  sum=$(printf '%s\n' "$shasums" | grep " $file\$" | awk '{print $1}')
  url="https://nodejs.org/dist/latest-$NODE_SERIES.x/$file"
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t odooapp)
  curl -fL --progress-bar "$url" -o "$tmp/$file" || fail "Download of $url failed."
  actual=$(sha256_of "$tmp/$file")
  if [ -n "$actual" ] && [ "$actual" != "$sum" ]; then rm -rf "$tmp"; fail "The downloaded Node.js file is corrupted (checksum mismatch). Please run the installer again."; fi
  rm -rf "$APP_DIR/node"
  mkdir -p "$APP_DIR/node"
  tar -xzf "$tmp/$file" -C "$APP_DIR/node" --strip-components=1 || fail "Could not extract Node.js."
  rm -rf "$tmp"
  NODE_BIN="$APP_DIR/node/bin/node"
  [ -x "$NODE_BIN" ] || fail "Node.js was extracted but $NODE_BIN is not executable."
}

download() { # url dest
  curl -fsSL "$1" -o "$2.tmp" || fail "Could not download $1"
  mv -f "$2.tmp" "$2"
}

claude_desktop_running() { pgrep -x Claude >/dev/null 2>&1; }
claude_desktop_installed() { [ -d "/Applications/Claude.app" ] || [ -d "$HOME/Applications/Claude.app" ]; }

# ---------------------------------------------------------------------------
if [ "$UNINSTALL" = "1" ]; then
  step "Removing Odoo App"
  find_node
  if [ -n "$NODE_BIN" ] && [ -f "$APP_DIR/server/setup.js" ]; then
    "$NODE_BIN" "$APP_DIR/server/setup.js" claude-desktop --remove >/dev/null 2>&1 && ok "Removed from Claude Desktop" || true
    "$NODE_BIN" "$APP_DIR/server/setup.js" claude-code --remove >/dev/null 2>&1 && ok "Removed from Claude Code" || true
  fi
  rm -rf "$APP_DIR"
  ok "Deleted $APP_DIR (including your saved Odoo login)"
  say "  Restart Claude Desktop to finish. Bye!"
  exit 0
fi

printf '\n%sOdoo App%s - connect Claude to Odoo\n' "$BOLD" "$RESET"
say "${DIM}Install folder: $APP_DIR${RESET}"

step "Step 1 of 4 - Preparing"
mkdir -p "$APP_DIR/server" || fail "Cannot create $APP_DIR"
find_node
if [ -n "$NODE_BIN" ]; then ok "Node.js found: $NODE_BIN ($("$NODE_BIN" --version 2>/dev/null))"; else install_node; ok "Node.js installed privately in $APP_DIR/node"; fi
download "$BASE_URL/server/index.js" "$APP_DIR/server/index.js"
download "$BASE_URL/server/setup.js" "$APP_DIR/server/setup.js"
SERVER="$APP_DIR/server/index.js"
SETUP="$APP_DIR/server/setup.js"
ok "Odoo connector $("$NODE_BIN" "$SERVER" --version 2>/dev/null) downloaded"

step "Step 2 of 4 - Your Odoo login"
DEF_URL="${ODOO_URL:-$("$NODE_BIN" "$SETUP" read-config --dir "$APP_DIR" --key url 2>/dev/null)}"
DEF_LOGIN="${ODOO_LOGIN:-$("$NODE_BIN" "$SETUP" read-config --dir "$APP_DIR" --key login 2>/dev/null)}"
DEF_DB="${ODOO_DB:-$("$NODE_BIN" "$SETUP" read-config --dir "$APP_DIR" --key db 2>/dev/null)}"
PRESET=0
if [ -n "${ODOO_URL:-}" ] && [ -n "${ODOO_LOGIN:-}" ] && [ -n "${ODOO_PASSWORD:-}" ]; then PRESET=1; fi
if [ "$PRESET" = "0" ] && [ -z "$TTY" ]; then fail "No terminal available to ask questions. Set ODOO_URL, ODOO_LOGIN and ODOO_PASSWORD in the environment, or run this in Terminal."; fi
say "  Use the same details you type on your Odoo login page."
URL_IN="${ODOO_URL:-}"; LOGIN_IN="${ODOO_LOGIN:-}"; PASS_IN="${ODOO_PASSWORD:-}"; DB_IN="${ODOO_DB:-}"
while :; do
  if [ "$PRESET" = "0" ]; then
    ask URL_IN "Odoo address (like https://mycompany.odoo.com)" "$DEF_URL"
    ask LOGIN_IN "Email you log into Odoo with" "$DEF_LOGIN"
    ask PASS_IN "Odoo password or API key (typing is hidden)" "" secret
    ask DB_IN "Database name (just press Enter to detect it automatically)" "$DEF_DB"
  fi
  say "  Checking the connection..."
  RESULT=$(ODOO_URL="$URL_IN" ODOO_LOGIN="$LOGIN_IN" ODOO_PASSWORD="$PASS_IN" ODOO_DB="$DB_IN" ODOO_READ_ONLY="$READ_ONLY" ODOO_CONFIG_FILE="/nonexistent/odoo-app.json" ODOO_QUIET=1 "$NODE_BIN" "$SERVER" --test 2>/dev/null)
  RC=$?
  if [ "$RC" = "0" ]; then
    printf '%s\n' "$RESULT" | sed 's/^/  /'
    ok "Your Odoo login works"
    break
  fi
  printf '%s%s%s\n' "$RED" "$RESULT" "$RESET" | sed 's/^/  /'
  if [ "$PRESET" = "1" ]; then fail "The connection check failed (see above)."; fi
  ask AGAIN "Try again? (Y/n)" "Y"
  case "$AGAIN" in n|N|no|No|NO) fail "Stopped. Run the installer again whenever you are ready." ;; esac
  DEF_URL="$URL_IN"; DEF_LOGIN="$LOGIN_IN"; DEF_DB="$DB_IN"
done

step "Step 3 of 4 - Saving"
CONFIG_FILE=$(ODOO_URL="$URL_IN" ODOO_LOGIN="$LOGIN_IN" ODOO_PASSWORD="$PASS_IN" ODOO_DB="$DB_IN" ODOO_READ_ONLY="$READ_ONLY" "$NODE_BIN" "$SETUP" save-config --dir "$APP_DIR") || fail "Could not save the configuration."
unset PASS_IN
ok "Saved to $CONFIG_FILE (readable only by you)"

step "Step 4 of 4 - Connecting Claude"
NO_LAUNCH="${ODOO_CLAUDE_NO_LAUNCH:-0}"   # set to 1 to never open apps or web pages (unattended installs)
if [ "$NO_LAUNCH" = "1" ]; then
  :
elif ! claude_desktop_installed; then
  warn "Claude Desktop is not installed on this Mac."
  if [ "$OS" = "darwin" ] && command -v brew >/dev/null 2>&1 && [ -n "$TTY" ]; then
    ask INSTALL_CLAUDE "Install Claude Desktop now with Homebrew? (Y/n)" "Y"
    case "$INSTALL_CLAUDE" in
      n|N|no|No|NO) say "  You can get it later from https://claude.ai/download" ;;
      *) brew install --cask claude && ok "Claude Desktop installed" || warn "Homebrew could not install Claude Desktop. Get it from https://claude.ai/download" ;;
    esac
  elif [ "$OS" = "darwin" ]; then
    say "  Opening the download page: https://claude.ai/download"
    open "https://claude.ai/download" >/dev/null 2>&1 || true
  fi
fi
DESKTOP_OUT=$("$NODE_BIN" "$SETUP" claude-desktop --force --node "$NODE_BIN" --server "$SERVER" --config "$CONFIG_FILE" 2>&1)
if [ $? -eq 0 ]; then ok "Claude Desktop: Odoo connector registered ($DESKTOP_OUT)"; else warn "Claude Desktop: $DESKTOP_OUT"; fi

CODE_OUT=$("$NODE_BIN" "$SETUP" claude-code --node "$NODE_BIN" --server "$SERVER" --config "$CONFIG_FILE" 2>&1)
CODE_RC=$?
if [ "$CODE_RC" = "0" ]; then ok "Claude Code: Odoo connector registered (user scope)"
elif [ "$CODE_RC" = "2" ]; then say "  ${DIM}Claude Code is not installed - skipped (install it later and run this installer again).${RESET}"
else warn "Claude Code: $CODE_OUT"; fi

if [ "$NO_LAUNCH" = "1" ]; then
  :
elif [ "$OS" = "darwin" ] && claude_desktop_running; then
  say "  Restarting Claude Desktop so it picks up the Odoo connector..."
  osascript -e 'tell application "Claude" to quit' >/dev/null 2>&1 || pkill -x Claude 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do claude_desktop_running || break; sleep 1; done
  open -a Claude >/dev/null 2>&1 || true
  ok "Claude Desktop restarted"
elif [ "$OS" = "darwin" ] && claude_desktop_installed; then
  open -a Claude >/dev/null 2>&1 || true
fi

printf '\n%s%sAll set!%s\n' "$GREEN" "$BOLD" "$RESET"
say "  1. Open Claude."
say "  2. Ask:  \"Check my Odoo connection\"  - then ask anything about your Odoo data."
say ""
say "  ${DIM}Change the login later: run this installer again.  Remove: add --uninstall.${RESET}"
