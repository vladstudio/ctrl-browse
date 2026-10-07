#!/usr/bin/env node
// ctrl-browse CLI — connects to the local daemon (starts it if needed) and
// runs one command scoped to a named session.

import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { PORT, ROOT, EXTENSION_DIR, STATE_DIR, LOG_FILE, version, sourceHash, errMsg } from '../src/common.js'
import { parse } from '../src/args.js'
import { helpText, COMMAND } from '../src/spec.js'

const DAEMON_PATH = path.join(ROOT, 'src', 'daemon.js')
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ctrl-browse.daemon.plist')

const uid = () => (process.getuid ? process.getuid() : 0) // launchctl paths are macOS-only
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// exit only once the output is flushed: on macOS, pipe writes are async and
// process.exit() right after console.log cuts piped output off at 64 KB
function finish(code, text) {
  const out = code ? process.stderr : process.stdout
  out.write(text ? text + '\n' : '', () => process.exit(code))
}
const fail = (msg) => finish(1, 'error: ' + msg)

// run the daemon as a login service (macOS) so it's always listening —
// kills the ERR_CONNECTION_REFUSED noise the extension logs while it's off
async function daemonCmd(sub) {
  if (process.platform !== 'darwin') return fail('daemon install is macOS-only — elsewhere the daemon auto-starts on demand')
  const bootout = () => { try { execSync(`launchctl bootout gui/${uid()} ${PLIST}`, { stdio: 'ignore' }) } catch {} } // not loaded: fine
  if (sub === 'uninstall') {
    bootout()
    if (!fs.existsSync(PLIST)) return finish(0, 'not installed')
    fs.unlinkSync(PLIST)
    return finish(0, 'launchagent removed — daemon back to on-demand auto-spawn')
  }
  if (sub !== 'install') return fail('usage: ctrl-browse daemon install|uninstall')
  fs.mkdirSync(path.dirname(PLIST), { recursive: true })
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ctrl-browse.daemon</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${DAEMON_PATH}</string></array>
  <key>EnvironmentVariables</key><dict><key>CTRL_BROWSE_MANAGED</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
</dict></plist>`)
  bootout()
  let ok = false
  for (let i = 0; i < 5 && !ok; i++) {
    await sleep(400) // let launchd settle; bootout reports exit 5 even on success
    try { execSync(`launchctl bootstrap gui/${uid()} ${PLIST}`, { stdio: 'ignore' }); ok = true } catch { bootout() }
  }
  if (!ok) return fail('could not bootstrap launchagent (see ' + PLIST + ')')
  finish(0, 'daemon installed as a login service (KeepAlive, restarts on crash, starts at login).\nThe extension now always finds it listening — no more ERR_CONNECTION_REFUSED errors\nin chrome://extensions.\nRemove with: ctrl-browse daemon uninstall')
}

/** @returns {Promise<WebSocket>} */
function connect(timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
    const t = setTimeout(() => { ws.terminate(); reject(new Error('timeout')) }, timeoutMs)
    ws.on('open', () => { clearTimeout(t); resolve(ws) })
    ws.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

function spawnDaemon() {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  // keep one previous log around
  try { if (fs.statSync(LOG_FILE).size > 1 << 20) fs.renameSync(LOG_FILE, LOG_FILE + '.1') } catch {} // no log yet
  const fd = fs.openSync(LOG_FILE, 'a')
  spawn(process.execPath, [DAEMON_PATH], { stdio: ['ignore', fd, fd], detached: true, env: process.env }).unref()
  fs.closeSync(fd)
}

// spawn: false when launchd owns the daemon (it restarts it; a second one would fight it for the port)
async function connectOrStart({ spawn = true } = {}) {
  try { return await connect(600) } catch {} // not running (yet)
  if (spawn) spawnDaemon()
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    try { return await connect(400) } catch {} // still starting
  }
  throw new Error(`could not start ctrl-browse daemon on 127.0.0.1:${PORT} (see ${LOG_FILE})`)
}

/** one request → its reply @param {WebSocket} ws @returns {Promise<any>} */
function request(ws, msg) {
  return new Promise((resolve, reject) => {
    ws.on('message', (data) => {
      let m
      try { m = JSON.parse(String(data)) } catch { return }
      if (m.id === msg.id) resolve(m)
    })
    ws.on('error', () => reject(new Error('daemon connection failed')))
    ws.on('close', () => reject(new Error('daemon connection closed')))
    ws.send(JSON.stringify(msg))
  })
}

const closed = (ws) => new Promise((resolve) => { if (ws.readyState === WebSocket.CLOSED) resolve(undefined); else ws.on('close', resolve) })

async function main() {
  let parsed
  try { parsed = parse(process.argv.slice(2)) } catch (e) { return fail(errMsg(e)) }
  const { cmd, args, flags } = parsed
  const session = parsed.session || process.env.CTRL_BROWSE_SESSION || null
  if (flags.version) return finish(0, version())
  if (!cmd || flags.help || cmd === 'help') return finish(0, helpText())
  if (!COMMAND.has(cmd)) return fail(`unknown command: ${cmd} — run "ctrl-browse help"`)
  if (cmd === 'daemon') return daemonCmd(args[0])
  if (cmd === 'extension-path') return finish(0, EXTENSION_DIR)

  // keep the client timeout above the daemon's 30s browser-connect wait
  const timeout = Math.max(35000, (parseInt(flags.timeout || '', 10) ? parseInt(flags.timeout || '', 10) + 15000 : 120000))
  setTimeout(() => fail('command timed out'), timeout).unref()

  const msg = { type: 'cli', id: `c${Date.now()}${Math.round(Math.random() * 1e6)}`, code: sourceHash(), session, cmd, args, flags }
  let m
  try {
    let ws = await connectOrStart()
    m = await request(ws, msg)
    if (m.stale) {
      // the daemon runs older code than what's on disk: it exits; start a fresh one and resend
      await closed(ws)
      ws = await connectOrStart({ spawn: !m.managed })
      m = await request(ws, msg)
    }
  } catch (e) {
    return fail(errMsg(e))
  }

  // if the daemon was launchd-managed, unload the agent or KeepAlive restarts it
  // (bootout is racy against the dying daemon — retry until it's really gone)
  if (m.data && m.data.managed && process.platform === 'darwin' && fs.existsSync(PLIST)) {
    for (let i = 0; i < 5; i++) {
      try { execSync(`launchctl bootout gui/${uid()} ${PLIST}`, { stdio: 'ignore' }) } catch {} // not loaded
      await sleep(400)
      try { (await connect(400)).close() } catch { break }
    }
  }
  // daemons before 0.4 don't report their code, so they can't be restarted automatically
  if (!m.code && cmd !== 'shutdown') process.stderr.write('warning: the running daemon predates this CLI — run "ctrl-browse shutdown"\n')
  if (m.ok === false) return fail(m.error)
  if (cmd === 'screenshot' && m.data && m.data.bytes) {
    const p = path.resolve(args[0] || 'screenshot.png')
    fs.writeFileSync(p, Buffer.from(m.data.bytes, 'base64'))
    const kb = Math.round((m.data.bytes.length * 3) / 4 / 1024)
    return finish(0, flags.json ? JSON.stringify({ saved: p, kb }) : `saved ${p} (${kb} KB)`)
  }
  finish(0, flags.json ? JSON.stringify(m.data ?? {}, null, 2) : (m.text ?? ''))
}

main()
