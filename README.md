# SAGE · Analytics Dashboard

Interactive results dashboard for **SAGE: Sentiment Alignment with Grounded Evidence for Stylized Image Captioning** (SentiCap).
It shares its look with the DHARA dashboard. Pages:

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

## Updating the data

1. Keep this folder inside the results folder (`C:\Model-SavedResources\SentiCap-SavedResources\SAGE_Dashboard`), next to the `Batch-*` folders.
2. Run the exporter (needs Python 3.8+, `pandas`, `openpyxl`):
   ```bash
   python export_results.py
   ```
   From anywhere else: `python export_results.py --src "path/to/SentiCap-SavedResources" --out data`.
3. Commit and push `data/`. New batches appear in the selector; nothing else changes.

`data/benchmarks.json` is written by hand (it is paper Table III). Edit it to add or correct a published method; the SAGE row is always computed from the batch files.

A batch can be exported before it is finished: missing parts (ablations still running, a failed test step) are skipped and shown as red dots in the selector. Batches listed in `EXPECTED_BATCHES` (top of `dashboard.js`) but not yet exported show as “pending”.

## Publishing on GitHub Pages

Push these files to a repository, then **Settings → Pages → Deploy from branch → main / root**.
If the repository is not called `sage`, edit `GH.repo` at the top of `dashboard.js` (used only for the header and as a fallback data source).
To preview locally: `python -m http.server` in this folder, then open http://localhost:8000.

A specific batch can be linked directly: `…/index.html?batch=Batch-128`.

## Notes on the numbers

* **Test source.** When `AblationResults/full_seed*` exist, test figures are the full model averaged over those seeds (mean ± sample σ), as in the paper's Tables I–III. Otherwise the main run's `stylised_best` test is used and marked † on the comparison page.
* **Main run vs seeds.** The “dead” counts and the Fig. 3 captions come from the main run (seed 11, the `TestResults` folder of each batch), as in the paper. Stage-2 training time is the mean of the three full-model seeds, as in Table I.
* **Best checkpoint.** Curves mark the checkpoint the pipeline tested as `stylised_best`. This is not always the epoch with the highest logged selection score; both are listed on the comparison page.
* **Significance.** Ablation p-values are two-sided Welch t-tests over seeds against the full model, computed by the exporter.
* **“dead” on animate nouns** counts captions where the word right after “dead” (or one later) is in a fixed person/animal list, so it can differ slightly from a manual count.
* **Images** on the Captions page load from `images.cocodataset.org`; if a browser blocks them, the captions still show without thumbnails.
* **Variant names** shown for ablations come from `VARIANT_LABELS` in `dashboard.js`; edit them to match the paper's wording.
