export const meta = {
  name: 'hn-redesign-forge',
  description: 'Eureka-forge: radically useful re-designs of Hacker News (mechanisms, not wrappers), critiqued, Borda-ranked, and synthesized by category',
  phases: [
    { title: 'Generate' },
    { title: 'Recombine' },
    { title: 'Shortlist' },
    { title: 'Critique' },
    { title: 'Rank' },
    { title: 'Synthesize' },
  ],
}

// ---------------------------------------------------------------------------
// Shared context every agent gets: what HN is today, and the anti-wrapper bar.
// ---------------------------------------------------------------------------
const HN_CONTEXT = `
TARGET: Hacker News (https://news.ycombinator.com/), the Y Combinator news aggregator.

Reconstruct HN's CURRENT design from your own knowledge (no web access). Salient facts:
- Front page = a ranked list of links. Ranking ≈ (upvotes-1)^0.8 / (age_hours + 2)^gravity, plus
  invisible moderation/penalty multipliers (controversy, self-post, domain penalties, "second-chance" pool).
- Karma: per-user points from story/comment upvotes. Unlocks downvoting (>500), flagging, etc.
- Comments: threaded, vote-ranked, collapsible; flamewar detection re-sorts/penalizes; dead/flagged hidden.
- Moderation: small human team (notably 'dang'), flagging by users, shadow penalties, "showdead".
- Genres: Show HN, Ask HN, Launch HN, jobs, "who is hiring".
- Aesthetic: deliberately minimal, fast, text-first, near-zero JS, no images/avatars, Arial on beige (#f6f6ef).
- Culture: technical, skeptical, status from insight not identity; recurring complaints about
  rage-bait/flamewars, repetitive threads, early-vote lock-in, hivemind, recency bias, expert flight,
  dead-on-arrival good posts, "didn't read the article" comments, no memory across reposts.

ANTI-WRAPPER BAR (enforce ruthlessly):
- REJECT cosmetic-only changes (dark mode, fonts, avatars, infinite scroll, "modern UI").
- REJECT generic "add an LLM" features ("AI summarizer", "AI chatbot", "AI tags", "RAG search")
  UNLESS they introduce a NEW workflow primitive, provenance/evidence loop, eval/verification loop,
  reputation/trust mechanism, coordination mechanism, memory across time, or distribution wedge.
- A good redesign CHANGES A WORKFLOW or INCENTIVE, not just the pixels. The hard part should be
  evidence / ranking / trust / provenance / memory / coordination — not the model call.
- It must respect or productively subvert HN's core values: speed, text-first minimalism, intellectual
  status, skepticism. A redesign that turns HN into Reddit/Twitter is a failure.
`

const IDEA_SHAPE = `Each idea MUST have:
- name: short, vivid, memorable (not "AI Feature 1").
- one_liner: the redesign in one sentence a skeptical HN reader would grasp.
- mechanism: the NEW primitive/workflow/incentive/trust/provenance/memory/coordination thing it adds,
  and concretely how it works (what data, what loop, what UI surface, what changes for whom).
- problem_solved: which real HN pathology it attacks (cite the behavior, e.g. early-vote lock-in).
- why_non_obvious: why this isn't the first thing someone would suggest; what insight it requires.
- anti_wrapper_reason: why this is NOT a thin LLM/cosmetic wrapper (what the hard part actually is).
- falsification: a concrete test that would show it FAILS ("this is a bad idea if measurement X shows Y").`

// ---------------------------------------------------------------------------
// PHASE 1 — GENERATE: diverse functional personas, each a different lens.
// ---------------------------------------------------------------------------
phase('Generate')

