# ctrl-browse

Let AI agents (and you) drive your **real** Chrome from the command line: your
profile, your logins, your extensions. No bundled browser, no headless mode, no
relaunching Chrome with debug flags.

Every command runs in a **named session**, and each session is a **Chrome tab
group** with that name. Several agents can work side by side without touching
each other's tabs, or yours.

```
ctrl-browse -s feature-a open http://localhost:3000   # creates tab group "feature-a"
ctrl-browse -s feature-a snapshot -i                  # interactive elements with @refs
ctrl-browse -s feature-a click @e3
ctrl-browse -s feature-a close                        # closes the group, cleans the session
```

> [!WARNING]
> ctrl-browse gives whatever runs it **full control of your everyday browser**:
> every site you're logged into (email, bank, work tools), plus page JavaScript,
> cookies and network traffic. Only point agents you trust at it, and consider a
> separate Chrome profile for agent work. The daemon listens only on
> `127.0.0.1` and accepts only its own extension, but any program on your
> machine can use the CLI.

## Why not Playwright MCP / chrome-devtools-mcp?

Those tools launch a separate browser (or need Chrome started with
`--remote-debugging-port`), so the agent starts logged out of everything.
ctrl-browse runs inside the Chrome you already have open: the agent sees exactly
what you see, including apps behind SSO. Tab groups keep each agent's work
visible and contained, and you can watch or take over at any time.

## Install

Requires **Node 20+** (or Bun) and **Chrome 116+**. Other Chromium browsers
with tab groups may work but aren't tested.

```bash
git clone https://github.com/vladstudio/ctrl-browse.git
cd ctrl-browse
npm install
npm link                 # puts `ctrl-browse` on your PATH (bun: bun install && bun link)
```

Load the extension in Chrome:

1. Open `chrome://extensions` and turn on **Developer mode** (top right)
2. Click **Load unpacked** and pick the folder printed by `ctrl-browse extension-path`

Check it's connected:

```bash
ctrl-browse status       # → browser: connected
```

The daemon starts on demand and the extension reconnects to it automatically.
Chrome can be open or closed when you run commands.

## Use with an AI agent

[`skill/SKILL.md`](skill/SKILL.md) teaches an agent the commands, the core
loop and the safety rules. For Claude Code:

```bash
mkdir -p ~/.claude/skills/ctrl-browse
cp skill/SKILL.md ~/.claude/skills/ctrl-browse/
```

Other agents (Cursor, Codex, …): paste its contents into your `AGENTS.md` or
rules file.

## Session model

- `-s <name>` is **required** (or set `CTRL_BROWSE_SESSION`).
- The first command with a new name **creates** the session: a colored tab
  group titled `<name>` with one tab.
- Sessions survive daemon restarts and Chrome restarts (re-bound by group
  title). State lives in `~/.ctrl-browse/state.json`.
- Deleting the group in Chrome (or closing all its tabs) deletes the session.
- `close` closes every tab in the group and forgets the session.
- `tab` commands manage several tabs inside one session; each tab can carry a
  `--label`.

## Commands

