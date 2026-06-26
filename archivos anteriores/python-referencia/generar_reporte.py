#!/usr/bin/env python3
"""
Genera un reporte HTML standalone a partir de los PDFs.

Uso:
    python generar_reporte.py \
        --liqui-partes data/01_*.pdf \
        --recibos data/recibo_contrib_v4.pdf data/recibo_contrib_v4_rrhh.pdf \
        --output data/reporte.html \
        [--periodo "Junio 2026"] [--empresa "Marval & O'Farrell"]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from src.parser_liquidacion import parse_liquidacion
from src.parser_recibos import parse_recibos
from src.validador import validar


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Validación de Recibos · {empresa} · {periodo}</title>
<style>
*,*::before,*::after{{box-sizing:border-box;margin:0;padding:0}}
:root{{--bg:#EEF1F6;--surface:#FFF;--border:#D5DCE8;--border-soft:#E8ECF3;--ink:#1B2A3E;--muted:#64738A;--accent:#1B4F8A;--accent-soft:#E8EFF8;--ok:#177A50;--ok-bg:#E9F7F0;--ok-border:#48BB8B;--error:#BF3737;--error-bg:#FBEEEE;--error-border:#E06060;--warn:#A05A10;--warn-bg:#FEF4E8;--warn-border:#E09040;--sinpar:#5C6B80;--sinpar-bg:#EFF2F6;--sinpar-border:#98A8BC;--r:6px}}
html{{font-size:15px}}body{{background:var(--bg);color:var(--ink);font-family:'Segoe UI',-apple-system,system-ui,sans-serif;line-height:1.5;min-height:100vh}}
.hdr{{background:var(--accent);color:#fff;padding:18px 32px;display:flex;align-items:center;justify-content:space-between;gap:16px}}
.hdr-t{{font-size:1.15rem;font-weight:600;letter-spacing:-.01em}}
.hdr-s{{font-size:.78rem;opacity:.72;letter-spacing:.04em;text-transform:uppercase;margin-top:2px}}
.hdr-r{{text-align:right;font-size:.78rem;opacity:.65}}
.main{{max-width:1200px;margin:0 auto;padding:28px 24px 48px}}
.cards{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px}}
@media(max-width:700px){{.cards{{grid-template-columns:repeat(2,1fr)}}}}
.card{{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px 20px}}
.card-lbl{{font-size:.70rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}}
.card-val{{font-size:2rem;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}}
.card-val.ok{{color:var(--ok)}}.card-val.error{{color:var(--error)}}.card-val.warn{{color:var(--warn)}}.card-val.total{{color:var(--ink)}}
.card-desc{{font-size:.78rem;color:var(--muted);margin-top:6px}}
.toolbar{{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}}
.filters{{display:flex;gap:6px;flex-wrap:wrap}}
.fbtn{{padding:5px 14px;border:1px solid var(--border);border-radius:100px;background:var(--surface);color:var(--muted);font-family:inherit;font-size:.80rem;font-weight:500;cursor:pointer;transition:background .12s,border-color .12s,color .12s}}
.fbtn:hover{{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}}
.fbtn.active{{background:var(--accent);border-color:var(--accent);color:#fff}}
.sw{{margin-left:auto;position:relative}}
.sw svg{{position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none;opacity:.45}}
#search{{padding:6px 12px 6px 34px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);font-family:inherit;font-size:.82rem;color:var(--ink);width:220px;outline:none}}
#search:focus{{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}}
.tw{{overflow-x:auto;border-radius:var(--r);border:1px solid var(--border);background:var(--surface)}}
table{{width:100%;border-collapse:collapse;font-size:.85rem}}
thead tr{{background:#F5F7FB;border-bottom:2px solid var(--border)}}
th{{padding:11px 14px;text-align:left;font-size:.72rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);white-space:nowrap;cursor:pointer;user-select:none}}
th:hover{{color:var(--ink)}}th.num{{text-align:right}}th.center{{text-align:center}}
th .si{{opacity:.3;margin-left:4px}}th.sorted .si{{opacity:.9;color:var(--accent)}}
tbody tr{{border-bottom:1px solid var(--border-soft);border-left:4px solid transparent;transition:background .08s}}
tbody tr:last-child{{border-bottom:none}}tbody tr:hover{{background:#F8FAFD}}tbody tr.hi{{cursor:pointer}}
tbody tr.s-ok{{border-left-color:var(--ok-border)}}
tbody tr.s-error{{border-left-color:var(--error-border);background:#FFFAFA}}tbody tr.s-error:hover{{background:#FEF5F5}}
tbody tr.s-warn{{border-left-color:var(--warn-border)}}tbody tr.s-sinpar{{border-left-color:var(--sinpar-border)}}
td{{padding:10px 14px;vertical-align:middle}}td.num{{text-align:right;font-variant-numeric:tabular-nums;font-size:.83rem}}td.center{{text-align:center}}
.leg{{font-size:.78rem;color:var(--muted);font-variant-numeric:tabular-nums}}.nom{{font-weight:500}}
.pill{{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:100px;font-size:.73rem;font-weight:600;letter-spacing:.03em;white-space:nowrap}}
.p-ok{{background:var(--ok-bg);color:var(--ok)}}.p-error{{background:var(--error-bg);color:var(--error)}}
.p-warn{{background:var(--warn-bg);color:var(--warn)}}.p-sinpar{{background:var(--sinpar-bg);color:var(--sinpar)}}
.torta{{font-size:.78rem;font-variant-numeric:tabular-nums;font-weight:600}}
.torta.ok{{color:var(--ok)}}.torta.warn{{color:var(--warn)}}
.xi{{color:var(--muted);font-size:.75rem;transition:transform .15s}}tr.open .xi{{transform:rotate(90deg)}}
tr.dr td{{padding:0;border-bottom:1px solid var(--border-soft)}}
.di{{padding:14px 20px 14px 32px;background:#F8FAFD;border-left:4px solid var(--accent-soft);display:none}}
tr.dr.open .di{{display:block}}
.dt{{width:100%;border-collapse:collapse;font-size:.80rem;margin-top:6px}}
.dt th{{font-size:.68rem;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);padding:5px 10px;border-bottom:1px solid var(--border);text-align:left;cursor:default}}
.dt td{{padding:5px 10px;border-bottom:1px solid var(--border-soft)}}.dt td.num{{text-align:right;font-variant-numeric:tabular-nums}}
.dt tr:last-child td{{border-bottom:none}}
.ht{{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.68rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}}
.t-MONTO_DIFIERE{{background:var(--error-bg);color:var(--error)}}.t-CONCEPTO_FALTANTE{{background:#FFF3E0;color:#8B4A00}}
.t-TOTAL_DIFIERE{{background:var(--error-bg);color:var(--error)}}.t-TORTA_NO_SUMA{{background:var(--warn-bg);color:var(--warn)}}
.t-LEGAJO_SIN_PAR{{background:var(--sinpar-bg);color:var(--sinpar)}}.t-CONCEPTO_DUPLICADO{{background:#F3E8FF;color:#6B21A8}}
.empty{{text-align:center;padding:52px 24px;color:var(--muted);font-size:.88rem}}
.empty strong{{display:block;font-size:1rem;color:var(--ink);margin-bottom:4px}}
.footer{{margin-top:24px;font-size:.73rem;color:var(--muted);display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}}
</style>
</head>
<body>
<div class="hdr">
  <div>
    <div class="hdr-t">Validación de Recibos de Haberes</div>
    <div class="hdr-s">{empresa} · {periodo}</div>
  </div>
  <div class="hdr-r">Generado el <span id="rd">—</span></div>
</div>
<div class="main">
  <div class="cards" id="cards"></div>
  <div class="toolbar">
    <div class="filters" id="filters"></div>
    <div class="sw">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="5" stroke="#1B2A3E" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="#1B2A3E" stroke-width="1.5" stroke-linecap="round"/></svg>
      <input id="search" type="search" placeholder="Buscar nombre o legajo…">
    </div>
  </div>
  <div class="tw">
    <table id="tbl">
      <thead><tr>
        <th data-col="legajo">Legajo <span class="si">↕</span></th>
        <th data-col="nombre">Nombre <span class="si">↕</span></th>
        <th class="num" data-col="bruto">Bruto <span class="si">↕</span></th>
        <th class="num" data-col="neto">Neto <span class="si">↕</span></th>
        <th class="num" data-col="contrib">Contribuciones <span class="si">↕</span></th>
        <th class="num" data-col="costo">Costo Laboral <span class="si">↕</span></th>
        <th class="center" data-col="torta">Torta <span class="si">↕</span></th>
        <th class="center" data-col="n_conceptos">Conc. <span class="si">↕</span></th>
        <th class="center" data-col="resultado">Estado <span class="si">↕</span></th>
        <th class="center"></th>
      </tr></thead>
      <tbody id="tbody"></tbody>
    </table>
    <div class="empty" id="es" style="display:none"><strong>Sin resultados</strong>Probá ajustando el filtro o la búsqueda.</div>
  </div>
  <div class="footer"><span id="fc"></span><span>Tolerancia por concepto ±$0,01 · Por total ±$1,00 · Contribuciones por total</span></div>
</div>
<script>
const D={DATA_JSON};
function fARS(n){{if(n==null)return'—';const s=n<0;const a=Math.abs(n).toFixed(2).split('.');a[0]=a[0].replace(/\B(?=(\d{{3}})+(?!\d))/g,'.');return(s?'-':'')+'$ '+a[0]+','+a[1];}}
function sc(r){{return r==='OK'?'ok':r==='ERROR'?'error':r==='ADVERTENCIA'?'warn':'sinpar';}}
function sl(r){{return r==='OK'?'✓ OK':r==='ERROR'?'✕ Error':r==='ADVERTENCIA'?'⚠ Advertencia':'? Sin par';}}
let F='all',SC='legajo',SD=1,SQ='';
function rCards(){{const r=D.resumen;document.getElementById('cards').innerHTML=[['Total empleados',r.total,'total','En este lote'],['Sin diferencias',r.ok,'ok','Recibos correctos'],['Con errores',r.errores,'error','Requieren revisión'],['Advertencias',r.advertencias,'warn','Torta u otros']].map(([l,v,c,d])=>`<div class="card"><div class="card-lbl">${{l}}</div><div class="card-val ${{c}}">${{v}}</div><div class="card-desc">${{d}}</div></div>`).join('');}}
function rFilters(){{const r=D.resumen;document.getElementById('filters').innerHTML=[['all',`Todos (${{r.total}})`],['OK',`OK (${{r.ok}})`],['ERROR',`Errores (${{r.errores}})`],['ADVERTENCIA',`Advertencias (${{r.advertencias}})`],['SIN_PAR',`Sin par (${{r.sin_par}})`]].map(([id,lbl])=>`<button class="fbtn${{F===id?' active':''}}" data-f="${{id}}">${{lbl}}</button>`).join('');document.querySelectorAll('.fbtn').forEach(b=>b.addEventListener('click',()=>{{F=b.dataset.f;rT();rFilters();}}));}}
function vis(){{const q=SQ.toLowerCase();return D.empleados.filter(e=>{{if(F!=='all'&&e.resultado!==F)return false;if(q&&!e.nombre.toLowerCase().includes(q)&&!e.legajo.includes(q))return false;return true;}}).sort((a,b)=>{{let av=a[SC],bv=b[SC];if(typeof av==='string')av=av.toLowerCase();if(typeof bv==='string')bv=bv.toLowerCase();return av<bv?-SD:av>bv?SD:0;}});}}
function rT(){{const rows=vis();const tb=document.getElementById('tbody');const es=document.getElementById('es');document.querySelectorAll('th[data-col]').forEach(t=>{{t.classList.toggle('sorted',t.dataset.col===SC);const i=t.querySelector('.si');if(i)i.textContent=t.dataset.col===SC?(SD===1?'↑':'↓'):'↕';}});if(!rows.length){{tb.innerHTML='';es.style.display='';document.getElementById('fc').textContent='Sin resultados.';return;}}es.style.display='none';document.getElementById('fc').textContent=`Mostrando ${{rows.length}} de ${{D.empleados.length}} empleados`;tb.innerHTML=rows.flatMap(e=>{{const s=sc(e.resultado);const hi=e.hallazgos&&e.hallazgos.length>0;const t=e.torta!=null?e.torta.toFixed(2)+'%':'—';const tc=e.torta!=null&&Math.abs(e.torta-100)<=1?'ok':'warn';const mr=`<tr class="s-${{s}}${{hi?' hi':''}}" data-leg="${{e.legajo}}"><td class="leg">${{e.legajo}}</td><td class="nom">${{e.nombre}}</td><td class="num">${{fARS(e.bruto)}}</td><td class="num">${{fARS(e.neto)}}</td><td class="num">${{fARS(e.contrib)}}</td><td class="num">${{fARS(e.costo)}}</td><td class="center"><span class="torta ${{tc}}">${{t}}</span></td><td class="center" style="color:var(--muted);font-size:.78rem">${{e.n_conceptos}}</td><td class="center"><span class="pill p-${{s}}">${{sl(e.resultado)}}</span></td><td class="center">${{hi?'<span class="xi">▶</span>':''}}</td></tr>`;const dr=hi?`<tr class="dr" data-leg="${{e.legajo}}"><td colspan="10"><div class="di"><table class="dt"><thead><tr><th>Tipo</th><th>Código</th><th>Descripción</th><th class="num">Liquidación</th><th class="num">Recibo</th><th class="num">Diferencia</th></tr></thead><tbody>${{e.hallazgos.map(h=>`<tr><td><span class="ht t-${{h.tipo}}">${{h.tipo.replace(/_/g,' ')}}</span></td><td style="font-variant-numeric:tabular-nums;color:var(--muted)">${{h.codigo||'—'}}</td><td>${{h.descripcion||h.mensaje}}</td><td class="num">${{h.monto_liqui!=null?fARS(h.monto_liqui):'—'}}</td><td class="num">${{h.monto_recibo!=null?fARS(h.monto_recibo):'—'}}</td><td class="num" style="color:var(--error)">${{h.diferencia!=null?fARS(h.diferencia):'—'}}</td></tr>`).join('')}}</tbody></table></div></td></tr>`:'';return[mr,dr];}}).join('');tb.querySelectorAll('tr.hi').forEach(tr=>{{tr.addEventListener('click',()=>{{const l=tr.dataset.leg;const d=tb.querySelector(`tr.dr[data-leg="${{l}}"]`);if(!d)return;const o=tr.classList.toggle('open');d.classList.toggle('open',o);}});}});}}
document.querySelectorAll('th[data-col]').forEach(t=>t.addEventListener('click',()=>{{const c=t.dataset.col;if(SC===c)SD*=-1;else{{SC=c;SD=1;}}rT();}}));
document.getElementById('search').addEventListener('input',e=>{{SQ=e.target.value;rT();}});
document.getElementById('rd').textContent=new Date().toLocaleDateString('es-AR',{{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}});
rCards();rFilters();rT();
</script>
</body>
</html>"""


