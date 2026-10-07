// reading and shaping the page: dom, snapshot, find, screenshot, viewport, eval, get, storage
import { int, num, redactUrl } from './util.js'
import { cdp, evalJS, pageCall, pageScript } from './cdp.js'
import { resolveTab } from './sessions.js'
import { clickCmd } from './input.js'

/** @typedef {import('./state.js').Session} Session */

export function renderSnapshot(res) {
  const L = [`page: ${res.title}`, `url: ${res.url}`, '']
  for (const e of res.elements || []) {
    const bits = []
    if (e.text) bits.push(`"${e.text}"`)
    if (e.name) bits.push(`name="${e.name}"`)
    if (e.value !== undefined) bits.push(`value="${e.value}"`)
    if (e.type) bits.push(`(${e.type})`)
    if (e.href) bits.push(e.href)
    if (e.checked) bits.push('[x]')
    if (e.disabled) bits.push('[disabled]')
    for (const a of ['pressed', 'expanded', 'selected']) if (e[a]) bits.push(`[${a}=${e[a]}]`)
    L.push(`@${String(e.ref).padEnd(6)}${String(e.role).padEnd(10)}${bits.join(' ').slice(0, 150)}`)
  }
  if (!res.elements || !res.elements.length) L.push('(no matching elements)')
  L.push('', 'use @refs with click/fill/type/select — e.g. click @e3')
  return L.join('\n')
}

/** @param {Session} s @param {import('../spec.js').Flags} flags */
export async function domCmd(s, args, flags) {
  const tab = await resolveTab(s)
  const html = String(await pageCall(s, tab.id, 'dom'))
  const limit = int(flags.limit, 200000)
  const out = html.slice(0, limit)
  return { text: out + (html.length > limit ? `\n\n[truncated at ${limit} chars]` : ''), data: { html: out } }
}

/** @param {Session} s @param {import('../spec.js').Flags} flags */
export async function snapshotCmd(s, args, flags) {
  const tab = await resolveTab(s)
  const res = await pageScript(s, tab.id, 'page', { interactive: !!flags.i, limit: int(flags.limit, 150) })
  if (!flags.raw) {
    res.url = redactUrl(res.url)
    for (const e of res.elements || []) if (e.href) e.href = redactUrl(e.href)
  }
  return { text: renderSnapshot(res), data: res }
}

/** @param {Session} s @param {import('../spec.js').Flags} flags */
export async function screenshotCmd(s, args, flags) {
  const tab = await resolveTab(s)
  const r = await pageCall(s, tab.id, 'clip', { el: flags.el, full: !!flags.full, pad: num(flags.pad, 0) })
  if (!r) throw new Error(`element not found: ${flags.el}`)
  // clip is in document coords; CDP rejects a clip without scale, or scale > 2
  const { dpr, ...clip } = r
  const maxWidth = num(flags['max-width'], Infinity)
  clip.scale = Math.min(2, num(flags.scale, 1), maxWidth / (clip.width * dpr) || 1)
  const shot = await cdp(s, tab.id, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!(flags.full || flags.el), clip }, 20000)
  return { text: 'ok', data: { bytes: shot.data } }
}

