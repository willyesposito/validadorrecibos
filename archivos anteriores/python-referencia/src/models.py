"""Shared data models."""
from dataclasses import dataclass, field
from typing import Optional, List


@dataclass
class Concepto:
    codigo: str
    descripcion: str
    monto: float
    columna: str = ''  # REM / DESC / NOREM / CONTRIB (liquidacion only)


@dataclass
class ReciboEmpleado:
    legajo: str
    nombre: str
    bruto: Optional[float]
    neto: Optional[float]
    total_contribuciones: Optional[float]
    costo_empleador: Optional[float]
    composicion_rem: Optional[float]
    composicion_no_rem: Optional[float]
    composicion_desc: Optional[float]
    conceptos: List[Concepto] = field(default_factory=list)
    contribuciones: List[Concepto] = field(default_factory=list)
    porcentajes_torta: List[float] = field(default_factory=list)
    paginas: List[int] = field(default_factory=list)
    n_paginas: int = 1
    errores_parse: List[str] = field(default_factory=list)


@dataclass
class LiquidacionEmpleado:
    legajo: str
    nombre: str
    bruto: Optional[float]          # Total Remunerativo + No Remunerativo
    neto: Optional[float]
    total_rem: Optional[float]
    total_desc: Optional[float]
    total_no_rem: Optional[float]
    total_contrib: Optional[float]
    conceptos: List[Concepto] = field(default_factory=list)
    n_bloques: int = 1
    errores_parse: List[str] = field(default_factory=list)


@dataclass
class Hallazgo:
    tipo: str          # CONCEPTO_FALTANTE | MONTO_DIFIERE | TOTAL_DIFIERE | TORTA_NO_SUMA | LEGAJO_SIN_PAR | CONCEPTO_DUPLICADO
    mensaje: str
    codigo: str = ''
    descripcion: str = ''
    monto_liqui: Optional[float] = None
    monto_recibo: Optional[float] = None
    diferencia: Optional[float] = None


@dataclass
class ResultadoEmpleado:
    legajo: str
    nombre_liqui: str = ''
    nombre_recibo: str = ''
    resultado: str = 'OK'   # OK | ERROR | ADVERTENCIA | SIN_PAR
    hallazgos: List[Hallazgo] = field(default_factory=list)
    n_bloques_liqui: int = 1
    n_paginas_recibo: int = 1
