#!/usr/bin/env node
// Portability proof: the same substance engine over a lobste.rs thread.
//   node adapters/lobsters.js [storyShortId] [out=lobsters-reranked.html]
// Lobsters' API returns comments as a FLAT list (parent_comment + depth), not
// a tree — so this exercises the adapter layer for real: rebuild the tree,
// hand it to the identical engine, render.

const fs = require('fs')
const engine = require('../lib/engine')

const STORY = process.argv[2] || null
const OUT = process.argv[3] || 'lobsters-reranked.html'
const UA = 'hot-thread-slow-rank/0.1 (read-only portability test)'

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url)
  return res.json()
}

const escapeHtml = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

;(async () => {
  let shortId = STORY
  let storyMeta = null
  if (!shortId) {
    const hottest = await getJSON('https://lobste.rs/hottest.json')
    storyMeta = hottest.filter((s) => s.comment_count >= 15)[0] || hottest[0]
    shortId = storyMeta.short_id
  }
  const s = await getJSON(`https://lobste.rs/s/${shortId}.json`)
  process.stderr.write(`Thread: "${s.title}" (${s.comments.length} comments)\n`)

  // flat list -> engine tree
  const nodes = new Map()
  const roots = []
  for (const c of s.comments) {
    if (c.is_deleted || c.is_moderated) continue
    nodes.set(c.short_id, {
      id: c.short_id,
      author: c.commenting_user || null,
      text: c.comment || '',
      created_at_i: Math.floor(new Date(c.created_at).getTime() / 1000),
      points: c.score,
      children: [],
    })
  }
  for (const c of s.comments) {
    const n = nodes.get(c.short_id)
    if (!n) continue
    const p = c.parent_comment && nodes.get(c.parent_comment)
    if (p) p.children.push(n)
    else roots.push(n)
  }
  const story = { id: 'root', title: s.title, children: roots }

  const analysis = engine.analyzeThread(story, { perStory: 8 })
  if (!analysis) throw new Error('no comments to analyze')

  const item = (c) => `<div class="c">
    <span class="score">${c.score}</span> <b>${escapeHtml(c.author)}</b>
    ${c.badges.map((b) => `<span class="badge">${b.icon} ${escapeHtml(b.label)}</span>`).join(' ')}
    ${c.dfsIndex >= 3 ? `<span class="moved">was #${c.dfsIndex + 1} by votes</span>` : ''}
    <a href="https://lobste.rs/s/${shortId}#c_${c.id}" target="_blank" rel="noopener">↗</a>
    <div class="t">${escapeHtml(c.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 700))}</div>
    ${c.reasons.length ? `<div class="why">${escapeHtml(c.reasons.slice(0, 3).join(' · '))}</div>` : ''}
  </div>`

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>lobste.rs thread, reranked by substance</title><style>
  body{margin:0 auto;max-width:840px;padding:24px 18px;background:#f6f6ef;color:#1b1b17;font:15px/1.5 -apple-system,Helvetica,Arial,sans-serif}
  h1{font-size:19px}h2{font-size:14px;color:#3a7d44;text-transform:uppercase;letter-spacing:.05em}
  .meta{color:#6b6b60;font-size:13px}.c{background:#fff;border:1px solid #e4e4d8;border-radius:10px;padding:10px 12px;margin:10px 0}
  .score{font-family:ui-monospace,monospace;font-weight:600;color:#3a7d44;background:#eef5ef;border:1px solid #d6e7d8;border-radius:7px;padding:1px 6px;font-size:12px}
  .badge{font-size:11px;background:#fbf2e9;border:1px solid #efd9c4;color:#b4612e;border-radius:8px;padding:1px 6px}
  .moved{font-size:10px;color:#9a9a8c;background:#f0f0e6;border-radius:7px;padding:1px 6px}
  .t{margin-top:6px;color:#23231d}.why{font-size:12px;color:#3a7d44;font-style:italic;margin-top:5px}
  footer{color:#6b6b60;font-size:12px;margin-top:26px}</style></head><body>
  <h1>${escapeHtml(s.title)}</h1>
  <div class="meta">lobste.rs · ${s.score} pts · ${analysis.comments.length} comments analyzed ·
    ${analysis.hot ? '🔥 hot thread' : 'calm thread'} · ${analysis.flagged.length} hidden as low-signal ·
    <a href="https://lobste.rs/s/${shortId}" target="_blank" rel="noopener">original ↗</a></div>
  <h2>▲ Worth reading (same engine, same weights as the HN version)</h2>
  ${analysis.surfaced.map(item).join('')}
  <footer>Portability proof: identical lib/engine.js scoring as hn-slow-rank — only the fetch/map layer is lobste.rs-specific (flat list → tree). Generated ${new Date().toISOString()}.</footer>
  </body></html>`

  fs.writeFileSync(OUT, html)
  process.stderr.write(`Done: ${analysis.comments.length} comments · ${analysis.surfaced.length} surfaced · ${analysis.flagged.length} low-signal\nWrote ${OUT}\n`)
  console.log(JSON.stringify({ story: s.title, comments: analysis.comments.length, surfaced: analysis.surfaced.length, flagged: analysis.flagged.length, hot: analysis.hot }))
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
