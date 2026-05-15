"""
backend/main.py
FastAPI server that loads the trained ShockSmart Random Forest model
and exposes a /predict endpoint.

Deploy this to Render.com (free tier).
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import joblib
import numpy as np
import pandas as pd
import os

app = FastAPI(title="ShockSmart API", version="1.0")

# Allow requests from Vercel frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://shock-smart.com", "https://www.shock-smart.com",
                   "http://localhost:5173"],   # Vite dev server
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# ── Load model on startup ─────────────────────────────────────────────────────
MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "rf_small.pkl")
bundle     = joblib.load(MODEL_PATH)
MODEL      = bundle["model"]
LE         = bundle["label_encoder"]
FEATURES   = bundle["features"]
MEDIANS    = bundle["medians"]

RAW_FEATURES = [
    "is_first_treatment", "age", "sex_female", "weight_kg",
    "resting_hr", "systolic_bp", "diastolic_bp",
    "flag_bipolarity_or_violence", "flag_on_benzos", "flag_on_seizure_meds",
    "flag_chronic_pain", "flag_neurocognitive_disorder",
    "flag_fracture_neuromuscular", "flag_baseline_nausea",
    "prior_reemergence_delirium", "prior_htn_emergency",
    "prior_hypotensive_shock", "prior_bradyarrhythmia",
    "prior_tachyarrhythmia", "prior_prolonged_seizure",
    "prior_inadequate_seizure", "prior_headache", "prior_nausea_emesis",
]


def engineer(raw: dict) -> pd.DataFrame:
    """Apply the same feature engineering used during training."""
    d = pd.Series({k: raw.get(k, MEDIANS.get(k, 0)) for k in RAW_FEATURES})

    d["R_C1"] = int((d["prior_hypotensive_shock"] == 1) or (d["systolic_bp"] < 100))
    d["R_H1"] = int((d["prior_htn_emergency"] == 1)     or (d["systolic_bp"] >= 175))
    d["R_H2"] = int((d["prior_tachyarrhythmia"] == 1)   or (d["resting_hr"] > 100))
    d["R_H3"] = int((d["prior_inadequate_seizure"] == 1) and (d["is_first_treatment"] == 0))
    d["R_H4"] = int(d["prior_prolonged_seizure"] == 1)
    d["R_H5"] = int((d["prior_reemergence_delirium"] == 1) or (d["flag_bipolarity_or_violence"] == 1))
    d["R_H6"] = int(d["flag_on_seizure_meds"] == 1)
    d["R_M1"] = int((d["systolic_bp"] >= 140) and (d["systolic_bp"] < 175))
    d["R_M2"] = int(d["flag_on_benzos"] == 1)

    d["high_bp"]         = int(d["systolic_bp"] >= 140)
    d["very_high_bp"]    = int(d["systolic_bp"] >= 175)
    d["tachycardic"]     = int(d["resting_hr"] > 100)
    d["bradycardic"]     = int(d["resting_hr"] < 55)
    d["inad_not_first"]  = d["prior_inadequate_seizure"] * (1 - d["is_first_treatment"])
    d["any_prior"]       = int(any(d[c] for c in [
        "prior_reemergence_delirium", "prior_htn_emergency",
        "prior_hypotensive_shock", "prior_tachyarrhythmia", "prior_inadequate_seizure"
    ]))
    d["propofol_push"]   = d["R_H1"] + d["R_H2"] + d["R_H4"] + d["R_M1"] + d["R_M2"]
    d["methohex_push"]   = d["R_C1"] + d["R_H5"] + d["R_H6"]
    d["elderly"]         = int(d["age"] >= 65)
    d["young"]           = int(d["age"] < 35)

    for col in ["systolic_bp", "resting_hr", "age", "weight_kg", "diastolic_bp"]:
        mu  = MEDIANS.get(col, d[col])
        std = MEDIANS.get(f"{col}_std", 1.0)
        d[f"{col}_z"] = (d[col] - mu) / (std + 1e-6)

    return pd.DataFrame([d[FEATURES]])


# ── Request / response models ─────────────────────────────────────────────────
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
    X = engineer(patient.dict())
    pred_enc   = MODEL.predict(X)[0]
    pred_label = LE.inverse_transform([pred_enc])[0]
    proba      = MODEL.predict_proba(X)[0]
    proba_dict = {cls: round(float(p), 4) for cls, p in zip(LE.classes_, proba)}
    # Sort by probability descending
    proba_sorted = dict(sorted(proba_dict.items(), key=lambda x: -x[1]))
    return {
        "primary_anesthetic": pred_label,
        "probabilities": proba_sorted,
        "confidence": round(float(proba_dict[pred_label]) * 100, 1),
    }
