"""Validación de una liquidación contra sus recibos.

Reglas (acordadas con el negocio). Dirección: LIQUIDACIÓN -> RECIBO.
  1. Cada concepto del trabajador de la liquidación (rem/no rem/desc, no interno)
     tiene que estar en el recibo con el mismo importe (tolerancia 0,01).
  2. Totales que tienen que cerrar entre liquidación y recibo:
       - Neto            (Total Netos          == Sueldo Neto)              [obligatorio]
       - Bruto/Haberes   (Total Haberes        == Sueldo Bruto)
       - Descuentos      (Total Descuentos     == Descuentos composición)
       - Contribuciones  (Total Contribuciones == Sub Total Contrib. Empleador)
       - Costo Laboral   (Bruto + Contribuciones == Costo Total Empleador)
  3. Aritmética interna de cada archivo (detecta documentos inconsistentes en sí mismos).
  4. Cada gráfico de torta del recibo tiene que sumar 100%.
  5. Anomalías: legajo sin par, conceptos duplicados, signos inesperados.

Empleados con más de una liquidación/recibo en el período se consolidan sumando y se
marcan con un hallazgo informativo (INFO).
"""
from .conceptos import es_comparable_trabajador, es_interno

TOL = 0.01
TOL_TORTA = 0.1

ERROR = "ERROR"
ADVERTENCIA = "ADVERTENCIA"
INFO = "INFO"


def _dif(a, b):
    if a is None or b is None:
        return None
    return abs(a - b)


