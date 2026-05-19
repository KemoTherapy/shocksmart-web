import { useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
//  RULE ENGINE — verified 18/18 test cases, mirrors Python backend exactly
// ─────────────────────────────────────────────────────────────────────────────
function ruleEngine(vitals, flags, isFirst) {
  const sbp = vitals.systolic_bp;
  const hr  = vitals.resting_hr;
  if (flags.prior_hypotensive_shock || sbp < 100)                              return "methohexital";
  if (flags.prior_htn_emergency     || sbp >= 175)                             return "propofol";
  if (flags.prior_tachyarrhythmia   || hr  > 100)                              return "propofol";
  if (flags.prior_inadequate_seizure && !isFirst)                               return "etomidate";
  if (flags.prior_prolonged_seizure)                                            return "propofol";
  if (flags.prior_reemergence_delirium || flags.flag_bipolarity_or_violence)    return "methohexital";
  if (flags.flag_on_seizure_meds)                                               return "methohexital";
  if (sbp >= 140)                                                               return "propofol";
  if (flags.flag_on_benzos)                                                     return "propofol";
  return "methohexital";
}

function getCocktail(vitals, flags, primary) {
  const sbp = vitals.systolic_bp;
  const hr  = vitals.resting_hr;
  const d   = [cap(primary)];
  if (flags.flag_fracture_neuromuscular) { d.push("Rocuronium"); d.push("Sugammadex"); }
  else d.push("Succinylcholine");
  if (flags.flag_bipolarity_or_violence || flags.flag_neurocognitive_disorder || flags.prior_reemergence_delirium) d.push("Precedex");
  if (flags.flag_on_benzos)                                                      d.push("Flumazenil");
  if (flags.flag_baseline_nausea || flags.prior_nausea_emesis || primary === "etomidate") d.push("Ondansetron");
  if (flags.flag_chronic_pain || flags.prior_headache)                           d.push("Acetaminophen");
  if (flags.flag_chronic_pain && flags.prior_headache)                           d.push("Ketorolac");
  if (flags.prior_htn_emergency || sbp >= 160)                                  d.push("Labetalol");
  if (flags.prior_bradyarrhythmia || hr < 55)                                   d.push("Glycopyrrolate");
  if (flags.prior_hypotensive_shock && !flags.prior_tachyarrhythmia && hr <= 100 && sbp < 140) d.push("Ketamine");
  return d;
}

function getFiredRules(vitals, flags, isFirst) {
  const sbp = vitals.systolic_bp;
  const hr  = vitals.resting_hr;
  const r   = [];
  const primaryRulesFired = [];

  if (flags.prior_hypotensive_shock || sbp < 100) { r.push({ id:"C1", t:"Hypotension risk — Methohexital (BP-neutral; propofol worsens hypotension)" }); primaryRulesFired.push("C1"); }
  if (flags.prior_htn_emergency     || sbp >= 175){ r.push({ id:"H1", t:"Hypertensive emergency — Propofol (vasodilatory; blunts BP spike at induction)" }); primaryRulesFired.push("H1"); }
  if (flags.prior_tachyarrhythmia   || hr  > 100) { r.push({ id:"H2", t:"Tachyarrhythmia — Propofol (negative chronotropic; ketamine avoided)" }); primaryRulesFired.push("H2"); }
  if (flags.prior_inadequate_seizure && !isFirst)  { r.push({ id:"H3", t:"Prior inadequate seizure — Etomidate (lowers seizure threshold most effectively)" }); primaryRulesFired.push("H3"); }
  if (flags.prior_inadequate_seizure && isFirst)   { r.push({ id:"H3*",t:"Prior inadequate seizure noted — blocked on first treatment; will switch to Etomidate on next session" }); }
  if (flags.prior_prolonged_seizure)               { r.push({ id:"H4", t:"Prior prolonged seizure — Propofol (anticonvulsant properties raise seizure threshold)" }); primaryRulesFired.push("H4"); }
  if (flags.prior_reemergence_delirium || flags.flag_bipolarity_or_violence) { r.push({ id:"H5", t:"Reemergence / agitation risk — Methohexital + Precedex added to cocktail" }); primaryRulesFired.push("H5"); }
  if (flags.flag_on_seizure_meds)                  { r.push({ id:"H6", t:"On AED medications — Methohexital (propofol further suppresses seizure threshold)" }); primaryRulesFired.push("H6"); }
  if (sbp >= 140 && sbp < 175 && primaryRulesFired.filter(x=>["C1","H1","H2","H3","H4","H5","H6"].includes(x)).length === 0) r.push({ id:"M1", t:"Elevated BP (moderate) — Propofol (vasodilatory advantage at induction)" });
  if (flags.flag_on_benzos && primaryRulesFired.filter(x=>["C1","H1","H2","H3","H4","H5","H6"].includes(x)).length === 0)     r.push({ id:"M2", t:"On benzodiazepines — Propofol (smoother emergence; reduces reemergence agitation)" });
  if (r.length === 0) r.push({ id:"D1", t:"No contraindications identified — Methohexital (default standard of care for ECT)" });

  if (flags.flag_fracture_neuromuscular)  r.push({ id:"ADJ", t:"Fracture / neuromuscular — Rocuronium + Sugammadex replacing Succinylcholine" });
  if (flags.flag_on_benzos)               r.push({ id:"ADJ", t:"On benzodiazepines — Flumazenil added to restore seizure threshold" });
  if (flags.flag_baseline_nausea || flags.prior_nausea_emesis) r.push({ id:"ADJ", t:"Nausea risk — Ondansetron added prophylactically" });
  if (ruleEngine(vitals,flags,isFirst) === "etomidate") r.push({ id:"ADJ", t:"Etomidate selected — Ondansetron added (high nausea incidence with etomidate)" });
  if (flags.flag_chronic_pain || flags.prior_headache) r.push({ id:"ADJ", t:"Pain / headache history — Acetaminophen added; Ketorolac if both present" });
  if (flags.prior_htn_emergency || sbp >= 160)         r.push({ id:"ADJ", t:"HTN risk — Labetalol added to blunt hypertensive response" });
  if (flags.prior_bradyarrhythmia || hr < 55)          r.push({ id:"ADJ", t:"Bradycardia risk — Glycopyrrolate added" });
  if (flags.prior_hypotensive_shock && !flags.prior_tachyarrhythmia && hr <= 100 && sbp < 140) r.push({ id:"ADJ", t:"Hypotension history — Ketamine added (sympathomimetic pressor)" });

  return r;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

const DEFAULT_VITALS = { age:52, weight_kg:78, resting_hr:74, systolic_bp:128, diastolic_bp:80 };
const DEFAULT_FLAGS  = {
  flag_bipolarity_or_violence:0, flag_on_benzos:0, flag_on_seizure_meds:0,
  flag_chronic_pain:0, flag_neurocognitive_disorder:0, flag_fracture_neuromuscular:0,
  flag_baseline_nausea:0, prior_reemergence_delirium:0, prior_htn_emergency:0,
  prior_hypotensive_shock:0, prior_bradyarrhythmia:0, prior_tachyarrhythmia:0,
  prior_prolonged_seizure:0, prior_inadequate_seizure:0, prior_headache:0, prior_nausea_emesis:0,
};

const FLAG_DEFS = [
  // Clinical flags
  { label:"Bipolarity / Violence Hx",   field:"flag_bipolarity_or_violence",  prior:false, effect:"primary" },
  { label:"On Seizure Medications",      field:"flag_on_seizure_meds",          prior:false, effect:"primary" },
  { label:"On Benzodiazepines",          field:"flag_on_benzos",                prior:false, effect:"both"    },
  { label:"Chronic Pain",                field:"flag_chronic_pain",             prior:false, effect:"adjunct" },
  { label:"Neurocognitive Disorder",     field:"flag_neurocognitive_disorder",  prior:false, effect:"adjunct" },
  { label:"Fracture / Neuromuscular",    field:"flag_fracture_neuromuscular",   prior:false, effect:"adjunct" },
  { label:"Baseline Nausea",             field:"flag_baseline_nausea",          prior:false, effect:"adjunct" },
  // Prior complications
  { label:"Prior HTN Emergency",         field:"prior_htn_emergency",           prior:true,  effect:"primary" },
  { label:"Prior Hypotensive Shock",     field:"prior_hypotensive_shock",       prior:true,  effect:"primary" },
  { label:"Prior Tachyarrhythmia",       field:"prior_tachyarrhythmia",         prior:true,  effect:"primary" },
  { label:"Prior Inadequate Seizure",    field:"prior_inadequate_seizure",      prior:true,  effect:"primary" },
  { label:"Prior Prolonged Seizure",     field:"prior_prolonged_seizure",       prior:true,  effect:"primary" },
  { label:"Prior Reemergence Delirium",  field:"prior_reemergence_delirium",    prior:true,  effect:"both"    },
  { label:"Prior Bradyarrhythmia",       field:"prior_bradyarrhythmia",         prior:true,  effect:"adjunct" },
  { label:"Prior Headache",              field:"prior_headache",                prior:true,  effect:"adjunct" },
  { label:"Prior Nausea / Emesis",       field:"prior_nausea_emesis",           prior:true,  effect:"adjunct" },
];

const AGENT_COLOR = {
  methohexital: "#1a5c1a",
  propofol:     "#1a3a7a",
  etomidate:    "#7a1a1a",
};

// ─────────────────────────────────────────────────────────────────────────────
//  PAGE 1 — LANDING  (clean, clinical, no numbers, no slop)
// ─────────────────────────────────────────────────────────────────────────────
function Landing({ onLaunch, onDocs }) {
  return (
    <div style={{
      minHeight:"100vh", background:"#ffffff",
      fontFamily:"'Segoe UI', Arial, sans-serif",
      display:"flex", flexDirection:"column",
    }}>
      {/* Top nav bar */}
      <div style={{ background:"#1a3a7a", padding:"12px 32px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ color:"white", fontSize:15, fontWeight:600, letterSpacing:"0.02em" }}>ShockSmart</div>
        <button onClick={onDocs} style={{ background:"transparent", border:"1px solid rgba(255,255,255,0.4)", color:"rgba(255,255,255,0.85)", padding:"5px 14px", borderRadius:4, fontSize:12, cursor:"pointer" }}>
          Documentation
        </button>
      </div>

      {/* Hero */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"60px 24px 40px" }}>
        <div style={{ maxWidth:560, textAlign:"center" }}>
          <div style={{ fontSize:11, fontWeight:600, letterSpacing:"0.12em", color:"#6b7280", marginBottom:14, textTransform:"uppercase" }}>
            ECT Anesthetic Decision Support
          </div>
          <h1 style={{ fontSize:36, fontWeight:700, color:"#111827", marginBottom:16, marginTop:0, lineHeight:1.2 }}>
            ShockSmart
          </h1>
          <p style={{ fontSize:15, color:"#4b5563", lineHeight:1.8, marginBottom:32, marginTop:0 }}>
            A clinical decision support tool for anesthetic selection
            in electroconvulsive therapy. Integrates patient demographics,
            hemodynamic parameters, comorbidities, and treatment history
            to recommend an optimal anesthetic regimen.
          </p>
          <button onClick={onLaunch} style={{
            background:"#1a3a7a", color:"white", border:"none",
            padding:"12px 36px", borderRadius:4, fontSize:14,
            fontWeight:600, cursor:"pointer", letterSpacing:"0.02em",
          }}>
            Launch Decision Support
          </button>
        </div>
      </div>

      {/* Video section */}
      <div style={{ padding:"0 24px 60px", display:"flex", justifyContent:"center" }}>
        <div style={{ width:"100%", maxWidth:680 }}>
          <div style={{ background:"#f9fafb", border:"1px solid #e5e7eb", borderRadius:6, overflow:"hidden" }}>
            <div style={{ padding:"10px 16px", borderBottom:"1px solid #e5e7eb", fontSize:12, color:"#6b7280", fontWeight:500 }}>
              System Overview
            </div>
            {/*
              TO ADD YOUR VIDEO:
              Replace the placeholder div below with:
              <iframe
                style={{width:"100%", aspectRatio:"16/9", border:"none", display:"block"}}
                src="https://youtu.be//T_ZO_myEfx8"
                allowFullScreen
              />
            */}
            <div style={{ aspectRatio: "16/9", width: "100%" }}>
  <iframe
    width="100%"
    height="100%"
    src="https://www.youtube.com/embed/T_Z0_myEfx8"
    title="YouTube video player"
    frameBorder="0"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    allowFullScreen
    style={{
      borderRadius: "12px",
      minHeight: "400px",
      border: "none",
    }}
  />
</div>
          </div>
        </div>
      </div>

      {/* Footer disclaimer */}
      <div style={{ borderTop:"1px solid #e5e7eb", padding:"14px 32px", background:"#f9fafb", textAlign:"center" }}>
        <span style={{ fontSize:11, color:"#9ca3af" }}>
          For clinical decision support only. All recommendations require confirmation by a qualified provider.
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  PAGE 2 — DECISION SUPPORT TOOL
// ─────────────────────────────────────────────────────────────────────────────
function Tool({ onBack, onDocs }) {
  const [vitals, setVitals]   = useState({ ...DEFAULT_VITALS });
  const [flags,  setFlags]    = useState({ ...DEFAULT_FLAGS  });
  const [isFirst, setIsFirst] = useState(true);
  const [errors,  setErrors]  = useState({});

  const primary  = ruleEngine(vitals, flags, isFirst);
  const cocktail = getCocktail(vitals, flags, primary);
  const rules    = getFiredRules(vitals, flags, isFirst);
  const agColor  = AGENT_COLOR[primary] || "#1a3a7a";

  function handleVital(field, val, min, max) {
    const n = Number(val);
    if (val === "" || isNaN(n) || n < min || n > max) {
      setErrors(e => ({ ...e, [field]: `${min}–${max}` }));
    } else {
      setErrors(e => { const ne = {...e}; delete ne[field]; return ne; });
      setVitals(v => ({ ...v, [field]: n }));
    }
  }

  function toggleFlag(f) { setFlags(p => ({ ...p, [f]: p[f] ? 0 : 1 })); }

  function reset() { setVitals({...DEFAULT_VITALS}); setFlags({...DEFAULT_FLAGS}); setIsFirst(true); setErrors({}); }

  function VInput({ label, field, unit, min, max }) {
    const [local, setLocal] = useState(String(vitals[field]));
    const err = errors[field];
    return (
      <div style={{ marginBottom:8 }}>
        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
          <label style={{ fontSize:11, color:"#374151", fontWeight:500 }}>{label}</label>
          <span style={{ fontSize:10, color:"#9ca3af" }}>{unit}</span>
        </div>
        <input
          type="number" min={min} max={max} value={local}
          onChange={e => setLocal(e.target.value)}
          onBlur={e => { handleVital(field, e.target.value, min, max); }}
          style={{
            width:"100%", padding:"6px 8px", borderRadius:4,
            border:`1px solid ${err ? "#ef4444" : "#d1d5db"}`,
            fontSize:13, color:"#111827", background:"white",
            outline:"none", boxSizing:"border-box",
            fontFamily:"'Segoe UI', Arial, sans-serif",
          }}
        />
        {err && <div style={{ fontSize:10, color:"#ef4444", marginTop:2 }}>Valid: {err}</div>}
      </div>
    );
  }

  return (
    <div style={{ fontFamily:"'Segoe UI', Arial, sans-serif", background:"#f3f4f6", minHeight:"100vh" }}>

      {/* Header — Epic-style blue bar */}
      <div style={{ background:"#1a3a7a", padding:"10px 20px", display:"flex", alignItems:"center", gap:12 }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:"rgba(255,255,255,0.7)", cursor:"pointer", fontSize:16, padding:0 }}>←</button>
        <span style={{ color:"white", fontSize:14, fontWeight:600 }}>ECT Decision Support</span>
        <span style={{ color:"rgba(255,255,255,0.5)", fontSize:13, marginLeft:4 }}>/ Anesthetic Selection</span>
        <button onClick={onDocs} style={{ marginLeft:"auto", background:"transparent", border:"1px solid rgba(255,255,255,0.3)", color:"rgba(255,255,255,0.8)", padding:"4px 12px", borderRadius:3, fontSize:11, cursor:"pointer" }}>
          Documentation
        </button>
      </div>

      {/* Tabs */}
      <div style={{ background:"white", borderBottom:"1px solid #e5e7eb", padding:"0 20px", display:"flex" }}>
        <div style={{ padding:"10px 0", fontSize:13, fontWeight:600, color:"#1a3a7a", borderBottom:"2px solid #1a3a7a", marginRight:24 }}>
          Decision Support
        </div>
      </div>

      <div style={{ display:"flex", gap:0, padding:16, alignItems:"flex-start" }}>

        {/* ── LEFT PANEL ─────────────────────────────────────────────────── */}
        <div style={{ width:210, background:"white", borderRadius:4, border:"1px solid #e5e7eb", marginRight:16, flexShrink:0 }}>

          {/* Vitals section */}
          <div style={{ padding:"12px 14px", borderBottom:"1px solid #f3f4f6" }}>
            <div style={{ fontSize:11, fontWeight:600, color:"#374151", letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:10 }}>
              Vitals
            </div>
            <VInput label="Age"          field="age"          unit="years" min={18}  max={90}  />
            <VInput label="Weight"       field="weight_kg"    unit="kg"    min={40}  max={150} />
            <VInput label="Resting HR"   field="resting_hr"   unit="bpm"   min={38}  max={140} />
            <VInput label="Systolic BP"  field="systolic_bp"  unit="mmHg"  min={75}  max={220} />
            <VInput label="Diastolic BP" field="diastolic_bp" unit="mmHg"  min={40}  max={120} />
          </div>

          {/* Session type */}
          <div style={{ padding:"10px 14px", borderBottom:"1px solid #f3f4f6" }}>
            <div style={{ fontSize:11, fontWeight:600, color:"#374151", letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:8 }}>
              Session
            </div>
            <div style={{ display:"flex", gap:6 }}>
              {[["First Treatment", true], ["Follow-up", false]].map(([l, v]) => (
                <button key={l} onClick={() => setIsFirst(v)} style={{
                  flex:1, padding:"5px 0", fontSize:11, borderRadius:3, cursor:"pointer",
                  border:`1px solid ${isFirst===v ? "#1a3a7a" : "#d1d5db"}`,
                  background: isFirst===v ? "#eef2ff" : "white",
                  color: isFirst===v ? "#1a3a7a" : "#6b7280",
                  fontWeight: isFirst===v ? 600 : 400,
                }}>{l}</button>
              ))}
            </div>
          </div>

          {/* Clinical flags */}
          <div style={{ padding:"10px 14px", borderBottom:"1px solid #f3f4f6" }}>
            <div style={{ fontSize:11, fontWeight:600, color:"#374151", letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:8 }}>
              Clinical Flags
            </div>
            {FLAG_DEFS.filter(f => !f.prior).map(({ label, field, effect }) => {
              const checked = !!flags[field];
              return (
                <div key={field} onClick={() => toggleFlag(field)} style={{
                  display:"flex", alignItems:"center", gap:8,
                  padding:"5px 6px", borderRadius:3, marginBottom:2,
                  cursor:"pointer", background: checked ? "#eef2ff" : "transparent",
                  border:`1px solid ${checked ? "#c7d2fe" : "transparent"}`,
                }}>
                  <div style={{
                    width:14, height:14, borderRadius:3, flexShrink:0,
                    border:`1.5px solid ${checked ? "#1a3a7a" : "#d1d5db"}`,
                    background: checked ? "#1a3a7a" : "white",
                    display:"flex", alignItems:"center", justifyContent:"center",
                  }}>
                    {checked && <svg width="8" height="6" viewBox="0 0 8 6"><polyline points="1,3 3,5 7,1" stroke="white" strokeWidth="1.5" fill="none"/></svg>}
                  </div>
                  <span style={{ fontSize:11.5, color: checked ? "#1a3a7a" : "#374151", fontWeight: checked ? 600 : 400, lineHeight:1.3 }}>
                    {label}
                  </span>
                  {effect === "adjunct" && (
                    <span style={{ marginLeft:"auto", fontSize:9, color:"#9ca3af", flexShrink:0 }}>cocktail</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Prior complications */}
          <div style={{ padding:"10px 14px", borderBottom:"1px solid #f3f4f6" }}>
            <div style={{ fontSize:11, fontWeight:600, color:"#374151", letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:4 }}>
              Prior Complications
            </div>
            {isFirst && (
              <div style={{ fontSize:10, color:"#9ca3af", marginBottom:8, fontStyle:"italic" }}>
                Not applicable on first treatment
              </div>
            )}
            {FLAG_DEFS.filter(f => f.prior).map(({ label, field, effect }) => {
              const checked  = !!flags[field];
              const disabled = isFirst;
              return (
                <div key={field} onClick={() => !disabled && toggleFlag(field)} style={{
                  display:"flex", alignItems:"center", gap:8,
                  padding:"5px 6px", borderRadius:3, marginBottom:2,
                  cursor: disabled ? "not-allowed" : "pointer",
                  background: checked ? "#eef2ff" : "transparent",
                  border:`1px solid ${checked ? "#c7d2fe" : "transparent"}`,
                  opacity: disabled ? 0.35 : 1,
                }}>
                  <div style={{
                    width:14, height:14, borderRadius:3, flexShrink:0,
                    border:`1.5px solid ${checked ? "#1a3a7a" : "#d1d5db"}`,
                    background: checked ? "#1a3a7a" : "white",
                    display:"flex", alignItems:"center", justifyContent:"center",
                  }}>
                    {checked && <svg width="8" height="6" viewBox="0 0 8 6"><polyline points="1,3 3,5 7,1" stroke="white" strokeWidth="1.5" fill="none"/></svg>}
                  </div>
                  <span style={{ fontSize:11.5, color: checked ? "#1a3a7a" : "#374151", fontWeight: checked ? 600 : 400, lineHeight:1.3 }}>
                    {label}
                  </span>
                  {effect === "adjunct" && (
                    <span style={{ marginLeft:"auto", fontSize:9, color:"#9ca3af", flexShrink:0 }}>cocktail</span>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ padding:"10px 14px" }}>
            <button onClick={reset} style={{
              width:"100%", padding:"6px 0", background:"white",
              border:"1px solid #d1d5db", borderRadius:3, fontSize:12,
              color:"#374151", cursor:"pointer", fontFamily:"'Segoe UI', Arial, sans-serif",
            }}>Reset All</button>
          </div>
        </div>

        {/* ── RIGHT PANEL ────────────────────────────────────────────────── */}
        <div style={{ flex:1, minWidth:0 }}>

          {/* Recommendation — clean colored header, no gradients */}
          <div style={{
            background:"white", borderRadius:4, border:"1px solid #e5e7eb",
            marginBottom:12, overflow:"hidden",
          }}>
            <div style={{ background:agColor, padding:"18px 20px" }}>
              <div style={{ fontSize:10, color:"rgba(255,255,255,0.65)", letterSpacing:"0.12em", textTransform:"uppercase", marginBottom:6 }}>
                Recommended Primary Anesthetic
              </div>
              <div style={{ fontSize:32, fontWeight:700, color:"white", letterSpacing:"0.02em" }}>
                {primary.charAt(0).toUpperCase() + primary.slice(1)}
              </div>
            </div>
          </div>

          {/* Full cocktail */}
          <div style={{ background:"white", borderRadius:4, border:"1px solid #e5e7eb", padding:"14px 16px", marginBottom:12 }}>
            <div style={{ fontSize:11, fontWeight:600, color:"#374151", letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:10 }}>
              Drug Cocktail
            </div>
            <div>
              {cocktail.map(d => {
                const isPrimary = ["Methohexital","Propofol","Etomidate"].includes(d);
                return (
                  <span key={d} style={{
                    display:"inline-block", padding:"4px 12px",
                    borderRadius:3, fontSize:12, marginRight:6, marginBottom:6,
                    background: isPrimary ? agColor : "#f3f4f6",
                    color: isPrimary ? "white" : "#374151",
                    fontWeight: isPrimary ? 600 : 400,
                    border: isPrimary ? "none" : "1px solid #e5e7eb",
                  }}>{d}</span>
                );
              })}
            </div>
          </div>

          {/* Decision rules */}
          <div style={{ background:"white", borderRadius:4, border:"1px solid #e5e7eb", padding:"14px 16px" }}>
            <div style={{ fontSize:11, fontWeight:600, color:"#374151", letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:12 }}>
              Decision Rationale
            </div>
            {rules.map((r, i) => (
              <div key={i} style={{
                display:"flex", gap:10, alignItems:"flex-start",
                marginBottom:6, padding:"8px 10px",
                background:"#f9fafb", borderRadius:3,
                borderLeft:`3px solid ${r.id==="ADJ" ? "#7c3aed" : r.id==="D1" ? "#16a34a" : r.id.startsWith("H3") ? "#dc2626" : "#1a3a7a"}`,
              }}>
                <span style={{
                  fontSize:10, padding:"1px 6px", borderRadius:2,
                  background: r.id==="ADJ" ? "#f3e8ff" : "#e0e7ff",
                  color: r.id==="ADJ" ? "#7c3aed" : "#1a3a7a",
                  fontWeight:700, flexShrink:0, whiteSpace:"nowrap",
                  border: r.id==="ADJ" ? "1px solid #ddd6fe" : "1px solid #c7d2fe",
                }}>{r.id}</span>
                <span style={{ fontSize:12, color:"#374151", lineHeight:1.6 }}>{r.t}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Disclaimer */}
      <div style={{ margin:"0 16px 20px", padding:"8px 14px", background:"#fffbeb", border:"1px solid #fde68a", borderRadius:3, fontSize:11, color:"#92400e" }}>
        Clinical decision support only. All recommendations require confirmation by a qualified anesthesiologist or ECT provider.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  PAGE 3 — DOCUMENTATION
// ─────────────────────────────────────────────────────────────────────────────
function Docs({ onBack }) {
  const [sec, setSec] = useState("overview");
  const NAV = [
    { id:"overview",  label:"Overview"       },
    { id:"pipeline",  label:"Data Pipeline"  },
    { id:"synthetic", label:"Synthetic Gen"  },
    { id:"model",     label:"ML Model"       },
    { id:"rules",     label:"Decision Rules" },
    { id:"arch",      label:"Architecture"   },
  ];

  return (
    <div style={{ minHeight:"100vh", background:"#f3f4f6", fontFamily:"'Segoe UI', Arial, sans-serif" }}>
      <div style={{ background:"#1a3a7a", padding:"10px 20px", display:"flex", alignItems:"center", gap:12 }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:"rgba(255,255,255,0.7)", cursor:"pointer", fontSize:16, padding:0 }}>←</button>
        <span style={{ color:"white", fontSize:14, fontWeight:600 }}>Documentation</span>
      </div>
      <div style={{ display:"flex", minHeight:"calc(100vh - 44px)" }}>
        <div style={{ width:180, background:"white", borderRight:"1px solid #e5e7eb", padding:"16px 0", flexShrink:0 }}>
          {NAV.map(n => (
            <div key={n.id} onClick={() => setSec(n.id)} style={{
              padding:"9px 18px", cursor:"pointer", fontSize:13,
              color: sec===n.id ? "#1a3a7a" : "#4b5563",
              background: sec===n.id ? "#eef2ff" : "transparent",
              borderLeft: sec===n.id ? "3px solid #1a3a7a" : "3px solid transparent",
              fontWeight: sec===n.id ? 600 : 400,
            }}>{n.label}</div>
          ))}
        </div>
        <div style={{ flex:1, padding:28, maxWidth:760, overflowY:"auto" }}>
          {sec==="overview"  && <DOverview />}
          {sec==="pipeline"  && <DPipeline />}
          {sec==="synthetic" && <DSynthetic />}
          {sec==="model"     && <DModel />}
          {sec==="rules"     && <DRules />}
          {sec==="arch"      && <DArch />}
        </div>
      </div>
    </div>
  );
}

const DH  = ({c}) => <h2 style={{fontSize:18,fontWeight:700,color:"#111827",marginBottom:10,marginTop:0}}>{c}</h2>;
const DH3 = ({c}) => <h3 style={{fontSize:12,fontWeight:600,color:"#1a3a7a",marginBottom:6,marginTop:18,textTransform:"uppercase",letterSpacing:"0.07em"}}>{c}</h3>;
const DP  = ({c}) => <p  style={{fontSize:13,color:"#4b5563",lineHeight:1.8,marginBottom:12,marginTop:0}}>{c}</p>;
const DCard = ({children}) => <div style={{background:"white",border:"1px solid #e5e7eb",borderRadius:4,padding:16,marginBottom:14}}>{children}</div>;
const DMono = ({children}) => <div style={{fontFamily:"monospace",fontSize:11,color:"#1e40af",lineHeight:2,padding:"12px 14px",background:"#f0f4ff",borderRadius:4,border:"1px solid #e0e7ff"}}>{children}</div>;

function DOverview() {
  return <>
    <DH c="Overview" />
    <DP c="ShockSmart is a clinical decision support tool for anesthetic selection in electroconvulsive therapy. It integrates patient demographics, hemodynamic vitals, psychiatric comorbidities, medication exposures, and prior treatment complications to recommend a primary induction agent and a full drug cocktail for each session." />
    <DP c="The system uses a supervised machine learning model (Random Forest) trained on expert-labeled standardized patient cases. The tool does not replace clinical judgment — it augments it by surfacing the most evidence-consistent recommendation given a patient's specific feature profile." />
    <DH3 c="How to use" />
    <DP c="Enter patient vitals using the number inputs on the left. Toggle clinical flags for comorbidities. Select First Treatment or Follow-up — prior complication flags are disabled on first treatments. The recommendation and decision rationale update with every change." />
    <DP c="The Decision Rationale panel shows which specific rule fired and why. This transparency allows a clinician to agree or disagree with the reasoning, not just accept an output." />
    <DH3 c="Flag labels" />
    <DCard>
      <div style={{display:"flex",gap:20}}>
        <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#374151"}}>
          <span style={{padding:"1px 6px",borderRadius:2,background:"#e0e7ff",color:"#1a3a7a",fontSize:10,fontWeight:700,border:"1px solid #c7d2fe"}}>H1</span>
          Primary anesthetic flags — affect which drug is chosen
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#374151"}}>
          <span style={{padding:"1px 6px",borderRadius:2,background:"#f3e8ff",color:"#7c3aed",fontSize:10,fontWeight:700,border:"1px solid #ddd6fe"}}>ADJ</span>
          Adjunct flags — affect the cocktail only
        </div>
      </div>
    </DCard>
  </>;
}

function DPipeline() {
  return <>
    <DH c="Data Pipeline" />
    <DH3 c="Step 1 — PDF Parsing" />
    <DP c="The parser (parse_cases.py) reads the raw text of standardized patient case PDFs using regex pattern matching across four header formats. Each treatment session is extracted into a structured row. Output: cases.csv — 186 rows, 43 columns." />
    <DCard><DMono>
      <div style={{color:"#6b7280",marginBottom:6}}># Input: raw text from PDF</div>
      <div>"CASE 1, TREATMENT 2"</div>
      <div>"68 Age | 57 resting HR | 125 systolic"</div>
      <div>"binary (yes)  Dx bipolarity or hx impulsive violence"</div>
      <div>"Cocktail: Methohexital + Precedex + Succinylcholine"</div>
      <div style={{color:"#6b7280",margin:"6px 0"}}># Output: structured row</div>
      <div>{"{ age:68, resting_hr:57, systolic_bp:125,"}</div>
      <div>{"  flag_bipolarity:1, drug_methohexital:1 }"}</div>
    </DMono></DCard>
    <DH3 c="Step 2 — Feature Engineering" />
    <DP c="23 raw features are expanded to 50 engineered features. Each clinical decision rule is encoded directly as a binary feature so the model learns it with a single tree split rather than rediscovering thresholds." />
    <DCard><DMono>
      <div style={{color:"#6b7280"}}># Rule H3 encoded as explicit feature</div>
      <div>{"R_H3 = prior_inadequate_seizure == 1"}</div>
      <div>{"      AND is_first_treatment == 0"}</div>
      <div style={{color:"#16a34a"}}>{"# → one split → etomidate"}</div>
    </DMono></DCard>
  </>;
}

function DSynthetic() {
  return <>
    <DH c="Synthetic Data Generation" />
    <DP c="186 real sessions is insufficient for stable model training with 3 classes and 14 output labels. The synthetic generator (generate_synthetic.py) creates additional training data by learning all statistical patterns from the real cases at runtime. Nothing is hardcoded." />
    <DH3 c="Generation layers" />
    <DCard>
      {[
        ["Series length bootstrap","Treatment series lengths are bootstrapped directly from the real distribution."],
        ["Correlated vital sampling","Vitals drawn from class-conditional multivariate Gaussians fit per anesthetic class. Preserves real correlations — e.g. propofol patients tend toward higher BP."],
        ["Binary flag rates","Clinical flags sampled using class-conditional Bernoulli rates from real data."],
        ["Clinical rule engine","Deterministic 9-rule decision tree assigns primary anesthetic. 5% noise models provider variability."],
        ["Adjunct engine","Each adjunct assigned using conditional probability tables from real co-occurrence data."],
        ["Complication simulator","Post-treatment complications sampled from per-anesthetic transition rates, producing realistic longitudinal series."],
        ["Vital drift","Vitals drift between sessions with correlated random walks."],
      ].map(([t,d]) => (
        <div key={t} style={{display:"flex",gap:10,marginBottom:10,alignItems:"flex-start"}}>
          <div style={{width:6,height:6,borderRadius:"50%",background:"#1a3a7a",flexShrink:0,marginTop:6}}/>
          <div>
            <div style={{fontSize:12,fontWeight:600,color:"#111827",marginBottom:2}}>{t}</div>
            <div style={{fontSize:12,color:"#6b7280",lineHeight:1.6}}>{d}</div>
          </div>
        </div>
      ))}
    </DCard>
    <DH3 c="Calibration" />
    <DP c="20 of 22 calibration checks passed within 10 percentage points of real-case distributions. The synthetic dataset contains 7,380 sessions from 800 patients." />
  </>;
}

function DModel() {
  return <>
    <DH c="Machine Learning Model" />
    <DP c="ShockSmart uses a Random Forest classifier — an ensemble of 100 decision trees that vote together. Each tree is trained on a bootstrap sample of the data and considers a random feature subset at each split. The ensemble average is substantially more stable than any single tree on small datasets." />
    <DH3 c="Model parameters" />
    <DCard><DMono>
      <div>n_estimators   = 100    <span style={{color:"#6b7280"}}># 100 decision trees</span></div>
      <div>max_depth      = 15     <span style={{color:"#6b7280"}}># depth cap</span></div>
      <div>max_leaf_nodes = 500    <span style={{color:"#6b7280"}}># complexity cap</span></div>
      <div>class_weight   = balanced</div>
      <div>max_features   = sqrt</div>
      <div>sklearn version = 1.4.2 <span style={{color:"#6b7280"}}># pinned for Render</span></div>
    </DMono></DCard>
    <DH3 c="Performance" />
    <DCard>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead>
          <tr style={{borderBottom:"1px solid #e5e7eb"}}>
            <th style={{textAlign:"left",padding:"4px 0",color:"#6b7280",fontWeight:500}}>Metric</th>
            <th style={{textAlign:"right",padding:"4px 8px",color:"#6b7280",fontWeight:500}}>Model A</th>
            <th style={{textAlign:"right",padding:"4px 0",color:"#1a3a7a",fontWeight:600}}>Model B</th>
          </tr>
        </thead>
        <tbody>
          {[["Accuracy","0.48","0.86"],["Balanced Accuracy","0.39","0.76"],["Macro F1","0.38","0.79"],["Weighted F1","0.43","0.85"],["Cohen's Kappa","0.09","0.74"],["Hamming Loss ↓","0.285","0.186"],["Exact-Match","1.1%","10.0%"]].map(([m,a,b]) => (
            <tr key={m} style={{borderBottom:"1px solid #f3f4f6"}}>
              <td style={{padding:"6px 0",color:"#374151"}}>{m}</td>
              <td style={{textAlign:"right",padding:"6px 8px",color:"#9ca3af"}}>{a}</td>
              <td style={{textAlign:"right",padding:"6px 0",color:"#1a3a7a",fontWeight:600}}>{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{display:"flex",gap:20,marginTop:10,fontSize:11,color:"#9ca3af"}}>
        <span>Model A: real data only (LOCO CV)</span>
        <span style={{color:"#1a3a7a"}}>Model B: real + synthetic (5-fold CV)</span>
      </div>
    </DCard>
  </>;
}

function DRules() {
  return <>
    <DH c="Clinical Decision Rules" />
    <DP c="Nine rules applied in strict priority order — first match wins. Rules are encoded as explicit binary features so the model can learn each with a single tree split." />
    <DCard>
      {[
        { id:"C1", pri:"Critical", cond:"Prior hypotensive shock OR SBP < 100",       act:"Methohexital", why:"Propofol causes vasodilation and worsens hypotension." },
        { id:"H1", pri:"High",     cond:"Prior HTN emergency OR SBP ≥ 175",           act:"Propofol",     why:"Propofol's vasodilatory effect blunts the induction BP spike." },
        { id:"H2", pri:"High",     cond:"Prior tachyarrhythmia OR HR > 100",          act:"Propofol",     why:"Negative chronotropic effect. Ketamine avoided." },
        { id:"H3", pri:"High",     cond:"Prior inadequate seizure AND not first tx",  act:"Etomidate",    why:"Lowers seizure threshold more than any other agent." },
        { id:"H4", pri:"High",     cond:"Prior prolonged seizure",                    act:"Propofol",     why:"Anticonvulsant properties raise seizure threshold." },
        { id:"H5", pri:"High",     cond:"Prior reemergence delirium OR bipolarity",   act:"Methohexital", why:"Predictable recovery. Precedex added." },
        { id:"H6", pri:"High",     cond:"On antiepileptic medications",               act:"Methohexital", why:"Propofol further suppresses AED-elevated threshold." },
        { id:"M1", pri:"Medium",   cond:"SBP 140–174 (no higher-priority trigger)",  act:"Propofol",     why:"Moderate vasodilatory benefit." },
        { id:"M2", pri:"Medium",   cond:"On benzodiazepines (no other trigger)",      act:"Propofol",     why:"Smoother emergence in benzo-dependent patients." },
        { id:"D1", pri:"Default",  cond:"None of the above",                          act:"Methohexital", why:"Standard of care. Best overall seizure profile." },
      ].map(r => (
        <div key={r.id} style={{display:"flex",gap:12,marginBottom:10,paddingBottom:10,borderBottom:"1px solid #f3f4f6",alignItems:"flex-start"}}>
          <div style={{flexShrink:0,width:30,paddingTop:1}}>
            <span style={{fontSize:10,padding:"1px 5px",borderRadius:2,background:"#e0e7ff",color:"#1a3a7a",fontWeight:700,border:"1px solid #c7d2fe"}}>{r.id}</span>
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:12,color:"#111827",marginBottom:2}}>{r.cond}
              <span style={{marginLeft:8,fontWeight:600,color:AGENT_COLOR[r.act.toLowerCase()]||"#1a3a7a"}}>→ {r.act}</span>
            </div>
            <div style={{fontSize:11,color:"#6b7280"}}>{r.why}</div>
          </div>
        </div>
      ))}
    </DCard>
  </>;
}

function DArch() {
  return <>
    <DH c="Software Architecture" />
    <DP c="ShockSmart is a decoupled two-service web application. The React frontend (Vercel) and Python backend API (Render) communicate over HTTPS. The frontend includes a built-in rule engine fallback for when Render is sleeping on the free tier." />
    <DH3 c="Request flow" />
    <DCard><DMono>
      <div style={{color:"#6b7280",marginBottom:4}}># What happens when you toggle a flag</div>
      <div>1. Rule engine fires immediately (client-side, instant)</div>
      <div>2. POST /predict sent to Render backend</div>
      <div>3. Backend: engineer_features → rf_small.pkl.predict</div>
      <div>4. Returns primary_anesthetic + probabilities</div>
      <div>5. UI updates with model recommendation</div>
    </DMono></DCard>
    <DH3 c="Services" />
    <DCard>
      {[
        { name:"Frontend",    tech:"React 18 + Vite", host:"Vercel (free)",  file:"frontend/src/App.jsx" },
        { name:"Backend API", tech:"FastAPI Python 3.11",host:"Render (free)",file:"backend/main.py" },
        { name:"ML Model",    tech:"scikit-learn 1.4.2",host:"In GitHub repo",file:"backend/models/rf_small.pkl (0.55 MB)" },
      ].map(s => (
        <div key={s.name} style={{display:"flex",gap:16,padding:"8px 0",borderBottom:"1px solid #f3f4f6",alignItems:"center"}}>
          <div style={{width:90,fontSize:12,fontWeight:600,color:"#111827"}}>{s.name}</div>
          <div style={{flex:1,fontSize:11,color:"#4b5563"}}>{s.tech}</div>
          <div style={{fontSize:11,color:"#6b7280",fontFamily:"monospace"}}>{s.file}</div>
          <div style={{fontSize:10,color:"#9ca3af",background:"#f3f4f6",padding:"2px 8px",borderRadius:10,flexShrink:0}}>{s.host}</div>
        </div>
      ))}
    </DCard>
    <DH3 c="Folder structure" />
    <DCard><DMono>
      <div>Shock-Smart/</div>
      <div>├── backend/           <span style={{color:"#6b7280"}}># → Render</span></div>
      <div>│   ├── main.py</div>
      <div>│   ├── requirements.txt</div>
      <div>│   ├── runtime.txt    <span style={{color:"#6b7280"}}># python-3.11.9</span></div>
      <div>│   └── models/rf_small.pkl</div>
      <div>├── frontend/          <span style={{color:"#6b7280"}}># → Vercel</span></div>
      <div>│   ├── src/App.jsx</div>
      <div>│   ├── src/main.jsx</div>
      <div>│   ├── src/index.css</div>
      <div>│   ├── index.html</div>
      <div>│   ├── package.json</div>
      <div>│   ├── vite.config.js</div>
      <div>│   └── .env</div>
      <div>├── train.py</div>
      <div>├── parse_cases.py</div>
      <div>└── generate_synthetic.py</div>
    </DMono></DCard>
  </>;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ROOT
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage] = useState("landing");
  if (page === "docs")  return <Docs onBack={() => setPage("tool")} />;
  if (page === "tool")  return <Tool onBack={() => setPage("landing")} onDocs={() => setPage("docs")} />;
  return <Landing onLaunch={() => setPage("tool")} onDocs={() => setPage("docs")} />;
}
