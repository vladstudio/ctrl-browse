// console and page-error logs
import { tsf, redactUrl } from './util.js'
import { peekTab } from './tabstate.js'

/** @typedef {import('./state.js').Session} Session */

const sinceNav = (flags) => (e) => !flags['since-nav'] || e.ts >= ((peekTab(e.tabId) || {}).navTs || 0)

/** @param {Session} s @param {import('../spec.js').Flags} flags */
export function consoleCmd(s, args, flags) {
  if (flags.clear) { s.console = []; return { text: 'console cleared' } }
  const list = s.console.filter(sinceNav(flags)).slice(-200)
    .map((e) => (flags.raw ? e : { ...e, text: redactUrl(e.text) }))
  if (flags.json) return { text: 'ok', data: { entries: list } }
  return {
    text: list.length
      ? list.map((e) => `${tsf(e.ts)}  ${String(e.type).padEnd(8)} ${String(e.text).slice(0, 200)}`).join('\n')
      : 'no console messages (only tabs touched by commands are tracked)',
  }
}

/** @param {Session} s @param {import('../spec.js').Flags} flags */
export function errorsCmd(s, args, flags) {
  if (flags.clear) { s.errors = []; return { text: 'errors cleared' } }
  const list = s.errors.filter(sinceNav(flags)).slice(-100)
    .map((e) => (flags.raw ? e : { ...e, text: redactUrl(e.text) }))
  return {
    text: list.length
      ? list.map((e) => `${tsf(e.ts)}  ${e.text}`).join('\n')
      : 'no page errors (only tabs touched by commands are tracked)',
    data: { entries: list },
  }
}
