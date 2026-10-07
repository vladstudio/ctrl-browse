#!/usr/bin/env node
// ctrl-browse daemon — bridges the CLI and the Chrome extension.
// Listens on 127.0.0.1:<PORT>; the extension connects as a ws client and
// executes chrome.tabs/tabGroups/debugger (CDP) calls on our behalf.

import { WebSocketServer } from 'ws'
import { PORT, EXT_ORIGIN } from './daemon/util.js'
import { ext, setExt, pendingRpcs } from './daemon/bridge.js'
import { attached, quit } from './daemon/cdp.js'
import { handleEvent } from './daemon/events.js'
import { mousePos } from './daemon/input.js'
import { dispatch } from './daemon/commands.js'

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: PORT,
  verifyClient: (info) => {
    // no Origin: the CLI (local processes are trusted, like a devtools port).
    // Web pages and every other extension send their own Origin and are refused
    const o = info.origin || (info.req && info.req.headers.origin)
    return !o || o === EXT_ORIGIN
  },
})
wss.on('error', (e) => { console.error('[ctrl-browse] daemon error:', e.message); process.exit(1) })

async function handleCli(m, ws) {
  const reply = (r) => { try { ws.send(JSON.stringify({ id: m.id, ...r })) } catch {} }
  try {
    const needsSession = !['sessions', 'status', 'shutdown'].includes(m.cmd)
    if (needsSession && !m.session) throw new Error('missing session — pass -s <name> (or set CTRL_BROWSE_SESSION)')
    const out = await dispatch(m.session, m.cmd, m.args || [], m.flags || {})
    reply({ ok: true, text: out.text, data: out.data })
  } catch (e) {
    reply({ ok: false, error: (e && e.message) || String(e) })
  }
}

wss.on('connection', (ws, req) => {
  const fromExt = req.headers.origin === EXT_ORIGIN
  let isExt = false
  ws.on('message', (data) => {
    let m
    try { m = JSON.parse(String(data)) } catch { return }
    if (m && m.id !== undefined && pendingRpcs.has(m.id)) {
      const e = pendingRpcs.get(m.id)
      pendingRpcs.delete(m.id)
      clearTimeout(e.timer)
      if (m.ok) e.resolve(m.result)
      else e.reject(new Error(m.error || 'extension error'))
      return
    }
    if (m && m.type === 'cli') { handleCli(m, ws).catch(() => {}); return }
    if (m && m.event === 'hello' && fromExt) {
      // fresh extension session (e.g. SW restart) — its debugger attaches are gone
      isExt = true; setExt(ws); attached.clear(); mousePos.clear()
      console.log('[ctrl-browse] browser extension connected'); return
    }
    if (isExt) {
      if (m && m.event === 'ping') { try { ws.send('{"event":"pong"}') } catch {} ; return }
      if (m && m.event) { try { handleEvent(m) } catch (e) { console.error('[ctrl-browse] event error:', e && e.message) } ; return }
      return
    }
  })
  ws.on('close', () => {
    if (isExt && ext === ws) {
      setExt(null)
      // fail in-flight commands immediately instead of letting them hang to timeout
      for (const [, e] of pendingRpcs) { clearTimeout(e.timer); e.reject(new Error('browser connection lost')) }
      pendingRpcs.clear()
      console.log('[ctrl-browse] browser extension disconnected')
    }
  })
})

// keepalive so the MV3 service worker doesn't get suspended
setInterval(() => { if (ext) { try { ext.send(JSON.stringify({ event: 'ping' })) } catch {} } }, 20000).unref?.()

process.on('SIGTERM', quit)
process.on('SIGINT', quit)
process.on('uncaughtException', (e) => { console.error('[ctrl-browse] fatal:', (e && e.message) || e); process.exit(1) })
process.on('unhandledRejection', (e) => console.error('[ctrl-browse] async error:', (e && e.message) || e))
console.log(`[ctrl-browse] daemon listening on 127.0.0.1:${PORT}`)
