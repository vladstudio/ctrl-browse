<p align="center"><img src="assets/icon-256.png" width="128" height="128" alt="ctrl-browse"></p>

<h1 align="center">ctrl-browse</h1>

CLI that lets AI agents (and you) drive your **real** Chrome: your profile,
logins and extensions. No bundled browser, no headless mode, no relaunching
with debug flags.

Each **session** is a **Chrome tab group** of the same name, so several agents
work side by side without touching each other's tabs or yours.

<p align="center"><img src="assets/screenshot.png" alt="ctrl-browse driving a browser session from the terminal"></p>

```
ctrl-browse -s feature-a open http://localhost:3000   # creates tab group "feature-a"
ctrl-browse -s feature-a snapshot -i                  # interactive elements with @refs
ctrl-browse -s feature-a click @e3
ctrl-browse -s feature-a close                        # closes group, ends session
```

> [!WARNING]
> Whatever runs ctrl-browse **controls your everyday browser**: every logged-in
> site (email, bank, work tools), page JavaScript, cookies, network traffic.
> Use only trusted agents; consider a separate Chrome profile. The daemon binds
> to `127.0.0.1` and refuses web pages and every extension but its own (pinned
> by the `key` in `manifest.json`), yet any local program can use it, same as
> a local devtools port.

## Why not Playwright MCP / chrome-devtools-mcp?

They launch a separate browser or need `--remote-debugging-port`, so the agent
starts logged out. ctrl-browse runs in your open Chrome: the agent sees what
you see, including SSO apps. Tab groups keep its work visible and contained;
watch or take over anytime.

## Install

Needs **Node 20+** (or Bun) and **Chrome 116+**. Other Chromium browsers with
tab groups may work, untested.

```bash
git clone https://github.com/vladstudio/ctrl-browse.git
cd ctrl-browse
npm install
npm link                 # adds `ctrl-browse` to PATH (bun: bun install && bun link)
```

Load the extension:

1. `chrome://extensions` → enable **Developer mode** (top right)
2. **Load unpacked** → pick the folder from `ctrl-browse extension-path`

Verify:

```bash
ctrl-browse status       # → browser: connected
```

The daemon starts on demand; the extension reconnects on its own. Chrome may be
open or closed when you run commands.

## Use with an AI agent

[`skill/SKILL.md`](skill/SKILL.md) teaches commands, core loop and safety
rules. Claude Code:

```bash
mkdir -p ~/.claude/skills/ctrl-browse
cp skill/SKILL.md ~/.claude/skills/ctrl-browse/
```

Others (Cursor, Codex, …): paste it into `AGENTS.md` or your rules file.

## Sessions

- `-s <name>` is **required** (or set `CTRL_BROWSE_SESSION`).
- A new name **creates** a colored tab group titled `<name>` with one tab.
- Survives daemon and Chrome restarts (re-bound by group title). State:
  `~/.ctrl-browse/state.json`.
- Deleting the group or closing all its tabs deletes the session.
- `close` closes all group tabs and forgets the session.
- `tab` commands manage multiple tabs per session, each with optional `--label`.

## Commands

