#!/usr/bin/env bun
// ctrl-browse daemon — bridges the CLI and the Chrome extension.
// Listens on 127.0.0.1:<PORT>; the extension connects as a ws client and
// executes chrome.tabs/tabGroups/debugger (CDP) calls on our behalf.

import { WebSocketServer } from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = parseInt(process.env.CTRL_BROWSE_PORT || '9876', 10)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATE_DIR = path.join(os.homedir(), '.ctrl-browse')
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const MD_SRC = fs.readFileSync(path.join(HERE, 'scripts', 'md.js'), 'utf8')
const PAGE_SRC = fs.readFileSync(path.join(HERE, 'scripts', 'page.js'), 'utf8')

const GROUP_COLORS = ['blue', 'cyan', 'green', 'orange', 'pink', 'purple', 'red', 'teal', 'yellow', 'grey']
const RES = {
  document: 'Document', stylesheet: 'Stylesheet', css: 'Stylesheet', image: 'Image', media: 'Media',
  font: 'Font', script: 'Script', xhr: 'XHR', fetch: 'Fetch', websocket: 'WebSocket',
  manifest: 'Manifest', ping: 'Ping', preflight: 'Preflight', other: 'Other',
}

const MAX_REQUESTS = 500, MAX_CONSOLE = 500, MAX_ERRORS = 300
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cap = (a, n) => { if (a.length > n) a.splice(0, a.length - n) }
const tsf = (t) => { const d = new Date(t || Date.now()); return d.toTimeString().slice(0, 8) }

// ------------------------------------------------------------------ state
let state = { sessions: {} }
try {
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  if (raw && typeof raw === 'object') state = { sessions: raw.sessions || {} }
} catch {}
let persistTimer = null
function persist() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      const tmp = STATE_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
      fs.renameSync(tmp, STATE_FILE)
    } catch (e) { console.error('[ctrl-browse] state write failed:', e.message) }
  }, 250)
}
// ensure pending state is flushed when the daemon goes away
process.on('exit', () => {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch {}
})

const sessions = new Map() // name -> session
function makeSession(name, groupId, { labels = {}, activeTabId = null } = {}) {
  return {
    name, groupId, labels, activeTabId,
    tabs: new Map(),           // tabId -> {title, url} (mirror of chrome state)
    routes: [],                // network routes (runtime only)
    requests: [], reqSeq: 0, reqMap: new Map(),
    console: [], errors: [],
  }
}
for (const [name, s] of Object.entries(state.sessions)) {
  sessions.set(name, makeSession(name, s.groupId, s))
}
function saveSession(s) {
  state.sessions[s.name] = { groupId: s.groupId, activeTabId: s.activeTabId, labels: s.labels }
  persist()
}
function dropSession(s) { sessions.delete(s.name); delete state.sessions[s.name]; persist() }

// ------------------------------------------------------- extension link
let ext = null
let reqSeq = 1
const pendingRpcs = new Map()

function rpc(cmd, payload = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (!ext) return reject(new Error('browser not connected — open Chrome with the ctrl-browse extension loaded (see README)'))
    const id = reqSeq++
    const entry = { resolve, reject }
    entry.timer = setTimeout(() => { pendingRpcs.delete(id); reject(new Error(`extension rpc timeout: ${cmd}`)) }, timeout)
    pendingRpcs.set(id, entry)
    ext.send(JSON.stringify({ id, cmd, ...payload }))
  })
}

async function waitBrowser(ms = 30000) {
  if (ext) return
  const t0 = Date.now()
  while (!ext) {
    if (Date.now() - t0 > ms) throw new Error('browser not connected — open Chrome with the ctrl-browse extension loaded (see README)')
    await sleep(200)
  }
}

// ----------------------------------------------------------- cdp helpers
const attached = new Set()
const loadWaiters = new Map() // tabId -> Set<entry>
// every page eval must run in the main frame's default-world execution context —
// with a password-manager's chrome-extension:// iframe on the page, default
// Runtime.evaluate fails with "Cannot access a chrome-extension:// URL…"
const mainFrameId = new Map() // tabId -> main frame id (via Page.getFrameTree)
const mainCtxId = new Map()   // tabId -> main-frame default-world context id
const noCtx = new Set()       // tabs that never report contexts (stub extensions, old Chrome)
const navTs = new Map()       // tabId -> last load time (console/errors --since-nav)

async function mainCtxFor(tabId) {
  if (!noCtx.has(tabId)) {
    for (let i = 0; i < 10 && !mainCtxId.has(tabId); i++) await sleep(50)
    if (!mainCtxId.has(tabId)) noCtx.add(tabId)
  }
  return mainCtxId.get(tabId)
}

async function attach(s, tabId) {
  if (attached.has(tabId)) return
  try {
    await rpc('debug.attach', { tabId }, 10000)
  } catch (e) {
    // a previous daemon (killed without detaching) may still hold the debugger
    if (/already attached/i.test(String(e && e.message))) {
      await rpc('debug.detach', { tabId }, 5000)
      await rpc('debug.attach', { tabId }, 10000)
    } else throw e
  }
  attached.add(tabId)
  for (const m of ['Page.enable', 'Log.enable', 'Network.enable']) {
    try { await rpc('debug.send', { tabId, method: m }, 8000) } catch {}
  }
  // main frame id before Runtime.enable, so the first executionContextCreated is not missed
  try {
    const t = await rpc('debug.send', { tabId, method: 'Page.getFrameTree' }, 8000)
    mainFrameId.set(tabId, t.frameTree.frame.id)
  } catch {}
  try { await rpc('debug.send', { tabId, method: 'Runtime.enable' }, 8000) } catch {}
  if (s && s.routes.length) { try { await applyRoutes(s, tabId) } catch {} }
}

async function cdp(s, tabId, method, params = {}, timeout) {
  const t = timeout || (method.startsWith('Page.') ? 25000 : 15000)
  await attach(s, tabId)
  try {
    return await rpc('debug.send', { tabId, method, params }, t)
  } catch (e) {
    // our `attached` bookkeeping can diverge from Chrome (SW restarts, DevTools,
    // Helium quirks) — drop the tab and force a fresh attach before giving up
    if (!/not attached|cannot access|detached/i.test(String(e && e.message))) throw e
    attached.delete(tabId)
    await attach(s, tabId)
    return rpc('debug.send', { tabId, method, params }, t)
  }
}

function routePatterns(routes) {
  return routes.map((r) => ({
    // CDP urlPatterns need a scheme (or a leading wildcard) or they match nothing —
    // scheme-less "host/*" patterns work in our matcher, so translate for CDP
    urlPattern: /:\/\//.test(r.url) || r.url.startsWith('*') ? r.url : '**/' + r.url,
    requestStage: 'Request',
    ...(r.resourceType ? { resourceType: RES[String(r.resourceType).toLowerCase()] || 'Other' } : {}),
  }))
}

async function applyRoutes(s, tabId) {
  try { await rpc('debug.send', { tabId, method: 'Fetch.disable' }, 8000) } catch {}
  if (s.routes.length) await rpc('debug.send', { tabId, method: 'Fetch.enable', params: { patterns: routePatterns(s.routes) } }, 8000)
}

async function syncRoutes(s) {
  let tabs = []
  try { tabs = await rpc('tabs.query', { query: { groupId: s.groupId } }, 8000) } catch {}
  for (const t of tabs) {
    try { await attach(s, t.id); await applyRoutes(s, t.id) } catch (e) { console.error('[ctrl-browse] route sync failed:', e.message) }
  }
}

