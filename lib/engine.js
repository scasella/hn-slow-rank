// Hot Thread Slow Rank — shared substance-scoring engine.
// Runs in Node (module.exports) and the browser (window.SlowRank).
// Scoring is a dot product over an explicit feature vector so weights can be
// hand-set (DEFAULT_WEIGHTS) or fitted from labeled data (see calibration/).
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.SlowRank = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  const ENT = { '&#x27;': "'", '&#x2F;': '/', '&gt;': '>', '&lt;': '<', '&quot;': '"', '&amp;': '&', '&#x60;': '`', '&#x3D;': '=' }
  function decode(s) {
    return String(s || '').replace(/&#x27;|&#x2F;|&gt;|&lt;|&quot;|&amp;|&#x60;|&#x3D;/g, (m) => ENT[m] || m)
  }
  function stripTags(html) {
    return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
  }
  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
  }
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
  const PRIMARY = /(github\.com|gitlab\.com|arxiv\.org|\.gov$|\.gov\/|datatracker\.ietf\.org|rfc-editor\.org|doi\.org|ncbi\.nlm\.nih\.gov|pubmed|docs\.|developer\.|wikipedia\.org|patents\.google)/i
  const CODE = /(^|\n)\s*(\$ |npm |pip |git |sudo |curl |def |function |const |import |SELECT )/

  // Every signal the score is built from. Feature values are small non-negative
  // numbers (mostly 0/1); the sign lives in the weight.
  const FEATURE_NAMES = [
    'duel', 'dunk', 'toxic', 'didntRead', 'lowEffort', 'shouting', 'wall',
    'links', 'primary', 'code', 'firsthand', 'specifics', 'structured', 'midLength',
    'discussion', 'question',
  ]

  // Hand-set v1 weights (ordinal judgment, see SPEC.md). Reproduces the MVP scoring.
  const DEFAULT_WEIGHTS = {
    duel: -4, dunk: -3, toxic: -3, didntRead: -1.5, lowEffort: -2, shouting: -1.5, wall: -1,
    links: 2, primary: 1, code: 3, firsthand: 3, specifics: 1, structured: 2, midLength: 1,
    discussion: 1, question: 0.5,
  }

  // flatten Algolia-shaped tree -> comment list with depth, parent, DFS index,
  // distinct-replier counts, and duel flags. `story` needs {id, children[]} where
  // each node has {id, author, text, created_at_i, children}.
  function flatten(story) {
    const list = []
    const byId = new Map()
    let dfs = 0
    function walk(node, depth, parent) {
      if (!node) return
      let nextParent, nextDepth
      if (node.id !== story.id) {
        const c = {
          id: node.id,
          author: node.author || null,
          textHtml: node.text || '',
          text: stripTags(node.text || ''),
          created: node.created_at_i || 0,
          points: node.points,
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
        nextParent = c.id
        nextDepth = depth + 1
      } else {
        nextParent = null
        nextDepth = 0
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

    // duel detection: longest ancestor suffix strictly alternating between 2 authors
    const authorOf = (id) => (byId.get(id) ? byId.get(id).author : null)
    for (const c of list) {
      const chain = []
      let cur = c.id
      while (cur && byId.has(cur)) { chain.push(authorOf(cur)); cur = byId.get(cur).parent }
      chain.reverse()
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

  // Extract the feature vector for one flattened comment.
  function featurize(c) {
    const t = c.text
    const words = t ? t.split(/\s+/).length : 0
    const links = extractLinks(c.textHtml)
    const hasCode = /<pre>|<code>/.test(c.textHtml) || CODE.test(t)
    const firsthand = FIRSTHAND.some((re) => re.test(t))
    const nums = (t.match(/\b\d[\d.,]*\s?(?:%|x|ms|s|gb|mb|kb|tb|k|m|b|fps|hz|w|kw|nm|°|years?|months?|days?|hours?)\b/gi) || []).length
    const versions = (t.match(/\bv?\d+\.\d+(\.\d+)?\b/g) || []).length
    const paras = (c.textHtml.match(/<p>/g) || []).length + 1
    const structured = words >= 60 && words <= 450 && paras >= 2

    const f = {
      duel: c.flags.duel ? 1 : 0,
      dunk: DUNK.test(t) && words < 30 ? 1 : 0,
      toxic: TOXIC.test(t) ? 1 : 0,
      didntRead: DIDNT_READ.test(t) && words < 40 ? 1 : 0,
      lowEffort: words < 12 && !links.length && !hasCode && !firsthand ? 1 : 0,
      shouting: /!{2,}/.test(t) || (t.length > 24 && t === t.toUpperCase() && /[A-Z]{6,}/.test(t)) ? 1 : 0,
      wall: words > 700 ? 1 : 0,
      links: Math.min(links.length, 2),
      primary: links.some((d) => PRIMARY.test(d)) ? 1 : 0,
      code: hasCode ? 1 : 0,
      firsthand: firsthand ? 1 : 0,
      specifics: nums + versions >= 2 ? Math.min(2, 1 + Math.floor((nums + versions) / 3)) : 0,
      structured: structured ? 1 : 0,
      midLength: !structured && words >= 40 && words <= 450 ? 1 : 0,
      discussion: c.distinctRepliers >= 3 && !c.flags.duel ? Math.min(2, c.distinctRepliers * 0.5) : 0,
      question: /\?/.test(t) && words >= 15 && words <= 80 && !links.length && !c.flags.duel ? 1 : 0,
    }
    f._links = links // for badge text, not a scored feature
    return f
  }

  // Score one comment in place: sets c.features, c.score, c.badges, c.reasons,
  // c.flags.downweight. Pass custom weights to use calibrated values.
  function scoreComment(c, weights) {
    const W = weights || DEFAULT_WEIGHTS
    const f = featurize(c)
    let score = 0
    for (const k of FEATURE_NAMES) score += (W[k] || 0) * (f[k] || 0)

    const badges = []
    const reasons = []
    if (f.duel) { c.flags.downweight = true; reasons.push('part of a back-and-forth duel') }
    if (f.dunk) { c.flags.downweight = true; reasons.push('dunk / low-content snark') }
    if (f.toxic) { c.flags.downweight = true; reasons.push('name-calling / toxicity') }
    if (f.didntRead) reasons.push('“didn’t read” / title complaint')
    if (f.lowEffort) { c.flags.downweight = true; reasons.push('very short, no substance') }
    if (f.shouting) reasons.push('shouting')
    if (f.links) {
      badges.push({ icon: '🔗', label: 'source' })
      reasons.push((f.primary ? 'cites a primary source (' : 'links out (') + f._links.slice(0, 2).join(', ') + ')')
    }
    if (f.code) { badges.push({ icon: '⟨/⟩', label: 'code' }); reasons.push('includes code / a command') }
    if (f.firsthand) { badges.push({ icon: '✋', label: 'firsthand' }); reasons.push('firsthand / disclosed experience') }
    if (f.specifics) { badges.push({ icon: '📊', label: 'specifics' }); reasons.push('quantified / specific') }
    if (f.structured) reasons.push('structured, substantive length')
    if (f.wall) reasons.push('very long (wall of text)')
    if (f.discussion) { badges.push({ icon: '💬', label: 'sparked discussion' }); reasons.push(c.distinctRepliers + ' distinct people engaged') }

    delete f._links
    c.features = f
    c.score = Math.round(score * 10) / 10
    c.badges = badges
    c.reasons = reasons
    return c
  }

  // Thread-level analysis: scores every comment, detects hot mode, splits into
  // surfaced / flagged / ordinary. Pure — no rendering, no fetching.
  function analyzeThread(story, opts) {
    const o = opts || {}
    const perStory = o.perStory || 6
    const weights = o.weights || DEFAULT_WEIGHTS
    const comments = flatten(story).filter((c) => c.author && c.text)
    if (!comments.length) return null
    comments.forEach((c) => scoreComment(c, weights))

    const duelCount = comments.filter((c) => c.flags.duel).length
    const duelRatio = duelCount / comments.length
    const hot = duelCount >= 6 || duelRatio >= 0.18

    const threshold = o.threshold != null ? o.threshold : (hot ? 3.5 : 2.5)
    const ranked = [...comments].sort((a, b) => b.score - a.score)
    let surfaced = ranked.filter((c) => c.score >= threshold && !c.flags.duel).slice(0, perStory)
    if (surfaced.length < 3) surfaced = ranked.filter((c) => !c.flags.duel).slice(0, Math.min(3, comments.length))
    const surfacedIds = new Set(surfaced.map((c) => c.id))
    const flagged = comments.filter((c) => !surfacedIds.has(c.id) && c.flags.downweight)
    const ordinary = comments.filter((c) => !surfacedIds.has(c.id) && !c.flags.downweight)

    return { comments, surfaced, flagged, ordinary, hot, duelCount, duelRatio }
  }

  return {
    decode, stripTags, domainOf, extractLinks,
    flatten, featurize, scoreComment, analyzeThread,
    FEATURE_NAMES, DEFAULT_WEIGHTS,
  }
})
