# Odoo App - connect Claude to Odoo

**Share this link with your team: https://raiybo.github.io/Odoo-App/**

It is a complete guide from zero: sign in to Claude (or create an account), install the Claude Desktop app
with direct download buttons for Mac or Windows, add the Odoo extension, enter the Odoo login, verify.
Ten minutes, no technical knowledge needed. The only things a person types are their **Odoo email** and
**Odoo password** (or an API key); with a team link even the Odoo address is pre-filled.

**Team link:** open the page, scroll to *For team admins*, enter your company's Odoo address and click
*Create team link*. Teammates who open that link see the address pre-filled everywhere, including inside the
extension they download (the page builds a personalised `odoo.mcpb` in the browser). Example:
`https://raiybo.github.io/Odoo-App/?odoo=https%3A%2F%2Fmycompany.odoo.com&company=My%20Company`

## Two ways to install the connector

| | Who it is for | What happens |
|---|---|---|
| **One-click extension** (`odoo.mcpb`) | Everyone using Claude Desktop | Download, double-click, enter the Odoo login in a form, done. Claude Desktop runs the connector with its built-in Node.js and stores the password in the OS keychain. |
| **Automatic installer** (`install.sh` / `install.ps1`) | Claude Code users, people who prefer the terminal, IT roll-outs | One pasted command. Gets a private Node.js if needed, downloads the connector, asks for the Odoo login, **verifies it against Odoo**, registers the connector in Claude Desktop and Claude Code, restarts Claude Desktop. |

