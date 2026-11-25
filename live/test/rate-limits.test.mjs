import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// A fake home and data folder; the modules read them when first imported.
const home = mkdtempSync(join(tmpdir(), 'deck-limits-'))
process.env.HOME = home
process.env.SUBAGENT_DECK_LIVE = join(home, 'live')
const dir = join(home, 'live', 'sessions')
mkdirSync(dir, { recursive: true })
mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
const { forgetSessionLists, listSessions, rateLimits } = await import('../lib/sessions.mjs')

const WEEK_END = '2026-11-27T17:00:00.000Z'
const limits = (five, week, fiveEnd = '2026-11-25T02:10:00.000Z') => [
  { kind: 'five_hour', percentUsed: five, resetsAt: fiveEnd },
  { kind: 'seven_day', percentUsed: week, resetsAt: WEEK_END },
]
// Writes a session file, `ageS` seconds old.
function write(id, rateLimits, ageS) {
  const path = join(dir, `${id}.json`)
  writeFileSync(path, JSON.stringify({ sessionId: id, project: 'p', updatedAt: 0, rateLimits, runs: [], helpers: [] }))
  const t = new Date(Date.now() - ageS * 1000)
  utimesSync(path, t, t)
}
const read = () => { forgetSessionLists(); listSessions(); return Object.fromEntries(rateLimits().map(l => [l.kind, l.percentUsed])) }

test('an idle session rewriting an old reading does not pull the usage back down', () => {
  write('busy', limits(87, 44), 2)
  write('idle', limits(77, 42), 1) // written last, but its numbers are older
  assert.deepEqual(read(), { five_hour: 87, seven_day: 44 })
  write('idle', limits(77, 42), 0) // and again on its next heartbeat
  assert.deepEqual(read(), { five_hour: 87, seven_day: 44 })
})

test('a new window replaces the old one even with a lower percentage', () => {
  write('busy', limits(3, 45, '2026-11-25T07:10:00.000Z'), 0)
  assert.deepEqual(read(), { five_hour: 3, seven_day: 45 })
  write('idle', limits(77, 42), 0) // still reporting the window that already reset
  assert.deepEqual(read(), { five_hour: 3, seven_day: 45 })
})
