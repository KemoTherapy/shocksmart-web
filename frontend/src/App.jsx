import { useState, useEffect, useCallback } from "react";

// ── API URL — points to your Render backend ───────────────────────────────────
// Change this once you have your Render URL
const API_URL = import.meta.env.VITE_API_URL || "https://shocksmart-api.onrender.com";

// ── Fallback rule engine (runs client-side if API is slow/down) ───────────────
function ruleEngineFallback(p, isFirst) {
  const sbp = p.systolic_bp, hr = p.resting_hr;
  if (p.prior_hypotensive_shock || sbp < 100) return { primary: "methohexital", confidence: 72 };
  if (p.prior_htn_emergency || sbp >= 175)    return { primary: "propofol",     confidence: 78 };
  if (p.prior_tachyarrhythmia || hr > 100)    return { primary: "propofol",     confidence: 74 };
  if (p.prior_inadequate_seizure && !isFirst)  return { primary: "etomidate",    confidence: 81 };
  if (p.prior_prolonged_seizure)               return { primary: "propofol",     confidence: 69 };
  if (p.prior_reemergence_delirium || p.flag_bipolarity_or_violence) return { primary: "methohexital", confidence: 67 };
  if (p.flag_on_seizure_meds)                  return { primary: "methohexital", confidence: 70 };
  if (sbp >= 140)                              return { primary: "propofol",     confidence: 63 };
  if (p.flag_on_benzos)                        return { primary: "propofol",     confidence: 58 };
  return { primary: "methohexital", confidence: 55 };
}

function getCocktail(p, primary) {
  const d = [];
  d.push(primary.charAt(0).toUpperCase() + primary.slice(1));
  if (!p.flag_fracture_neuromuscular) d.push("Succinylcholine");
  else { d.push("Rocuronium"); d.push("Sugammadex"); }
  if (p.flag_bipolarity_or_violence || p.flag_neurocognitive_disorder || p.prior_reemergence_delirium) d.push("Precedex");
  if (p.flag_on_benzos) d.push("Flumazenil");
  if (p.flag_baseline_nausea || p.prior_nausea_emesis || primary === "etomidate") d.push("Ondansetron");
  if (p.flag_chronic_pain || p.prior_headache) d.push("Acetaminophen");
  if (p.prior_headache && p.flag_chronic_pain) d.push("Ketorolac");
  if (p.prior_htn_emergency || p.systolic_bp >= 160) d.push("Labetalol");
  if (p.prior_bradyarrhythmia || p.resting_hr < 55) d.push("Glycopyrrolate");
  return d;
}

function getRules(p, isFirst) {
  const r = [];
  if (p.prior_hypotensive_shock || p.systolic_bp < 100) r.push({ id: "C1", text: "Hypotension risk — Methohexital (BP-neutral)" });
  if (p.prior_htn_emergency || p.systolic_bp >= 175)    r.push({ id: "H1", text: "HTN emergency — Propofol (vasodilatory)" });
  if (p.prior_tachyarrhythmia || p.resting_hr > 100)   r.push({ id: "H2", text: "Tachyarrhythmia — Propofol (lowers HR)" });
  if (p.prior_inadequate_seizure && !isFirst)            r.push({ id: "H3", text: "Prior inadequate seizure — Etomidate" });
  if (p.prior_prolonged_seizure)                         r.push({ id: "H4", text: "Prolonged seizure — Propofol (raises threshold)" });
  if (p.prior_reemergence_delirium || p.flag_bipolarity_or_violence) r.push({ id: "H5", text: "Reemergence / agitation risk — Methohexital + Precedex" });
  if (p.flag_on_seizure_meds)                            r.push({ id: "H6", text: "On AED — Methohexital (propofol suppresses threshold)" });
  if (p.systolic_bp >= 140 && r.length === 0)            r.push({ id: "M1", text: "Elevated BP — Propofol (vasodilatory advantage)" });
  if (p.flag_on_benzos && r.length === 0)                r.push({ id: "M2", text: "On benzodiazepines — Propofol (smoother emergence)" });
  if (r.length === 0)                                    r.push({ id: "D1", text: "No contraindications — Methohexital (default)" });
  return r;
}

const DRUG_COLORS = { methohexital: "#16a34a", propofol: "#2563eb", etomidate: "#dc2626", ketamine: "#7c3aed" };

