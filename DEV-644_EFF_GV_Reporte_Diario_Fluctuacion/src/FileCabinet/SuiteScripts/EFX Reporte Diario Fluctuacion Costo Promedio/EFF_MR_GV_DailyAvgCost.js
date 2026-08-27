/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * EFF|GV|Motor de Captura — Reporte Diario de Fluctuación del Costo Promedio
 * Folio: DRD/26/GV/003 | Cliente: Grupo Vida
 *
 * Este script corre en dos modalidades (parámetro custscript_efx_mode,
 * lista customlist_efx_incio_final):
 *   - INICIO (id '1'): captura el costo promedio vigente al inicio del día.
 *   - FINAL  (id '2'): captura el costo promedio vigente al cierre, calcula
 *                      la variación y cierra el registro como 'Completa'.
 *
 * NOTA (20-08-2026): el costo promedio por ubicación se obtiene con
 * search.create sobre el tipo 'item', usando la columna 'locationaveragecost'.
 * Este campo es exclusivo de búsqueda (no está disponible en el sublist
 * 'locations' vía record.load), y cada fila del resultado corresponde a una
 * ubicación distinta del artículo.
 *
 * NOTA (14-08-2026): costingmethod real = 'AVG' (no 'AVERAGE'). Los 3
 * artículos de prueba (internalid 119, 136, 127) son tipo 'Assembly' (sin
 * lote), por eso se agregó 'Assembly' a TIPOS_ARTICULO_ALCANCE. El filtro
 * temporal por internalid y el bloque de diagnóstico se dejan mientras se
 * valida con estos 3 artículos puntuales; quitar ambos antes de producción.
 */