```
sessions | status | shutdown | extension-path

open <url> | goto <url>            # goto also returns the page as markdown
back | forward | reload
wait <selector|ms> | wait --text "Welcome" | wait --load
wait --text-gone "Loading…" | wait --gone <sel> | wait --fn "<js expr>" | wait --network-idle [ms]
                                   # all waits: [--timeout ms] [--interval ms]

dom [--limit n]                    # document HTML
snapshot                           # page outline with @refs
snapshot -i                        # interactive elements with @refs + aria state
screenshot <path> [--full] [--scale n] [--max-width n] [--el <sel|@ref> [--pad px]]
                                   # --el crops to element, --pad adds margin; --max-width never upscales
viewport <w> <h> [--dpr n]         # real resize; undo: viewport reset
eval <js>                          # run JS in page (awaits promises)
get text <sel> | get html <sel>
storage get|set|clear local|session <key> [value]
scrollintoview <sel>

click <sel|@ref> [--force]         # trusted click at center, or a visible part if center is covered;
                                   # --force clicks center anyway
fill <sel> <text>                  # inputs: clear + set value (fires input/change)
                                   # contenteditable: select-all + trusted insert (Lexical, ProseMirror)
type <sel> <text> [--delay ms]     # real keystrokes; delay between keys (default 15ms)
press <key[+mod…]>                 # Escape, Meta+a: keys/shortcuts, never text
select <sel> <value|label>
find role <role> [--name <s>] [--nth N] [click|show]
find label <accessible name> [--nth N] [click|show]
find text <text> [--nth N] [click|show]  # --nth: 1-based, as numbered in listing

mouse move <x> <y> [--duration ms] [--steps n] [--human --seed n]
mouse down [left|right|middle] | mouse up [button]
mouse wheel <dy> [dx]

tab                                # list tabs (tN, tabId, label)
tab new [url] [--label L]
tab <tN|label|tabId|title>
tab close [tN|label|tabId]

console [--clear] [--json] [--since-nav]   # --since-nav: only since last page load
errors [--clear] [--since-nav]

network route <pattern> [--abort] [--body json] [--status n] [--method M] [--times n] [--header "K: v"] [--content-type ct] [--resource-type t]
                                   # --status alone: empty body; --times N: expires after N matches;
                                   # CORS preflights auto-answered, Origin echoed, so credentialed mocks work
network unroute [pattern]
network requests [--clear] [--filter pat] [--type xhr,fetch] [--method POST] [--status 2xx|200|400-499] [--raw]
network request <n|id> [--raw]     # token-like params, auth/cookie headers show [REDACTED] unless --raw
```

Global flags: `-s/--session <name>`, `--json`, `--limit n`, `--timeout ms`.
Selectors are CSS; `@eN` refs come from `snapshot`/`find`.

## How it works

```
CLI ──ws──▶ daemon (127.0.0.1:9876) ──ws──▶ Chrome extension ──▶ chrome.debugger / tabs / tabGroups
```

- **CLI** (`bin/ctrl-browse.js`): parses, sends to daemon (starting it if
  needed), prints result.
- **Daemon** (`src/daemon.js` + `src/daemon/`): holds session state (tab group,
  active tab, labels, logs, mocks); implements every command over CDP.
- **Extension** (`src/extension/`): thin in-browser bridge running
  `chrome.debugger` (CDP), `chrome.tabs`, `chrome.tabGroups` calls for the
  daemon. Hence your everyday profile, always headed.

## Notes & limits

- Driven tabs show Chrome's *"ctrl-browse bridge started debugging this
  browser"* bar. That's `chrome.debugger`, which makes clicks, keys and network
  mocks trusted and reliable.
- With the daemon off, the extension's service-worker console logs
  `ERR_CONNECTION_REFUSED` per reconnect attempt (Chrome logs these; JS can't
  hide them). macOS fix: `ctrl-browse daemon install` runs it as a login
  service. `ctrl-browse shutdown` stops the daemon; `ctrl-browse daemon
  uninstall` reverts to on-demand.
- Console and network tracking cover only tabs you've run commands against.
- `@eN` refs persist while the element stays in the DOM. Re-snapshot for new
  elements.
- Output never shows typed passwords or token-like URL params; `network
  request` needs `--raw` for auth headers and cookies.
- Page JS runs in the main frame's default world, so extension iframes
  (password managers) don't break commands.
- Opening DevTools on a tab detaches the debugger; the next command re-attaches.
- Fork with a new manifest `key`? The daemon picks up the new extension ID
  automatically.
- Port: set `CTRL_BROWSE_PORT` **and** edit the hardcoded port in
  `src/extension/background.js`.

## Uninstall

```bash
npm unlink -g ctrl-browse      # or: bun unlink
# remove the extension at chrome://extensions
rm -rf ~/.ctrl-browse          # optional: session state and logs
```

## Development

```bash
bun run test        # smoke test (real daemon + CLI, fake extension) + in-page script unit tests; no Chrome needed
node test/smoke.js  # smoke test on Node
bun src/daemon.js   # daemon in foreground
```

## License

[MIT](LICENSE)
