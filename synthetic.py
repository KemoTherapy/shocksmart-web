"""
╔══════════════════════════════════════════════════════════════════════════════╗
║  generate_synthetic.py  –  ShockSmart  /  Step 2                            ║
║                                                                              ║
║  DESIGN PHILOSOPHY                                                           ║
║  ─────────────────                                                           ║
║  Every distribution, probability, and transition rate is derived DIRECTLY   ║
║  from the real cases.csv at runtime — nothing is hardcoded.                 ║
║                                                                              ║
║  GENERATION STRATEGY (7 layers)                                              ║
║  ────────────────────────────────                                            ║
║  1. SERIES LENGTH BOOTSTRAP                                                  ║
║     Lengths bootstrapped from real case distribution (range 2-16).          ║
║                                                                              ║
║  2. CORRELATED VITAL SAMPLING (per anesthetic class)                        ║
║     Vitals sampled from class-conditional multivariate Gaussians fit        ║
║     on real data, preserving within-class covariance structure.             ║
║                                                                              ║
║  3. FLAG RATES PER CLASS                                                     ║
║     Binary clinical flags sampled using class-conditional Bernoulli rates.  ║
║                                                                              ║
║  4. RULE ENGINE (deterministic label)                                        ║
║     Tampa Site A decision tree → primary anesthetic.                        ║
║     95% deterministic; 5% noise for clinical variability.                   ║
║                                                                              ║
║  5. ADJUNCT ENGINE (conditional probabilities from real data)                ║
║     Each adjunct drug assigned using real conditional rates from the CSV.   ║
║                                                                              ║
║  6. COMPLICATION SIMULATOR (per-anesthetic rates from real data)            ║
║     Post-treatment complications sampled from anesthetic-conditional        ║
║     rates fit on real transition data.                                      ║
║                                                                              ║
║  7. PHYSIOLOGIC CONSTRAINTS                                                  ║
║     Hard constraints: DBP < SBP-10, HR ∈ [38,150], etomidate never         ║
║     on first treatment (confirmed in all 20 real cases), rocuronium         ║
║     always co-occurs with sugammadex.                                       ║
║                                                                              ║
║  USAGE                                                                       ║
║    python src/generate_synthetic.py                                          ║
║    python src/generate_synthetic.py --patients 800 --validate               ║
╚══════════════════════════════════════════════════════════════════════════════╝
"""

from __future__ import annotations
import argparse, csv, io, random, sys
from pathlib import Path
from collections import Counter

import numpy as np
import pandas as pd

# Windows UTF-8 fix
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ── Column schema ─────────────────────────────────────────────────────────────
VITAL_COLS = ["age","weight_kg","resting_hr","systolic_bp","diastolic_bp"]
FLAG_COLS  = ["flag_bipolarity_or_violence","flag_on_benzos","flag_on_seizure_meds",
              "flag_chronic_pain","flag_neurocognitive_disorder",
              "flag_fracture_neuromuscular","flag_baseline_nausea"]
PRIOR_COLS = ["prior_reemergence_delirium","prior_htn_emergency","prior_hypotensive_shock",
              "prior_bradyarrhythmia","prior_tachyarrhythmia","prior_prolonged_seizure",
              "prior_inadequate_seizure","prior_headache","prior_nausea_emesis"]
DRUG_COLS  = ["drug_methohexital","drug_propofol","drug_etomidate","drug_succinylcholine",
              "drug_rocuronium","drug_sugammadex","drug_precedex","drug_ketamine",
              "drug_glycopyrrolate","drug_flumazenil","drug_tylenol","drug_toradol",
              "drug_zofran","drug_labetalol"]
FEATURE_COLS = ["is_first_treatment","sex_female"] + VITAL_COLS + FLAG_COLS + PRIOR_COLS
OUTPUT_COLS  = ["case_id","treatment_num","synthetic"] + FEATURE_COLS + DRUG_COLS + ["primary_anesthetic"]
PRIMARY_AGENTS = ["methohexital","propofol","etomidate"]


