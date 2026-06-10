#!/usr/bin/env node
// Label sampled pairs with an LLM judge via the `claude` CLI (Haiku — cheap).
//   node calibration/judge.js [batchSize=8] [model=haiku]
// Reads calibration/pairs.json, appends to calibration/labels.json (resumable).

const fs = require('fs')
const { execFileSync } = require('child_process')

const BATCH = parseInt(process.argv[2] || '8', 10)
const MODEL = process.argv[3] || 'haiku'
const pairs = JSON.parse(fs.readFileSync('calibration/pairs.json', 'utf8'))

let labels = {}
try { labels = JSON.parse(fs.readFileSync('calibration/labels.json', 'utf8')) } catch {}

const todo = pairs.filter((p) => !(p.pair in labels))
console.log(`${pairs.length} pairs, ${todo.length} unlabeled, batches of ${BATCH}, model=${MODEL}`)

function promptFor(batch) {
  const items = batch.map((p) =>
    `### Pair ${p.pair} (story: ${JSON.stringify(p.storyTitle)})\nComment A:\n${p.a.text}\n\nComment B:\n${p.b.text}`
  ).join('\n\n')
  return `You are judging pairs of Hacker News comments from the same thread for a "worth reading first" ranking.

For each pair decide which comment a reader seeking SUBSTANCE should read first. Substance means: firsthand knowledge or disclosed experience, primary sources or evidence, concrete specifics (numbers, versions, mechanisms), genuine insight or a well-posed expert question. The loser profile: snark, dunks, flamewar back-and-forth, vague opinion, low-effort one-liners, generic agreement. Judge the text on its merits, not its length — a short precise correction can beat a long ramble.

${items}

Respond with ONLY a JSON array, no prose, no code fences: [{"pair":<n>,"winner":"A"|"B"|"tie"}, ...] — one entry per pair, "tie" only when genuinely inseparable.`
}

function judgeBatch(batch, attempt = 1) {
  const out = execFileSync('claude', ['-p', '--model', MODEL], {
    input: promptFor(batch), encoding: 'utf8', timeout: 240000, maxBuffer: 10 * 1024 * 1024,
  })
  const m = out.match(/\[[\s\S]*\]/)
  if (!m) throw new Error('no JSON array in output: ' + out.slice(0, 200))
  const arr = JSON.parse(m[0])
  const got = new Map(arr.map((r) => [r.pair, String(r.winner || '').toLowerCase()]))
  const missing = batch.filter((p) => !['a', 'b', 'tie'].includes(got.get(p.pair)))
  if (missing.length && attempt < 3) {
    console.log(`  ${missing.length} missing/invalid, retrying those`)
    judgeBatch(missing, attempt + 1)
  }
  for (const p of batch) {
    const w = got.get(p.pair)
    if (['a', 'b', 'tie'].includes(w)) labels[p.pair] = w
  }
}

;(async () => {
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH)
    process.stdout.write(`batch ${i / BATCH + 1}/${Math.ceil(todo.length / BATCH)} (pairs ${batch[0].pair}-${batch[batch.length - 1].pair})… `)
    try {
      judgeBatch(batch)
      fs.writeFileSync('calibration/labels.json', JSON.stringify(labels, null, 1))
      console.log('ok')
    } catch (e) {
      console.log('FAILED: ' + e.message.slice(0, 160))
    }
  }
  const counts = { a: 0, b: 0, tie: 0 }
  for (const v of Object.values(labels)) counts[v]++
  console.log(`done: ${Object.keys(labels).length} labeled — A:${counts.a} B:${counts.b} tie:${counts.tie}`)
})()
