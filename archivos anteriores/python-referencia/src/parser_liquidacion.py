"""Parser for Marval pre-liquidacion PDFs (CONTROL DE LIQUIDACIÓN).

Text-based line parser — no coordinate detection needed.
Employee blocks start with 'Legajo: XXXX' and end at the next 'Legajo:' or page end.

Totals extracted from:
  'Total Haberes: X  Total Descuentos: X  ...  Total Netos: X'
  'Total Imponible: X  ...  Costo Laboral: X'   ← Costo Laboral = Total Contribuciones
"""
import re
from typing import Dict, List, Optional

import pdfplumber

from .models import Concepto, LiquidacionEmpleado

# Internal concept codes — never required in receipts
INTERNAL_CODES = {'5911', '5921', '7100'}

# Keywords that mark provision/internal concepts (case-insensitive)
PROVISION_KEYWORDS = [
    'provision', 'provisión', 'prov.', 'reversion', 'reversión',
    'rev. prov', 'rever.', 'bonus prov', 'prov ccss',
]

# Concept line: CODE [space] description [optional unit like "11,00"] amount
# pdfplumber sometimes merges code+description with no space (e.g. "3025Comp. gastos")
_CONCEPTO_RE = re.compile(
    r'^(-?\d{3,6})\s*'           # code (3-6 digits, optional leading minus)
    r'(.+?)\s+'                   # description (non-greedy)
    r'(?:\d{1,4},\d{2}\s+)?'     # optional unit like "11,00" or "4,00"
    r'(-?(?:\d{1,3}\.)*\d{1,3},\d{2})\s*$'  # amount in AR format
)

# Employee header line
_LEGAJO_RE = re.compile(r'Legajo:\s*(\d+)\s+Empleado:\s*(.+?)\s+Categor')

# Total lines
_TOTAL_HABERES_RE = re.compile(r'Total Haberes:\s*([\d.,]+)')
_TOTAL_DESC_RE    = re.compile(r'Total Descuentos:\s*([\d.,]+)')
_TOTAL_NETOS_RE   = re.compile(r'Total Netos:\s*([\d.,]+)')
# Costo Laboral = Total Contribuciones (reliable, no pdfplumber merge bug)
_COSTO_LABORAL_RE = re.compile(r'Costo Laboral:\s*([\d.,]+)')


def is_internal(codigo: str, descripcion: str) -> bool:
    if codigo.lstrip('-') in INTERNAL_CODES:
        return True
    desc_lower = descripcion.lower()
    return any(kw in desc_lower for kw in PROVISION_KEYWORDS)


def parse_money(s: str) -> Optional[float]:
    """Convert AR-format money string (dots=thousands, comma=decimal) to float."""
    if not s:
        return None
    s = re.sub(r'[$\s]', '', str(s)).strip()
    if not s:
        return None
    # AR format: 1.234.567,89
    if re.match(r'^-?(?:\d{1,3}\.)*\d{1,3},\d{2}$', s):
        return float(s.replace('.', '').replace(',', '.'))
    # US format (fallback): 1,234,567.89
    if re.match(r'^-?[\d,]+\.\d{1,2}$', s):
        return float(s.replace(',', ''))
    if re.match(r'^-?\d+$', s):
        return float(s)
    return None


def _flush_employee(
    current: LiquidacionEmpleado,
    results: Dict[str, List[LiquidacionEmpleado]],
) -> None:
    if not current.legajo:
        return
    if current.legajo not in results:
        results[current.legajo] = []
    results[current.legajo].append(current)