async function evalJS(s, tabId, expression, opts = {}) {
  const evaluate = async () => {
    const ctx = await mainCtxFor(tabId)
    const r = await cdp(s, tabId, 'Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: opts.awaitPromise !== false, userGesture: true,
      ...(ctx ? { contextId: ctx } : {}),
    })
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error('page eval error: ' + String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 400))
    }
    return r && r.result ? r.result.value : undefined
  }
  try {
    return await evaluate()
  } catch (e) {
    const msg = String((e && e.message) || e)
    if (/cannot find.*context|context .*destroyed/i.test(msg)) { mainCtxId.delete(tabId); return evaluate() } // stale after a navigation
    if (/chrome-extension/i.test(msg))
      throw new Error(msg + ' — an extension frame we cannot control (usually a password manager) is injected on this page; disable it for this site or use a clean profile')
    throw e
  }
}

const selExpr = (sel) =>
  sel.startsWith('@')
    ? `document.querySelector('[data-cb-ref="${sel.slice(1).replace(/"/g, '')}"]')`
    : `document.querySelector(${JSON.stringify(sel)})`

// ------------------------------------------------------------- sessions
let colorIdx = 0

async function ensureSession(name, { create = true, url } = {}) {
  await waitBrowser()
  let s = sessions.get(name)
  if (s) {
    try { await rpc('groups.get', { groupId: s.groupId }, 8000) } catch { dropSession(s); s = null }
  }
  if (!s) {
    let groups = []
    try { groups = await rpc('groups.query', { query: { title: name } }, 8000) } catch {}
    if (groups && groups.length) {
      const g = groups[0]
      const tabs = (await rpc('tabs.query', { query: { groupId: g.id } }, 8000)).sort((a, b) => a.index - b.index)
      s = makeSession(name, g.id, { labels: (state.sessions[name] || {}).labels || {}, activeTabId: tabs[0] ? tabs[0].id : null })
      for (const t of tabs) s.tabs.set(t.id, { title: t.title, url: t.url })
      sessions.set(name, s); saveSession(s)
    }
  }
  if (!s && create) {
    const tab = await rpc('tabs.create', { props: { url: url || 'about:blank', active: true } }, 20000)
    const groupId = await rpc('tabs.group', { tabIds: [tab.id] }, 8000)
    try { await rpc('groups.update', { groupId, props: { title: name, color: GROUP_COLORS[colorIdx++ % GROUP_COLORS.length] } }, 8000) } catch {}
    s = makeSession(name, groupId, { activeTabId: tab.id })
    s.tabs.set(tab.id, { title: tab.title || '', url: tab.url || '' })
    sessions.set(name, s); saveSession(s)
    if (url) s._fresh = true
  }
  if (!s) throw new Error(`no such session: "${name}"`)
  return s
}

const resolveTab = (s) => resolveTabRef(s).then((r) => r.tab)

async function resolveTabRef(s, ref) {
  let tabs
  try {
    tabs = (await rpc('tabs.query', { query: { groupId: s.groupId } }, 8000)).sort((a, b) => a.index - b.index)
  } catch (e) {
    // transient failure — keep the session (a real empty group drops it below)
    throw new Error(`could not query tabs: ${e.message}`)
  }
  s.tabs = new Map(tabs.map((t) => [t.id, { title: t.title, url: t.url }]))
  for (const id in s.labels) if (!s.tabs.has(Number(id))) delete s.labels[id] // prune dead tabs
  if (!tabs.length) {
    dropSession(s)
    throw new Error(`session "${s.name}" has no tabs — it will be recreated on next use`)
  }
  if (ref === undefined || ref === null || ref === '') {
    const tab = tabs.find((t) => t.id === s.activeTabId) || tabs[0]
    if (tab.id !== s.activeTabId) { s.activeTabId = tab.id; saveSession(s) }
    return { tab, tabs }
  }
  const m = /^t(\d+)$/i.exec(ref)
  if (m) {
    const i = parseInt(m[1], 10) - 1
    if (i < 0 || i >= tabs.length) throw new Error(`no tab t${m[1]} (${tabs.length} tab${tabs.length === 1 ? '' : 's'} in session)`)
    return { tab: tabs[i], tabs }
  }
  const byLabel = tabs.find((t) => s.labels[t.id] === ref)
  if (byLabel) return { tab: byLabel, tabs }
  if (/^\d+$/.test(ref)) {
    const byId = tabs.find((t) => t.id === Number(ref))
    if (byId) return { tab: byId, tabs }
  }
  const byTitle = tabs.find((t) => t.title === ref)
  if (byTitle) return { tab: byTitle, tabs }
  throw new Error(`no tab matching "${ref}" — use t<N>, a label, a tabId, or an exact title`)
}

async function waitComplete(tabId, timeout) {
  const t0 = Date.now()
  for (;;) {
    const tab = await rpc('tabs.get', { tabId }).catch(() => { throw new Error('tab was closed') })
    if (tab.status === 'complete') return tab
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for page load (${timeout}ms)`)
    await sleep(150)
  }
}

function waitLoadEvent(tabId, timeout) {
  let entry
  const p = new Promise((resolve, reject) => {
    entry = { resolve, reject, tabId }
    entry.timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for page load (${timeout}ms)`)) }, timeout)
    entry.cleanup = cleanup
    entry.cancel = () => { cleanup(); reject(new Error('cancelled')) }
  })
  function cleanup() {
    clearTimeout(entry.timer)
    const set = loadWaiters.get(entry.tabId)
    if (set) { set.delete(entry); if (!set.size) loadWaiters.delete(entry.tabId) }
  }
  const set = loadWaiters.get(tabId) || new Set()
  set.add(entry); loadWaiters.set(tabId, set)
  p.cleanup = cleanup
  p.catch(() => {})
  return p
}

// ---------------------------------------------------------------- events
function sessionOfTab(tabId) {
  for (const s of sessions.values()) if (s.tabs.has(tabId)) return s
  return null
}

function globToRegex(g, { anchored = true, ignoreCase = false } = {}) {
  const src = String(g).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(anchored ? `^${src}$` : src, ignoreCase ? 'i' : '')
}

function statusMatch(spec, status) {
  return String(spec).split(',').some((part) => {
    part = part.trim().toLowerCase()
    if (!part) return false
    if (part.endsWith('xx')) { const c = parseInt(part[0], 10); return status >= c * 100 && status < (c + 1) * 100 }
    if (part.includes('-')) { const [a, b] = part.split('-').map(Number); return status >= a && status <= b }
    return status === parseInt(part, 10)
  })
}

function trackRequest(s, tabId, p) {
  const prev = s.reqMap.get(p.requestId)
  if (prev) s.reqMap.delete(p.requestId) // redirect: keep old entry in list, start a new one
  const e = {
    n: ++s.reqSeq, ts: Date.now(), id: p.requestId, tabId,
    method: p.request.method, url: p.request.url,
    type: (p.type || '').toLowerCase() || undefined,
    status: null, requestHeaders: p.request.headers, postData: p.request.postData,
    responseHeaders: null, done: false,
  }
  s.reqMap.set(p.requestId, e)
  s.requests.push(e)
  while (s.requests.length > MAX_REQUESTS) { const old = s.requests.shift(); if (s.reqMap.get(old.id) === old) s.reqMap.delete(old.id) }
}

