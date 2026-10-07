// command + flag spec, shared by the CLI (parsing, help), the daemon (arity
// checks, usage errors) and the README (scripts/gen.js renders its command
// reference from here). The single source for "what commands and flags exist".

/**
 * value: takes the next arg · bool: no value · opt: bool, or --name=value
 * list: value, repeatable
 */
export const FLAGS = /** @type {const} */ ({
  // global
  json: 'bool', timeout: 'value', help: 'bool', version: 'bool',
  // per command (see each command's `flags`)
  limit: 'value', raw: 'bool', i: 'bool',
  text: 'value', 'text-gone': 'value', gone: 'value', fn: 'value', 'network-idle': 'opt', load: 'bool', interval: 'value',
  full: 'bool', scale: 'value', 'max-width': 'value', el: 'value', pad: 'value', dpr: 'value',
  force: 'bool', delay: 'value', name: 'value', nth: 'value', action: 'value',
  duration: 'value', steps: 'value', human: 'bool', seed: 'value',
  label: 'value', clear: 'bool', 'since-nav': 'bool',
  abort: 'bool', body: 'value', status: 'value', method: 'value', times: 'value', header: 'list',
  'content-type': 'value', 'resource-type': 'value', filter: 'value', type: 'value',
})

/**
 * @typedef {typeof FLAGS} FlagKinds
 * @typedef {{ -readonly [K in keyof FlagKinds]?: FlagKinds[K] extends 'bool' ? true
 *   : FlagKinds[K] extends 'list' ? string[] : FlagKinds[K] extends 'opt' ? true | string : string }} Flags
 */

/** @type {(keyof FlagKinds)[]} accepted by every command */
export const GLOBAL_FLAGS = ['json', 'timeout', 'help', 'version']
/** @type {Record<string, keyof FlagKinds>} -s is the session */
export const SHORT_FLAGS = { i: 'i', h: 'help', v: 'version' }

/**
 * @typedef {object} CommandSpec
 * @property {string} name
 * @property {string[]} [aliases]
 * @property {string} section
 * @property {{ syntax: string, help?: string }[]} usage
 * @property {string[]} [notes]
 * @property {(keyof FlagKinds)[]} [flags]  besides GLOBAL_FLAGS
 * @property {number} [min]        required positional args
 * @property {boolean} [url]       first arg is a url (normalized, opens a new session's first tab)
 * @property {boolean} [session]   false: runs without a session
 * @property {boolean} [local]     handled by the CLI itself
 */

