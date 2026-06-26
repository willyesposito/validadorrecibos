"""Parser de la liquidación de Marval (PDF 'Control de Liquidación').

Estructura: varios empleados por página. Cada empleado tiene un encabezado
'Legajo: NNNN  Empleado: ...  Categoría: ...', una tabla de conceptos con columnas
(UNIDADES | REMUNERATIVO | DESCUENTOS | NO REMUNERATIVO | CONTRIBUCIONES) y un bloque
de totales. La asignación de cada importe a su columna se hace por la coordenada x del
número (alineados a la derecha; se usa el centro x y se asigna a la columna más cercana).

Un mismo legajo puede aparecer varias veces (empleados con más de una liquidación en el
período, p.ej. una liquidación normal más un ajuste/SAC). Esos bloques se CONSOLIDAN
sumando conceptos y totales, y se registra cuántas liquidaciones tenía (n_liquidaciones).

La liquidación también puede venir en Excel; ese parser no está implementado todavía
porque no hay archivo de muestra. Ver cargar_liquidacion().
"""
import re
from collections import defaultdict
import pdfplumber

from .util import parse_money, normalizar_legajo, cluster_lines, texto_de_linea

_HEADER_EMP = re.compile(r"Legajo:\s*(\d+)\s+Empleado:\s*(.*?)\s+Categor")
_COD = re.compile(r"^(\d{3,4})")
_MONEY = re.compile(r"^-?\d[\d.]*,\d{2}$")

# Etiquetas de totales. Se leen de forma tolerante porque pdfplumber a veces intercala
# el ':' dentro del número (ej. 'Total Contribuciones2:.949.371,56').
_LABELS = {
    "haberes": "Total Haberes",
    "descuentos": "Total Descuentos",
    "netos": "Total Netos",
    "imponible": "Total Imponible",
    "imp_contrib": "Total Imp. Contrib",
    "costo_laboral_liq": "Costo Laboral",
    "contribuciones": "Total Contribuciones",
    "reducciones": "Reducciones de Contrib.",
}


def _leer_total(raw, label):
    pat = re.escape(label) + r"[^\d\-]*([\d.,:\-]+)"
    m = re.search(pat, raw)
    if not m:
        return None
    return parse_money(m.group(1).replace(":", ""))


def _detectar_centros(line_words):
    centros = {}
    ws = line_words
    i = 0
    while i < len(ws):
        t = ws[i]["text"]
        cx = (ws[i]["x0"] + ws[i]["x1"]) / 2
        if t == "UNIDADES":
            centros["UNIDAD"] = cx
        elif t == "REMUNERATIVO":
            if "REM" not in centros:
                centros["REM"] = cx
        elif t == "DESCUENTOS":
            centros["DESC"] = cx
        elif t == "NO" and i + 1 < len(ws) and ws[i + 1]["text"] == "REMUNERATIVO":
            centros["NOREM"] = (ws[i]["x0"] + ws[i + 1]["x1"]) / 2
            i += 1
        elif t == "CONTRIBUCIONES":
            centros["CONTRIB"] = cx
        i += 1
    requeridas = {"UNIDAD", "REM", "DESC", "NOREM", "CONTRIB"}
    return centros if requeridas.issubset(centros) else None


def _columna_de(cx, centros):
    return min(centros, key=lambda k: abs(centros[k] - cx))


def _es_header_columnas(line_words):
    texts = {w["text"] for w in line_words}
    return "CONCEPTO" in texts and "CONTRIBUCIONES" in texts


def _finalizar_bloque(emp):
    raw = emp.pop("_raw")
    tot = {nombre: _leer_total(raw, label) for nombre, label in _LABELS.items()}
    emp["totales"] = tot
    return emp


def _consolidar(bloques):
    """Suma conceptos y totales de varios bloques del mismo legajo en un único registro."""
    conceptos = []
    for b in bloques:
        conceptos.extend(b["conceptos"])
    totales = {}
    for k in _LABELS:
        vals = [b["totales"].get(k) for b in bloques]
        presentes = [v for v in vals if v is not None]
        totales[k] = sum(presentes) if len(presentes) == len(vals) and presentes else (
            sum(presentes) if presentes else None
        )
    return {
        "legajo": bloques[0]["legajo"],
        "nombre": bloques[0]["nombre"],
        "conceptos": conceptos,
        "totales": totales,
        "n_liquidaciones": len(bloques),
    }


def parse_liquidacion_pdf(path):
    """Devuelve {legajo_normalizado: registro consolidado}."""
    bloques = defaultdict(list)
    current = None
    ultimos_centros = None

    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            words = page.extract_words()
            lines = cluster_lines(words)

            centros = None
            for lw in lines:
                if _es_header_columnas(lw):
                    centros = _detectar_centros(lw)
                    if centros:
                        break
            if centros:
                ultimos_centros = centros
            centros = centros or ultimos_centros

            for lw in lines:
                txt = texto_de_linea(lw)
                m = _HEADER_EMP.search(txt)
                if m:
                    if current:
                        leg = normalizar_legajo(current["legajo"])
                        bloques[leg].append(_finalizar_bloque(current))
                    current = {
                        "legajo": m.group(1),
                        "nombre": m.group(2).strip().replace(" ,", ", "),
                        "conceptos": [],
                        "_raw": "",
                    }
                    continue
                if current is None:
                    continue
                current["_raw"] += txt + "\n"

                cm = _COD.match(lw[0]["text"]) if lw else None
                if cm and centros:
                    codigo = cm.group(1)
                    columna = monto = None
                    for w in lw:
                        if _MONEY.match(w["text"]):
                            cx = (w["x0"] + w["x1"]) / 2
                            col = _columna_de(cx, centros)
                            if col == "UNIDAD":
                                continue
                            columna, monto = col, parse_money(w["text"])
                            break
                    if columna is not None and monto is not None:
                        current["conceptos"].append(
                            {"codigo": codigo, "columna": columna, "monto": monto})

    if current:
        leg = normalizar_legajo(current["legajo"])
        bloques[leg].append(_finalizar_bloque(current))

    return {leg: _consolidar(bs) for leg, bs in bloques.items()}


def cargar_liquidacion(path):
    low = path.lower()
    if low.endswith(".pdf"):
        return parse_liquidacion_pdf(path)
    if low.endswith((".xlsx", ".xls", ".xlsm")):
        raise NotImplementedError(
            "El parser de liquidación en Excel todavía no está implementado: "
            "hace falta un Excel de muestra para no asumir la estructura de columnas.")
    raise ValueError(f"Formato de liquidación no soportado: {path}")
