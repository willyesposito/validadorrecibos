"""Parser for Marval receipt PDFs (recibo_contrib_v4.pdf, recibo_contrib_v4_rrhh.pdf)."""
import re
import pdfplumber
from typing import Dict, List, Optional

from .models import Concepto, ReciboEmpleado

MESES = (
    r'(?:Enero|Febrero|Marzo|Abril|Mayo|Junio|'
    r'Julio|Agosto|Septiembre|Octubre|Noviembre|Diciembre)'
)


def parse_money(s: str) -> Optional[float]:
    """Convert Argentine or US money string to float.

    Handles: '$ 1.234.567,89' (AR) and '$10,963,803.18' (US).
    """
    if not s:
        return None
    s = re.sub(r'[$\s]', '', str(s)).strip()
    if not s or s in ('-', ''):
        return None
    # US format: ends with .XX (two decimal digits after dot)
    if re.match(r'^-?[\d,]+\.\d{1,2}$', s):
        return float(s.replace(',', ''))
    # AR format: ends with ,XX
    if re.match(r'^-?[\d.]+,\d{1,2}$', s):
        return float(s.replace('.', '').replace(',', '.'))
    # Plain integer
    if re.match(r'^-?\d+$', s):
        return float(s)
    return None


def _parse_concepto_line(line: str) -> Optional[Concepto]:
    """Parse 'CODE Description [UNIT] $ AMOUNT' -> Concepto."""
    m = re.match(r'^(-?\d{3,6})\s+(.+?)\s+\$\s*(-?[\d.,]+)\s*$', line.strip())
    if not m:
        return None
    code = m.group(1)
    raw_desc = m.group(2).strip()
    amount_str = m.group(3)
    # Strip trailing unit/base numbers from description (e.g. "Jubilación 11,00")
    desc = re.sub(r'\s+\d{1,3}(?:,\d+)?\s*$', '', raw_desc).strip()
    amount = parse_money(amount_str)
    if amount is None:
        return None
    return Concepto(codigo=code, descripcion=desc, monto=amount)


def _parse_page(text: str, page_num: int) -> Optional[ReciboEmpleado]:
    lines = [ln.strip() for ln in text.split('\n')]

    rp = ReciboEmpleado(
        legajo='', nombre='',
        bruto=None, neto=None,
        total_contribuciones=None, costo_empleador=None,
        composicion_rem=None, composicion_no_rem=None, composicion_desc=None,
        paginas=[page_num],
    )

    # State machine
    state = 'HEADER'
    concepto_section_count = 0  # track which CONCEPTO block we're in

    for line in lines:
        if not line:
            continue

        # --- HEADER: find legajo + nombre + bruto ---
        if state == 'HEADER':
            m = re.search(
                rf'{MESES}\s+\d{{4}}\s+(.+?)\s+(\d{{3,6}})\s+\$\s*([\d.,]+)',
                line,
            )
            if m:
                rp.nombre = m.group(1).strip()
                # Normalizar legajo igual que la liquidación (sin ceros a la
                # izquierda) para que '0826' (recibo) matchee '826' (liqui).
                rp.legajo = (m.group(2).strip().lstrip('0') or '0')
                state = 'PRE_CONTRIB'
                continue

        # --- COSTO TOTAL EMPLEADOR (can appear anywhere before contributions) ---
        if state in ('HEADER', 'PRE_CONTRIB', 'CONTRIB'):
            m = re.search(r'COSTO TOTAL EMPLEADOR\s+\$\s*([\d.,]+)', line)
            if m:
                rp.costo_empleador = parse_money(m.group(1))

        # --- Start of first CONCEPTO block = contributions section ---
        if state == 'PRE_CONTRIB' and line == 'CONCEPTO UNIDAD BASE MONTO':
            state = 'CONTRIB'
            continue

        if state == 'CONTRIB':
            m = re.search(r'SUB TOTAL CONTRIBUCIONES EMPLEADOR\s+\$\s*([\d.,]+)', line)
            if m:
                rp.total_contribuciones = parse_money(m.group(1))
                state = 'PRE_CONCEPTOS'
                continue
            c = _parse_concepto_line(line)
            if c:
                rp.contribuciones.append(c)

        # --- Between contributions and concepts: get SUELDO BRUTO ---
        if state == 'PRE_CONCEPTOS':
            m = re.match(r'SUELDO BRUTO\s+\$\s*([\d.,]+)', line)
            if m:
                rp.bruto = parse_money(m.group(1))
                continue
            if line == 'CONCEPTO UNIDAD BASE MONTO':
                state = 'CONCEPTOS'
                continue

        # --- Haberes / Descuentos section ---
        if state == 'CONCEPTOS':
            # COMPOSICION SALARIAL marks end of concepts
            m = re.search(
                r'Remunerativo:\s*\$\s*([\d,\.]+)'
                r'\s+No Remunerativo:\s*\$\s*([\d,.]+)'
                r'\s+Descuentos:\s*\$\s*([\d,.]+)',
                line,
            )
            if m:
                rp.composicion_rem = parse_money(m.group(1))
                rp.composicion_no_rem = parse_money(m.group(2))
                rp.composicion_desc = parse_money(m.group(3))
                state = 'POST_CONCEPTOS'
                continue
            c = _parse_concepto_line(line)
            if c:
                rp.conceptos.append(c)

        # --- After COMPOSICION SALARIAL: find SUELDO NETO ---
        if state == 'POST_CONCEPTOS':
            m = re.match(r'SUELDO NETO\s+\$\s*([\d.,]+)', line)
            if m:
                rp.neto = parse_money(m.group(1))
                state = 'PIE'
                continue

        # --- Pie chart percentages ---
        if state == 'PIE':
            for pct in re.findall(r'(\d{1,2}\.\d{2})%', line):
                rp.porcentajes_torta.append(float(pct))

    if not rp.legajo:
        rp.errores_parse.append(f'Página {page_num}: no se detectó legajo')
        return None

    return rp


