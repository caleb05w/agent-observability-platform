// The session files the mod writes (live/sessions/<id>.json every 2 seconds), as dashboard rows.
// readSessionFile serves them corrected: T3 helpers that already finished are done, resolved agents need no attention.
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { livePath, sessionPath, SESSIONS_DIR } from './paths.mjs'
import { DAY, MINUTE, SECOND } from './time.mjs'
import { delegatedTitles, displayTitle, safeTranscriptTitle } from './titles.mjs'
import { applyResolved } from './resolved.mjs'
import { applyT3Finished } from './t3-helpers.mjs'
import { lastModelOf } from './transcripts.mjs'
import { usageWindow, weeklyShares } from './usage-store.mjs'

const KEEP_SESSION_FILES_MS = 7 * DAY
const LIVE_WITHIN_MS = 10 * SECOND // a file written this recently belongs to an open session
const WEEK_LIST_CACHE_MS = 10 * SECOND
const STORE_KEEP_MS = 31 * DAY // matches the usage store
const EMPTY_DAY = { usd: 0, tokens: 0, mainUsd: 0, mainTokens: 0 }

const LIST_CACHE_MS = 1 * SECOND // every open tab polls; one listing serves all of them for this long

// Parsed session files, re-parsed only when the file changed (each open session rewrites its own every 2 s;
// most files are idle). Entries are shared: callers must not change them.
const parsed = new Map() // path -> { mtimeMs, size, data }
function parseSessionFile(path, st = statSync(path)) {
  const hit = parsed.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data
  const data = JSON.parse(readFileSync(path, 'utf8'))
  parsed.set(path, { mtimeMs: st.mtimeMs, size: st.size, data })
  return data
}

// A session file's data, corrected for the dashboard (a fresh top-level copy; runs are shared).
export function readSessionFile(id) {
  try { return applyResolved(applyT3Finished({ ...parseSessionFile(sessionPath(id)) })) } catch { return null }
}

// Session files are deleted a week after their last write.
export function deleteOldSessionFiles() {
  try {
    for (const name of readdirSync(SESSIONS_DIR)) {
      if (!name.endsWith('.json')) continue
      const path = join(SESSIONS_DIR, name)
      if (Date.now() - statSync(path).mtimeMs > KEEP_SESSION_FILES_MS) { unlinkSync(path); parsed.delete(path) }
    }
  } catch {}
}

// The plan's usage windows. Every open session reports them as it last saw them, and an idle session keeps
// rewriting an old reading, so the newest file is not the newest reading: taking it made the ring jump between
// sessions' numbers. Usage only grows within a window, so per kind keep the window that resets last and, within
// it, the highest percentage any session reported.
const SAME_WINDOW_MS = 10 * MINUTE // reports of one window's reset time can differ slightly
let limits = []
let limitsAt = 0
export const rateLimits = () => limits
export const rateLimitsAt = () => limitsAt || null
const resetMs = l => Date.parse(l.resetsAt) || 0
function isNewerReading(l, cur) {
  const gap = resetMs(l) - resetMs(cur)
  if (Math.abs(gap) > SAME_WINDOW_MS) return gap > 0 // a later window
  return (l.percentUsed ?? -1) > (cur.percentUsed ?? -1)
}
function noteLimits(data, mtime) {
  if (!Array.isArray(data.rateLimits) || !data.rateLimits.length) return
  let next = limits
  for (const l of data.rateLimits) {
    const i = next.findIndex(x => x.kind === l.kind)
    if (i >= 0 && !isNewerReading(l, next[i])) continue
    next = next === limits ? [...limits] : next
    if (i >= 0) next[i] = l
    else next.push(l)
  }
  limits = next
  limitsAt = Math.max(limitsAt, mtime)
}

// Sessions hidden from the dashboard (never deleted): { [sessionId]: hiddenAt }.
// A hidden session shows again once it has new activity (a new message or agent).
const hiddenPath = livePath('hidden.json')
let hidden = {}
try { hidden = JSON.parse(readFileSync(hiddenPath, 'utf8')) ?? {} } catch {}
const saveHidden = () => { try { writeFileSync(hiddenPath, JSON.stringify(hidden, null, 1) + '\n') } catch {} }
export const isHidden = id => id in hidden
let hiddenChanges = 0
export const hiddenVersion = () => hiddenChanges // changes whenever the hidden set does
// Entries hidden over 31 days ago (beyond every timeframe) whose session file is gone.
export function trimHidden() {
  let changed = false
  for (const [id, at] of Object.entries(hidden)) {
    if (Date.now() - at > STORE_KEEP_MS && !existsSync(sessionPath(id))) { delete hidden[id]; changed = true }
  }
  if (changed) { saveHidden(); hiddenChanges++ }
}
export function setHidden(id, hide) {
  if (hide) hidden[id] = Date.now(); else delete hidden[id]
  listCache.clear()
  hiddenChanges++
  saveHidden()
}
function unhideIfActive(data) {
  const hiddenAt = hidden[data.sessionId]
  if (!hiddenAt) return
  const active = (data.lastAsk?.at ?? 0) > hiddenAt || (data.runs ?? []).some(r => r.id !== 'triage' && (r.startedAt ?? 0) > hiddenAt)
  if (active) setHidden(data.sessionId, false)
}

