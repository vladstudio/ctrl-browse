// Smoke test: runs the real daemon with a fake extension over ws, then drives
// it with the real CLI. Validates plumbing end-to-end without Chrome.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'bin', 'ctrl-browse.js')
const DAEMON = path.join(HERE, '..', 'src', 'daemon.js')
const PORT = 9900 + Math.floor(Math.random() * 400)

let failures = 0
function ok(cond, msg, detail) {
  if (cond) console.log('ok  -', msg)
  else { failures++; console.error('FAIL -', msg); if (detail) console.error(detail) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, CTRL_BROWSE_PORT: String(PORT), ...env },
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => resolve({ code, out, err }))
  })
}

// ------------------------------------------------------------- fake extension
const tabs = new Map()
const groups = new Map()
const cdpCalls = []
let tabSeq = 100
let groupSeq = 500

function fakeDebugSend(m) {
  const { method, params } = m
  cdpCalls.push(method)
  if (method === 'Runtime.evaluate') {
    const expr = params.expression
    if (expr.includes('markdown')) return { result: { value: { title: 'Example Page', url: 'http://localhost:3000', markdown: '# Example\n\nHello **world**' } } }
    if (expr.includes('indexOf')) return { result: { value: true } }
    if (expr.includes('__cbRefSeq')) {
      const value = expr.includes('"find"')
        ? [{ ref: 'e1', tag: 'button', role: 'button', text: 'Go' }]
        : { title: 'Example', url: 'http://localhost:3000', elements: [{ ref: 'e1', tag: 'button', role: 'button', text: 'Go' }] }
      return { result: { value } }
    }
    if (expr.includes('innerText')) return { result: { value: 'Hello' } }
    if (expr.includes('scrollIntoView')) return { result: { value: { x: 50, y: 60, disabled: false } } }
    if (expr.includes('getBoundingClientRect')) return { result: { value: { x: 50, y: 60, disabled: false } } }
    return { result: { value: true } }
  }
  if (method === 'Page.captureScreenshot') return { data: 'Zm9vYmFy' }
  return {}
}

let ws
const fakeExtReady = new Promise((resolve, reject) => {
  const tryConnect = (attempt) => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
    ws.on('open', () => { ws.send(JSON.stringify({ event: 'hello' })); resolve() })
    ws.on('error', () => { setTimeout(() => tryConnect(attempt + 1), 200) })
    attachHandlers()
    if (attempt > 50) reject(new Error('fake ext could not connect'))
  }
  tryConnect(0)
})

function attachHandlers() {
  ws.on('message', async (d) => {
    const m = JSON.parse(String(d))
    if (m.event === 'ping') { ws.send(JSON.stringify({ event: 'pong' })); return }
    if (m.id === undefined) return
    try {
      const result = await fakeHandle(m)
      ws.send(JSON.stringify({ id: m.id, ok: true, result }))
    } catch (e) {
      ws.send(JSON.stringify({ id: m.id, ok: false, error: e.message }))
    }
  })
}

function fakeHandle(m) {
  switch (m.cmd) {
    case 'groups.get': {
      const g = groups.get(m.groupId)
      if (!g) throw new Error('no such group')
      return g
    }
    case 'groups.query': {
      const all = [...groups.values()]
      return m.query && m.query.title ? all.filter((g) => g.title === m.query.title) : all
    }
    case 'groups.update': { Object.assign(groups.get(m.groupId), m.props); return {} }
    case 'tabs.create': {
      const t = { id: ++tabSeq, url: m.props.url, title: 'Tab', status: 'loading', index: tabs.size, windowId: 1 }
      tabs.set(t.id, t)
      setTimeout(() => { t.status = 'complete' }, 30)
      return t
    }
    case 'tabs.group': {
      const gid = ++groupSeq
      groups.set(gid, { id: gid, title: '' })
      for (const id of m.tabIds) { const t = tabs.get(id); t.groupId = m.groupId || gid }
      return m.groupId || gid
    }
    case 'tabs.query': {
      return [...tabs.values()].filter((t) => (m.query && m.query.groupId !== undefined ? t.groupId === m.query.groupId : true))
    }
    case 'tabs.get': {
      const t = tabs.get(m.tabId)
      if (!t) throw new Error('no such tab')
      return t
    }
    case 'tabs.update': {
      const t = tabs.get(m.tabId)
      Object.assign(t, m.props)
      t.status = 'complete'
      return t
    }
    case 'tabs.remove': {
      const ids = Array.isArray(m.tabId) ? m.tabId : [m.tabId]
      for (const id of ids) tabs.delete(id)
      return {}
    }
    case 'tabs.reload': { tabs.get(m.tabId).status = 'complete'; return {} }
    case 'tabs.goBack': case 'tabs.goForward': return {}
    case 'windows.update': return {}
    case 'debug.attach': return {}
    case 'debug.send': return fakeDebugSend(m)
    default: throw new Error('fake ext: unknown cmd ' + m.cmd)
  }
}