```
sessions | status | shutdown | extension-path

open <url> | goto <url>            # goto replies with page as markdown
back | forward | reload
wait <selector|ms> | wait --text "Welcome" | wait --load   [--timeout ms]
wait --text-gone "Loading…" | wait --gone <sel> | wait --fn "<js expr>" | wait --network-idle [ms]
                                   # every wait also takes --timeout / --interval

dom [--limit n]                    # document HTML
snapshot                           # page outline with @refs
snapshot -i                        # interactive elements with @refs + aria state
screenshot <path> [--full] [--scale n] [--max-width n] [--el <sel|@ref> [--pad px]]
                                   # --el crops to one element, --pad adds context around it; --max-width never upscales
viewport <w> <h> [--dpr n]         # real viewport resize — undo with: viewport reset
eval <js>                          # run JS in the page (awaits promises)
get text <sel> | get html <sel>
storage get|set|clear local|session <key> [value]
scrollintoview <sel>

click <sel|@ref> [--force]         # real (trusted) mouse click at element center — or a visible part of it
                                   # when the center is covered; --force clicks the center anyway
fill <sel> <text>                  # inputs: clear + set value (fires input/change)
                                   # contenteditable: select-all + trusted insert (Lexical, ProseMirror)
type <sel> <text> [--delay ms]     # real keystrokes between keys (input;  default 15ms)
press <key[+mod…]>                 # press Escape, press Meta+a — shortcuts, never text
select <sel> <value|label>
find role <role> [--name <s>] [--nth N] [click|show]
find label <accessible name> [--nth N] [click|show]
find text <text> [--nth N] [click|show]  # --nth: 1-based, as numbered in the listing

mouse move <x> <y> [--duration ms] [--steps n] [--human --seed n]
mouse down [left|right|middle] | mouse up [button]
mouse wheel <dy> [dx]

tab                                # list tabs (tN, tabId, label)
tab new [url] [--label L]
tab <tN|label|tabId|title>
tab close [tN|label|tabId]

console [--clear] [--json] [--since-nav]   # --since-nav: entries since the last page load
errors [--clear] [--since-nav]

network route <pattern> [--abort] [--body json] [--status n] [--method M] [--times n] [--header "K: v"] [--content-type ct] [--resource-type t]
                                   # --status alone fulfills with an empty body; --times N expires the route after N matches;
                                   # CORS preflights are answered automatically and Origin is echoed, so credentialed mocks work
network unroute [pattern]
network requests [--clear] [--filter pat] [--type xhr,fetch] [--method POST] [--status 2xx|200|400-499] [--raw]
network request <n|id> [--raw]     # token-like params and auth/cookie headers show as [REDACTED] unless --raw
```

Global flags: `-s/--session <name>`, `--json`, `--limit n`, `--timeout ms`.
Selectors are CSS selectors; `@eN` refs come from `snapshot`/`find`.

## How it works

```
CLI ──ws──▶ daemon (127.0.0.1:9876) ──ws──▶ Chrome extension ──▶ chrome.debugger / tabs / tabGroups
```

- **CLI** (`bin/ctrl-browse.js`) parses the command, sends it to the daemon
  (starting it on first use) and prints the result.
- **Daemon** (`src/daemon.js` + `src/daemon/`) holds session state (tab group,
  active tab, labels, logs, mocks) and implements every command over CDP.
- **Extension** (`src/extension/`) is a thin bridge inside your browser. It
  runs `chrome.debugger` (CDP), `chrome.tabs` and `chrome.tabGroups` calls for
  the daemon. That's why it works with your everyday profile and is always
  headed.

## Notes & limits

- While the extension drives a tab, Chrome shows a *"ctrl-browse bridge started
  debugging this browser"* bar. That's the `chrome.debugger` API, and it's what
  makes clicks, keys and network mocks trusted and reliable.
- While the daemon is off, the extension's service-worker console logs
  `ERR_CONNECTION_REFUSED` on each reconnect attempt (Chrome logs these and
  JS can't hide them). On macOS, `ctrl-browse daemon install` keeps the daemon
  running as a login service so this never happens. `ctrl-browse shutdown`
  stops it; `ctrl-browse daemon uninstall` goes back to on-demand starts.
- Console and network tracking only cover tabs you've run commands against.
- `@eN` refs are stable: an element keeps its ref while it stays in the DOM.
  Re-snapshot to pick up new elements.
- Typed passwords and token-like URL params never appear in output; network
  detail needs `--raw` to show auth headers and cookies.
- Page JS runs in the main frame's default world, so extension iframes
  (password managers) don't break commands.
- Opening DevTools on a tab detaches the debugger; the next command re-attaches.
- **Security:** the daemon binds to `127.0.0.1` and refuses web pages and every
  extension except its own (pinned by the `key` in `manifest.json`). Local
  programs can use it, the same trust level as a local devtools port. If you
  fork and change the key, the daemon picks up the new ID automatically.
- Change the port with `CTRL_BROWSE_PORT`. The extension's port is hardcoded in
  `src/extension/background.js`, so change both.
- Stop the daemon: `ctrl-browse shutdown`.

## Uninstall

```bash
npm unlink -g ctrl-browse      # or: bun unlink
# remove the extension at chrome://extensions
rm -rf ~/.ctrl-browse          # optional: session state and logs
```

## Development

```bash
bun run test        # smoke test (real daemon + CLI, fake extension) and unit tests for the in-page scripts — no Chrome needed
node test/smoke.js  # smoke test on Node
bun src/daemon.js   # run the daemon in the foreground
```

## License

[MIT](LICENSE)
