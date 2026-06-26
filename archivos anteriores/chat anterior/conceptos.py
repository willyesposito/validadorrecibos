"""Clasificación de conceptos del modelo de liquidación de Marval.

Decisiones acordadas con el negocio:
- Dirección de la validación: LIQUIDACIÓN -> RECIBO. Cada concepto del trabajador
  de la liquidación (remunerativo / no remunerativo / descuento) tiene que aparecer
  en el recibo con el mismo importe.
- Las contribuciones (columna CONTRIBUCIONES) NO se cruzan línea por línea en esta
  fase: la liquidación agrupa base + SAC en un solo código y el recibo los separa.
  Se validan únicamente por TOTAL (Total Contribuciones vs Sub Total Contribuciones
  Empleador). El match agrupado por código queda para una fase posterior.
- Conceptos internos del cálculo: NO se exigen en el recibo. Se excluyen del cruce
  línea por línea y de las reconstrucciones aritméticas de haberes/descuentos.
"""

# Códigos internos del cálculo que NUNCA van al recibo.
CONCEPTOS_INTERNOS = {
    # Provisiones y reversiones (vacaciones, SAC, bonus)
    "3570", "3572", "3574", "3576",
    "3670", "3672", "3674", "3676",
    "7289", "7290", "7291", "7292",
    # Mínimos no imponibles de cargas sociales
    "5911", "5921",
    # Valor del plan / prepaga (interno del cálculo)
    "7100",
}

# Columnas de la liquidación que corresponden a conceptos del trabajador
# (lo que sí tiene que estar en el recibo).
COLUMNAS_TRABAJADOR = {"REM", "NOREM", "DESC"}

# Columna de contribuciones patronales (se valida por total, no línea por línea).
COLUMNA_CONTRIB = "CONTRIB"


def es_interno(codigo):
    return codigo in CONCEPTOS_INTERNOS


def es_comparable_trabajador(concepto):
    """True si el concepto de la liquidación debe cruzarse línea por línea con el recibo."""
    return (
        concepto["columna"] in COLUMNAS_TRABAJADOR
        and not es_interno(concepto["codigo"])
    )


def es_contribucion(concepto):
    return concepto["columna"] == COLUMNA_CONTRIB and not es_interno(concepto["codigo"])
