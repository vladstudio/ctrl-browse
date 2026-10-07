// Smoke test: runs the real daemon with a fake extension over ws, then drives
// it with the real CLI. Validates plumbing end-to-end without Chrome.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'bin', 'ctrl-browse.js')
const DAEMON = path.join(HERE, '..', 'src', 'daemon.js')
const PORT = 9900 + Math.floor(Math.random() * 400)
// keep the test daemon's state file out of the real ~/.ctrl-browse
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrl-browse-test-'))
process.env.HOME = HOME
const { extOrigin } = await import('../src/daemon/util.js')
const { BRIDGE_FILE, bridgeHash } = await import('../src/common.js')
const CODE = bridgeHash(fs.readFileSync(BRIDGE_FILE, 'utf8')) // what an up-to-date extension reports
const EXT_ORIGIN = extOrigin()
const SRC = Object.fromEntries(['md', 'page', 'actions'].map((n) => [n, fs.readFileSync(path.join(HERE, '..', 'src', 'scripts', n + '.js'), 'utf8')]))

let failures = 0
function ok(cond, msg, detail) {
  if (cond) console.log('ok  -', msg)
  else { failures++; console.error('FAIL -', msg); if (detail) console.error(detail) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// poll instead of sleeping a fixed time: true as soon as cond() holds, false after ms
async function until(cond, ms = 3000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(20)) if (await cond()) return true
  return false
}

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
const keyEvents = []
const pageOps = []     // [op, arg] of every actions.js call
const attachCalls = [] // tabIds
const tabUpdates = []  // tabs.update props
let actionsInstalls = 0
let clickInfo = null // overrides the click probe's answer (covered / forced cases)
let domHtml = '<html></html>'
let tabSeq = 100
let groupSeq = 500

// "(<script source>)(<json args>)" → the parsed args, or null for another expression
function scriptCall(expr, name) {
  const head = '(' + SRC[name] + ')('
  if (!expr.startsWith(head)) return null
  return JSON.parse('[' + expr.slice(head.length, -1) + ']')
}

function fakePage(op, arg) {
  switch (op) {
    case 'click': return clickInfo || { x: 50, y: 60, disabled: false }
    case 'fill': return { ok: true, value: arg.value }
    case 'get': return 'Hello'
    case 'clip': return { x: 0, y: 0, width: 100, height: 100, dpr: 1 }
    case 'storage': return arg.sub === 'get' ? 'v' : true
    case 'dom': return domHtml
    default: return true // focus, scroll, exists, has-text
  }
}

function fakeDebugSend(m) {
  const { method, params } = m
  cdpCalls.push(method + (params && params.responseCode !== undefined ? ':' + params.responseCode : ''))
  if (method === 'Input.dispatchKeyEvent') keyEvents.push(params)
  if (method === 'Runtime.evaluate') {
    const expr = params.expression
    if (scriptCall(expr, 'md')) return { result: { value: { title: 'Example Page', url: 'http://localhost:3000', markdown: '# Example\n\nHello **world**' } } }
    const pg = scriptCall(expr, 'page')
    if (pg) {
      const value = pg[0].find
        ? [1, 2, 3].map((i) => ({ ref: 'e' + i, tag: 'button', role: 'button', text: 'Go' }))
        : { title: 'Example', url: 'http://localhost:3000/?token=SECRET1', elements: [{ ref: 'e1', tag: 'button', role: 'button', text: 'Go' }, { ref: 'e2', tag: 'a', role: 'link', text: 'x', href: 'http://a.test/?api_key=SECRET2' }] }
      return { result: { value } }
    }
    if (expr === '(' + SRC.actions + ')') { actionsInstalls++; return { result: { type: 'function', objectId: 'actions-1' } } }
    return { result: { value: true } } // eval / wait --fn
  }
  if (method === 'Runtime.callFunctionOn') {
    const act = params.arguments.map((a) => a.value)
    pageOps.push(act)
    return { result: { value: fakePage(act[0], act[1] || {}) } }
  }
  if (method === 'Page.captureScreenshot') return { data: 'Zm9vYmFy' }
  if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
  return {}
}

let ws
const fakeExtReady = new Promise((resolve, reject) => {
  const tryConnect = (attempt) => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { Origin: EXT_ORIGIN } })
    ws.on('open', () => { ws.send(JSON.stringify({ event: 'hello', code: CODE })); resolve() })
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
      tabUpdates.push(m.props)
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
    case 'debug.attach': attachCalls.push(m.tabId); return sleep(50).then(() => ({}))
    case 'debug.detach': return {}
    case 'debug.send': return fakeDebugSend(m)
    default: throw new Error('fake ext: unknown cmd ' + m.cmd)
  }
}

