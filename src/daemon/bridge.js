// rpc link to the Chrome extension (set by the ws server on "hello")
import fs from 'node:fs'
import { sleep } from './util.js'
import { BRIDGE_FILE, bridgeHash, once } from '../common.js'

const NOT_CONNECTED = 'browser not connected — open Chrome with the ctrl-browse extension loaded (see README)'

/** @type {import('ws').WebSocket | null} */
export let ext = null
/** @type {string|null} code stamp the connected extension reported */
export let extCode = null
let reqSeq = 1
/** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
export const pendingRpcs = new Map()

/** @param {import('ws').WebSocket | null} ws @param {string|null} [code] */
export function setExt(ws, code = null) { ext = ws; extCode = code }

// what the extension on disk should report (read once: a daemon whose files
// changed is restarted by the CLI anyway)
export const expectedCode = once(() => bridgeHash(fs.readFileSync(BRIDGE_FILE, 'utf8')))

// Chrome loads the unpacked extension from this checkout but only re-reads it
// when the user clicks reload — after a pull it can run an older bridge
export function codeProblem() {
  if (!ext || extCode === expectedCode()) return null
  return 'Chrome is running an older ctrl-browse extension than the one on disk — click reload on "ctrl-browse bridge" at chrome://extensions'
}

// detaching is safe with any bridge version, and shutdown must always be able to release tabs
const ANY_VERSION = new Set(['debug.detach'])

/** @returns {Promise<any>} */
export function rpc(cmd, payload = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (!ext) return reject(new Error(NOT_CONNECTED))
    const problem = ANY_VERSION.has(cmd) ? null : codeProblem()
    if (problem) return reject(new Error(problem))
    const id = reqSeq++
    const timer = setTimeout(() => { pendingRpcs.delete(id); reject(new Error(`extension rpc timeout: ${cmd}`)) }, timeout)
    pendingRpcs.set(id, { resolve, reject, timer })
    ext.send(JSON.stringify({ id, cmd, ...payload }))
  })
}

export function settleRpc(m) {
  const e = pendingRpcs.get(m.id)
  if (!e) return false
  pendingRpcs.delete(m.id)
  clearTimeout(e.timer)
  if (m.ok) e.resolve(m.result)
  else e.reject(new Error(m.error || 'extension error'))
  return true
}

// fail in-flight calls immediately instead of letting them hang to their timeout
export function failPending(msg) {
  for (const [, e] of pendingRpcs) { clearTimeout(e.timer); e.reject(new Error(msg)) }
  pendingRpcs.clear()
}

export async function waitBrowser(ms = 30000) {
  const t0 = Date.now()
  while (!ext) {
    if (Date.now() - t0 > ms) throw new Error(NOT_CONNECTED)
    await sleep(200)
  }
}
