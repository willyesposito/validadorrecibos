#!/usr/bin/env python3
"""
Compara dos versiones de recibos (ej. v4 vs v6) legajo por legajo.

Verifica que los datos de cada legajo sean IGUALES entre las dos versiones,
ignorando el concepto "Costo SCVO" (agregado en la versión nueva) y su efecto
sobre el gráfico de torta, las contribuciones y el costo del empleador.

Uso:
    python comparar_versiones.py \\
        --v4 "data/recibo_contrib v4.pdf" \\
        --v6 "data/recibo_contrib v6.pdf" \\
        --output data/comparacion_v4_v6.json

Salida: resumen en consola + JSON con los legajos que difieren.
El resultado esperado: todo igual salvo SCVO, con excepción de 2 legajos.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from src.parser_recibos import parse_recibos
from src.models import ReciboEmpleado

# Tolerancias
TOL_CONCEPTO = 0.01
TOL_TOTAL = 1.0

# Palabra clave que identifica el concepto agregado (a ignorar en la comparación)
SCVO_KEYWORD = 'scvo'


def _fmt(v):
    if v is None:
        return 'N/D'
    return f'{v:,.2f}'.replace(',', 'X').replace('.', ',').replace('X', '.')


def _scvo_total(rp: ReciboEmpleado) -> float:
    """Suma de todos los conceptos/contribuciones cuya descripción contiene SCVO."""
    total = 0.0
    for c in list(rp.conceptos) + list(rp.contribuciones):
        if SCVO_KEYWORD in c.descripcion.lower():
            total += abs(c.monto)
    return round(total, 2)


def _mapa_conceptos(rp: ReciboEmpleado) -> dict:
    """Conceptos + contribuciones por código, EXCLUYENDO SCVO. Monto en valor absoluto."""
    m = {}
    for c in list(rp.conceptos) + list(rp.contribuciones):
        if SCVO_KEYWORD in c.descripcion.lower():
            continue
        # Si un código aparece más de una vez (multi-página) sumamos magnitudes
        if c.codigo in m:
            m[c.codigo] = (m[c.codigo][0], round(m[c.codigo][1] + abs(c.monto), 2))
        else:
            m[c.codigo] = (c.descripcion, abs(c.monto))
    return m


def _comparar_legajo(v4: ReciboEmpleado, v6: ReciboEmpleado) -> list:
    """Devuelve lista de diferencias (vacía = idénticos, salvo SCVO)."""
    diffs = []

    m4 = _mapa_conceptos(v4)
    m6 = _mapa_conceptos(v6)

    # Conceptos en ambos lados (excl. SCVO)
    for code in sorted(set(m4) | set(m6)):
        d4 = m4.get(code)
        d6 = m6.get(code)
        if d4 is None:
            diffs.append({
                'tipo': 'CONCEPTO_SOLO_V6',
                'codigo': code, 'descripcion': d6[0],
                'monto_v4': None, 'monto_v6': d6[1],
                'mensaje': f'Código {code} ({d6[0]}): no está en v4, en v6 ${_fmt(d6[1])}',
            })
        elif d6 is None:
            diffs.append({
                'tipo': 'CONCEPTO_SOLO_V4',
                'codigo': code, 'descripcion': d4[0],
                'monto_v4': d4[1], 'monto_v6': None,
                'mensaje': f'Código {code} ({d4[0]}): está en v4 ${_fmt(d4[1])}, no está en v6',
            })
        elif abs(d4[1] - d6[1]) > TOL_CONCEPTO:
            diffs.append({
                'tipo': 'MONTO_DIFIERE',
                'codigo': code, 'descripcion': d4[0],
                'monto_v4': d4[1], 'monto_v6': d6[1],
                'mensaje': f'Código {code} ({d4[0]}): v4 ${_fmt(d4[1])} ≠ v6 ${_fmt(d6[1])} '
                           f'(dif ${_fmt(round(d4[1] - d6[1], 2))})',
            })

    # Totales que NO deberían cambiar con SCVO (lado empleado)
    for label, a, b in (('Bruto', v4.bruto, v6.bruto), ('Neto', v4.neto, v6.neto),
                        ('Total Descuentos', v4.composicion_desc, v6.composicion_desc)):
        if a is None or b is None:
            if a is not None or b is not None:
                diffs.append({
                    'tipo': 'TOTAL_DIFIERE', 'codigo': '', 'descripcion': label,
                    'monto_v4': a, 'monto_v6': b,
                    'mensaje': f'{label}: v4={_fmt(a)} v6={_fmt(b)} (uno es N/D)',
                })
            continue
        if abs(a - b) > TOL_TOTAL:
            diffs.append({
                'tipo': 'TOTAL_DIFIERE', 'codigo': '', 'descripcion': label,
                'monto_v4': a, 'monto_v6': b,
                'mensaje': f'{label}: v4 ${_fmt(a)} ≠ v6 ${_fmt(b)} (dif ${_fmt(round(a - b, 2))})',
            })

    # Totales que SÍ cambian por SCVO: la diferencia debe ser exactamente el SCVO agregado
    scvo = round(_scvo_total(v6) - _scvo_total(v4), 2)
    for label, a, b in (('Total Contribuciones', v4.total_contribuciones, v6.total_contribuciones),
                        ('Costo Empleador', v4.costo_empleador, v6.costo_empleador)):
        if a is None or b is None:
            continue
        delta_inesperado = round((b - a) - scvo, 2)
        if abs(delta_inesperado) > TOL_TOTAL:
            diffs.append({
                'tipo': 'TOTAL_DIFIERE', 'codigo': '', 'descripcion': label,
                'monto_v4': a, 'monto_v6': b,
                'mensaje': f'{label}: v4 ${_fmt(a)} → v6 ${_fmt(b)}; el aumento ${_fmt(round(b - a, 2))} '
                           f'no coincide con el SCVO agregado ${_fmt(scvo)} '
                           f'(diferencia inesperada ${_fmt(delta_inesperado)})',
            })

    return diffs


def main() -> None:
    ap = argparse.ArgumentParser(description='Compara dos versiones de recibos legajo por legajo')
    ap.add_argument('--v4', required=True, help='PDF versión anterior (v4)')
    ap.add_argument('--v6', required=True, help='PDF versión nueva (v6)')
    ap.add_argument('--output', default=None, help='JSON de salida')
    ap.add_argument('--verbose', '-v', action='store_true')
    args = ap.parse_args()

    print(f'Parseando v4: {args.v4}')
    r4 = parse_recibos([args.v4], verbose=args.verbose)
    print(f'  → {len(r4)} legajos')
    print(f'Parseando v6: {args.v6}')
    r6 = parse_recibos([args.v6], verbose=args.verbose)
    print(f'  → {len(r6)} legajos')

    legajos = sorted(set(r4) | set(r6))
    diferentes, solo_v4, solo_v6, scvo_count = [], [], [], 0

    for legajo in legajos:
        a, b = r4.get(legajo), r6.get(legajo)
        if a is None:
            solo_v6.append({'legajo': legajo, 'nombre': b.nombre})
            continue
        if b is None:
            solo_v4.append({'legajo': legajo, 'nombre': a.nombre})
            continue
        if _scvo_total(b) > 0:
            scvo_count += 1
        diffs = _comparar_legajo(a, b)
        if diffs:
            diferentes.append({
                'legajo': legajo, 'nombre': b.nombre or a.nombre, 'diffs': diffs,
            })

    iguales = len(set(r4) & set(r6)) - len(diferentes)
    reporte = {
        'resumen': {
            'legajos_v4': len(r4),
            'legajos_v6': len(r6),
            'iguales_salvo_scvo': iguales,
            'diferentes': len(diferentes),
            'solo_v4': len(solo_v4),
            'solo_v6': len(solo_v6),
            'legajos_con_scvo_en_v6': scvo_count,
        },
        'diferentes': diferentes,
        'solo_v4': solo_v4,
        'solo_v6': solo_v6,
    }

    # --- Consola ---
    print('\n' + '=' * 70)
    print('COMPARACIÓN v4 vs v6  (ignorando "Costo SCVO" y su efecto en torta)')
    print('=' * 70)
    res = reporte['resumen']
    print(f"  Legajos en v4              : {res['legajos_v4']}")
    print(f"  Legajos en v6              : {res['legajos_v6']}")
    print(f"  ✅ Iguales (salvo SCVO)    : {res['iguales_salvo_scvo']}")
    print(f"  ❌ Diferentes              : {res['diferentes']}")
    print(f"  🔍 Solo en v4              : {res['solo_v4']}")
    print(f"  🔍 Solo en v6              : {res['solo_v6']}")
    print(f"  ℹ️  Legajos con SCVO en v6  : {res['legajos_con_scvo_en_v6']}")
    print('=' * 70)

    for emp in diferentes:
        print(f"\n❌ Legajo {emp['legajo']}  {emp['nombre']}")
        for d in emp['diffs']:
            print(f"    • {d['mensaje']}")
    for emp in solo_v4:
        print(f"\n🔍 Legajo {emp['legajo']}  {emp['nombre']}  → solo en v4")
    for emp in solo_v6:
        print(f"\n🔍 Legajo {emp['legajo']}  {emp['nombre']}  → solo en v6")
    print()

    if args.output:
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(reporte, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'Reporte guardado en: {args.output}')


if __name__ == '__main__':
    main()