const hval = (h, name) => { for (const k in h || {}) if (k.toLowerCase() === name) return h[k]; return '' }

// route matches are recorded on the network entry they intercepted. Fetch
// interception ids live in their own space ("interception-job-N"), so a
// request already tracked by requestWillBeSent is matched by url+method
// instead; the synthetic-row fallback is only for requests the Network
// events missed entirely
function markIntercepted(s, tabId, p, status, routeUrl, mockBody) {
  const e = s.reqMap.get(p.requestId)
    || [...s.requests].reverse().find((r) => r.tabId === tabId && r.status === null
      && (r.method || 'GET').toUpperCase() === p.request.method.toUpperCase() && r.url === p.request.url)
  if (e) { e.route = routeUrl; e.mocked = status; e.status = status; e.done = true; e.mockBody = mockBody }
  else {
    s.requests.push({
      n: ++s.reqSeq, ts: Date.now(), id: p.requestId, tabId,
      method: p.request.method, url: p.request.url, type: (p.resourceType || '').toLowerCase() || undefined,
      status, route: routeUrl, mocked: status, done: true,
    })
    cap(s.requests, MAX_REQUESTS)
  }
}

async function onPause(s, tabId, p) {
  const url = p.request.url
  const rt = (p.resourceType || '').toLowerCase()
  const req = p.request
  // anchored against the full URL or the URL without its scheme
  // (so "api.example.com/*" matches "https://api.example.com/x" but not sub/embedded URLs)
  const matches = (r) => {
    if (r.resourceType) {
      const want = (RES[String(r.resourceType).toLowerCase()] || 'Other').toLowerCase()
      if (want !== rt) return false
    }
    const re = globToRegex(r.url)
    const bare = url.replace(/^[a-z]+:\/\//i, '')
    return re.test(url) || re.test(bare)
  }
  // preflight (OPTIONS) for a mocked URL must be answered by us: a wrong or
  // failed preflight makes the browser block the real request, killing the mock
  // ('*' is rejected on credentialed calls, so the caller's Origin is echoed)
  if (req.method.toUpperCase() === 'OPTIONS' && hval(req.headers, 'access-control-request-method') && s.routes.some(matches)) {
    markIntercepted(s, tabId, p, 'preflight', null)
    await cdp(s, tabId, 'Fetch.fulfillRequest', {
      requestId: p.requestId, responseCode: 204,
      responseHeaders: [
        { name: 'Access-Control-Allow-Origin', value: hval(req.headers, 'origin') || '*' },
        { name: 'Access-Control-Allow-Credentials', value: 'true' },
        { name: 'Access-Control-Allow-Methods', value: hval(req.headers, 'access-control-request-method') },
        { name: 'Access-Control-Allow-Headers', value: hval(req.headers, 'access-control-request-headers') },
        { name: 'Access-Control-Max-Age', value: '600' },
      ],
    }).catch(() => {})
    return
  }
  const route = s.routes.find((r) => (!r.method || req.method.toUpperCase() === r.method) && matches(r))
  if (!route) { await cdp(s, tabId, 'Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); return }
  if (route.abort || route.body !== undefined) {
    markIntercepted(s, tabId, p, route.abort ? 'blocked' : `mocked ${route.status || 200}`, route.url, route.abort ? undefined : route.body)
    if (route.times !== undefined && --route.times <= 0) {
      s.routes = s.routes.filter((r) => r !== route)
      syncRoutes(s).catch(() => {})
    }
  }
  if (route.abort) await cdp(s, tabId, 'Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' }).catch(() => {})
  else if (route.body !== undefined) {
    let hs = route.headers || []
    const put = (name, value) => { if (!hs.some((h) => h.name.toLowerCase() === name.toLowerCase())) hs = hs.concat({ name, value }) }
    put('Content-Type', route.contentType || 'application/json')
    put('Access-Control-Allow-Origin', hval(req.headers, 'origin') || '*')
    put('Access-Control-Allow-Credentials', 'true')
    await cdp(s, tabId, 'Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: route.status || 200,
      responseHeaders: hs,
      body: Buffer.from(String(route.body)).toString('base64'),
    }).catch(() => {})
  }
  else await cdp(s, tabId, 'Fetch.continueRequest', { requestId: p.requestId }).catch(() => {})
}

function logConsole(s, tabId, p) {
  const text = (p.args || []).map((a) => a.value !== undefined ? String(a.value)
    : a.preview ? '{ ' + a.preview.properties.map((q) => `${q.name}: ${String(q.value).slice(0, 60)}`).join(', ') + ' }'
    : a.description || a.type || '').join(' ')
  s.console.push({ ts: p.timestamp || Date.now(), tabId, type: p.type || 'log', text })
  cap(s.console, MAX_CONSOLE)
}

function pushErr(s, tabId, text) {
  s.errors.push({ ts: Date.now(), tabId, text: String(text).slice(0, 1000) })
  cap(s.errors, MAX_ERRORS)
}

function handleEvent(m) {
  if (m.event === 'debugEvent') {
    const { tabId, method, params } = m
    if (method === 'Page.loadEventFired') {
      navTs.set(tabId, Date.now())
      const set = loadWaiters.get(tabId)
      if (set) for (const e of [...set]) { e.cleanup(); e.resolve() }
      return
    }
    if (method === 'Runtime.executionContextCreated') {
      const c = params.context || {}
      if (c.auxData && c.auxData.isDefault && c.auxData.frameId === mainFrameId.get(tabId)) mainCtxId.set(tabId, c.id)
      return
    }
    if (method === 'Runtime.executionContextsCleared') { mainCtxId.delete(tabId); noCtx.delete(tabId); return }
    if (method === 'Fetch.requestPaused') {
      const s = sessionOfTab(tabId)
      if (s) { onPause(s, tabId, params).catch(() => {}); return }
      // no session → nobody would continue it; the request would hang forever
      rpc('debug.send', { tabId, method: 'Fetch.continueRequest', params: { requestId: params.requestId } }).catch(() => {})
      return
    }
    const s = sessionOfTab(tabId)
    if (!s) return
    if (method === 'Network.requestWillBeSent') { trackRequest(s, tabId, params); return }
    if (method === 'Network.responseReceived') {
      const e = s.reqMap.get(params.requestId)
      if (e) { e.status = params.response.status; e.responseHeaders = params.response.headers; e.mimeType = params.response.mimeType; e.done = true }
      return
    }
    if (method === 'Network.loadingFailed') {
      const e = s.reqMap.get(params.requestId)
      if (e) { e.status = 'failed'; e.error = params.errorText; e.done = true }
      return
    }
    if (method === 'Runtime.consoleAPICalled') { logConsole(s, tabId, params); return }
    if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails || {}
      pushErr(s, tabId, (d.exception && (d.exception.description || d.exception.value)) || d.text || 'page exception')
      return
    }
    if (method === 'Log.entryAdded') {
      const en = params.entry || {}
      const line = `[${en.source || 'log'}] ${en.text || ''}`
      if (en.level === 'error') pushErr(s, tabId, line)
      else logConsole(s, tabId, { type: en.level === 'warning' ? 'warning' : 'info', args: [{ type: 'string', value: line }] })
      return
    }
    return
  }
  if (m.event === 'debugDetached') { for (const p of [attached, mainFrameId, mainCtxId, noCtx]) p.delete(m.tabId); return }
  if (m.event === 'tabs.onRemoved') {
    for (const p of [attached, mainFrameId, mainCtxId, noCtx]) p.delete(m.tabId)
    mousePos.delete(m.tabId); navTs.delete(m.tabId)
    for (const s of sessions.values()) s.tabs.delete(m.tabId)
    return
  }
  if (m.event === 'groups.onRemoved') {
    for (const s of [...sessions.values()]) if (s.groupId === m.groupId) dropSession(s)
    return
  }
}

