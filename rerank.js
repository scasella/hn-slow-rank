#!/usr/bin/env node
// Slow Rank — front-page generator.
// The comment worth reading, surfaced. Hide the fight.
// Zero-participation: pure read-only over HN's public Firebase + Algolia APIs.
//
//   node rerank.js [topStories=24] [perStory=6] [--out=frontpage-reranked.html]
//                  [--json=dump.json] [--weights=weights.json] [--no-prior-art]
//
// Scoring lives in lib/engine.js (shared with the browser extension and the
// adapters). --json dumps every scored comment + feature vector for
// calibration; --weights swaps in fitted weights.
//
// Page design (after the 5-expert panel review, 2026-06-09): one story told
// once — deck sentence → unified "Today's rescues" (hero = item 1 with the
// rank-delta as the headline + a share button) → "Browse every thread"
// digest, deduped against the rescues and collapsed after 5 stories.
// Two-color system (slate + clay), WCAG-clean meta text, real headings.
// Also emits <out dir>/og.svg (CI rasterizes it to og.png).

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
const SITE = 'https://scasella.github.io/hn-slow-rank/'
const REPO = 'https://github.com/scasella/hn-slow-rank'

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
      const res = await fetch(url, { headers: { 'user-agent': 'hot-thread-slow-rank/0.3 (read-only)' } })
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