def _fmt_ars(n):
    if n is None:
        return None
    return n


def main():
    parser = argparse.ArgumentParser(description='Genera reporte HTML de validación')
    parser.add_argument('--liqui-partes', nargs='+', required=True,
                        help='PDF(s) de liquidación (pueden ser varias partes)')
    parser.add_argument('--recibos', nargs='+', required=True,
                        help='PDF(s) de recibos')
    parser.add_argument('--output', default='reporte.html',
                        help='Archivo HTML de salida')
    parser.add_argument('--periodo', default='', help='Ej: "Junio 2026"')
    parser.add_argument('--empresa', default='Marval & O\'Farrell')
    parser.add_argument('--verbose', '-v', action='store_true')
    args = parser.parse_args()

    print(f'Parseando liquidación ({len(args.liqui_partes)} archivo(s))…')
    liquis = parse_liquidacion(args.liqui_partes, verbose=args.verbose)
    print(f'  → {len(liquis)} empleados')

    print(f'Parseando recibos ({len(args.recibos)} archivo(s))…')
    recibos = parse_recibos(args.recibos, verbose=args.verbose)
    print(f'  → {len(recibos)} empleados')

    # Filter liqui to employees that have recibos (for multi-group runs)
    liquis_match = {leg: liquis[leg] for leg in recibos if leg in liquis}

    print('Validando…')
    reporte = validar(liquis_match, recibos)

    # Enrich with parsed receipt data for display
    for emp in reporte['empleados']:
        leg = emp['legajo']
        r = recibos.get(leg)
        l = liquis_match.get(leg)
        if r:
            emp['bruto']   = r.bruto
            emp['neto']    = r.neto
            emp['contrib'] = r.total_contribuciones
            emp['costo']   = r.costo_empleador
            emp['n_conceptos'] = len(r.conceptos)
            emp['torta']   = round(sum(r.porcentajes_torta), 2) if r.porcentajes_torta else None
        else:
            emp['bruto'] = emp['neto'] = emp['contrib'] = emp['costo'] = None
            emp['n_conceptos'] = 0
            emp['torta'] = None

    # Inject into HTML template
    data_json = json.dumps(reporte, ensure_ascii=False)
    html = HTML_TEMPLATE.replace('{DATA_JSON}', data_json)\
                        .replace('{empresa}', args.empresa)\
                        .replace('{periodo}', args.periodo or '')

    Path(args.output).write_text(html, encoding='utf-8')
    res = reporte['resumen']
    print(f'\nReporte generado: {args.output}')
    print(f'  ✅ OK: {res["ok"]}  ❌ Errores: {res["errores"]}  '
          f'⚠️  Advertencias: {res["advertencias"]}  🔍 Sin par: {res["sin_par"]}')


if __name__ == '__main__':
    main()