def _merge_pages(base: ReciboEmpleado, extra: ReciboEmpleado) -> None:
    """Add extra page data into base (for multi-page employees)."""
    base.conceptos.extend(extra.conceptos)
    base.contribuciones.extend(extra.contribuciones)
    base.paginas.extend(extra.paginas)
    base.n_paginas += 1
    base.porcentajes_torta.extend(extra.porcentajes_torta)

    for field in ('bruto', 'neto', 'total_contribuciones', 'costo_empleador'):
        bv = getattr(base, field)
        ev = getattr(extra, field)
        if bv is not None and ev is not None:
            setattr(base, field, round(bv + ev, 2))
        elif ev is not None:
            setattr(base, field, ev)

    for field in ('composicion_rem', 'composicion_no_rem', 'composicion_desc'):
        bv = getattr(base, field)
        ev = getattr(extra, field)
        if bv is not None and ev is not None:
            setattr(base, field, round(bv + ev, 2))
        elif ev is not None:
            setattr(base, field, ev)


def parse_recibos(pdf_paths: List[str], verbose: bool = False) -> Dict[str, ReciboEmpleado]:
    """Parse one or more receipt PDFs. Returns dict keyed by legajo string."""
    results: Dict[str, ReciboEmpleado] = {}
    sin_legajo = 0

    for pdf_path in pdf_paths:
        with pdfplumber.open(pdf_path) as pdf:
            for page_num, page in enumerate(pdf.pages, 1):
                text = page.extract_text() or ''
                rp = _parse_page(text, page_num)
                if rp is None:
                    sin_legajo += 1
                    if verbose:
                        print(f'[WARN] {pdf_path} pág {page_num}: sin legajo detectado')
                    continue
                if rp.legajo in results:
                    _merge_pages(results[rp.legajo], rp)
                    if verbose:
                        print(f'[INFO] Legajo {rp.legajo} (pág {page_num}): bloque adicional sumado')
                else:
                    results[rp.legajo] = rp

    if verbose:
        print(f'[INFO] Recibos parseados: {len(results)} empleados, {sin_legajo} páginas sin legajo')

    return results
