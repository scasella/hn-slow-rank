#!/usr/bin/env node
// Rank-trajectory snapshot: record the top-120 front-page order + scores so a
// future shadow-rank / second-chance detector has history to work with.
// Appends one compact JSON line to data/snapshots/YYYY-MM-DD.jsonl (UTC).
//   node scripts/snapshot.js

const fs = require('fs')

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'hot-thread-slow-rank/0.2 (snapshot)' } })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let idx = 0
  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) {
      const i = idx++
      if (i >= items.length) return
      try { out[i] = await fn(items[i], i) } catch { out[i] = null }
    }
  }))
  return out
}

;(async () => {
  const ids = (await getJSON('https://hacker-news.firebaseio.com/v0/topstories.json')).slice(0, 120)
  const items = await mapLimit(ids, 12, (id) => getJSON('https://hacker-news.firebaseio.com/v0/item/' + id + '.json'))
  const t = Math.floor(Date.now() / 1000)
  const line = JSON.stringify({
    t,
    stories: items.map((it, i) => it && [it.id, i + 1, it.score || 0, it.descendants || 0, it.time || 0]).filter(Boolean),
  })
  const day = new Date(t * 1000).toISOString().slice(0, 10)
  fs.mkdirSync('data/snapshots', { recursive: true })
  const file = `data/snapshots/${day}.jsonl`
  fs.appendFileSync(file, line + '\n')
  console.log(`snapshot: ${ids.length} stories -> ${file} (${line.length} bytes)`)
})().catch((e) => { console.error('snapshot failed:', e.message); process.exit(1) })
