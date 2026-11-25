import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// A fake home and data folder; the modules read them when first imported.
const home = mkdtempSync(join(tmpdir(), 'deck-limits-'))
after(() => rmSync(home, { recursive: true, force: true }))
process.env.HOME = home
process.env.SUBAGENT_DECK_LIVE = join(home, 'live')
const dir = join(home, 'live', 'sessions')
mkdirSync(dir, { recursive: true })
mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
const { forgetSessionLists, listSessions, rateLimits } = await import('../lib/sessions.mjs')

// Reset times relative to now, so the windows are still open whenever the tests run.
const at = hours => new Date(Date.now() + hours * 3600_000).toISOString()
const WEEK_END = at(72)
const limits = (five, week, fiveEnd = at(2)) => [
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
  write('busy', limits(3, 45, at(7)), 0)
  assert.deepEqual(read(), { five_hour: 3, seven_day: 45 })
  write('idle', limits(77, 42), 0) // still reporting the window that already reset
  assert.deepEqual(read(), { five_hour: 3, seven_day: 45 })
})

test('a window whose reset time has passed is dropped once Claude stops reporting it', (t) => {
  write('busy', limits(3, 45, at(7)), 0)
  assert.deepEqual(read(), { five_hour: 3, seven_day: 45 })
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 8 * 3600_000 }) // 8 hours later: the 5-hour window is over
  write('busy', [{ kind: 'seven_day', percentUsed: 46, resetsAt: WEEK_END }], 0) // and only the week is reported now
  assert.deepEqual(read(), { seven_day: 46 })
})