// eslint-disable-next-line no-undef
define(['N/search', 'N/record', 'N/runtime', 'N/log', 'N/format'], (
  search,
  record,
  runtime,
  log,
  format,
) => {
  // IDs internos de customlist_efx_incio_final — CONFIRMADOS
  const MODO = {
    INICIO: '1',
    FINAL: '2',
  };

  // IDs internos de customlist_efx_estatus_captura — CONFIRMAR contra la cuenta
  const ESTATUS = {
    PENDIENTE: '1',
    COMPLETA: '2',
    CON_ERROR: '3',
  };

  // IDs internos de customlist_efx_tipo_variacion — CONFIRMAR contra la cuenta
  const TIPO_VARIACION = {
    AUMENTO: '1',
    DISMINUCION: '2',
    SIN_CAMBIO: '3',
    NO_CALCULABLE: '4',
  };

  // CONFIRMADO por el consultor (puntos 1 y 5): única subsidiaria en alcance.
  const SUBSIDIARIA_ALCANCE = '6'; // GIVSA

  // PENDIENTE de confirmación final con el cliente (puntos 3 y 4).
  // Se agregó 'Assembly' porque los 3 artículos de prueba reales son de
  // ese tipo (sin lote), no LotNumberedAssemblyItem como se asumió antes.
  const TIPOS_ARTICULO_ALCANCE = [
    'LotNumberedAssemblyItem',
    'LotNumberedInventoryItem',
    'Assembly',
  ];

  // CONFIRMADO: el campo es 'locationaveragecost', obtenido vía search.create
  // sobre el tipo 'item' (columna directa, sin necesidad de join explícito).
  // Es un campo exclusivo de búsqueda: no está disponible en el sublist
  // 'locations' del artículo a través de record.load.
  const CAMPO_COSTO_PROMEDIO = 'locationaveragecost';

  // TEMPORAL — internalid de los 3 artículos de prueba confirmados con el
  // consultor (06431008, 05760107, 05400031). Quitar este filtro cuando se
  // valide con el universo completo de artículos.

  // Los campos tipo lista/registro (como "type") llegan en context.value
  // como un objeto { value, text } en vez de texto plano. Esta función
  // extrae el valor real sin importar el formato en que haya llegado.
  function obtenerValorPlano(valor) {
    if (valor && typeof valor === 'object' && 'value' in valor) {
      return valor.value;
    }
    return valor;
  }

  // Mapa de valores de la columna 'type' (búsqueda de ítems) a record.Type real.
  function resolverTipoDeRegistro(tipoBusqueda) {
    const mapa = {
      InvtPart: record.Type.INVENTORY_ITEM,
      Assembly: record.Type.ASSEMBLY_ITEM,
      LotNumberedInventoryItem: record.Type.LOT_NUMBERED_INVENTORY_ITEM,
      LotNumberedAssemblyItem: record.Type.LOT_NUMBERED_ASSEMBLY_ITEM,
      SerializedInventoryItem: record.Type.SERIALIZED_INVENTORY_ITEM,
      SerializedAssemblyItem: record.Type.SERIALIZED_ASSEMBLY_ITEM,
    };
    const tipo = mapa[tipoBusqueda];
    if (!tipo) {
      throw new Error(
        'Tipo de artículo no soportado para costeo promedio: ' + tipoBusqueda
      );
    }
    return tipo;
  }

  /**
   * Marca un registro diario YA EXISTENTE (por su internalid) como "Con error",
   * guardando el detalle técnico en el campo Mensaje de error.
   * Se usa en capturarCostoFinal, donde el dailyRecordId ya se conoce desde
   * el inicio (viene del propio registro que se está procesando).
   */
  function marcarRegistroConError(dailyRecordId, mensajeError) {
    try {
      record.submitFields({
        type: 'customrecord_efx_daily_avg_cost',
        id: dailyRecordId,
        values: {
          custrecord_efx_daily_avg_cost_status_cap: ESTATUS.CON_ERROR,
          custrecord_efx_daily_avg_cost_error_mess: mensajeError,
        },
      });
    } catch (e) {
      // Si ni siquiera se puede marcar el error, al menos que quede en el log.
      log.error({
        title: 'No se pudo marcar el registro ' + dailyRecordId + ' como Con error',
        details: e.message,
      });
    }
  }

  /**
   * Crea o actualiza (upsert) un registro diario en estatus "Con error",
   * para una combinación artículo + ubicación + fecha específica.
   * Se usa en capturarCostoInicial, donde el registro puede no existir
   * todavía cuando ocurre el fallo (por ejemplo, si falla la lectura del
   * costo de una ubicación puntual).
   */
  function upsertRegistroConError({ itemId, locationId, fecha, mensajeError }) {
    try {
      const existingId = buscarRegistroExistente({ itemId, locationId, fecha });
      const values = {
        custrecord_efx_daily_avg_cost_fecha_anal: fecha,
        custrecord_efx_daily_avg_cost_subsidiary: SUBSIDIARIA_ALCANCE,
        custrecord_efx_daily_avg_cost_item: itemId,
        custrecord_efx_daily_avg_cost_location: locationId,
        custrecord_efx_daily_avg_cost_status_cap: ESTATUS.CON_ERROR,
        custrecord_efx_daily_avg_cost_error_mess: mensajeError,
      };

      if (existingId) {
        record.submitFields({
          type: 'customrecord_efx_daily_avg_cost',
          id: existingId,
          values: values,
        });
      } else {
        const nuevoRegistro = record.create({
          type: 'customrecord_efx_daily_avg_cost',
          isDynamic: false,
        });
        Object.keys(values).forEach((campo) => {
          nuevoRegistro.setValue({ fieldId: campo, value: values[campo] });
        });
        nuevoRegistro.save();
      }
    } catch (e) {
      log.error({
        title: 'No se pudo registrar el error para item ' + itemId + ' / ubicación ' + locationId,
        details: e.message,
      });
    }
  }

  /**
   * Lógica de upsert: evita duplicados para Fecha + Ubicación + Artículo.
   */
  function buscarRegistroExistente({ itemId, locationId, fecha }) {
    log.debug('<span color="red">[buscarRegistroExistente][Valores]</span>', {itemId, locationId, fecha});

    /* const inicioDia = new Date(fecha);
    inicioDia.setHours(0, 0, 0, 0);
    const finDia = new Date(fecha);
    finDia.setHours(23, 59, 59, 999); */

    let fechaTexto = format.format({
      value: fecha, // tu objeto Date con el día que analizas
      type: format.Type.DATE
    });

    const resultados = search
      .create({
        type: 'customrecord_efx_daily_avg_cost',
        filters: [
          ['custrecord_efx_daily_avg_cost_item', 'anyof', itemId],
          'AND',
          ['custrecord_efx_daily_avg_cost_location', 'anyof', locationId],
          'AND',
          // ** ['custrecord_efx_daily_avg_cost_fecha_anal', 'within', inicioDia, finDia],
          ['custrecord_efx_daily_avg_cost_fecha_anal', 'on', fechaTexto],
        ],
        columns: ['internalid'],
      })
      .run()
      .getRange({ start: 0, end: 1 });

    return resultados.length ? resultados[0].id : null;
  }

  /**
   * Devuelve el costo promedio por ubicación de un artículo, usando
   * search.create sobre el tipo 'item' con la columna CAMPO_COSTO_PROMEDIO
   * (locationaveragecost). Cada fila del resultado corresponde a una
   * ubicación distinta donde el artículo tiene inventario.
   *
   * @param {string|number} itemId - Internal ID del artículo
   * @returns {Array<{locationId: string, costo: string}>}
   */
  function obtenerCostosPorUbicacion(itemId) {
    const costosPorUbicacion = [];

    search
      .create({
        type: search.Type.ITEM,
        filters: [['internalid', 'anyof', itemId]],
        columns: ['inventorylocation', CAMPO_COSTO_PROMEDIO, ],
      })
      .run()
      .each((r) => {
        const locationId = r.getValue({ name: 'inventorylocation' });
        if (locationId) {
          costosPorUbicacion.push({
            locationId: locationId,
            locationText: r.getText({ name: 'inventorylocation' }),
            costo: r.getValue({ name: CAMPO_COSTO_PROMEDIO }) || 0,
          });
        }
        return true;
      });

    return costosPorUbicacion;
  }

  /**
   * Devuelve el costo promedio de un artículo para UNA ubicación específica,
   * usando el mismo mecanismo de búsqueda (locationaveragecost). Se usa en
   * capturarCostoFinal, donde ya se conoce la ubicación puntual a consultar.
   *
   * @param {string|number} itemId - Internal ID del artículo
   * @param {string|number} locationId - Internal ID de la ubicación
   * @returns {string|null} Costo promedio en la ubicación, o null si no aplica
   */
  function obtenerCostoPorUbicacionEspecifica(itemId, locationId) {
    let costo = null;

    search
      .create({
        type: search.Type.ITEM,
        filters: [
          ['internalid', 'anyof', itemId],
          'AND',
          ['inventorylocation', 'anyof', locationId],
        ],
        columns: [CAMPO_COSTO_PROMEDIO],
      })
      .run()
      .each((r) => {
        costo = r.getValue({ name: CAMPO_COSTO_PROMEDIO });
        return false;
      });

    return costo;
  }

  const getInputData = () => {
    const modo = runtime
      .getCurrentScript()
      .getParameter({ name: 'custscript_efx_mode' });

    log.debug({ title: 'getInputData — inicio', details: 'Modo recibido: ' + Object.keys(MODO).find((key) => MODO[key] === modo), });

    // TEMPORAL — solo para diagnóstico, quitar después
    const busqueda1 = search.create({
      type: search.Type.ITEM,
      // ** filters: [ ['internalid', 'anyof', ITEMS_DE_PRUEBA],],
      columns: [
        'internalid',
        'itemid',
        'isinactive',
        'costingmethod',
        'subsidiary',
        'type',
      ],
    });

    const resultados1 = busqueda1.run().getRange({ start: 0, end: 10 });
    resultados1.forEach((r) => {
      log.debug({
        title: 'DIAGNÓSTICO artículo ' + r.getValue('itemid'),
        details:
          'isinactive=' + r.getValue('isinactive') +
          ' | costingmethod=' + r.getText('costingmethod') +
          ' (' + r.getValue('costingmethod') + ')' +
          ' | subsidiary=' + r.getText('subsidiary') +
          ' (' + r.getValue('subsidiary') + ')' +
          ' | type=' + r.getValue('type'),
      });
    });


    if (modo === MODO.INICIO) {
      const busqueda = search.create({
        type: search.Type.ITEM,
        filters: [
          ['isinactive', 'is', 'F'],
          'AND',
          ['costingmethod', 'anyof', 'AVG'],
          'AND',
          ['subsidiary', 'anyof', SUBSIDIARIA_ALCANCE],
          'AND',
          ['type', 'anyof', TIPOS_ARTICULO_ALCANCE],
          // ** 'AND', ['internalid', 'anyof', ITEMS_DE_PRUEBA],
        ],
        columns: ['internalid', 'itemid', 'displayname', 'type'],
      });

      log.debug({
        title: 'getInputData — modo INICIO',
        details:
          'Artículos encontrados: ' + busqueda.runPaged().count,
      });

      return busqueda;
    }

    if (modo === MODO.FINAL) {
      const busqueda = search.create({
        type: 'customrecord_efx_daily_avg_cost',
        filters: [
          ['custrecord_efx_daily_avg_cost_status_cap', 'anyof', ESTATUS.PENDIENTE],
        ],
        columns: [
          'internalid',
          'custrecord_efx_daily_avg_cost_item',
          'custrecord_efx_daily_avg_cost_location',
        ],
      });

      log.debug({
        title: 'getInputData — modo FINAL',
        details:
          'Registros pendientes encontrados: ' + busqueda.runPaged().count,
      });

      return busqueda;
    }

    log.error({
      title: 'Modo de ejecución no reconocido',
      details: 'Valor recibido: ' + modo,
    });
    return [];
  };

  const map = (context) => {
    const modo = runtime
      .getCurrentScript()
      .getParameter({ name: 'custscript_efx_mode' });

    log.debug({
      title: 'map — procesando key ' + context.key,
      details: 'Modo: ' + modo,
    });

    try {
      if (modo === MODO.INICIO) {
        capturarCostoInicial(context);
      } else if (modo === MODO.FINAL) {
        capturarCostoFinal(context);
      }
    } catch (e) {
      log.error({
        title: 'Error en map — ' + context.key,
        details: e.message,
      });
      context.write({
        key: context.key,
        value: { error: e.message, stage: 'map', modo: modo },
      });
    }
  };

  /**
   * Fase 1 — Captura inicial: por cada artículo, lee el costo por ubicación
   * y crea (o actualiza si ya existe) el registro diario en estatus 'Pendiente'.
   */
  function capturarCostoInicial(context) {
    const result = JSON.parse(context.value);
    const itemId = result.id;
    const tipoItem = resolverTipoDeRegistro(obtenerValorPlano(result.values.type));

    log.debug({
      title: 'capturarCostoInicial — artículo ' + itemId,
      details: 'Tipo resuelto: ' + tipoItem,
    });

    const costosPorUbicacion = obtenerCostosPorUbicacion(itemId);
    const hoy = new Date();

    log.debug({
      title: 'capturarCostoInicial — ubicaciones encontradas',
      details: 'Artículo ' + itemId + ' tiene ' + costosPorUbicacion.length + ' ubicación(es)',
    });

    for (let i = 0; i < costosPorUbicacion.length; i++) {
      const locationId = costosPorUbicacion[i].locationId;
      if (!locationId) continue;

      try {
        // Costo obtenido vía search.create (locationaveragecost), un valor por ubicación.
        const costoInicialRaw = costosPorUbicacion[i].costo;
        const costoInicial = parseFloat(costoInicialRaw);

        log.debug({
          title: 'capturarCostoInicial — costo leído',
          details:
            'Item ' + itemId + ' / Ubicación ' + locationId +
            ' / Campo ' + CAMPO_COSTO_PROMEDIO + ' = ' + costoInicialRaw,
        });

        const existingId = buscarRegistroExistente({
          itemId,
          locationId,
          fecha: hoy,
        });

        const values = {
          custrecord_efx_daily_avg_cost_fecha_anal: hoy,
          custrecord_efx_daily_avg_cost_subsidiary: SUBSIDIARIA_ALCANCE,
          custrecord_efx_daily_avg_cost_item: itemId,
          custrecord_efx_daily_avg_cost_location: locationId,
          custrecord_efx_daily_avg_cost_cos_pro_i: isNaN(costoInicial) ? '' : costoInicial,
          custrecord_efx_daily_avg_cost_fec_cap_i: new Date(),
          custrecord_efx_daily_avg_cost_status_cap: ESTATUS.PENDIENTE,
        };

        if (existingId) {
          log.debug('[]', '[2]');
          record.submitFields({
            type: 'customrecord_efx_daily_avg_cost',
            id: existingId,
            values: values,
          });
          log.audit({
            title: 'capturarCostoInicial — registro actualizado (upsert)',
            details: 'Custom record id ' + existingId,
          });
        } else {
          log.debug('[]', '[3]');
          const nuevoRegistro = record.create({
            type: 'customrecord_efx_daily_avg_cost',
            isDynamic: false,
          });
          Object.keys(values).forEach((campo) => {
            nuevoRegistro.setValue({ fieldId: campo, value: values[campo] });
          });
          const nuevoId = nuevoRegistro.save();
          log.audit({
            title: 'capturarCostoInicial — registro creado',
            details: 'Custom record id ' + nuevoId,
          });
        }
      } catch (eUbicacion) {
        // Un fallo en ESTA ubicación no debe impedir procesar las demás
        // ubicaciones del mismo artículo (regla de manejo de errores del DRD).
        log.error({
          title: 'capturarCostoInicial — error en ubicación ' + locationId,
          details: eUbicacion.message,
        });
        upsertRegistroConError({
          itemId,
          locationId,
          fecha: hoy,
          mensajeError: eUbicacion.message,
        });
      }
    }
  }

  /**
   * Fase 2 — Captura final: lee el costo vigente al cierre,
   * calcula la variación y cierra el registro como 'Completa'.
   */
  function capturarCostoFinal(context) {
    const result = JSON.parse(context.value);
    const dailyRecordId = result.id;
    const itemId = result.values.custrecord_efx_daily_avg_cost_item.value;
    const locationId = result.values.custrecord_efx_daily_avg_cost_location.value;

    log.debug({
      title: 'capturarCostoFinal — registro ' + dailyRecordId,
      details: 'Item ' + itemId + ' / Ubicación ' + locationId,
    });

    try {
      const dailyRecord = record.load({
        type: 'customrecord_efx_daily_avg_cost',
        id: dailyRecordId,
      });

      const costoInicial = parseFloat(
        dailyRecord.getValue({
          fieldId: 'custrecord_efx_daily_avg_cost_cos_pro_i',
        })
      );

      const costoFinalRaw = obtenerCostoPorUbicacionEspecifica(itemId, locationId);
      let costoFinal = NaN;

      if (costoFinalRaw === null) {
        log.audit({
          title: 'capturarCostoFinal — ubicación no disponible',
          details:
            'Item ' + itemId + ' ya no tiene configurada la ubicación ' + locationId,
        });
      } else {
        costoFinal = parseFloat(costoFinalRaw);
        log.debug({
          title: 'capturarCostoFinal — costo leído',
          details:
            'Item ' + itemId + ' / Campo ' + CAMPO_COSTO_PROMEDIO + ' = ' + costoFinalRaw,
        });
      }

      let variacionImporte = null;
      let variacionPorcentual = null;
      let tipoVariacion;

      if (!costoInicial || isNaN(costoFinal)) {
        tipoVariacion = TIPO_VARIACION.NO_CALCULABLE;
      } else {
        variacionImporte = costoFinal - costoInicial;
        variacionPorcentual = (variacionImporte / costoInicial) * 100;
        if (variacionImporte > 0) tipoVariacion = TIPO_VARIACION.AUMENTO;
        else if (variacionImporte < 0) tipoVariacion = TIPO_VARIACION.DISMINUCION;
        else tipoVariacion = TIPO_VARIACION.SIN_CAMBIO;
      }

      if (!isNaN(costoFinal)) {
        dailyRecord.setValue({
          fieldId: 'custrecord_efx_daily_avg_cost_cos_pro_f',
          value: costoFinal,
        });
      }
      dailyRecord.setValue({
        fieldId: 'custrecord_efx_daily_avg_cost_fec_cap_f',
        value: new Date(),
      });
      if (variacionImporte !== null) {
        dailyRecord.setValue({
          fieldId: 'custrecord_efx_daily_avg_cost_var_import',
          value: variacionImporte,
        });
      }
      if (variacionPorcentual !== null) {
        dailyRecord.setValue({
          fieldId: 'custrecord_efx_daily_avg_cost_var_percen',
          value: variacionPorcentual,
        });
      }
      dailyRecord.setValue({
        fieldId: 'custrecord_efx_daily_avg_cost_var_type',
        value: tipoVariacion,
      });
      dailyRecord.setValue({
        fieldId: 'custrecord_efx_daily_avg_cost_status_cap',
        value: ESTATUS.COMPLETA,
      });

      dailyRecord.save();

      log.audit({
        title: 'capturarCostoFinal — registro completado',
        details: 'Custom record id ' + dailyRecordId + ' / Tipo variación: ' + tipoVariacion,
      });
    } catch (eFinal) {
      // Ya tenemos dailyRecordId desde el inicio, así que sí podemos marcar
      // ESTE registro puntual como "Con error" sin afectar a los demás.
      log.error({
        title: 'capturarCostoFinal — error en registro ' + dailyRecordId,
        details: eFinal.message,
      });
      marcarRegistroConError(dailyRecordId, eFinal.message);
    }
  }

  return { getInputData, map };
});