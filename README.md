# Hot Thread Slow Rank

**Surface the comment worth reading, hide the fight.**

HN ranks comments by votes + recency, so the witty dunk wins and the person who
*actually knows* — primary source, firsthand experience, code — is buried at
position #200. This tool re-ranks every front-page thread by **substance**,
read-only over public APIs. No HN user does anything new; nothing is sent
anywhere.

**Live page (regenerated hourly):** https://scasella.github.io/hn-slow-rank/

Real examples from live runs: a source+specifics comment surfaced from
**position #246 by votes**; on a 1,319-comment hot thread, a source+code+firsthand
comment surfaced from **#1231**.

## How it scores

Every comment gets a transparent, additive score — each point carries a visible
reason badge:

- **Float up:** 🔗 primary-source links · `⟨/⟩` code · ✋ firsthand ("I built/maintain/work on…") · 📊 specifics (numbers, versions, units) · structured depth · 💬 discussion from distinct repliers
- **Sink/fold:** 🥊 duels (same two users alternating ≥4 deep) · dunks · toxicity · low-effort one-liners
- **Hot mode:** threads with heavy dueling get a stricter surfacing bar
- **📜 Prior-Art Receipts:** the Algolia archive is mined for earlier submissions of the same story — "HN has been here before" with links to what surfaced last time

Scoring is an explicit feature-vector × weights dot product in
[`lib/engine.js`](lib/engine.js) — the same file powers the generator, the
browser extension, and the non-HN adapters.

## Use it

**Generated page** (this repo's CI does this hourly):

```
node rerank.js [topStories=24] [perStory=6] [--out=file.html]
               [--json=dump.json] [--weights=calibration/weights.calibrated.json]
```

**Browser extension** (live HN, in place): `chrome://extensions` → Developer
mode → *Load unpacked* → select [`extension/`](extension/). On any
`news.ycombinator.com/item` page it injects a **▲ Worth reading** lane (click a
row to jump to the comment) and dims low-signal comments (toggleable).
`extension/engine.js` is a byte-for-byte copy of `lib/engine.js` (CI enforces it):
after editing the engine run `cp lib/engine.js extension/engine.js`.

**Other platforms** (same engine, different fetch/map layer):

```
node adapters/lobsters.js          # works today, no auth
node adapters/reddit.js            # mapping ready; Reddit requires OAuth app creds
```

## Calibrated weights

The v1 weights were hand-picked. `calibration/` replaces taste with
measurement: sample within-story comment pairs from a live run, have an LLM
judge label "which is more worth reading" (`claude -p`, Haiku), fit a
Bradley–Terry / logistic model on feature differences, and compare against the
hand weights. See [`calibration/REPORT.md`](calibration/REPORT.md) for what the
judge confirmed and what it overturned.

```
node rerank.js 24 6 --json=calibration/dump.json   # 1. dump features
node calibration/sample-pairs.js 120               # 2. sample pairs
node calibration/judge.js 8 haiku                  # 3. LLM-judge labels (resumable)
node calibration/fit.js                            # 4. fit + report
```

## Rank-trajectory data

`scripts/snapshot.js` records the top-120 front-page order + scores hourly into
`data/snapshots/` (a few KB per line). This is the raw material for a future
shadow-rank / second-chance detector: stories that fell faster than their score
explains, and good posts that never surfaced.

## Honest limitations

- Substance scoring is transparent heuristics. It will occasionally float a
  well-linked-but-wrong comment and miss a brilliant plain-text one. The badges
  ("why floated") are the trustworthy part; disagree on the spot.
- HN flag counts aren't public — flamewars are inferred from thread structure
  (two-author duel chains), not flags.
- Calibration labels come from one LLM judge, not humans. Cheap bootstrap, not
  gospel.

## Provenance

Idea selected from a 33-agent ideation forge over "radically useful HN
redesigns" (2026-06-08), filtered to overlays needing zero user participation;
see [`SPEC.md`](SPEC.md). No dependencies anywhere — plain Node ≥18.
