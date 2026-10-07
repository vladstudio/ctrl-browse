// CDP / tab events from the extension
import { MAX_CONSOLE, MAX_ERRORS, cap } from './util.js'
import { sessions, dropSession } from './state.js'
import { rpc } from './bridge.js'
import { attached, loadWaiters, mainFrameId, mainCtxId, noCtx, navTs } from './cdp.js'
import { trackRequest, onPause } from './network.js'
import { mousePos } from './input.js'

export function sessionOfTab(tabId) {
  for (const s of sessions.values()) if (s.tabs.has(tabId)) return s
  return null
}

export function logConsole(s, tabId, p) {
  const text = (p.args || []).map((a) => a.value !== undefined ? String(a.value)
    : a.preview ? '{ ' + a.preview.properties.map((q) => `${q.name}: ${String(q.value).slice(0, 60)}`).join(', ') + ' }'
    : a.description || a.type || '').join(' ')
  s.console.push({ ts: p.timestamp || Date.now(), tabId, type: p.type || 'log', text })
  cap(s.console, MAX_CONSOLE)
}

export function pushErr(s, tabId, text) {
  s.errors.push({ ts: Date.now(), tabId, text: String(text).slice(0, 1000) })
  cap(s.errors, MAX_ERRORS)
}

export function handleEvent(m) {
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
