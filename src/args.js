// argv → { cmd, args, flags, session }
import { FLAGS, GLOBAL_FLAGS, SHORT_FLAGS, COMMAND } from './spec.js'

/**
 * @typedef {{ cmd: string|null, args: string[], flags: import('./spec.js').Flags, session: string|null }} Parsed
 * @param {string[]} argv
 * @returns {Parsed}
 */
export function parse(argv) {
  /** @type {Parsed} */
  const out = { cmd: null, args: [], flags: {}, session: null }
  /** @type {Record<string, any>} */
  const flags = out.flags
  const positional = (a) => { if (!out.cmd) out.cmd = a; else out.args.push(a) }
  const takes = (name) => { const c = out.cmd ? COMMAND.get(out.cmd) : undefined; return !!c && (c.flags || []).includes(name) }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { argv.slice(i + 1).forEach(positional); break } // the rest is literal text
    if (a.startsWith('--')) {
      let name = a.slice(2)
      /** @type {string|true|undefined} */
      let val
      const eq = name.indexOf('=')
      if (eq !== -1) { val = name.slice(eq + 1); name = name.slice(0, eq) }
      if (name === 'session') {
        if (val === undefined && i + 1 >= argv.length) throw new Error('--session needs a name')
        out.session = typeof val === 'string' ? val : argv[++i]
        continue
      }
      const kind = FLAGS[/** @type {keyof typeof FLAGS} */ (name)]
      if (!kind || name === 'i') throw new Error(`unknown flag --${name} (to pass text that starts with "-", put it after --)`)
      if (val === undefined) {
        if (kind === 'bool' || kind === 'opt') val = true
        else if (i + 1 >= argv.length) throw new Error(`--${name} needs a value`)
        else val = argv[++i]
      } else if (kind === 'bool') throw new Error(`--${name} takes no value`)
      if (kind === 'list') (flags[name] = flags[name] || []).push(val)
      else flags[name] = val
      continue
    }
    if (a === '-s') {
      if (i + 1 >= argv.length) throw new Error('-s needs a session name')
      out.session = argv[++i]
      continue
    }
    // -h/-v only before the command, -i only for commands that take it:
    // anywhere else a short dash-word is text ("fill #q -h")
    const short = /^-([a-z])$/i.exec(a)
    const name = short && SHORT_FLAGS[short[1]]
    if (name && (GLOBAL_FLAGS.includes(name) ? !out.cmd : !out.cmd || takes(name))) { flags[name] = true; continue }
    positional(a)
  }
  const c = out.cmd ? COMMAND.get(out.cmd) : undefined
  if (c) {
    for (const f of Object.keys(flags)) {
      if (!GLOBAL_FLAGS.includes(/** @type {any} */ (f)) && !(c.flags || []).includes(/** @type {any} */ (f))) {
        throw new Error(`--${f} is not a flag of "${c.name}" — see ctrl-browse help`)
      }
    }
  }
  return out
}
