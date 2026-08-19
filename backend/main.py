import json
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="ShockSmart API", version="2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

FOREST_PATH = os.path.join(os.path.dirname(__file__), "forest.json")
with open(FOREST_PATH) as f:
    FOREST = json.load(f)

TREES = FOREST["trees"]
CLASSES = FOREST["classes"]
FEATURES = FOREST["features"]
MEDIANS = FOREST["medians"]


def walk_tree(node, x):
    if node["leaf"]:
        return node["values"]
    feat_val = x.get(node["feature"], MEDIANS.get(node["feature"], 0.0))
    if feat_val <= node["threshold"]:
        return walk_tree(node["left"], x)
    else:
        return walk_tree(node["right"], x)


def predict_proba(x):
    totals = [0.0] * len(CLASSES)
    for tree in TREES:
        leaf_values = walk_tree(tree, x)
        total = sum(leaf_values)
        if total > 0:
            for i, v in enumerate(leaf_values):
                totals[i] += v / total
    n_trees = len(TREES)
    probs = [t / n_trees for t in totals]
    return dict(zip(CLASSES, probs))


def build_features(raw):
    x = {f: float(raw.get(f, MEDIANS.get(f, 0.0))) for f in FEATURES
         if f not in ("prior_was_methohexital", "prior_was_propofol", "prior_was_etomidate")}
    prior_drug = raw.get("prior_drug", "")
    x["prior_was_methohexital"] = 1.0 if prior_drug == "methohexital" else 0.0
    x["prior_was_propofol"] = 1.0 if prior_drug == "propofol" else 0.0
    x["prior_was_etomidate"] = 1.0 if prior_drug == "etomidate" else 0.0
    return x


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
    prior_drug: str = ""


@app.get("/")
def root():
    return {"status": "ShockSmart API running", "version": "2.0",
            "model": "50-tree Random Forest, trained on 186 real ECT sessions",
            "loco_accuracy": 0.849}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/predict")
def predict(patient: PatientInput):
    raw = patient.dict()
    x = build_features(raw)
    probs = predict_proba(x)
    primary = max(probs, key=probs.get)
    probs_sorted = dict(sorted(probs.items(), key=lambda kv: -kv[1]))
    return {
        "primary_anesthetic": primary,
        "probabilities": {k: round(v, 4) for k, v in probs_sorted.items()},
        "confidence": round(probs[primary] * 100, 1),
    }