function fakeExtConnect() {
  return new Promise((resolve) => {
    const tryC = (n) => {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
      ws.on('open', () => { ws.send(JSON.stringify({ event: 'hello' })); resolve() })
      ws.on('error', () => { setTimeout(() => tryC(n + 1), 200) })
      attachHandlers()
    }
    tryC(0)
  })
}

function fakeEvent(event) {
  ws.send(JSON.stringify({ event: 'debugEvent', tabId: [...tabs.keys()][0], ...event }))
}

// -------------------------------------------------------------------- test
async function main() {
  let daemon2 = null
  const daemon = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, CTRL_BROWSE_PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  daemon.unref()
  await sleep(400)
  await fakeExtReady

  // 1. goto creates the session + tab group
  let r = await run(['-s', 'feat-a', 'goto', 'http://localhost:3000'])
  ok(r.code === 0 && r.out.includes('Example Page'), 'goto → markdown', JSON.stringify({code: r.code, out: r.out, err: r.err}))
  let g = [...groups.values()].find((x) => x.title === 'feat-a')
  ok(!!g, 'session bound to tab group titled "feat-a"')

  // 2. snapshot
  r = await run(['-s', 'feat-a', 'snapshot', '-i'])
  ok(r.code === 0 && r.out.includes('@e1'), 'snapshot -i → refs', JSON.stringify({code: r.code, out: r.out, err: r.err}))

  // 3. click
  r = await run(['-s', 'feat-a', 'click', '#submit'])
  ok(r.code === 0 && r.out.includes('clicked #submit'), 'click', JSON.stringify({code: r.code, out: r.out, err: r.err}))

  // 4. mouse
  r = await run(['-s', 'feat-a', 'mouse', 'move', '600', '400', '--human', '--seed', '42'])
  ok(r.code === 0 && r.out.includes('mouse at 600,400'), 'mouse move --human')

  // 5. eval
  r = await run(['-s', 'feat-a', 'eval', '1+1'])
  ok(r.code === 0 && r.out.trim() !== '', 'eval', JSON.stringify({code: r.code, out: r.out, err: r.err}))

  // 6. fill
  r = await run(['-s', 'feat-a', 'fill', '#email', 'me@example.com'])
  ok(r.code === 0 && r.out.includes('filled #email'), 'fill', JSON.stringify({code: r.code, out: r.out, err: r.err}))

  // 7. tabs
  r = await run(['-s', 'feat-a', 'tab', 'new', '--label', 'docs', 'http://docs.local'])
  ok(r.code === 0 && r.out.includes('opened tab'), 'tab new --label', JSON.stringify({code: r.code, out: r.out, err: r.err}))
  r = await run(['-s', 'feat-a', 'tab'])
  ok(r.code === 0 && r.out.includes('t1') && r.out.includes('t2') && r.out.includes('label=docs'), 'tab list shows tN + labels', JSON.stringify({code: r.code, out: r.out, err: r.err}))
  r = await run(['-s', 'feat-a', 'tab', 't2'])
  ok(r.code === 0 && r.out.includes('switched to t2'), 'tab switch by tN', JSON.stringify({code: r.code, out: r.out, err: r.err}))
  r = await run(['-s', 'feat-a', 'tab', 'docs'])
  ok(r.code === 0 && r.out.includes('switched'), 'switch by label', JSON.stringify({code: r.code, out: r.out, err: r.err}))
  r = await run(['-s', 'feat-a', 'tab', 'close', 't2'])
  ok(r.code === 0 && r.out.includes('closed t2'), 'tab close', JSON.stringify({code: r.code, out: r.out, err: r.err}))

  // 8. network route + intercept
  r = await run(['-s', 'feat-a', 'network', 'route', 'api.example.com/*', '--abort'])
  ok(r.code === 0 && r.out.includes('route added'), 'network route', JSON.stringify({code: r.code, out: r.out, err: r.err}))
  ok(cdpCalls.includes('Fetch.enable'), 'Fetch.enable applied')
  fakeEvent({ method: 'Fetch.requestPaused', params: { requestId: 'req-1', resourceType: 'XHR', request: { method: 'GET', url: 'https://api.example.com/users' } } })
  await sleep(300)
  ok(cdpCalls.includes('Fetch.failRequest'), 'route --abort → Fetch.failRequest')
  r = await run(['-s', 'feat-a', 'network', 'requests'])
  ok(r.code === 0 && r.out.includes('blocked'), 'network requests shows blocked', JSON.stringify({code: r.code, out: r.out, err: r.err}))

  // 9. console + errors events
  fakeEvent({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ type: 'string', value: 'hi from page' }] } })
  fakeEvent({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'Uncaught TypeError', exception: { description: 'Uncaught TypeError: x is not a function' } } } })
  await sleep(300)
  r = await run(['-s', 'feat-a', 'console'])
  ok(r.code === 0 && r.out.includes('hi from page'), 'console', JSON.stringify({code: r.code, out: r.out, err: r.err}))
  r = await run(['-s', 'feat-a', 'errors'])
  ok(r.code === 0 && r.out.includes('TypeError'), 'errors', JSON.stringify({code: r.code, out: r.out, err: r.err}))

  // 9b. mock response route
  r = await run(['-s', 'feat-a', 'network', 'route', 'mock.example.com/*', '--body', '{"ok":1}'])
  ok(r.code === 0 && r.out.includes('route added'), 'mock route added', JSON.stringify(r))
  fakeEvent({ method: 'Fetch.requestPaused', params: { requestId: 'req-2', resourceType: 'Fetch', request: { method: 'GET', url: 'https://mock.example.com/api' } } })
  await sleep(300)
  ok(cdpCalls.includes('Fetch.fulfillRequest'), 'route --body → Fetch.fulfillRequest')

  // 9c. screenshot writes a file
  const shotPath = '/tmp/ctrl-browse-test.png'
  fs.rmSync(shotPath, { force: true })
  r = await run(['-s', 'feat-a', 'screenshot', shotPath])
  ok(r.code === 0 && r.out.includes('saved') && fs.existsSync(shotPath), 'screenshot saved', JSON.stringify(r))

  // 9d. --json
  r = await run(['-s', 'feat-a', 'snapshot', '-i', '--json'])
  ok(r.code === 0 && r.out.includes('"e1"'), 'snapshot --json', JSON.stringify(r))

  // 9e. find / wait / get / back
  r = await run(['-s', 'feat-a', 'find', 'role', 'button'])
  ok(r.code === 0 && r.out.includes('@e1'), 'find role → refs', JSON.stringify(r))
  r = await run(['-s', 'feat-a', 'wait', '--text', 'Ready'])
  ok(r.code === 0 && r.out.includes('found text'), 'wait --text', JSON.stringify(r))
  r = await run(['-s', 'feat-a', 'get', 'text', 'h1'])
  ok(r.code === 0 && r.out.includes('Hello'), 'get text', JSON.stringify(r))
  r = await run(['-s', 'feat-a', 'back'])
  ok(r.code === 0 && r.out.includes('navigated back'), 'back', JSON.stringify(r))

  // 10. missing session → error
  r = await run(['goto', 'http://x'])
  ok(r.code === 1 && r.err.includes('missing session'), 'missing -s → error exit 1', JSON.stringify({code: r.code, out: r.out, err: r.err}))

  // 11. close session
  r = await run(['-s', 'feat-a', 'close'])
  ok(r.code === 0 && r.out.includes('session "feat-a" closed'), 'close session', JSON.stringify({code: r.code, out: r.out, err: r.err}))
  r = await run(['-s', 'feat-a', 'sessions'])
  ok(r.code === 0 && !r.out.includes('feat-a'), 'sessions list empty after close', JSON.stringify({code: r.code, out: r.out, err: r.err}))

  // 12. session rebind after daemon restart
  await run(['-s', 'rebind-x', 'eval', '1'])
  daemon.kill() // SIGTERM → quit() flushes state before exiting
  await sleep(500)
  daemon2 = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, CTRL_BROWSE_PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  daemon2.unref()
  await sleep(400)
  await fakeExtConnect()
  r = await run(['-s', 'rebind-x', 'sessions'])
  ok(r.code === 0 && r.out.includes('rebind-x'), 'session rebound from tab group title after restart', JSON.stringify(r))
  r = await run(['-s', 'rebind-x', 'close'])
  ok(r.code === 0 && r.out.includes('closed'), 'rebind session closed')

  // teardown
  await run(['shutdown']).catch(() => {})
  await sleep(300)
  daemon.kill()

  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1) }
  console.log('\nall smoke tests passed')
  process.exit(0)
}

main()