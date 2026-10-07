// Unit tests for pure pieces: argument parsing, url handling, redaction,
// the command registry, network-idle accounting. No daemon, no browser.
import { test, expect } from 'bun:test'
import { parse } from '../src/args.js'
import { COMMANDS, FLAGS, GLOBAL_FLAGS, helpText } from '../src/spec.js'
import { normalizeUrl, globToRegex, statusMatch, redactUrl, redactHeaders, int } from '../src/daemon/util.js'
import { HANDLERS, GLOBAL_HANDLERS } from '../src/daemon/commands.js'
import { networkQuietFor, LONG_REQUEST_MS } from '../src/daemon/nav.js'
import { makeSession } from '../src/daemon/state.js'

test('parse: session, command, args, value and boolean flags', () => {
  const p = parse(['-s', 'x', 'click', '#go', '--force', '--timeout', '500'])
  expect(p).toEqual({ cmd: 'click', args: ['#go'], flags: { force: true, timeout: '500' }, session: 'x' })
  expect(parse(['--session=y', 'eval', '1']).session).toBe('y')
  expect(parse(['--session', 'z', 'eval', '1']).session).toBe('z')
  expect(parse(['wait', '--text=a=b']).flags.text).toBe('a=b')
})

test('parse: repeatable --header', () => {
  expect(parse(['network', 'route', 'x', '--header', 'A: 1', '--header', 'B: 2']).flags.header).toEqual(['A: 1', 'B: 2'])
})

test('parse: -- ends flags; short dash-words are flags only where they mean one', () => {
  expect(parse(['fill', '#q', '--', '--verbose', '-s']).args).toEqual(['#q', '--verbose', '-s'])
  expect(parse(['type', '#q', '-a']).args).toEqual(['#q', '-a'])
  expect(parse(['mouse', 'wheel', '-100']).args).toEqual(['wheel', '-100'])
  expect(parse(['-v']).flags.version).toBe(true)
  expect(parse(['-h', 'click']).flags.help).toBe(true)
  expect(parse(['fill', '#q', '-h'])).toMatchObject({ args: ['#q', '-h'], flags: {} }) // after the command: text
  expect(parse(['fill', '#q', '-v']).args).toEqual(['#q', '-v'])
  expect(parse(['snapshot', '-i']).flags.i).toBe(true)
  expect(parse(['fill', '#q', '-i']).args).toEqual(['#q', '-i']) // fill takes no -i
  expect(parse(['click', '#q', '--help']).flags.help).toBe(true) // long global flags work anywhere
})

test('parse: --network-idle takes an optional =value', () => {
  expect(parse(['wait', '--network-idle', '800']).flags['network-idle']).toBe(true)
  expect(parse(['wait', '--network-idle', '800']).args).toEqual(['800'])
  expect(parse(['wait', '--network-idle=800']).flags['network-idle']).toBe('800')
})

test('parse: unknown flags, misplaced flags and missing values are errors', () => {
  expect(() => parse(['click', 'x', '--forse'])).toThrow('unknown flag --forse')
  expect(() => parse(['click', 'x', '--text', 'a'])).toThrow('not a flag of "click"')
  expect(() => parse(['open', 'x', '--force'])).toThrow('not a flag of "goto"')
  expect(() => parse(['wait', '--text'])).toThrow('--text needs a value')
  expect(() => parse(['click', 'x', '--force=yes'])).toThrow('takes no value')
  expect(() => parse(['-s'])).toThrow('needs a session name')
  expect(parse(['click', 'x', '--json', '--timeout', '5']).flags).toEqual({ json: true, timeout: '5' }) // globals
})

test('spec: every per-command flag is a declared flag', () => {
  for (const c of COMMANDS) for (const f of c.flags || []) expect(FLAGS[f]).toBeDefined()
  for (const f of GLOBAL_FLAGS) expect(FLAGS[f]).toBeDefined()
})

