"""Parser de recibos de haberes de Marval (PDF, un empleado por página).

Cada página tiene dos bloques de conceptos:
- Contribuciones patronales: entre 'COSTO TOTAL EMPLEADOR' y 'SUB TOTAL CONTRIBUCIONES EMPLEADOR'.
- Conceptos del trabajador (haberes + descuentos): entre 'SUB TOTAL CONTRIBUCIONES EMPLEADOR'
  y 'SUELDO NETO'. (Se arranca después del subtotal de contribuciones porque el texto
  'SUELDO BRUTO' aparece dos veces: como título de columna y como total.)
Más los totales, la composición salarial y los porcentajes del gráfico de torta.

Un mismo legajo puede tener varias páginas de recibo (empleados con más de una
liquidación, incluidos recibos de corrección con importes negativos). Esas páginas se
CONSOLIDAN sumando conceptos y totales; los porcentajes de torta se guardan por página.
"""
import re
from collections import defaultdict
import pdfplumber

from .util import parse_money, normalizar_legajo

_LEGAJO_BRUTO = re.compile(r"(\d{3,5})\s+\$\s*(-?[\d.,]+)")
_CONCEPTO = re.compile(r"^\s*(\d{3,4})\s+.*?\$\s*(-?[\d.,]+)", re.M)
_PORC = re.compile(r"(-?\d+(?:\.\d+)?)\s*%")

_RE_NETO = re.compile(r"SUELDO NETO\s+\$\s*(-?[\d.,]+)")
_RE_SUBTOT_CONTRIB = re.compile(r"SUB TOTAL CONTRIBUCIONES EMPLEADOR\s+\$\s*(-?[\d.,]+)")
_RE_COSTO_TOTAL = re.compile(r"COSTO TOTAL EMPLEADOR\s+\$\s*(-?[\d.,]+)")
_RE_BRUTO_TOTAL = re.compile(r"\bSUELDO BRUTO\s+\$\s*(-?[\d.,]+)")
_RE_COMPO = re.compile(
    r"Remunerativo:\s*\$\s*(-?[\d.,]+).*?No Remunerativo:\s*\$\s*(-?[\d.,]+).*?Descuentos:\s*\$\s*(-?[\d.,]+)",
    re.S)


def _entre(texto, ini, fin):
    i = texto.find(ini)
    if i == -1:
        return ""
    i += len(ini)
    j = texto.find(fin, i)
    if j == -1:
        j = len(texto)
    return texto[i:j]


def _conceptos_de(bloque):
    """Devuelve (dict {codigo: monto_sumado}, set de codigos duplicados en la página)."""
    out = {}
    dups = set()
    for m in _CONCEPTO.finditer(bloque):
        codigo = m.group(1)
        monto = parse_money(m.group(2))
        if monto is None:
            continue
        if codigo in out:
            dups.add(codigo)
            out[codigo] += monto
        else:
            out[codigo] = monto
    return out, dups


def _parse_pagina(texto):
    mlb = _LEGAJO_BRUTO.search(texto)
    if not mlb:
        return None
    legajo = mlb.group(1)

    def num(rgx):
        m = rgx.search(texto)
        return parse_money(m.group(1)) if m else None

    rem = norem = desc = None
    mc = _RE_COMPO.search(texto)
    if mc:
        rem = parse_money(mc.group(1))
        norem = parse_money(mc.group(2))
        desc = parse_money(mc.group(3))

    contrib, dup_c = _conceptos_de(_entre(texto, "COSTO TOTAL EMPLEADOR",
                                          "SUB TOTAL CONTRIBUCIONES"))
    trab, dup_t = _conceptos_de(_entre(texto, "SUB TOTAL CONTRIBUCIONES EMPLEADOR",
                                       "SUELDO NETO"))
    return {
        "legajo": legajo,
        "bruto": num(_RE_BRUTO_TOTAL),
        "neto": num(_RE_NETO),
        "subtotal_contrib": num(_RE_SUBTOT_CONTRIB),
        "costo_total_empleador": num(_RE_COSTO_TOTAL),
        "remunerativo": rem,
        "no_remunerativo": norem,
        "descuentos": desc,
        "conceptos_trab": trab,
        "conceptos_contrib": contrib,
        "duplicados_pagina": dup_t | dup_c,
        "porcentajes_torta": [float(p) for p in _PORC.findall(texto)],
    }


def _suma(vals):
    presentes = [v for v in vals if v is not None]
    return sum(presentes) if presentes else None


def _consolidar(paginas):
    trab = defaultdict(float)
    contrib = defaultdict(float)
    dups = set()
    for p in paginas:
        for c, v in p["conceptos_trab"].items():
            trab[c] += v
        for c, v in p["conceptos_contrib"].items():
            contrib[c] += v
        dups |= p["duplicados_pagina"]
    return {
        "legajo": paginas[0]["legajo"],
        "bruto": _suma([p["bruto"] for p in paginas]),
        "neto": _suma([p["neto"] for p in paginas]),
        "subtotal_contrib": _suma([p["subtotal_contrib"] for p in paginas]),
        "costo_total_empleador": _suma([p["costo_total_empleador"] for p in paginas]),
        "remunerativo": _suma([p["remunerativo"] for p in paginas]),
        "no_remunerativo": _suma([p["no_remunerativo"] for p in paginas]),
        "descuentos": _suma([p["descuentos"] for p in paginas]),
        "conceptos_trab": dict(trab),
        "conceptos_contrib": dict(contrib),
        "duplicados_pagina": dups,
        "porcentajes_por_pagina": [p["porcentajes_torta"] for p in paginas],
        "n_recibos": len(paginas),
    }


def parse_recibos_pdf(path):
    paginas = defaultdict(list)
    sin_legajo = []
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages):
            rec = _parse_pagina(page.extract_text() or "")
            if rec is None:
                sin_legajo.append(i)
                continue
            paginas[normalizar_legajo(rec["legajo"])].append(rec)
    consolidado = {leg: _consolidar(ps) for leg, ps in paginas.items()}
    return consolidado, sin_legajo


def parse_varios_recibos(paths):
    """Combina varios archivos. Devuelve (dict consolidado, duplicados_entre_archivos, paginas_sin_legajo)."""
    por_legajo = defaultdict(list)
    sin_legajo_total = []
    for p in paths:
        with pdfplumber.open(p) as pdf:
            for i, page in enumerate(pdf.pages):
                rec = _parse_pagina(page.extract_text() or "")
                if rec is None:
                    sin_legajo_total.append((p.split("/")[-1], i))
                    continue
                por_legajo[normalizar_legajo(rec["legajo"])].append(rec)
    consolidado = {leg: _consolidar(ps) for leg, ps in por_legajo.items()}
    return consolidado, [], sin_legajo_total
