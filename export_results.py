#!/usr/bin/env python3
"""
SAGE Analytics Dashboard — export_results.py
Author: Dr. Himanshu Sharma

Turns the SAGE `SavedResources/` folder into the small JSON files the
dashboard reads, so the repository never has to carry model states (.pt)
or the full prediction dumps.

    python export_results.py --src "<path to SavedResources>" --out data

For every `Batch-<N>` folder it writes `data/Batch-<N>.json`, and it writes
`data/batches.json` listing every exported batch. Parts that are missing
(e.g. ablations still running, a test step that failed) are skipped and
recorded under "availability", so a half-finished batch still exports.

When Batch-256 arrives: copy it into SavedResources, rerun this script,
commit the `data/` folder. Nothing in the dashboard code needs to change.

Requires: Python 3.8+, pandas, openpyxl.
"""
import argparse
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

try:
    import pandas as pd
except ImportError:  # pragma: no cover
    sys.exit("pandas (and openpyxl) are required:  pip install pandas openpyxl")

STYLES = ("negative", "positive")

# Images shown in the paper's qualitative figure (Fig. 3); their captions are exported for every batch.
FEATURED = ["COCO_val2014_000000372979.jpg", "COCO_val2014_000000377946.jpg",
            "COCO_val2014_000000573094.jpg", "COCO_val2014_000000139637.jpg"]

# Nouns treated as animate when checking the "dead" failure mode
ANIMATE = {
    "man", "men", "woman", "women", "person", "people", "boy", "boys", "girl", "girls",
    "child", "children", "kid", "kids", "baby", "babies", "guy", "guys", "lady", "ladies",
    "player", "players", "skier", "skiers", "surfer", "surfers", "skateboarder", "skateboarders",
    "snowboarder", "rider", "riders", "family", "couple", "crowd", "team", "toddler", "teenager",
    "dog", "dogs", "puppy", "cat", "cats", "kitten", "horse", "horses", "bird", "birds",
    "cow", "cows", "elephant", "elephants", "giraffe", "giraffes", "zebra", "zebras",
    "sheep", "bear", "bears", "animal", "animals", "pigeon", "pigeons", "duck", "ducks",
    "goat", "goats", "lamb", "calf", "seagull",
}


# ──────────────────────────────────────────────────────────────────────────
# helpers
# ──────────────────────────────────────────────────────────────────────────
def clean(o):
    """Make an object JSON-safe: NaN/inf -> None, numpy -> python, round floats."""
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if hasattr(o, "item") and not isinstance(o, (str, bytes)):
        try:
            o = o.item()
        except Exception:
            pass
    if isinstance(o, float):
        if math.isnan(o) or math.isinf(o):
            return None
        return round(o, 5)
    return o


def read_json(p):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"    ! could not read {p}: {e}")
        return None


def read_sheet(p):
    try:
        df = pd.read_excel(p)
        return clean(df.where(pd.notnull(df), None).to_dict(orient="records"))
    except Exception as e:
        print(f"    ! could not read {p}: {e}")
        return None


def parse_epoch_dump(p):
    """Parse GeneratedPredictions_*.txt -> {epoch: {key: caption}}."""
    try:
        text = Path(p).read_text(encoding="utf-8")
    except Exception as e:
        print(f"    ! could not read {p}: {e}")
        return {}
    sep = re.compile(r"-{20,}\s*\n\s*Epoch Number (\d+)\s*\n\s*-{20,}\s*\n")
    parts = sep.split(text)
    out = {}
    for i in range(1, len(parts) - 1, 2):
        ep = int(parts[i])
        block = re.sub(r"\n-{20,}[\s\S]*$", "", parts[i + 1]).strip()
        try:
            d = json.loads(block)
        except Exception:
            continue
        out[ep] = {k: (v[0] if isinstance(v, list) else v) for k, v in d.items()}
    return out


def toks(s):
    return re.findall(r"[a-z']+", (s or "").lower())


def distinct_n(caps, n):
    grams, total = set(), 0
    for c in caps:
        t = toks(c)
        g = [tuple(t[i:i + n]) for i in range(len(t) - n + 1)]
        grams.update(g)
        total += len(g)
    return 100.0 * len(grams) / total if total else None


