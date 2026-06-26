#!/usr/bin/env python3
"""
Validador de Recibos vs Liquidación - Marval & O'Farrell

Uso:
    python run_validation.py \\
        --liqui  "data/01-Preliquidacion mensual 06-2026 V2.pdf" \\
        --recibos data/recibo_contrib_v4.pdf data/recibo_contrib_v4_rrhh.pdf \\
        [--output data/reporte.json] \\
        [--verbose] [--solo-errores]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from src.parser_liquidacion import parse_liquidacion
from src.parser_recibos import parse_recibos
from src.validador import validar, print_reporte_consola


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Valida recibos PDF contra liquidación PDF',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument('--liqui', required=False, help='PDF de pre-liquidación')
    parser.add_argument('--recibos', nargs='+', required=False,
                        help='Uno o más PDFs de recibos')
    parser.add_argument('--output', default=None,
                        help='Archivo JSON de salida (opcional, por defecto stdout)')
    parser.add_argument('--verbose', '-v', action='store_true',
                        help='Mostrar progreso detallado')
    parser.add_argument('--solo-errores', action='store_true',
                        help='En la salida JSON incluir solo empleados con hallazgos')

    args = parser.parse_args()

    # --- Validation mode ---
    if not args.liqui or not args.recibos:
        parser.print_help()
        sys.exit(1)

    print(f'Parseando liquidación: {args.liqui}')
    liquidaciones = parse_liquidacion([args.liqui], verbose=args.verbose)
    print(f'  → {len(liquidaciones)} empleados')

    print(f'Parseando recibos: {args.recibos}')
    recibos = parse_recibos(args.recibos, verbose=args.verbose)
    print(f'  → {len(recibos)} empleados')

    print('Validando...')
    reporte = validar(liquidaciones, recibos, verbose=args.verbose)

    if args.solo_errores:
        reporte['empleados'] = [
            e for e in reporte['empleados'] if e['resultado'] != 'OK'
        ]

    # Print summary to console
    print_reporte_consola(reporte)

    # Save or print JSON
    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(reporte, ensure_ascii=False, indent=2), encoding='utf-8'
        )
        print(f'Reporte guardado en: {args.output}')
    else:
        print('\n--- JSON completo ---')
        print(json.dumps(reporte, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
