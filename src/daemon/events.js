// CDP / tab events from the extension
import { MAX_CONSOLE, MAX_ERRORS, cap, warn } from './util.js'
import { sessions, dropSession, forgetSession } from './state.js'
import { rpc } from './bridge.js'
import { tabState, peekTab, debuggerGone, forgetTab, contextGone } from './tabstate.js'
import { trackRequest, onPause } from './network.js'

/** @typedef {import('./state.js').Session} Session */

export function sessionOfTab(tabId) {
  for (const s of sessions.values()) if (s.tabs.has(tabId)) return s
  return null
}

/** @param {Session} s */
export function logConsole(s, tabId, p) {
  const text = (p.args || []).map((a) => a.value !== undefined ? String(a.value)
    : a.preview ? '{ ' + a.preview.properties.map((q) => `${q.name}: ${String(q.value).slice(0, 60)}`).join(', ') + ' }'
    : a.description || a.type || '').join(' ')
  s.console.push({ ts: p.timestamp || Date.now(), tabId, type: p.type || 'log', text })
  cap(s.console, MAX_CONSOLE)
}

/** @param {Session} s */
export function pushErr(s, tabId, text) {
  s.errors.push({ ts: Date.now(), tabId, text: String(text).slice(0, 1000) })
  cap(s.errors, MAX_ERRORS)
}

function finishReq(s, requestId, fields) {
  const e = s.reqMap.get(requestId)
  if (e) Object.assign(e, { done: true, endTs: Date.now() }, fields)
}

// we'll never hear how a tab's open requests end (debugger detached, tab
// closed); close them out so they don't hold `wait --network-idle` off forever
function abandonRequests(tabId, why) {
  for (const s of sessions.values()) {
    for (const e of s.requests) if (e.tabId === tabId && !e.done) Object.assign(e, { done: true, endTs: Date.now(), status: 'unknown', error: why })
  }
}

export function handleEvent(m) {
  if (m.event === 'debugEvent') {
    const { tabId, method, params } = m
    if (method === 'Page.loadEventFired') {
      const t = tabState(tabId)
      t.navTs = Date.now()
      for (const w of [...t.loadWaiters]) w.done()
      return
    }
    if (method === 'Runtime.executionContextCreated') {
      const t = peekTab(tabId)
      const c = params.context || {}
      if (t && c.auxData && c.auxData.isDefault && c.auxData.frameId === t.frameId) { contextGone(t); t.ctxId = c.id }
      return
    }
    if (method === 'Runtime.executionContextsCleared') {
      const t = peekTab(tabId)
      if (t) contextGone(t)
      return
    }
    if (method === 'Fetch.requestPaused') {
      const s = sessionOfTab(tabId)
      if (s) { onPause(s, tabId, params).catch(warn('request interception')); return }
      // no session → nobody would continue it; the request would hang forever
      rpc('debug.send', { tabId, method: 'Fetch.continueRequest', params: { requestId: params.requestId } }).catch(warn('Fetch.continueRequest'))
      return
    }
    const s = sessionOfTab(tabId)
    if (!s) return
    if (method === 'Network.requestWillBeSent') { trackRequest(s, tabId, params); return }
    if (method === 'Network.responseReceived') {
      const r = params.response
      finishReq(s, params.requestId, { status: r.status, responseHeaders: r.headers, mimeType: r.mimeType })
      return
    }
    if (method === 'Network.loadingFinished') { finishReq(s, params.requestId, {}); return }
    if (method === 'Network.loadingFailed') { finishReq(s, params.requestId, { status: 'failed', error: params.errorText }); return }
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
  if (m.event === 'debugDetached') { debuggerGone(m.tabId); abandonRequests(m.tabId, 'debugger detached'); return }
  if (m.event === 'tabs.onRemoved') {
    forgetTab(m.tabId)
    abandonRequests(m.tabId, 'tab closed')
    for (const s of sessions.values()) {
      if (s.tabs.delete(m.tabId) && m.windowClosing) s.windowClosing = true
    }
    return
  }
  if (m.event === 'groups.onRemoved') {
    // the user removed the group: the name is free again. Lost with its window
    // (or at quit): keep ownership, so the restored group is re-bound later
    for (const s of [...sessions.values()]) {
      if (s.groupId === m.groupId) (s.windowClosing ? dropSession : forgetSession)(s)
    }
    return
  }
}