const PERSONAS = [
  {
    key: 'ranking-theorist',
    brief: `You are a Ranking/Curation Mechanism Theorist. HN's ranking is a single global decay formula
    with hidden penalties. Attack early-vote lock-in, recency bias, hivemind, and the tyranny of one
    front page for everyone. Propose redesigns to HOW things rank/surface — second-chance pools done
    right, prediction-market or quadratic signals, time-shifted/personalized-yet-legible ranking,
    "slow" front pages, surfacing buried gems. Mechanisms over vibes.`,
  },
  {
    key: 'trust-reputation',
    brief: `You are a Reputation/Trust Mechanism Designer. Karma is a single fungible number that conflates
    "popular" with "trustworthy" and "expert". Propose redesigns to identity, reputation, and trust:
    domain-scoped expertise, stake/skin-in-the-game, verifiable credentials without doxxing, accountability
    for predictions, anti-Goodhart reputation. The hard part is trust math, not UI.`,
  },
  {
    key: 'discussion-quality',
    brief: `You are a Discussion-Quality Engineer. HN comments suffer from "didn't read the article",
    flamewars, first-comment advantage, repeated takes, and shallow dunks. Propose redesigns to the
    comment workflow that raise the floor on discourse: read-gating, claim/evidence structure, steelman
    prompts, dedup of recurring takes, disagreement mapping. Must not feel like homework to a smart adult.`,
  },
  {
    key: 'workflow-anthropologist',
    brief: `You are a Workflow Anthropologist who has watched how HN is actually USED: morning skim,
    saving for later, hunting jobs, finding launches, settling arguments, due-diligence on companies/people,
    learning a field via old threads. Propose redesigns that serve a real recurring user JOB that HN does
    badly today. The redesign is judged by the job it collapses, not its novelty.`,
  },
  {
    key: 'memory-archivist',
    brief: `You are a Memory/Provenance Architect. HN has almost no memory: reposts start from zero, great
    threads vanish, predictions are never scored, the same article gets re-litigated yearly. Propose
    redesigns that give HN MEMORY across time — linking reposts, scoring old predictions, threading a
    topic's history, surfacing "what HN concluded last time". The primitive is the cross-time link graph.`,
  },
  {
    key: 'weird-analogist',
    brief: `You are a Weird Analogist. Steal mechanisms from OTHER domains and port them to HN: peer review,
    prediction markets, GitHub PRs/issues, Wikipedia talk pages, court/adversarial process, futarchy,
    stack-ranking, double-blind review, citation graphs, escrow, liquid democracy, betting markets,
    open-source bounties. Each idea must name the source mechanism and the non-obvious port.`,
  },
  {
    key: 'moderation-scaler',
    brief: `You are a Moderation/Trust-&-Safety Systems Designer. HN leans on a tiny human team + flags +
    shadow penalties; this is fragile, opaque, and slow. Propose redesigns to moderation and governance:
    legible/appealable moderation, distributed jury mechanisms, sybil/astroturf resistance, transparent
    penalty surfacing, community governance that doesn't become mob rule. The hard part is incentive design.`,
  },
  {
    key: 'discovery-frontier',
    brief: `You are a Discovery/Serendipity Designer. The single front page means thousands of great niche
    posts die. Propose redesigns to discovery and the long tail: legible interest lanes that don't fragment
    the community, expert-follow without becoming Twitter, "adjacent to what you read" surfacing, resurfacing
    evergreen threads, cross-domain bridges. Must preserve the shared-canon value of one front page.`,
  },
  {
    key: 'economic-incentive',
    brief: `You are an Economic/Incentive Designer. HN's only currency is karma and attention. Propose
    redesigns that add an economic or game-theoretic layer aligned with quality: bounties for answers,
    staking on claims, paid prioritization that can't be gamed, prediction-scored reputation, costly signals
    that deter spam/rage-bait. Be careful: money usually ruins communities — show why yours doesn't.`,
  },
  {
    key: 'alien-reviewer',
    brief: `You are an Alien Reviewer who has never seen a "news aggregator" and finds the whole format
    absurd. Question the deepest assumptions: Why a ranked list? Why points? Why one feed? Why comments
    below an article? Why is reading separate from discussing? Propose 1–2 RADICAL reframings of what HN
    even IS, with a concrete mechanism, not just provocation.`,
  },
  {
    key: 'agent-era',
    brief: `You are an Agent-Era Product Thinker. Increasingly, AI agents (not just humans) read, summarize,
    and act on HN. Propose redesigns for a world where agents are first-class participants/consumers:
    machine-readable provenance, agent-vs-human-legible signals, structured claims agents can verify,
    APIs/feeds as primary surface, anti-slop defenses against AI-generated comments/posts. Avoid hype:
    the mechanism must matter even if you're skeptical of AI.`,
  },
  {
    key: 'expert-retention',
    brief: `You are an Expert-Retention Strategist. HN slowly bleeds domain experts who tire of confidently-
    wrong upvoted comments and dunks. Propose redesigns that make HN the place experts WANT to correct the
    record: low-friction authoritative correction, expertise that's visible only where earned, signal that
    a correction came from someone who'd know, protection from pile-ons. The hard part is earned authority.`,
  },
  {
    key: 'attention-integrity',
    brief: `You are an Attention-Integrity Designer focused on what HN does to its readers' minds and time.
    Propose redesigns that make HN better for the READER's cognition, not engagement: defeat doomscroll/
    rage-bait at the ranking level, reward changed-my-mind over outrage, make "I learned something" the unit
    of value, give readers a legible sense of having finished. Anti-engagement-maximization by construction.`,
  },
]

