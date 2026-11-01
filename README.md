# SAGE · Analytics Dashboard

Interactive results dashboard for **SAGE: Sentiment Alignment with Grounded Evidence for Stylized Image Captioning** (SentiCap).
Pages:

| Page | What it shows |
|---|---|
| Dashboard | Headline test metrics (full model, mean ± σ over seeds), stage-2 loss, validation CIDEr / style accuracy, negative vs positive |
| Training Logs | Stage-1 factual pre-training, stage-2 loss components, per-epoch loss composition, LR / teacher-forcing schedules, caption length |
| Evaluation | Validation curves, every test configuration (seeds, main run, unconstrained, last), constrained vs unconstrained decoding, seed spread |
| Style & Grounding | Per-epoch style diagnostics, selector word choice, presence spread, NULL-slot mass, copy gate, over-generation, the “dead” failure mode |
| Captions | Paper Fig. 3 images across all batch sizes, style-switch pairs with highlighted lexicon words, caption evolution across epochs, best/worst examples with references |
| Ablations | Δ vs full model with Welch t-tests, full ablation table, variant × metric heatmap (paper Table II variants, or all variants) |
| Benchmarks | SAGE against the eight published SentiCap results of paper Table III, at any batch size, with margins over the best published value |
| Batch Comparison | All batch sizes side by side (paper Table I and Fig. 2), including ablation × batch-size effects (Table II) |
| Insights | Findings generated from the loaded batch, plus the run configuration |

## Repository layout

```
index.html          page shell
dashboard.css       theme (same palette as DHARA)
dashboard.js        charts and pages (Chart.js 4)
export_results.py   turns SavedResources/ into data/*.json
data/               batches.json, benchmarks.json (paper Table III) + one Batch-<N>.json per batch size
```

Model states (`.pt`) and full prediction dumps never go to GitHub; the exporter keeps only what the dashboard needs (~200–400 KB per batch).