def caption_stats(caps):
    lens = [len(toks(c)) for c in caps if c]
    if not lens:
        return None
    m = sum(lens) / len(lens)
    sd = math.sqrt(sum((x - m) ** 2 for x in lens) / len(lens))
    return {
        "n": len(lens), "mean_len": m, "std_len": sd,
        "distinct1": distinct_n(caps, 1), "distinct2": distinct_n(caps, 2),
        "unique_pct": 100.0 * len(set(caps)) / len(caps),
        "len_hist": dict(Counter(lens)),
    }


# Welch t-test (two-sided) without scipy ----------------------------------
def _betacf(a, b, x):
    qab, qap, qam = a + b, a + 1, a - 1
    c, d = 1.0, 1 - qab * x / qap
    d = 1 / (d if abs(d) > 1e-30 else 1e-30)
    h = d
    for m in range(1, 200):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1 + aa * d; d = 1 / (d if abs(d) > 1e-30 else 1e-30)
        c = 1 + aa / c if abs(c) > 1e-30 else 1 + aa / 1e-30
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1 + aa * d; d = 1 / (d if abs(d) > 1e-30 else 1e-30)
        c = 1 + aa / c if abs(c) > 1e-30 else 1 + aa / 1e-30
        de = d * c
        h *= de
        if abs(de - 1) < 3e-12:
            break
    return h


def _ibeta(a, b, x):
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    lbt = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x)
    bt = math.exp(lbt)
    if x < (a + 1) / (a + b + 2):
        return bt * _betacf(a, b, x) / a
    return 1 - bt * _betacf(b, a, 1 - x) / b


def welch_p(xs, ys):
    xs = [v for v in xs if v is not None]
    ys = [v for v in ys if v is not None]
    if len(xs) < 2 or len(ys) < 2:
        return None
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    vx = sum((v - mx) ** 2 for v in xs) / (len(xs) - 1)
    vy = sum((v - my) ** 2 for v in ys) / (len(ys) - 1)
    se2 = vx / len(xs) + vy / len(ys)
    if se2 == 0:
        return 1.0 if mx == my else 0.0
    t = (mx - my) / math.sqrt(se2)
    df = se2 ** 2 / ((vx / len(xs)) ** 2 / (len(xs) - 1) + (vy / len(ys)) ** 2 / (len(ys) - 1))
    return _ibeta(df / 2, 0.5, df / (df + t * t))


# ──────────────────────────────────────────────────────────────────────────
# test-folder readers
# ──────────────────────────────────────────────────────────────────────────
TEST_RE = re.compile(r"TestResults_stylised_(best|last)_epoch(\d+)_beam(\d+)\.json$")


def find_tests(test_root):
    """Return {label: {'dir':..., 'tag':..., 'epoch':..., 'beam':...}} for a TestResults folder."""
    found = {}
    if not Path(test_root).is_dir():
        return found
    for d in sorted(Path(test_root).iterdir()):
        if not d.is_dir():
            continue
        for f in d.iterdir():
            m = TEST_RE.match(f.name)
            if not m:
                continue
            state, ep, beam = m.group(1), int(m.group(2)), int(m.group(3))
            label = state + ("_unconstrained" if d.name.endswith("_unconstrained") else "")
            found[label] = {"dir": d, "tag": f"stylised_{state}_epoch{ep}_beam{beam}", "epoch": ep, "beam": beam}
    return found


def dead_analysis(neg_caps):
    total = len(neg_caps)
    with_dead = animate = 0
    nouns = Counter()
    for c in neg_caps:
        t = toks(c)
        if "dead" not in t:
            continue
        with_dead += 1
        hit = False
        for i, w in enumerate(t):
            if w != "dead":
                continue
            if i + 1 < len(t):
                nouns[t[i + 1]] += 1
            for j in (i + 1, i + 2):  # "dead man", "dead old man"
                if j < len(t) and t[j] in ANIMATE:
                    hit = True
        animate += hit
    return {"n_negative": total, "with_dead": with_dead, "dead_on_animate": animate,
            "following_word_top": nouns.most_common(12)}


