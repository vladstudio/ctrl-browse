// command registry: name → handler(session, args, flags). Names, arity and
// usage text come from src/spec.js, which the CLI's help is built from too.
import { COMMAND, usage } from '../spec.js'
import { PORT, version } from '../common.js'
import { sleep, normalizeUrl } from './util.js'
import { sessions } from './state.js'
import { ext, rpc, codeProblem } from './bridge.js'
import { quit } from './cdp.js'
import { ensureSession } from './sessions.js'
import { gotoCmd, historyCmd, waitCmd } from './nav.js'
import { domCmd, snapshotCmd, screenshotCmd, viewportCmd, storageCmd, evalCmd, scrollCmd, getCmd, findCmd } from './content.js'
import { clickCmd, fillCmd, typeCmd, pressCmd, selectCmd, mouseCmd } from './input.js'
import { closeCmd, tabCmd } from './tabs.js'
import { consoleCmd, errorsCmd } from './logs.js'
import { networkCmd } from './network.js'

/**
 * @typedef {{ text?: string, data?: any }} Result
 * @typedef {import('../spec.js').Flags} Flags
 * @typedef {(s: import('./state.js').Session, args: string[], flags: Flags) => Result | Promise<Result>} Handler
 */

/** @type {Record<string, Handler>} */
export const HANDLERS = {
  goto: gotoCmd,
  close: closeCmd,
  back: (s, a, f) => historyCmd(s, 'back', f),
  forward: (s, a, f) => historyCmd(s, 'forward', f),
  reload: (s, a, f) => historyCmd(s, 'reload', f),
  wait: waitCmd,
  dom: domCmd,
  snapshot: snapshotCmd,
  screenshot: screenshotCmd,
  viewport: viewportCmd,
  eval: evalCmd,
  get: getCmd,
  storage: storageCmd,
  scrollintoview: scrollCmd,
  click: (s, a, f) => clickCmd(s, a[0], f),
  fill: (s, a) => fillCmd(s, a[0], a.slice(1).join(' ')),
  type: (s, a, f) => typeCmd(s, a[0], a.slice(1).join(' '), f),
  press: (s, a) => pressCmd(s, a[0]),
  select: (s, a) => selectCmd(s, a[0], a.slice(1).join(' ')),
  find: findCmd,
  mouse: mouseCmd,
  tab: tabCmd,
  console: consoleCmd,
  errors: errorsCmd,
  network: networkCmd,
}

/** commands that need no session @type {Record<string, () => Promise<Result>>} */
export const GLOBAL_HANDLERS = {
  async shutdown() {
    setTimeout(quit, 100)
    return { text: 'daemon shutting down', data: { managed: !!process.env.CTRL_BROWSE_MANAGED } }
  },
  async status() {
    // give the extension's service worker a moment to wake up and connect
    const t0 = Date.now()
    while (!ext && Date.now() - t0 < 8000) await sleep(250)
    const problem = codeProblem()
    const browser = !ext
      ? 'not connected (open Chrome with the ctrl-browse extension loaded — it connects within ~30s of the daemon starting)'
      : problem ? `connected, but ${problem}` : 'connected'
    return {
      text: `daemon: v${version()}, pid ${process.pid} on 127.0.0.1:${PORT}${process.env.CTRL_BROWSE_MANAGED ? ' (launchagent)' : ''}\n` +
        `browser: ${browser}\nsessions: ${sessions.size ? [...sessions.keys()].join(', ') : '(none)'}`,
      data: { version: version(), connected: !!ext, problem, sessions: [...sessions.keys()] },
    }
  },
  async sessions() {
    const out = []
    for (const s of sessions.values()) {
      let n = '?'
      try { n = (await rpc('tabs.query', { query: { groupId: s.groupId } }, 5000)).length } catch {} // shown as "?"
      out.push(`${s.name}  groupId=${s.groupId}  tabs=${n}`)
    }
    return { text: out.length ? out.join('\n') : 'no sessions', data: { sessions: [...sessions.keys()] } }
  },
}

/** @param {{ session?: string|null, cmd: string, args?: string[], flags?: Flags }} m @returns {Promise<Result>} */
export async function dispatch({ session, cmd, args = [], flags = {} }) {
  const spec = COMMAND.get(cmd)
  if (!spec || spec.local) throw new Error(`unknown command: ${cmd} — run "ctrl-browse help"`)
  if (args.length < (spec.min || 0)) throw new Error(usage(spec))
  if (spec.session === false) return GLOBAL_HANDLERS[spec.name]()
  if (!session) throw new Error('missing session — pass -s <name> (or set CTRL_BROWSE_SESSION)')
  if (spec.url) args = [normalizeUrl(args[0]), ...args.slice(1)]
  const s = await ensureSession(session, { create: spec.name !== 'close', url: spec.url ? args[0] : undefined })
  return HANDLERS[spec.name](s, args, flags)
}