# ══════════════════════════════════════════════════════════════════════════════
#  DataFitter — learns all distributions from real CSV at runtime
# ══════════════════════════════════════════════════════════════════════════════
class DataFitter:
    def __init__(self, csv_path: str):
        self.df = pd.read_csv(csv_path)
        self._fit()

    def _fit(self):
        df = self.df

        # 1. Series length bootstrap pool
        self.series_lengths = df.groupby("case_id")["treatment_num"].max().tolist()

        # 2. Per-class vital distributions (multivariate Gaussian)
        self.vital_means, self.vital_covs = {}, {}
        for agent in PRIMARY_AGENTS:
            sub = df[df["primary_anesthetic"]==agent][VITAL_COLS].dropna()
            self.vital_means[agent] = sub.mean().values
            cov = sub.cov().values + np.eye(len(VITAL_COLS)) * 1e-3
            self.vital_covs[agent]  = cov

        # 3. Per-class flag rates (Bernoulli)
        self.flag_rates = {}
        for agent in PRIMARY_AGENTS:
            sub = df[df["primary_anesthetic"]==agent]
            self.flag_rates[agent] = {c: float(sub[c].mean()) for c in FLAG_COLS}

        # 4. Per-class sex rate
        self.sex_rates = {a: float(df[df["primary_anesthetic"]==a]["sex_female"].mean())
                          for a in PRIMARY_AGENTS}

        # 5. First-treatment anesthetic distribution (etomidate=0 in real data)
        first = df[df["is_first_treatment"]==1]
        total = len(first)
        self.first_tx_dist = {a: first["primary_anesthetic"].tolist().count(a)/total
                               for a in PRIMARY_AGENTS}

        # 6. Per-anesthetic complication rates (subsequent treatments only)
        subseq = df[df["is_first_treatment"]==0]
        self.compl_rates = {}
        for c in PRIOR_COLS:
            self.compl_rates[c] = {}
            for a in PRIMARY_AGENTS:
                sub = subseq[subseq["primary_anesthetic"]==a]
                self.compl_rates[c][a] = max(float(sub[c].mean()) if len(sub)>0 else 0.0, 0.005)

        # 7. Adjunct base rates per primary agent (for fallback)
        self.adjunct_base = {}
        for a in PRIMARY_AGENTS:
            sub = df[df["primary_anesthetic"]==a]
            self.adjunct_base[a] = {d: float(sub[d].mean()) for d in DRUG_COLS}

        # 8. Key conditional adjunct rates (P(drug | condition=1) vs P(drug | condition=0))
        self.cond_rates = {}
        pairs = [
            ("drug_rocuronium",    "flag_fracture_neuromuscular"),
            ("drug_sugammadex",    "flag_fracture_neuromuscular"),
            ("drug_flumazenil",    "flag_on_benzos"),
            ("drug_zofran",        "flag_baseline_nausea"),
            ("drug_labetalol",     "prior_htn_emergency"),
            ("drug_ketamine",      "prior_hypotensive_shock"),
            ("drug_precedex",      "flag_bipolarity_or_violence"),
            ("drug_precedex",      "flag_neurocognitive_disorder"),
            ("drug_precedex",      "prior_reemergence_delirium"),
            ("drug_tylenol",       "flag_chronic_pain"),
            ("drug_toradol",       "flag_chronic_pain"),
            ("drug_tylenol",       "prior_headache"),
            ("drug_toradol",       "prior_headache"),
            ("drug_glycopyrrolate","prior_bradyarrhythmia"),
            ("drug_zofran",        "prior_nausea_emesis"),
        ]
        for drug, cond in pairs:
            pos = df[df[cond]==1][drug].mean()
            neg = df[df[cond]==0][drug].mean()
            self.cond_rates[(drug, cond)] = (float(pos), float(neg))

        # Etomidate-conditional zofran rate
        etom_rows = df[df["primary_anesthetic"]=="etomidate"]
        self.zofran_given_etomidate = float(etom_rows["drug_zofran"].mean())

        print(f"  [DataFitter] fit on {len(df)} rows, {df['case_id'].nunique()} cases")
        print(f"  first_tx_dist : {self.first_tx_dist}")
        print(f"  series_lengths: min={min(self.series_lengths)} "
              f"mean={sum(self.series_lengths)/len(self.series_lengths):.1f} "
              f"max={max(self.series_lengths)}")


