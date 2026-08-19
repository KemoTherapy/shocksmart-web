"""
╔══════════════════════════════════════════════════════════════════════════════╗
║  parse_cases.py  –  ShockSmart  /  Step 1                                   ║
║                                                                              ║
║  PURPOSE                                                                     ║
║  ───────                                                                     ║
║  Convert the raw Standardized Patient Cases text file into a structured CSV. ║
║  Every row = one ECT treatment session.                                      ║
║                                                                              ║
║  OUTPUT SCHEMA                                                               ║
║  ─────────────                                                               ║
║  Features (X)  –  23 binary/numeric clinical inputs                          ║
║  Labels   (y)  –  13 binary drug flags (multi-label) + 1 primary-agent label ║
║                                                                              ║
║  WHY MULTI-LABEL?                                                            ║
║  ────────────────                                                             ║
║  Each treatment session uses a *cocktail* of drugs, not just one.            ║
║  Predicting the full cocktail as a set of binary flags lets us compute:      ║
║    • Hamming loss   (fraction of individual drug flags wrong)                 ║
║    • Per-drug precision / recall / F1                                        ║
║    • Exact-match accuracy  (entire cocktail predicted correctly)             ║
║  This is far more informative than single-class accuracy.                    ║
║                                                                              ║
║  USAGE                                                                       ║
║  ─────                                                                       ║
║    python src/parse_cases.py                                                 ║
║    python src/parse_cases.py --input data/Standardized_Patient_Cases.pdf    ║
║    python src/parse_cases.py --input "data/Standardized Patient Cases.txt"  ║
║                              --output data/cases.csv                         ║
╚══════════════════════════════════════════════════════════════════════════════╝
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path
from typing import Optional

# ── Windows fix: force UTF-8 output so box/bar characters don't crash ────────
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                                  errors="replace")


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 1 – Drug vocabulary
#  ─────────────────────────────
#  Maps a canonical column name → list of spelling variants that appear in
#  the raw text (case-insensitive substring match).
#  This handles the many inconsistent spellings in the source document.
# ══════════════════════════════════════════════════════════════════════════════

DRUG_VOCAB: dict[str, list[str]] = {
    # ── Primary induction agents ─────────────────────────────────────────────
    "drug_methohexital":    ["methohexital"],
    "drug_propofol":        ["propofol"],
    "drug_etomidate":       ["etomidate"],

    # ── Paralytics ───────────────────────────────────────────────────────────
    "drug_succinylcholine": ["succinylcholine"],
    "drug_rocuronium":      ["rocuronium"],
    # Sugammadex is the reversal agent for rocuronium; always paired with it
    "drug_sugammadex":      ["sugammadex"],

    # ── Adjunct anesthetic / sedation ────────────────────────────────────────
    "drug_precedex":        ["precedex", "dexmedetomidine"],
    "drug_ketamine":        ["ketamine"],

    # ── Anticholinergic (secretion control / prevent bradycardia) ────────────
    # Note: three different spellings appear in the source text
    "drug_glycopyrrolate":  ["glycopyrrolate", "glycopyrrholate",
                              "glycopyrroloate"],

    # ── Benzo reversal ───────────────────────────────────────────────────────
    "drug_flumazenil":      ["flumazenil"],

    # ── Analgesics / anti-inflammatory ───────────────────────────────────────
    "drug_tylenol":         ["tylenol", "acetaminophen"],
    "drug_toradol":         ["toradol", "ketorolac"],

    # ── Antiemetic ───────────────────────────────────────────────────────────
    "drug_zofran":          ["zofran", "ondansetron"],

    # ── Cardiovascular ───────────────────────────────────────────────────────
    "drug_labetalol":       ["labetalol", "esmolol"],
}

# Ordered list of drug column names (used for consistent CSV column ordering)
ALL_DRUG_COLS = list(DRUG_VOCAB.keys())

# The three primary induction agents we model explicitly
PRIMARY_AGENTS = ["methohexital", "propofol", "etomidate"]


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 2 – Binary flag maps
#  ─────────────────────────────
#  Each entry: (regex that matches the flag's description text, column name)
#  We scan for lines of the form:   binary (yes/no)  <description>
# ══════════════════════════════════════════════════════════════════════════════

#  Psychiatric / clinical flags (first-treatment features)
PSYCH_FLAG_MAP: list[tuple[str, str]] = [
    (r"bipolarity|impulsive\s+violence",   "flag_bipolarity_or_violence"),
    (r"benzodiazepine",                     "flag_on_benzos"),
    (r"seizure\s+med",                      "flag_on_seizure_meds"),
    (r"chronic\s+pain",                     "flag_chronic_pain"),
    (r"neurocognitive",                     "flag_neurocognitive_disorder"),
    (r"fracture|neuromuscular",             "flag_fracture_neuromuscular"),
    # nausea as a *presenting* symptom (distinct from prior-complication nausea)
    (r"nausea|emesis",                      "flag_baseline_nausea"),
]

#  Prior-session complication flags (subsequent-treatment features)
PRIOR_FLAG_MAP: list[tuple[str, str]] = [
    (r"reemergence\s+deli",                "prior_reemergence_delirium"),
    (r"hypertensive\s+em",                  "prior_htn_emergency"),
    (r"hypotensive\s+shock",               "prior_hypotensive_shock"),
    (r"bradyarrhythmia",                   "prior_bradyarrhythmia"),
    (r"tachyarrhythmia",                   "prior_tachyarrhythmia"),
    (r"prolonged\s+seizure",               "prior_prolonged_seizure"),
    (r"inadequate\s+seizure",              "prior_inadequate_seizure"),
    # headache: match standalone (avoid matching nausea or emesis lines)
    (r"^.*\bheadache\b(?!.*nausea)",       "prior_headache"),
    (r"nausea\s+or\s+emesis",              "prior_nausea_emesis"),
]

PSYCH_COLS = [col for _, col in PSYCH_FLAG_MAP]
PRIOR_COLS = [col for _, col in PRIOR_FLAG_MAP]


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 3 – Text utilities
# ══════════════════════════════════════════════════════════════════════════════

def _yn(text: str) -> int:
    """'yes' in text → 1, else → 0 (case-insensitive)."""
    return 1 if re.search(r"\byes\b", text, re.I) else 0


def _find_drug(cocktail: str, variants: list[str]) -> int:
    """Return 1 if any variant appears in the cocktail string."""
    c = cocktail.lower()
    return int(any(v in c for v in variants))


def _primary_agent(cocktail: str) -> str:
    """
    Extract the single primary induction agent from a cocktail string.
    Priority: etomidate > propofol > methohexital.

    Rationale for priority order:
      - Etomidate is reserved for difficult seizure cases; if it's in the
        cocktail it's definitely the primary agent.
      - Propofol is used when etomidate is not, and overrides methohexital
        when both appear (rare; methohexital sometimes given post-procedure).
      - Methohexital is the default fallback.
    """
    c = cocktail.lower()
    for agent in ["etomidate", "propofol", "methohexital"]:
        if agent in c:
            return agent
    return "other"


def _complication_is_none(text: str) -> int:
    t = text.strip().lower()
    return int(not t or "none" in t or "no complication" in t)


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 4 – Block splitter
# ══════════════════════════════════════════════════════════════════════════════

#  Handles both "CASE 1, TREATMENT 2"  and  "Case 1 Treatment 2"
CASE_HEADER_RE = re.compile(
    # Matches all four formats found in the source document:
    #   CASE 1, TREATMENT 2      (uppercase, comma)
    #   CASE 10 TREATMENT 3      (uppercase, no comma)
    #   Case 12 Treatment 4      (title-case, no comma)   ← cases 12-20
    #   Case 14, Treatment 1     (title-case, comma)
    # \b word boundary + re.I handles any capitalisation variation
    r"\bcase\s+(\d+)\s*,?\s*treatment\s+(\d+)",
    re.I,
)


def split_blocks(raw: str) -> list[tuple[int, int, str]]:
    """
    Split raw text into (case_id, treatment_num, block_text) tuples.
    Each block covers one case-treatment header through the next header.
    """
    hits = [(m.start(), int(m.group(1)), int(m.group(2)))
            for m in CASE_HEADER_RE.finditer(raw)]
    blocks = []
    for i, (start, case, tx) in enumerate(hits):
        end = hits[i + 1][0] if i + 1 < len(hits) else len(raw)
        blocks.append((case, tx, raw[start:end]))
    return blocks


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 5 – Field extractors
# ══════════════════════════════════════════════════════════════════════════════

def extract_binary_flags(block: str,
                         flag_map: list[tuple[str, str]]) -> dict[str, int]:
    """
    For every (pattern, column) pair in flag_map, scan lines matching:
        binary (yes/no)  <description text matching pattern>
    and return a dict of {column: 0 or 1}.
    """
    result = {col: 0 for _, col in flag_map}

    for line in block.splitlines():
        m = re.match(r"\s*binary\s*\((yes|no)\)\s*(.*)", line, re.I)
        if not m:
            continue
        value = _yn(m.group(1))
        desc  = m.group(2)
        for pattern, col in flag_map:
            if re.search(pattern, desc, re.I):
                result[col] = value
                break   # each line maps to at most one flag

    return result


def extract_vitals(block: str) -> dict[str, Optional[float]]:
    """
    Extract age, resting_hr, systolic_bp, diastolic_bp, weight_kg.

    The source document uses two formats:
      A) Labeled-number format:    68 Age   /   57 resting HR   /   125 systolic
      B) Narrative format:         "resting HR 57"  /  "BP 125/75"  / "weighing 82.5kg"

    We try A first (more reliable), fall back to B.
    """
    v: dict[str, Optional[float]] = dict(
        age=None, resting_hr=None,
        systolic_bp=None, diastolic_bp=None, weight_kg=None,
    )

    for line in block.splitlines():
        s = line.strip()

        if v["age"] is None:
            m = re.match(r"^(\d+)\s+Age\b", s, re.I)
            if m:
                v["age"] = int(m.group(1))

        if v["resting_hr"] is None:
            m = re.match(r"^(\d+)\s+resting\s+HR\b", s, re.I)
            if m:
                v["resting_hr"] = int(m.group(1))

        if v["systolic_bp"] is None:
            m = re.match(r"^(\d{2,3})\s+systolic\b", s, re.I)
            if m:
                v["systolic_bp"] = int(m.group(1))

        if v["diastolic_bp"] is None:
            m = re.match(r"^(\d{2,3})\s+diastolic\b", s, re.I)
            if m:
                v["diastolic_bp"] = int(m.group(1))

        if v["weight_kg"] is None:
            m = re.match(r"^([\d.]+)\s*kg\b", s, re.I)
            if m:
                v["weight_kg"] = float(m.group(1))

    # ── Fallbacks: narrative formats ─────────────────────────────────────────

    if v["age"] is None:
        # "Patient is a 68 yo male …"  OR  "A 45-year-old male …"
        m = re.search(r"(\d+)\s*[-\s](?:yo|year[s]?\s*[-\s]\s*old)", block, re.I)
        if m:
            v["age"] = int(m.group(1))
        # "Age: 80"  (cases 10-20 inline format)
        if v["age"] is None:
            m = re.search(r"\bAge\s*:\s*(\d+)", block, re.I)
            if m:
                v["age"] = int(m.group(1))

    if v["resting_hr"] is None:
        # "resting HR 57"  or  "HR of 88 bpm"
        m = re.search(r"(?:resting\s+)?HR\s+(?:of\s+)?(\d+)", block, re.I)
        if m:
            v["resting_hr"] = int(m.group(1))
        # "resting heart rate of 88 bpm"  (cases 12-20 narrative)
        if v["resting_hr"] is None:
            m = re.search(r"resting\s+heart\s+rate\s+(?:of\s+)?(\d+)", block, re.I)
            if m:
                v["resting_hr"] = int(m.group(1))
        # "Resting HR: 88"  (cases 10-20 table format)
        if v["resting_hr"] is None:
            m = re.search(r"Resting\s+HR\s*:\s*(\d+)", block, re.I)
            if m:
                v["resting_hr"] = int(m.group(1))
        # "heart rate is 72 beats per minute"
        if v["resting_hr"] is None:
            m = re.search(r"heart\s+rate\s+(?:is\s+)?(\d+)\s*beats", block, re.I)
            if m:
                v["resting_hr"] = int(m.group(1))
        # "Resting HR: High" sentinel
        if v["resting_hr"] is None and re.search(r"Resting HR.*High", block, re.I):
            v["resting_hr"] = 105

    if v["systolic_bp"] is None or v["diastolic_bp"] is None:
        # "BP 125/75"  or  "blood pressure of 170/85 mmHg"  or  "145/95"
        for pat in [
            r"BP\s+(\d{2,3})[/\\](\d{2,3})",
            r"blood\s+pressure.*?(\d{2,3})[/\\](\d{2,3})",
            r"\b(\d{2,3})[/\\](\d{2,3})\s*(?:mmHg)?",
        ]:
            m = re.search(pat, block, re.I)
            if m:
                v["systolic_bp"]  = int(m.group(1))
                v["diastolic_bp"] = int(m.group(2))
                break
        if v["systolic_bp"] is None and re.search(r"Resting Systolic BP.*High", block, re.I):
            v["systolic_bp"]  = 150
            v["diastolic_bp"] = 90
        # "Resting Systolic BP: 150 Resting Diastolic BP: 85"  (cases 10-20)
        if v["systolic_bp"] is None:
            m = re.search(r"Resting\s+Systolic\s+BP\s*:\s*(\d+)", block, re.I)
            if m:
                v["systolic_bp"] = int(m.group(1))
        if v["diastolic_bp"] is None:
            m = re.search(r"Resting\s+Diastolic\s+BP\s*:\s*(\d+)", block, re.I)
            if m:
                v["diastolic_bp"] = int(m.group(1))

    if v["weight_kg"] is None:
        for pat in [
            r"weighing\s+([\d.]+)\s*kg",
            r"Weight\s*\(kg\)[:\s]+([\d.]+)",          # "Weight (kg): 79"
            r"weight\s+(?:is\s+)?([\d.]+)\s*(?:kg|kilograms)",
            r"([\d.]+)\s*kilogram",
        ]:
            m = re.search(pat, block, re.I)
            if m:
                v["weight_kg"] = float(m.group(1))
                break

    return v


def extract_sex(block: str) -> int:
    """Return 1 for female, 0 for male."""
    m = re.search(r"\b(male|female)\b", block, re.I)
    return 1 if m and m.group(1).lower() == "female" else 0


def extract_cocktail(block: str) -> str:
    """Return the text on the 'Cocktail: ...' line."""
    m = re.search(r"Cocktail\s*:\s*(.+?)(?:\n|$)", block, re.I)
    return m.group(1).strip() if m else ""


def extract_complication(block: str) -> str:
    """Return the complication text (Complication: ... OR Complicated by ...)."""
    m = re.search(r"Complication[s]?\s*:\s*(.+?)(?:\n|$)", block, re.I)
    if m:
        return m.group(1).strip()
    m = re.search(r"Complicated\s+by\s+(.+?)(?:\.|$)", block, re.I)
    return m.group(1).strip() if m else ""


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 6 – Single-block parser
# ══════════════════════════════════════════════════════════════════════════════

def parse_block(case_id: int, tx_num: int, block: str) -> Optional[dict]:
    """
    Parse one CASE X / TREATMENT Y block into a flat feature dict.
    Returns None if no cocktail could be extracted (malformed block).
    """

    # ── Identify prior-complications section ─────────────────────────────────
    prior_section_re = re.compile(
        r"Prior Complications|Subsequent treatment Factors", re.I)
    split = prior_section_re.split(block, maxsplit=1)
    psych_block = split[0]
    prior_block  = split[1] if len(split) > 1 else ""

    # ── Extract everything ────────────────────────────────────────────────────
    psych_flags  = extract_binary_flags(psych_block, PSYCH_FLAG_MAP)
    prior_flags  = extract_binary_flags(prior_block, PRIOR_FLAG_MAP)
    vitals       = extract_vitals(block)
    sex_female   = extract_sex(block)
    cocktail     = extract_cocktail(block)
    complication = extract_complication(block)

    if not cocktail:
        return None  # can't label this row

    # ── Build drug label flags ────────────────────────────────────────────────
    drug_flags = {
        col: _find_drug(cocktail, variants)
        for col, variants in DRUG_VOCAB.items()
    }

    # ── Primary-agent label (for reference / single-label comparisons) ────────
    primary = _primary_agent(cocktail)
    if primary == "other":
        return None  # discard rows with no recognised induction agent

    row = {
        # ── Identifiers ───────────────────────────────────────────────────────
        "case_id":            case_id,
        "treatment_num":      tx_num,
        "is_first_treatment": int(tx_num == 1),
        # ── Demographics ──────────────────────────────────────────────────────
        "age":                vitals["age"],
        "sex_female":         sex_female,
        "weight_kg":          vitals["weight_kg"],
        # ── Vitals ────────────────────────────────────────────────────────────
        "resting_hr":         vitals["resting_hr"],
        "systolic_bp":        vitals["systolic_bp"],
        "diastolic_bp":       vitals["diastolic_bp"],
        # ── Psychiatric / clinical flags ──────────────────────────────────────
        **psych_flags,
        # ── Prior complication flags ───────────────────────────────────────────
        **prior_flags,
        # ── Multi-label drug targets ──────────────────────────────────────────
        **drug_flags,
        # ── Single-label primary agent (convenience) ──────────────────────────
        "primary_anesthetic": primary,
        # ── Raw strings for audit ─────────────────────────────────────────────
        "cocktail_raw":       cocktail,
        "complication_raw":   complication,
        "complication_none":  _complication_is_none(complication),
    }
    return row


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 7 – CSV column order
# ══════════════════════════════════════════════════════════════════════════════

FEATURE_COLS = [
    "is_first_treatment",
    "age", "sex_female", "weight_kg",
    "resting_hr", "systolic_bp", "diastolic_bp",
    *PSYCH_COLS,
    *PRIOR_COLS,
]

OUTPUT_COLS = [
    "case_id", "treatment_num",
    *FEATURE_COLS,
    *ALL_DRUG_COLS,          # 14 binary drug flags
    "primary_anesthetic",    # single-label convenience column
    "cocktail_raw",
    "complication_raw",
    "complication_none",
]


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 8 – Main entry point
# ══════════════════════════════════════════════════════════════════════════════

def extract_pdf_to_text(pdf_path: str) -> str:
    """
    Extract plain text from a PDF using pdftotext (poppler).
    Falls back to pypdf if pdftotext is not installed.

    Why pdftotext over pypdf:
      pdftotext preserves the reading order that pypdf sometimes mangles,
      which matters for the line-by-line regex patterns we use below.
    """
    import subprocess, shutil

    if shutil.which("pdftotext"):
        result = subprocess.run(
            ["pdftotext", pdf_path, "-"],
            capture_output=True, text=True, encoding="utf-8", errors="ignore"
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout

    # Fallback: pypdf
    try:
        from pypdf import PdfReader
        reader = PdfReader(pdf_path)
        return "\n".join(
            page.extract_text() or "" for page in reader.pages
        )
    except Exception as e:
        sys.exit(f"❌  Could not read PDF '{pdf_path}': {e}\n"
                 f"    Install poppler:  https://poppler.freedesktop.org/\n"
                 f"    Or pypdf:  pip install pypdf")


def parse_file(input_path: str, output_path: str) -> list[dict]:
    # ── Read file (PDF or plain text) ─────────────────────────────────────────
    p = Path(input_path)
    try:
        if p.suffix.lower() == ".pdf":
            print(f"\n  Extracting text from PDF '{p.name}' ...")
            raw = extract_pdf_to_text(str(p))
        else:
            raw = p.read_text(encoding="utf-8", errors="ignore")
    except FileNotFoundError:
        sys.exit(
            f"\n❌  File not found: {input_path}\n"
            f"    Place the PDF or TXT in the data/ folder and run from\n"
            f"    the shocksmart/ root directory:\n"
            f"      python src/parse_cases.py --input data/Standardized_Patient_Cases.pdf\n"
        )

    raw = raw.replace("\r\n", "\n").replace("\r", "\n")

    blocks = split_blocks(raw)

    # ── Immediate diagnostic (printed before anything else) ───────────────────
    print(f"\n  Scanning '{Path(input_path).name}' ...")
    print(f"  Blocks found : {len(blocks)}")
    if len(blocks) < 100:
        print(f"\n  ⚠️  WARNING: Expected ~186 blocks. Only {len(blocks)} found.")
        print(f"     Check that you are running from the shocksmart/ root directory")
        print(f"     and not using VS Code Code Runner (use terminal instead):")
        print(f"     > python src/parse_cases.py")

    if not blocks:
        sys.exit("❌  No CASE/TREATMENT headers found. Check input file path.")

    rows, skipped = [], 0
    for case_id, tx_num, block in blocks:
        row = parse_block(case_id, tx_num, block)
        if row is None:
            skipped += 1
            continue
        rows.append(row)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_COLS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

    # ── Summary ──────────────────────────────────────────────────────────────
    print(f"\n{'─'*60}")
    print(f"  STEP 1 — Parsing complete")
    print(f"{'─'*60}")
    print(f"  Blocks found  : {len(blocks)}")
    print(f"  Rows kept     : {len(rows)}")
    print(f"  Rows skipped  : {skipped}  (no cocktail / no known induction agent)")
    print(f"\n  Primary anesthetic distribution:")

    from collections import Counter
    counts = Counter(r["primary_anesthetic"] for r in rows)
    total  = len(rows)
    for drug in ["methohexital", "propofol", "etomidate"]:
        n   = counts.get(drug, 0)
        bar = "█" * n
        print(f"    {drug:<16} {n:>3} ({n/total*100:.0f}%)  {bar}")

    print(f"\n  Drug flag prevalence (multi-label targets):")
    for col in ALL_DRUG_COLS:
        n   = sum(r.get(col, 0) for r in rows)
        bar = "█" * int(n / total * 30)
        print(f"    {col:<26} {n:>3} ({n/total*100:.0f}%)  {bar}")

    print(f"\n  Missing vitals:")
    for col in ["age", "resting_hr", "systolic_bp", "diastolic_bp", "weight_kg"]:
        n_miss = sum(1 for r in rows if r.get(col) is None)
        print(f"    {col:<16}  {n_miss} missing")

    print(f"\n  Saved → {output_path}")
    print(f"{'─'*60}\n")
    return rows


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="ShockSmart Step 1 – Parse cases")
    ap.add_argument("--input",  default="data/Standardized_Patient_Cases.pdf",
                    help="PDF or TXT file (default: data/Standardized_Patient_Cases.pdf)")
    ap.add_argument("--output", default="data/cases.csv")
    args = ap.parse_args()
    parse_file(args.input, args.output)