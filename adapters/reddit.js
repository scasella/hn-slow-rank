#!/usr/bin/env node
// Portability proof: the same substance engine over a Reddit thread.
//   node adapters/reddit.js [subreddit=technology] [out=reddit-reranked.html]
// Picks the hottest non-sticky text-discussable post, maps Reddit's comment
// tree to the engine's shape, scores with the identical weights, renders.
// STATUS (2026-06): Reddit 403s ALL unauthenticated .json access (www, old,
// api.reddit.com alike) — the post-2023 API lockdown. This adapter is kept as
// the mapping layer; to run it you must register a Reddit OAuth app and front
// these calls with a bearer token. The live portability proof that needs no
// credentials is adapters/lobsters.js.

const fs = require('fs')
const engine = require('../lib/engine')

const SUB = process.argv[2] || 'technology'
const OUT = process.argv[3] || 'reddit-reranked.html'
const UA = 'hot-thread-slow-rank/0.1 (read-only portability test)'

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url)
  return res.json()
}

// Reddit comment node -> engine node. body_html is double-entity-encoded.
function decodeRedditHtml(s) {
  return String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}
function mapComment(node) {
  const d = node.data
  return {
    id: d.id,
    author: d.author && d.author !== '[deleted]' ? d.author : null,
    text: decodeRedditHtml(d.body_html || ''),
    created_at_i: d.created_utc || 0,
    points: d.score,
    children: ((d.replies && d.replies.data && d.replies.data.children) || [])
      .filter((k) => k.kind === 't1')
      .map(mapComment),
  }
}

const escapeHtml = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

;(async () => {
  process.stderr.write(`Fetching r/${SUB} hot…\n`)
  const hot = await getJSON(`https://www.reddit.com/r/${SUB}/hot.json?limit=15`)
  const post = hot.data.children
    .map((c) => c.data)
    .filter((p) => !p.stickied && p.num_comments >= 80)[0]
  if (!post) throw new Error('no suitable post found')
  process.stderr.write(`Thread: "${post.title}" (${post.num_comments} comments)\n`)

  const thread = await getJSON(`https://www.reddit.com${post.permalink}.json?limit=500&depth=10`)
  const commentListing = thread[1].data.children.filter((k) => k.kind === 't1').map(mapComment)
  const story = { id: 'root', title: post.title, children: commentListing }

  const analysis = engine.analyzeThread(story, { perStory: 10 })
  if (!analysis) throw new Error('no comments to analyze')

  const item = (c) => `<div class="c">
    <span class="score">${c.score}</span> <b>${escapeHtml(c.author)}</b>
    ${c.badges.map((b) => `<span class="badge">${b.icon} ${escapeHtml(b.label)}</span>`).join(' ')}
    ${c.dfsIndex >= 3 ? `<span class="moved">was #${c.dfsIndex + 1} by votes</span>` : ''}
    <a href="https://reddit.com${post.permalink}${c.id}/" target="_blank" rel="noopener">↗</a>
    <div class="t">${escapeHtml(c.text.length > 700 ? c.text.slice(0, 700) + '…' : c.text)}</div>
    ${c.reasons.length ? `<div class="why">${escapeHtml(c.reasons.slice(0, 3).join(' · '))}</div>` : ''}
  </div>`

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Reddit thread, reranked by substance</title><style>
  body{margin:0 auto;max-width:840px;padding:24px 18px;background:#f6f6ef;color:#1b1b17;font:15px/1.5 -apple-system,Helvetica,Arial,sans-serif}
  h1{font-size:19px}h2{font-size:14px;color:#3a7d44;text-transform:uppercase;letter-spacing:.05em}
  .meta{color:#6b6b60;font-size:13px}.c{background:#fff;border:1px solid #e4e4d8;border-radius:10px;padding:10px 12px;margin:10px 0}
  .score{font-family:ui-monospace,monospace;font-weight:600;color:#3a7d44;background:#eef5ef;border:1px solid #d6e7d8;border-radius:7px;padding:1px 6px;font-size:12px}
  .badge{font-size:11px;background:#fbf2e9;border:1px solid #efd9c4;color:#b4612e;border-radius:8px;padding:1px 6px}
  .moved{font-size:10px;color:#9a9a8c;background:#f0f0e6;border-radius:7px;padding:1px 6px}
  .t{margin-top:6px;color:#23231d}.why{font-size:12px;color:#3a7d44;font-style:italic;margin-top:5px}
  footer{color:#6b6b60;font-size:12px;margin-top:26px}</style></head><body>
  <h1>${escapeHtml(post.title)}</h1>
  <div class="meta">r/${SUB} · ${post.score} pts · ${post.num_comments} comments · ${analysis.comments.length} fetched & analyzed ·
    ${analysis.hot ? '🔥 hot thread' : 'calm thread'} · ${analysis.flagged.length} hidden as low-signal ·
    <a href="https://reddit.com${post.permalink}" target="_blank" rel="noopener">original ↗</a></div>
  <h2>▲ Worth reading (same engine, same weights as the HN version)</h2>
  ${analysis.surfaced.map(item).join('')}
  <footer>Portability proof: identical lib/engine.js scoring as hn-slow-rank — only the fetch/map layer is Reddit-specific. Generated ${new Date().toISOString()}.</footer>
  </body></html>`

  fs.writeFileSync(OUT, html)
  process.stderr.write(`Done: ${analysis.comments.length} comments · ${analysis.surfaced.length} surfaced · ${analysis.flagged.length} low-signal · hot=${analysis.hot}\nWrote ${OUT}\n`)
  console.log(JSON.stringify({ sub: SUB, post: post.title, comments: analysis.comments.length, surfaced: analysis.surfaced.length, flagged: analysis.flagged.length, hot: analysis.hot }))
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
