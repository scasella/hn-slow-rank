#!/usr/bin/env node
// Hot Thread Slow Rank — MVP
// Surface the comment worth reading, hide the fight.
// Zero-participation: pure read-only over HN's public Firebase + Algolia APIs.
//
//   node rerank.js [topStories=24] [perStory=6]
//
// Writes frontpage-reranked.html (self-contained, offline).

const TOP_N = parseInt(process.argv[2] || '24', 10)
const PER_STORY = parseInt(process.argv[3] || '6', 10)
const CONCURRENCY = 6

// ---------------------------------------------------------------------------
// tiny utils
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'hot-thread-slow-rank/0.1 (read-only)' } })
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

const ENT = { '&#x27;': "'", '&#x2F;': '/', '&gt;': '>', '&lt;': '<', '&quot;': '"', '&amp;': '&', '&#x60;': '`', '&#x3D;': '=' }
function decode(s) {
  return String(s || '').replace(/&#x27;|&#x2F;|&gt;|&lt;|&quot;|&amp;|&#x60;|&#x3D;/g, (m) => ENT[m] || m)
}
function stripTags(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}
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
function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}
function ageStr(createdSec) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - createdSec)
  const h = Math.floor(s / 3600)
  if (h < 1) return Math.floor(s / 60) + 'm'
  if (h < 24) return h + 'h'
  return Math.floor(h / 24) + 'd'
}

// ---------------------------------------------------------------------------
// flatten Algolia tree -> comment list with depth, parent, DFS index
// ---------------------------------------------------------------------------
function flatten(story) {
  const list = []
  const byId = new Map()
  let dfs = 0
  function walk(node, depth, parent) {
    if (!node) return
    if (node.id !== story.id) {
      const c = {
        id: node.id,
        author: node.author || null,
        textHtml: node.text || '',
        text: stripTags(node.text || ''),
        created: node.created_at_i || 0,
        points: node.points, // often null for comments — we deliberately ignore for ranking
        depth,
        parent,
        dfsIndex: dfs++, // order HN would display ≈ by-vote/recency position
        children: [],
        distinctRepliers: 0,
        flags: {},
      }
      list.push(c)
      byId.set(c.id, c)
      if (parent && byId.get(parent)) byId.get(parent).children.push(c.id)
      var nextParent = c.id
      var nextDepth = depth + 1
    } else {
      var nextParent = null
      var nextDepth = 0
    }
    for (const k of node.children || []) walk(k, nextDepth, nextParent)
  }
  walk(story, 0, null)

  // distinct repliers in each comment's subtree (genuine discussion signal)
  for (const c of list) {
    const seen = new Set()
    const stack = [...c.children]
    while (stack.length) {
      const k = byId.get(stack.pop())
      if (!k) continue
      if (k.author && k.author !== c.author) seen.add(k.author)
      for (const g of k.children) stack.push(g)
    }
    c.distinctRepliers = seen.size
  }

  // duel detection: longest ancestor suffix that strictly alternates between 2 authors
  const authorOf = (id) => (byId.get(id) ? byId.get(id).author : null)
  for (const c of list) {
    const chain = []
    let cur = c.id
    while (cur && byId.has(cur)) { chain.push(authorOf(cur)); cur = byId.get(cur).parent }
    chain.reverse() // root..self
    // find longest alternating-2-author suffix ending at self
    let best = 1
    for (let start = chain.length - 1; start >= 0; start--) {
      const seg = chain.slice(start)
      const uniq = [...new Set(seg.filter(Boolean))]
      if (uniq.length !== 2) continue
      let alt = true
      for (let i = 1; i < seg.length; i++) if (!seg[i] || seg[i] === seg[i - 1]) { alt = false; break }
      if (alt) best = Math.max(best, seg.length)
    }
    c.flags.duel = best >= 4
  }
  return list
}

