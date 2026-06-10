# Weight calibration — LLM-judge pairwise labels → Bradley–Terry fit

- Pairs sampled within-story from a live front-page run; judged "which is more worth reading" by an LLM judge (Haiku) in batches.
- Usable pairs: **107** (106 decided, 1 ties) · train 86 / test 21.
- Model: logistic on feature *differences* (Bradley–Terry), L2 λ=0.03.

| accuracy on decided pairs | hand weights | fitted weights |
|---|---|---|
| train | 68.2% | 74.1% |
| held-out test | 66.7% | 81.0% |

| feature | hand | fitted (scaled to hand range) | pairs where it differs | verdict |
|---|---|---|---|---|
| duel | -4 | -0.93 | 5/107 | too rare in sample — no evidence either way |
| dunk | -3 | 0 | 0/107 | too rare in sample — no evidence either way |
| toxic | -3 | 0.36 | 1/107 | too rare in sample — no evidence either way |
| didntRead | -1.5 | 0 | 0/107 | too rare in sample — no evidence either way |
| lowEffort | -2 | -1.8 | 24/107 | roughly confirmed |
| shouting | -1.5 | 0 | 0/107 | too rare in sample — no evidence either way |
| wall | -1 | 0 | 0/107 | too rare in sample — no evidence either way |
| links | 2 | 0.86 | 23/107 | roughly confirmed |
| primary | 1 | 0.49 | 5/107 | too rare in sample — no evidence either way |
| code | 3 | 0 | 0/107 | too rare in sample — no evidence either way |
| firsthand | 3 | 0.1 | 4/107 | too rare in sample — no evidence either way |
| specifics | 1 | 1.29 | 9/107 | roughly confirmed |
| structured | 2 | 4 | 42/107 | underweighted by hand |
| midLength | 1 | 1.85 | 34/107 | underweighted by hand |
| discussion | 1 | -0.08 | 25/107 | roughly confirmed |
| question | 0.5 | -0.81 | 20/107 | **sign flip — hand weight likely wrong** |

## Caveats
- The judge sees comment text only — thread-context features (duel, discussion) are judged indirectly, so their fitted weights are noisy.
- Labels come from one LLM judge, not humans; treat as cheap bootstrap ground truth (spot-check before trusting).
- Rare features (code, firsthand, dunk, toxic…) almost never differ within sampled pairs, so their fitted weights are ~0 by L2 default — **absence of evidence, not evidence of absence**. The hand weights stay the shipping default; next round should oversample pairs where rare features differ.
- Apply with: `node rerank.js --weights calibration/weights.calibrated.json`