Mac:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Raiybo/Odoo-App/main/install.sh)"
```

Windows (PowerShell, no admin rights needed):

```powershell
irm https://raw.githubusercontent.com/Raiybo/Odoo-App/main/install.ps1 | iex
```

After either method, open Claude and ask **"Check my Odoo connection"**.

## What Claude can do once connected

The connector exposes these tools to Claude (it picks them itself):

| Tool | Purpose |
|---|---|
| `odoo_check_connection` | Verifies the connection, reports Odoo version, database, user, company, access mode |
| `odoo_search_models` | Finds technical model names (`customer` -> `res.partner`, `invoice` -> `account.move`, ...) |
| `odoo_fields` | Lists a model's fields with labels, types, relations and selection values |
| `odoo_search_read` | Searches records with an Odoo domain and returns field values (the workhorse) |
| `odoo_count` | Counts matching records |
| `odoo_read` | Reads specific records by id |
| `odoo_name_search` | Finds a record id from a (partial) name |
| `odoo_group_by` | Counts and sums grouped by fields (pivot-style), version-aware |
| `odoo_create` / `odoo_write` / `odoo_delete` | Creates, updates, deletes records (Claude confirms with the user first; delete needs an explicit confirmation flag) |
| `odoo_call` | Calls any public model method, for workflow actions such as confirming a quotation or posting an invoice |
| `odoo_record_link` | Returns the web link to open a record in Odoo |

Claude always acts **as the connected user**, with that user's Odoo access rights. A **Read-only mode** switch
(extension setting, or `ODOO_READ_ONLY=true`) blocks every change.

## How it connects (and why it works everywhere)

Odoo's API changed over the years, so the connector probes the server and picks the first method that works:

1. **Web session** (`/web/session/authenticate` + `/web/dataset/call_kw`): what the Odoo web client itself uses.
   Works on every Odoo version and every Odoo Online plan with a normal password.
2. **JSON-2 API** (`/json/2/<model>/<method>`): Odoo 19 and newer, with an API key.
3. **Classic JSON-RPC** (`/jsonrpc`): Odoo 8 to 21, with a password or an API key.

It also finds the database name by itself (server list, login page, or address), follows redirects
(`http` -> `https`, old domain -> new domain), renews expired sessions, and turns every failure into a plain-language
explanation ("your account uses two-factor authentication, create an API key like this...").

Two-factor-authentication and Google/Microsoft single-sign-on accounts need an Odoo **API key** instead of the
password (Odoo: your name -> Preferences -> Account Security -> New API Key). The page and the connector both explain that.

## Repository layout

```
index.html                 the guide, served at https://raiybo.github.io/Odoo-App/
assets/odoo-app-bundle.js  builds a personalised odoo.mcpb in the browser (team links)
odoo.mcpb                  the one-click Claude Desktop extension (zip of bundle/)
bundle/                    the unzipped extension: manifest.json, server/index.js, icon.png, package.json (built, committed, served)
install.sh / install.ps1   the automatic installers for Mac/Linux and Windows
server/index.js            the MCP server: Odoo client + tools, zero dependencies, Node 18+
server/setup.js            helper for the installers: saves config, edits Claude's config files
extension/manifest.json    the extension manifest template (MCPB 0.3); the build fills in version and tools
scripts/build-mcpb.mjs     builds bundle/, odoo.mcpb and icon.png (no dependencies)
tests/                     offline end-to-end tests (fake Odoo), installer smoke tests, browser tests, live demo test
```

## Development

```bash
npm test             # offline end-to-end tests against the built-in fake Odoo + the in-browser bundle builder
npm run test:browser # landing page and bundle builder in a real headless browser (Edge/Chrome); ONLINE=1 also checks Anthropic's download links
npm run test:live    # smoke test against Odoo's public demo server (needs internet)
npm run build        # rebuild bundle/, odoo.mcpb and icon.png
node server/index.js --test   # check a connection using ODOO_URL / ODOO_LOGIN / ODOO_PASSWORD env vars
```

Installer smoke tests (run the real installer unattended against the fake Odoo in an isolated HOME):
`bash tests/installer-smoke.sh [--download-node]` and `powershell -File tests\installer-smoke.ps1 [-DownloadNode]`.
GitHub Actions runs all of this on Linux, macOS and Windows on every push.

Configuration is read from environment variables, falling back to a JSON file
(`~/.odoo-claude/config.json` on Mac/Linux, `%LOCALAPPDATA%\OdooClaude\config.json` on Windows, or `ODOO_CONFIG_FILE`):
`ODOO_URL`, `ODOO_LOGIN`, `ODOO_PASSWORD` (password or API key), `ODOO_DB` (optional), `ODOO_READ_ONLY`,
`ODOO_INSECURE_SSL` (self-signed certificates), `ODOO_TIMEOUT_MS`, `ODOO_DEBUG=1` for verbose logs on stderr.

Installer knobs (environment variables): `ODOO_URL`, `ODOO_LOGIN`, `ODOO_PASSWORD`, `ODOO_DB`, `ODOO_READ_ONLY`
make the install unattended (`ODOO_URL` alone pre-fills the question); `ODOO_CLAUDE_NO_LAUNCH=1` never opens apps or
web pages; `ODOO_CLAUDE_HOME` changes the install folder; `ODOO_CLAUDE_NODE` points at an existing Node.js binary;
`ODOO_CLAUDE_BASE_URL` changes where files are downloaded from (for forks and mirrors).

Uninstall: `--uninstall` (Mac) or `$env:ODOO_CLAUDE_UNINSTALL='1'` (Windows) before running the install command
again; or Settings -> Extensions -> Odoo -> Uninstall for the extension.

Releasing a new version: bump `version` in `package.json`, `npm run build`, commit, push, then
`gh release create vX.Y.Z odoo.mcpb --notes-file notes.md`.

## Windows note (Microsoft Store / MSIX build of Claude Desktop)

The current Windows build of Claude Desktop is an MSIX package (`Claude_pzs8sxrjxfjjc`). It keeps its
configuration in a virtualised AppData folder, `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\`,
not in the documented `%APPDATA%\Claude\`. The installer (`server/setup.js`) detects the package and writes
`claude_desktop_config.json` to both places, and launches the app through its Start menu entry. That build also
registers no `.mcpb` file association, so the guide tells Windows users to install the extension through
*Settings -> Extensions -> Advanced settings -> Install Extension...* (or drag and drop) rather than by double-click.

## Security notes

- Credentials never leave the user's computer except to their own Odoo server over HTTPS.
- The extension keeps the password in the OS keychain (handled by Claude Desktop); the installer keeps it in a
  file readable only by the user.
- The connector has no third-party dependencies; `server/index.js` is the whole program and can be audited in minutes.
- Prefer API keys over passwords where possible, and enable Read-only mode for people who only need to look things up.
- The page links to Anthropic's own "latest installer" endpoints for Claude Desktop
  (`https://claude.ai/api/desktop/<platform>/.../latest/redirect`), the same ones used by claude.com/download.

## License

MIT