def featured_captions(caps):
    """Captions (and selected words) for the paper's Fig. 3 images."""
    out = {}
    for img in FEATURED:
        for s in STYLES:
            v = caps.get(f"{img}|{s}")
            if v:
                out.setdefault(img, {})[s] = {"caption": v.get("caption"), "words": v.get("style_words", [])}
    return out


def read_test(info, n_examples=48, keep_captions=True):
    d, tag = info["dir"], info["tag"]
    res = read_json(d / f"TestResults_{tag}.json")
    if res is None:
        return None
    out = {"epoch": info["epoch"], "beam": info["beam"], "results": res}
    if not keep_captions:
        caps = read_json(d / f"TestCaptions_{tag}.json")
        if caps:
            neg = [v["caption"] for k, v in caps.items() if k.endswith("|negative")]
            out["dead"] = dead_analysis(neg)
            out["featured"] = featured_captions(caps)
        return out

    spread = read_json(d / f"PresenceSpread_{tag}.json")
    if spread is not None:
        out["presence_spread"] = spread
    qual = read_json(d / f"Qualitative_{tag}.json")
    if qual is not None:
        out["qualitative"] = qual
    sw = read_json(d / f"StyleSwitch_{tag}.json")
    caps = read_json(d / f"TestCaptions_{tag}.json")
    words_by_key = {}
    if caps:
        by_style = defaultdict(list)
        word_freq = {s: Counter() for s in STYLES}
        for k, v in caps.items():
            st = k.rsplit("|", 1)[-1]
            by_style[st].append(v.get("caption", ""))
            words_by_key[k] = v.get("style_words", [])
            for w, _ in v.get("style_words", [])[:1]:
                word_freq.setdefault(st, Counter())[w] += 1
        out["caption_stats"] = {s: caption_stats(by_style[s]) for s in by_style}
        out["selected_top1"] = {s: word_freq[s].most_common(15) for s in word_freq}
        out["dead"] = dead_analysis(by_style.get("negative", []))
        out["featured"] = featured_captions(caps)
    if sw:
        keys = sorted(sw.keys())
        step = max(1, len(keys) // n_examples)
        sample = keys[::step][:n_examples]
        out["style_switch"] = [{
            "image": k,
            "negative": sw[k].get("negative"), "positive": sw[k].get("positive"),
            "neg_words": words_by_key.get(k + "|negative", []),
            "pos_words": words_by_key.get(k + "|positive", []),
        } for k in sample]
    return out


# ──────────────────────────────────────────────────────────────────────────
# per-batch export
# ──────────────────────────────────────────────────────────────────────────
def pick_evolution_images(ep_dump, n=8):
    if not ep_dump:
        return []
    last = ep_dump[max(ep_dump)]
    imgs = sorted({k.rsplit("|", 1)[0] for k in last})
    both = [i for i in imgs if f"{i}|negative" in last and f"{i}|positive" in last]
    pool = both or imgs
    step = max(1, len(pool) // n)
    return pool[::step][:n]


def export_batch(bdir):
    name = bdir.name
    bs = int(re.sub(r"\D", "", name) or 0)
    print(f"  · {name}")
    avail = {}
    out = {"batch": name, "batch_size": bs, "exported": datetime.now().strftime("%Y-%m-%d %H:%M")}

    status = read_json(bdir / "PipelineStatus.json") if (bdir / "PipelineStatus.json").exists() else None
    out["pipeline"] = status
    avail["pipeline"] = status is not None

    # Stage 1 (pretrain) and Stage 2 (stylised) logs
    for stage in ("pretrain", "stylised"):
        tl, ps = bdir / f"TrainingLogs_{stage}.xlsx", bdir / f"PredictionSplit_{stage}.xlsx"
        out[f"train_{stage}"] = read_sheet(tl) if tl.exists() else None
        out[f"val_{stage}"] = read_sheet(ps) if ps.exists() else None
        avail[f"train_{stage}"] = bool(out[f"train_{stage}"])
        avail[f"val_{stage}"] = bool(out[f"val_{stage}"])

    diag = bdir / "EpochDiagnostics_stylised.json"
    out["diagnostics"] = clean(read_json(diag)) if diag.exists() else None
    avail["diagnostics"] = bool(out["diagnostics"])

    # Caption evolution (validation subset) for stage 2 and stage 1
    gp = parse_epoch_dump(bdir / "GeneratedPredictions_stylised.txt") if (bdir / "GeneratedPredictions_stylised.txt").exists() else {}
    if gp:
        imgs = pick_evolution_images(gp)
        out["evolution"] = {
            "epochs": sorted(gp),
            "images": imgs,
            "captions": {i: {s: {str(ep): gp[ep].get(f"{i}|{s}") for ep in sorted(gp)} for s in STYLES} for i in imgs},
            "stats": {s: [dict(epoch=ep, **(caption_stats([v for k, v in gp[ep].items() if k.endswith("|" + s)]) or {}))
                          for ep in sorted(gp)] for s in STYLES},
        }
        for s in STYLES:
            for row in out["evolution"]["stats"][s]:
                row.pop("len_hist", None)
    avail["evolution"] = bool(gp)

    gp1 = parse_epoch_dump(bdir / "GeneratedPredictions_pretrain.txt") if (bdir / "GeneratedPredictions_pretrain.txt").exists() else {}
    if gp1:
        last = gp1[max(gp1)]
        keys = sorted(last)[:: max(1, len(last) // 6)][:6]
        out["evolution_pretrain"] = {"epochs": sorted(gp1),
                                     "captions": {k.rsplit("|", 1)[0]: {str(ep): gp1[ep].get(k) for ep in sorted(gp1)} for k in keys}}

    # Selector: which style words are picked, per epoch
    sel = bdir / "SelectedWords_stylised.jsonl"
    if sel.exists():
        per_epoch = []
        overall = {s: Counter() for s in STYLES}
        with open(sel, encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                counts = {s: Counter() for s in STYLES}
                n = Counter()
                for k, ws in row.get("words", {}).items():
                    st = k.rsplit("|", 1)[-1]
                    if st not in counts:
                        continue
                    n[st] += 1
                    if ws:
                        counts[st][ws[0][0]] += 1
                        overall[st][ws[0][0]] += 1
                per_epoch.append({"epoch": row.get("epoch"), "n": dict(n), "top1": {s: dict(counts[s]) for s in STYLES}})
        keep = {s: [w for w, _ in overall[s].most_common(8)] for s in STYLES}
        out["selector_evolution"] = {"words": keep, "epochs": [
            {"epoch": r["epoch"], **{s: {w: 100.0 * r["top1"][s].get(w, 0) / max(r["n"].get(s, 0), 1) for w in keep[s]} for s in STYLES}}
            for r in per_epoch]}
    avail["selector_evolution"] = "selector_evolution" in out

    # Main-run tests
    tests = find_tests(bdir / "TestResults")
    out["tests"] = {}
    for label, info in tests.items():
        r = read_test(info)
        if r:
            out["tests"][label] = r
    avail["tests"] = sorted(out["tests"])

    # Ablations
    abl_dir = bdir / "AblationResults"
    summ = read_json(abl_dir / "Summary" / "Ablations.json") if (abl_dir / "Summary" / "Ablations.json").exists() else None
    if summ:
        per_seed = summ.get("per_seed", {})
        summary = summ.get("summary", {})
        # derived: average of the two styles, per seed, so the dashboard can rank variants on one number
        for var, runs in per_seed.items():
            for r in runs:
                for m in ("CIDEr", "BLEU-4", "METEOR", "StyleAcc(VADER)", "CLIPScore"):
                    a, b = r.get(f"negative {m}"), r.get(f"positive {m}")
                    if a is not None and b is not None:
                        r[f"mean {m}"] = (a + b) / 2
            for m in ("CIDEr", "BLEU-4", "METEOR", "StyleAcc(VADER)", "CLIPScore"):
                vals = [r.get(f"mean {m}") for r in runs if r.get(f"mean {m}") is not None]
                if vals and var in summary:
                    mu = sum(vals) / len(vals)
                    sd = math.sqrt(sum((v - mu) ** 2 for v in vals) / (len(vals) - 1)) if len(vals) > 1 else 0.0
                    summary[var][f"mean {m}"] = {"mean": mu, "std": sd, "n": len(vals)}
        full = per_seed.get("full", [])
        pvals = {}
        for var, runs in per_seed.items():
            if var == "full":
                continue
            pvals[var] = {}
            for metric in (runs[0].keys() if runs else []):
                pvals[var][metric] = welch_p([r.get(metric) for r in runs], [r.get(metric) for r in full])
        out["ablations"] = {"seeds": summ.get("seeds"), "summary": summary,
                            "per_seed": per_seed, "p_vs_full": pvals}
        fails = read_json(abl_dir / "Summary" / "Failures.json") if (abl_dir / "Summary" / "Failures.json").exists() else None
        out["ablations"]["failures"] = fails or []
    avail["ablations"] = bool(summ)

    # Full-model seeds: test detail per seed (results + "dead" counts, captions for first seed)
    seeds = []
    if abl_dir.is_dir():
        for sd in sorted(abl_dir.glob("full_seed*")):
            t = find_tests(sd / "TestResults")
            entry = {"seed": int(re.sub(r"\D", "", sd.name.split("seed")[-1]) or 0)}
            for label, info in t.items():
                r = read_test(info, keep_captions=not seeds)  # rich detail only for the first seed
                if r:
                    entry[label] = r
            tl = sd / "TrainingLogs_stylised.xlsx"
            if tl.exists():
                rows = read_sheet(tl) or []
                secs = [r.get("seconds") for r in rows if r.get("seconds") is not None]
                if secs:
                    entry["stylised_min"] = sum(secs) / 60
                    entry["stylised_epochs"] = len(secs)
            if len(entry) > 1:
                seeds.append(entry)
    out["full_seeds"] = seeds
    avail["full_seeds"] = len(seeds)

    # Timing
    timing = {}
    for stage in ("pretrain", "stylised"):
        rows = out.get(f"train_{stage}") or []
        secs = [r.get("seconds") for r in rows if r.get("seconds") is not None]
        if secs:
            timing[stage] = {"total_min": sum(secs) / 60, "per_epoch_s": sum(secs) / len(secs), "epochs": len(secs)}
    st_seeds = [s["stylised_min"] for s in seeds if s.get("stylised_min") is not None]
    if st_seeds:
        mu = sum(st_seeds) / len(st_seeds)
        sd_ = math.sqrt(sum((v - mu) ** 2 for v in st_seeds) / (len(st_seeds) - 1)) if len(st_seeds) > 1 else 0.0
        timing["stylised_seeds"] = {"mean_min": mu, "std_min": sd_, "n": len(st_seeds)}
    out["timing"] = timing

    out["availability"] = avail
    return clean(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    here = Path(__file__).resolve().parent
    ap.add_argument("--src", default=str(here.parent), help="SavedResources folder containing Batch-* folders")
    ap.add_argument("--out", default=str(here / "data"), help="output folder (default: ./data)")
    ap.add_argument("--only", nargs="*", help="export only these batches, e.g. --only Batch-256")
    a = ap.parse_args()

    src, dst = Path(a.src), Path(a.out)
    batches = sorted([p for p in src.glob("Batch-*") if p.is_dir()], key=lambda p: int(re.sub(r"\D", "", p.name) or 0))
    if a.only:
        batches = [b for b in batches if b.name in a.only]
    if not batches:
        sys.exit(f"No Batch-* folders found in {src}")
    dst.mkdir(parents=True, exist_ok=True)
    print(f"Exporting {len(batches)} batch(es) from {src}")
    for b in batches:
        data = export_batch(b)
        p = dst / f"{b.name}.json"
        p.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
        print(f"    → {p}  ({p.stat().st_size / 1024:.0f} KB)")

    # batches.json lists every exported batch, with what each one contains
    index = []
    for p in sorted(dst.glob("Batch-*.json"), key=lambda p: int(re.sub(r"\D", "", p.stem) or 0)):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        index.append({"name": d["batch"], "batch_size": d["batch_size"], "exported": d.get("exported"),
                      "availability": d.get("availability", {})})
    (dst / "batches.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    print(f"    → {dst / 'batches.json'}  ({len(index)} batches)")


if __name__ == "__main__":
    main()