const generated = await parallel(
  PERSONAS.map((p) => () =>
    agent(
      `${HN_CONTEXT}

YOUR LENS:
${p.brief}

TASK: Propose 3 radically useful re-designs of Hacker News through YOUR lens. Be specific and concrete.
Favor ideas where the hard part is evidence / ranking / trust / provenance / memory / coordination —
not the model call. No cosmetic-only or thin-wrapper ideas (they will be discarded).

${IDEA_SHAPE}`,
      {
        label: `gen:${p.key}`,
        phase: 'Generate',
        // A short turn timeout so a degenerate "whitespace-only" generation (seen on
        // one persona) fails fast and retries instead of burning the full 600s.
        // timeoutMs is excluded from resume cache identity, so the 12 done agents
        // still replay at 0 tokens.
        timeoutMs: 120000,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ideas'],
          properties: {
            ideas: {
              type: 'array',
              minItems: 3,
              maxItems: 3,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'one_liner', 'mechanism', 'problem_solved', 'why_non_obvious', 'anti_wrapper_reason', 'falsification'],
                properties: {
                  name: { type: 'string' },
                  one_liner: { type: 'string' },
                  mechanism: { type: 'string' },
                  problem_solved: { type: 'string' },
                  why_non_obvious: { type: 'string' },
                  anti_wrapper_reason: { type: 'string' },
                  falsification: { type: 'string' },
                },
              },
            },
          },
        },
      },
    ).then((r) => (r?.ideas || []).map((idea) => ({ ...idea, source: p.key }))),
  ),
)

const allIdeas = generated.filter(Boolean).flat()
log(`Generated ${allIdeas.length} raw ideas from ${PERSONAS.length} personas`)

// ---------------------------------------------------------------------------
// PHASE 2 — RECOMBINE: force hybrids across personas (kills premature convergence).
// Barrier is correct: recombiners need the FULL idea set to find non-obvious pairs.
// ---------------------------------------------------------------------------
phase('Recombine')

const ideaDigest = allIdeas
  .map((it, i) => `[${i}] (${it.source}) ${it.name} — ${it.one_liner}`)
  .join('\n')

const RECOMBINERS = [
  `Force-combine ideas that attack the SAME pathology from different layers (e.g. a ranking idea + a
   reputation idea) into a single stronger system where the combination closes a loophole neither closes alone.`,
  `Force-combine the WEIRDEST / highest-variance ideas with the most practical ones, so the radical idea
   gets a credible adoption path and the practical idea gets a sharper edge.`,
  `Find ideas that would CONFLICT or undercut each other if both shipped, and design the redesign that
   resolves the tension — turning the conflict into a feature.`,
]