test('normalizeUrl', () => {
  expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000')
  expect(normalizeUrl('localhost:3000/a?b=1')).toBe('http://localhost:3000/a?b=1')
  expect(normalizeUrl('example.com')).toBe('http://example.com')
  expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  expect(normalizeUrl('https://x.test')).toBe('https://x.test')
  expect(normalizeUrl('chrome://settings')).toBe('chrome://settings')
  expect(normalizeUrl('about:blank')).toBe('about:blank')
  expect(normalizeUrl('data:text/html,hi')).toBe('data:text/html,hi')
  expect(normalizeUrl('file:///tmp/a.html')).toBe('file:///tmp/a.html')
})

test('globToRegex, statusMatch, int', () => {
  expect(globToRegex('api.example.com/*').test('api.example.com/users?x=1')).toBe(true)
  expect(globToRegex('api.example.com/*').test('evil.test/api.example.com/x')).toBe(false)
  expect(globToRegex('USERS', { anchored: false, ignoreCase: true }).test('/api/users/1')).toBe(true)
  expect(statusMatch('2xx', 204)).toBe(true)
  expect(statusMatch('400-499', 404)).toBe(true)
  expect(statusMatch('200,301', 301)).toBe(true)
  expect(statusMatch('5xx', 404)).toBe(false)
  expect(int('abc', 7)).toBe(7)
  expect(int('12', 7)).toBe(12)
  expect(int(undefined, 7)).toBe(7)
})

test('redaction', () => {
  expect(redactUrl('https://x.test/a?token=abc&q=1&api_key=k')).toBe('https://x.test/a?token=[REDACTED]&q=1&api_key=[REDACTED]')
  expect(redactUrl('see https://x.test/?sig=zz#frag')).toBe('see https://x.test/?sig=[REDACTED]#frag')
  expect(redactHeaders({ Authorization: 'Bearer x', Accept: '*/*' })).toEqual({ Authorization: '[REDACTED]', Accept: '*/*' })
})

test('every spec command has exactly one handler, and vice versa', () => {
  const remote = COMMANDS.filter((c) => !c.local)
  for (const c of remote) {
    const table = c.session === false ? GLOBAL_HANDLERS : HANDLERS
    expect(typeof table[c.name]).toBe('function')
  }
  const names = new Set(remote.map((c) => c.name))
  for (const n of [...Object.keys(HANDLERS), ...Object.keys(GLOBAL_HANDLERS)]) expect(names.has(n)).toBe(true)
})

test('help documents every command and every flag it takes', () => {
  const help = helpText()
  for (const c of COMMANDS) {
    expect(help).toContain(c.name)
    for (const f of c.flags || []) {
      if (f === 'action' || f === 'i') continue // --action is find's click|show; -i shows as "snapshot -i"
      expect(help).toContain('--' + f)
    }
  }
})

test('networkQuietFor: in-flight requests hold idle off; streams do not', () => {
  const s = makeSession('n', 1)
  const req = (o) => ({ n: 0, id: 'r', tabId: 1, method: 'GET', url: 'u', status: null, ...o })
  s.requests = [req({ ts: 1000, endTs: 1200, done: true })]
  expect(networkQuietFor(s, 1, 2000)).toBe(800)
  s.requests.push(req({ ts: 1500, done: false })) // a slow fetch still running
  expect(networkQuietFor(s, 1, 9000)).toBe(0)
  s.requests[1] = req({ ts: 1500, done: false, type: 'eventsource' })
  expect(networkQuietFor(s, 1, 2000)).toBe(500)
  s.requests[1] = req({ ts: 1500, done: false }) // a long-poll: open for over LONG_REQUEST_MS
  expect(networkQuietFor(s, 1, 1500 + LONG_REQUEST_MS + 100)).toBe(LONG_REQUEST_MS + 100)
  expect(networkQuietFor(s, 2, 2000)).toBe(2000) // other tabs don't count
})
