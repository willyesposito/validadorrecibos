"""Cross-validation logic: liquidacion vs recibos."""
import json
from typing import Dict, List, Optional, Tuple

from .models import (
    Concepto, Hallazgo, LiquidacionEmpleado,
    ReciboEmpleado, ResultadoEmpleado,
)

# Tolerance for individual concept comparison (±$0.01)
TOLS_CONCEPTO = 0.01
# Tolerance for total comparisons (±$1.00 covers accumulation rounding)
TOL_TOTAL = 1.0
# Tolerance for pie chart sum (±1 percentage point)
TOL_TORTA = 1.0

# Contribution concept codes (validated by total only, not line by line)
# Codes 6050-6999 and 7015 are employer contributions shown in the receipt header
_CONTRIB_RANGE = range(6050, 7100)


def _is_contrib(codigo: str) -> bool:
    try:
        return int(codigo.lstrip('-')) in _CONTRIB_RANGE
    except ValueError:
        return False


def _fmt(v: Optional[float]) -> str:
    if v is None:
        return 'N/D'
    return f'{v:,.2f}'.replace(',', 'X').replace('.', ',').replace('X', '.')


def _diff_ok(a: Optional[float], b: Optional[float], tol: float) -> bool:
    if a is None or b is None:
        return False
    return abs(a - b) <= tol


