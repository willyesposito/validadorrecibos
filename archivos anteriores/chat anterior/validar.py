#!/usr/bin/env python3
"""Validador de recibos contra liquidación.

Uso típico (autodescubre archivos en data/):
    python validar.py

O explícito:
    python validar.py --liquidacion data/liquidacion/liq.pdf \
                      --recibos data/recibos/*.pdf \
                      --salida output/

Códigos de salida: 0 si no hay ERRORES, 1 si hay al menos un ERROR.
"""
import argparse
import csv
import glob
import json
import os
import sys

from src.parser_liquidacion import cargar_liquidacion
from src.parser_recibo import parse_varios_recibos
from src.validador import validar, ERROR, ADVERTENCIA

RAIZ = os.path.dirname(os.path.abspath(__file__))


def _descubrir(patron_dir, exts):
    archivos = []
    for ext in exts:
        archivos += glob.glob(os.path.join(patron_dir, f"*{ext}"))
    return sorted(archivos)


def main():
    ap = argparse.ArgumentParser(description="Valida recibos contra una liquidación.")
    ap.add_argument("--liquidacion", help="Archivo de liquidación (PDF o Excel).")
    ap.add_argument("--recibos", nargs="+", help="Uno o más archivos de recibos (PDF).")
    ap.add_argument("--salida", default=os.path.join(RAIZ, "output"),
                    help="Carpeta donde escribir los reportes.")
    args = ap.parse_args()

    # --- localizar archivos ---
    liq_path = args.liquidacion
    if not liq_path:
        encontrados = _descubrir(os.path.join(RAIZ, "data", "liquidacion"),
                                 [".pdf", ".xlsx", ".xls", ".xlsm"])
        if len(encontrados) != 1:
            sys.exit("Poné exactamente un archivo de liquidación en data/liquidacion/ "
                     "o pasá --liquidacion. Encontrados: %d" % len(encontrados))
        liq_path = encontrados[0]

    recibo_paths = args.recibos
    if not recibo_paths:
        recibo_paths = _descubrir(os.path.join(RAIZ, "data", "recibos"), [".pdf"])
        if not recibo_paths:
            sys.exit("No hay recibos en data/recibos/ ni se pasó --recibos.")

    print(f"Liquidación: {os.path.basename(liq_path)}")
    print(f"Recibos:     {', '.join(os.path.basename(p) for p in recibo_paths)}")
    print("Parseando...")

    liquidacion = cargar_liquidacion(liq_path)
    recibos, duplicados = parse_varios_recibos(recibo_paths)

    hallazgos, resumen = validar(liquidacion, recibos, duplicados)

    # --- consola ---
    print("\n================ RESUMEN ================")
    print(f"Empleados en liquidación : {resumen['empleados_liquidacion']}")
    print(f"Empleados en recibos     : {resumen['empleados_recibos']}")
    print(f"Evaluados                : {resumen['empleados_evaluados']}")
    print(f"  OK                     : {resumen['ok']}")
    print(f"  Con advertencia        : {resumen['con_advertencia']}")
    print(f"  Con ERROR              : {resumen['con_error']}")
    print(f"Total de hallazgos       : {resumen['total_hallazgos']}")

    por_tipo = {}
    for h in hallazgos:
        clave = (h["severidad"], h["tipo"])
        por_tipo[clave] = por_tipo.get(clave, 0) + 1
    if por_tipo:
        print("\nHallazgos por tipo:")
        for (sev, tipo), n in sorted(por_tipo.items(), key=lambda x: (-x[1])):
            print(f"  [{sev:11}] {tipo:38} {n}")

    errores = [h for h in hallazgos if h["severidad"] == ERROR]
    if errores:
        print(f"\nPrimeros {min(15, len(errores))} ERRORES:")
        for h in errores[:15]:
            print(f"  Legajo {h['legajo']:>5} | {h['tipo']:30} | esp={h['esperado']} enc={h['encontrado']} | {h['detalle']}")

    # --- archivos ---
    os.makedirs(args.salida, exist_ok=True)
    csv_path = os.path.join(args.salida, "hallazgos.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["legajo", "nombre", "severidad", "tipo",
                                          "detalle", "esperado", "encontrado"])
        w.writeheader()
        for h in hallazgos:
            w.writerow(h)

    json_path = os.path.join(args.salida, "resumen.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"resumen": resumen,
                   "hallazgos_por_tipo": {f"{s}|{t}": n for (s, t), n in por_tipo.items()}},
                  f, ensure_ascii=False, indent=2)

    md_path = os.path.join(args.salida, "resumen.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# Reporte de validación\n\n")
        f.write(f"- Liquidación: `{os.path.basename(liq_path)}`\n")
        f.write(f"- Recibos: {', '.join('`'+os.path.basename(p)+'`' for p in recibo_paths)}\n\n")
        f.write("## Resumen\n\n")
        for k, v in resumen.items():
            f.write(f"- {k.replace('_',' ')}: **{v}**\n")
        f.write("\n## Hallazgos por tipo\n\n")
        if por_tipo:
            f.write("| Severidad | Tipo | Cantidad |\n|---|---|---|\n")
            for (sev, tipo), n in sorted(por_tipo.items(), key=lambda x: (-x[1])):
                f.write(f"| {sev} | {tipo} | {n} |\n")
        else:
            f.write("Sin hallazgos.\n")
        if errores:
            f.write("\n## Errores (detalle)\n\n")
            f.write("| Legajo | Tipo | Esperado | Encontrado | Detalle |\n|---|---|---|---|---|\n")
            for h in errores:
                f.write(f"| {h['legajo']} | {h['tipo']} | {h['esperado']} | {h['encontrado']} | {h['detalle']} |\n")

    print(f"\nReportes escritos en: {args.salida}")
    print(f"  - {os.path.basename(csv_path)}  (todos los hallazgos)")
    print(f"  - {os.path.basename(md_path)}  (resumen legible)")
    print(f"  - {os.path.basename(json_path)}")

    sys.exit(1 if resumen["con_error"] > 0 else 0)


if __name__ == "__main__":
    main()
