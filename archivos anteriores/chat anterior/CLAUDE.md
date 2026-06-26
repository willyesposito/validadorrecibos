# Validador de recibos vs liquidación — Marval & O'Farrell

## Qué hace este proyecto

Cruza una preliquidación mensual de sueldos (PDF) contra los recibos de haberes de los
empleados (PDF). Detecta conceptos faltantes, montos erróneos, totales que no cierran y
recibos con el gráfico de torta roto. Genera un CSV con todos los hallazgos y un Markdown
de resumen.

**Cliente:** Marval & O'Farrell (estudio jurídico, Buenos Aires). Junio 2026.
**Desarrollado para:** Hidalgo & Asociados, Willy Esposito.
**Estado:** código escrito y testeado sobre un caso unitario (ALVAREZ). Falta correr
sobre los 543 empleados y entregar los outputs.

---

## Archivos de entrada

Los tres PDFs son de texto nativo (seleccionable). No hay OCR.

| Archivo | Descripción | Páginas |
|---|---|---|
| `01-_Preliquidación_mensual_06-2026_V2.pdf` | Liquidación ("Control de Liquidación") | 235 (543 empleados, varios por página) |
| `recibo_contrib_v4.pdf` | Recibos masivos | 528 (1 por página) |
| `recibo_contrib_v4_rrhh.pdf` | 15 recibos adicionales (RRHH) | 15 (1 por página) |

528 + 15 = 543 = exactamente los empleados de la liquidación. Sin solapamiento de legajos
entre los dos archivos de recibos.

**Ruta en producción (uploads de Claude.ai):**
```
/mnt/user-data/uploads/01-_Preliquidación_mensual_06-2026_V2.pdf
/mnt/user-data/uploads/recibo_contrib_v4.pdf
/mnt/user-data/uploads/recibo_contrib_v4_rrhh.pdf
```

---

## Estructura del código

```
validador-recibos/
├── validar.py                  # CLI principal (entry point)
├── src/
│   ├── __init__.py
│   ├── util.py                 # parse_money, normalizar_legajo, cluster_lines
│   ├── conceptos.py            # clasificación: internos, trabajador, contribuciones
│   ├── parser_liquidacion.py   # parser del PDF de liquidación
│   ├── parser_recibo.py        # parser de los PDFs de recibos
│   └── validador.py            # lógica de cruce y reglas de negocio
├── data/
│   ├── liquidacion/            # poner aquí el PDF de liquidación
│   └── recibos/                # poner aquí los PDF de recibos
└── output/                     # hallazgos.csv, resumen.md, resumen.json
```

**Dependencias:** `pdfplumber`, `openpyxl`. Instalar con:
```bash
pip install pdfplumber openpyxl --break-system-packages
```

---

## Estructura de los documentos (lo que aprendimos empíricamente)

### Liquidación

Encabezado de cada empleado:
```
Legajo:    0826     Empleado: LUCIANO ,RODOLFO D.     Categoría: 00 - Desconocido
```

Tabla de conceptos con 5 columnas (en coordenadas x reales, pdfplumber):
- UNIDADES  x≈170
- REMUNERATIVO  x≈234  → columna `REM`
- DESCUENTOS  x≈332  → columna `DESC`
- NO REMUNERATIVO  x≈415  → columna `NOREM`
- CONTRIBUCIONES  x≈512  → columna `CONTRIB`

Asignación de columna: se usa el **centro x del número** y se asigna a la columna más cercana.
Los valores están right-aligned; el offset de carácter de pdftotext no sirve.

Bloque de totales al final de cada empleado:
```
Total Haberes: 3.151.333,34   Total Descuentos: 530.626,67   Total Netos: 2.620.706,67
Total Imponible: 3.121.333,34  Total Imp. Contrib: 3.121.333,34  Costo Laboral: 839.747,16
Total Contribuciones: 839.747,16    Reducciones de Contrib.: 10.505,52
```

**Bug conocido del PDF:** pdfplumber a veces pega el primer dígito del importe al final
del label: `'Total Contribuciones2:.949.371,56'`. El parser lo resuelve con un regex
tolerante que extrae el número descartando el ':' intercalado.

### Recibos

Un empleado por página. Layout:
1. Encabezado: APELLIDO, LEGAJO, SUELDO BRUTO, COSTO TOTAL EMPLEADOR.
2. Bloque de contribuciones patronales: entre `COSTO TOTAL EMPLEADOR` y `SUB TOTAL CONTRIBUCIONES EMPLEADOR`.
3. Bloque del trabajador (haberes + descuentos): entre `SUB TOTAL CONTRIBUCIONES EMPLEADOR` y `SUELDO NETO`.
   — **Importante:** NO entre `SUELDO BRUTO` y `SUELDO NETO`, porque `SUELDO BRUTO` aparece
   dos veces en el texto (encabezado de tabla y total) y confunde el delimitador.