// ---------------------------------------------------------------------------
// substance scoring — additive, every point carries a reason badge
// ---------------------------------------------------------------------------
const FIRSTHAND = [
  /\bI(?:'ve| have)? (?:work(?:ed)?|built|wrote|made|maintain|created|implemented|designed|run|ran|founded|led|shipped|deployed)\b/i,
  /\bI(?:'m| am) (?:the|one of the|a) (?:author|maintainer|creator|dev|developer|engineer)\b/i,
  /\bwe (?:built|wrote|found|shipped|run|ran|maintain|deployed)\b/i,
  /\bin my experience\b/i,
  /\b(?:full )?disclosure[:,]/i,
  /\bI work (?:at|on|for)\b/i,
  /\bI was (?:there|involved|on the team)\b/i,
  /\bsource[:,]\s/i,
]
const DUNK = /\b(?:lol|lmao|rofl|cope|seethe|ratio'?d?|found the \w+|cool story|ok\b|sure\b|nailed it|exactly this|came here to say|this\.?$|\^+\s*this|\+1\b|big if true|tell me you|the absolute state)\b/i
const TOXIC = /\b(?:idiot|moron|stupid|clown|shill|fanboy|cope|delusional|braindead|garbage take|trash|dumb)\b/i
const DIDNT_READ = /\b(?:didn'?t (?:read|rtfa)|did not read|read the (?:article|paper)|clickbait|misleading title|the title says)\b/i

function extractLinks(html) {
  const out = []
  const re = /href="([^"]+)"/gi
  let m
  while ((m = re.exec(html))) {
    const u = decode(m[1])
    const d = domainOf(u)
    if (d && d !== 'news.ycombinator.com') out.push(d)
  }
  return out
}
const PRIMARY = /(github\.com|gitlab\.com|arxiv\.org|\.gov$|\.gov\/|datatracker\.ietf\.org|rfc-editor\.org|doi\.org|ncbi\.nlm\.nih\.gov|pubmed|docs\.|developer\.|wikipedia\.org|patents\.google)/i

function scoreComment(c) {
  const badges = []
  const reasons = []
  let score = 0
  const t = c.text
  const words = t ? t.split(/\s+/).length : 0

  // negatives first (they gate the lane)
  if (c.flags.duel) { score -= 4; c.flags.downweight = true; reasons.push('part of a back-and-forth duel') }
  const isShort = words < 12
  if (DUNK.test(t) && words < 30) { score -= 3; c.flags.downweight = true; reasons.push('dunk / low-content snark') }
  if (TOXIC.test(t)) { score -= 3; c.flags.downweight = true; reasons.push('name-calling / toxicity') }
  if (DIDNT_READ.test(t) && words < 40) { score -= 1.5; reasons.push('“didn’t read” / title complaint') }
  if (isShort && score <= 0) { score -= 2; c.flags.downweight = true; reasons.push('very short, no substance') }
  if (/!{2,}/.test(t) || (t.length > 24 && t === t.toUpperCase() && /[A-Z]{6,}/.test(t))) { score -= 1.5; reasons.push('shouting') }

  // positives
  const links = extractLinks(c.textHtml)
  if (links.length) {
    const isPrimary = links.some((d) => PRIMARY.test(d))
    score += Math.min(links.length, 2) * 2 + (isPrimary ? 1 : 0)
    badges.push({ icon: '🔗', label: 'source' })
    reasons.push((isPrimary ? 'cites a primary source (' : 'links out (') + links.slice(0, 2).join(', ') + ')')
  }
  if (/<pre>|<code>/.test(c.textHtml) || /(^|\n)\s*(\$ |npm |pip |git |sudo |curl |def |function |const |import |SELECT )/.test(t)) {
    score += 3; badges.push({ icon: '⟨/⟩', label: 'code' }); reasons.push('includes code / a command')
  }
  if (FIRSTHAND.some((re) => re.test(t))) {
    score += 3; badges.push({ icon: '✋', label: 'firsthand' }); reasons.push('firsthand / disclosed experience')
  }
  const nums = (t.match(/\b\d[\d.,]*\s?(?:%|x|ms|s|gb|mb|kb|tb|k|m|b|fps|hz|w|kw|nm|°|years?|months?|days?|hours?|x)\b/gi) || []).length
  const versions = (t.match(/\bv?\d+\.\d+(\.\d+)?\b/g) || []).length
  if (nums + versions >= 2) { score += Math.min(2, 1 + Math.floor((nums + versions) / 3)); badges.push({ icon: '📊', label: 'specifics' }); reasons.push('quantified / specific') }

  const paras = (c.textHtml.match(/<p>/g) || []).length + 1
  if (words >= 60 && words <= 450 && paras >= 2) { score += 2; reasons.push('structured, substantive length') }
  else if (words >= 40 && words <= 450) { score += 1 }
  if (words > 700) { score -= 1; reasons.push('very long (wall of text)') }

  if (c.distinctRepliers >= 3 && !c.flags.duel) {
    score += Math.min(2, c.distinctRepliers * 0.5); badges.push({ icon: '💬', label: 'sparked discussion' })
    reasons.push(c.distinctRepliers + ' distinct people engaged')
  }
  // genuine question that invites expertise
  if (/\?/.test(t) && words >= 15 && words <= 80 && links.length === 0 && !c.flags.duel) { score += 0.5 }

  c.score = Math.round(score * 10) / 10
  c.badges = badges
  c.reasons = reasons
  return c
}

// ---------------------------------------------------------------------------
// per-story processing
// ---------------------------------------------------------------------------
function processStory(item, rank) {
  const story = item.algolia
  const meta = item.fb
  if (!story || !Array.isArray(story.children)) return null
  const comments = flatten(story).filter((c) => c.author && c.text) // drop dead/deleted
  if (!comments.length) return null
  comments.forEach(scoreComment)

  const duelCount = comments.filter((c) => c.flags.duel).length
  const duelRatio = duelCount / comments.length
  const hot = duelCount >= 6 || duelRatio >= 0.18

  const threshold = hot ? 3.5 : 2.5
  const ranked = [...comments].sort((a, b) => b.score - a.score)
  let surfaced = ranked.filter((c) => c.score >= threshold && !c.flags.duel).slice(0, PER_STORY)
  if (surfaced.length < 3) surfaced = ranked.filter((c) => !c.flags.duel).slice(0, Math.min(3, comments.length))
  const surfacedIds = new Set(surfaced.map((c) => c.id))
  // honest accounting: only flagged comments (duel/dunk/low/toxic) are "hidden as
  // low-signal" — the fight. Everything else not surfaced is just ordinary on-topic
  // comment that didn't make the top lane (still one click away on HN).
  const flagged = comments.filter((c) => !surfacedIds.has(c.id) && c.flags.downweight)
  const ordinary = comments.filter((c) => !surfacedIds.has(c.id) && !c.flags.downweight)

  return {
    rank,
    id: story.id,
    title: meta.title || story.title,
    url: meta.url || story.url || ('https://news.ycombinator.com/item?id=' + story.id),
    domain: domainOf(meta.url || story.url || '') || 'news.ycombinator.com',
    points: meta.score ?? story.points ?? 0,
    nComments: comments.length,
    age: ageStr(meta.time || story.created_at_i || 0),
    hot,
    duelCount,
    flaggedCount: flagged.length,
    ordinaryCount: ordinary.length,
    surfaced,
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
    <div class="tag">Surface the comment worth reading, hide the fight. — front page of ${now.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })}</div>
    <div class="stats">
      <span><b>${stats.stories}</b> stories</span>
      <span><b>${stats.comments.toLocaleString()}</b> comments analyzed</span>
      <span><b>${stats.surfaced}</b> surfaced</span>
      <span><b>${stats.flagged.toLocaleString()}</b> hidden as low-signal</span>
      <span><b>${stats.hot}</b> hot threads</span>
    </div>
    <div class="legend">
      <span>🔗 source</span><span>⟨/⟩ code</span><span>✋ firsthand</span><span>📊 specifics</span><span>💬 discussion</span><span>🥊 duel → folded</span>
    </div>
  </div></header>
  <main class="wrap">${stories.map(renderStory).join('')}</main>
  <footer>Zero participation · built from HN's public Firebase + Algolia APIs · comments re-ranked by transparent substance heuristics, not votes. Generated ${now.toISOString()}.</footer>
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
  // re-number by surviving order (front-page order preserved)
  stories.forEach((s, i) => (s.rank = i + 1))

  const stats = {
    stories: stories.length,
    comments: stories.reduce((a, s) => a + s.nComments, 0),
    surfaced: stories.reduce((a, s) => a + s.surfaced.length, 0),
    flagged: stories.reduce((a, s) => a + s.flaggedCount, 0),
    hot: stories.filter((s) => s.hot).length,
  }

  const fs = require('fs')
  fs.writeFileSync('frontpage-reranked.html', renderPage(stories, stats))
  process.stderr.write(`\nDone. ${stats.stories} stories · ${stats.comments} comments analyzed · ${stats.surfaced} surfaced · ${stats.flagged} hidden as low-signal · ${stats.hot} hot threads\n`)
  process.stderr.write('Wrote frontpage-reranked.html\n')
  // also emit compact JSON stats to stdout
  console.log(JSON.stringify({ ...stats, generatedAt: new Date().toISOString(), topExamples: stories.slice(0, 5).map((s) => ({ title: s.title, hot: s.hot, surfaced: s.surfaced.length, flagged: s.flaggedCount, ordinary: s.ordinaryCount, top: s.surfaced[0] && { author: s.surfaced[0].author, score: s.surfaced[0].score, wasPosition: s.surfaced[0].dfsIndex + 1, badges: s.surfaced[0].badges.map((b) => b.label) } })) }, null, 2))
})().catch((e) => { console.error('FATAL', e); process.exit(1) })
