import { useState, useEffect, useCallback } from "react";

// ── API ───────────────────────────────────────────────────────────────────────
const API_URL = import.meta.env.VITE_API_URL || "https://shocksmart-api.onrender.com";

// ── Client-side rule engine fallback (used if Render is asleep/unreachable) ───
function ruleEngineFallback(vitals, flags, isFirst, priorDrug) {
  const sbp = vitals.systolic_bp, hr = vitals.resting_hr;

  if (flags.prior_hypotensive_shock || sbp < 100) return "methohexital";
  if (flags.prior_htn_emergency || sbp >= 175)    return "propofol";
  if (flags.prior_tachyarrhythmia || hr > 100)    return "propofol";
  if (flags.prior_inadequate_seizure && !isFirst)  return "etomidate";
  if (flags.prior_prolonged_seizure)               return "propofol";

  if (!isFirst && priorDrug) return priorDrug;

  if (flags.prior_reemergence_delirium || flags.flag_bipolarity_or_violence) return "methohexital";
  if (flags.flag_on_seizure_meds) return "methohexital";
  if (sbp >= 140) return "propofol";
  if (flags.flag_on_benzos) return "propofol";
  return "methohexital";
}

function getCocktail(vitals, flags, primary) {
  const sbp = vitals.systolic_bp, hr = vitals.resting_hr;
  const d = [primary.charAt(0).toUpperCase() + primary.slice(1)];
  if (flags.flag_fracture_neuromuscular) { d.push("Rocuronium"); d.push("Sugammadex"); }
  else d.push("Succinylcholine");
  if (flags.flag_bipolarity_or_violence || flags.flag_neurocognitive_disorder || flags.prior_reemergence_delirium) d.push("Precedex");
  if (flags.flag_on_benzos) d.push("Flumazenil");
  if (flags.flag_baseline_nausea || flags.prior_nausea_emesis || primary === "etomidate") d.push("Ondansetron");
  if (flags.flag_chronic_pain || flags.prior_headache) d.push("Acetaminophen");
  if (flags.flag_chronic_pain && flags.prior_headache) d.push("Ketorolac");
  if (flags.prior_htn_emergency || sbp >= 160) d.push("Labetalol");
  if (flags.prior_bradyarrhythmia || hr < 55) d.push("Glycopyrrolate");
  if (flags.prior_hypotensive_shock && !flags.prior_tachyarrhythmia && hr <= 100 && sbp < 140) d.push("Ketamine");
  return d;
}

function getFiredRules(vitals, flags, isFirst, priorDrug, primary) {
  const sbp = vitals.systolic_bp, hr = vitals.resting_hr;
  const r = [];

  if (flags.prior_hypotensive_shock || sbp < 100) r.push({ id: "C1", t: "Hypotension risk — Methohexital (BP-neutral)" });
  if (flags.prior_htn_emergency || sbp >= 175)    r.push({ id: "H1", t: "Hypertensive emergency — Propofol (vasodilatory)" });
  if (flags.prior_tachyarrhythmia || hr > 100)    r.push({ id: "H2", t: "Tachyarrhythmia — Propofol (lowers HR)" });
  if (flags.prior_inadequate_seizure && !isFirst)  r.push({ id: "H3", t: "Prior inadequate seizure — Etomidate" });
  if (flags.prior_prolonged_seizure)               r.push({ id: "H4", t: "Prolonged seizure — Propofol (raises threshold)" });

  const highFired = r.length > 0;
  if (!highFired && !isFirst && priorDrug) {
    r.push({ id: "PERSIST", t: `Patient was stable on ${priorDrug} last session — continuity favored (strongest signal in the trained model, 84.9% LOCO accuracy)` });
  }

  if (flags.prior_reemergence_delirium || flags.flag_bipolarity_or_violence) r.push({ id: "H5", t: "Reemergence / agitation risk — Precedex added" });
  if (flags.flag_on_seizure_meds) r.push({ id: "H6", t: "On AED — Methohexital preferred" });
  if (flags.flag_fracture_neuromuscular) r.push({ id: "ADJ", t: "Fracture/neuromuscular — Rocuronium + Sugammadex replacing Succinylcholine" });
  if (flags.flag_on_benzos) r.push({ id: "ADJ", t: "On benzodiazepines — Flumazenil added" });
  if (flags.flag_baseline_nausea || flags.prior_nausea_emesis || primary === "etomidate") r.push({ id: "ADJ", t: "Nausea risk — Ondansetron added" });
  if (flags.flag_chronic_pain || flags.prior_headache) r.push({ id: "ADJ", t: "Pain/headache history — Acetaminophen added" });
  if (flags.prior_htn_emergency || sbp >= 160) r.push({ id: "ADJ", t: "HTN risk — Labetalol added" });
  if (flags.prior_bradyarrhythmia || hr < 55) r.push({ id: "ADJ", t: "Bradycardia risk — Glycopyrrolate added" });

  if (r.length === 0) r.push({ id: "D1", t: "No contraindications identified — Methohexital (default)" });
  return r;
}