def validar_empleado(legajo, emp_liq, recibo, hallazgos):
    nombre = emp_liq["nombre"] if emp_liq else ""

    def add(sev, tipo, detalle, esperado=None, encontrado=None):
        hallazgos.append({"legajo": legajo, "nombre": nombre, "severidad": sev,
                          "tipo": tipo, "detalle": detalle,
                          "esperado": esperado, "encontrado": encontrado})

    if recibo is None:
        add(ERROR, "legajo_sin_recibo", "Legajo en la liquidación sin recibo correspondiente.")
        return
    if emp_liq is None:
        add(ERROR, "recibo_sin_liquidacion", "Recibo sin empleado en la liquidación.")
        return

    # marca de multi-liquidación (informativa)
    n_liq = emp_liq.get("n_liquidaciones", 1)
    n_rec = recibo.get("n_recibos", 1)
    if n_liq > 1 or n_rec > 1:
        add(INFO, "empleado_multiliquidacion",
            f"Tiene {n_liq} liquidación(es) y {n_rec} recibo(s) en el período; se consolidó sumando.")

    tot = emp_liq["totales"]
    conceptos = emp_liq["conceptos"]

    # 1. cruce de conceptos del trabajador: liquidación -> recibo
    liq_por_cod = {}
    for c in conceptos:
        if es_comparable_trabajador(c):
            liq_por_cod[c["codigo"]] = liq_por_cod.get(c["codigo"], 0.0) + c["monto"]

    rec_trab = recibo["conceptos_trab"]
    for cod, monto_liq in liq_por_cod.items():
        if abs(monto_liq) < TOL:
            continue  # concepto consolidado en cero: no se exige en el recibo
        if cod not in rec_trab:
            add(ERROR, "concepto_falta_en_recibo",
                f"Concepto {cod} está en la liquidación y no aparece en el recibo.",
                esperado=round(monto_liq, 2), encontrado=None)
        elif _dif(monto_liq, rec_trab[cod]) > TOL:
            add(ERROR, "monto_difiere",
                f"Concepto {cod}: el importe difiere entre liquidación y recibo.",
                esperado=round(monto_liq, 2), encontrado=round(rec_trab[cod], 2))

    # secundario (informativo): conceptos del recibo que no están en la liquidación
    for cod, monto_rec in rec_trab.items():
        if not es_interno(cod) and cod not in liq_por_cod and abs(monto_rec) >= TOL:
            add(ADVERTENCIA, "concepto_extra_en_recibo",
                f"Concepto {cod} está en el recibo y no aparece en la liquidación.",
                encontrado=round(monto_rec, 2))

    # 2. totales liquidación vs recibo
    for nombre_tot, val_liq, val_rec in [
        ("neto", tot.get("netos"), recibo["neto"]),
        ("bruto", tot.get("haberes"), recibo["bruto"]),
        ("descuentos", tot.get("descuentos"), recibo["descuentos"]),
        ("contribuciones", tot.get("contribuciones"), recibo["subtotal_contrib"]),
    ]:
        d = _dif(val_liq, val_rec)
        if d is None:
            add(ADVERTENCIA, "total_no_legible",
                f"No se pudo leer el total '{nombre_tot}' en alguno de los dos documentos.",
                esperado=val_liq, encontrado=val_rec)
        elif d > TOL:
            add(ERROR, f"total_{nombre_tot}_no_cierra",
                f"El total '{nombre_tot}' no coincide entre liquidación y recibo.",
                esperado=round(val_liq, 2), encontrado=round(val_rec, 2))

    # Costo Laboral = Bruto + Contribuciones  vs  Costo Total Empleador del recibo
    if tot.get("haberes") is not None and tot.get("contribuciones") is not None \
            and recibo["costo_total_empleador"] is not None:
        costo_calc = tot["haberes"] + tot["contribuciones"]
        if _dif(costo_calc, recibo["costo_total_empleador"]) > TOL:
            add(ERROR, "costo_laboral_no_cierra",
                "Costo Laboral (Bruto + Contribuciones) no coincide con Costo Total Empleador.",
                esperado=round(costo_calc, 2),
                encontrado=round(recibo["costo_total_empleador"], 2))

    # 3a. aritmética interna de la liquidación
    suma_rem = sum(c["monto"] for c in conceptos if c["columna"] == "REM")
    suma_norem = sum(c["monto"] for c in conceptos
                     if c["columna"] == "NOREM" and not es_interno(c["codigo"]))
    suma_desc = sum(c["monto"] for c in conceptos
                    if c["columna"] == "DESC" and not es_interno(c["codigo"]))
    if tot.get("haberes") is not None and _dif(suma_rem + suma_norem, tot["haberes"]) > TOL:
        add(ADVERTENCIA, "liq_haberes_no_reconstruye",
            "Rem + No Rem de la liquidación no da el Total Haberes.",
            esperado=round(tot["haberes"], 2), encontrado=round(suma_rem + suma_norem, 2))
    if tot.get("descuentos") is not None and _dif(suma_desc, tot["descuentos"]) > TOL:
        add(ADVERTENCIA, "liq_descuentos_no_reconstruye",
            "La suma de descuentos de la liquidación no da el Total Descuentos.",
            esperado=round(tot["descuentos"], 2), encontrado=round(suma_desc, 2))

    # 3b. aritmética interna del recibo
    if recibo["remunerativo"] is not None and recibo["no_remunerativo"] is not None \
            and recibo["bruto"] is not None:
        if _dif(recibo["remunerativo"] + recibo["no_remunerativo"], recibo["bruto"]) > TOL:
            add(ADVERTENCIA, "recibo_bruto_no_reconstruye",
                "Rem + No Rem del recibo no da el Sueldo Bruto.",
                esperado=round(recibo["bruto"], 2),
                encontrado=round(recibo["remunerativo"] + recibo["no_remunerativo"], 2))
    if recibo["bruto"] is not None and recibo["descuentos"] is not None \
            and recibo["neto"] is not None:
        if _dif(recibo["bruto"] - recibo["descuentos"], recibo["neto"]) > TOL:
            add(ADVERTENCIA, "recibo_neto_no_reconstruye",
                "Sueldo Bruto - Descuentos del recibo no da el Sueldo Neto.",
                esperado=round(recibo["neto"], 2),
                encontrado=round(recibo["bruto"] - recibo["descuentos"], 2))
    if recibo["subtotal_contrib"] is not None:
        suma_c = sum(recibo["conceptos_contrib"].values())
        if _dif(suma_c, recibo["subtotal_contrib"]) > TOL:
            add(ADVERTENCIA, "recibo_contrib_no_reconstruye",
                "La suma de contribuciones del recibo no da el Sub Total Contribuciones.",
                esperado=round(recibo["subtotal_contrib"], 2), encontrado=round(suma_c, 2))

    # 4. gráfico de torta = 100% (por página de recibo)
    paginas_torta = recibo.get("porcentajes_por_pagina") or []
    for idx, porc in enumerate(paginas_torta, start=1):
        if porc:
            suma = sum(porc)
            if abs(suma - 100.0) > TOL_TORTA:
                detalle = "Los porcentajes del gráfico de torta no suman 100%."
                if len(paginas_torta) > 1:
                    detalle = f"Recibo {idx}: " + detalle
                add(ADVERTENCIA, "torta_no_suma_100", detalle,
                    esperado=100.0, encontrado=round(suma, 2))

    # 5. anomalías
    for cod in recibo.get("duplicados_pagina", set()):
        add(ADVERTENCIA, "concepto_duplicado_recibo",
            f"Concepto {cod} aparece más de una vez dentro de un mismo recibo.")
    conteo = {}
    for c in conceptos:
        if es_comparable_trabajador(c):
            conteo[c["codigo"]] = conteo.get(c["codigo"], 0) + 1
    for c in conceptos:
        if es_comparable_trabajador(c) and c["monto"] < 0:
            tipo = "haber_negativo" if c["columna"] in ("REM", "NOREM") else "descuento_negativo"
            add(ADVERTENCIA, tipo,
                f"Concepto {c['codigo']} ({c['columna']}) tiene importe negativo en la liquidación.",
                encontrado=round(c["monto"], 2))


def validar(liquidacion, recibos, sin_legajo=None):
    hallazgos = []
    legajos = set(liquidacion) | set(recibos)
    for legajo in sorted(legajos, key=lambda x: (len(x), x)):
        validar_empleado(legajo, liquidacion.get(legajo), recibos.get(legajo), hallazgos)

    for archivo, pagina in (sin_legajo or []):
        hallazgos.append({"legajo": "", "nombre": "", "severidad": ADVERTENCIA,
                          "tipo": "pagina_recibo_sin_legajo",
                          "detalle": f"Página {pagina} de {archivo}: no se detectó legajo.",
                          "esperado": None, "encontrado": None})

    con_error = {h["legajo"] for h in hallazgos if h["severidad"] == ERROR and h["legajo"]}
    con_adv = {h["legajo"] for h in hallazgos if h["severidad"] == ADVERTENCIA and h["legajo"]}
    resumen = {
        "empleados_liquidacion": len(liquidacion),
        "empleados_recibos": len(recibos),
        "empleados_evaluados": len(legajos),
        "ok": len(legajos - con_error - con_adv),
        "con_advertencia": len(con_adv - con_error),
        "con_error": len(con_error),
        "total_hallazgos": len(hallazgos),
    }
    return hallazgos, resumen
