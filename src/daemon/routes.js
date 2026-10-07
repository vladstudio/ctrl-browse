// Fetch-domain interception for a session's routes (kept apart from network.js
// so cdp.js can re-apply routes on attach without an import cycle)
import { RES } from './util.js'
import { rpc } from './bridge.js'

/** @param {import('./state.js').Route[]} routes */
export function routePatterns(routes) {
  return routes.map((r) => ({
    // CDP urlPatterns need a scheme (or a leading wildcard) or they match nothing —
    // scheme-less "host/*" patterns work in our matcher, so translate for CDP
    urlPattern: /:\/\//.test(r.url) || r.url.startsWith('*') ? r.url : '**/' + r.url,
    requestStage: 'Request',
    ...(r.resourceType ? { resourceType: RES[String(r.resourceType).toLowerCase()] || 'Other' } : {}),
  }))
}

/** @param {import('./state.js').Session} s @param {number} tabId */
export async function applyRoutes(s, tabId) {
  await rpc('debug.send', { tabId, method: 'Fetch.disable' }, 8000)
  if (s.routes.length) await rpc('debug.send', { tabId, method: 'Fetch.enable', params: { patterns: routePatterns(s.routes) } }, 8000)
}
