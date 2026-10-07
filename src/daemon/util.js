// shared constants and small pure helpers
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, manifest, once, errMsg } from '../common.js'
export { errMsg }

// only our own extension may connect: its id derives from the manifest "key"
// (sha256 of the public key, first 32 hex digits mapped to a-p), so a fork
// that changes the key keeps working. CTRL_BROWSE_EXTENSION_ID overrides it
export function extensionId(key) {
  const hex = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  return hex.replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)))
}
export const extOrigin = once(() => 'chrome-extension://' + (process.env.CTRL_BROWSE_EXTENSION_ID || extensionId(manifest().key)))

// in-page scripts (src/scripts/*.js): function expressions run via Runtime.evaluate
const scripts = new Map()
/** @param {'md'|'page'|'actions'} name */
export function script(name) {
  if (!scripts.has(name)) scripts.set(name, fs.readFileSync(path.join(ROOT, 'src', 'scripts', name + '.js'), 'utf8'))
  return scripts.get(name)
}

export const GROUP_COLORS = ['blue', 'cyan', 'green', 'orange', 'pink', 'purple', 'red', 'teal', 'yellow', 'grey']
export const RES = {
  document: 'Document', stylesheet: 'Stylesheet', css: 'Stylesheet', image: 'Image', media: 'Media',
  font: 'Font', script: 'Script', xhr: 'XHR', fetch: 'Fetch', websocket: 'WebSocket',
  manifest: 'Manifest', ping: 'Ping', preflight: 'Preflight', other: 'Other',
}

export const MAX_REQUESTS = 500, MAX_CONSOLE = 500, MAX_ERRORS = 300
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const cap = (a, n) => { if (a.length > n) a.splice(0, a.length - n) }
export const tsf = (t) => { const d = new Date(t || Date.now()); return d.toTimeString().slice(0, 8) }
/** integer flag with a default — "--timeout abc" must not become NaN (= no timeout) */
/** @param {string|undefined} v @param {number} d */
export const int = (v, d) => { const n = parseInt(v ?? '', 10); return Number.isFinite(n) ? n : d }
/** @param {string|undefined} v @param {number} d */
export const num = (v, d) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : d }

// for errors we deliberately survive: keep them visible in ~/.ctrl-browse/daemon.log
export const warn = (what) => (e) => { console.error(`[ctrl-browse] ${what}:`, errMsg(e)) }

// "localhost:3000" and "example.com/x" get http://; real schemes pass through.
// (an unqualified url reaching chrome.tabs.create resolves against the extension)
const NO_SLASH_SCHEMES = /^(about|data|javascript|blob|mailto|tel|view-source|chrome|chrome-extension|file):/i
export function normalizeUrl(u) {
  u = String(u).trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || NO_SLASH_SCHEMES.test(u)) return u
  return 'http://' + u
}

export function globToRegex(g, { anchored = true, ignoreCase = false } = {}) {
  const src = String(g).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(anchored ? `^${src}$` : src, ignoreCase ? 'i' : '')
}

export function statusMatch(spec, status) {
  return String(spec).split(',').some((part) => {
    part = part.trim().toLowerCase()
    if (!part) return false
    if (part.endsWith('xx')) { const c = parseInt(part[0], 10); return status >= c * 100 && status < (c + 1) * 100 }
    if (part.includes('-')) { const [a, b] = part.split('-').map(Number); return status >= a && status <= b }
    return status === parseInt(part, 10)
  })
}

export const hval = (h, name) => { for (const k in h || {}) if (k.toLowerCase() === name) return h[k]; return '' }

// tokens/credentials never reach summary output unless --raw is passed
export const SECRET_URL = /([?&][^?&#=]*(?:token|auth|key|pwd|pass|secret|sig)[^?&#=]*=)[^&#]*/gi
export const SECRET_HEADER = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key)$/i
export const redactUrl = (u) => String(u).replace(SECRET_URL, '$1[REDACTED]')
export const redactHeaders = (hs) => hs && Object.fromEntries(Object.entries(hs).map(([k, v]) => [k, SECRET_HEADER.test(k) ? '[REDACTED]' : v]))