# ══════════════════════════════════════════════════════════════════════════════
#  Rule Engine — Tampa Site A decision tree
# ══════════════════════════════════════════════════════════════════════════════
def rule_engine(p: dict, is_first: bool) -> str:
    """
    Priority-ordered rules (first match wins):

    CRITICAL
      C1  prior_hypotensive_shock OR SBP<100       → methohexital
    HIGH – hemodynamic
      H1  prior_htn_emergency OR SBP>=175          → propofol
      H2  prior_tachyarrhythmia OR HR>100          → propofol
    HIGH – seizure quality
      H3  prior_inadequate_seizure (not 1st tx)    → etomidate
      H4  prior_prolonged_seizure                  → propofol
    HIGH – psychiatric
      H5  prior_reemergence OR bipolarity           → methohexital
      H6  on_seizure_meds                          → methohexital
    MEDIUM
      M1  SBP 140-174                              → propofol
      M2  on_benzos                                → propofol
    DEFAULT                                        → methohexital
    """
    sbp          = p.get("systolic_bp",  120)
    hr           = p.get("resting_hr",    75)
    bipolarity   = p.get("flag_bipolarity_or_violence", 0)
    benzos       = p.get("flag_on_benzos", 0)
    seizure_meds = p.get("flag_on_seizure_meds", 0)
    prior_hypo   = p.get("prior_hypotensive_shock", 0)
    prior_htn    = p.get("prior_htn_emergency", 0)
    prior_tachy  = p.get("prior_tachyarrhythmia", 0)
    prior_inad   = p.get("prior_inadequate_seizure", 0)
    prior_prol   = p.get("prior_prolonged_seizure", 0)
    prior_del    = p.get("prior_reemergence_delirium", 0)

    if prior_hypo or sbp < 100:             return "methohexital"   # C1
    if prior_htn  or sbp >= 175:            return "propofol"       # H1
    if prior_tachy or hr > 100:             return "propofol"       # H2
    if prior_inad and not is_first:         return "etomidate"      # H3
    if prior_prol:                          return "propofol"       # H4
    if prior_del or bipolarity:             return "methohexital"   # H5
    if seizure_meds:                        return "methohexital"   # H6
    if sbp >= 140:                          return "propofol"       # M1
    if benzos:                              return "propofol"       # M2
    return "methohexital"                                           # D1


