#!/usr/bin/env node
// Sample within-story comment pairs for LLM-judge labeling.
//   node calibration/sample-pairs.js [nPairs=120] [dump=calibration/dump.json]
// Deterministic (seeded) so runs are reproducible.

const fs = require('fs')
const N_PAIRS = parseInt(process.argv[2] || '120', 10)
const DUMP = process.argv[3] || 'calibration/dump.json'

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20260609)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]

const all = JSON.parse(fs.readFileSync(DUMP, 'utf8'))
// judgeable: enough text to evaluate on its own
const ok = all.filter((c) => c.text && c.text.split(/\s+/).length >= 6 && c.text.length <= 1400)
const byStory = new Map()
for (const c of ok) {
  if (!byStory.has(c.storyId)) byStory.set(c.storyId, [])
  byStory.get(c.storyId).push(c)
}
const stories = [...byStory.values()].filter((s) => s.length >= 6)

const pairs = []
const seen = new Set()
let guard = 0
while (pairs.length < N_PAIRS && guard++ < N_PAIRS * 60) {
  const s = pick(stories)
  const a = pick(s)
  let b = pick(s)
  if (!b || b.id === a.id) continue
  const key = a.id < b.id ? a.id + ':' + b.id : b.id + ':' + a.id
  if (seen.has(key)) continue
  // mix: 50% any pair, 50% pairs the heuristic thinks are close (the informative ones)
  const gap = Math.abs(a.score - b.score)
  const wantClose = pairs.length % 2 === 0
  if (wantClose && gap > 2) continue
  if (!wantClose && gap < 1) continue
  seen.add(key)
  const trim = (c) => ({ id: c.id, score: c.score, features: c.features, text: c.text.slice(0, 950) })
  pairs.push({ pair: pairs.length + 1, storyTitle: s[0].storyTitle, a: trim(a), b: trim(b) })
}

fs.writeFileSync('calibration/pairs.json', JSON.stringify(pairs, null, 1))
console.log(`Sampled ${pairs.length} pairs from ${stories.length} stories (${ok.length} judgeable comments) -> calibration/pairs.json`)