const DEFAULT = {
  age: 52, sex_female: 0, weight_kg: 78, resting_hr: 74, systolic_bp: 128, diastolic_bp: 80,
  flag_bipolarity_or_violence: 0, flag_on_benzos: 0, flag_on_seizure_meds: 0,
  flag_chronic_pain: 0, flag_neurocognitive_disorder: 0, flag_fracture_neuromuscular: 0, flag_baseline_nausea: 0,
  prior_reemergence_delirium: 0, prior_htn_emergency: 0, prior_hypotensive_shock: 0,
  prior_bradyarrhythmia: 0, prior_tachyarrhythmia: 0, prior_prolonged_seizure: 0,
  prior_inadequate_seizure: 0, prior_headache: 0, prior_nausea_emesis: 0,
};

const FLAGS = [
  { label: "Hypertensive Emergency", field: "prior_htn_emergency",          prior: true },
  { label: "Seizure Medications",    field: "flag_on_seizure_meds",          prior: false },
  { label: "Reemergence Delirium",   field: "prior_reemergence_delirium",    prior: true },
  { label: "Inadequate Seizure",     field: "prior_inadequate_seizure",      prior: true },
  { label: "Chronic Pain",           field: "flag_chronic_pain",             prior: false },
  { label: "Bipolarity / Violence",  field: "flag_bipolarity_or_violence",   prior: false },
  { label: "On Benzodiazepines",     field: "flag_on_benzos",                prior: false },
  { label: "Tachyarrhythmia",        field: "prior_tachyarrhythmia",         prior: true },
  { label: "Hypotensive Shock",      field: "prior_hypotensive_shock",       prior: true },
  { label: "Fracture / Neuromuscular", field: "flag_fracture_neuromuscular", prior: false },
  { label: "Baseline Nausea",        field: "flag_baseline_nausea",          prior: false },
  { label: "Bradyarrhythmia",        field: "prior_bradyarrhythmia",         prior: true },
  { label: "Prolonged Seizure",      field: "prior_prolonged_seizure",       prior: true },
  { label: "Neurocognitive Disorder",field: "flag_neurocognitive_disorder",  prior: false },
];