const AGENT_COLOR = { methohexital: "#1a5c1a", propofol: "#1a3a7a", etomidate: "#7a1a1a" };

const DEFAULT_VITALS = { age: 52, weight_kg: 78, resting_hr: 74, systolic_bp: 128, diastolic_bp: 80 };
const DEFAULT_FLAGS = {
  flag_bipolarity_or_violence: 0, flag_on_benzos: 0, flag_on_seizure_meds: 0,
  flag_chronic_pain: 0, flag_neurocognitive_disorder: 0, flag_fracture_neuromuscular: 0,
  flag_baseline_nausea: 0, prior_reemergence_delirium: 0, prior_htn_emergency: 0,
  prior_hypotensive_shock: 0, prior_bradyarrhythmia: 0, prior_tachyarrhythmia: 0,
  prior_prolonged_seizure: 0, prior_inadequate_seizure: 0, prior_headache: 0, prior_nausea_emesis: 0,
};

const FLAG_DEFS = [
  { label: "Bipolarity / Violence Hx",  field: "flag_bipolarity_or_violence", prior: false, effect: "primary" },
  { label: "On Seizure Medications",     field: "flag_on_seizure_meds",        prior: false, effect: "primary" },
  { label: "On Benzodiazepines",         field: "flag_on_benzos",              prior: false, effect: "both"    },
  { label: "Chronic Pain",               field: "flag_chronic_pain",           prior: false, effect: "adjunct" },
  { label: "Neurocognitive Disorder",    field: "flag_neurocognitive_disorder",prior: false, effect: "adjunct" },
  { label: "Fracture / Neuromuscular",   field: "flag_fracture_neuromuscular", prior: false, effect: "adjunct" },
  { label: "Baseline Nausea",            field: "flag_baseline_nausea",        prior: false, effect: "adjunct" },
  { label: "Prior HTN Emergency",        field: "prior_htn_emergency",         prior: true,  effect: "primary" },
  { label: "Prior Hypotensive Shock",    field: "prior_hypotensive_shock",     prior: true,  effect: "primary" },
  { label: "Prior Tachyarrhythmia",      field: "prior_tachyarrhythmia",       prior: true,  effect: "primary" },
  { label: "Prior Inadequate Seizure",   field: "prior_inadequate_seizure",    prior: true,  effect: "primary" },
  { label: "Prior Prolonged Seizure",    field: "prior_prolonged_seizure",     prior: true,  effect: "primary" },
  { label: "Prior Reemergence Delirium", field: "prior_reemergence_delirium",  prior: true,  effect: "both"    },
  { label: "Prior Bradyarrhythmia",      field: "prior_bradyarrhythmia",       prior: true,  effect: "adjunct" },
  { label: "Prior Headache",             field: "prior_headache",              prior: true,  effect: "adjunct" },
  { label: "Prior Nausea / Emesis",      field: "prior_nausea_emesis",         prior: true,  effect: "adjunct" },
];

