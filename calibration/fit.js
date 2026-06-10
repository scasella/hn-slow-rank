#!/usr/bin/env node
// Fit Bradley-Terry / logistic weights from judged pairs.
//   node calibration/fit.js
// P(A preferred over B) = sigmoid(w · (fA - fB)). Ties contribute target 0.5.
// Writes calibration/weights.calibrated.json + calibration/REPORT.md.

const fs = require('fs')
const engine = require('../lib/engine')
const F = engine.FEATURE_NAMES
const HAND = engine.DEFAULT_WEIGHTS

const pairs = JSON.parse(fs.readFileSync('calibration/pairs.json', 'utf8'))
const labels = JSON.parse(fs.readFileSync('calibration/labels.json', 'utf8'))

const rows = [] // {x: featureDiff[], y: target}
for (const p of pairs) {
  const w = labels[p.pair]
  if (!w) continue
  const x = F.map((k) => (p.a.features[k] || 0) - (p.b.features[k] || 0))
  if (x.every((v) => v === 0)) continue // identical feature vectors carry no signal
  rows.push({ x, y: w === 'a' ? 1 : w === 'b' ? 0 : 0.5, pair: p.pair })
}

// deterministic shuffle + 80/20 split
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(7)
for (let i = rows.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [rows[i], rows[j]] = [rows[j], rows[i]]
}
const nTest = Math.max(1, Math.floor(rows.length * 0.2))
const test = rows.slice(0, nTest)
const train = rows.slice(nTest)

const sig = (z) => 1 / (1 + Math.exp(-z))
const dot = (w, x) => w.reduce((a, wi, i) => a + wi * x[i], 0)

function fit(data, lambda = 0.03, lr = 0.15, iters = 6000) {
  let w = new Array(F.length).fill(0)
  for (let it = 0; it < iters; it++) {
    const g = new Array(F.length).fill(0)
    for (const r of data) {
      const err = sig(dot(w, r.x)) - r.y
      for (let i = 0; i < F.length; i++) g[i] += err * r.x[i]
    }
    for (let i = 0; i < F.length; i++) w[i] -= lr * (g[i] / data.length + lambda * w[i])
  }
  return w
}

function acc(w, data) {
  let right = 0, n = 0
  for (const r of data) {
    if (r.y === 0.5) continue
    n++
    if ((dot(w, r.x) > 0 ? 1 : 0) === r.y) right++
  }
  return n ? right / n : NaN
}

const handVec = F.map((k) => HAND[k])
const learned = fit(train)

// rescale so the strongest learned weight matches the hand scale (max |w| = 4);
// rank thresholds in rerank.js stay meaningful.
const maxAbs = Math.max(...learned.map(Math.abs)) || 1
const scaled = learned.map((v) => Math.round((v * 4 / maxAbs) * 100) / 100)

const calibrated = {}
F.forEach((k, i) => (calibrated[k] = scaled[i]))
fs.writeFileSync('calibration/weights.calibrated.json', JSON.stringify(calibrated, null, 2))

const decided = rows.filter((r) => r.y !== 0.5).length
const lines = []
lines.push('# Weight calibration — LLM-judge pairwise labels → Bradley–Terry fit')
lines.push('')
lines.push(`- Pairs sampled within-story from a live front-page run; judged "which is more worth reading" by an LLM judge (Haiku) in batches.`)
lines.push(`- Usable pairs: **${rows.length}** (${decided} decided, ${rows.length - decided} ties) · train ${train.length} / test ${test.length}.`)
lines.push(`- Model: logistic on feature *differences* (Bradley–Terry), L2 λ=0.03.`)
lines.push('')
lines.push(`| accuracy on decided pairs | hand weights | fitted weights |`)
lines.push(`|---|---|---|`)
lines.push(`| train | ${(acc(handVec, train) * 100).toFixed(1)}% | ${(acc(learned, train) * 100).toFixed(1)}% |`)
lines.push(`| held-out test | ${(acc(handVec, test) * 100).toFixed(1)}% | ${(acc(learned, test) * 100).toFixed(1)}% |`)
lines.push('')
lines.push('| feature | hand | fitted (scaled to hand range) | verdict |')
lines.push('|---|---|---|---|')
F.forEach((k, i) => {
  const h = HAND[k], s = scaled[i]
  let verdict = ''
  if (Math.sign(h) !== Math.sign(s) && Math.abs(s) > 0.4) verdict = '**sign flip — hand weight likely wrong**'
  else if (Math.abs(s) < 0.3 && Math.abs(h) >= 1.5) verdict = 'judge barely uses this — overweighted by hand'
  else if (Math.abs(s) > Math.abs(h) * 1.8) verdict = 'underweighted by hand'
  else verdict = 'roughly confirmed'
  lines.push(`| ${k} | ${h} | ${s} | ${verdict} |`)
})
lines.push('')
lines.push('## Caveats')
lines.push('- The judge sees comment text only — thread-context features (duel, discussion) are judged indirectly, so their fitted weights are noisy.')
lines.push('- Labels come from one LLM judge, not humans; treat as cheap bootstrap ground truth (spot-check before trusting).')
lines.push('- Apply with: `node rerank.js --weights calibration/weights.calibrated.json`')
fs.writeFileSync('calibration/REPORT.md', lines.join('\n') + '\n')
console.log(lines.join('\n'))
