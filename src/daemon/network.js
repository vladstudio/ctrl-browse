// request log, route mocking (Fetch domain), request detail
import { RES, MAX_REQUESTS, cap, globToRegex, hval, SECRET_HEADER, redactUrl } from './util.js'
import { rpc } from './bridge.js'
import { attach, cdp } from './cdp.js'

export function routePatterns(routes) {
  return routes.map((r) => ({
    // CDP urlPatterns need a scheme (or a leading wildcard) or they match nothing —
    // scheme-less "host/*" patterns work in our matcher, so translate for CDP
    urlPattern: /:\/\//.test(r.url) || r.url.startsWith('*') ? r.url : '**/' + r.url,
    requestStage: 'Request',
    ...(r.resourceType ? { resourceType: RES[String(r.resourceType).toLowerCase()] || 'Other' } : {}),
  }))
}

export async function applyRoutes(s, tabId) {
  try { await rpc('debug.send', { tabId, method: 'Fetch.disable' }, 8000) } catch {}
  if (s.routes.length) await rpc('debug.send', { tabId, method: 'Fetch.enable', params: { patterns: routePatterns(s.routes) } }, 8000)
}

export async function syncRoutes(s) {
  let tabs = []
  try { tabs = await rpc('tabs.query', { query: { groupId: s.groupId } }, 8000) } catch {}
  for (const t of tabs) {
    try { await attach(s, t.id); await applyRoutes(s, t.id) } catch (e) { console.error('[ctrl-browse] route sync failed:', e.message) }
  }
}

export function trackRequest(s, tabId, p) {
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

// route matches are recorded on the network entry they intercepted. Fetch
// interception ids live in their own space ("interception-job-N"), so a
// request already tracked by requestWillBeSent is matched by url+method
// instead; the synthetic-row fallback is only for requests the Network
// events missed entirely
export function markIntercepted(s, tabId, p, status, routeUrl, mockBody) {
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

export async function onPause(s, tabId, p) {
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

export function renderRequests(list, raw) {
  if (!list.length) return 'no requests tracked (only tabs touched by commands record traffic)'
  const lines = []
  for (const e of list.slice(-120)) {
    // mocked-then-failed (e.g. CORS-refused) is the interesting combination
    const st = e.mocked && e.error ? `${e.mocked} → ${e.error}` : (e.mocked ?? e.status ?? '…')
    lines.push(`#${String(e.n).padEnd(5)}${String(e.method || 'GET').padEnd(8)}${String(st).padEnd(12)}${String(e.type || '').padEnd(12)}${(raw ? e.url : redactUrl(e.url)).slice(0, 140)}`)
  }
  return lines.join('\n')
}

export async function requestDetail(s, ref, raw) {
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