// ─────────────────────────────────────────────────────────────────────────────
//  LANDING
// ─────────────────────────────────────────────────────────────────────────────
function Landing({ onLaunch, onDocs }) {
  return (
    <div style={{ minHeight: "100vh", background: "#ffffff", fontFamily: "'Segoe UI', Arial, sans-serif", display: "flex", flexDirection: "column" }}>
      <div style={{ background: "#1a3a7a", padding: "12px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ color: "white", fontSize: 15, fontWeight: 600, letterSpacing: "0.02em" }}>ShockSmart</div>
        <button onClick={onDocs} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.4)", color: "rgba(255,255,255,0.85)", padding: "5px 14px", borderRadius: 4, fontSize: 12, cursor: "pointer" }}>
          Documentation
        </button>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 24px 40px" }}>
        <div style={{ maxWidth: 560, textAlign: "center" }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.12em", color: "#6b7280", marginBottom: 14, textTransform: "uppercase" }}>
            ECT Anesthetic Decision Support
          </div>
          <h1 style={{ fontSize: 36, fontWeight: 700, color: "#111827", marginBottom: 16, marginTop: 0, lineHeight: 1.2 }}>
            ShockSmart
          </h1>
          <p style={{ fontSize: 15, color: "#4b5563", lineHeight: 1.8, marginBottom: 32, marginTop: 0 }}>
            A clinical decision support tool for anesthetic selection
            in electroconvulsive therapy. Integrates patient demographics,
            hemodynamic parameters, comorbidities, and treatment history
            to recommend an optimal anesthetic regimen.
          </p>
          <button onClick={onLaunch} style={{ background: "#1a3a7a", color: "white", border: "none", padding: "12px 36px", borderRadius: 4, fontSize: 14, fontWeight: 600, cursor: "pointer", letterSpacing: "0.02em" }}>
            Launch Decision Support
          </button>
        </div>
      </div>

      <div style={{ padding: "0 24px 60px", display: "flex", justifyContent: "center" }}>
        <div style={{ width: "100%", maxWidth: 680 }}>
          <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6, overflow: "hidden" }}>
            <div style={{ padding: "10px 16px", borderBottom: "1px solid #e5e7eb", fontSize: 12, color: "#6b7280", fontWeight: 500 }}>
              System Overview
            </div>
            <div style={{ aspectRatio: "16/9", background: "#f3f4f6", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
              <div style={{ width: 52, height: 52, borderRadius: "50%", background: "#e5e7eb", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#9ca3af"><polygon points="5,3 19,12 5,21"/></svg>
              </div>
              <span style={{ fontSize: 13, color: "#9ca3af" }}>Demo video</span>
            </div>
          </div>
        </div>
      </div>

      <div style={{ borderTop: "1px solid #e5e7eb", padding: "14px 32px", background: "#f9fafb", textAlign: "center" }}>
        <span style={{ fontSize: 11, color: "#9ca3af" }}>
          For clinical decision support only. All recommendations require confirmation by a qualified provider.
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  TOOL — with prior-drug selector + real API call
// ─────────────────────────────────────────────────────────────────────────────
function Tool({ onBack, onDocs }) {
  const [vitals, setVitals]   = useState({ ...DEFAULT_VITALS });
  const [flags, setFlags]     = useState({ ...DEFAULT_FLAGS });
  const [isFirst, setIsFirst] = useState(true);
  const [priorDrug, setPriorDrug] = useState("methohexital");
  const [errors, setErrors]   = useState({});
  const [result, setResult]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [apiOk, setApiOk]     = useState(true);

  const runPredict = useCallback(async (v, f, first, prior) => {
    setLoading(true);
    const body = {
      ...v, ...f,
      is_first_treatment: first ? 1 : 0,
      prior_drug: first ? "" : prior,
    };
    try {
      const res = await fetch(`${API_URL}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      setApiOk(true);
      setResult({ primary: data.primary_anesthetic, confidence: data.confidence, source: "model" });
    } catch {
      setApiOk(false);
      const fallbackPrimary = ruleEngineFallback(v, f, first, first ? null : prior);
      setResult({ primary: fallbackPrimary, confidence: null, source: "fallback" });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => runPredict(vitals, flags, isFirst, priorDrug), 250);
    return () => clearTimeout(timer);
  }, [vitals, flags, isFirst, priorDrug, runPredict]);

  const primary  = result?.primary || "methohexital";
  const cocktail = getCocktail(vitals, flags, primary);
  const rules    = getFiredRules(vitals, flags, isFirst, isFirst ? null : priorDrug, primary);
  const agColor  = AGENT_COLOR[primary] || "#1a3a7a";

  function handleVital(field, val, min, max) {
    const n = Number(val);
    if (val === "" || isNaN(n) || n < min || n > max) {
      setErrors(e => ({ ...e, [field]: `${min}–${max}` }));
    } else {
      setErrors(e => { const ne = { ...e }; delete ne[field]; return ne; });
      setVitals(v => ({ ...v, [field]: n }));
    }
  }

  function toggleFlag(f) { setFlags(p => ({ ...p, [f]: p[f] ? 0 : 1 })); }
  function reset() {
    setVitals({ ...DEFAULT_VITALS }); setFlags({ ...DEFAULT_FLAGS });
    setIsFirst(true); setPriorDrug("methohexital"); setErrors({});
  }

  function VInput({ label, field, unit, min, max }) {
    const [local, setLocal] = useState(String(vitals[field]));
    const err = errors[field];
    return (
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
          <label style={{ fontSize: 11, color: "#374151", fontWeight: 500 }}>{label}</label>
          <span style={{ fontSize: 10, color: "#9ca3af" }}>{unit}</span>
        </div>
        <input
          type="number" min={min} max={max} value={local}
          onChange={e => setLocal(e.target.value)}
          onBlur={e => handleVital(field, e.target.value, min, max)}
          style={{
            width: "100%", padding: "6px 8px", borderRadius: 4,
            border: `1px solid ${err ? "#ef4444" : "#d1d5db"}`,
            fontSize: 13, color: "#111827", background: "white",
            outline: "none", boxSizing: "border-box",
            fontFamily: "'Segoe UI', Arial, sans-serif",
          }}
        />
        {err && <div style={{ fontSize: 10, color: "#ef4444", marginTop: 2 }}>Valid: {err}</div>}
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'Segoe UI', Arial, sans-serif", background: "#f3f4f6", minHeight: "100vh" }}>

      <div style={{ background: "#1a3a7a", padding: "10px 20px", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.7)", cursor: "pointer", fontSize: 16, padding: 0 }}>←</button>
        <span style={{ color: "white", fontSize: 14, fontWeight: 600 }}>ECT Decision Support</span>
        <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, marginLeft: 4 }}>/ Anesthetic Selection</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {loading && <span style={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }}>Analyzing...</span>}
          {!apiOk && <span style={{ fontSize: 10, background: "#7a4a1a", color: "#fde68a", padding: "2px 8px", borderRadius: 8 }}>Offline mode</span>}
          <button onClick={onDocs} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.3)", color: "rgba(255,255,255,0.8)", padding: "4px 12px", borderRadius: 3, fontSize: 11, cursor: "pointer" }}>
            Documentation
          </button>
        </div>
      </div>

      <div style={{ background: "white", borderBottom: "1px solid #e5e7eb", padding: "0 20px", display: "flex" }}>
        <div style={{ padding: "10px 0", fontSize: 13, fontWeight: 600, color: "#1a3a7a", borderBottom: "2px solid #1a3a7a", marginRight: 24 }}>
          Decision Support
        </div>
      </div>

      <div style={{ display: "flex", gap: 0, padding: 16, alignItems: "flex-start" }}>

        {/* LEFT PANEL */}
        <div style={{ width: 220, background: "white", borderRadius: 4, border: "1px solid #e5e7eb", marginRight: 16, flexShrink: 0 }}>

          <div style={{ padding: "12px 14px", borderBottom: "1px solid #f3f4f6" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#374151", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 10 }}>Vitals</div>
            <VInput label="Age" field="age" unit="years" min={18} max={90} />
            <VInput label="Weight" field="weight_kg" unit="kg" min={40} max={150} />
            <VInput label="Resting HR" field="resting_hr" unit="bpm" min={38} max={140} />
            <VInput label="Systolic BP" field="systolic_bp" unit="mmHg" min={75} max={220} />
            <VInput label="Diastolic BP" field="diastolic_bp" unit="mmHg" min={40} max={120} />
          </div>

          <div style={{ padding: "10px 14px", borderBottom: "1px solid #f3f4f6" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#374151", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>Session</div>
            <div style={{ display: "flex", gap: 6, marginBottom: isFirst ? 0 : 10 }}>
              {[["First Treatment", true], ["Follow-up", false]].map(([l, v]) => (
                <button key={l} onClick={() => setIsFirst(v)} style={{
                  flex: 1, padding: "5px 0", fontSize: 11, borderRadius: 3, cursor: "pointer",
                  border: `1px solid ${isFirst === v ? "#1a3a7a" : "#d1d5db"}`,
                  background: isFirst === v ? "#eef2ff" : "white",
                  color: isFirst === v ? "#1a3a7a" : "#6b7280",
                  fontWeight: isFirst === v ? 600 : 400,
                }}>{l}</button>
              ))}
            </div>

            {!isFirst && (
              <div style={{ marginTop: 4 }}>
                <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 6, letterSpacing: "0.05em" }}>
                  PREVIOUS SESSION'S DRUG
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  {["methohexital", "propofol", "etomidate"].map(drug => (
                    <button key={drug} onClick={() => setPriorDrug(drug)} style={{
                      flex: 1, padding: "5px 2px", fontSize: 10, borderRadius: 4, cursor: "pointer",
                      border: `1px solid ${priorDrug === drug ? "#1a3a7a" : "#d1d5db"}`,
                      background: priorDrug === drug ? "#eef2ff" : "white",
                      color: priorDrug === drug ? "#1a3a7a" : "#6b7280",
                      fontWeight: priorDrug === drug ? 600 : 400,
                      textTransform: "capitalize",
                    }}>{drug}</button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div style={{ padding: "10px 14px", borderBottom: "1px solid #f3f4f6" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#374151", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>Clinical Flags</div>
            {FLAG_DEFS.filter(f => !f.prior).map(({ label, field, effect }) => {
              const checked = !!flags[field];
              return (
                <div key={field} onClick={() => toggleFlag(field)} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderRadius: 3, marginBottom: 2,
                  cursor: "pointer", background: checked ? "#eef2ff" : "transparent",
                  border: `1px solid ${checked ? "#c7d2fe" : "transparent"}`,
                }}>
                  <div style={{
                    width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                    border: `1.5px solid ${checked ? "#1a3a7a" : "#d1d5db"}`,
                    background: checked ? "#1a3a7a" : "white",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {checked && <svg width="8" height="6" viewBox="0 0 8 6"><polyline points="1,3 3,5 7,1" stroke="white" strokeWidth="1.5" fill="none"/></svg>}
                  </div>
                  <span style={{ fontSize: 11.5, color: checked ? "#1a3a7a" : "#374151", fontWeight: checked ? 600 : 400 }}>{label}</span>
                  {effect === "adjunct" && <span style={{ marginLeft: "auto", fontSize: 9, color: "#9ca3af", flexShrink: 0 }}>cocktail</span>}
                </div>
              );
            })}
          </div>

          <div style={{ padding: "10px 14px", borderBottom: "1px solid #f3f4f6" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#374151", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4 }}>Prior Complications</div>
            {isFirst && <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 8, fontStyle: "italic" }}>Not applicable on first treatment</div>}
            {FLAG_DEFS.filter(f => f.prior).map(({ label, field, effect }) => {
              const checked = !!flags[field];
              const disabled = isFirst;
              return (
                <div key={field} onClick={() => !disabled && toggleFlag(field)} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderRadius: 3, marginBottom: 2,
                  cursor: disabled ? "not-allowed" : "pointer",
                  background: checked ? "#eef2ff" : "transparent",
                  border: `1px solid ${checked ? "#c7d2fe" : "transparent"}`,
                  opacity: disabled ? 0.35 : 1,
                }}>
                  <div style={{
                    width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                    border: `1.5px solid ${checked ? "#1a3a7a" : "#d1d5db"}`,
                    background: checked ? "#1a3a7a" : "white",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {checked && <svg width="8" height="6" viewBox="0 0 8 6"><polyline points="1,3 3,5 7,1" stroke="white" strokeWidth="1.5" fill="none"/></svg>}
                  </div>
                  <span style={{ fontSize: 11.5, color: checked ? "#1a3a7a" : "#374151", fontWeight: checked ? 600 : 400 }}>{label}</span>
                  {effect === "adjunct" && <span style={{ marginLeft: "auto", fontSize: 9, color: "#9ca3af", flexShrink: 0 }}>cocktail</span>}
                </div>
              );
            })}
          </div>

          <div style={{ padding: "10px 14px" }}>
            <button onClick={reset} style={{ width: "100%", padding: "6px 0", background: "white", border: "1px solid #d1d5db", borderRadius: 3, fontSize: 12, color: "#374151", cursor: "pointer" }}>Reset All</button>
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ background: "white", borderRadius: 4, border: "1px solid #e5e7eb", marginBottom: 12, overflow: "hidden", opacity: loading ? 0.85 : 1, transition: "opacity 0.15s" }}>
            <div style={{ background: agColor, padding: "18px 20px" }}>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.65)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 6 }}>
                Recommended Primary Anesthetic
              </div>
              <div style={{ fontSize: 32, fontWeight: 700, color: "white", letterSpacing: "0.02em" }}>
                {primary.charAt(0).toUpperCase() + primary.slice(1)}
              </div>
              {result?.confidence != null && (
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 6 }}>
                  Model confidence: {result.confidence}%
                  {result.source === "fallback" && <span style={{ color: "#fde68a", marginLeft: 8 }}>(offline fallback)</span>}
                </div>
              )}
            </div>
          </div>

          <div style={{ background: "white", borderRadius: 4, border: "1px solid #e5e7eb", padding: "14px 16px", marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#374151", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 10 }}>Drug Cocktail</div>
            <div>
              {cocktail.map(d => {
                const isPrimary = ["Methohexital", "Propofol", "Etomidate"].includes(d);
                return (
                  <span key={d} style={{
                    display: "inline-block", padding: "4px 12px", borderRadius: 3, fontSize: 12, marginRight: 6, marginBottom: 6,
                    background: isPrimary ? agColor : "#f3f4f6",
                    color: isPrimary ? "white" : "#374151",
                    fontWeight: isPrimary ? 600 : 400,
                    border: isPrimary ? "none" : "1px solid #e5e7eb",
                  }}>{d}</span>
                );
              })}
            </div>
          </div>

          <div style={{ background: "white", borderRadius: 4, border: "1px solid #e5e7eb", padding: "14px 16px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#374151", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Decision Rationale</div>
            {rules.map((r, i) => (
              <div key={i} style={{
                display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 6, padding: "8px 10px",
                background: "#f9fafb", borderRadius: 3,
                borderLeft: `3px solid ${r.id === "ADJ" ? "#7c3aed" : r.id === "D1" ? "#16a34a" : r.id === "PERSIST" ? "#0ea5e9" : r.id.startsWith("H3") ? "#dc2626" : "#1a3a7a"}`,
              }}>
                <span style={{
                  fontSize: 10, padding: "1px 6px", borderRadius: 2,
                  background: r.id === "ADJ" ? "#f3e8ff" : r.id === "PERSIST" ? "#e0f2fe" : "#e0e7ff",
                  color: r.id === "ADJ" ? "#7c3aed" : r.id === "PERSIST" ? "#0369a1" : "#1a3a7a",
                  fontWeight: 700, flexShrink: 0, whiteSpace: "nowrap",
                  border: `1px solid ${r.id === "ADJ" ? "#ddd6fe" : r.id === "PERSIST" ? "#bae6fd" : "#c7d2fe"}`,
                }}>{r.id}</span>
                <span style={{ fontSize: 12, color: "#374151", lineHeight: 1.6 }}>{r.t}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ margin: "0 16px 20px", padding: "8px 14px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 3, fontSize: 11, color: "#92400e" }}>
        Clinical decision support only. All recommendations require confirmation by a qualified anesthesiologist or ECT provider.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  DOCS
// ─────────────────────────────────────────────────────────────────────────────
function Docs({ onBack }) {
  const [sec, setSec] = useState("overview");
  const NAV = [
    { id: "overview", label: "Overview" },
    { id: "model", label: "ML Model" },
    { id: "rules", label: "Decision Rules" },
  ];
  return (
    <div style={{ minHeight: "100vh", background: "#f3f4f6", fontFamily: "'Segoe UI', Arial, sans-serif" }}>
      <div style={{ background: "#1a3a7a", padding: "10px 20px", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.7)", cursor: "pointer", fontSize: 16, padding: 0 }}>←</button>
        <span style={{ color: "white", fontSize: 14, fontWeight: 600 }}>Documentation</span>
      </div>
      <div style={{ display: "flex", minHeight: "calc(100vh - 44px)" }}>
        <div style={{ width: 180, background: "white", borderRight: "1px solid #e5e7eb", padding: "16px 0", flexShrink: 0 }}>
          {NAV.map(n => (
            <div key={n.id} onClick={() => setSec(n.id)} style={{
              padding: "9px 18px", cursor: "pointer", fontSize: 13,
              color: sec === n.id ? "#1a3a7a" : "#4b5563",
              background: sec === n.id ? "#eef2ff" : "transparent",
              borderLeft: sec === n.id ? "3px solid #1a3a7a" : "3px solid transparent",
              fontWeight: sec === n.id ? 600 : 400,
            }}>{n.label}</div>
          ))}
        </div>
        <div style={{ flex: 1, padding: 28, maxWidth: 760 }}>
          {sec === "overview" && (
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: "#111827", marginBottom: 12 }}>Overview</h2>
              <p style={{ fontSize: 13, color: "#4b5563", lineHeight: 1.8, marginBottom: 14 }}>
                ShockSmart recommends an anesthetic regimen for ECT sessions using a Random Forest
                trained on 186 real expert-labeled sessions. The single most important feature is
                what anesthetic was used in the patient's previous session — this raised
                leave-one-case-out cross-validation accuracy from 51.6% to 84.9%.
              </p>
            </div>
          )}
          {sec === "model" && (
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: "#111827", marginBottom: 12 }}>ML Model</h2>
              <p style={{ fontSize: 13, color: "#4b5563", lineHeight: 1.8, marginBottom: 14 }}>
                50-tree Random Forest, max depth 6, trained on 186 real sessions only.
                LOCO cross-validation accuracy: 84.9%. Deployed as a dependency-free pure
                Python inference engine — no scikit-learn or pandas at runtime.
              </p>
            </div>
          )}
          {sec === "rules" && (
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: "#111827", marginBottom: 12 }}>Decision Rules</h2>
              <p style={{ fontSize: 13, color: "#4b5563", lineHeight: 1.8 }}>
                Safety-critical rules (hypotension, HTN emergency, tachyarrhythmia, prolonged/inadequate
                seizure) always override. If none apply, the model favors continuing the patient's
                prior anesthetic — reflecting the strongest pattern found in real clinical data.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  ROOT
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage] = useState("landing");
  if (page === "docs") return <Docs onBack={() => setPage("tool")} />;
  if (page === "tool") return <Tool onBack={() => setPage("landing")} onDocs={() => setPage("docs")} />;
  return <Landing onLaunch={() => setPage("tool")} onDocs={() => setPage("docs")} />;
}