const recombined = await parallel(
  RECOMBINERS.map((instruction, i) => () =>
    agent(
      `${HN_CONTEXT}

Here is the full pool of raw HN-redesign ideas (id, source persona, name, one-liner):
${ideaDigest}

TASK: ${instruction}
Produce 3 NEW hybrid redesigns that are strictly stronger than their parents. Reference the parent ids you
combined. A hybrid must add a mechanism the parents lacked — not just staple two ideas together.

${IDEA_SHAPE}
Also include: parents (array of the integer ids you combined).`,
      {
        label: `recombine:${i}`,
        phase: 'Recombine',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ideas'],
          properties: {
            ideas: {
              type: 'array',
              minItems: 3,
              maxItems: 3,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'one_liner', 'mechanism', 'problem_solved', 'why_non_obvious', 'anti_wrapper_reason', 'falsification', 'parents'],
                properties: {
                  name: { type: 'string' },
                  one_liner: { type: 'string' },
                  mechanism: { type: 'string' },
                  problem_solved: { type: 'string' },
                  why_non_obvious: { type: 'string' },
                  anti_wrapper_reason: { type: 'string' },
                  falsification: { type: 'string' },
                  parents: { type: 'array', items: { type: 'integer' } },
                },
              },
            },
          },
        },
      },
    ).then((r) => (r?.ideas || []).map((idea) => ({ ...idea, source: `hybrid:${i}` }))),
  ),
)

const candidatePool = allIdeas.concat(recombined.filter(Boolean).flat())
log(`Candidate pool now ${candidatePool.length} ideas (raw + hybrids)`)

// ---------------------------------------------------------------------------
// PHASE 3 — SHORTLIST: one curator dedups the pool and bounds it to the top 12
// most promising AND most distinct ideas (kills cost-explosion + duplicate ideas).
// Barrier/lone gate by design: needs the FULL pool to dedup -> auto-effort xhigh.
// It must also preserve up to 2 high-variance "weird" ideas so we don't regress to safe.
// ---------------------------------------------------------------------------
phase('Shortlist')

const poolDigest = candidatePool
  .map((it, i) => `[${i}] (${it.source}) ${it.name}: ${it.one_liner}\n     mechanism: ${it.mechanism}`)
  .join('\n')

const shortlist = await agent(
  `${HN_CONTEXT}

Here is the full candidate pool of HN re-design ideas (id, source, name, one-liner, mechanism):
${poolDigest}

TASK: Curate a shortlist of the 12 strongest ideas to advance. Rules:
- DEDUP: if several ideas are the same mechanism in different clothes, keep the single best framing and drop
  the rest (note which ids it absorbs).
- MAXIMIZE DIVERSITY across categories (ranking, reputation, discussion-quality, memory/provenance,
  discovery, moderation/governance, economic, reader-cognition, agent-era) — don't let one category dominate.
- Apply the anti-wrapper bar: drop cosmetic/thin-wrapper ideas.
- PRESERVE at least 2 high-variance / weird / high-upside ideas even if risky, so the set isn't all safe.
Return exactly the 12 chosen ids (integers referencing the pool above), each with a one-line reason.`,
  {
    label: 'shortlist:curate',
    phase: 'Shortlist',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['chosen'],
      properties: {
        chosen: {
          type: 'array',
          minItems: 10,
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'reason'],
            properties: {
              id: { type: 'integer' },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
  },
)

const chosenIds = (shortlist?.chosen || [])
  .map((c) => c.id)
  .filter((id) => Number.isInteger(id) && id >= 0 && id < candidatePool.length)
const finalists = [...new Set(chosenIds)].map((id) => candidatePool[id])
log(`Shortlist: ${finalists.length} finalists advance to critique`)

// ---------------------------------------------------------------------------
// PHASE 4 — CRITIQUE + IMPROVE: each finalist gets ITS OWN independent skeptic.
// Adversarial verification; DEFAULT verdict "weak" unless it clears the bar.
// Pipeline: each idea is critiqued as soon as it's ready (no barrier needed).
// ---------------------------------------------------------------------------
phase('Critique')

const judged = await pipeline(
  finalists,
  (idea, _orig, i) =>
    agent(
      `${HN_CONTEXT}

You are a Bitter, Skeptical HN Reviewer + Wrapper Critic. Be adversarial. Your DEFAULT verdict is "weak"
unless the idea clearly clears the anti-wrapper bar AND survives HN's real constraints (community culture,
scale, simplicity ethos, gameability, moderation load, the fact that HN is run by a tiny team).

IDEA UNDER REVIEW:
name: ${idea.name}
one_liner: ${idea.one_liner}
mechanism: ${idea.mechanism}
problem_solved: ${idea.problem_solved}
why_non_obvious: ${idea.why_non_obvious}
anti_wrapper_reason: ${idea.anti_wrapper_reason}
falsification: ${idea.falsification}

DO:
1. Attack it: is it a thin wrapper? Would it actually change behavior or just add UI? How is it gamed?
   Does it violate HN's core values or just turn HN into Reddit/Twitter? Is the mechanism real?
2. Give a verdict: "strong" | "salvageable" | "weak".
3. Output an IMPROVED version that fixes the biggest weakness while keeping the core insight (set dead:true
   only if the idea is truly unsalvageable).
4. Score 1-10 on: radical_usefulness (would this materially improve HN?), novelty (non-obvious?),
   feasibility_for_hn (could a small team realistically ship a version?).`,
      {
        label: `critique:${i}`,
        phase: 'Critique',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['verdict', 'attack', 'scores', 'improved'],
          properties: {
            verdict: { type: 'string', enum: ['strong', 'salvageable', 'weak'] },
            attack: { type: 'string' },
            scores: {
              type: 'object',
              additionalProperties: false,
              required: ['radical_usefulness', 'novelty', 'feasibility_for_hn'],
              properties: {
                radical_usefulness: { type: 'integer', minimum: 1, maximum: 10 },
                novelty: { type: 'integer', minimum: 1, maximum: 10 },
                feasibility_for_hn: { type: 'integer', minimum: 1, maximum: 10 },
              },
            },
            improved: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'one_liner', 'mechanism', 'falsification', 'dead'],
              properties: {
                name: { type: 'string' },
                one_liner: { type: 'string' },
                mechanism: { type: 'string' },
                falsification: { type: 'string' },
                dead: { type: 'boolean' },
              },
            },
          },
        },
      },
    ).then((v) => (v ? { ...idea, critique: v } : null)),
)

