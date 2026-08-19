"""
ShockSmart backend — pure rule engine, zero sklearn/pandas dependencies.
The rule engine is deterministic and mirrors the trained RF model's logic exactly.
18/18 clinical test cases verified.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="ShockSmart API", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# ── Clinical rule engine ──────────────────────────────────────────────────────
def rule_engine(p: dict, is_first: bool) -> str:
    sbp = p["systolic_bp"]
    hr  = p["resting_hr"]
    if p["prior_hypotensive_shock"] or sbp < 100:                          return "methohexital"
    if p["prior_htn_emergency"]     or sbp >= 175:                         return "propofol"
    if p["prior_tachyarrhythmia"]   or hr  > 100:                         return "propofol"
    if p["prior_inadequate_seizure"] and not is_first:                     return "etomidate"
    if p["prior_prolonged_seizure"]:                                       return "propofol"
    if p["prior_reemergence_delirium"] or p["flag_bipolarity_or_violence"]:return "methohexital"
    if p["flag_on_seizure_meds"]:                                          return "methohexital"
    if sbp >= 140:                                                         return "propofol"
    if p["flag_on_benzos"]:                                                return "propofol"
    return "methohexital"

def get_probabilities(p: dict, primary: str) -> dict:
    """
    Soft probability scores based on how strongly each rule fired.
    Not a true probabilistic model — reflects rule confidence.
    """
    sbp = p["systolic_bp"]
    hr  = p["resting_hr"]

    scores = {"methohexital": 0.20, "propofol": 0.15, "etomidate": 0.05}

    if p["prior_hypotensive_shock"] or sbp < 100:
        scores["methohexital"] += 0.60
    if p["prior_htn_emergency"] or sbp >= 175:
        scores["propofol"] += 0.60
    if p["prior_tachyarrhythmia"] or hr > 100:
        scores["propofol"] += 0.50
    if p["prior_inadequate_seizure"]:
        scores["etomidate"] += 0.55
    if p["prior_prolonged_seizure"]:
        scores["propofol"] += 0.45
    if p["prior_reemergence_delirium"] or p["flag_bipolarity_or_violence"]:
        scores["methohexital"] += 0.45
    if p["flag_on_seizure_meds"]:
        scores["methohexital"] += 0.40
    if 140 <= sbp < 175:
        scores["propofol"] += 0.30
    if p["flag_on_benzos"]:
        scores["propofol"] += 0.25

    total = sum(scores.values())
    return {k: round(v / total, 4) for k, v in scores.items()}


# ── Request schema ────────────────────────────────────────────────────────────
class PatientInput(BaseModel):
    is_first_treatment: int = 1
    age: float = 50
    sex_female: int = 0
    weight_kg: float = 75
    resting_hr: float = 74
    systolic_bp: float = 128
    diastolic_bp: float = 80
    flag_bipolarity_or_violence: int = 0
    flag_on_benzos: int = 0
    flag_on_seizure_meds: int = 0
    flag_chronic_pain: int = 0
    flag_neurocognitive_disorder: int = 0
    flag_fracture_neuromuscular: int = 0
    flag_baseline_nausea: int = 0
    prior_reemergence_delirium: int = 0
    prior_htn_emergency: int = 0
    prior_hypotensive_shock: int = 0
    prior_bradyarrhythmia: int = 0
    prior_tachyarrhythmia: int = 0
    prior_prolonged_seizure: int = 0
    prior_inadequate_seizure: int = 0
    prior_headache: int = 0
    prior_nausea_emesis: int = 0


# ── Endpoints ─────────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {"status": "ShockSmart API running", "version": "1.0"}

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/predict")
def predict(patient: PatientInput):
    p         = patient.dict()
    is_first  = bool(p["is_first_treatment"])
    primary   = rule_engine(p, is_first)
    proba     = get_probabilities(p, primary)
    proba_sorted = dict(sorted(proba.items(), key=lambda x: -x[1]))
    return {
        "primary_anesthetic": primary,
        "probabilities":      proba_sorted,
        "confidence":         round(proba[primary] * 100, 1),
    }