"""Parser for Marval pre-liquidacion PDFs (01-Preliquidacion mensual.pdf).

Uses pdfplumber coordinate-based column detection.
Column x-midpoints (calibrated from Marval format):
  REM   ~234  | DESC  ~332  | NOREM ~415  | CONTRIB ~512

Column boundaries (midpoints between adjacent columns):
  CONCEPTO: x < 200
  REM:      200 <= x < 283
  DESC:     283 <= x < 373
  NOREM:    373 <= x < 463
  CONTRIB:  x >= 463
"""
import re
from typing import Dict, List, Optional, Tuple

import pdfplumber

from .models import Concepto, LiquidacionEmpleado

# Internal concept codes that should NOT be required in receipts
INTERNAL_CODES = {'5911', '5921', '7100'}

# Keywords that identify provision/internal concepts (case-insensitive)
PROVISION_KEYWORDS = [
    'provision', 'provisión', 'prov.', 'vacac.prov', 'sac prov',
    'bonus prov', 'bonif.prov', 'prov vac',
]

# Column x-boundaries (can be overridden via calibrate_columns())
_COL_BOUNDS = [
    ('CONCEPTO', 0,   200),
    ('REM',      200, 283),
    ('DESC',     283, 373),
    ('NOREM',    373, 463),
    ('CONTRIB',  463, 9999),
]

# Keywords for total lines in the liquidation
_TOTAL_KEYWORDS = {
    'neto':    re.compile(r'\bNeto\b', re.I),
    'rem':     re.compile(r'Total\s+Rem', re.I),
    'desc':    re.compile(r'Total\s+Desc', re.I),
    'no_rem':  re.compile(r'Total\s+No\s*Rem|Total\s+N\.?\s*Rem', re.I),
    'contrib': re.compile(r'Total\s+Contrib', re.I),
}

# Legajo detection: a standalone number (3-6 digits) at start of a text block
_LEGAJO_RE = re.compile(r'^(\d{3,6})\s+(.+)$')


def is_internal(codigo: str, descripcion: str) -> bool:
    if codigo.lstrip('-') in INTERNAL_CODES:
        return True
    desc_lower = descripcion.lower()
    return any(kw in desc_lower for kw in PROVISION_KEYWORDS)


def parse_money(s: str) -> Optional[float]:
    if not s:
        return None
    s = re.sub(r'[$\s]', '', str(s)).strip()
    if not s:
        return None
    # Fix pdfplumber merge artifacts like "2:.949.371,56" -> "2.949.371,56"
    s = re.sub(r'(\d):\.', r'\1.', s)
    # US format
    if re.match(r'^-?[\d,]+\.\d{1,2}$', s):
        return float(s.replace(',', ''))
    # AR format
    if re.match(r'^-?[\d.]+,\d{1,2}$', s):
        return float(s.replace('.', '').replace(',', '.'))
    if re.match(r'^-?\d+$', s):
        return float(s)
    return None


def _classify_col(x_center: float) -> str:
    for name, lo, hi in _COL_BOUNDS:
        if lo <= x_center < hi:
            return name
    return 'UNKNOWN'


def _group_words_into_rows(words: list, y_tol: float = 3.0) -> List[List[dict]]:
    """Group pdfplumber words into horizontal rows by y position."""
    if not words:
        return []
    rows: List[List[dict]] = []
    current_row: List[dict] = [words[0]]
    current_y = (words[0]['top'] + words[0]['bottom']) / 2

    for w in words[1:]:
        w_y = (w['top'] + w['bottom']) / 2
        if abs(w_y - current_y) <= y_tol:
            current_row.append(w)
        else:
            rows.append(sorted(current_row, key=lambda x: x['x0']))
            current_row = [w]
            current_y = w_y

    if current_row:
        rows.append(sorted(current_row, key=lambda x: x['x0']))

    return rows


def _row_to_columns(row: List[dict]) -> Dict[str, str]:
    """Map a row of words to column names based on x position."""
    cols: Dict[str, List[str]] = {name: [] for name, *_ in _COL_BOUNDS}
    for w in row:
        x_center = (w['x0'] + w['x1']) / 2
        col = _classify_col(x_center)
        if col in cols:
            cols[col].append(w['text'])
    return {k: ' '.join(v) for k, v in cols.items()}


def _is_money(s: str) -> bool:
    s = s.replace('.', '').replace(',', '').replace('-', '').strip()
    return bool(s) and s.isdigit()


