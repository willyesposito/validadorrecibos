# Validador de Recibos Marval

Cruza recibos en PDF contra la pre-liquidación y reporta diferencias concepto por concepto.

## Archivos que necesitás

Copiá los tres PDFs en la carpeta `data/`:

| Archivo | Descripción |
|---------|-------------|
| `01-Preliquidacion mensual 06-2026 V2.pdf` | Liquidación (543 empleados) |
| `recibo_contrib_v4.pdf` | Recibos generales (528 empleados) |
| `recibo_contrib_v4_rrhh.pdf` | Recibos RRHH (15 empleados) |

## Setup (una sola vez)

```bash
pip install -r requirements.txt
```

## Corrida normal

```bash
python run_validation.py \
  --liqui  "data/01-Preliquidacion mensual 06-2026 V2.pdf" \
  --recibos data/recibo_contrib_v4.pdf data/recibo_contrib_v4_rrhh.pdf \
  --output data/reporte.json
```

Imprime resumen en consola y guarda el JSON completo en `data/reporte.json`.

### Solo empleados con problemas (JSON más chico)

```bash
python run_validation.py \
  --liqui  "data/01-Preliquidacion mensual 06-2026 V2.pdf" \
  --recibos data/recibo_contrib_v4.pdf data/recibo_contrib_v4_rrhh.pdf \
  --output data/reporte.json \
  --solo-errores
```

### Con detalle de progreso

```bash
python run_validation.py --verbose ...
```

---

## Qué valida

### Por cada empleado (cruce: liquidación → recibo, match por legajo)

| Chequeo | Descripción |
|---------|-------------|
| **Conceptos presentes** | Cada código de la liquidación (excl. internos) debe estar en el recibo |
| **Montos** | Tolerancia ±$0,01 por concepto |
| **Total Contribuciones** | Comparación de totales (no línea por línea), tolerancia ±$1,00 |
| **Neto** | Liquidación vs recibo, tolerancia ±$1,00 |
| **Bruto** | Liquidación vs recibo, tolerancia ±$1,00 |
| **Descuentos** | Total descuentos, tolerancia ±$1,00 |
| **Costo Laboral** | Bruto + Contribuciones = Costo Total Empleador (del recibo) |
| **Gráfico de torta** | Suma de porcentajes = 100% ±1 punto |

### Conceptos internos excluidos (no se buscan en los recibos)

- Códigos **5911, 5921, 7100**
- Cualquier concepto cuya descripción contenga "provision", "provisión", "prov.", etc.

---

## Cómo leer el reporte

### Consola

```
======================================================================
REPORTE DE VALIDACIÓN DE RECIBOS
======================================================================
  Empleados en liquidación : 543
  Empleados en recibos     : 543
  ✅ OK                    : 538
  ❌ Con errores           : 4
  ⚠️  Advertencias          : 1
  🔍 Sin par               : 0

❌ Legajo 1234  PEREZ, JUAN
    • Código 1003 (Sueldo): liquidación $6.300.000,00 ≠ recibo $6.350.000,00 (dif $-50.000,00)
```

### JSON (para uso en HTML / Excel)

```json
{
  "resumen": {
    "total_empleados_liqui": 543,
    "total_empleados_recibos": 543,
    "ok": 538,
    "errores": 4,
    "advertencias": 1,
    "sin_par": 0
  },
  "empleados": [
    {
      "legajo": "4258",
      "nombre_liqui": "ALVAREZ, MICAELA",
      "nombre_recibo": "ALVAREZ, MICAELA",
      "resultado": "OK",
      "hallazgos": []
    },
    ...
  ]
}
```

### Tipos de hallazgo

| Tipo | Significa |
|------|-----------|
| `CONCEPTO_FALTANTE` | Código de liquidación no existe en el recibo |
| `MONTO_DIFIERE` | El código existe pero el monto difiere más de $0,01 |
| `TOTAL_DIFIERE` | Un total (Neto, Bruto, Descuentos, Contribuciones) no coincide |
| `TORTA_NO_SUMA` | Los porcentajes del gráfico de torta no suman ~100% |
| `LEGAJO_SIN_PAR` | El legajo existe en un archivo pero no en el otro |
| `CONCEPTO_DUPLICADO` | El mismo código aparece dos veces en el recibo |

---

## Diagnóstico / Calibración de columnas

Si la liquidación tiene un formato diferente o las columnas no clasifican bien,
usá el modo diagnóstico para ver las coordenadas reales:

```bash
python run_validation.py --diagnostico \
  --liqui "data/01-Preliquidacion mensual 06-2026 V2.pdf" \
  --pagina 1
```

Esto imprime cada fila de la página con sus coordenadas X.  
Ajustá los límites en `src/parser_liquidacion.py` → variable `_COL_BOUNDS`.

---

## Estructura del proyecto

```
validadorrecibos/
├── run_validation.py          # Punto de entrada
├── requirements.txt
├── INSTRUCCIONES.md
├── src/
│   ├── models.py              # Dataclasses compartidas
│   ├── parser_recibos.py      # Parser de recibos PDF
│   ├── parser_liquidacion.py  # Parser de liquidación PDF (por coordenadas)
│   └── validador.py           # Lógica de cruce y generación de reporte
└── data/                      # Ponés los PDFs acá (no committeados)
```

---

## Empleados con múltiples bloques

8 empleados aparecen en más de un bloque en la liquidación (distintas relaciones laborales).
El validador los consolida sumando todos sus bloques antes de comparar contra el recibo.
Los recibos también se consolidan si el mismo legajo tiene más de una página.

## Recibos negativos (correcciones)

El parser maneja recibos con importes negativos (ej. legajo 7183 en períodos anteriores).
Estos se consolidan sumando: si hay un recibo de $876.010,55 y uno de corrección por
$−876.010,55, el neto consolidado es $0 y se reporta como tal.
