// request log, route mocking (Fetch domain), request detail, the network command
import { RES, MAX_REQUESTS, cap, globToRegex, hval, SECRET_HEADER, redactUrl, redactHeaders, statusMatch, warn, errMsg } from './util.js'
import { rpc } from './bridge.js'
import { attach, cdp } from './cdp.js'
import { applyRoutes } from './routes.js'

/** @typedef {import('./state.js').Session} Session */

/** @param {Session} s */
export async function syncRoutes(s) {
  const tabs = await rpc('tabs.query', { query: { groupId: s.groupId } }, 8000)
  for (const t of tabs) {
    try { await attach(s, t.id); await applyRoutes(s, t.id) } catch (e) { warn(`route sync (tab ${t.id})`)(e) }
  }
}

/** @param {Session} s */
export function trackRequest(s, tabId, p) {
  const prev = s.reqMap.get(p.requestId)
  if (prev) {
    // redirect: the previous hop is finished — keep it in the list, start a new entry
    s.reqMap.delete(p.requestId)
    if (!prev.done) Object.assign(prev, { status: p.redirectResponse ? p.redirectResponse.status : 'redirect', done: true, endTs: Date.now() })
  }
  const e = {
    n: ++s.reqSeq, ts: Date.now(), id: p.requestId, tabId,
    method: p.request.method, url: p.request.url,
    type: (p.type || '').toLowerCase() || undefined,
    status: null, requestHeaders: p.request.headers, postData: p.request.postData,
    responseHeaders: null, done: false,
  }
  s.reqMap.set(p.requestId, e)
  s.requests.push(e)
  while (s.requests.length > MAX_REQUESTS) { const old = s.requests.shift(); if (old && s.reqMap.get(old.id) === old) s.reqMap.delete(old.id) }
}

// route matches are recorded on the network entry they intercepted. Fetch
// interception ids live in their own space ("interception-job-N"), so a
// request already tracked by requestWillBeSent is matched by url+method
// instead; the synthetic-row fallback is only for requests the Network
// events missed entirely
/** @param {Session} s @param {number} tabId @param {any} p @param {string} status @param {string|null} routeUrl @param {string} [mockBody] */
export function markIntercepted(s, tabId, p, status, routeUrl, mockBody) {
  const e = s.reqMap.get(p.requestId)
    || [...s.requests].reverse().find((r) => r.tabId === tabId && r.status === null
      && (r.method || 'GET').toUpperCase() === p.request.method.toUpperCase() && r.url === p.request.url)
  if (e) Object.assign(e, { route: routeUrl, mocked: status, status, done: true, endTs: Date.now(), mockBody })
  else {
    s.requests.push({
      n: ++s.reqSeq, ts: Date.now(), endTs: Date.now(), id: p.requestId, tabId,
      method: p.request.method, url: p.request.url, type: (p.resourceType || '').toLowerCase() || undefined,
      status, route: routeUrl, mocked: status, done: true,
    })
    cap(s.requests, MAX_REQUESTS)
  }
}

/** @param {Session} s */
export async function onPause(s, tabId, p) {
  const url = p.request.url
  const rt = (p.resourceType || '').toLowerCase()
  const req = p.request
  const cont = () => cdp(s, tabId, 'Fetch.continueRequest', { requestId: p.requestId }).catch(warn('Fetch.continueRequest'))
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
    }).catch(warn('preflight fulfill'))
    return
  }
  const route = s.routes.find((r) => (!r.method || req.method.toUpperCase() === r.method) && matches(r))
  if (!route) return cont()
  if (route.abort || route.body !== undefined) {
    markIntercepted(s, tabId, p, route.abort ? 'blocked' : `mocked ${route.status || 200}`, route.url, route.abort ? undefined : route.body)
    if (route.times !== undefined && --route.times <= 0) {
      s.routes = s.routes.filter((r) => r !== route)
      syncRoutes(s).catch(warn('route sync after --times'))
    }
  }
  if (route.abort) return cdp(s, tabId, 'Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' }).catch(warn('Fetch.failRequest'))
  if (route.body === undefined) return cont()
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
  }).catch(warn('Fetch.fulfillRequest'))
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

/** @param {Session} s */
export async function requestDetail(s, ref, raw) {
  let e = s.requests.find((x) => String(x.n) === String(ref))
  if (!e) e = s.requests.find((x) => x.id && String(x.id).startsWith(String(ref)))
  if (!e) throw new Error(`no request matching "${ref}" — run "network requests" first`)
  const L = [`#${e.n} ${e.method} ${e.status ?? ''} ${raw ? e.url : redactUrl(e.url)}`]
  if (e.route) L.push(`intercepted by route "${e.route}"${e.mocked ? ` (${e.mocked})` : ''}`)
  const headers = (hs) => Object.entries(hs).map(([k, v]) => `${k}: ${!raw && SECRET_HEADER.test(k) ? '[REDACTED]' : v}`).join('\n')
  if (e.requestHeaders && Object.keys(e.requestHeaders).length) L.push('\n-- request headers --\n' + headers(e.requestHeaders))
  if (e.postData) L.push('\n-- request body --\n' + String(e.postData).slice(0, 2000))
  if (e.responseHeaders) L.push('\n-- response headers --\n' + headers(e.responseHeaders))
  if (e.mockBody !== undefined) L.push('\n-- mocked body --\n' + String(e.mockBody).slice(0, 2000))
  if (e.tabId && !e.route) { // intercepted ones never had a real response body
    try {
      const b = await cdp(s, e.tabId, 'Network.getResponseBody', { requestId: e.id })
      const body = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body
      L.push('\n-- response body --\n' + String(body).slice(0, 4000))
    } catch (err) {
      L.push(`\n-- response body unavailable (${errMsg(err).slice(0, 120)}) --`)
    }
  }
  return { text: L.join('\n') }
}

/** @param {Session} s @param {string[]} args @param {import('../spec.js').Flags} flags */
export async function networkCmd(s, args, flags) {
  const sub = args[0]
  if (sub === 'route') {
    const pat = args[1]
    if (!pat) throw new Error('usage: network route <pattern> [--body <json>] [--status n] [--method M] [--times n] [--header "Name: value"] [--content-type ct] [--resource-type t] [--abort]')
    const headers = (flags.header || []).flatMap((kv) => {
      const i = kv.indexOf(':')
      return i === -1 ? [] : [{ name: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim() }]
    })
    const times = flags.times ? parseInt(flags.times, 10) : undefined
    s.routes.push({
      url: pat, abort: !!flags.abort, headers,
      // --status alone fulfills with an empty body
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