/** @type {CommandSpec[]} */
export const COMMANDS = [
  { name: 'sessions', section: 'sessions', session: false, usage: [{ syntax: 'sessions', help: 'list sessions' }] },
  { name: 'close', section: 'sessions', usage: [{ syntax: 'close', help: 'close session (closes its tab group)' }] },
  { name: 'status', section: 'sessions', session: false, usage: [{ syntax: 'status', help: 'daemon + browser status' }] },
  { name: 'shutdown', section: 'sessions', session: false, usage: [{ syntax: 'shutdown', help: 'stop the daemon, detaching every tab' }] },
  { name: 'daemon', section: 'sessions', local: true, usage: [{ syntax: 'daemon install|uninstall', help: 'run daemon as a login service (macOS launchagent)' }] },
  { name: 'extension-path', section: 'sessions', local: true, usage: [{ syntax: 'extension-path', help: 'folder to "Load unpacked" in chrome://extensions' }] },

  { name: 'goto', aliases: ['open'], section: 'navigation', min: 1, url: true, flags: ['limit'], usage: [{ syntax: 'open <url> | goto <url> [--limit n]', help: 'navigate; prints the page as markdown' }] },
  { name: 'back', section: 'navigation', usage: [{ syntax: 'back', help: 'history back' }] },
  { name: 'forward', section: 'navigation', usage: [{ syntax: 'forward', help: 'history forward' }] },
  { name: 'reload', section: 'navigation', usage: [{ syntax: 'reload' }] },
  {
    name: 'wait', section: 'navigation', flags: ['text', 'text-gone', 'gone', 'fn', 'network-idle', 'load', 'interval'],
    usage: [
      { syntax: 'wait <selector|@ref|ms>', help: 'element appears, or ms pass' },
      { syntax: 'wait --text "Welcome"', help: 'text appears (substring)' },
      { syntax: 'wait --text-gone "Loading…"', help: 'text disappears' },
      { syntax: 'wait --gone <selector|@ref>', help: 'element disappears' },
      { syntax: 'wait --fn "<js expression>"', help: 'expression becomes truthy' },
      { syntax: 'wait --network-idle [ms]', help: 'nothing in flight, no traffic for ms (default 500)' },
      { syntax: 'wait --load', help: 'page load' },
    ],
    notes: [
      'all waits: --timeout ms, --interval ms',
      '--network-idle ignores streams and long-polls open >10s',
    ],
  },

  { name: 'dom', section: 'page', flags: ['limit'], usage: [{ syntax: 'dom [--limit n]', help: 'document HTML' }] },
  {
    name: 'snapshot', section: 'page', flags: ['i', 'limit', 'raw'], usage: [
      { syntax: 'snapshot', help: 'page outline with stable @refs' },
      { syntax: 'snapshot -i', help: 'interactive elements, @refs, aria state' },
    ],
  },
  {
    name: 'screenshot', section: 'page', min: 1, flags: ['full', 'scale', 'max-width', 'el', 'pad'], usage: [
      { syntax: 'screenshot <path> [--full] [--scale n] [--max-width n] [--el <sel|@ref> [--pad px]]',
        help: '--el: crop to element, --pad: margin; --max-width never upscales' },
    ],
  },
  {
    name: 'viewport', section: 'page', min: 1, flags: ['dpr'], usage: [
      { syntax: 'viewport <w> <h> [--dpr n]', help: 'real viewport resize' },
      { syntax: 'viewport reset', help: 'undo viewport' },
    ],
  },
  { name: 'eval', section: 'page', min: 1, usage: [{ syntax: 'eval <js>', help: 'run page JavaScript (awaits promises)' }] },
  { name: 'get', section: 'page', min: 2, usage: [{ syntax: 'get text|html <sel|@ref>', help: 'element text or inner HTML' }] },
  { name: 'storage', section: 'page', min: 2, usage: [{ syntax: 'storage get|set|clear local|session <key> [value]' }] },
  { name: 'scrollintoview', section: 'page', min: 1, usage: [{ syntax: 'scrollintoview <sel|@ref>' }] },

  {
    name: 'click', section: 'interact', min: 1, flags: ['force'], usage: [
      { syntax: 'click <sel|@ref> [--force]', help: 'trusted click at center, or a visible part if the\ncenter is covered; --force: center anyway' },
    ],
  },
  { name: 'fill', section: 'interact', min: 2, usage: [{ syntax: 'fill <sel|@ref> <text>', help: 'clear + set value, fires input/change;\ncontenteditable: select-all + trusted insert' }] },
  { name: 'type', section: 'interact', min: 2, flags: ['delay'], usage: [{ syntax: 'type <sel|@ref> <text> [--delay ms]', help: 'real keystrokes, default delay 15ms' }] },
  { name: 'press', section: 'interact', min: 1, usage: [{ syntax: 'press <key[+mod…]>', help: 'key or shortcut: Escape, Meta+a' }] },
  { name: 'select', section: 'interact', min: 2, usage: [{ syntax: 'select <sel|@ref> <value|label>' }] },
  {
    name: 'find', section: 'interact', min: 2, flags: ['name', 'nth', 'action', 'force'], usage: [
      { syntax: 'find role <role> [--name <s>] [--nth N] [click|show]' },
      { syntax: 'find label <accessible name> [--nth N] [click|show]' },
      { syntax: 'find text <text> [--nth N] [click|show]' },
    ],
    notes: ['--nth N: Nth match, 1-based'],
  },

  {
    name: 'mouse', section: 'mouse', min: 1, flags: ['duration', 'steps', 'human', 'seed'], usage: [
      { syntax: 'mouse move <x> <y> [--duration ms] [--steps n] [--human --seed n]' },
      { syntax: 'mouse down [left|right|middle] | mouse up [button]' },
      { syntax: 'mouse wheel <dy> [dx]' },
    ],
  },

  {
    name: 'tab', section: 'tabs (inside the session)', flags: ['label', 'raw'], usage: [
      { syntax: 'tab', help: 'list tabs (tN, tabId, label)' },
      { syntax: 'tab new [url] [--label L]', help: 'new tab in the session group' },
      { syntax: 'tab <tN|label|tabId|title>', help: 'switch' },
      { syntax: 'tab close [tN|label|tabId]', help: 'close (defaults to active)' },
    ],
  },

  { name: 'console', section: 'console', flags: ['clear', 'since-nav', 'raw'], usage: [{ syntax: 'console [--clear] [--since-nav]', help: 'console messages' }] },
  { name: 'errors', section: 'console', flags: ['clear', 'since-nav', 'raw'], usage: [{ syntax: 'errors [--clear] [--since-nav]', help: 'page errors' }], notes: ['--since-nav: since last page load'] },

  {
    name: 'network', section: 'network', min: 1,
    flags: ['abort', 'body', 'status', 'method', 'times', 'header', 'content-type', 'resource-type', 'clear', 'filter', 'type', 'raw'],
    usage: [
      { syntax: 'network route <pattern> [--abort] [--body json] [--status n] [--method M] [--times n] [--header "K: v"] [--content-type ct] [--resource-type t]',
        help: '--status alone: empty body; --times N: expire after N matches;\nCORS preflights answered, Origin echoed (credentialed mocks work)' },
      { syntax: 'network unroute [pattern]' },
      { syntax: 'network requests [--clear] [--filter pat] [--type xhr,fetch] [--method POST] [--status 2xx|200|400-499]' },
      { syntax: 'network request <n|id>', help: 'headers + bodies of one request' },
    ],
  },
]

