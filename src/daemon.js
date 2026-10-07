#!/usr/bin/env node
// ctrl-browse daemon — bridges the CLI and the Chrome extension.
// Listens on 127.0.0.1:<PORT>; the extension connects as a ws client and
// executes chrome.tabs/tabGroups/debugger (CDP) calls on our behalf.

import { WebSocketServer } from 'ws'
import { PORT, version, sourceHash } from './common.js'
import { extOrigin, errMsg } from './daemon/util.js'
import { loadState, flushState } from './daemon/state.js'
import { ext, setExt, settleRpc, failPending } from './daemon/bridge.js'
import { quit } from './daemon/cdp.js'
import { resetAllTabs } from './daemon/tabstate.js'
import { handleEvent } from './daemon/events.js'
import { dispatch } from './daemon/commands.js'

loadState()
process.on('exit', flushState)
// the code this daemon runs; a CLI that hashes different files on disk gets it restarted
const CODE = sourceHash()

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: PORT,
  verifyClient: (info) => {
    // no Origin: a local process (trusted, like a devtools port — see README
    // "Security model"). Web pages and other extensions send their own Origin
    const o = info.origin || info.req.headers.origin
    return !o || o === extOrigin()
  },
})
wss.on('error', (e) => { console.error('[ctrl-browse] daemon error:', e.message); process.exit(1) })

async function handleCli(m, ws) {
  const reply = (r) => { try { ws.send(JSON.stringify({ id: m.id, code: CODE, ...r })) } catch {} } // CLI already gone
  // the files changed since this daemon started (git pull, local edit): it
  // must not run the command with stale code. It exits; the CLI starts a
  // fresh one (or launchd restarts it) and resends
  if (m.code && m.code !== CODE) {
    reply({ ok: false, stale: true, managed: !!process.env.CTRL_BROWSE_MANAGED, error: 'daemon code is stale' })
    setTimeout(quit, 50)
    return
  }
  try {
    const out = await dispatch(m)
    reply({ ok: true, text: out.text, data: out.data })
  } catch (e) {
    reply({ ok: false, error: errMsg(e) })
  }
}

wss.on('connection', (ws, req) => {
  const fromExt = req.headers.origin === extOrigin()
  let isExt = false
  ws.on('message', (data) => {
    let m
    try { m = JSON.parse(String(data)) } catch { return }
    if (!m || typeof m !== 'object') return
    if (isExt && m.id !== undefined && settleRpc(m)) return
    if (m.type === 'cli' && !fromExt) { handleCli(m, ws); return }
    if (m.event === 'hello' && fromExt) {
      // fresh extension session (e.g. SW restart) — its debugger attaches are gone
      isExt = true; setExt(ws, m.code || null); resetAllTabs()
      console.log(`[ctrl-browse] browser extension connected (code ${m.code || 'unstamped'})`)
      return
    }
    if (!isExt) return
    if (m.event === 'ping') { try { ws.send('{"event":"pong"}') } catch {} ; return }
    if (m.event) { try { handleEvent(m) } catch (e) { console.error('[ctrl-browse] event error:', errMsg(e)) } }
  })
  ws.on('close', () => {
    if (isExt && ext === ws) {
      setExt(null)
      failPending('browser connection lost')
      console.log('[ctrl-browse] browser extension disconnected')
    }
  })
})

// keepalive so the MV3 service worker doesn't get suspended
setInterval(() => { if (ext) { try { ext.send(JSON.stringify({ event: 'ping' })) } catch {} } }, 20000).unref?.()

process.on('SIGTERM', quit)
process.on('SIGINT', quit)
process.on('uncaughtException', (e) => { console.error('[ctrl-browse] fatal:', e.stack || e); process.exit(1) })
process.on('unhandledRejection', (e) => console.error('[ctrl-browse] async error:', e instanceof Error ? e.stack : e))
wss.on('listening', () => console.log(`[ctrl-browse] daemon v${version()} listening on 127.0.0.1:${PORT}`))