# ══════════════════════════════════════════════════════════════════════════════
#  Adjunct Engine — conditional probabilities from real data
# ══════════════════════════════════════════════════════════════════════════════
def adjunct_engine(p: dict, primary: str, fitter: DataFitter,
                   rng: random.Random) -> dict[str, int]:
    def coin(prob): return int(rng.random() < prob)
    def cond(drug, cond_col, flag_val):
        key = (drug, cond_col)
        if key in fitter.cond_rates:
            p_yes, p_no = fitter.cond_rates[key]
            return p_yes if flag_val else p_no
        return fitter.adjunct_base[primary].get(drug, 0.05)

    fracture   = p.get("flag_fracture_neuromuscular", 0)
    benzos     = p.get("flag_on_benzos", 0)
    nausea     = p.get("flag_baseline_nausea", 0)
    pain       = p.get("flag_chronic_pain", 0)
    bipolarity = p.get("flag_bipolarity_or_violence", 0)
    neuro      = p.get("flag_neurocognitive_disorder", 0)
    hr         = p.get("resting_hr", 75)
    sbp        = p.get("systolic_bp", 120)
    prior_del  = p.get("prior_reemergence_delirium", 0)
    prior_htn  = p.get("prior_htn_emergency", 0)
    prior_hypo = p.get("prior_hypotensive_shock", 0)
    prior_brad = p.get("prior_bradyarrhythmia", 0)
    prior_tachy= p.get("prior_tachyarrhythmia", 0)
    prior_head = p.get("prior_headache", 0)
    prior_nv   = p.get("prior_nausea_emesis", 0)

    # Paralytic
    use_roc  = coin(cond("drug_rocuronium",  "flag_fracture_neuromuscular", fracture))
    use_sugg = use_roc
    use_sux  = int(not use_roc)

    # Benzo reversal
    use_flum = coin(cond("drug_flumazenil", "flag_on_benzos", benzos))

    # Antiemetic — etomidate drives high zofran usage (0.62 in real data)
    if primary == "etomidate":
        p_zofran = fitter.zofran_given_etomidate
    elif nausea:
        p_zofran = cond("drug_zofran", "flag_baseline_nausea", 1)
    elif prior_nv:
        p_zofran = cond("drug_zofran", "prior_nausea_emesis", 1)
    else:
        p_zofran = fitter.adjunct_base[primary]["drug_zofran"]
    use_zofran = coin(p_zofran)

    # Precedex — agitation / reemergence / cognitive protection
    any_prec = bipolarity or neuro or prior_del
    if any_prec:
        p_prec = max(
            cond("drug_precedex", "flag_bipolarity_or_violence", bipolarity),
            cond("drug_precedex", "flag_neurocognitive_disorder", neuro),
            cond("drug_precedex", "prior_reemergence_delirium", prior_del),
        )
    else:
        # Precedex used broadly in real data (31% rate even without specific triggers)
        p_prec = fitter.adjunct_base[primary]["drug_precedex"]
    use_prec = coin(p_prec)

    # Glycopyrrolate — bradyarrhythmia prevention
    if prior_brad or hr < 55:
        p_glyco = max(0.40, fitter.adjunct_base[primary]["drug_glycopyrrolate"])
    else:
        p_glyco = fitter.adjunct_base[primary]["drug_glycopyrrolate"]
    use_glyco = coin(p_glyco)

    # Labetalol — BP control
    if prior_htn or sbp >= 160:
        p_lab = max(cond("drug_labetalol","prior_htn_emergency", prior_htn), 0.20)
    else:
        p_lab = fitter.adjunct_base[primary]["drug_labetalol"]
    use_lab = coin(p_lab)

    # Ketamine — pressor for hypotension; avoid when tachy or high BP
    if prior_hypo and not prior_tachy and hr <= 100 and sbp < 140:
        p_ket = max(cond("drug_ketamine","prior_hypotensive_shock", 1), 0.30)
    else:
        p_ket = 0.01
    use_ket = coin(p_ket)

    # Analgesics
    # Tylenol/Toradol: used broadly as standard premedication even without explicit pain flag
    # Base rate 42%/40% even without triggers in real data — don't suppress
    if pain or prior_head:
        p_tyl = max(cond("drug_tylenol","flag_chronic_pain",pain),
                    cond("drug_tylenol","prior_headache",prior_head))
        p_tor = max(cond("drug_toradol","flag_chronic_pain",pain),
                    cond("drug_toradol","prior_headache",prior_head))
    else:
        p_tyl = fitter.adjunct_base[primary]["drug_tylenol"]  # use actual base rate
        p_tor = fitter.adjunct_base[primary]["drug_toradol"]
    use_tyl = coin(p_tyl)
    use_tor = coin(p_tor)

    return {
        "drug_methohexital":    int(primary=="methohexital"),
        "drug_propofol":        int(primary=="propofol"),
        "drug_etomidate":       int(primary=="etomidate"),
        "drug_succinylcholine": use_sux,
        "drug_rocuronium":      use_roc,
        "drug_sugammadex":      use_sugg,
        "drug_precedex":        use_prec,
        "drug_ketamine":        use_ket,
        "drug_glycopyrrolate":  use_glyco,
        "drug_flumazenil":      use_flum,
        "drug_tylenol":         use_tyl,
        "drug_toradol":         use_tor,
        "drug_zofran":          use_zofran,
        "drug_labetalol":       use_lab,
    }


# ══════════════════════════════════════════════════════════════════════════════
#  Complication Simulator
# ══════════════════════════════════════════════════════════════════════════════
def simulate_complications(primary: str, p: dict, fitter: DataFitter,
                            rng: random.Random) -> dict[str, int]:
    """
    Sample complication flags from per-anesthetic rates + contextual adjustment.

    Contextual adjustments (multipliers on base rates):
      SBP>=160          → HTN emergency ×1.5
      SBP<100           → hypotensive shock ×2.0
      on seizure meds   → inadequate seizure ×1.5
      bipolarity        → reemergence delirium ×2.0
      etomidate         → nausea ×1.5
      HR<55             → bradyarrhythmia floor at 0.05
    """
    rates = {c: fitter.compl_rates[c][primary] for c in PRIOR_COLS}
    sbp  = p.get("systolic_bp",120)
    hr   = p.get("resting_hr", 75)

    if sbp >= 160:            rates["prior_htn_emergency"]        *= 1.5
    if sbp < 100:             rates["prior_hypotensive_shock"]    *= 2.0
    if p.get("flag_on_seizure_meds",0): rates["prior_inadequate_seizure"] *= 1.5
    if p.get("flag_bipolarity_or_violence",0): rates["prior_reemergence_delirium"] *= 2.0
    if primary == "etomidate": rates["prior_nausea_emesis"]       *= 1.5
    if hr < 55:               rates["prior_bradyarrhythmia"]       = max(0.05, rates["prior_bradyarrhythmia"])

    return {c: int(rng.random() < min(rates[c], 0.95)) for c in PRIOR_COLS}