def _parse_text(
    text: str,
    results: Dict[str, List[LiquidacionEmpleado]],
    current_holder: list,  # mutable single-element list so we can update across lines
) -> None:
    """Parse one page's text, accumulating employee blocks into results."""
    for line in text.split('\n'):
        line = line.strip()
        if not line:
            continue

        # --- New employee block ---
        m = _LEGAJO_RE.search(line)
        if m:
            if current_holder[0] is not None:
                _flush_employee(current_holder[0], results)
            legajo = m.group(1).lstrip('0') or '0'
            nombre = m.group(2).strip().rstrip(',').strip()
            current_holder[0] = LiquidacionEmpleado(
                legajo=legajo, nombre=nombre,
                bruto=None, neto=None,
                total_rem=None, total_desc=None,
                total_no_rem=None, total_contrib=None,
            )
            continue

        emp = current_holder[0]
        if emp is None:
            continue

        # --- Skip header rows ---
        if line.startswith('CONCEPTO') or line.startswith('Marval') \
                or line.startswith('CONTROL') or line.startswith('Mes y Año') \
                or line.startswith('Ingreso:'):
            continue

        # --- Total lines ---
        m_hab = _TOTAL_HABERES_RE.search(line)
        if m_hab:
            emp.bruto = parse_money(m_hab.group(1))
            m_desc = _TOTAL_DESC_RE.search(line)
            if m_desc:
                emp.total_desc = parse_money(m_desc.group(1))
            m_net = _TOTAL_NETOS_RE.search(line)
            if m_net:
                emp.neto = parse_money(m_net.group(1))
            continue

        m_cl = _COSTO_LABORAL_RE.search(line)
        if m_cl:
            emp.total_contrib = parse_money(m_cl.group(1))
            continue

        # --- Concept line ---
        m_c = _CONCEPTO_RE.match(line)
        if m_c:
            code = m_c.group(1).lstrip('-')  # strip minus from code for lookup
            desc = m_c.group(2).strip()
            amount_str = m_c.group(3)
            if is_internal(code, desc):
                continue
            amount = parse_money(amount_str)
            if amount is not None:
                emp.conceptos.append(
                    Concepto(codigo=code, descripcion=desc, monto=abs(amount))
                )


def _consolidate(blocks: List[LiquidacionEmpleado]) -> LiquidacionEmpleado:
    """Sum multiple blocks for same legajo (employees with >1 payroll run)."""
    if len(blocks) == 1:
        b = blocks[0]
        b.n_bloques = 1
        return b

    base = LiquidacionEmpleado(
        legajo=blocks[0].legajo,
        nombre=blocks[0].nombre,
        bruto=None, neto=None,
        total_rem=None, total_desc=None,
        total_no_rem=None, total_contrib=None,
        n_bloques=len(blocks),
    )
    for b in blocks:
        for attr in ('bruto', 'neto', 'total_desc', 'total_contrib'):
            bv = getattr(base, attr)
            ev = getattr(b, attr)
            if ev is not None:
                setattr(base, attr, round((bv or 0.0) + ev, 2))
        base.conceptos.extend(b.conceptos)

    # Merge conceptos: sum repeated codes
    merged: Dict[str, Concepto] = {}
    for c in base.conceptos:
        if c.codigo in merged:
            merged[c.codigo] = Concepto(
                codigo=c.codigo, descripcion=c.descripcion,
                monto=round(merged[c.codigo].monto + c.monto, 2),
            )
        else:
            merged[c.codigo] = c
    base.conceptos = list(merged.values())
    return base


def parse_liquidacion(pdf_paths: List[str], verbose: bool = False) -> Dict[str, LiquidacionEmpleado]:
    """Parse one or more liquidation PDF parts. Returns dict keyed by legajo."""
    raw: Dict[str, List[LiquidacionEmpleado]] = {}
    current_holder = [None]  # carries state between pages of same part

    for path in pdf_paths:
        current_holder[0] = None  # reset between parts (each part is independent)
        with pdfplumber.open(path) as pdf:
            if verbose:
                print(f'[INFO] Procesando {path}: {len(pdf.pages)} páginas')
            for page in pdf.pages:
                text = page.extract_text() or ''
                _parse_text(text, raw, current_holder)
        # Flush last employee of each part
        if current_holder[0] is not None:
            _flush_employee(current_holder[0], raw)

    results: Dict[str, LiquidacionEmpleado] = {}
    for legajo, blocks in raw.items():
        results[legajo] = _consolidate(blocks)

    if verbose:
        multi = sum(1 for b in raw.values() if len(b) > 1)
        print(f'[INFO] Liquidación: {len(results)} empleados ({multi} con múltiples bloques)')

    return results