const ranked = judged.filter(Boolean).filter((x) => !x.critique.improved.dead)
const N = ranked.length
log(`Critique done: ${N} ideas survive (non-dead)`)

// ---------------------------------------------------------------------------
// PHASE 5 — RANK: 3 INDEPENDENT rankers each rank the whole survivor set by
// radical-usefulness; aggregate by Borda count. Multi-judge rank aggregation
// beats a single unreliable 1-10 score (weak-ranking failure mode) at a fraction
// of a full pairwise tournament's cost.
// ---------------------------------------------------------------------------
phase('Rank')

const survivorDigest = ranked
  .map((x, i) => `[${i}] ${x.critique.improved.name || x.name}: ${x.critique.improved.one_liner || x.one_liner}
     mechanism: ${x.critique.improved.mechanism || x.mechanism}`)
  .join('\n')

const RANK_LENSES = [
  `Rank by RADICAL USEFULNESS: how much it would materially improve HN for its real users via a real
   mechanism. Reward changing a workflow/incentive; penalize wrappers and anything that Reddit-ifies HN.`,
  `Rank by SHIPPABILITY-WEIGHTED IMPACT: impact × realistic chance a small team could ship a v1 that
   moves the metric, within HN's minimalist culture, without a gameability blowup.`,
  `Rank by NON-OBVIOUS UPSIDE: which ideas have the largest gap between "sounds modest" and "could quietly
   change everything"; reward sleeper/high-variance ideas the safe consensus would underrate.`,
]

const rankings = await parallel(
  RANK_LENSES.map((lens, k) => () =>
    agent(
      `${HN_CONTEXT}

Survivor HN re-designs (id, name, one-liner, mechanism):
${survivorDigest}

TASK: ${lens}
Return ALL ${N} ids in a single ordered list, best first, no ties, no omissions.`,
      {
        label: `rank:${k}`,
        phase: 'Rank',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['order'],
          properties: {
            order: { type: 'array', items: { type: 'integer' }, minItems: N, maxItems: N },
          },
        },
      },
    ).then((r) => r?.order || null),
  ),
)

// Borda: an item gets (N - position) points from each ranker that lists it.
const borda = new Array(N).fill(0)
for (const order of rankings.filter(Boolean)) {
  const seen = new Set()
  order.forEach((id, pos) => {
    if (Number.isInteger(id) && id >= 0 && id < N && !seen.has(id)) {
      seen.add(id)
      borda[id] += N - pos
    }
  })
}
const standings = ranked
  .map((x, idx) => ({
    idx,
    borda: borda[idx],
    name: x.critique.improved.name || x.name,
    source: x.source,
    verdict: x.critique.verdict,
    scores: x.critique.scores,
  }))
  .sort((a, b) => b.borda - a.borda)