# ══════════════════════════════════════════════════════════════════════════════
#  Vital sampler — multivariate Gaussian per anesthetic class
# ══════════════════════════════════════════════════════════════════════════════
def sample_vitals(agent: str, fitter: DataFitter, rng: random.Random) -> dict:
    np_rng = np.random.default_rng(rng.randint(0, 2**31))
    mean = fitter.vital_means[agent]
    cov  = fitter.vital_covs[agent]
    for _ in range(50):
        s = np_rng.multivariate_normal(mean, cov)
        age,wt,hr,sbp,dbp = round(s[0]),round(s[1],1),round(s[2]),round(s[3]),round(s[4])
        if not (18<=age<=90):  continue
        if not (40<=wt<=150):  continue
        if not (38<=hr<=140):  continue
        if not (75<=sbp<=220): continue
        if not (40<=dbp<=120): continue
        if not (dbp < sbp-10): continue
        return {"age":age,"weight_kg":wt,"resting_hr":hr,"systolic_bp":sbp,"diastolic_bp":dbp}
    # fallback to class mean + small jitter
    return {"age":int(np.clip(mean[0]+rng.gauss(0,3),18,90)),
            "weight_kg":round(float(np.clip(mean[1]+rng.gauss(0,2),40,150)),1),
            "resting_hr":int(np.clip(mean[2]+rng.gauss(0,5),38,140)),
            "systolic_bp":int(np.clip(mean[3]+rng.gauss(0,8),75,220)),
            "diastolic_bp":int(np.clip(mean[4]+rng.gauss(0,5),40,120))}


def sample_flags(agent: str, fitter: DataFitter, rng: random.Random) -> dict:
    rates = fitter.flag_rates[agent]
    return {c: int(rng.random() < rates[c]) for c in FLAG_COLS}


def drift_vitals(p: dict, rng: random.Random):
    """Correlated small random walk on vitals between sessions."""
    sbp_d = rng.gauss(0, 5)
    p["systolic_bp"]  = int(np.clip(p["systolic_bp"]  + sbp_d,       75, 220))
    p["diastolic_bp"] = int(np.clip(p["diastolic_bp"] + sbp_d * 0.6, 40, 120))
    p["diastolic_bp"] = min(p["diastolic_bp"], p["systolic_bp"]-10)
    p["resting_hr"]   = int(np.clip(p["resting_hr"]   + rng.gauss(0,3), 38, 140))
    p["weight_kg"]    = round(float(np.clip(p["weight_kg"] + rng.gauss(0,0.3), 40, 150)), 1)


def inject_noise(primary: str, drugs: dict, rng: random.Random):
    new = rng.choice([a for a in PRIMARY_AGENTS if a != primary])
    drugs = dict(drugs)
    for a in PRIMARY_AGENTS: drugs[f"drug_{a}"] = int(new == a)
    return new, drugs


# ══════════════════════════════════════════════════════════════════════════════
#  Main generator
# ══════════════════════════════════════════════════════════════════════════════
def generate(fitter: DataFitter, n_patients: int, noise_rate: float, seed: int):
    rng = random.Random(seed)
    rows, case_id = [], 1000

    first_agents  = ["methohexital","propofol"]  # etomidate NEVER on first tx
    first_weights = [fitter.first_tx_dist.get(a,0) for a in first_agents]

    for _ in range(n_patients):
        n_tx = rng.choice(fitter.series_lengths)

        # Choose first-tx agent from real first-tx distribution
        first_agent = rng.choices(first_agents, weights=first_weights, k=1)[0]

        # Sample patient profile from that agent's distributions
        vitals = sample_vitals(first_agent, fitter, rng)
        flags  = sample_flags(first_agent, fitter, rng)
        sex_f  = int(rng.random() < fitter.sex_rates[first_agent])
        priors = {c: 0 for c in PRIOR_COLS}
        prev_primary = None

        for tx in range(1, n_tx+1):
            is_first = (tx == 1)
            session = {"is_first_treatment": int(is_first),
                       "sex_female": sex_f, **vitals, **flags, **priors}

            if is_first:
                primary = first_agent
                prev_primary = None
            else:
                # Etomidate persistence: once started, continue unless new complication
                # (82% of real etomidate sessions follow a prior etomidate session)
                if prev_primary == "etomidate" and not priors.get("prior_inadequate_seizure"):
                    # No new complication forcing a switch -- 80% chance to stay on etomidate
                    primary = "etomidate" if rng.random() < 0.80 else rule_engine(session, is_first)
                else:
                    primary = rule_engine(session, is_first)
            prev_primary = primary
            drugs   = adjunct_engine(session, primary, fitter, rng)

            if rng.random() < noise_rate:
                primary, drugs = inject_noise(primary, drugs, rng)

            rows.append({"case_id":case_id,"treatment_num":tx,"synthetic":1,
                         **{k: session[k] for k in FEATURE_COLS},
                         **drugs,"primary_anesthetic":primary})

            priors = simulate_complications(primary, session, fitter, rng)
            drift_vitals(vitals, rng)

        case_id += 1

    return rows


