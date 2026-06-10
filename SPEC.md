# Hot Thread Slow Rank — MVP spec

**Tagline:** Surface the comment worth reading, hide the fight.

**Thesis:** HN ranks comments by votes + recency, so the witty dunk wins and the
person who *actually knows* (primary source, firsthand experience, code) is buried.
This tool re-ranks every front-page thread by **substance**, with zero new user
participation — pure read-only over public APIs.

## Data sources (no auth, no participation)
- `https://hacker-news.firebaseio.com/v0/topstories.json` — live front-page order (≈500 ids).
- `https://hn.algolia.com/api/v1/items/<id>` — a story's full nested comment tree in one call
  (author, text, created_at_i, points, children, parent_id).

Not available externally (so deliberately unused): per-user read behavior, flag counts,
HN's private penalty ledger.

## Substance scoring (transparent, additive — every point carries a reason)
Float UP:
- 🔗 **primary source** — external link(s); bonus for github/arxiv/docs/*.gov/RFC.
- `⟨/⟩` **code** — `<pre>/<code>` block or shell-like lines.
- ✋ **firsthand** — "I built/wrote/maintain/work on…", "disclosure:", "I was there".
- 📊 **specifics** — numbers, versions, units, dates, citations.
- **depth** — multi-paragraph, in a 60–450-word sweet spot (walls slightly penalized).
- 💬 **sparked discussion** — replies from ≥3 *distinct* authors (genuine, not a duel).

Sink / FOLD:
- 🥊 **duel** — same two authors alternating ≥4 deep (flamewar back-and-forth).
- **dunk** — short + snark/dismissal lexicon ("lol", "found the…", "ratio", "this.").
- **low-effort** — <12 words, no link/code/firsthand.
- **didn't read** / off-topic title complaints.
- **toxic** — name-calling, ALL-CAPS shouting, exclamation spam.

## Thread "hot mode"
A story is HOT when `duelComments ≥ 6` or `duelRatio ≥ 0.18`. In hot mode the fold is
more aggressive and firsthand/source comments are explicitly floated above the fight.

## Output
`frontpage-reranked.html` — self-contained, offline. Per story:
- header (rank, title, domain, points, comment count, age, HOT badge),
- **▲ Worth reading** lane: top substantive comments, each with badges, a one-line
  *why floated*, and its original by-vote DFS position ("was #34 → surfaced"),
- collapsed **🥊 down-weighted** count (duels + low-signal), expandable.

## Run
```
node rerank.js [topStories=24] [perStory=6]
```

## Next step beyond MVP
The scoring engine (`scoreComment`) is render-target-agnostic. Wrap it in a browser
extension content-script to re-render live news.ycombinator.com threads in place; the
same engine generalizes to any comment platform (Reddit/YouTube/news) as the wedge.