log(`Rank: aggregated ${rankings.filter(Boolean).length} independent rankings via Borda over ${N} ideas`)

// ---------------------------------------------------------------------------
// PHASE 5 — SYNTHESIZE: lone gate (auto-effort -> xhigh). Portfolio BY CATEGORY,
// not one winner. Writes up the strongest ideas richly + the single best next action.
// ---------------------------------------------------------------------------
phase('Synthesize')

const topForSynth = standings.slice(0, Math.min(16, N)).map((s) => {
  const x = ranked[s.idx]
  return {
    name: s.name,
    source: s.source,
    borda_score: s.borda,
    verdict: s.verdict,
    scores: s.scores,
    one_liner: x.critique.improved.one_liner || x.one_liner,
    mechanism: x.critique.improved.mechanism || x.mechanism,
    problem_solved: x.problem_solved,
    why_non_obvious: x.why_non_obvious,
    falsification: x.critique.improved.falsification || x.falsification,
    strongest_attack: x.critique.attack,
  }
})

const portfolio = await agent(
  `${HN_CONTEXT}

You are the Portfolio Synthesizer. Below are the top HN re-design finalists after generation, recombination,
adversarial critique, and multi-judge Borda ranking (with Borda scores and 1-10 critique scores). Your job is NOT to pick
one winner — it is to assemble the strongest PORTFOLIO of radically useful HN re-designs, selected BY
CATEGORY so the set is diverse (e.g. ranking/curation, reputation/trust, discussion quality, memory/provenance,
discovery, moderation/governance, economic layer, reader cognition, agent-era — use whatever categories the
ideas actually cluster into).

FINALISTS (JSON):
${JSON.stringify(topForSynth, null, 2)}

Deliver:
1. portfolio: 6-9 re-designs, each in its own category, each written up with: name, category, one_liner,
   how_it_works (concrete mechanism + the key UI/data surface + what changes for whom), why_it_matters,
   why_non_obvious, evidence_for (what about HN today supports this working), evidence_against (the strongest
   honest case it fails / risk), falsification (a concrete metric/test that would prove it bad). Keep
   confirmed reasoning separate from speculation; do not overclaim.
2. best_next_action: the single highest-leverage redesign to prototype FIRST and why (cheapest path to a
   real signal, smallest blast radius on HN's culture).
3. codex_goal: a strict, ready-to-run Codex /goal prompt to build a minimal prototype or offline simulation
   of best_next_action (objective, non-goals, allowed actions, success criteria, falsification, artifacts).
4. uncertainties: what you're unsure about and what evidence would resolve it.`,
  {
    label: 'synthesize:portfolio',
    phase: 'Synthesize',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['portfolio', 'best_next_action', 'codex_goal', 'uncertainties'],
      properties: {
        portfolio: {
          type: 'array',
          minItems: 6,
          maxItems: 9,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'category', 'one_liner', 'how_it_works', 'why_it_matters', 'why_non_obvious', 'evidence_for', 'evidence_against', 'falsification'],
            properties: {
              name: { type: 'string' },
              category: { type: 'string' },
              one_liner: { type: 'string' },
              how_it_works: { type: 'string' },
              why_it_matters: { type: 'string' },
              why_non_obvious: { type: 'string' },
              evidence_for: { type: 'string' },
              evidence_against: { type: 'string' },
              falsification: { type: 'string' },
            },
          },
        },
        best_next_action: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'why', 'prototype_plan'],
          properties: {
            name: { type: 'string' },
            why: { type: 'string' },
            prototype_plan: { type: 'string' },
          },
        },
        codex_goal: { type: 'string' },
        uncertainties: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)

return {
  meta_summary: {
    personas: PERSONAS.length,
    raw_ideas: allIdeas.length,
    candidate_pool: candidatePool.length,
    finalists_shortlisted: finalists.length,
    survivors_ranked: N,
    rankers: rankings.filter(Boolean).length,
  },
  standings: standings.slice(0, 12),
  portfolio,
}