function sessionRow(data, st, day) {
  const runs = data.runs ?? []
  const mtime = st.mtimeMs
  return {
    id: data.sessionId,
    project: data.project,
    title: displayTitle(data.sessionId) ?? data.title ?? null,
    rawTitle: safeTranscriptTitle(data.sessionId) ?? data.title ?? null,
    // A Codex helper's file names the session that delegated it.
    ...(data.delegatedBy?.sessionId ? { parentId: data.delegatedBy.sessionId } : {}),
    ...(data.costKnown === false ? { costKnown: false } : {}),
    updatedAt: mtime,
    // Files rewritten by rename (Codex helpers) carry their own start; otherwise the file's birth time.
    startedAt: Number(data.startedAt) || st.birthtimeMs,
    isLive: Date.now() - mtime < LIVE_WITHIN_MS,
    agents: runs.filter(r => r.id !== 'main').length,
    working: runs.filter(r => r.now !== 'done').length,
    totalUsd: data.totalUsd ?? 0,
    // For the All view's idle chats: the main conversation's model, and the session's tokens.
    model: runs.find(r => r.id === 'main')?.model ?? lastModelOf(data.sessionId),
    tokens: runs.filter(r => r.id !== 'triage').reduce((n, r) => n + (r.tokens ?? 0), 0),
    // The last 24 hours of this chat (same window as the All view's totals).
    day: day[data.sessionId] ?? EMPTY_DAY,
    ...(isHidden(data.sessionId) ? { hidden: true } : {}),
  }
}

// Session files written within `maxAge`, newest-started first. Each row carries its share of this week's limit,
// and a T3 helper's session is marked with the session that delegated it (parentId).
const listCache = new Map() // maxAge -> { at, list }
// Drops the cached listings now (a session file just changed), so the next request reads them fresh.
export const forgetSessionLists = () => { listCache.clear(); weekList = null }
export function listSessions(maxAge = DAY) {
  const hit = listCache.get(maxAge)
  if (hit && Date.now() - hit.at < LIST_CACHE_MS) return hit.list
  const list = readSessionList(maxAge)
  listCache.set(maxAge, { at: Date.now(), list })
  return list
}
function readSessionList(maxAge) {
  const out = []
  const day = usageWindow(DAY).bySession
  let names = []
  try { names = readdirSync(SESSIONS_DIR) } catch {}
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(SESSIONS_DIR, name)
    try {
      const st = statSync(path)
      if (Date.now() - st.mtimeMs > maxAge) continue
      const data = parseSessionFile(path, st)
      noteLimits(data, st.mtimeMs)
      unhideIfActive(data)
      out.push(sessionRow(data, st, day))
    } catch {}
  }
  addWeekShares(out)
  linkHelpersToParents(out)
  // By start time, so the list never reshuffles while you look at it.
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

function addWeekShares(rows) {
  const week = limits.find(l => l.kind === 'seven_day')
  const start = week?.resetsAt ? Date.parse(week.resetsAt) - 7 * DAY : Date.now() - 7 * DAY
  const { out: shares } = weeklyShares(week ? week.percentUsed : null, start)
  for (const s of rows) {
    s.weekPct = shares[s.id]?.pct ?? null
    s.weekTokens = shares[s.id]?.tokens ?? 0
  }
}

// A helper's session takes its task's title; it belongs to the session that delegated that task and started
// before it. Its share of the week is counted in the parent too. The page lists only parents.
function linkHelpersToParents(rows) {
  for (const parent of rows) {
    let titles = []
    try { titles = delegatedTitles(parent.id) } catch {}
    for (const child of rows) {
      if (child === parent || child.parentId || child.startedAt < parent.startedAt) continue
      if (titles.includes(child.title) || titles.includes(child.rawTitle)) child.parentId = parent.id
    }
  }
  for (const child of rows) {
    const parent = child.parentId && rows.find(x => x.id === child.parentId)
    if (parent && child.weekPct != null) parent.weekPctAll = (parent.weekPctAll ?? parent.weekPct ?? 0) + child.weekPct
  }
}

// Session files up to a week old, reused for a few seconds.
let weekList = null
export function listSessionsWeek() {
  if (weekList && Date.now() - weekList.at < WEEK_LIST_CACHE_MS) return weekList.list
  weekList = { at: Date.now(), list: listSessions(7 * DAY) }
  return weekList.list
}

// Open sessions that are not T3 helpers, most recently written first.
export const openSessions = (list = listSessions()) =>
  list.filter(s => s.isLive && !s.parentId).sort((a, b) => b.updatedAt - a.updatedAt)
