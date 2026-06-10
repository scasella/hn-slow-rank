// Hot Thread Slow Rank — content script for news.ycombinator.com/item pages.
// Fetches the thread's public Algolia JSON, scores every comment with the
// shared engine (engine.js -> window.SlowRank), then:
//   1. injects a "Worth reading" lane above the comment tree, and
//   2. dims low-signal comments (duels/dunks/toxic/low-effort) in place.
// Zero participation: read-only, nothing is sent anywhere.

;(async function () {
  const id = new URLSearchParams(location.search).get('id')
  if (!id) return
  const tree = document.querySelector('table.comment-tree')
  if (!tree || document.getElementById('srk-lane')) return

  let story
  try {
    const res = await fetch('https://hn.algolia.com/api/v1/items/' + id)
    if (!res.ok) return
    story = await res.json()
  } catch { return }
  if (!story || !Array.isArray(story.children) || !story.children.length) return

  const analysis = SlowRank.analyzeThread(story, { perStory: 8 })
  if (!analysis || !analysis.surfaced.length) return

  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  // --- dim the fight in place -------------------------------------------
  const flaggedIds = analysis.comments.filter((c) => c.flags.downweight).map((c) => String(c.id))
  function setDim(on) {
    for (const fid of flaggedIds) {
      const row = document.getElementById(fid)
      if (row && row.classList.contains('comtr')) row.classList.toggle('srk-dim', on)
    }
    localStorage.setItem('srk-dim', on ? '1' : '0')
  }
  const dimOn = localStorage.getItem('srk-dim') !== '0'

  // --- worth-reading lane -------------------------------------------------
  function jump(cid) {
    const row = document.getElementById(String(cid))
    if (!row) return
    row.classList.remove('srk-dim')
    row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    row.classList.add('srk-flash')
    setTimeout(() => row.classList.remove('srk-flash'), 2200)
  }

  const lane = document.createElement('div')
  lane.id = 'srk-lane'
  const hot = analysis.hot ? `<span class="srk-hot">🔥 hot thread — ${analysis.duelCount} comments in duels, combat down-weighted</span>` : ''
  const rows = analysis.surfaced.map((c) => {
    const badges = c.badges.map((b) => `<span class="srk-badge">${b.icon} ${esc(b.label)}</span>`).join('')
    const moved = c.dfsIndex >= 3 ? `<span class="srk-moved">was #${c.dfsIndex + 1}</span>` : ''
    const why = c.reasons.length ? esc(c.reasons.slice(0, 2).join(' · ')) : ''
    const snippet = esc(c.text.length > 260 ? c.text.slice(0, 260) + '…' : c.text)
    return `<div class="srk-item" data-cid="${c.id}" title="${why}">
      <span class="srk-score">${c.score}</span>
      <span class="srk-author">${esc(c.author)}</span>${badges}${moved}
      <div class="srk-snippet">${snippet}</div>
    </div>`
  }).join('')
  lane.innerHTML = `
    <div class="srk-head">
      <span class="srk-title">▲ Worth reading <span class="srk-sub">(${analysis.surfaced.length} of ${analysis.comments.length} comments, ranked by substance, not votes)</span></span>
      ${hot}
      <label class="srk-toggle"><input type="checkbox" id="srk-dimtoggle" ${dimOn ? 'checked' : ''}> dim low-signal (${flaggedIds.length})</label>
    </div>
    ${rows}`
  tree.parentNode.insertBefore(lane, tree)

  lane.querySelectorAll('.srk-item').forEach((el) => el.addEventListener('click', () => jump(el.dataset.cid)))
  document.getElementById('srk-dimtoggle').addEventListener('change', (e) => setDim(e.target.checked))
  setDim(dimOn)
})()