/** name or alias → spec @type {Map<string, CommandSpec>} */
export const COMMAND = new Map()
for (const c of COMMANDS) for (const n of [c.name, ...(c.aliases || [])]) COMMAND.set(n, c)

/** @param {CommandSpec} c */
export const usage = (c) => 'usage: ' + c.usage.map((u) => u.syntax).join('\n       ')

const COL = 34
const indent = (s) => s.split('\n').join('\n' + ' '.repeat(COL))

// the command reference, as printed by `help` and embedded in the README
export function renderCommands() {
  const out = []
  for (const sec of [...new Set(COMMANDS.map((c) => c.section))]) {
    if (out.length) out.push('')
    out.push(sec + ':')
    for (const c of COMMANDS) {
      if (c.section !== sec) continue
      for (const { syntax, help } of c.usage) {
        if (!help) out.push('  ' + syntax)
        else if (syntax.length + 2 < COL) out.push(('  ' + syntax).padEnd(COL) + indent(help))
        else out.push('  ' + syntax + '\n' + ' '.repeat(COL) + indent(help))
      }
      for (const n of c.notes || []) out.push(' '.repeat(COL) + '(' + n + ')')
    }
  }
  out.push(
    '',
    'global flags: -s/--session NAME (or CTRL_BROWSE_SESSION), --json, --timeout ms, --version',
    '--raw (snapshot, tab, console, errors, network): show token-like url params, auth headers',
    'selectors: CSS, or @eN refs from snapshot/find',
    'text starting with "-": put it after --, e.g. fill #q -- --verbose',
  )
  return out.join('\n')
}

export function helpText() {
  return [
    'ctrl-browse — control your existing browser. Every command is scoped to a named',
    'session, and each session is bound to a Chrome tab group with the same name.',
    '',
    'usage: ctrl-browse -s <session> <command> [args] [flags]',
    '',
    renderCommands(),
  ].join('\n')
}