def _parse_page_rows(
    rows: List[List[dict]],
    accumulator: Dict[str, List[LiquidacionEmpleado]],
    page_num: int,
) -> None:
    """
    Process rows from one page and append employee blocks to accumulator.
    accumulator maps legajo -> list of LiquidacionEmpleado blocks.
    """
    current: Optional[LiquidacionEmpleado] = None

    for row in rows:
        cols = _row_to_columns(row)
        concepto_text = cols.get('CONCEPTO', '').strip()
        if not concepto_text:
            continue

        # --- Detect start of new employee block ---
        m = _LEGAJO_RE.match(concepto_text)
        if m and not any(cols.get(c, '').strip()
                         for c in ('REM', 'DESC', 'NOREM', 'CONTRIB')):
            # This row has legajo + name in CONCEPTO col and no amounts
            if current is not None:
                _finalize_block(current, accumulator)
            legajo = m.group(1)
            nombre = m.group(2).strip()
            current = LiquidacionEmpleado(
                legajo=legajo, nombre=nombre,
                bruto=None, neto=None,
                total_rem=None, total_desc=None,
                total_no_rem=None, total_contrib=None,
            )
            continue

        if current is None:
            continue

        # --- Detect total lines ---
        for key, pattern in _TOTAL_KEYWORDS.items():
            if pattern.search(concepto_text):
                amount_str = (
                    cols.get('REM', '') or cols.get('DESC', '') or
                    cols.get('NOREM', '') or cols.get('CONTRIB', '') or
                    cols.get('CONCEPTO', '')
                )
                # Try to find a money value in the row (any column after CONCEPTO)
                for col_name in ('REM', 'DESC', 'NOREM', 'CONTRIB'):
                    val = cols.get(col_name, '').strip()
                    if val and _is_money(val.replace('.', '').replace(',', '')):
                        amount = parse_money(val)
                        if amount is not None:
                            if key == 'neto':
                                current.neto = amount
                            elif key == 'rem':
                                current.total_rem = amount
                            elif key == 'desc':
                                current.total_desc = amount
                            elif key == 'no_rem':
                                current.total_no_rem = amount
                            elif key == 'contrib':
                                current.total_contrib = amount
                            break
                break
        else:
            # --- Regular concept line ---
            # CONCEPTO has: "CODE description"
            code_m = re.match(r'^(-?\d{3,6})\s+(.*)', concepto_text)
            if not code_m:
                continue
            code = code_m.group(1)
            desc = code_m.group(2).strip()

            if is_internal(code, desc):
                continue

            # Find which column has the amount
            for col_name in ('REM', 'DESC', 'NOREM', 'CONTRIB'):
                val = cols.get(col_name, '').strip()
                if not val:
                    continue
                amount = parse_money(val)
                if amount is not None:
                    current.conceptos.append(
                        Concepto(codigo=code, descripcion=desc,
                                 monto=amount, columna=col_name)
                    )
                    # A concept can appear in multiple columns (e.g. SAC splits)
                    # We collect each separately

    # Finalize last block on page
    if current is not None:
        _finalize_block(current, accumulator)


def _finalize_block(
    block: LiquidacionEmpleado,
    accumulator: Dict[str, List[LiquidacionEmpleado]],
) -> None:
    """Compute bruto = total_rem + total_no_rem and store block."""
    if block.total_rem is not None and block.total_no_rem is not None:
        block.bruto = round(block.total_rem + block.total_no_rem, 2)
    elif block.total_rem is not None:
        block.bruto = block.total_rem

    if block.legajo not in accumulator:
        accumulator[block.legajo] = []
    accumulator[block.legajo].append(block)


def _consolidate(blocks: List[LiquidacionEmpleado]) -> LiquidacionEmpleado:
    """Sum multiple blocks for the same legajo."""
    if len(blocks) == 1:
        return blocks[0]

    base = LiquidacionEmpleado(
        legajo=blocks[0].legajo,
        nombre=blocks[0].nombre,
        bruto=None, neto=None,
        total_rem=None, total_desc=None,
        total_no_rem=None, total_contrib=None,
        n_bloques=len(blocks),
    )

    for b in blocks:
        for attr in ('bruto', 'neto', 'total_rem', 'total_desc', 'total_no_rem', 'total_contrib'):
            bv = getattr(base, attr)
            ev = getattr(b, attr)
            if ev is not None:
                setattr(base, attr, round((bv or 0) + ev, 2))
        base.conceptos.extend(b.conceptos)

    # Merge conceptos by code (sum repeated codes)
    merged: Dict[str, Concepto] = {}
    for c in base.conceptos:
        key = f'{c.codigo}:{c.columna}'
        if key in merged:
            merged[key] = Concepto(
                codigo=c.codigo,
                descripcion=c.descripcion,
                monto=round(merged[key].monto + c.monto, 2),
                columna=c.columna,
            )
        else:
            merged[key] = c
    base.conceptos = list(merged.values())

    return base


def parse_liquidacion(pdf_path: str, verbose: bool = False) -> Dict[str, LiquidacionEmpleado]:
    """Parse liquidation PDF. Returns dict keyed by legajo string."""
    accumulator: Dict[str, List[LiquidacionEmpleado]] = {}

    with pdfplumber.open(pdf_path) as pdf:
        total_pages = len(pdf.pages)
        if verbose:
            print(f'[INFO] Liquidación: {total_pages} páginas')

        for page_num, page in enumerate(pdf.pages, 1):
            words = page.extract_words(x_tolerance=3, y_tolerance=3)
            if not words:
                if verbose:
                    print(f'[WARN] Pág {page_num}: sin palabras')
                continue
            rows = _group_words_into_rows(words)
            _parse_page_rows(rows, accumulator, page_num)

    results: Dict[str, LiquidacionEmpleado] = {}
    for legajo, blocks in accumulator.items():
        emp = _consolidate(blocks)
        results[legajo] = emp

    if verbose:
        multi = sum(1 for b in accumulator.values() if len(b) > 1)
        print(f'[INFO] Liquidación parseada: {len(results)} empleados ({multi} con múltiples bloques)')

    return results


def calibrate_columns(pdf_path: str, page_num: int = 1, n_rows: int = 30) -> None:
    """Diagnostic: print word coordinates to calibrate column boundaries."""
    with pdfplumber.open(pdf_path) as pdf:
        page = pdf.pages[page_num - 1]
        words = page.extract_words(x_tolerance=3, y_tolerance=3)
        rows = _group_words_into_rows(words)
        print(f'--- Página {page_num}: primeras {n_rows} filas con coordenadas ---')
        for i, row in enumerate(rows[:n_rows]):
            items = [(w['text'], round((w['x0'] + w['x1']) / 2, 1)) for w in row]
            print(f'  Fila {i+1}: {items}')