// --------------------------------------------------------- mouse helpers
const mousePos = new Map()
function posOf(tabId) {
  if (!mousePos.has(tabId)) mousePos.set(tabId, { x: 0, y: 0 })
  return mousePos.get(tabId)
}
function lcg(seed) {
  let s = (seed >>> 0) || 1
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

async function mouseMoveCmd(s, tabId, x, y, flags = {}) {
  const from = posOf(tabId)
  if (flags.human || flags.duration || flags.steps) {
    const steps = Math.max(2, parseInt(flags.steps || 24, 10))
    const duration = Math.max(16, parseInt(flags.duration || 250, 10))
    const rng = flags.seed !== undefined ? lcg(parseInt(flags.seed, 10) || 1) : Math.random
    const jitter = Math.min(6, Math.hypot(x - from.x, y - from.y) / 25)
    for (let i = 1; i <= steps; i++) {
      const p = 1 - Math.pow(1 - i / steps, 3) // easeOutCubic
      const j = i < steps ? jitter : 0
      await cdp(s, tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + (x - from.x) * p + (rng() - 0.5) * j),
        y: Math.round(from.y + (y - from.y) * p + (rng() - 0.5) * j),
        buttons: 0,
      })
      if (i < steps) await sleep(duration / steps)
    }
  } else {
    await cdp(s, tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  }
  posOf(tabId).x = x
  posOf(tabId).y = y
}

// -------------------------------------------------------------- commands
async function gotoCmd(s, url, flags) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'http://' + url
  const tab = await resolveTab(s)
  const timeout = parseInt(flags.timeout || 30000, 10)
  const limit = parseInt(flags.limit || 20000, 10)
  try { await attach(s, tab.id) } catch {}

  if (s._fresh) {
    // tab was just created with this url — just wait for it to settle
    s._fresh = false
    try { await waitComplete(tab.id, timeout) } catch {}
  } else {
    const lp = waitLoadEvent(tab.id, timeout)
    try {
      await cdp(s, tab.id, 'Page.navigate', { url }, timeout + 5000)
    } catch (e) { lp.cleanup(); throw e }
    try { await lp } catch (e) {
      const t = await rpc('tabs.get', { tabId: tab.id }).catch(() => null)
      if (!t || t.status !== 'complete') throw e
    }
  }
  await sleep(250)
  const md = await evalJS(s, tab.id, `(${MD_SRC})()`).catch(() => null)
  const markdown = String((md && md.markdown) || '')
  const shown = redactUrl(markdown).slice(0, limit) // tokens in URLs never reach output; --raw applies to network commands
  const text = `# ${(md && md.title) || tab.title || url}\n${(md && md.url) || tab.url || url}\n\n${shown || '(empty page)'}` +
    (markdown.length > limit ? `\n\n[truncated at ${limit} chars — use "dom" or "get text <sel>" for more]` : '')
  return { text, data: { title: md && md.title, url: (md && md.url) || tab.url, chars: markdown.length } }
}

async function closeCmd(s) {
  let tabs = []
  try { tabs = await rpc('tabs.query', { query: { groupId: s.groupId } }, 8000) } catch {}
  if (tabs.length) { try { await rpc('tabs.remove', { tabId: tabs.map((t) => t.id) }, 10000) } catch {} }
  for (const t of tabs) attached.delete(t.id)
  dropSession(s)
  return { text: `session "${s.name}" closed (${tabs.length} tab${tabs.length === 1 ? '' : 's'})` }
}