export default function App() {
  const [tab, setTab]       = useState("decision");
  const [form, setForm]     = useState({ ...DEFAULT });
  const [isFirst, setIsFirst] = useState(true);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [apiOk, setApiOk]   = useState(true);

  const toggle = (f) => setForm(p => ({ ...p, [f]: p[f] ? 0 : 1 }));
  const reset  = () => { setForm({ ...DEFAULT }); setIsFirst(true); };

  const runPredict = useCallback(async (formData, first) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...formData, is_first_treatment: first ? 1 : 0 }),
      });
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      setApiOk(true);
      setResult({
        primary:       data.primary_anesthetic,
        confidence:    data.confidence,
        probabilities: data.probabilities,
        source:        "model",
      });
    } catch {
      // Fallback to rule engine if API is unavailable
      setApiOk(false);
      const fb = ruleEngineFallback(formData, first);
      setResult({
        primary:       fb.primary,
        confidence:    fb.confidence,
        probabilities: { [fb.primary]: fb.confidence / 100 },
        source:        "fallback",
      });
    }
    setLoading(false);
  }, []);

  // Auto-predict whenever form changes
  useEffect(() => {
    const timer = setTimeout(() => runPredict(form, isFirst), 300);
    return () => clearTimeout(timer);
  }, [form, isFirst, runPredict]);

  const primary  = result?.primary || "methohexital";
  const conf     = result?.confidence || 0;
  const probs    = result?.probabilities || {};
  const cocktail = getCocktail(form, primary);
  const rules    = getRules(form, isFirst);
  const topFour  = Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, 4);

  return (
    <div style={{ fontFamily: "'Segoe UI', system-ui, sans-serif", background: "#f3f4f6", minHeight: "100vh" }}>

      {/* Header */}
      <div style={{ background: "#1e3a8a", color: "white", padding: "11px 20px", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 18 }}>⚡</span>
        <span style={{ fontSize: 15, fontWeight: 700 }}>ECT Decision Support System</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {loading && <span style={{ fontSize: 11, color: "#93c5fd" }}>Analyzing...</span>}
          {!apiOk && (
            <span style={{ fontSize: 11, background: "#78350f", color: "#fcd34d", padding: "2px 8px", borderRadius: 8 }}>
              Offline mode
            </span>
          )}
          <span style={{ fontSize: 11, background: "#1d4ed8", padding: "3px 10px", borderRadius: 10, color: "#bfdbfe" }}>
            ShockSmart v1.0
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ background: "white", borderBottom: "1px solid #e5e7eb", padding: "0 20px", display: "flex" }}>
        {[["Patient Chart", "chart"], ["Decision Support", "decision"]].map(([label, key]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            padding: "10px 16px", fontSize: 13, border: "none", background: "none", cursor: "pointer",
            borderBottom: tab === key ? "2px solid #1e3a8a" : "2px solid transparent",
            color: tab === key ? "#1e3a8a" : "#6b7280", fontWeight: tab === key ? 600 : 400,
          }}>{label}</button>
        ))}
      </div>

      {/* Body */}
      <div style={{ display: "flex", gap: 16, padding: 16, alignItems: "flex-start" }}>

        {/* LEFT PANEL */}
        <div style={{ width: 200, background: "white", borderRadius: 8, border: "1px solid #e5e7eb", padding: "14px 14px 10px", flexShrink: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", marginBottom: 2 }}>Patient Factors</div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 12 }}>Toggle to see changes</div>

          {FLAGS.map(({ label, field, prior }) => {
            const checked   = !!form[field];
            const disabled  = prior && isFirst;
            return (
              <div key={field} onClick={() => !disabled && toggle(field)} style={{
                display: "flex", alignItems: "center", gap: 8, padding: "5px 8px",
                borderRadius: 5, marginBottom: 3,
                cursor: disabled ? "not-allowed" : "pointer",
                background: checked ? "#eff6ff" : "transparent",
                border: `1px solid ${checked ? "#bfdbfe" : "transparent"}`,
                opacity: disabled ? 0.35 : 1, transition: "background 0.1s",
              }}>
                <div style={{
                  width: 15, height: 15, borderRadius: 3, flexShrink: 0,
                  border: `2px solid ${checked ? "#1e3a8a" : "#d1d5db"}`,
                  background: checked ? "#1e3a8a" : "white",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {checked && (
                    <svg width="9" height="7" viewBox="0 0 9 7">
                      <polyline points="1,3.5 3.5,6 8,1" stroke="white" strokeWidth="2" fill="none"/>
                    </svg>
                  )}
                </div>
                <span style={{ fontSize: 11.5, color: checked ? "#1e3a8a" : "#374151", fontWeight: checked ? 600 : 400 }}>
                  {label}
                </span>
              </div>
            );
          })}

          <div style={{ marginTop: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 6 }}>Treatment session</div>
            <div style={{ display: "flex", gap: 6 }}>
              {[["First", true], ["Follow-up", false]].map(([l, v]) => (
                <button key={l} onClick={() => setIsFirst(v)} style={{
                  flex: 1, padding: "5px 0", fontSize: 11, borderRadius: 5,
                  border: `1px solid ${isFirst === v ? "#1e3a8a" : "#e5e7eb"}`,
                  background: isFirst === v ? "#eff6ff" : "white",
                  color: isFirst === v ? "#1e3a8a" : "#6b7280",
                  fontWeight: isFirst === v ? 600 : 400,
                }}>{l}</button>
              ))}
            </div>
          </div>

          <button onClick={reset} style={{
            width: "100%", padding: "7px 0", background: "white",
            border: "1px solid #d1d5db", borderRadius: 6, fontSize: 12, color: "#374151",
          }}>Reset All</button>
        </div>

        {/* RIGHT PANEL */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {tab === "chart" ? (

            /* ── PATIENT CHART TAB ── */
            <div>
              <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
                {[["Age", "age", "yrs"], ["HR", "resting_hr", "bpm"], ["SBP", "systolic_bp", "mmHg"], ["DBP", "diastolic_bp", "mmHg"], ["Wt", "weight_kg", "kg"]].map(([l, f, u]) => (
                  <div key={f} style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 14px", textAlign: "center", flex: 1 }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: "#111827" }}>{form[f]}</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{l} ({u})</div>
                  </div>
                ))}
              </div>
              <div style={{ background: "white", borderRadius: 8, border: "1px solid #e5e7eb", padding: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 12, letterSpacing: "0.05em" }}>ADJUST VITALS</div>
                {[["Age (years)", "age", 18, 90], ["Heart Rate (bpm)", "resting_hr", 38, 140], ["Systolic BP (mmHg)", "systolic_bp", 75, 220], ["Diastolic BP (mmHg)", "diastolic_bp", 40, 120], ["Weight (kg)", "weight_kg", 40, 150]].map(([l, f, mn, mx]) => (
                  <div key={f} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: "#6b7280" }}>{l}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>{form[f]}</span>
                    </div>
                    <input type="range" min={mn} max={mx} value={form[f]}
                      onChange={e => setForm(p => ({ ...p, [f]: Number(e.target.value) }))}
                      style={{ width: "100%", accentColor: "#1e3a8a" }} />
                  </div>
                ))}
              </div>
            </div>

          ) : (

            /* ── DECISION SUPPORT TAB ── */
            <div>
              {/* Recommendation */}
              <div style={{
                background: "linear-gradient(135deg, #1e3a8a 0%, #1d4ed8 100%)",
                borderRadius: 10, padding: "26px 20px", textAlign: "center",
                marginBottom: 14, color: "white",
                opacity: loading ? 0.8 : 1, transition: "opacity 0.2s",
              }}>
                <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "#93c5fd", marginBottom: 8 }}>RECOMMENDED</div>
                <div style={{ fontSize: 38, fontWeight: 800, letterSpacing: 1, marginBottom: 8 }}>
                  {primary.toUpperCase()}
                </div>
                <div style={{ fontSize: 15, color: "#bfdbfe" }}>
                  Confidence: {conf}%
                  {result?.source === "fallback" && (
                    <span style={{ fontSize: 11, marginLeft: 8, color: "#fcd34d" }}>(rule engine)</span>
                  )}
                </div>
              </div>

              {/* Probability bars */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                {topFour.map(([drug, pct]) => {
                  const pctDisplay = typeof pct === "number" && pct <= 1 ? Math.round(pct * 100) : Math.round(pct);
                  return (
                    <div key={drug} style={{ background: "white", borderRadius: 8, border: "1px solid #e5e7eb", padding: "10px 14px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontSize: 13, color: "#374151" }}>{drug}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{pctDisplay}%</span>
                      </div>
                      <div style={{ height: 6, background: "#f3f4f6", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{
                          height: "100%", width: `${pctDisplay}%`,
                          background: DRUG_COLORS[drug] || "#1e3a8a",
                          borderRadius: 3, transition: "width 0.4s ease",
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Full cocktail */}
              <div style={{ background: "white", borderRadius: 8, border: "1px solid #e5e7eb", padding: "12px 14px", marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.1em", marginBottom: 10 }}>FULL COCKTAIL</div>
                <div>
                  {cocktail.map(d => {
                    const isPrimary = ["Methohexital", "Propofol", "Etomidate"].includes(d);
                    return (
                      <span key={d} style={{
                        display: "inline-block", padding: "4px 10px", borderRadius: 12,
                        fontSize: 12, marginRight: 6, marginBottom: 6,
                        background: isPrimary ? "#1e3a8a" : "#f3f4f6",
                        color: isPrimary ? "white" : "#374151",
                        fontWeight: isPrimary ? 700 : 400,
                        border: isPrimary ? "none" : "1px solid #e5e7eb",
                      }}>{d}</span>
                    );
                  })}
                </div>
              </div>

              {/* Decision network */}
              <div style={{ background: "#0f172a", borderRadius: 8, padding: "14px 16px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#93c5fd", marginBottom: 10, letterSpacing: "0.1em" }}>
                  Decision Network
                </div>
                <div style={{ display: "flex", gap: 16, marginBottom: 12, fontSize: 11 }}>
                  <span style={{ color: "#fbbf24" }}>● Start / Active</span>
                  <span style={{ color: "#34d399" }}>● Decision Points</span>
                  <span style={{ color: "#60a5fa" }}>● Outcomes</span>
                </div>
                {rules.map(r => (
                  <div key={r.id} style={{
                    display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 8,
                    padding: "8px 10px", borderRadius: 6,
                    background: "#162032", border: "1px solid #1e3a5f",
                  }}>
                    <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 3, background: "#1e3a7a", color: "#93c5fd", fontWeight: 700, flexShrink: 0 }}>
                      {r.id}
                    </span>
                    <span style={{ fontSize: 11, color: "#cbd5e1" }}>{r.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Disclaimer */}
      <div style={{ margin: "0 16px 16px", padding: "9px 14px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, fontSize: 11, color: "#92400e" }}>
        ⚠ Clinical decision support only. All recommendations require confirmation by a qualified anesthesiologist or ECT provider.
        ShockSmart augments, not replaces, clinical judgment.
      </div>
    </div>
  );
}
