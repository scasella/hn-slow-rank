#!/usr/bin/env node
// Hot Thread Slow Rank — front-page generator.
// Surface the comment worth reading, hide the fight.
// Zero-participation: pure read-only over HN's public Firebase + Algolia APIs.
//
//   node rerank.js [topStories=24] [perStory=6] [--out=frontpage-reranked.html]
//                  [--json=dump.json] [--weights=weights.json] [--no-prior-art]
//
// Scoring lives in lib/engine.js (shared with the browser extension and the
// reddit adapter). --json dumps every scored comment + feature vector for
// calibration; --weights swaps in fitted weights.

const engine = require('./lib/engine')

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const flag = (name) => {
  const a = args.find((x) => x === '--' + name || x.startsWith('--' + name + '='))
  if (!a) return null
  return a.includes('=') ? a.split('=').slice(1).join('=') : true
}
const TOP_N = parseInt(positional[0] || '24', 10)
const PER_STORY = parseInt(positional[1] || '6', 10)
const OUT = typeof flag('out') === 'string' ? flag('out') : 'frontpage-reranked.html'
const JSON_DUMP = typeof flag('json') === 'string' ? flag('json') : null
const PRIOR_ART = !flag('no-prior-art')
const CONCURRENCY = 6

let WEIGHTS = engine.DEFAULT_WEIGHTS
if (typeof flag('weights') === 'string') {
  WEIGHTS = { ...engine.DEFAULT_WEIGHTS, ...JSON.parse(require('fs').readFileSync(flag('weights'), 'utf8')) }
  process.stderr.write('Using weights from ' + flag('weights') + '\n')
}

// ---------------------------------------------------------------------------
// tiny utils
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'hot-thread-slow-rank/0.2 (read-only)' } })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.json()
    } catch (e) {
      if (i === tries - 1) throw e
      await sleep(400 * (i + 1))
    }
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++
      if (i >= items.length) return
      try { out[i] = await fn(items[i], i) } catch (e) { out[i] = null }
    }
  })
  await Promise.all(workers)
  return out
}

const { stripTags, domainOf } = engine
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
// HN text is already sanitized HTML; just harden links + drop anything script-y.
function safeCommentHtml(html) {
  let h = String(html || '')
  h = h.replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '')
  h = h.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  h = h.replace(/<a\s+href=/gi, '<a target="_blank" rel="noopener noreferrer nofollow" href=')
  return h
}
function ageStr(createdSec) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - createdSec)
  const h = Math.floor(s / 3600)
  if (h < 1) return Math.floor(s / 60) + 'm'
  if (h < 24) return h + 'h'
  return Math.floor(h / 24) + 'd'
}

// ---------------------------------------------------------------------------
// prior-art receipts: has HN discussed this before?
// ---------------------------------------------------------------------------
const normUrl = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/[/#?]+$/, '').toLowerCase()
function titleSim(a, b) {
  const w = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]{4,}/g) || [])
  const A = w(a), B = w(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / Math.min(A.size, B.size)
}

async function priorArt(story) {
  const out = []
  const seen = new Set([story.id])
  const cutoff = story.time || Math.floor(Date.now() / 1000)
  const keep = (h) => {
    const id = +h.objectID
    if (seen.has(id) || (h.created_at_i || 0) >= cutoff) return false
    seen.add(id)
    out.push({
      id,
      title: h.title || '',
      points: h.points || 0,
      comments: h.num_comments || 0,
      date: (h.created_at || '').slice(0, 10),
    })
    return true
  }
  try {
    if (story.url && !/news\.ycombinator\.com/.test(story.url)) {
      const r = await getJSON('https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(story.url) +
        '&restrictSearchableAttributes=url&tags=story&hitsPerPage=12')
      for (const h of r?.hits || []) if (normUrl(h.url) === normUrl(story.url)) keep(h)
    }
    const r2 = await getJSON('https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(story.title) +
      '&restrictSearchableAttributes=title&tags=story&hitsPerPage=12')
    for (const h of r2?.hits || []) {
      if ((h.num_comments || 0) < 5) continue
      if (titleSim(h.title, story.title) < 0.75) continue
      keep(h)
    }
  } catch { /* prior art is best-effort */ }
  out.sort((a, b) => (b.points + b.comments) - (a.points + a.comments))
  return out.slice(0, 4)
}