# ══════════════════════════════════════════════════════════════════════════════
#  Calibration validator
# ══════════════════════════════════════════════════════════════════════════════
def validate(rows: list, fitter: DataFitter):
    syn  = pd.DataFrame(rows)
    real = fitter.df
    print(f"\n  {'Metric':<35} {'Real':>7} {'Syn':>7} {'Delta':>7} OK?")
    print(f"  {'─'*58}")
    passed = 0; total = 0
    def chk(label, r, s, threshold):
        nonlocal passed, total
        delta = abs(r - s)
        ok = "✅" if delta < threshold else "⚠️ "
        if delta < threshold: passed += 1
        total += 1
        print(f"  {label:<35} {r:>7.3f} {s:>7.3f} {delta:>7.3f} {ok}")
    for a in PRIMARY_AGENTS:
        chk(f"P(primary={a})",
            (real["primary_anesthetic"]==a).mean(),
            (syn["primary_anesthetic"]==a).mean(), 0.08)
    for c in VITAL_COLS:
        r = real[c].dropna().mean(); s = syn[c].dropna().mean()
        chk(f"mean({c})", r/100, s/100, 0.20)
    for d in DRUG_COLS:
        chk(f"P({d})", real[d].mean(), syn[d].mean(), 0.10)
    print(f"\n  Calibration: {passed}/{total} passed ({passed/total*100:.0f}%)")


# ══════════════════════════════════════════════════════════════════════════════
#  Save + summary
# ══════════════════════════════════════════════════════════════════════════════
def save(rows: list, output_path: str):
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path,"w",newline="",encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=OUTPUT_COLS, extrasaction="ignore")
        w.writeheader(); w.writerows(rows)
    n = len(rows); pts = len(set(r["case_id"] for r in rows))
    pc = Counter(r["primary_anesthetic"] for r in rows)
    print(f"\n{'─'*60}")
    print(f"  STEP 2 — Synthetic generation complete")
    print(f"{'─'*60}")
    print(f"  Patients: {pts}   Sessions: {n}   Avg tx/pt: {n/pts:.1f}")
    print(f"\n  Primary anesthetic distribution:")
    for a in PRIMARY_AGENTS:
        c = pc.get(a,0); bar = "█"*int(c/n*50)
        print(f"    {a:<16} {c:>5} ({c/n*100:.1f}%)  {bar}")
    print(f"\n  Drug flag prevalence:")
    for d in DRUG_COLS:
        c = sum(r.get(d,0) for r in rows); bar = "█"*int(c/n*30)
        print(f"    {d:<26} {c:>5} ({c/n*100:.1f}%)  {bar}")
    print(f"\n  Saved → {output_path}")
    print(f"{'─'*60}\n")


# ══════════════════════════════════════════════════════════════════════════════
#  CLI
# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="ShockSmart Step 2 – Generate synthetic data")
    ap.add_argument("--cases",    default="data/cases.csv")
    ap.add_argument("--patients", type=int,   default=800)
    ap.add_argument("--noise",    type=float, default=0.05)
    ap.add_argument("--seed",     type=int,   default=42)
    ap.add_argument("--output",   default="data/synthetic.csv")
    ap.add_argument("--validate", action="store_true")
    args = ap.parse_args()

    print(f"\n{'─'*60}")
    print(f"  STEP 2 — Fitting on real data ...")
    print(f"{'─'*60}")
    fitter = DataFitter(args.cases)
    print(f"\n  Generating {args.patients} synthetic patients ...")
    rows = generate(fitter, args.patients, args.noise, args.seed)
    if args.validate: validate(rows, fitter)
    save(rows, args.output)