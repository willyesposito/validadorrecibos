# Validador de Recibos — Hidalgo & Asociados

Herramienta web para **cruzar la liquidación de sueldos contra los recibos de haberes** y
detectar diferencias de conceptos, totales, contribuciones y gráfico de torta.

**100% en el navegador:** subís los archivos y se procesan en tu equipo. Ningún dato se
sube a internet ni a ningún servidor.

## Uso

1. Abrí la herramienta: **https://willyesposito.github.io/validadorrecibos/**
2. **Liquidación de sueldos:** arrastrá el archivo (PDF o Excel).
3. **Recibos de haberes:** arrastrá uno o varios PDF (puede ser un solo archivo con todos).
4. Clic en **Validar**. En unos segundos aparece el reporte: tarjetas de resumen, filtros
   (OK / errores / advertencias / sin par), buscador y detalle por empleado.

## Qué valida

- Cada concepto del trabajador de la liquidación está en el recibo, con el mismo importe.
- Totales: Neto, Bruto, Descuentos, Contribuciones y Costo Laboral.
- Que el gráfico de torta del recibo sume ~100%.

Tolerancias: ±$0,01 por concepto, ±$1,00 por total. Las contribuciones se validan por total.

## Desarrollo / despliegue

- Código de la app: carpeta [`docs/`](docs/) (HTML + CSS + JS, sin backend).
- Publicación: GitHub Pages desde `main` / carpeta `/docs`.
- Detalles técnicos, decisiones y reglas de negocio: ver [CLAUDE.md](CLAUDE.md).

Probar localmente:

```bash
python -m http.server 8123
# http://localhost:8123/docs/index.html
```