def _validar_empleado(
    liqui: LiquidacionEmpleado,
    recibo: ReciboEmpleado,
) -> ResultadoEmpleado:
    resultado = ResultadoEmpleado(
        legajo=liqui.legajo,
        nombre_liqui=liqui.nombre,
        nombre_recibo=recibo.nombre,
        n_bloques_liqui=liqui.n_bloques,
        n_paginas_recibo=recibo.n_paginas,
    )
    hallazgos = resultado.hallazgos

    # Build lookup for recibo conceptos (non-contribution) by code
    recibo_conceptos: Dict[str, Concepto] = {}
    for c in recibo.conceptos:
        if c.codigo in recibo_conceptos:
            hallazgos.append(Hallazgo(
                tipo='CONCEPTO_DUPLICADO',
                mensaje=f'Recibo: código {c.codigo} ({c.descripcion}) duplicado',
                codigo=c.codigo, descripcion=c.descripcion,
            ))
        else:
            recibo_conceptos[c.codigo] = c

    # --- 1. Verify each liquidacion concept exists in the recibo ---
    for c in liqui.conceptos:
        # Skip contribution-range concepts (validated by total)
        if _is_contrib(c.codigo):
            continue

        rc = recibo_conceptos.get(c.codigo)
        if rc is None:
            hallazgos.append(Hallazgo(
                tipo='CONCEPTO_FALTANTE',
                mensaje=f'Código {c.codigo} ({c.descripcion}) en liquidación [{c.columna}] '
                        f'no encontrado en recibo. Monto: ${_fmt(c.monto)}',
                codigo=c.codigo, descripcion=c.descripcion,
                monto_liqui=c.monto,
            ))
        else:
            if not _diff_ok(c.monto, rc.monto, TOLS_CONCEPTO):
                diff = round(c.monto - rc.monto, 2)
                hallazgos.append(Hallazgo(
                    tipo='MONTO_DIFIERE',
                    mensaje=f'Código {c.codigo} ({c.descripcion}): '
                            f'liquidación ${_fmt(c.monto)} ≠ recibo ${_fmt(rc.monto)} '
                            f'(dif ${_fmt(diff)})',
                    codigo=c.codigo, descripcion=c.descripcion,
                    monto_liqui=c.monto, monto_recibo=rc.monto, diferencia=diff,
                ))

    # --- 2. Verify totals ---
    def _check_total(label: str, lv: Optional[float], rv: Optional[float]) -> None:
        if lv is None and rv is None:
            return
        if lv is None or rv is None:
            hallazgos.append(Hallazgo(
                tipo='TOTAL_DIFIERE',
                mensaje=f'{label}: liquidación={_fmt(lv)} recibo={_fmt(rv)} (uno es N/D)',
            ))
            return
        if not _diff_ok(lv, rv, TOL_TOTAL):
            diff = round(lv - rv, 2)
            hallazgos.append(Hallazgo(
                tipo='TOTAL_DIFIERE',
                mensaje=f'{label}: liquidación ${_fmt(lv)} ≠ recibo ${_fmt(rv)} (dif ${_fmt(diff)})',
                diferencia=diff,
            ))

    _check_total('Neto', liqui.neto, recibo.neto)
    _check_total('Bruto', liqui.bruto, recibo.bruto)
    _check_total('Total Descuentos', liqui.total_desc, recibo.composicion_desc)
    _check_total('Total Contribuciones', liqui.total_contrib, recibo.total_contribuciones)

    # Costo Laboral = Bruto + Contribuciones
    if recibo.bruto is not None and recibo.total_contribuciones is not None:
        costo_calc = round(recibo.bruto + recibo.total_contribuciones, 2)
        if recibo.costo_empleador is not None and not _diff_ok(costo_calc, recibo.costo_empleador, TOL_TOTAL):
            diff = round(costo_calc - recibo.costo_empleador, 2)
            hallazgos.append(Hallazgo(
                tipo='TOTAL_DIFIERE',
                mensaje=f'Costo Laboral recibo: Bruto+Contrib=${_fmt(costo_calc)} ≠ '
                        f'impreso=${_fmt(recibo.costo_empleador)} (dif=${_fmt(diff)})',
                diferencia=diff,
            ))

    # --- 3. Pie chart sum validation (per receipt page, can have multiple) ---
    if recibo.porcentajes_torta:
        total_pct = round(sum(recibo.porcentajes_torta), 2)
        if abs(total_pct - 100.0) > TOL_TORTA:
            hallazgos.append(Hallazgo(
                tipo='TORTA_NO_SUMA',
                mensaje=f'Gráfico de torta: suma de porcentajes = {total_pct}% (esperado ~100%)',
                diferencia=round(total_pct - 100.0, 2),
            ))

    # --- 4. Internal consistency checks ---
    # Neto = Bruto - Descuentos (from recibo)
    if (recibo.bruto is not None and recibo.composicion_desc is not None
            and recibo.neto is not None):
        neto_calc = round(recibo.bruto - recibo.composicion_desc, 2)
        if not _diff_ok(neto_calc, recibo.neto, TOL_TOTAL):
            diff = round(neto_calc - recibo.neto, 2)
            hallazgos.append(Hallazgo(
                tipo='TOTAL_DIFIERE',
                mensaje=f'Recibo: Bruto-Desc=${_fmt(neto_calc)} ≠ Neto impreso=${_fmt(recibo.neto)} '
                        f'(dif=${_fmt(diff)})',
                diferencia=diff,
            ))

    # Determine overall result level
    errores = [h for h in hallazgos if h.tipo not in ('TORTA_NO_SUMA',)]
    advertencias = [h for h in hallazgos if h.tipo == 'TORTA_NO_SUMA']

    if errores:
        resultado.resultado = 'ERROR'
    elif advertencias:
        resultado.resultado = 'ADVERTENCIA'
    else:
        resultado.resultado = 'OK'

    return resultado