// ---------------------------------------------------------------------------
// per-story processing
// ---------------------------------------------------------------------------
function processStory(item, rank) {
  const story = item.algolia
  const meta = item.fb
  if (!story || !Array.isArray(story.children)) return null
  const analysis = engine.analyzeThread(story, { perStory: PER_STORY, weights: WEIGHTS })
  if (!analysis) return null

  return {
    rank,
    id: story.id,
    title: meta.title || story.title,
    url: meta.url || story.url || ('https://news.ycombinator.com/item?id=' + story.id),
    domain: domainOf(meta.url || story.url || '') || 'news.ycombinator.com',
    points: meta.score ?? story.points ?? 0,
    nComments: analysis.comments.length,
    age: ageStr(meta.time || story.created_at_i || 0),
    time: meta.time || story.created_at_i || 0,
    hot: analysis.hot,
    duelCount: analysis.duelCount,
    flaggedCount: analysis.flagged.length,
    ordinaryCount: analysis.ordinary.length,
    surfaced: analysis.surfaced,
    comments: analysis.comments,
    priorArt: [],
  }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
function renderComment(c) {
  const badges = c.badges.map((b) => `<span class="badge">${b.icon}&nbsp;${b.label}</span>`).join('')
  const why = c.reasons.length ? `<div class="why">${escapeHtml(c.reasons.slice(0, 3).join(' · '))}</div>` : ''
  const moved = c.dfsIndex >= 3 ? `<span class="moved">was&nbsp;#${c.dfsIndex + 1}&nbsp;by&nbsp;votes&nbsp;→&nbsp;surfaced</span>` : ''
  let body
  if (c.text.length > 900) {
    body = `<details class="ctext"><summary>${escapeHtml(c.text.slice(0, 220))}…</summary><div class="full">${safeCommentHtml(c.textHtml)}</div></details>`
  } else {
    body = `<div class="ctext">${safeCommentHtml(c.textHtml)}</div>`
  }
  return `<div class="comment">
    <div class="crail"><span class="score">${c.score}</span></div>
    <div class="cbody">
      <div class="cmeta"><span class="author">${escapeHtml(c.author)}</span> ${badges} ${moved}
        <a class="permalink" target="_blank" rel="noopener" href="https://news.ycombinator.com/item?id=${c.id}">↗</a></div>
      ${body}
      ${why}
    </div>
  </div>`
}

function renderPriorArt(s) {
  if (!s.priorArt.length) return ''
  const links = s.priorArt.map((p) =>
    `<a target="_blank" rel="noopener" href="https://news.ycombinator.com/item?id=${p.id}" title="${escapeHtml(p.title)}">${p.date.slice(0, 4)} · ${p.points}&nbsp;pts · ${p.comments}&nbsp;comment${p.comments === 1 ? '' : 's'}</a>`).join('<span class="psep">·</span>')
  return `<div class="prior">📜 HN has been here before — ${s.priorArt.length} earlier thread${s.priorArt.length > 1 ? 's' : ''}: ${links}</div>`
}

function renderStory(s) {
  const comments = s.surfaced.map(renderComment).join('')
  const hotBadge = s.hot ? `<span class="hot">🔥 hot thread · combat down-weighted</span>` : ''
  const foldBits = []
  if (s.flaggedCount) foldBits.push(`<details class="fold"><summary>🥊 ${s.flaggedCount} hidden as low-signal${s.duelCount ? ` · ${s.duelCount} in duels` : ''}</summary>
         <div class="foldnote">Hidden: flame-war back-and-forths, dunks, name-calling, and low-content one-liners. Expand if you want the fight.</div></details>`)
  if (s.ordinaryCount) foldBits.push(`<div class="ordinary">+ ${s.ordinaryCount} more on-topic comments (fine, just not top-ranked — <a target="_blank" rel="noopener" href="https://news.ycombinator.com/item?id=${s.id}">all on HN ↗</a>)</div>`)
  const fold = foldBits.join('')
  return `<section class="story">
    <div class="shead">
      <span class="srank">${s.rank}</span>
      <div class="stitle">
        <a target="_blank" rel="noopener" href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a>
        <span class="domain">${escapeHtml(s.domain)}</span>
        <div class="smeta">${s.points} pts · ${s.nComments} comments · ${s.age} ${hotBadge}
          <a class="hnlink" target="_blank" rel="noopener" href="https://news.ycombinator.com/item?id=${s.id}">discuss on HN ↗</a></div>
        ${renderPriorArt(s)}
      </div>
    </div>
    <div class="lane"><div class="lanelabel">▲ Worth reading</div>${comments}</div>
    ${fold}
  </section>`
}

function renderPage(stories, stats) {
  const now = new Date()
  const css = `
  :root{--bg:#f6f6ef;--card:#fff;--ink:#1b1b17;--dim:#6b6b60;--line:#e4e4d8;--accent:#b4612e;--hot:#c0392b;--good:#3a7d44;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
  header{position:sticky;top:0;z-index:5;background:rgba(246,246,239,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:18px 22px}
  .wrap{max-width:860px;margin:0 auto;padding:0 18px}
  h1{font-size:20px;margin:0;letter-spacing:-.01em}.tag{color:var(--dim);font-size:13px;margin-top:3px}
  .stats{font-family:var(--mono);font-size:12px;color:var(--dim);margin-top:8px;display:flex;gap:14px;flex-wrap:wrap}
  .stats b{color:var(--ink)}
  .legend{font-family:var(--mono);font-size:11px;color:var(--dim);margin-top:10px;display:flex;gap:10px;flex-wrap:wrap}
  .legend span{background:#efeee3;border:1px solid var(--line);border-radius:10px;padding:1px 7px}
  main{padding:26px 0 80px}
  .story{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:0 0 18px;box-shadow:0 1px 0 rgba(0,0,0,.02)}
  .shead{display:flex;gap:12px;align-items:flex-start;padding-bottom:10px;border-bottom:1px solid var(--line)}
  .srank{font-family:var(--mono);font-size:13px;color:var(--dim);min-width:22px;text-align:right;padding-top:2px}
  .stitle a{font-size:17px;font-weight:600;letter-spacing:-.01em}
  .domain{color:var(--dim);font-size:12px;margin-left:7px}
  .smeta{font-family:var(--mono);font-size:11.5px;color:var(--dim);margin-top:4px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .hnlink{font-size:11.5px}
  .hot{color:var(--hot);font-weight:600}
  .prior{font-family:var(--mono);font-size:11px;color:#8a6d3b;background:#faf6ea;border:1px solid #eee3c3;border-radius:8px;padding:4px 8px;margin-top:7px;line-height:1.7}
  .prior a{font-size:11px;white-space:nowrap}.psep{margin:0 6px;color:#c9bd99}
  .lane{margin-top:12px}.lanelabel{font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--good);margin-bottom:8px}
  .comment{display:flex;gap:12px;padding:11px 0;border-top:1px dashed var(--line)}
  .comment:first-of-type{border-top:none}
  .crail{min-width:34px;text-align:center}
  .score{display:inline-block;font-family:var(--mono);font-size:12px;font-weight:600;color:var(--good);background:#eef5ef;border:1px solid #d6e7d8;border-radius:8px;padding:2px 6px}
  .cbody{flex:1;min-width:0}
  .cmeta{font-size:12.5px;color:var(--dim);margin-bottom:5px;display:flex;gap:7px;align-items:center;flex-wrap:wrap}
  .author{font-weight:600;color:#444}
  .badge{font-family:var(--mono);font-size:10.5px;background:#fbf2e9;border:1px solid #efd9c4;color:var(--accent);border-radius:10px;padding:1px 7px;white-space:nowrap}
  .moved{font-family:var(--mono);font-size:10px;color:#9a9a8c;background:#f0f0e6;border-radius:8px;padding:1px 6px}
  .permalink{margin-left:auto;color:var(--dim);font-size:13px}
  .ctext{font-size:14.5px;color:#23231d;overflow-wrap:break-word}.ctext p{margin:.5em 0}.ctext pre{background:#f3f3ea;padding:8px 10px;border-radius:8px;overflow:auto;font-size:12.5px}
  details.ctext summary{cursor:pointer;color:#23231d}details.ctext .full{margin-top:6px}
  .why{font-size:12px;color:var(--good);margin-top:6px;font-style:italic}
  .fold{margin-top:12px}.fold summary{cursor:pointer;font-family:var(--mono);font-size:12px;color:var(--dim);background:#f0f0e6;border:1px solid var(--line);border-radius:8px;padding:6px 10px}
  .foldnote{font-size:12.5px;color:var(--dim);padding:9px 4px 2px}
  .ordinary{font-size:12px;color:var(--dim);margin-top:8px;padding-left:2px}
  footer{max-width:860px;margin:0 auto;padding:30px 18px;color:var(--dim);font-size:12px;font-family:var(--mono);border-top:1px solid var(--line)}
  `
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>HN Front Page, Reranked — ${now.toISOString().slice(0, 10)}</title>
  <style>${css}</style></head><body>
  <header><div class="wrap" style="padding:0">
    <h1>Hacker News, reranked by substance</h1>
    <div class="tag">Surface the comment worth reading, hide the fight. — front page of ${now.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' })} UTC</div>
    <div class="stats">
      <span><b>${stats.stories}</b> stories</span>
      <span><b>${stats.comments.toLocaleString()}</b> comments analyzed</span>
      <span><b>${stats.surfaced}</b> surfaced</span>
      <span><b>${stats.flagged.toLocaleString()}</b> hidden as low-signal</span>
      <span><b>${stats.hot}</b> hot threads</span>
      <span><b>${stats.priorArt}</b> stories seen before</span>
    </div>
    <div class="legend">
      <span>🔗 source</span><span>⟨/⟩ code</span><span>✋ firsthand</span><span>📊 specifics</span><span>💬 discussion</span><span>🥊 duel → folded</span><span>📜 prior art</span>
    </div>
  </div></header>
  <main class="wrap">${stories.map(renderStory).join('')}</main>
  <footer>Zero participation · built from HN's public Firebase + Algolia APIs · comments re-ranked by transparent substance heuristics, not votes. Generated ${now.toISOString()}. <a href="https://github.com/scasella/hn-slow-rank">source</a></footer>
  </body></html>`
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
;(async () => {
  process.stderr.write(`Fetching front page (top ${TOP_N})…\n`)
  const ids = (await getJSON('https://hacker-news.firebaseio.com/v0/topstories.json')).slice(0, TOP_N)

  process.stderr.write(`Fetching ${ids.length} stories (meta + full comment trees)…\n`)
  const items = await mapLimit(ids, CONCURRENCY, async (id) => {
    const [fb, algolia] = await Promise.all([
      getJSON('https://hacker-news.firebaseio.com/v0/item/' + id + '.json'),
      getJSON('https://hn.algolia.com/api/v1/items/' + id),
    ])
    return { id, fb: fb || {}, algolia }
  })

  const stories = []
  let ci = 0
  items.filter(Boolean).forEach((it) => {
    if (it.fb && it.fb.type === 'job') return
    const s = processStory(it, ++ci)
    if (s) stories.push(s)
  })
  stories.forEach((s, i) => (s.rank = i + 1))

  if (PRIOR_ART) {
    process.stderr.write('Mining prior art (Algolia archive)…\n')
    await mapLimit(stories, CONCURRENCY, async (s) => { s.priorArt = await priorArt(s) })
  }

  const stats = {
    stories: stories.length,
    comments: stories.reduce((a, s) => a + s.nComments, 0),
    surfaced: stories.reduce((a, s) => a + s.surfaced.length, 0),
    flagged: stories.reduce((a, s) => a + s.flaggedCount, 0),
    hot: stories.filter((s) => s.hot).length,
    priorArt: stories.filter((s) => s.priorArt.length).length,
  }

  const fs = require('fs')
  fs.writeFileSync(OUT, renderPage(stories, stats))

  if (JSON_DUMP) {
    const dump = []
    for (const s of stories) {
      for (const c of s.comments) {
        dump.push({
          storyId: s.id, storyTitle: s.title, hot: s.hot,
          id: c.id, author: c.author, dfsIndex: c.dfsIndex, depth: c.depth,
          distinctRepliers: c.distinctRepliers, score: c.score,
          features: c.features, text: c.text.slice(0, 1600),
        })
      }
    }
    fs.mkdirSync(require('path').dirname(JSON_DUMP), { recursive: true })
    fs.writeFileSync(JSON_DUMP, JSON.stringify(dump))
    process.stderr.write(`Dumped ${dump.length} scored comments to ${JSON_DUMP}\n`)
  }

  process.stderr.write(`\nDone. ${stats.stories} stories · ${stats.comments} comments analyzed · ${stats.surfaced} surfaced · ${stats.flagged} hidden as low-signal · ${stats.hot} hot threads · ${stats.priorArt} with prior art\n`)
  process.stderr.write('Wrote ' + OUT + '\n')
  console.log(JSON.stringify({ ...stats, generatedAt: new Date().toISOString() }))
})().catch((e) => { console.error('FATAL', e); process.exit(1) })