const VIEWPORT_USAGE = 'usage: viewport <w> <h> [--dpr n] | viewport reset'
/** @param {Session} s @param {import('../spec.js').Flags} flags */
export async function viewportCmd(s, args, flags) {
  const tab = await resolveTab(s)
  if (args[0] === 'reset') { await cdp(s, tab.id, 'Emulation.clearDeviceMetricsOverride'); return { text: 'viewport reset' } }
  const w = int(args[0], 0), h = int(args[1], 0)
  if (!w || !h) throw new Error(VIEWPORT_USAGE)
  const dpr = num(flags.dpr, NaN)
  await cdp(s, tab.id, 'Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: isNaN(dpr) ? 0 : dpr, mobile: false })
  return { text: `viewport ${w}×${h}${isNaN(dpr) ? '' : ` dpr ${dpr}`}` }
}

const STORAGE_USAGE = 'usage: storage get|set|clear local|session <key> [value]'
/** @param {Session} s */
export async function storageCmd(s, args) {
  const [sub, kind, key] = args
  if (!['get', 'set', 'clear'].includes(sub) || !['local', 'session'].includes(kind) || (sub !== 'clear' && !key)) throw new Error(STORAGE_USAGE)
  const tab = await resolveTab(s)
  const name = kind + 'Storage'
  const v = await pageCall(s, tab.id, 'storage', { sub, kind, key, value: args.slice(3).join(' ') })
  if (sub === 'get') return { text: String(v), data: { key, value: v } }
  if (sub === 'set') return { text: `set ${name}.${key}` }
  return { text: `cleared ${name}${key ? `.${key}` : ''}` }
}

/** @param {Session} s */
export async function evalCmd(s, args) {
  const tab = await resolveTab(s)
  const v = await evalJS(s, tab.id, args.join(' '))
  let text
  try { text = typeof v === 'string' ? v : v === undefined ? 'undefined' : JSON.stringify(v, null, 2) } catch { text = String(v) }
  return { text, data: { result: v } }
}

/** @param {Session} s */
export async function scrollCmd(s, args) {
  const tab = await resolveTab(s)
  if (!(await pageCall(s, tab.id, 'scroll', { sel: args[0] }))) throw new Error(`element not found: ${args[0]}`)
  return { text: `scrolled into view: ${args[0]}` }
}

/** @param {Session} s */
export async function getCmd(s, args) {
  const [what, sel] = args
  if ((what !== 'text' && what !== 'html') || !sel) throw new Error('usage: get text <sel> | get html <sel>')
  const tab = await resolveTab(s)
  const r = await pageCall(s, tab.id, 'get', { sel, what })
  if (r === null) throw new Error(`element not found: ${sel}`)
  return { text: String(r), data: what === 'text' ? { text: r } : { html: r } }
}

/** @param {Session} s @param {import('../spec.js').Flags} flags */
export async function findCmd(s, args, flags) {
  let a = [...args]
  let action = flags.action
  const last = a[a.length - 1]
  if (!action && (last === 'click' || last === 'show')) { action = last; a = a.slice(0, -1) }
  action = action || 'show'
  const kind = a[0]
  if (!['role', 'text', 'label'].includes(kind)) throw new Error('usage: find role <role> [--name <s>] | find label <accessible name> | find text <text>  [--nth N] [click|show]')
  const needle = kind === 'role' ? a[1] : a.slice(1).join(' ')
  if (!needle) throw new Error(`missing ${kind}`)
  const tab = await resolveTab(s)
  const res = (await pageScript(s, tab.id, 'page', { find: { kind, needle, name: flags.name } })) || []
  // --nth is 1-based, matching the numbers in the listing
  const nth = flags.nth === undefined ? null : parseInt(flags.nth, 10)
  if (nth !== null && !(nth >= 1)) throw new Error('--nth takes a 1-based index, e.g. --nth 2')
  if (nth !== null && nth > res.length) throw new Error(`--nth ${nth}, but only ${res.length} match${res.length === 1 ? '' : 'es'} for ${kind} "${needle}"`)
  const pick = nth || 1
  let text = res.length ? res.map((e, i) => `${String(i + 1).padStart(2)}${nth === i + 1 ? '*' : ' '} @${e.ref}  ${String(e.role).padEnd(9)} ${e.text || ''}`).join('\n') : 'no matches'
  if (action === 'click') {
    if (!res.length) throw new Error(`no match for ${kind} "${needle}" — cannot click`)
    if (res.length > 1 && !nth) text += `\n${res.length} matches — clicked the first (add --nth N to target another)`
    const r = await clickCmd(s, '@' + res[pick - 1].ref, flags)
    text += `\n${r.text}`
  }
  return { text, data: { matches: res } }
}