def validar(
    liquidaciones: Dict[str, LiquidacionEmpleado],
    recibos: Dict[str, ReciboEmpleado],
    verbose: bool = False,
) -> dict:
    """Run full validation. Returns a report dict ready for JSON serialization."""
    resultados: List[ResultadoEmpleado] = []

    all_legajos = sorted(set(list(liquidaciones.keys()) + list(recibos.keys())))

    for legajo in all_legajos:
        liqui = liquidaciones.get(legajo)
        recibo = recibos.get(legajo)

        if liqui is None:
            # Recibo sin par en liquidación
            r = ResultadoEmpleado(
                legajo=legajo,
                nombre_recibo=recibo.nombre if recibo else '',
                resultado='SIN_PAR',
            )
            r.hallazgos.append(Hallazgo(
                tipo='LEGAJO_SIN_PAR',
                mensaje=f'Legajo {legajo} tiene recibo pero no aparece en la liquidación',
            ))
            resultados.append(r)
            continue

        if recibo is None:
            r = ResultadoEmpleado(
                legajo=legajo,
                nombre_liqui=liqui.nombre,
                resultado='SIN_PAR',
            )
            r.hallazgos.append(Hallazgo(
                tipo='LEGAJO_SIN_PAR',
                mensaje=f'Legajo {legajo} aparece en liquidación pero no tiene recibo',
            ))
            resultados.append(r)
            continue

        r = _validar_empleado(liqui, recibo)
        resultados.append(r)

        if verbose and r.resultado != 'OK':
            print(f'  [{r.resultado}] Legajo {legajo} ({liqui.nombre}): '
                  f'{len(r.hallazgos)} hallazgo(s)')

    # --- Summary ---
    n_ok = sum(1 for r in resultados if r.resultado == 'OK')
    n_error = sum(1 for r in resultados if r.resultado == 'ERROR')
    n_adv = sum(1 for r in resultados if r.resultado == 'ADVERTENCIA')
    n_sin_par = sum(1 for r in resultados if r.resultado == 'SIN_PAR')

    reporte = {
        'resumen': {
            'total_empleados_liqui': len(liquidaciones),
            'total_empleados_recibos': len(recibos),
            'ok': n_ok,
            'errores': n_error,
            'advertencias': n_adv,
            'sin_par': n_sin_par,
        },
        'empleados': [_resultado_to_dict(r) for r in resultados],
    }

    return reporte


def _resultado_to_dict(r: ResultadoEmpleado) -> dict:
    return {
        'legajo': r.legajo,
        'nombre_liqui': r.nombre_liqui,
        'nombre_recibo': r.nombre_recibo,
        'resultado': r.resultado,
        'n_bloques_liqui': r.n_bloques_liqui,
        'n_paginas_recibo': r.n_paginas_recibo,
        'hallazgos': [
            {
                'tipo': h.tipo,
                'mensaje': h.mensaje,
                'codigo': h.codigo,
                'descripcion': h.descripcion,
                'monto_liqui': h.monto_liqui,
                'monto_recibo': h.monto_recibo,
                'diferencia': h.diferencia,
            }
            for h in r.hallazgos
        ],
    }


def print_reporte_consola(reporte: dict) -> None:
    """Print a human-readable summary to stdout."""
    res = reporte['resumen']
    print('\n' + '=' * 70)
    print('REPORTE DE VALIDACIÓN DE RECIBOS')
    print('=' * 70)
    print(f"  Empleados en liquidación : {res['total_empleados_liqui']}")
    print(f"  Empleados en recibos     : {res['total_empleados_recibos']}")
    print(f"  ✅ OK                    : {res['ok']}")
    print(f"  ❌ Con errores           : {res['errores']}")
    print(f"  ⚠️  Advertencias          : {res['advertencias']}")
    print(f"  🔍 Sin par               : {res['sin_par']}")
    print('=' * 70)

    for emp in reporte['empleados']:
        if emp['resultado'] == 'OK':
            continue
        icono = {'ERROR': '❌', 'ADVERTENCIA': '⚠️', 'SIN_PAR': '🔍'}.get(emp['resultado'], '?')
        nombre = emp['nombre_liqui'] or emp['nombre_recibo']
        print(f"\n{icono} Legajo {emp['legajo']}  {nombre}")
        for h in emp['hallazgos']:
            print(f"    • {h['mensaje']}")

    print()