function fakeExtConnect(code = CODE) {
  return new Promise((resolve) => {
    const tryC = (n) => {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { Origin: EXT_ORIGIN } })
      ws.on('open', () => { ws.send(JSON.stringify({ event: 'hello', code })); resolve() })
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
  await fakeExtReady // retries until the daemon listens

  // 0. extension-path points at the folder to load unpacked
  let r0 = await run(['extension-path'])
  ok(r0.code === 0 && fs.existsSync(path.join(r0.out.trim(), 'manifest.json')), 'extension-path')

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
  ok(await until(() => cdpCalls.includes('Fetch.failRequest')), 'route --abort → Fetch.failRequest')
  r = await run(['-s', 'feat-a', 'network', 'requests'])
  ok(r.code === 0 && r.out.includes('blocked'), 'network requests shows blocked', JSON.stringify({code: r.code, out: r.out, err: r.err}))

  // 9. console + errors events
  fakeEvent({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ type: 'string', value: 'hi from page' }] } })
  fakeEvent({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'Uncaught TypeError', exception: { description: 'Uncaught TypeError: x is not a function' } } } })
  // (events share the socket with the fake's rpc replies, so the daemon has
  // handled them before the next command gets its first reply: no wait needed)
  r = await run(['-s', 'feat-a', 'console'])
  ok(r.code === 0 && r.out.includes('hi from page'), 'console', JSON.stringify({code: r.code, out: r.out, err: r.err}))
  r = await run(['-s', 'feat-a', 'errors'])
  ok(r.code === 0 && r.out.includes('TypeError'), 'errors', JSON.stringify({code: r.code, out: r.out, err: r.err}))

  // 9b. mock response route
  r = await run(['-s', 'feat-a', 'network', 'route', 'mock.example.com/*', '--body', '{"ok":1}'])
  ok(r.code === 0 && r.out.includes('route added'), 'mock route added', JSON.stringify(r))
  fakeEvent({ method: 'Fetch.requestPaused', params: { requestId: 'req-2', resourceType: 'Fetch', request: { method: 'GET', url: 'https://mock.example.com/api' } } })
  ok(await until(() => cdpCalls.includes('Fetch.fulfillRequest:200')), 'route --body → Fetch.fulfillRequest', JSON.stringify(cdpCalls.slice(-20)))

  // 9b2. preflights for mocked URLs are answered with echoed CORS headers
  fakeEvent({ method: 'Fetch.requestPaused', params: { requestId: 'req-3', resourceType: 'Preflight', request: { method: 'OPTIONS', url: 'https://mock.example.com/api', headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } } } })
  ok(await until(() => cdpCalls.includes('Fetch.fulfillRequest:204')), 'mocked URL preflight → 204 with echoed CORS headers', JSON.stringify(cdpCalls.slice(-20)))

  // 9b3. --status without --body fulfills; --times 1 expires after one match
  r = await run(['-s', 'feat-a', 'network', 'route', 'once.test/*', '--status', '409', '--times', '1'])
  ok(r.code === 0 && r.out.includes('route added'), 'route --status 409 --times 1 (no --body)', JSON.stringify(r))
  fakeEvent({ method: 'Fetch.requestPaused', params: { requestId: 'req-4', resourceType: 'XHR', request: { method: 'POST', url: 'https://once.test/api' } } })
  ok(await until(() => cdpCalls.includes('Fetch.fulfillRequest:409')), '--status alone fulfills with an empty body', JSON.stringify(cdpCalls.slice(-20)))
  fakeEvent({ method: 'Fetch.requestPaused', params: { requestId: 'req-5', resourceType: 'XHR', request: { method: 'POST', url: 'https://once.test/api' } } })
  ok(await until(() => cdpCalls.includes('Fetch.continueRequest')), '--times 1 consumed → the next request continues', JSON.stringify(cdpCalls.slice(-20)))

  // 9b4. token-like query params are redacted unless --raw
  fakeEvent({ method: 'Network.requestWillBeSent', params: { requestId: 'req-6', request: { method: 'GET', url: 'https://x.test/sse?token=eyJhbGciOiJIUzI1NiJ9.SECRET.SIG' } } })
  fakeEvent({ method: 'Network.loadingFinished', params: { requestId: 'req-6' } })
  r = await run(['-s', 'feat-a', 'network', 'requests', '--filter', 'x.test'])
  ok(r.code === 0 && r.out.includes('[REDACTED]') && !r.out.includes('SECRET.SIG'), 'token query params redacted', JSON.stringify(r))
  r = await run(['-s', 'feat-a', 'network', 'requests', '--filter', 'x.test', '--raw'])
  ok(r.code === 0 && r.out.includes('SECRET.SIG'), '--raw restores them')

  // 9b5. press / viewport / storage / find label / wait --fn
  r = await run(['-s', 'feat-a', 'press', 'meta+a'])
  ok(r.code === 0 && cdpCalls.includes('Input.dispatchKeyEvent'), 'press meta+a → key events')
  keyEvents.length = 0
  r = await run(['-s', 'feat-a', 'press', 'Enter'])
  ok(r.code === 0 && keyEvents.some((e) => e.type === 'keyDown' && e.key === 'Enter' && e.text === '\r'), 'press Enter → keyDown with \\r text (submits forms)', JSON.stringify(keyEvents))
  clickInfo = { x: 5, y: 5, disabled: false, covered: '<div class="fixed inset-0">', dialog: 'Rename workflow' }
  r = await run(['-s', 'feat-a', 'click', '#save'])
  ok(r.code !== 0 && r.err.includes('fixed inset-0') && r.err.includes('Rename workflow') && r.err.includes('--force'), 'covered click names the cover + dialog', JSON.stringify(r))
  clickInfo = { x: 5, y: 5, disabled: false, forced: '<div class="fixed inset-0">' }
  r = await run(['-s', 'feat-a', 'click', '#save', '--force'])
  ok(r.code === 0 && r.out.includes('forced'), 'click --force clicks and says what was on top', JSON.stringify(r))
  clickInfo = null
  r = await run(['-s', 'feat-a', 'find', 'label', 'Go', '--nth', '2', 'click'])
  ok(r.code === 0 && r.out.includes('clicked @e2') && !r.out.includes('clicked the first'), 'find --nth 2 click → second match', JSON.stringify(r))
  r = await run(['-s', 'feat-a', 'find', 'label', 'Go', 'click'])
  ok(r.code === 0 && r.out.includes('clicked @e1') && r.out.includes('--nth'), 'find click on many → first + --nth hint', JSON.stringify(r))
  r = await run(['-s', 'feat-a', 'find', 'label', 'Go', '--nth', '9', 'click'])
  ok(r.code !== 0 && r.err.includes('only 3 matches'), 'find --nth out of range errors', JSON.stringify(r))
  r = await run(['-s', 'feat-a', 'viewport', '1280', '800'])
  ok(r.code === 0 && cdpCalls.includes('Emulation.setDeviceMetricsOverride'), 'viewport override')
  r = await run(['-s', 'feat-a', 'viewport', 'reset'])
  ok(r.code === 0 && cdpCalls.includes('Emulation.clearDeviceMetricsOverride'), 'viewport reset')
  r = await run(['-s', 'feat-a', 'storage', 'set', 'local', 'flag', '1'])
  ok(r.code === 0, 'storage set', JSON.stringify(r))
  r = await run(['-s', 'feat-a', 'find', 'label', 'Go'])
  ok(r.code === 0 && r.out.includes('@e1'), 'find label → refs', JSON.stringify(r))
  r = await run(['-s', 'feat-a', 'wait', '--fn', 'document.readyState'])
  ok(r.code === 0 && r.out.includes('truthy'), 'wait --fn', JSON.stringify(r))

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

  // 9f. regressions: redaction, piped output, literal text, unknown flags, url normalization
  r = await run(['-s', 'feat-a', 'snapshot'])
  ok(r.code === 0 && !r.out.includes('SECRET1') && !r.out.includes('SECRET2') && r.out.includes('[REDACTED]'), 'snapshot redacts token-like url params', JSON.stringify(r))
  r = await run(['-s', 'feat-a', 'snapshot', '--raw'])
  ok(r.code === 0 && r.out.includes('SECRET2'), 'snapshot --raw keeps them')
  domHtml = '<html>' + 'x'.repeat(300000) + '</html>'
  r = await run(['-s', 'feat-a', 'dom', '--limit', '1000000'])
  ok(r.code === 0 && r.out.length > domHtml.length, `piped output is not truncated (${r.out.length} chars)`)
  domHtml = '<html></html>'
  r = await run(['-s', 'feat-a', 'fill', '#q', '--', '--verbose'])
  ok(r.code === 0 && pageOps.at(-1)[1].value === '--verbose', 'text after -- is literal', JSON.stringify({ r, op: pageOps.at(-1) }))
  r = await run(['-s', 'feat-a', 'fill', '#q', '-a'])
  ok(r.code === 0 && pageOps.at(-1)[1].value === '-a', '"-a" is text, not a flag', JSON.stringify(pageOps.at(-1)))
  r = await run(['-s', 'feat-a', 'click', '#q', '--forse'])
  ok(r.code === 1 && r.err.includes('unknown flag --forse'), 'unknown flags are rejected', JSON.stringify(r))
  r = await run(['-s', 'feat-a', 'click', '@e1"]\')'])
  ok(r.code === 0 && pageOps.at(-1)[1].sel === '@e1"]\')', 'selectors reach the page as data, not code', JSON.stringify(pageOps.at(-1)))
  r = await run(['-s', 'feat-a', 'storage', 'set', 'local', 'k', 'v'])
  ok(r.code === 0 && r.out.includes('set localStorage.k'), 'storage set reports a set, not a clear', JSON.stringify(r))
  r = await run(['-s', 'feat-a', 'storage', 'nuke', 'local', 'k'])
  ok(r.code === 1 && r.err.includes('usage'), 'unknown storage op is an error, not a removeItem', JSON.stringify(r))
  r = await run(['-s', 'new-url', 'open', 'localhost:3000'])
  const created = [...tabs.values()].find((t) => groups.get(t.groupId)?.title === 'new-url')
  ok(r.code === 0 && created && created.url === 'http://localhost:3000', 'open localhost:3000 on a new session → http://localhost:3000', JSON.stringify({ r, url: created && created.url }))
  r = await run(['open', 'example.com'], { CTRL_BROWSE_SESSION: 'new-url' })
  ok(r.code === 0 && cdpCalls.includes('Page.navigate'), 'CTRL_BROWSE_SESSION is honored', JSON.stringify(r))
  await run(['-s', 'new-url', 'close'])

  // 9g. races: parallel commands on a new session → one group, one debugger attach
  attachCalls.length = 0
  const rs = await Promise.all([1, 2, 3].map(() => run(['-s', 'racy', 'eval', '1'])))
  const racyGroups = [...groups.values()].filter((x) => x.title === 'racy')
  const racyTab = [...tabs.values()].find((t) => t.groupId === racyGroups[0]?.id)
  ok(rs.every((x) => x.code === 0) && racyGroups.length === 1, 'parallel commands create one tab group', JSON.stringify({ rs, n: racyGroups.length }))
  ok(attachCalls.filter((id) => id === racyTab?.id).length === 1, 'parallel commands attach the debugger once', JSON.stringify(attachCalls))
  await run(['-s', 'racy', 'close'])

  // 9h. a user's own tab group is never adopted
  groups.set(9999, { id: 9999, title: 'Personal' })
  r = await run(['-s', 'Personal', 'eval', '1'])
  ok(r.code === 1 && r.err.includes('did not create'), "a user's own group is not adopted", JSON.stringify(r))
  groups.delete(9999)

  // 9i. parser: short flags only where they mean something, flags only where the command takes them
  r = await run(['-s', 'feat-a', 'fill', '#q', '-h'])
  ok(r.code === 0 && pageOps.at(-1)[1].value === '-h', '"-h" after the command is text', JSON.stringify({ r, op: pageOps.at(-1) }))
  r = await run(['-s', 'feat-a', 'click', '#x', '--text', 'foo'])
  ok(r.code === 1 && r.err.includes('not a flag of "click"'), 'a flag the command does not take is an error', JSON.stringify(r))
  r = await run(['-s', 'feat-a', 'frobnicate'])
  ok(r.code === 1 && r.err.includes('unknown command'), 'unknown commands fail before reaching the daemon', JSON.stringify(r))
  const installs = actionsInstalls
  await run(['-s', 'feat-a', 'get', 'text', 'h1'])
  await run(['-s', 'feat-a', 'get', 'text', 'h1'])
  ok(actionsInstalls === installs, 'actions.js is installed once per page context, not re-sent per call', `${installs} → ${actionsInstalls}`)

  // 9j. pages Chrome won't let extensions debug
  attachCalls.length = 0
  r = await run(['-s', 'chrome-x', 'open', 'chrome://version'])
  const chromeTab = [...tabs.values()].find((t) => groups.get(t.groupId)?.title === 'chrome-x')
  ok(r.code === 0 && r.out.includes('navigated only') && !attachCalls.includes(chromeTab?.id), 'open chrome://… on a new session works without the debugger', JSON.stringify({ r, attachCalls }))
  r = await run(['-s', 'chrome-x', 'goto', 'chrome://settings'])
  ok(r.code === 0 && tabUpdates.at(-1)?.url === 'chrome://settings', 'goto chrome://… navigates with chrome.tabs', JSON.stringify({ r, last: tabUpdates.at(-1) }))
  await run(['-s', 'chrome-x', 'close'])

  // 9k. network idle: requests in flight hold it off; abandoned ones don't
  fakeEvent({ method: 'Network.requestWillBeSent', params: { requestId: 'slow-1', type: 'Fetch', request: { method: 'GET', url: 'https://slow.test/a' } } })
  r = await run(['-s', 'feat-a', 'wait', '--network-idle', '100', '--timeout', '600'])
  ok(r.code === 1 && r.err.includes('timed out'), 'an in-flight request holds network-idle off', JSON.stringify(r))
  fakeEvent({ method: 'Network.loadingFinished', params: { requestId: 'slow-1' } })
  r = await run(['-s', 'feat-a', 'wait', '--network-idle', '100', '--timeout', '3000'])
  ok(r.code === 0 && r.out.includes('network idle'), 'network idle once it finishes', JSON.stringify(r))
  fakeEvent({ method: 'Network.requestWillBeSent', params: { requestId: 'slow-2', type: 'Fetch', request: { method: 'GET', url: 'https://slow.test/b' } } })
  ws.send(JSON.stringify({ event: 'debugDetached', tabId: [...tabs.keys()][0] }))
  r = await run(['-s', 'feat-a', 'wait', '--network-idle', '100', '--timeout', '3000'])
  ok(r.code === 0, 'requests abandoned by a detach do not hold network-idle off', JSON.stringify(r))

  // 9l. group ownership: lost with its window → still ours; removed by the user → name is free
  const loseGroup = (title, windowClosing) => {
    const g = [...groups.values()].find((x) => x.title === title)
    for (const t of [...tabs.values()]) {
      if (t.groupId !== g.id) continue
      tabs.delete(t.id)
      ws.send(JSON.stringify({ event: 'tabs.onRemoved', tabId: t.id, windowClosing }))
    }
    groups.delete(g.id)
    ws.send(JSON.stringify({ event: 'groups.onRemoved', groupId: g.id }))
  }
  const restoreGroup = (title) => { // a group with this title appears (window restored, or the user made one)
    const g = { id: ++groupSeq, title }
    groups.set(g.id, g)
    const t = { id: ++tabSeq, url: 'about:blank', title: 'Tab', status: 'complete', index: tabs.size, windowId: 1, groupId: g.id }
    tabs.set(t.id, t)
  }
  await run(['-s', 'win-x', 'eval', '1'])
  loseGroup('win-x', true)
  restoreGroup('win-x')
  r = await run(['-s', 'win-x', 'eval', '1'])
  ok(r.code === 0, 'a group lost with its window is re-bound when restored', JSON.stringify(r))
  await run(['-s', 'win-x', 'close'])
  await run(['-s', 'del-x', 'eval', '1'])
  loseGroup('del-x', false)
  restoreGroup('del-x')
  r = await run(['-s', 'del-x', 'eval', '1'])
  ok(r.code === 1 && r.err.includes('did not create'), 'after the user removes a group, a new group with that title is theirs', JSON.stringify(r))

  // 9z. only our own extension may act as the bridge; local clients connect without credentials
  const probe = (headers) => new Promise((resolve) => {
    const c = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers })
    c.on('open', () => { c.close(); resolve(true) })
    c.on('error', () => resolve(false))
  })
  ok(!(await probe({ Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })), 'other extensions are refused')
  ok(!(await probe({ Origin: 'http://evil.test' })), 'web pages are refused')
  ok(await probe({}), 'local clients connect (no token — see README "Security model")')
  const impostor = new WebSocket(`ws://127.0.0.1:${PORT}`)
  await new Promise((r, j) => { impostor.on('open', r); impostor.on('error', j) })
  impostor.send(JSON.stringify({ event: 'hello' }))
  impostor.on('message', () => { failures++; console.error('FAIL - impostor received a bridge rpc') })
  await sleep(100) // a negative check: give a takeover the chance to happen
  r = await run(['-s', 'feat-a', 'eval', '1'])
  impostor.close()
  ok(r.code === 0, 'a no-origin "hello" cannot take over the bridge', JSON.stringify(r))

  // 10. missing session → error
  r = await run(['goto', 'http://x'])
  ok(r.code === 1 && r.err.includes('missing session'), 'missing -s → error exit 1', JSON.stringify({code: r.code, out: r.out, err: r.err}))

  // 11. close session
  r = await run(['-s', 'feat-a', 'close'])
  ok(r.code === 0 && r.out.includes('session "feat-a" closed'), 'close session', JSON.stringify({code: r.code, out: r.out, err: r.err}))
  r = await run(['-s', 'feat-a', 'sessions'])
  ok(r.code === 0 && !r.out.includes('feat-a'), 'sessions list empty after close', JSON.stringify({code: r.code, out: r.out, err: r.err}))

  // 12. a daemon whose code changed on disk refuses the command and exits
  await run(['-s', 'rebind-x', 'eval', '1'])
  const exited = new Promise((resolve) => daemon.on('exit', resolve))
  const stale = await new Promise((resolve) => {
    const c = new WebSocket(`ws://127.0.0.1:${PORT}`)
    c.on('open', () => c.send(JSON.stringify({ type: 'cli', id: 's1', code: 'not-this-code', session: 'rebind-x', cmd: 'eval', args: ['1'], flags: {} })))
    c.on('message', (d) => { c.close(); resolve(JSON.parse(String(d))) })
  })
  ok(stale.ok === false && stale.stale === true, 'a CLI with other code gets "stale"', JSON.stringify(stale))
  ok(await until(() => exited.then(() => true), 5000), 'the stale daemon exits (state flushed)')

  // 13. session rebind after daemon + "Chrome" restart (new group ids)
  const old = [...groups.values()].find((x) => x.title === 'rebind-x')
  groups.delete(old.id); old.id = ++groupSeq; groups.set(old.id, old)
  for (const t of tabs.values()) if (t.groupId !== undefined && !groups.has(t.groupId)) t.groupId = old.id
  daemon2 = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, CTRL_BROWSE_PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  daemon2.unref()
  await fakeExtConnect('0123456789abcdef') // an extension Chrome loaded before the files changed
  r = await run(['-s', 'rebind-x', 'eval', '1'])
  ok(r.code === 1 && r.err.includes('older ctrl-browse extension'), 'an extension running older code is refused', JSON.stringify(r))
  await fakeExtConnect()
  const before = groups.size
  r = await run(['-s', 'rebind-x', 'eval', '1'])
  ok(r.code === 0 && groups.size === before, 'session re-bound by title after restart (no new group)', JSON.stringify(r))
  r = await run(['-s', 'rebind-x', 'close'])
  ok(r.code === 0 && r.out.includes('closed'), 'rebind session closed')

  // teardown
  await run(['shutdown']).catch(() => {})
  daemon2.kill()

  fs.rmSync(HOME, { recursive: true, force: true })
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1) }
  console.log('\nall smoke tests passed')
  process.exit(0)
}

main()