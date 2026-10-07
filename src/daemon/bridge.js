// rpc link to the Chrome extension (set by the ws server on "hello")
import { sleep } from './util.js'

export let ext = null
let reqSeq = 1
export const pendingRpcs = new Map()

export function rpc(cmd, payload = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (!ext) return reject(new Error('browser not connected — open Chrome with the ctrl-browse extension loaded (see README)'))
    const id = reqSeq++
    const entry = { resolve, reject }
    entry.timer = setTimeout(() => { pendingRpcs.delete(id); reject(new Error(`extension rpc timeout: ${cmd}`)) }, timeout)
    pendingRpcs.set(id, entry)
    ext.send(JSON.stringify({ id, cmd, ...payload }))
  })
}

export async function waitBrowser(ms = 30000) {
  if (ext) return
  const t0 = Date.now()
  while (!ext) {
    if (Date.now() - t0 > ms) throw new Error('browser not connected — open Chrome with the ctrl-browse extension loaded (see README)')
    await sleep(200)
  }
}
export function setExt(ws) { ext = ws }
