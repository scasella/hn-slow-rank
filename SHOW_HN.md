# Show HN draft (post this yourself — title + text below)

**Title:**

Show HN: HN's front page with every thread reranked by substance, not votes

**URL:** https://scasella.github.io/hn-slow-rank/

**Text:**

HN ranks comments by votes and recency, so the witty dunk wins and the person
who actually knows — the maintainer, the primary source, the comment with the
benchmark numbers — is often buried. This page re-ranks every front-page
thread by substance instead. It regenerates hourly, read-only over the public
Firebase + Algolia APIs.

What it looks for: primary-source links, code, firsthand markers ("I built /
I maintain / disclosure:"), concrete specifics, and replies from several
distinct people. What it folds: two-author flamewar duels, dunks, and
low-effort one-liners. Every surfaced comment shows *why* it floated and where
votes had it (e.g. "was #246 → surfaced") — the scoring is deliberately legible
heuristics, not a black box, so you can disagree on the spot.

Two things I'd love feedback on:

1. The weights started as hand-picked taste; I then fitted them against
   LLM-judged pairwise labels (Bradley–Terry on feature diffs) — report in the
   repo. If you see a floated comment that doesn't deserve it, that's exactly
   the failure case I want.
2. There's a browser extension in the repo that does the same thing in place
   on news.ycombinator.com threads.

This thread will, of course, rerank itself on the next hourly run.

Repo: https://github.com/scasella/hn-slow-rank

---

*Posting notes (not part of the post): post on a weekday morning US-time;
"Show HN" requires something people can try, which the live page satisfies.
The self-referential hook (the thread reranking itself) is the line people
will quote — consider replying with the direct link to the reranked Show HN
thread once the next cron run includes it.*
