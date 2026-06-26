"""Utilidades compartidas: parseo de montos y agrupamiento de palabras en líneas."""
import re

_MONEY_RE = re.compile(r"-?\d[\d.]*,\d{2}$|-?\d[\d.,]*\.\d{2}$|-?\d+$")


def parse_money(s):
    """Convierte un importe a float, tolerando formato AR (1.234.567,89) y US (1,234,567.89).

    Regla: el separador decimal es el que aparezca más a la derecha (. o ,).
    Devuelve None si la cadena no contiene un número.
    """
    if s is None:
        return None
    s = s.strip().replace("$", "").replace(" ", "").replace("\xa0", "")
    if s in ("", "-", "+"):
        return None
    neg = s.startswith("-")
    s = s.lstrip("-+")
    if not re.search(r"\d", s):
        return None
    last_dot = s.rfind(".")
    last_com = s.rfind(",")
    try:
        if last_dot == -1 and last_com == -1:
            val = float(s)
        elif last_com > last_dot:
            # coma como decimal (AR): los puntos son miles
            val = float(s.replace(".", "").replace(",", "."))
        else:
            # punto como decimal (US): las comas son miles
            val = float(s.replace(",", ""))
    except ValueError:
        return None
    return -val if neg else val


def normalizar_legajo(legajo):
    """Normaliza un legajo a string sin ceros a la izquierda (0826 -> '826')."""
    legajo = str(legajo).strip()
    digits = re.sub(r"\D", "", legajo)
    if not digits:
        return legajo
    return str(int(digits))


def cluster_lines(words, tol=3):
    """Agrupa palabras de pdfplumber en líneas por su coordenada 'top'.

    Devuelve una lista de líneas (cada una lista de words ordenadas por x0),
    en orden vertical de la página.
    """
    lines = []  # lista de (top_key, [words])
    for w in words:
        placed = False
        for entry in lines:
            if abs(entry[0] - w["top"]) <= tol:
                entry[1].append(w)
                placed = True
                break
        if not placed:
            lines.append([w["top"], [w]])
    lines.sort(key=lambda e: e[0])
    return [sorted(e[1], key=lambda w: w["x0"]) for e in lines]


def texto_de_linea(line_words):
    return " ".join(w["text"] for w in line_words)