const { domainOf } = engine
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
function escapeXml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
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
// cut plain text at a word boundary (box-drawing chars stripped — ASCII
// tables don't survive serif pull quotes)
function excerpt(text, n) {
  const t = String(text || '').replace(/[│┌┐└┘├┤┬┴┼─═║╔╗╚╝╠╣╦╩╬]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (t.length <= n) return t
  const cut = t.slice(0, n)
  return cut.slice(0, Math.max(40, cut.lastIndexOf(' '))) + '…'
}
const fmt = (n) => Number(n).toLocaleString('en-US')

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
// rescue selection + plain-english reasons
// ---------------------------------------------------------------------------
// how impressive is this rescue? quality × how deeply votes had buried it
const rescueRank = (c) => c.score * Math.log2(2 + c.dfsIndex)

// one short, jargon-free tag — the panel's "one quiet line" rule
function shortReason(c) {
  const f = c.features || {}
  const receipts = []
  if (f.links || f.primary) receipts.push('sources')
  if (f.code) receipts.push('code')
  if (f.specifics) receipts.push('numbers')
  if (f.firsthand && receipts.length) return 'firsthand, with ' + receipts.join(' + ')
  if (f.firsthand) return 'speaks from experience'
  if (receipts.length) return 'receipts: ' + receipts.join(' + ')
  if (f.discussion) return 'got ' + c.distinctRepliers + ' people talking'
  if (f.structured) return 'actually explains it'
  return 'substance'
}

function pickRescues(stories) {
  const all = []
  for (const s of stories) {
    for (const c of s.surfaced) {
      if (!c.text || c.text.length < 80) continue
      if (c.score < 3) continue
      all.push({ c, s })
    }
  }
  all.sort((a, b) => rescueRank(b.c) - rescueRank(a.c))
  // hero must read well as a pull quote and be a real rescue
  const hero = all.find((r) => r.c.dfsIndex >= 8 && r.c.text.length >= 120) || all[0] || null
  // cap rescues per source thread so the list shows range, not one hot thread
  const perThread = new Map()
  if (hero) perThread.set(hero.s.id, 1)
  const rest = []
  for (const r of all) {
    if (r === hero || r.c.dfsIndex < 5) continue
    const n = perThread.get(r.s.id) || 0
    if (n >= 2) continue
    perThread.set(r.s.id, n + 1)
    rest.push(r)
    if (rest.length === 9) break
  }
  return { hero, rescues: rest }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
// truncated quote that expands in place — full rich text revealed without
// leaving the page; "show less" collapses it back
function expandableQuote(c, limit, quoteClass) {
  const norm = c.text.replace(/[│┌┐└┘├┤┬┴┼─═║╔╗╚╝╠╣╦╩╬]+/g, ' ').replace(/\s+/g, ' ').trim()
  const short = excerpt(c.text, limit)
  if (norm.length <= limit) return `<p class="${quoteClass}">&ldquo;${escapeHtml(short)}&rdquo;</p>`
  const qid = `q-${c.id}`, xid = `x-${c.id}`
  return `<p class="${quoteClass}" id="${qid}">&ldquo;${escapeHtml(short)}&rdquo;
      <button class="pmore" data-expand="${xid}" data-quote="${qid}" aria-expanded="false" aria-controls="${xid}">expand ↓</button></p>
    <div class="rfull" id="${xid}" hidden>${safeCommentHtml(c.textHtml)}
      <button class="pmore" data-collapse="${xid}" data-quote="${qid}">show less ↑</button></div>`
}

function renderHeroItem(hero) {
  if (!hero) return ''
  const { c, s } = hero
  const from = c.dfsIndex + 1
  const stat = from >= 8
    ? `Buried at <b>#${fmt(from)}</b> by votes. Should&rsquo;ve been <b>#1</b>.`
    : `The comment worth reading today.`
  const shareText = `HN buried this comment at #${fmt(from)}. It should've been #1: ${excerpt(c.text, 120)} — ${SITE}#r-${c.id}`
  return `<article class="heroitem" id="r-${c.id}" aria-labelledby="herostat">
    <p class="bigstat" id="herostat">${stat}</p>
    ${expandableQuote(c, 300, 'pull')}
    <p class="hmeta"><b>${escapeHtml(c.author)}</b> · on &ldquo;<a href="https://news.ycombinator.com/item?id=${s.id}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a>&rdquo; · ${escapeHtml(shortReason(c))}</p>
    <div class="heroactions">
      <button class="share" data-share="${escapeHtml(shareText)}" aria-label="Copy a shareable summary of this rescue">Share this rescue</button>
      <a class="ghost" target="_blank" rel="noopener" href="https://news.ycombinator.com/item?id=${c.id}">read it in the thread ↗</a>
    </div>
  </article>`
}

function renderRescueItem({ c, s }) {
  return `<li class="ritem" id="r-${c.id}">
    ${expandableQuote(c, 170, 'rq')}
    <p class="rmeta"><b>${escapeHtml(c.author)}</b> · ${escapeHtml(excerpt(s.title, 54))} · <span class="was">was #${fmt(c.dfsIndex + 1)}</span> · ${escapeHtml(shortReason(c))} · <a target="_blank" rel="noopener" href="https://news.ycombinator.com/item?id=${c.id}">thread ↗</a></p>
  </li>`
}

function renderComment(c) {
  const was = c.dfsIndex >= 3 ? `<span class="was">was #${fmt(c.dfsIndex + 1)}</span> · ` : ''
  let body
  if (c.text.length > 900) {
    body = `<details class="ctext"><summary>${escapeHtml(c.text.slice(0, 220))}…</summary><div class="full">${safeCommentHtml(c.textHtml)}</div></details>`
  } else {
    body = `<div class="ctext">${safeCommentHtml(c.textHtml)}</div>`
  }
  return `<div class="comment">
    <p class="cmeta"><b class="author">${escapeHtml(c.author)}</b> · ${was}${escapeHtml(shortReason(c))}
      <a class="permalink" target="_blank" rel="noopener" href="https://news.ycombinator.com/item?id=${c.id}" aria-label="Open this comment on Hacker News">open&nbsp;↗</a></p>
    ${body}
  </div>`
}

function renderPriorArt(s) {
  if (!s.priorArt.length) return ''
  const links = s.priorArt.map((p) =>
    `<a target="_blank" rel="noopener" href="https://news.ycombinator.com/item?id=${p.id}" title="${escapeHtml(p.title)}">${p.date.slice(0, 4)} (${p.points}&nbsp;pts)</a>`).join(' · ')
  return `<p class="prior">HN has discussed this before: ${links}</p>`
}

function renderStory(s, rescueIds) {
  const shown = s.surfaced.filter((c) => !rescueIds.has(c.id))
  const featured = s.surfaced.length - shown.length
  const top = shown.slice(0, 3).map(renderComment).join('')
  const more = shown.slice(3)
  const moreBlock = more.length
    ? `<details class="more"><summary>+ ${more.length} more worth reading</summary>${more.map(renderComment).join('')}</details>`
    : ''
  const featuredNote = featured ? `<p class="featurednote">▲ ${featured} comment${featured > 1 ? 's' : ''} from this thread featured in Today's rescues above</p>` : ''
  const foldBits = []
  if (s.flaggedCount) foldBits.push(`<details class="fold"><summary>${s.flaggedCount} comments tucked away (the fights and one-liners)</summary>
         <div class="foldnote">Hidden by default: repetitive back-and-forth arguments, snark, and low-content one-liners. They're all still on HN — expand the thread there if you want them.</div></details>`)
  if (s.ordinaryCount) foldBits.push(`<p class="ordinary">+ ${s.ordinaryCount} more on-topic comments (fine, just not the standouts — <a target="_blank" rel="noopener" href="https://news.ycombinator.com/item?id=${s.id}">all on HN ↗</a>)</p>`)
  return `<section class="story" id="s-${s.id}" aria-labelledby="st-${s.id}">
    <div class="shead">
      <span class="srank" aria-hidden="true">${s.rank}</span>
      <div class="stitle">
        <h3 id="st-${s.id}"><a target="_blank" rel="noopener" href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a></h3>
        <p class="smeta">${escapeHtml(s.domain)} · ${s.points} pts · ${s.nComments} comments · ${s.age}
          <a class="hnlink" target="_blank" rel="noopener" href="https://news.ycombinator.com/item?id=${s.id}">discuss on HN ↗</a></p>
        ${renderPriorArt(s)}
      </div>
    </div>
    <div class="lane">${featuredNote}${top}${moreBlock}</div>
    ${foldBits.join('')}
  </section>`
}

const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#FAF9F5"/><path d="M16 7 L26 24 L6 24 Z" fill="#D97757"/></svg>')

function renderPage(stories, stats, hero, rescues) {
  const now = new Date()
  const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
  const ogDesc = hero
    ? `Today's rescue: a comment votes buried at #${fmt(hero.c.dfsIndex + 1)}. ${excerpt(hero.c.text, 120)}`
    : 'Hacker News comment threads re-ranked by substance instead of votes, updated hourly.'
  const rescueIds = new Set([hero, ...rescues].filter(Boolean).map((r) => r.c.id))
  const firstStories = stories.slice(0, 5)
  const restStories = stories.slice(5)

  const css = `
  :root{--ink:rgba(255,255,255,.97);--body:rgba(255,255,255,.88);--meta:rgba(255,255,255,.68);
    --hairline:rgba(255,255,255,.30);--hairline-soft:rgba(255,255,255,.16);
    --glass:linear-gradient(135deg,rgba(255,255,255,.16),rgba(255,255,255,.06));
    --glass-strong:linear-gradient(135deg,rgba(255,255,255,.24),rgba(255,255,255,.10));
    --accent:#FFC9A3;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --mono:ui-monospace,"SF Mono",Menlo,Monaco,Consolas,monospace}
  *{box-sizing:border-box}html{scroll-behavior:smooth}
  body{margin:0;background:#16112e;color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased;overflow-x:hidden}
  .bg{position:fixed;inset:-25%;z-index:-2;pointer-events:none;filter:blur(80px) saturate(150%);
    background:
     radial-gradient(42% 52% at 12% 18%,rgba(255,122,89,.85),transparent 62%),
     radial-gradient(36% 46% at 88% 12%,rgba(96,205,255,.70),transparent 62%),
     radial-gradient(46% 56% at 78% 82%,rgba(255,93,162,.65),transparent 62%),
     radial-gradient(40% 52% at 22% 86%,rgba(255,209,102,.60),transparent 62%),
     radial-gradient(70% 80% at 50% 50%,rgba(108,75,217,.80),transparent 75%);
    animation:drift 26s ease-in-out infinite alternate}
  @keyframes drift{from{transform:translate3d(-2.5%,-1.5%,0) rotate(-2deg) scale(1)}to{transform:translate3d(2.5%,2%,0) rotate(4deg) scale(1.12)}}
  .grain{position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.07;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/></filter><rect width='160' height='160' filter='url(%23n)' opacity='0.55'/></svg>")}
  @media (prefers-reduced-motion:reduce){.bg{animation:none}}
  a{color:#fff;text-decoration-color:rgba(255,255,255,.45);text-decoration-thickness:1px;text-underline-offset:3px}
  a:hover{text-decoration-color:#fff}
  a:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid #fff;outline-offset:2px;border-radius:6px}
  .wrap{max-width:860px;margin:0 auto;padding:0 22px}
  .vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .mast{padding:42px 0 0}
  h1.brand{font-size:30px;font-weight:800;letter-spacing:-.02em;margin:0;color:#fff;text-shadow:0 2px 18px rgba(0,0,0,.30)}
  .brand .tri{color:var(--accent)}
  .brand .bsub{font-family:var(--mono);font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--meta);margin-left:10px}
  .deck{font-size:17px;color:var(--body);margin:12px 0 0;max-width:580px;line-height:1.55;text-shadow:0 1px 12px rgba(0,0,0,.25)}
  .mnav{font-family:var(--mono);font-size:12px;color:var(--meta);margin-top:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .mnav a,.mnav span{color:var(--meta);background:var(--glass);border:1px solid var(--hairline-soft);border-radius:999px;padding:7px 13px;text-decoration:none;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
  .mnav a:hover{color:#fff;border-color:var(--hairline)}
  .eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--meta);display:flex;align-items:center;gap:12px;margin:0 0 14px}
  .eyebrow::before{content:"";width:26px;height:1.5px;background:var(--accent)}
  h2{font-size:22px;font-weight:700;letter-spacing:-.015em;margin:0 0 4px;color:#fff}
  .secsub{color:var(--meta);font-size:13.5px;margin:0 0 16px}
  .rescues{margin-top:52px}
  .heroitem{background:var(--glass-strong);backdrop-filter:blur(26px) saturate(160%);-webkit-backdrop-filter:blur(26px) saturate(160%);border:1px solid var(--hairline);border-radius:28px;padding:32px 36px;margin-bottom:20px;box-shadow:0 20px 60px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.40)}
  .bigstat{font-size:clamp(26px,4vw,40px);font-weight:800;line-height:1.12;letter-spacing:-.02em;margin:0 0 18px;color:#fff;text-shadow:0 2px 22px rgba(0,0,0,.25)}
  .bigstat b{color:var(--accent);font-weight:800}
  .pull{font-size:clamp(17px,2.4vw,21px);font-weight:500;line-height:1.5;margin:0;color:var(--body)}
  .pmore{font-family:var(--mono);font-size:11.5px;color:var(--accent);background:none;border:none;cursor:pointer;padding:6px 8px;margin-left:2px;white-space:nowrap}
  .pmore:hover{color:#fff;text-decoration:underline}
  .rfull{margin-top:10px;font-size:15px;color:var(--body);overflow-wrap:break-word}
  .rfull p{margin:.5em 0}
  .rfull pre{background:rgba(0,0,0,.35);border:1px solid var(--hairline-soft);color:#EDE9F7;padding:9px 11px;border-radius:12px;overflow:auto;font-size:13px;font-family:var(--mono)}
  .rfull .pmore{display:block;margin:10px 0 0;padding-left:0}
  .hmeta{margin:16px 0 0;font-size:13.5px;color:var(--meta)}
  .hmeta b{color:#fff}
  .heroactions{margin-top:20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  .share{font-family:var(--sans);font-size:14px;font-weight:700;color:#231a33;background:#fff;border:none;border-radius:999px;padding:13px 24px;cursor:pointer;min-height:44px;box-shadow:0 10px 30px rgba(0,0,0,.30);transition:transform .15s ease}
  .share:hover{transform:translateY(-1px)}
  .ghost{display:inline-flex;align-items:center;font-family:var(--mono);font-size:12.5px;color:#fff;background:var(--glass);border:1px solid var(--hairline);border-radius:999px;padding:11px 18px;cursor:pointer;text-decoration:none;min-height:44px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
  .ghost:hover{border-color:#fff}
  .rlist{list-style:none;counter-reset:r 1;margin:0;padding:0;background:var(--glass);backdrop-filter:blur(22px) saturate(150%);-webkit-backdrop-filter:blur(22px) saturate(150%);border:1px solid var(--hairline);border-radius:24px;overflow:hidden;box-shadow:0 14px 44px rgba(0,0,0,.30),inset 0 1px 0 rgba(255,255,255,.30)}
  .ritem{counter-increment:r;padding:16px 20px 16px 56px;border-bottom:1px solid rgba(255,255,255,.12);position:relative}
  .ritem:last-child{border-bottom:none}
  .ritem::before{content:counter(r);position:absolute;left:20px;top:17px;font-family:var(--mono);font-size:13px;color:var(--accent)}
  .rq{display:block;font-size:16px;font-weight:550;line-height:1.5;color:var(--ink);margin:0}
  .rmeta{margin:7px 0 0;font-size:12.5px;color:var(--meta)}
  .rmeta b{color:var(--body)}
  .was{font-family:var(--mono);font-size:12px;color:var(--accent)}
  .digest{margin-top:60px}
  .story{background:var(--glass);backdrop-filter:blur(22px) saturate(150%);-webkit-backdrop-filter:blur(22px) saturate(150%);border:1px solid var(--hairline-soft);border-radius:24px;padding:20px 22px;margin:0 0 16px;box-shadow:0 10px 36px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.25)}
  .shead{display:flex;gap:12px;align-items:flex-start;padding-bottom:9px;border-bottom:1px solid rgba(255,255,255,.12)}
  .srank{font-family:var(--mono);font-size:12.5px;color:var(--meta);min-width:20px;text-align:right;padding-top:5px}
  .stitle h3{font-size:17px;font-weight:700;letter-spacing:-.01em;margin:0;line-height:1.35}
  .stitle h3 a{color:#fff;text-decoration:none}
  .stitle h3 a:hover{text-decoration:underline}
  .smeta{font-family:var(--mono);font-size:12.5px;color:var(--meta);margin:5px 0 0}
  .hnlink{margin-left:8px}
  .prior{font-family:var(--mono);font-size:12.5px;color:var(--meta);margin:6px 0 0}
  .lane{margin-top:8px}
  .featurednote{font-family:var(--mono);font-size:12.5px;color:var(--accent);margin:8px 0 0}
  .comment{padding:12px 0;border-top:1px dashed rgba(255,255,255,.16)}
  .comment:first-of-type{border-top:none}
  .cmeta{font-size:13px;color:var(--meta);margin:0 0 4px;display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
  .author{color:var(--body);font-weight:700}
  .permalink{margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--meta);padding:6px 8px;margin-top:-6px;margin-bottom:-6px}
  .ctext{font-size:15px;color:var(--body);overflow-wrap:break-word}.ctext p{margin:.5em 0}
  .ctext pre{background:rgba(0,0,0,.35);border:1px solid var(--hairline-soft);color:#EDE9F7;padding:9px 11px;border-radius:12px;overflow:auto;font-size:13px;font-family:var(--mono)}
  details.ctext summary{cursor:pointer;padding:10px 0;min-height:24px;color:var(--body)}details.ctext .full{margin-top:6px}
  details.more{margin-top:8px}
  details.more summary{cursor:pointer;font-family:var(--mono);font-size:12.5px;color:var(--meta);padding:14px 0;min-height:16px}
  details.more summary:hover{color:#fff}
  details.wide{margin:8px 0}
  details.wide > summary{cursor:pointer;font-family:var(--mono);font-size:12.5px;color:var(--body);background:var(--glass);border:1px solid var(--hairline-soft);border-radius:12px;padding:12px 14px}
  .fold{margin-top:10px}
  .fold summary{cursor:pointer;font-family:var(--mono);font-size:12.5px;color:var(--body);background:var(--glass);border:1px solid var(--hairline-soft);border-radius:999px;padding:12px 16px;display:inline-block;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
  .fold summary:hover{border-color:var(--hairline)}
  .foldnote{font-size:13px;color:var(--meta);padding:8px 4px 2px}
  .ordinary{font-size:12.5px;color:var(--meta);margin:8px 0 0}
  details.morestories{margin-top:4px}
  details.morestories > summary{cursor:pointer;font-family:var(--sans);font-weight:600;font-size:14px;color:#fff;background:var(--glass-strong);border:1px solid var(--hairline);border-radius:999px;padding:15px 22px;list-style-position:inside;backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);box-shadow:inset 0 1px 0 rgba(255,255,255,.30)}
  details.morestories > summary:hover{border-color:#fff}
  details.morestories[open] > summary{margin-bottom:16px}
  footer{margin:70px 0 0;padding:20px 0 100px;border-top:1px solid rgba(255,255,255,.18);font-family:var(--mono);font-size:12px;color:var(--meta);line-height:2}
  footer a{color:var(--meta)}footer a:hover{color:#fff}
  @supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
    .heroitem,.rlist,.story,.fold summary,.details.wide > summary,.mnav a,.mnav span,.ghost,details.morestories > summary{background:rgba(30,23,58,.92)}
  }
  @media (max-width:680px){
    .mast{padding-top:28px}
    .heroitem{padding:24px 20px;border-radius:22px}
    .ritem{padding:14px 16px 14px 46px}
    .ritem::before{left:16px}
    .permalink{margin-left:0}
    .ctext pre,.rfull pre{font-size:12px}
    .bg{filter:blur(60px) saturate(150%)}
  }`

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Slow Rank — the comment worth reading, surfaced</title>
  <meta name="description" content="${escapeHtml(ogDesc)}">
  <link rel="icon" href="${FAVICON}">
  <link rel="canonical" href="${SITE}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Slow Rank">
  <meta property="og:title" content="Slow Rank — the comment worth reading, surfaced">
  <meta property="og:description" content="${escapeHtml(ogDesc)}">
  <meta property="og:url" content="${SITE}">
  <meta property="og:image" content="${SITE}og.png">
  <meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Slow Rank — the comment worth reading, surfaced">
  <meta name="twitter:description" content="${escapeHtml(ogDesc)}">
  <meta name="twitter:image" content="${SITE}og.png">
  <style>${css}</style></head><body>
  <div class="bg" aria-hidden="true"></div>
  <div class="grain" aria-hidden="true"></div>
  <main class="wrap">
  <header class="mast">
    <h1 class="brand"><span class="tri" aria-hidden="true">▲</span> Slow Rank<span class="bsub">for Hacker News</span></h1>
    <p class="deck">Hacker News ranks comments by upvotes. Every hour we re-rank every thread by who actually knows what they're talking about &mdash; here's today's handful worth your time.</p>
    <p class="mnav">
      <span>${fmt(stats.comments)} comments read this hour</span>
      <span class="fresh" id="fresh" data-t="${now.toISOString()}">updates hourly</span>
      <a href="feed.xml">subscribe (RSS)</a>
      <a href="${REPO}#how-it-scores">how scoring works</a>
      <a href="${REPO}">source</a>
    </p>
  </header>

  <section class="rescues" aria-labelledby="rescues-h">
    <div class="eyebrow">Today's rescues · ${dateStr}</div>
    <h2 id="rescues-h" class="vh">Today's rescues</h2>
    <p class="secsub">The most buried-but-worth-it comments on today's front page, best first &mdash; flagged when they bring sources, code, or firsthand experience.</p>
    ${renderHeroItem(hero)}
    ${rescues.length ? `<ol class="rlist">${rescues.map(renderRescueItem).join('')}</ol>` : ''}
  </section>

  <section class="digest" aria-labelledby="digest-h">
    <h2 id="digest-h">Browse every thread</h2>
    <p class="secsub">All ${stats.stories} front-page stories — each thread's most substantial comments, and where votes had them.</p>
    ${firstStories.map((s) => renderStory(s, rescueIds)).join('')}
    ${restStories.length ? `<details class="morestories"><summary>Show the other ${restStories.length} threads</summary>${restStories.map((s) => renderStory(s, rescueIds)).join('')}</details>` : ''}
  </section>

  <footer>
    read-only over HN's public APIs — no votes harvested, nothing posted · scoring is transparent heuristics, not a black box:
    <a href="${REPO}#how-it-scores">how it works</a> · weights cross-checked against blind pairwise judgments (81% held-out agreement,
    <a href="${REPO}/blob/main/calibration/REPORT.md">report</a>) · generated ${now.toISOString()} · <a href="${REPO}">github</a>
  </footer>
  </main>
  <span class="vh" id="announce" aria-live="polite"></span>
  <script>
  (function(){
    var el = document.getElementById('fresh')
    if (el && el.dataset.t) {
      var m = Math.round((Date.now() - new Date(el.dataset.t).getTime()) / 60000)
      el.textContent = (m < 1 ? 'updated just now' : m < 120 ? 'updated ' + m + ' min ago' : 'updated ' + Math.round(m / 60) + ' h ago')
    }
    var live = document.getElementById('announce')
    function flash(b, msg, announce) {
      var t = b.textContent; b.textContent = msg
      if (live) live.textContent = announce
      setTimeout(function(){ b.textContent = t; if (live) live.textContent = '' }, 2000)
    }
    document.querySelectorAll('[data-share]').forEach(function(b){
      b.addEventListener('click', function(){
        var text = b.dataset.share
        if (navigator.share) {
          navigator.share({ text: text }).catch(function(){ /* user cancelled */ })
          return
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function(){
            flash(b, 'Copied — paste anywhere', 'Share text copied to clipboard')
          }, function(){
            flash(b, "Couldn't copy — select it in the thread", 'Copy failed')
          })
        } else {
          flash(b, "Couldn't copy — select it in the thread", 'Copy not supported')
        }
      })
    })
    // truncated quotes expand in place — no leaving the page to finish reading
    function swapQuote(quoteId, fullId, showFull) {
      var q = document.getElementById(quoteId), f = document.getElementById(fullId)
      if (!q || !f) return
      q.hidden = showFull
      f.hidden = !showFull
      var btn = q.querySelector('[data-expand]')
      if (btn) btn.setAttribute('aria-expanded', String(showFull))
    }
    document.querySelectorAll('[data-expand]').forEach(function(b){
      b.addEventListener('click', function(){ swapQuote(b.dataset.quote, b.dataset.expand, true) })
    })
    document.querySelectorAll('[data-collapse]').forEach(function(b){
      b.addEventListener('click', function(){ swapQuote(b.dataset.quote, b.dataset.collapse, false) })
    })
    // wide code/ASCII tables become tap-to-expand on small screens (the
    // sideways-scroll-inside-vertical-scroll trap)
    if (window.innerWidth <= 680) {
      document.querySelectorAll('.ctext pre, .rfull pre').forEach(function(pre){
        if (pre.scrollWidth > pre.clientWidth + 12) {
          var d = document.createElement('details')
          d.className = 'wide'
          d.innerHTML = '<summary>show code / table (scrolls sideways)</summary>'
          pre.parentNode.insertBefore(d, pre)
          d.appendChild(pre)
        }
      })
    }
  })()
  </script>
  </body></html>`
}

// ---------------------------------------------------------------------------
// OG quote card (SVG; CI rasterizes to og.png)
// ---------------------------------------------------------------------------
function wrapLines(text, maxChars, maxLines) {
  const words = String(text).split(/\s+/)
  const lines = []
  let cur = ''
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars) {
      lines.push(cur.trim())
      cur = w
      if (lines.length === maxLines) break
    } else cur = (cur + ' ' + w).trim()
  }
  if (lines.length < maxLines && cur) lines.push(cur.trim())
  if (words.join(' ').length > lines.join(' ').length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/\W*$/, '') + '…'
  }
  return lines
}

function renderOgSvg(hero, stats) {
  const from = hero ? fmt(hero.c.dfsIndex + 1) : null
  const headline = hero && hero.c.dfsIndex + 1 >= 8
    ? `Buried at #${from}. Should've been #1.`
    : `The comment worth reading, surfaced.`
  const quote = hero ? excerpt(hero.c.text, 160) : 'Hacker News, re-ranked by substance instead of votes.'
  const lines = wrapLines(quote, 52, 3)
  const attrib = hero ? `${hero.c.author} · on “${excerpt(hero.s.title, 48)}”` : ''
  const quoteLines = lines.map((l, i) =>
    `<text x="120" y="${330 + i * 46}" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#FFFFFF" fill-opacity="0.85">${escapeXml(l)}</text>`).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="g1" cx="15%" cy="20%" r="55%"><stop offset="0%" stop-color="#FF7A59" stop-opacity=".9"/><stop offset="100%" stop-color="#FF7A59" stop-opacity="0"/></radialGradient>
    <radialGradient id="g2" cx="88%" cy="12%" r="50%"><stop offset="0%" stop-color="#60CDFF" stop-opacity=".8"/><stop offset="100%" stop-color="#60CDFF" stop-opacity="0"/></radialGradient>
    <radialGradient id="g3" cx="78%" cy="85%" r="55%"><stop offset="0%" stop-color="#FF5DA2" stop-opacity=".8"/><stop offset="100%" stop-color="#FF5DA2" stop-opacity="0"/></radialGradient>
    <radialGradient id="g4" cx="25%" cy="88%" r="50%"><stop offset="0%" stop-color="#FFD166" stop-opacity=".7"/><stop offset="100%" stop-color="#FFD166" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1200" height="630" fill="#16112E"/>
  <rect width="1200" height="630" fill="url(#g1)"/><rect width="1200" height="630" fill="url(#g2)"/>
  <rect width="1200" height="630" fill="url(#g3)"/><rect width="1200" height="630" fill="url(#g4)"/>
  <rect x="60" y="80" width="1080" height="470" rx="36" fill="#FFFFFF" fill-opacity="0.13" stroke="#FFFFFF" stroke-opacity="0.35" stroke-width="1.5"/>
  <text x="120" y="160" font-family="Menlo, monospace" font-size="21" letter-spacing="4" fill="#FFFFFF" fill-opacity="0.65">SLOW RANK · TODAY'S RESCUE</text>
  <text x="120" y="245" font-family="Helvetica, Arial, sans-serif" font-weight="bold" font-size="52" fill="#FFFFFF">${escapeXml(headline)}</text>
  ${quoteLines}
  <text x="120" y="${330 + lines.length * 46 + 28}" font-family="Menlo, monospace" font-size="21" fill="#FFFFFF" fill-opacity="0.65">${escapeXml(attrib)}</text>
  <text x="120" y="600" font-family="Menlo, monospace" font-size="17" fill="#FFFFFF" fill-opacity="0.55">${escapeXml(`${fmt(stats.comments || 0)} comments read this hour · scasella.github.io/hn-slow-rank`)}</text>
  </svg>`
}

// ---------------------------------------------------------------------------
// Atom feed — the retention hook for a static site. One entry per rescue,
// id = the HN comment, so readers dedupe across hourly regenerations and
// only see genuinely new rescues.
// ---------------------------------------------------------------------------
function renderFeed(hero, rescues, now) {
  const items = [hero, ...rescues].filter(Boolean)
  const entry = ({ c, s }, isHero) => {
    const from = c.dfsIndex + 1
    const title = (isHero && from >= 8)
      ? `Buried at #${fmt(from)}. Should've been #1: ${excerpt(c.text, 70)}`
      : `was #${fmt(from)} — ${excerpt(c.text, 80)}`
    return `<entry>
  <id>https://news.ycombinator.com/item?id=${c.id}</id>
  <title>${escapeXml(title)}</title>
  <link href="https://news.ycombinator.com/item?id=${c.id}"/>
  <updated>${new Date(c.created * 1000 || now).toISOString()}</updated>
  <author><name>${escapeXml(c.author)}</name></author>
  <summary>${escapeXml(excerpt(c.text, 400) + ` — ${c.author}, on "${s.title}" (votes had it at #${fmt(from)})`)}</summary>
</entry>`
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Slow Rank — today's rescues</title>
<subtitle>The Hacker News comments worth reading, surfaced from where votes buried them. Hourly.</subtitle>
<link href="${SITE}"/>
<link rel="self" href="${SITE}feed.xml"/>
<id>${SITE}</id>
<updated>${now.toISOString()}</updated>
${items.map((r, i) => entry(r, i === 0)).join('\n')}
</feed>
`
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

  const { hero, rescues } = pickRescues(stories)
  if (hero) process.stderr.write(`Hero rescue: ${hero.c.author} from #${hero.c.dfsIndex + 1} (score ${hero.c.score}) on "${hero.s.title}"\n`)

  const fs = require('fs')
  const path = require('path')
  const outDir = path.dirname(path.resolve(OUT))
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(OUT, renderPage(stories, stats, hero, rescues))
  fs.writeFileSync(path.join(outDir, 'og.svg'), renderOgSvg(hero, stats))
  fs.writeFileSync(path.join(outDir, 'feed.xml'), renderFeed(hero, rescues, new Date()))

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
    fs.mkdirSync(path.dirname(path.resolve(JSON_DUMP)), { recursive: true })
    fs.writeFileSync(JSON_DUMP, JSON.stringify(dump))
    process.stderr.write(`Dumped ${dump.length} scored comments to ${JSON_DUMP}\n`)
  }

  process.stderr.write(`\nDone. ${stats.stories} stories · ${stats.comments} comments analyzed · ${stats.surfaced} surfaced · ${stats.flagged} folded as low-signal · ${stats.hot} hot threads · ${stats.priorArt} with prior art\n`)
  process.stderr.write('Wrote ' + OUT + ' (+ og.svg)\n')
  console.log(JSON.stringify({ ...stats, generatedAt: new Date().toISOString() }))
})().catch((e) => { console.error('FATAL', e); process.exit(1) })
