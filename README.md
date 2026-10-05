# ctrl-browse

Control your **existing** Chrome browser from the CLI — built for AI agents.
No bundled browser, no headless mode. Every command is scoped to a **named
session**, and each session is bound to a **Chrome tab group** with the same
name.

```
ctrl-browse -s feature-a open http://localhost:3000   # creates tab group "feature-a"
ctrl-browse -s feature-a snapshot -i                  # interactive elements with @refs
ctrl-browse -s feature-a click @e3
ctrl-browse -s feature-a close                        # closes the group, cleans the session
```

## How it works

```
CLI ──ws──▶ daemon (127.0.0.1:9876) ──ws──▶ Chrome extension ──▶ chrome.debugger / tabs / tabGroups
```

- **CLI** (`bin/ctrl-browse.js`) — parses the command, sends it to the daemon
  (auto-spawns the daemon on first use), prints the result.
- **Daemon** (`src/daemon.js`) — holds session state (tab group id, active tab,
  labels, logs, routes) and implements all commands via CDP.
- **Extension** (`src/extension/`) — thin bridge living inside your real
  browser. Executes `chrome.debugger` (CDP), `chrome.tabs` and
  `chrome.tabGroups` calls on the daemon's behalf. This is what makes it work
  with your everyday profile — no `--remote-debugging-port`, no separate
  `--user-data-dir`, always headed.

Sessions persist in `~/.ctrl-browse/state.json` and re-bind after restarts by
looking up the tab group by its title.

## Install

With **bun** (your runtime — everything is verified to run on Bun, and the CLI
starts ~4× faster):

```bash
cd ctrl-browse
bun install
bun link             # puts `ctrl-browse` on your PATH (runs via bun)
```

Node works identically (`npm install -g .` or `npm link`) — the shebang is
`env bun`, so use `node bin/ctrl-browse.js ...` directly if you ever want node.
The daemon auto-spawned by the CLI uses the same runtime as the CLI.

Load the extension in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `src/extension` folder

That's it. Chrome can be open or closed; the daemon starts on demand and the
extension reconnects automatically. Verify with:

```bash
ctrl-browse status
```

## Session model

- `-s <name>` is **required** (or set `CTRL_BROWSE_SESSION`).
- First command with an unknown name **auto-creates** the session: it makes a
  tab group titled `<name>` (colored) containing one tab.
- Sessions survive daemon restarts (state file) and even Chrome restarts
  (re-bound by group title).
- Deleting the group in Chrome (or closing all its tabs) deletes the session.
- `close` closes every tab in the group and forgets the session.
- `tab` commands manage multiple tabs inside one session; each tab can carry a
  user-assigned `--label`.

## Commands

```
sessions | status | shutdown

open <url> | goto <url>            # goto replies with page as markdown
back | forward | reload
wait <selector|ms> | wait --text "Welcome" | wait --load   [--timeout ms]

dom [--limit n]                    # document HTML
snapshot                           # page outline with @refs
snapshot -i                        # interactive elements with @refs
screenshot <path> [--full]         # viewport or full-page PNG
eval <js>                          # run JS in the page (awaits promises)
get text <sel> | get html <sel>
scrollintoview <sel>

click <sel|@ref>                   # real (trusted) mouse click at element center
fill <sel> <text>                  # clear + set value, fires input/change
type <sel> <text> [--delay ms]     # real keystrokes
select <sel> <value|label>
find role <role> [click|show]
find text <text> [click|show]

mouse move <x> <y> [--duration ms] [--steps n] [--human --seed n]
mouse down [left|right|middle] | mouse up [button]
mouse wheel <dy> [dx]

tab                                # list tabs (tN, tabId, label)
tab new [url] [--label L]
tab <tN|label|tabId|title>
tab close [tN|label|tabId]

console [--clear] [--json]
errors [--clear]

network route <pattern> [--abort] [--body json] [--status n] [--content-type ct] [--resource-type t]
network unroute [pattern]
network requests [--clear] [--filter pat] [--type xhr,fetch] [--method POST] [--status 2xx|200|400-499]
network request <n|id>
```

Global flags: `-s/--session <name>`, `--json`, `--limit n`, `--timeout ms`.
Selectors are CSS selectors; `@eN` refs come from `snapshot`/`find`.

## Agent journey

```bash
ctrl-browse -s feature-a goto http://localhost:3000     # → page as markdown
ctrl-browse -s feature-a snapshot -i                    # → @e1 button "Submit" …
ctrl-browse -s feature-a fill #email "me@example.com"
ctrl-browse -s feature-a click @e3
ctrl-browse -s feature-a console                        # → page console
ctrl-browse -s feature-a network requests --filter api
ctrl-browse -s feature-a close
```

## Notes & limits

- While the daemon is off, the extension's service worker console shows
  `ERR_CONNECTION_REFUSED` on each probe — Chrome logs every refused connect
  attempt and it can't be suppressed from JS. **Avoid it entirely with
  `ctrl-browse daemon install`** — keeps the daemon running as a login service
  (KeepAlive), so it's always listening. `ctrl-browse shutdown` unloads it;
  `ctrl-browse daemon uninstall` reverts to on-demand auto-spawn.
- While the extension drives a tab, Chrome shows the usual
  *"ctrl-browse bridge started debugging this browser"* infobar. That's the
  `chrome.debugger` API doing its job — it's what makes clicks/keys/network
  interception trusted and reliable.
- Console/network tracking only covers tabs the extension is attached to
  (i.e. tabs you've run commands against).
- `@eN` refs are re-assigned on every `snapshot`/`find` — after the page
  changes, re-snapshot before clicking an old ref.
- Opening DevTools on a tab detaches the debugger; the next command
  re-attaches.
- The daemon only listens on `127.0.0.1` and rejects browser-page origins.
  Anything running on your machine can use it — same trust level as a local
  devtools port.
- Override the port with `CTRL_BROWSE_PORT` (must match for the extension —
  port is hardcoded in `src/extension/background.js`; change both if needed).
- Kill the daemon: `ctrl-browse shutdown` (or `pkill -f ctrl-browse/daemon`).

## Uninstall

```bash
npm uninstall -g ctrl-browse   # or npm unlink -g
# remove the extension at chrome://extensions
# optional: rm -rf ~/.ctrl-browse
```

## Development

```bash
bun run test    # end-to-end smoke test with a fake extension (no Chrome needed)
bun test        # unit tests for the in-page scripts (md.js, page.js)
bun src/daemon.js   # run the daemon in the foreground
```