4. COMPOSICION SALARIAL: Remunerativo / No Remunerativo / Descuentos.
5. Gráfico de torta: los porcentajes vienen como `59.94%` en el texto.

### Empleados multi-liquidación

8 legajos aparecen más de una vez en la liquidación (y tienen más de una página de recibo).
Son empleados con más de un contrato en el período (ej. legajo 3170 tiene 4 bloques).
Los bloques se **consolidan sumando**: conceptos sumados por código, totales sumados.
Los netos consolidados coinciden exactamente con los recibos (verificado en los 8 casos).

Un recibo tiene importe negativo (FABRIS, legajo 7183, página 171 de recibo_contrib_v4.pdf):
es un recibo de corrección. El parser lo maneja sin problema porque acepta negativos.

---

## Reglas de negocio (TODAS acordadas con el cliente, NO cambiar sin consultar)

### Match por código

El código de 4 dígitos es la clave de cruce. El nombre puede diferir entre liquidación
y recibo (ej. `1003` = "Salario Base" en liq, "Sueldo" en recibo; `6130` = "Contribución
ANSES" en liq, "Contribucion CASFEC/PI" en recibo). **Nunca usar el nombre para matchear.**

### Dirección de la validación: LIQUIDACIÓN → RECIBO

Cada concepto del trabajador de la liquidación tiene que estar en el recibo con el mismo
importe. No al revés. Si está en el recibo y no en la liquidación, es ADVERTENCIA, no ERROR.

### Columnas del trabajador (las que se cruzan línea por línea)

`REM`, `NOREM`, `DESC`. Solo estas tres. Las contribuciones (`CONTRIB`) NO se cruzan
línea por línea (la liquidación agrega base + SAC en un código; el recibo los separa).

### Conceptos internos (EXCLUIR del cruce y de la reconstrucción aritmética)

```python
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
```

Nota: `7116` (Dif OMINT) **NO** es interno. Si aparece en DESC en la liquidación y no
está en el recibo, se reporta como error.

### Contribuciones: solo por total

`Total Contribuciones` (liquidación) vs `Sub Total Contribuciones Empleador` (recibo).
No línea por línea. El match agrupado por código queda para una fase posterior.

### Totales a validar

| Total | Fuente liquidación | Fuente recibo |
|---|---|---|
| Neto | `Total Netos` | `SUELDO NETO` |
| Bruto/Haberes | `Total Haberes` | `SUELDO BRUTO` |
| Descuentos | `Total Descuentos` | `Descuentos` (COMPOSICION SALARIAL) |
| Contribuciones | `Total Contribuciones` | `SUB TOTAL CONTRIBUCIONES EMPLEADOR` |
| Costo Laboral | `Total Haberes + Total Contribuciones` (calculado) | `COSTO TOTAL EMPLEADOR` |

El campo `Costo Laboral` impreso en la liquidación es **engañoso**: en realidad contiene
el Total Contribuciones, no el verdadero costo laboral. Por eso se calcula como
`Bruto + Contribuciones` y se compara contra `Costo Total Empleador` del recibo.

### Gráfico de torta

Los porcentajes del recibo tienen que sumar 100%, tolerancia 0.10 (los valores vienen
redondeados a 2 decimales; ALVAREZ da 100.01, que está OK).

### Tolerancia de comparación de montos

0.01 (un centavo).

---

## Severidades de hallazgos

- `ERROR`: el recibo está mal o no coincide con la liquidación. Debe investigarse y corregirse.
- `ADVERTENCIA`: anomalía que puede ser legítima pero requiere revisión.
- `INFO`: informativo, no requiere acción (ej. empleado multi-liquidación).

Tipos de ERROR: `legajo_sin_recibo`, `recibo_sin_liquidacion`, `concepto_falta_en_recibo`,
`monto_difiere`, `total_neto_no_cierra`, `total_bruto_no_cierra`, `total_descuentos_no_cierra`,
`total_contribuciones_no_cierra`, `costo_laboral_no_cierra`.

Tipos de ADVERTENCIA: `concepto_extra_en_recibo`, `total_no_legible`,
`liq_haberes_no_reconstruye`, `liq_descuentos_no_reconstruye`, `recibo_bruto_no_reconstruye`,
`recibo_neto_no_reconstruye`, `recibo_contrib_no_reconstruye`, `torta_no_suma_100`,
`concepto_duplicado_recibo`, `haber_negativo`, `descuento_negativo`, `pagina_recibo_sin_legajo`.

---

## Caso de verificación: ALVAREZ MICAELA (legajo 4258)

Es el caso verificado manualmente de punta a punta. Una corrida limpia sobre este legajo
debe devolver **solo un INFO** (si no es multi-liquidación: sin hallazgos):

- Legajo: 4258
- Recibo en: `recibo_contrib_v4_rrhh.pdf`, página 1
- Liquidación: página 61 del PDF

Totales esperados:

| | Liquidación | Recibo |
|---|---|---|
| Neto | 8.356.881,55 | 8.356.881,55 |
| Bruto | 10.993.803,18 | 10.993.803,18 |
| Descuentos | 2.636.921,63 | 2.636.921,63 |
| Contribuciones | 2.949.371,56 | 2.949.371,56 |
| Costo Total | 13.943.174,74 | 13.943.174,74 |

Torta: `[20.02, 6.14, 2.66, 0.41, 10.84, 59.94]` → suma 100.01 (OK dentro de tolerancia).

Conceptos del trabajador en la liquidación (11, todos REM/DESC/NOREM, ninguno interno):
`1003, 1017, 3025, 3613, 4899, 5010, 6005, 6018, 6041, 8802, 8805`.

El recibo los tiene todos con el mismo importe.

**Las contribuciones que aparecen en `conceptos_trab` del parser de recibo** (6050, 6093,
6094, 6100, 6101, etc.) **son ADVERTENCIA "concepto_extra_en_recibo"**, NO errores. Esto
es esperado y correcto en el contexto actual (cruce de contribuciones solo por total).
Si querés suprimir estas advertencias para que no saturen el reporte, filtrá por
`es_contribucion()` en el bloque "extra en recibo" del validador.

---

## Cómo correr

```bash
cd /home/claude/validador-recibos   # o donde esté el proyecto

# Opción 1: con los archivos en /mnt/user-data/uploads (Claude.ai)
python validar.py \
  --liquidacion /mnt/user-data/uploads/01-_Preliquidación_mensual_06-2026_V2.pdf \
  --recibos /mnt/user-data/uploads/recibo_contrib_v4.pdf \
           /mnt/user-data/uploads/recibo_contrib_v4_rrhh.pdf

# Opción 2: archivos en data/ (autodescubrimiento)
cp /mnt/user-data/uploads/01-_Preliquidación_mensual_06-2026_V2.pdf data/liquidacion/
cp /mnt/user-data/uploads/recibo_contrib_v4*.pdf data/recibos/
python validar.py
```

Outputs en `output/`:
- `hallazgos.csv` — todos los hallazgos (legajo, nombre, severidad, tipo, detalle, esperado, encontrado)
- `resumen.md` — resumen legible
- `resumen.json` — resumen estructurado

Exit code 0 si no hay ERROREs, 1 si hay alguno.

El parseo de la liquidación demora ~65 segundos (235 páginas). Los 543 recibos demoran
~90 segundos.

---

## Test unitario rápido (solo Alvarez, ~70s)

```python
# test_parse.py (en /home/claude/)
import sys; sys.path.insert(0, "/home/claude/validador-recibos")
from src.parser_recibo import parse_varios_recibos
from src.parser_liquidacion import parse_liquidacion_pdf
from src.validador import validar_empleado

UP = "/mnt/user-data/uploads"
rec, _, _ = parse_varios_recibos([f"{UP}/recibo_contrib_v4_rrhh.pdf"])
liq = parse_liquidacion_pdf(f"{UP}/01-_Preliquidación_mensual_06-2026_V2.pdf")

h = []
validar_empleado("4258", liq["4258"], rec["4258"], h)
errores = [x for x in h if x["severidad"] == "ERROR"]
print("ERROREs:", len(errores))
for x in errores:
    print(x)
```

---

## Pendientes al momento de escribir este archivo

1. **Correr el validador sobre los 543 empleados** y revisar el CSV de hallazgos.
   El criterio de "terminado" es: corrida exitosa con salida interpretable, no cero errores
   (puede haber diferencias reales en los datos).

2. **Filtrar "concepto_extra_en_recibo" para los códigos 6xxx** (contribuciones patronales).
   El recibo los incluye en el bloque del trabajador porque el parser no puede separar
   el bloque de contribuciones cuando vienen mezclados. El validador los marca como ADVERTENCIA
   correctamente, pero generan ruido. La solución es agregar un filtro en el validador:
   si el código extra empieza en `6` y está en el rango de contribuciones conocidas,
   degradarlo de ADVERTENCIA a INFO o suprimirlo.

3. **Fase 2 (futura):** interfaz HTML/web para otros clientes. El código Python actual
   es la base; se puede exponer como API o convertir a WebAssembly.

4. **Parser de liquidación en Excel:** no implementado. Si el cliente manda un Excel,
   `cargar_liquidacion()` lanza `NotImplementedError` con un mensaje claro. Se necesita
   un archivo de muestra para implementarlo sin asumir columnas.

---

## Contexto de negocio

El objetivo de la validación es detectar errores **antes** de que los recibos sean
firmados y entregados a los empleados. Un ERROR real (ej. `monto_difiere` en el neto)
implica que el empleado va a cobrar un importe distinto al de la liquidación aprobada.
Las ADVERTENCIAS pueden ser configuración legítima o señal de que algo se liquidó fuera
del período normal.

NUNCA asumir ni inventar datos de empleados. Todo dato en el reporte sale de lo que
se parsea de los PDFs.