function renderSnapshot(res) {
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

async function clickCmd(s, sel) {
  const tab = await resolveTab(s)
  const info = await evalJS(s, tab.id, `(() => {
    const el = ${selExpr(sel)}
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
    const hit = document.elementFromPoint(x, y)
    return { x, y, disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      covered: hit && !el.contains(hit) && !hit.contains(el) ? hit.tagName.toLowerCase() : null }
  })()`)
  if (!info) throw new Error(`element not found: ${sel} (run "snapshot -i" for refs)`)
  if (info.disabled) throw new Error('element is disabled')
  if (info.covered) throw new Error(`${sel} is covered by <${info.covered}> — the click would land on that element instead`)
  await mouseMoveCmd(s, tab.id, info.x, info.y)
  await cdp(s, tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp(s, tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', buttons: 0, clickCount: 1 })
  return { text: `clicked ${sel} at ${info.x},${info.y}` }
}

async function fillCmd(s, sel, text) {
  const tab = await resolveTab(s)
  const r = await evalJS(s, tab.id, `(() => {
    const el = ${selExpr(sel)}
    if (!el) return null
    el.focus()
    if (el.isContentEditable) {
      // select existing content for replacement — editors (Lexical, ProseMirror…)
      // ignore DOM writes and synthetic events, so the caller completes this
      // fill with a trusted Input.insertText
      const range = document.createRange(); range.selectNodeContents(el)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
      return { editable: true }
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : (el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype)
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    const v = ${JSON.stringify(text)}
    if (desc && desc.set) desc.set.call(el, v); else el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: el.value === v, value: el.type === 'password' ? '[REDACTED]' : el.value }
  })()`)
  if (!r) throw new Error(`element not found: ${sel}`)
  if (r.editable) { await cdp(s, tab.id, 'Input.insertText', { text }); return { text: `filled ${sel} (contenteditable)`, data: r } }
  if (!r.ok) throw new Error(`fill failed — the element now holds ${JSON.stringify(r.value)} (masked or reformatting input) ${sel}`)
  return { text: `filled ${sel}`, data: r }
}

// some handlers key off Windows virtual-key codes; Chrome only derives them for a-z
const CHAR_VK = { ' ': 32, ';': 186, '=': 187, ',': 188, '-': 189, '.': 190, '/': 191, '`': 192, '[': 219, '\\': 220, ']': 221, "'": 222 }
const vkOf = (ch) => /[a-z0-9]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : (CHAR_VK[ch] || 0)

async function typeCmd(s, sel, text, flags) {
  const tab = await resolveTab(s)
  const found = await evalJS(s, tab.id, `(() => { const el = ${selExpr(sel)}; if (!el) return false; el.focus(); return true })()`)
  if (!found) throw new Error(`element not found: ${sel}`)
  // a small default delay: editors detect trigger characters (#, @) on their
  // update cycle, and back-to-back synthetic keys land before it runs
  const delay = parseInt(flags.delay ?? 15, 10) || 0
  for (const ch of String(text)) {
    if (ch === '\n' || ch === '\r') {
      await cdp(s, tab.id, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      await cdp(s, tab.id, 'Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter', windowsVirtualKeyCode: 13 })
      await cdp(s, tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    } else {
      const vk = vkOf(ch)
      await cdp(s, tab.id, 'Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
      await cdp(s, tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    }
    if (delay) await sleep(delay)
  }
  return { text: `typed ${String(text).length} chars into ${sel}` }
}

const PRESS_KEYS = {
  escape: ['Escape', 27], tab: ['Tab', 9], enter: ['Enter', 13], backspace: ['Backspace', 8],
  delete: ['Delete', 46], home: ['Home', 36], end: ['End', 35], pageup: ['PageUp', 33], pagedown: ['PageDown', 34],
  arrowup: ['ArrowUp', 38], arrowdown: ['ArrowDown', 40], arrowleft: ['ArrowLeft', 37], arrowright: ['ArrowRight', 39],
}

async function pressCmd(s, chunk) {
  // trusted key presses / shortcuts (press Escape, press Meta+a). `press`
  // never inserts text — use `fill`/`type` for that
  const parts = String(chunk).split('+').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) throw new Error('usage: press <key[+mod]>, e.g. press Escape, press Meta+a')
  const MOD = { ctrl: 'Control', control: 'Control', meta: 'Meta', cmd: 'Meta', command: 'Meta', shift: 'Shift', alt: 'Alt' }
  const BIT = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
  const VK = { Alt: 18, Control: 17, Meta: 91, Shift: 16 }
  const mods = parts.slice(0, -1).map((p) => MOD[p.toLowerCase()])
  if (mods.includes(undefined)) throw new Error(`unknown modifier in "${chunk}" — use ctrl|meta|cmd|shift|alt`)
  const name = parts[parts.length - 1].toLowerCase()
  const fk = /^f([1-9]|1[0-2])$/.exec(name)
  const def = PRESS_KEYS[name] || (/^[a-z]$/.test(name) ? [name.toUpperCase(), name.toUpperCase().charCodeAt(0)] : null)
    || (/^[0-9]$/.test(name) ? [name, name.charCodeAt(0)] : null) || (fk ? ['F' + fk[1], 111 + Number(fk[1])] : null)
  if (!def) throw new Error(`unknown key "${parts[parts.length - 1]}" — letter, digit, F1-F12, escape, tab, enter, backspace, delete, arrows, home/end, pageup/pagedown`)
  const [key, vk] = def
  const code = /^[a-z]$/.test(name) ? 'Key' + key : /^[0-9]$/.test(name) ? 'Digit' + key : key
  const tab = await resolveTab(s)
  const press = (type, key, code, vk, modifiers) =>
    cdp(s, tab.id, 'Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  let mask = 0
  for (const m of mods) { mask |= BIT[m]; await press('rawKeyDown', m, m + 'Left', VK[m], mask) }
  await press('rawKeyDown', key, code, vk, mask)
  await press('keyUp', key, code, vk, mask)
  for (const m of mods.reverse()) { mask &= ~BIT[m]; await press('keyUp', m, m + 'Left', VK[m], mask) }
  return { text: `pressed ${chunk}` }
}

async function selectCmd(s, sel, val) {
  const tab = await resolveTab(s)
  const r = await evalJS(s, tab.id, `(() => {
    const el = ${selExpr(sel)}
    if (!el) return { error: 'not found' }
    if (el.tagName !== 'SELECT') return { error: 'not a <select> (tag: ' + el.tagName.toLowerCase() + ')' }
    const want = ${JSON.stringify(String(val))}
    const opts = Array.from(el.options)
    const opt = opts.find((o) => o.value === want) || opts.find((o) => o.text.trim() === want)
    if (!opt) return { error: 'no option with value or label: ' + want, options: opts.slice(0, 50).map((o) => ({ value: o.value, text: o.text })) }
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
    if (desc && desc.set) desc.set.call(el, opt.value); else el.value = opt.value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { value: el.value, text: el.selectedOptions[0] ? el.selectedOptions[0].text : '' }
  })()`)
  if (r.error) throw new Error(r.error + (r.options ? '\navailable options: ' + r.options.map((o) => `${o.value} ("${o.text}")`).join(', ') : ''))
  return { text: `selected "${r.text}" (value=${r.value})`, data: r }
}

// tokens/credentials never reach command output unless --raw is passed
const SECRET_URL = /([?&][^?&#=]*(?:token|auth|key|pwd|pass|secret|sig)[^?&#=]*=)[^&#]*/gi
const SECRET_HEADER = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key)$/i
const redactUrl = (u) => String(u).replace(SECRET_URL, '$1[REDACTED]')
const redactHeaders = (hs) => hs && Object.fromEntries(Object.entries(hs).map(([k, v]) => [k, SECRET_HEADER.test(k) ? '[REDACTED]' : v]))

function renderRequests(list, raw) {
  if (!list.length) return 'no requests tracked (only tabs touched by commands record traffic)'
  const lines = []
  for (const e of list.slice(-120)) {
    // mocked-then-failed (e.g. CORS-refused) is the interesting combination
    const st = e.mocked && e.error ? `${e.mocked} → ${e.error}` : (e.mocked ?? e.status ?? '…')
    lines.push(`#${String(e.n).padEnd(5)}${String(e.method || 'GET').padEnd(8)}${String(st).padEnd(12)}${String(e.type || '').padEnd(12)}${(raw ? e.url : redactUrl(e.url)).slice(0, 140)}`)
  }
  return lines.join('\n')
}

async function requestDetail(s, ref, raw) {
  let e = s.requests.find((x) => String(x.n) === String(ref))
  if (!e) e = s.requests.find((x) => x.id && String(x.id).startsWith(String(ref)))
  if (!e) throw new Error(`no request matching "${ref}" — run "network requests" first`)
  const L = [`#${e.n} ${e.method} ${e.status ?? ''} ${raw ? e.url : redactUrl(e.url)}`]
  if (e.route) L.push(`intercepted by route "${e.route}"${e.mocked ? ` (${e.mocked})` : ''}`)
  const headers = (hs) => Object.entries(hs).map(([k, v]) => `${k}: ${!raw && SECRET_HEADER.test(k) ? '[REDACTED]' : v}`).join('\n')
  if (e.requestHeaders && Object.keys(e.requestHeaders).length) {
    L.push('\n-- request headers --\n' + headers(e.requestHeaders))
  }
  if (e.postData) L.push('\n-- request body --\n' + String(e.postData).slice(0, 2000))
  if (e.responseHeaders) L.push('\n-- response headers --\n' + headers(e.responseHeaders))
  if (e.mockBody !== undefined) L.push('\n-- mocked body --\n' + String(e.mockBody).slice(0, 2000))
  if (e.tabId && !e.route) { // intercepted ones never had a real response body
    try {
      const b = await cdp(s, e.tabId, 'Network.getResponseBody', { requestId: e.id })
      const body = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body
      L.push('\n-- response body --\n' + String(body).slice(0, 4000))
    } catch {}
  }
  return { text: L.join('\n') }
}

// ------------------------------------------------------------- tab commands
async function tabList(s) {
  const tabs = (await rpc('tabs.query', { query: { groupId: s.groupId } }, 8000)).sort((a, b) => a.index - b.index)
  s.tabs = new Map(tabs.map((t) => [t.id, { title: t.title, url: t.url }]))
  const lines = tabs.map((t, i) =>
    `t${i + 1}${t.id === s.activeTabId ? '*' : ' '} tabId=${t.id}${s.labels[t.id] ? ` label=${s.labels[t.id]}` : ''} "${String(t.title || '').slice(0, 50)}"\n      ${t.url}`)
  const data = tabs.map((t, i) => ({ ref: `t${i + 1}`, tabId: t.id, label: s.labels[t.id] || null, title: t.title, url: t.url, active: t.id === s.activeTabId }))
  return { text: lines.join('\n') || '(no tabs)', data: { tabs: data } }
}

async function tabNew(s, url, label) {
  const tab = await rpc('tabs.create', { props: { url: url || 'about:blank', active: true } }, 20000)
  try {
    await rpc('tabs.group', { tabIds: [tab.id], groupId: s.groupId }, 8000)
  } catch (e) {
    await rpc('tabs.remove', { tabId: tab.id }, 5000).catch(() => {})
    throw new Error('could not add tab to session group: ' + e.message)
  }
  if (label) s.labels[tab.id] = String(label)
  s.activeTabId = tab.id
  s.tabs.set(tab.id, { title: tab.title || '', url: tab.url || url || '' })
  saveSession(s)
  return { text: `opened tab tabId=${tab.id}${label ? ` label=${label}` : ''} in "${s.name}"` }
}

async function tabSwitch(s, ref) {
  const { tab, tabs } = await resolveTabRef(s, ref)
  await rpc('tabs.update', { tabId: tab.id, props: { active: true } }, 8000)
  try { await rpc('windows.update', { windowId: tab.windowId, props: { focused: true } }, 5000) } catch {}
  s.activeTabId = tab.id
  saveSession(s)
  const i = tabs.findIndex((t) => t.id === tab.id)
  return { text: `switched to t${i + 1} (tabId=${tab.id})` }
}

async function tabClose(s, ref) {
  const { tab, tabs } = await resolveTabRef(s, ref)
  const i = tabs.findIndex((t) => t.id === tab.id)
  await rpc('tabs.remove', { tabId: tab.id }, 8000)
  attached.delete(tab.id)
  delete s.labels[tab.id]
  s.tabs.delete(tab.id)
  if (s.activeTabId === tab.id) {
    const rest = tabs.filter((t) => t.id !== tab.id)
    s.activeTabId = rest.length ? rest[0].id : null
  }
  saveSession(s)
  return { text: `closed t${i + 1} (tabId=${tab.id})` }
}

// ---------------------------------------------------------------- dispatch
const USAGE = {
  goto: ['open|goto <url>', 1], open: ['open|goto <url>', 1],
  screenshot: ['screenshot <path> [--full] [--scale n] [--max-width n] [--el <sel|@ref>]', 1],
  click: ['click <selector|@ref>', 1],
  fill: ['fill <selector> <text>', 2], type: ['type <selector> <text> [--delay ms]', 2],
  press: ['press <key[+mod]>', 1],
  get: ['get text|html <sel>', 2],
  select: ['select <selector> <value|label>', 2], eval: ['eval <js>', 1],
  scrollintoview: ['scrollintoview <selector|@ref>', 1],
  viewport: ['viewport <w> <h> [--dpr n] | viewport reset', 1],
  storage: ['storage get|set|clear local|session <key> [value]', 2],
}

async function dispatch(session, cmd, args, flags) {
  if (cmd === 'shutdown') { setTimeout(quit, 100); return { text: 'daemon shutting down', data: { managed: !!process.env.CTRL_BROWSE_MANAGED } } }
  if (cmd === 'status') {
    if (!ext) {
      // give the extension's service worker a moment to wake up and connect
      const t0 = Date.now()
      while (!ext && Date.now() - t0 < 8000) await sleep(250)
    }
    return {
      text: `daemon: pid ${process.pid} on 127.0.0.1:${PORT}${process.env.CTRL_BROWSE_MANAGED ? ' (launchagent)' : ''}\nbrowser: ${ext ? 'connected' : 'not connected (open Chrome with the ctrl-browse extension loaded — it connects within ~30s of the daemon starting)'}\nsessions: ${sessions.size ? [...sessions.keys()].join(', ') : '(none)'}`,
    }
  }
  if (cmd === 'sessions') {
    const out = []
    for (const s of sessions.values()) {
      let n = '?'
      try { n = (await rpc('tabs.query', { query: { groupId: s.groupId } }, 5000)).length } catch {}
      out.push(`${s.name}  groupId=${s.groupId}  tabs=${n}`)
    }
    return { text: out.length ? out.join('\n') : 'no sessions', data: { sessions: [...sessions.keys()] } }
  }

  const wantsUrl = cmd === 'goto' || cmd === 'open'
  const u = USAGE[cmd]
  if (u && args.length < u[1]) throw new Error('usage: ' + u[0])
  const s = await ensureSession(session, { create: cmd !== 'close', url: wantsUrl ? args[0] : undefined })

  switch (cmd) {
    case 'goto': case 'open': return gotoCmd(s, args[0], flags)
    case 'close': return closeCmd(s)
    case 'back': case 'forward': {
      const tab = await resolveTab(s)
      await rpc(cmd === 'back' ? 'tabs.goBack' : 'tabs.goForward', { tabId: tab.id }, 10000)
      try { await waitComplete(tab.id, 5000) } catch {}
      return { text: cmd === 'back' ? 'navigated back' : 'navigated forward' }
    }
    case 'reload': {
      const tab = await resolveTab(s)
      await rpc('tabs.reload', { tabId: tab.id }, 10000)
      try { await waitComplete(tab.id, parseInt(flags.timeout || 20000, 10)) } catch {}
      return { text: 'reloaded' }
    }
    case 'dom': {
      const tab = await resolveTab(s)
      const html = await evalJS(s, tab.id, 'document.documentElement.outerHTML')
      const limit = parseInt(flags.limit || 200000, 10)
      const out = String(html).slice(0, limit)
      return { text: out + (String(html).length > limit ? `\n\n[truncated at ${limit} chars]` : ''), data: { html: out } }
    }
    case 'snapshot': {
      const tab = await resolveTab(s)
      const res = await evalJS(s, tab.id, `(${PAGE_SRC})(${JSON.stringify({ interactive: !!flags.i, limit: parseInt(flags.limit || 150, 10) })})`)
      return { text: renderSnapshot(res), data: res }
    }
    case 'screenshot': {
      const tab = await resolveTab(s)
      const params = { format: 'png', captureBeyondViewport: !!flags.full }
      let width // clip width, for --max-width scaling
      if (flags.el) {
        const r = await evalJS(s, tab.id, `(() => { const el = ${selExpr(flags.el)}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: Math.max(0, b.left), y: Math.max(0, b.top), width: b.width, height: b.height } })()`)
        if (!r) throw new Error(`element not found: ${flags.el}`)
        params.clip = r; width = r.width
      } else if (flags.scale || flags['max-width']) {
        params.clip = flags.full
          ? await cdp(s, tab.id, 'Page.getLayoutMetrics').then((m) => ({ x: 0, y: 0, width: m.contentSize.width, height: m.contentSize.height }))
          : await evalJS(s, tab.id, '({ x: 0, y: 0, width: innerWidth, height: innerHeight })')
        width = params.clip.width
      }
      if (width && (flags.scale || flags['max-width'])) {
        const sc = flags.scale ? parseFloat(flags.scale) : parseFloat(flags['max-width']) / width
        if (sc > 0) params.clip.scale = Math.min(2, sc) // capped: CDP rejects scale > 2
      }
      const shot = await cdp(s, tab.id, 'Page.captureScreenshot', params, 20000)
      return { text: 'ok', data: { bytes: shot.data } }
    }
    case 'press': return pressCmd(s, args[0])
    case 'viewport': {
      const tab = await resolveTab(s)
      if (args[0] === 'reset') { await cdp(s, tab.id, 'Emulation.clearDeviceMetricsOverride'); return { text: 'viewport reset' } }
      const [w, h] = [parseInt(args[0], 10), parseInt(args[1], 10)]
      if (!w || !h) throw new Error('usage: viewport <w> <h> [--dpr n] | viewport reset')
      const dpr = parseFloat(flags.dpr)
      await cdp(s, tab.id, 'Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: isNaN(dpr) ? 0 : dpr, mobile: false })
      return { text: `viewport ${w}×${h}${isNaN(dpr) ? '' : ` dpr ${dpr}`}` }
    }
    case 'storage': {
      const [sub, kind, key] = args
      const sto = kind === 'local' ? 'localStorage' : kind === 'session' ? 'sessionStorage' : null
      const k = JSON.stringify(String(key || ''))
      if (!sub || !sto || (sub !== 'clear' && !key)) throw new Error('usage: storage get|set|clear local|session <key> [value]')
      const tab = await resolveTab(s)
      const js = sub === 'get' ? `${sto}.getItem(${k})`
        : sub === 'set' ? `${sto}.setItem(${k}, ${JSON.stringify(args.slice(3).join(' '))})`
        : key ? `${sto}.removeItem(${k})` : `${sto}.clear()`
      const v = await evalJS(s, tab.id, js)
      if (sub === 'get') return { text: String(v), data: { key, value: v } }
      return { text: `cleared ${sto}${key ? `.${key}` : ''}` }
    }
    case 'click': return clickCmd(s, args[0])
    case 'fill': return fillCmd(s, args[0], args.slice(1).join(' '))
    case 'type': return typeCmd(s, args[0], args.slice(1).join(' '), flags)
    case 'select': return selectCmd(s, args[0], args.slice(1).join(' '))
    case 'find': {
      let a = [...args]
      let action = flags.action
      const last = a[a.length - 1]
      if (!action && (last === 'click' || last === 'show')) { action = last; a = a.slice(0, -1) }
      action = action || 'show'
      const kind = a[0]
      if (!['role', 'text', 'label'].includes(kind)) throw new Error('usage: find role <role> [--name <s>] | find label <accessible name> | find text <text>  [click|show]')
      const needle = kind === 'role' ? a[1] : a.slice(1).join(' ')
      if (!needle) throw new Error(`missing ${kind}`)
      const tab = await resolveTab(s)
      const res = (await evalJS(s, tab.id, `(${PAGE_SRC})(${JSON.stringify({ find: { kind, needle, name: flags.name } })})`)) || []
      let text = res.length ? res.map((e) => `@${e.ref}  ${String(e.role).padEnd(9)} ${e.text || ''}`).join('\n') : 'no matches'
      if (action === 'click') {
        if (!res.length) throw new Error(`no match for ${kind} "${needle}" — cannot click`)
        if (res.length > 1) text += `\n${res.length} matches — clicked the first (re-run with a narrower query to target another)`
        const r = await clickCmd(s, '@' + res[0].ref)
        text += `\n${r.text}`
      }
      return { text, data: { matches: res } }
    }
    case 'wait': return waitCmd(s, args, flags)
    case 'eval': {
      const tab = await resolveTab(s)
      const v = await evalJS(s, tab.id, args.join(' '))
      let text
      try { text = typeof v === 'string' ? v : v === undefined ? 'undefined' : JSON.stringify(v, null, 2) } catch { text = String(v) }
      return { text, data: { result: v } }
    }
    case 'scrollintoview': {
      const tab = await resolveTab(s)
      const ok = await evalJS(s, tab.id, `(() => { const el = ${selExpr(args[0])}; if (!el) return false; el.scrollIntoView({ block: 'center' }); return true })()`)
      if (!ok) throw new Error(`element not found: ${args[0]}`)
      return { text: `scrolled into view: ${args[0]}` }
    }
    case 'get': {
      const sub = args[0]
      if ((sub !== 'text' && sub !== 'html') || !args[1]) throw new Error('usage: get text <sel> | get html <sel>')
      const tab = await resolveTab(s)
      const r = await evalJS(s, tab.id, `(() => { const el = ${selExpr(args[1])}; if (!el) return null; return ${sub === 'text' ? 'el.innerText' : 'el.innerHTML'} })()`)
      if (r === null) throw new Error(`element not found: ${args[1]}`)
      return { text: String(r), data: sub === 'text' ? { text: r } : { html: r } }
    }
    case 'mouse': {
      const sub = args[0]
      const tab = await resolveTab(s)
      if (sub === 'move') {
        const x = Number(args[1]); const y = Number(args[2])
        if (Number.isNaN(x) || Number.isNaN(y)) throw new Error('usage: mouse move <x> <y> [--duration ms] [--steps n] [--human --seed n]')
        await mouseMoveCmd(s, tab.id, x, y, flags)
        return { text: `mouse at ${x},${y}` }
      }
      if (sub === 'down' || sub === 'up') {
        const btn = args[1] || 'left'
        if (!['left', 'right', 'middle'].includes(btn)) throw new Error('button: left|right|middle')
        const p = posOf(tab.id)
        const mask = btn === 'left' ? 1 : btn === 'right' ? 2 : 4
        await cdp(s, tab.id, 'Input.dispatchMouseEvent',
          sub === 'down'
            ? { type: 'mousePressed', x: p.x, y: p.y, button: btn, buttons: mask, clickCount: 1 }
            : { type: 'mouseReleased', x: p.x, y: p.y, button: btn, buttons: 0, clickCount: 1 })
        return { text: `${sub} ${btn} at ${p.x},${p.y}` }
      }
      if (sub === 'wheel') {
        const dy = Number(args[1] || 0); const dx = Number(args[2] || 0)
        const p = posOf(tab.id)
        await cdp(s, tab.id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: dx, deltaY: dy })
        return { text: `wheel dy=${dy} dx=${dx} at ${p.x},${p.y}` }
      }
      throw new Error('usage: mouse move <x> <y> | mouse down [button] | mouse up [button] | mouse wheel <dy> [dx]')
    }
    case 'network': {
      const sub = args[0]
      if (sub === 'route') {
        const pat = args[1]
        if (!pat) throw new Error('usage: network route <pattern> [--body <json>] [--status n] [--method M] [--times n] [--header "Name: value"] [--content-type ct] [--resource-type t] [--abort]')
        const headers = (Array.isArray(flags.header) ? flags.header : flags.header ? [flags.header] : [])
          .map((kv) => { const i = String(kv).indexOf(':'); return i === -1 ? null : { name: String(kv).slice(0, i).trim(), value: String(kv).slice(i + 1).trim() } })
          .filter(Boolean)
        const times = flags.times ? parseInt(flags.times, 10) : undefined
        s.routes.push({
          url: pat, abort: !!flags.abort, headers,
          // --status alone fulfills with an empty body (it used to silently pass through)
          body: flags.body !== undefined ? flags.body : flags.status !== undefined ? '' : undefined,
          status: flags.status ? parseInt(flags.status, 10) : undefined,
          method: flags.method ? String(flags.method).toUpperCase() : undefined,
          times: Number.isFinite(times) ? times : undefined,
          contentType: flags['content-type'], resourceType: flags['resource-type'],
        })
        await syncRoutes(s)
        return { text: `route added (${s.routes.length} active — applies to every tab in "${s.name}")` }
      }
      if (sub === 'unroute') {
        const pat = args[1]
        const before = s.routes.length
        s.routes = pat ? s.routes.filter((r) => r.url !== pat) : []
        await syncRoutes(s)
        return { text: `removed ${before - s.routes.length} route(s), ${s.routes.length} remain` }
      }
      if (sub === 'requests') {
        if (flags.clear) { s.requests = []; s.reqMap = new Map(); return { text: 'request log cleared' } }
        let list = s.requests
        if (flags.filter) { const re = globToRegex(flags.filter, { anchored: false, ignoreCase: true }); list = list.filter((e) => re.test(e.url)) }
        if (flags.type) { const want = String(flags.type).split(',').map((x) => x.trim().toLowerCase()); list = list.filter((e) => want.includes(String(e.type || '').toLowerCase())) }
        if (flags.method) { const want = String(flags.method).split(',').map((x) => x.trim().toUpperCase()); list = list.filter((e) => want.includes(String(e.method || '').toUpperCase())) }
        if (flags.status) list = list.filter((e) => (typeof e.status === 'number' ? statusMatch(flags.status, e.status) : String(e.status || '').includes(String(flags.status))))
        if (!flags.raw) list = list.map((e) => ({ ...e, url: redactUrl(e.url), requestHeaders: redactHeaders(e.requestHeaders), responseHeaders: redactHeaders(e.responseHeaders) }))
        return { text: renderRequests(list, !!flags.raw), data: { requests: list.slice(-200) } }
      }
      if (sub === 'request') {
        if (!args[1]) throw new Error('usage: network request <n|id> [--raw]')
        return requestDetail(s, args[1], !!flags.raw)
      }
      throw new Error('usage: network route|unroute|requests|request')
    }
    case 'tab': {
      if (args[0] === undefined || args[0] === 'list') return tabList(s)
      if (args[0] === 'new') return tabNew(s, args[1], flags.label)
      if (args[0] === 'close') return tabClose(s, args[1])
      return tabSwitch(s, args[0])
    }
    case 'console': {
      if (flags.clear) { s.console = []; return { text: 'console cleared' } }
      const list = s.console.filter((e) => !flags['since-nav'] || e.ts >= (navTs.get(e.tabId) || 0)).slice(-200)
      if (flags.json) return { text: 'ok', data: { entries: list } }
      return {
        text: list.length
          ? list.map((e) => `${tsf(e.ts)}  ${String(e.type).padEnd(8)} ${String(e.text).slice(0, 200)}`).join('\n')
          : 'no console messages (only tabs touched by commands are tracked)',
      }
    }
    case 'errors': {
      if (flags.clear) { s.errors = []; return { text: 'errors cleared' } }
      const list = s.errors.filter((e) => !flags['since-nav'] || e.ts >= (navTs.get(e.tabId) || 0)).slice(-100)
      return {
        text: list.length
          ? list.map((e) => `${tsf(e.ts)}  ${e.text}`).join('\n')
          : 'no page errors (only tabs touched by commands are tracked)',
      }
    }
    default:
      throw new Error(`unknown command: ${cmd} — run "ctrl-browse help"`)
  }
}

async function waitCmd(s, args, flags) {
  const tab = await resolveTab(s)
  const timeout = parseInt(flags.timeout || 10000, 10)
  const interval = Math.max(50, parseInt(flags.interval || 200, 10))
  const t0 = Date.now()
  const poll = async (desc, test) => {
    for (;;) {
      const hit = await test().catch(() => false)
      if (hit) return { text: `${desc} after ${Date.now() - t0}ms` }
      if (Date.now() - t0 > timeout) throw new Error(`${desc} — timed out after ${timeout}ms`)
      await sleep(interval)
    }
  }
  const page = (js) => () => evalJS(s, tab.id, js)
  const q = (v) => JSON.stringify(String(v))
  if (flags.text) return poll(`found text "${flags.text}"`, page(`document.body ? document.body.innerText.indexOf(${q(flags.text)}) !== -1 : false`))
  if (flags['text-gone']) return poll(`text "${flags['text-gone']}" gone`, page(`document.body ? document.body.innerText.indexOf(${q(flags['text-gone'])}) === -1 : true`))
  if (flags.gone) return poll(`element "${flags.gone}" gone`, page(`!document.querySelector(${q(flags.gone)})`))
  if (flags.fn) return poll(`--fn (${String(flags.fn).slice(0, 60)}) truthy`, () => evalJS(s, tab.id, String(flags.fn)).then(Boolean))
  if (flags['network-idle']) {
    // "nothing new for this tab in the last N ms" — queries the tracked log.
    // ms comes from the flag value or, being boolean, the first positional arg
    const idle = parseInt(flags['network-idle'], 10) || parseInt(args[0], 10) || 500
    return poll(`network idle (${idle}ms quiet)`, () => {
      const last = Math.max(0, ...s.requests.filter((e) => e.tabId === tab.id).map((e) => e.ts))
      return Date.now() - last >= idle
    })
  }
  if (flags.load) {
    const t = await rpc('tabs.get', { tabId: tab.id }).catch(() => { throw new Error('tab was closed') })
    if (t.status === 'complete') return { text: 'page already loaded' }
    await waitComplete(tab.id, timeout)
    return { text: 'page loaded' }
  }
  const a = args[0]
  if (a === undefined) throw new Error('usage: wait <selector|ms> | wait --text <s> | --text-gone <s> | wait --gone <sel> | wait --fn <js> | wait --network-idle [ms] | wait --load  [--timeout ms] [--interval ms]')
  if (/^\d+$/.test(a)) { await sleep(parseInt(a, 10)); return { text: `waited ${a}ms` } }
  return poll(`element "${a}" appeared`, page(`!!document.querySelector(${q(a)})`))
}

// ------------------------------------------------------------- ws server
const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: PORT,
  verifyClient: (info) => {
    const o = info.origin || (info.req && info.req.headers.origin)
    return !o || String(o).startsWith('chrome-extension://') // reject browser-page origins
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

wss.on('connection', (ws) => {
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
    if (m && m.event === 'hello') {
      // fresh extension session (e.g. SW restart) — its debugger attaches are gone
      isExt = true; ext = ws; attached.clear(); mousePos.clear()
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
      ext = null
      // fail in-flight commands immediately instead of letting them hang to timeout
      for (const [, e] of pendingRpcs) { clearTimeout(e.timer); e.reject(new Error('browser connection lost')) }
      pendingRpcs.clear()
      console.log('[ctrl-browse] browser extension disconnected')
    }
  })
})

// keepalive so the MV3 service worker doesn't get suspended
setInterval(() => { if (ext) { try { ext.send(JSON.stringify({ event: 'ping' })) } catch {} } }, 20000).unref?.()

// detach all debuggers and exit — also used by the shutdown command
// (a killed daemon leaves tabs debugger-locked for the next daemon)
async function quit() {
  for (const tabId of [...attached]) {
    try { await rpc('debug.detach', { tabId }, 2000) } catch {}
    attached.delete(tabId)
  }
  process.exit(0)
}
process.on('SIGTERM', quit)
process.on('SIGINT', quit)
process.on('uncaughtException', (e) => { console.error('[ctrl-browse] fatal:', (e && e.message) || e); process.exit(1) })
process.on('unhandledRejection', (e) => console.error('[ctrl-browse] async error:', (e && e.message) || e))
console.log(`[ctrl-browse] daemon listening on 127.0.0.1:${PORT}`)