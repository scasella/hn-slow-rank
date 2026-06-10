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
// Page design: "Daily Rescue" editorial layout — hero rescued comment,
// x-ray strip explaining the mechanism, today's rescues with permalinks,
// then the per-story digest. Also emits <out dir>/og.svg (CI rasterizes it
// to og.png for social cards).

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
// cut plain text at a word boundary
function excerpt(text, n) {
  const t = String(text || '').replace(/[│┌┐└┘├┤┬┴┼─═║╔╗╚╝╠╣╦╩╬]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (t.length <= n) return t
  const cut = t.slice(0, n)
  return cut.slice(0, Math.max(40, cut.lastIndexOf(' '))) + '…'
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
// rescue selection + plain-english reasons
// ---------------------------------------------------------------------------
// how impressive is this rescue? quality × how deeply votes had buried it
const rescueRank = (c) => c.score * Math.log2(2 + c.dfsIndex)

function plainReason(c) {
  const f = c.features || {}
  const receipts = []
  if (f.links || f.primary) receipts.push(f.primary ? 'primary sources' : 'sources')
  if (f.code) receipts.push('code')
  if (f.specifics) receipts.push('real numbers')
  const bits = []
  if (f.firsthand) bits.push('speaks from experience')
  if (receipts.length) bits.push('brought receipts: ' + receipts.join(' + '))
  if (!bits.length && f.discussion) bits.push('got ' + c.distinctRepliers + ' people talking')
  if (!bits.length && f.structured) bits.push('took the time to actually explain')
  if (!bits.length) bits.push((c.reasons && c.reasons[0]) || 'substantive')
  return bits.join(' — ')
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
  const rest = all.filter((r) => r !== hero && r.c.dfsIndex >= 5).slice(0, 9)
  return { hero, rescues: rest }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
function renderHero(hero, dateStr) {
  if (!hero) return ''
  const { c, s } = hero
  return `<section class="hero" id="r-${c.id}">
    <div class="eyebrow">Today's rescue · ${dateStr}</div>
    <blockquote class="pull">&ldquo;${escapeHtml(excerpt(c.text, 320))}&rdquo;</blockquote>
    <div class="attrib"><b>${escapeHtml(c.author)}</b> · on &ldquo;<a href="https://news.ycombinator.com/item?id=${s.id}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a>&rdquo; · <span class="preason">${escapeHtml(plainReason(c))}</span></div>
    <div class="heroactions">
      <span class="rescuepill">▲ rescued from #${c.dfsIndex + 1} by votes</span>
      <a class="ghost" target="_blank" rel="noopener" href="https://news.ycombinator.com/item?id=${c.id}">read in thread ↗</a>
      <button class="ghost" data-copy="r-${c.id}">copy link</button>
    </div>
  </section>`
}

function renderXray(hero) {
  if (!hero) return ''
  const { c, s } = hero
  const from = c.dfsIndex + 1
  // illustrative strip: gem teleports up, the fight sinks
  const rows = (kind) => kind === 'votes'
    ? `<i></i><i class="fight"></i><i class="fight"></i><i></i><i></i><i></i><i class="gem"></i>`
    : `<i class="gem"></i><i></i><i></i><i></i><i class="fight dim"></i><i class="fight dim"></i><i class="dim"></i>`
  return `<section class="xray">
    <div class="xcols">
      <div><div class="xh">By votes</div><div class="xrows">${rows('votes')}</div></div>
      <div><div class="xh">By substance</div><div class="xrows">${rows('substance')}</div></div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M 46 86 C 58 86, 42 14, 54 14" fill="none" stroke="#D97757" stroke-width="1.4" stroke-dasharray="3 2"/></svg>
    </div>
    <div class="xcap">That's the whole product: in &ldquo;${escapeHtml(excerpt(s.title, 60))}&rdquo;, votes had this comment at <b>#${from}</b>; substance scoring puts it first. Flame-war duels (striped) sink, dimmed but never deleted.</div>
  </section>`
}

function renderRescueList(rescues) {
  if (!rescues.length) return ''
  const items = rescues.map(({ c, s }) => `<li class="ritem" id="r-${c.id}">
      <div class="rq">&ldquo;${escapeHtml(excerpt(c.text, 170))}&rdquo;</div>
      <div class="rmeta">
        <b>${escapeHtml(c.author)}</b>
        <span class="dimsep">·</span> <a href="https://news.ycombinator.com/item?id=${s.id}" target="_blank" rel="noopener">${escapeHtml(excerpt(s.title, 56))}</a>
        <span class="waspill">was #${c.dfsIndex + 1}</span>
        <span class="preason">${escapeHtml(plainReason(c))}</span>
        <span class="ractions"><a class="ghost" target="_blank" rel="noopener" href="https://news.ycombinator.com/item?id=${c.id}">thread ↗</a> <button class="ghost" data-copy="r-${c.id}">copy link</button></span>
      </div>
    </li>`).join('')
  return `<section class="rescues">
    <h2>Today's rescues</h2>
    <p class="secsub">The best comments votes left for dead, across every front-page thread.</p>
    <ol class="rlist">${items}</ol>
  </section>`
}

function renderComment(c) {
  const was = c.dfsIndex >= 3 ? `<span class="waspill">was&nbsp;#${c.dfsIndex + 1}</span>` : ''
  let body
  if (c.text.length > 900) {
    body = `<details class="ctext"><summary>${escapeHtml(c.text.slice(0, 220))}…</summary><div class="full">${safeCommentHtml(c.textHtml)}</div></details>`
  } else {
    body = `<div class="ctext">${safeCommentHtml(c.textHtml)}</div>`
  }
  return `<div class="comment">
    <div class="cmeta"><b class="author">${escapeHtml(c.author)}</b> ${was} <span class="preason">${escapeHtml(plainReason(c))}</span>
      <a class="permalink" target="_blank" rel="noopener" href="https://news.ycombinator.com/item?id=${c.id}" title="open on HN">↗</a></div>
    ${body}
  </div>`
}

function renderPriorArt(s) {
  if (!s.priorArt.length) return ''
  const links = s.priorArt.map((p) =>
    `<a target="_blank" rel="noopener" href="https://news.ycombinator.com/item?id=${p.id}" title="${escapeHtml(p.title)}">${p.date.slice(0, 4)} (${p.points}&nbsp;pts, ${p.comments}&nbsp;comment${p.comments === 1 ? '' : 's'})</a>`).join(' · ')
  return `<div class="prior">seen before on HN: ${links}</div>`
}

function renderStory(s) {
  const top = s.surfaced.slice(0, 3).map(renderComment).join('')
  const more = s.surfaced.slice(3)
  const moreBlock = more.length
    ? `<details class="more"><summary>+ ${more.length} more worth reading</summary>${more.map(renderComment).join('')}</details>`
    : ''
  const hotBadge = s.hot ? `<span class="hotpill">hot thread — combat down-weighted</span>` : ''
  const foldBits = []
  if (s.flaggedCount) foldBits.push(`<details class="fold"><summary>${s.flaggedCount} low-signal comments folded${s.duelCount ? ` (${s.duelCount} in duels)` : ''}</summary>
         <div class="foldnote">Folded: flame-war back-and-forths, dunks, name-calling, and low-content one-liners. They're all still on HN — expand if you want the fight.</div></details>`)
  if (s.ordinaryCount) foldBits.push(`<div class="ordinary">+ ${s.ordinaryCount} more on-topic comments (fine, just not top-ranked — <a target="_blank" rel="noopener" href="https://news.ycombinator.com/item?id=${s.id}">all on HN ↗</a>)</div>`)
  return `<section class="story" id="s-${s.id}">
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
    <div class="lane"><div class="lanelabel">▲ Worth reading</div>${top}${moreBlock}</div>
    ${foldBits.join('')}
  </section>`
}

const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#FAF9F5"/><path d="M16 7 L26 24 L6 24 Z" fill="#D97757"/></svg>')

function renderPage(stories, stats, hero, rescues) {
  const now = new Date()
  const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
  const ogDesc = hero
    ? `Today's rescue: a comment votes buried at #${hero.c.dfsIndex + 1}. ${excerpt(hero.c.text, 120)}`
    : 'Hacker News front-page threads re-ranked by substance instead of votes, updated hourly.'
  const css = `
  :root{--ivory:#FAF9F5;--paper:#FFFFFF;--slate:#141413;--g100:#F0EEE6;--g200:#E6E3DA;--g300:#D1CFC5;--g500:#87867F;--g700:#3D3D3A;
    --clay:#D97757;--clay-d:#B85C3E;--oat:#E3DACC;--olive:#788C5D;--rust:#B04A3F;--amber:#C78E3F;
    --serif:ui-serif,Georgia,"Times New Roman",Times,serif;--sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --mono:ui-monospace,"SF Mono",Menlo,Monaco,Consolas,monospace}
  *{box-sizing:border-box}html{scroll-behavior:smooth}
  body{margin:0;background:var(--ivory);color:var(--slate);font-family:var(--sans);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
  a{color:var(--clay);text-decoration-color:var(--oat);text-underline-offset:3px}a:hover{text-decoration-color:var(--clay)}
  .wrap{max-width:860px;margin:0 auto;padding:0 22px}
  .mast{padding:34px 0 6px}
  .brand{font-family:var(--serif);font-weight:500;font-size:30px;letter-spacing:-.015em}
  .brand .tri{color:var(--clay)}
  .brand .bsub{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--g500);margin-left:10px}
  .hline{color:var(--g700);font-size:15px;margin-top:8px;max-width:640px}
  .hline b{color:var(--slate)}
  .mnav{font-family:var(--mono);font-size:11.5px;color:var(--g500);margin-top:10px;display:flex;gap:16px;flex-wrap:wrap}
  .fresh{color:var(--olive)}
  .eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--g500);display:flex;align-items:center;gap:12px;margin-bottom:14px}
  .eyebrow::before{content:"";width:24px;height:1.5px;background:var(--clay)}
  .hero{margin-top:44px;background:var(--paper);border:1.5px solid var(--g300);border-radius:14px;padding:30px 34px}
  .pull{font-family:var(--serif);font-weight:500;font-size:clamp(21px,3.2vw,29px);line-height:1.3;letter-spacing:-.012em;margin:0;color:var(--slate)}
  .attrib{margin-top:14px;font-size:13.5px;color:var(--g500)}
  .attrib b{color:var(--g700)}
  .preason{color:var(--olive);font-style:italic}
  .heroactions{margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .rescuepill{font-family:var(--mono);font-size:11.5px;color:#fff;background:var(--clay);border-radius:999px;padding:3px 12px}
  .ghost{font-family:var(--mono);font-size:11px;color:var(--g500);background:none;border:1.5px solid var(--g300);border-radius:999px;padding:2px 10px;cursor:pointer;text-decoration:none}
  .ghost:hover{border-color:var(--clay);color:var(--clay)}
  .xray{margin-top:18px;background:var(--g100);border:1.5px solid var(--g300);border-radius:12px;padding:16px 20px;display:grid;grid-template-columns:240px 1fr;gap:20px;align-items:center}
  .xcols{display:grid;grid-template-columns:1fr 1fr;gap:12px;position:relative}
  .xh{font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--g500);margin-bottom:5px}
  .xrows i{display:block;height:9px;border-radius:3px;background:var(--g200);margin-bottom:4px}
  .xrows i.gem{background:var(--clay)}
  .xrows i.fight{background:repeating-linear-gradient(45deg,var(--g300),var(--g300) 3px,var(--g200) 3px,var(--g200) 6px)}
  .xrows i.dim{opacity:.45}
  .xcols svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
  .xcap{font-size:13px;color:var(--g700)}
  .xcap b{color:var(--clay-d)}
  h2{font-family:var(--serif);font-weight:500;font-size:24px;line-height:1.18;letter-spacing:-.012em;margin:0 0 4px}
  .secsub{color:var(--g500);font-size:13.5px;margin:0 0 14px}
  .rescues{margin-top:52px}
  .rlist{list-style:none;counter-reset:r;margin:0;padding:0;border:1.5px solid var(--g300);border-radius:12px;background:var(--paper);overflow:hidden}
  .ritem{counter-increment:r;padding:14px 18px 14px 52px;border-bottom:1px solid var(--g100);position:relative}
  .ritem:last-child{border-bottom:none}
  .ritem::before{content:counter(r);position:absolute;left:18px;top:15px;font-family:var(--mono);font-size:12px;color:var(--g500)}
  .rq{font-family:var(--serif);font-size:16px;line-height:1.4;color:var(--slate)}
  .rmeta{margin-top:6px;font-size:12.5px;color:var(--g500);display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
  .rmeta b{color:var(--g700)}
  .dimsep{color:var(--g300)}
  .waspill{font-family:var(--mono);font-size:10.5px;color:var(--clay-d);background:rgba(217,119,87,.13);border-radius:999px;padding:1px 8px;white-space:nowrap}
  .ractions{margin-left:auto;display:flex;gap:6px}
  .digest{margin-top:56px}
  .story{background:var(--paper);border:1.5px solid var(--g300);border-radius:12px;padding:18px 20px;margin:0 0 16px}
  .shead{display:flex;gap:12px;align-items:flex-start;padding-bottom:10px;border-bottom:1px solid var(--g100)}
  .srank{font-family:var(--mono);font-size:12px;color:var(--g500);min-width:20px;text-align:right;padding-top:4px}
  .stitle a{font-family:var(--serif);font-size:18px;font-weight:500;letter-spacing:-.008em;color:var(--slate);text-decoration:none}
  .stitle a:hover{color:var(--clay-d)}
  .domain{color:var(--g500);font-size:12px;margin-left:7px;font-family:var(--mono)}
  .smeta{font-family:var(--mono);font-size:11px;color:var(--g500);margin-top:4px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .hotpill{font-family:var(--mono);font-size:10px;color:var(--rust);background:rgba(176,74,63,.12);border-radius:999px;padding:1px 8px}
  .hnlink{font-size:11px}
  .prior{font-family:var(--mono);font-size:10.5px;color:var(--amber);background:rgba(199,142,63,.1);border-radius:8px;padding:4px 9px;margin-top:7px;line-height:1.7}
  .prior a{font-size:10.5px;color:var(--amber)}
  .lane{margin-top:10px}
  .lanelabel{font-family:var(--mono);font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--olive);margin-bottom:4px}
  .comment{padding:10px 0;border-top:1px dashed var(--g200)}
  .comment:first-of-type{border-top:none}
  .cmeta{font-size:12.5px;color:var(--g500);margin-bottom:4px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
  .author{color:var(--g700)}
  .permalink{margin-left:auto;color:var(--g500);font-size:13px;text-decoration:none}
  .ctext{font-size:14px;color:var(--g700);overflow-wrap:break-word}.ctext p{margin:.5em 0}
  .ctext pre{background:var(--g100);padding:8px 10px;border-radius:8px;overflow:auto;font-size:12.5px;font-family:var(--mono)}
  details.ctext summary{cursor:pointer}details.ctext .full{margin-top:6px}
  details.more{margin-top:8px}
  details.more summary{cursor:pointer;font-family:var(--mono);font-size:11.5px;color:var(--g500)}
  details.more summary:hover{color:var(--clay)}
  .fold{margin-top:12px}
  .fold summary{cursor:pointer;font-family:var(--mono);font-size:11.5px;color:var(--g500);background:var(--g100);border:1.5px solid var(--g200);border-radius:8px;padding:5px 10px;display:inline-block}
  .foldnote{font-size:12.5px;color:var(--g500);padding:8px 4px 2px}
  .ordinary{font-size:12px;color:var(--g500);margin-top:8px}
  footer{margin:70px 0 0;padding:18px 0 90px;border-top:1px solid var(--g200);font-family:var(--mono);font-size:11px;color:var(--g500);line-height:2}
  @media (max-width:680px){
    .xray{grid-template-columns:1fr}
    .hero{padding:22px 20px}
    .ractions{margin-left:0}
    .mast{padding-top:24px}
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
  <div class="wrap">
  <header class="mast">
    <div class="brand"><span class="tri">▲</span> Slow Rank<span class="bsub">for Hacker News</span></div>
    <div class="hline"><b>${stats.comments.toLocaleString()}</b> comments across <b>${stats.stories}</b> front-page stories, read so you don't have to. The substance floats; the fight folds.</div>
    <div class="mnav">
      <span class="fresh" id="fresh" data-t="${now.toISOString()}">updates hourly</span>
      <a href="${REPO}#how-it-scores">how scoring works</a>
      <a href="${REPO}/tree/main/extension">browser extension</a>
      <a href="${REPO}">source</a>
    </div>
  </header>
  ${renderHero(hero, dateStr)}
  ${renderXray(hero)}
  ${renderRescueList(rescues)}
  <section class="digest">
    <h2>The full front page, story by story</h2>
    <p class="secsub">Every thread's top comments by substance — each with where votes had it and why it floated. ${stats.flagged.toLocaleString()} low-signal comments folded across ${stats.hot} hot threads.</p>
    ${stories.map(renderStory).join('')}
  </section>
  <footer>
    zero participation · read-only over HN's public Firebase + Algolia APIs · scoring is transparent heuristics, not a black box —
    <a href="${REPO}#how-it-scores">how it works</a> · weights cross-checked against blind pairwise judgments (81% held-out agreement,
    <a href="${REPO}/blob/main/calibration/REPORT.md">report</a>) · generated ${now.toISOString()} · <a href="${REPO}">github</a>
  </footer>
  </div>
  <script>
  (function(){
    var el = document.getElementById('fresh')
    if (el && el.dataset.t) {
      var m = Math.round((Date.now() - new Date(el.dataset.t).getTime()) / 60000)
      el.textContent = m < 1 ? 'updated just now' : m < 120 ? 'updated ' + m + ' min ago' : 'updated ' + Math.round(m / 60) + ' h ago'
      el.textContent += ' · refreshes hourly'
    }
    document.querySelectorAll('[data-copy]').forEach(function(b){
      b.addEventListener('click', function(){
        var url = location.origin + location.pathname + '#' + b.dataset.copy
        navigator.clipboard.writeText(url).then(function(){
          var t = b.textContent; b.textContent = 'copied ✓'
          setTimeout(function(){ b.textContent = t }, 1500)
        })
      })
    })
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
  const quote = hero ? excerpt(hero.c.text, 200) : 'The comment worth reading, surfaced.'
  const lines = wrapLines(quote, 44, 4)
  const attrib = hero ? `${hero.c.author} · on “${excerpt(hero.s.title, 48)}”` : ''
  const pill = hero ? `▲ rescued from #${hero.c.dfsIndex + 1} by votes` : '▲ re-ranked by substance, not votes'
  const quoteLines = lines.map((l, i) =>
    `<text x="90" y="${238 + i * 62}" font-family="Georgia, serif" font-size="44" fill="#141413">${escapeXml(l)}</text>`).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#FAF9F5"/>
  <rect x="0" y="0" width="1200" height="8" fill="#D97757"/>
  <text x="90" y="120" font-family="Menlo, monospace" font-size="22" letter-spacing="4" fill="#87867F">SLOW RANK · TODAY'S RESCUE</text>
  <text x="90" y="180" font-family="Georgia, serif" font-size="60" fill="#D97757">&#8220;</text>
  ${quoteLines}
  <text x="90" y="${238 + lines.length * 62 + 20}" font-family="Menlo, monospace" font-size="22" fill="#87867F">${escapeXml(attrib)}</text>
  <rect x="86" y="${238 + lines.length * 62 + 48}" rx="22" width="${pill.length * 13 + 40}" height="44" fill="#D97757"/>
  <text x="106" y="${238 + lines.length * 62 + 77}" font-family="Menlo, monospace" font-size="22" fill="#FFFFFF">${escapeXml(pill)}</text>
  <text x="90" y="585" font-family="Menlo, monospace" font-size="18" fill="#87867F">${escapeXml(`${(stats.comments || 0).toLocaleString()} comments read · scasella.github.io/hn-slow-rank`)}</text>
  </svg>`
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

  process.stderr.write(`\nDone. ${stats.stories} stories · ${stats.comments} comments analyzed · ${stats.surfaced} surfaced · ${stats.flagged} hidden as low-signal · ${stats.hot} hot threads · ${stats.priorArt} with prior art\n`)
  process.stderr.write('Wrote ' + OUT + ' (+ og.svg)\n')
  console.log(JSON.stringify({ ...stats, generatedAt: new Date().toISOString() }))
})().catch((e) => { console.error('FATAL', e); process.exit(1) })
