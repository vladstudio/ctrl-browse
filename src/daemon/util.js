// shared constants and small pure helpers
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PORT = parseInt(process.env.CTRL_BROWSE_PORT || '9876', 10)
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const STATE_DIR = path.join(os.homedir(), '.ctrl-browse')
export const STATE_FILE = path.join(STATE_DIR, 'state.json')

// only our own extension may connect: its id derives from the manifest "key"
// (sha256 of the public key, first 32 hex digits mapped to a-p), so a fork
// that changes the key keeps working. CTRL_BROWSE_EXTENSION_ID overrides it
function extensionId() {
  const { key } = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'extension', 'manifest.json'), 'utf8'))
  const hex = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  return hex.replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)))
}
export const EXT_ORIGIN = 'chrome-extension://' + (process.env.CTRL_BROWSE_EXTENSION_ID || extensionId())
export const MD_SRC = fs.readFileSync(path.join(HERE, '..', 'scripts', 'md.js'), 'utf8')
export const PAGE_SRC = fs.readFileSync(path.join(HERE, '..', 'scripts', 'page.js'), 'utf8')

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

// tokens/credentials never reach command output unless --raw is passed
export const SECRET_URL = /([?&][^?&#=]*(?:token|auth|key|pwd|pass|secret|sig)[^?&#=]*=)[^&#]*/gi
export const SECRET_HEADER = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key)$/i
export const redactUrl = (u) => String(u).replace(SECRET_URL, '$1[REDACTED]')
export const redactHeaders = (hs) => hs && Object.fromEntries(Object.entries(hs).map(([k, v]) => [k, SECRET_HEADER.test(k) ? '[REDACTED]' : v]))

export const selExpr = (sel) =>
  sel.startsWith('@')
    ? `document.querySelector('[data-cb-ref="${sel.slice(1).replace(/"/g, '')}"]')`
    : `document.querySelector(${JSON.stringify(sel)})`
