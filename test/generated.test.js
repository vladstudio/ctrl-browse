// checked-in derived content must match its source — run `bun run gen` to update
import { test, expect } from 'bun:test'
import fs from 'node:fs'
import { BRIDGE_FILE, bridgeHash, bridgeStamp } from '../src/common.js'
import { README_FILE, withCommands } from '../scripts/gen.js'

test('README command reference matches src/spec.js (bun run gen)', () => {
  const readme = fs.readFileSync(README_FILE, 'utf8')
  expect(readme).toBe(withCommands(readme))
})

test('background.js code stamp matches its source (bun run gen)', () => {
  const src = fs.readFileSync(BRIDGE_FILE, 'utf8')
  expect(bridgeStamp(src)).toBe(bridgeHash(src))
})

test('the stamp ignores the port line', () => {
  const src = fs.readFileSync(BRIDGE_FILE, 'utf8')
  expect(bridgeHash(src.replace(/const PORT = \d+/, 'const PORT = 9999'))).toBe(bridgeHash(src))
})

test('skill/SKILL.md frontmatter is valid YAML with name and description', async () => {
  const { YAML } = await import('bun')
  const src = fs.readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf8')
  const meta = YAML.parse(src.split('---')[1])
  expect(meta.name).toBe('ctrl-browse')
  expect(meta.description).toContain('Triggers: "in my browser"')
})
