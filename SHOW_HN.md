# Show HN draft (post this yourself — title + text below)

**Submit at:** https://news.ycombinator.com/submit

**Title:**

Show HN: HN's front page with every comment thread reranked by substance

**URL:** https://scasella.github.io/hn-slow-rank/

**Text:**

HN ranks comments by votes and recency, so the witty dunk wins and the person
who actually knows — the maintainer, the primary source, the comment with the
benchmark numbers — is often buried. This page re-ranks every front-page
thread by substance instead, hourly, read-only over the public Firebase +
Algolia APIs.

It leads with the day's best "rescue." Today's: a comment votes had at
position #1,265 in a 1,300-comment thread, surfaced to #1 because it brought
firsthand experience, sources, and numbers. Every surfaced comment shows why
it floated and where votes had it — the scoring is deliberately legible
heuristics (sources, code, firsthand markers, specifics, real discussion),
not a black box, so you can disagree on the spot.

Things you might poke at:

1. The weights started as hand-picked taste; I then fitted them against
   LLM-judged pairwise labels (Bradley–Terry on feature diffs — 81% held-out
   agreement vs 67% for my hand weights; report in the repo). If a floated
   comment doesn't deserve it, that's exactly the failure case I want to hear
   about.
2. There's a browser extension in the repo that re-ranks live
   news.ycombinator.com threads in place, and a lobste.rs adapter as proof the
   engine isn't HN-specific.
3. There's an RSS feed of the daily rescues if you want them pushed.

This thread will, of course, rerank itself on the next hourly run.

Repo: https://github.com/scasella/hn-slow-rank

---

*Posting notes (not part of the post): post on a weekday morning US-time.
After the next hourly build, the Show HN thread itself will appear on the
page — replying with a link to its own reranked version is the line people
will quote. Expect "the scoring missed X" comments; those are labeled
training data, welcome them.*
