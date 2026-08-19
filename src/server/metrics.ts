/**
 * Kernmetriken der Instanz im Prometheus-Textformat.
 *
 * Bewusst ohne Client-Bibliothek: gebraucht werden vier Zaehler und vier abgelesene Werte, und das Format
 * ist eine Zeile je Messwert. Eine Abhaengigkeit dafuer waere mehr Angriffsflaeche als Nutzen.
 *
 * **Was hier nie steht:** Pfade, Kennungen, Nutzer, Boards. Eine Metrik mit Pfad- oder Kennungslabel waere
 * eine zweite, unbeaufsichtigte Ausgabe von Nutzungsdaten - und bei vielen Werten ausserdem eine
 * Speicherfalle. Es bleibt bei der Statusklasse; wer mehr wissen will, liest die Protokollzeilen.
 *
 * Der Endpunkt gehoert ins interne Netz. Der Reverse Proxy beantwortet ihn nach aussen mit 404.
 */

export type MetricSources = {
  readonly realtimeConnections: number
  readonly boardRooms: number
  readonly dbPoolTotal: number
  readonly dbPoolIdle: number
  readonly dbPoolWaiting: number
}

export type Metrics = {
  /** Eine beantwortete HTTP-Anfrage. Gezaehlt wird nur die Statusklasse. */
  recordResponse(status: number): void
  /** Eine wegen der Ratengrenze abgelehnte Anfrage. */
  recordRateLimited(): void
  render(sources: MetricSources): string
}

const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const
type StatusClass = (typeof STATUS_CLASSES)[number]

function classOf(status: number): StatusClass | null {
  if (status >= 200 && status < 300) {
    return '2xx'
  }
  if (status >= 300 && status < 400) {
    return '3xx'
  }
  if (status >= 400 && status < 500) {
    return '4xx'
  }
  return status >= 500 && status < 600 ? '5xx' : null
}

export function createMetrics(now: () => number = () => Date.now()): Metrics {
  const startedAt = now()
  const responses: Record<StatusClass, number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }
  let rateLimited = 0

  return {
    recordResponse(status: number): void {
      const statusClass = classOf(status)
      if (statusClass !== null) {
        responses[statusClass] += 1
      }
    },

    recordRateLimited(): void {
      rateLimited += 1
    },

    render(sources: MetricSources): string {
      const lines = [
        '# HELP canvaz_uptime_seconds Laufzeit dieses Anwendungsprozesses in Sekunden.',
        '# TYPE canvaz_uptime_seconds gauge',
        `canvaz_uptime_seconds ${String((now() - startedAt) / 1000)}`,
        '# HELP canvaz_http_responses_total Beantwortete HTTP-Anfragen nach Statusklasse.',
        '# TYPE canvaz_http_responses_total counter',
        ...STATUS_CLASSES.map((key) => `canvaz_http_responses_total{status="${key}"} ${String(responses[key])}`),
        '# HELP canvaz_http_rate_limited_total Wegen der Ratengrenze abgelehnte HTTP-Anfragen.',
        '# TYPE canvaz_http_rate_limited_total counter',
        `canvaz_http_rate_limited_total ${String(rateLimited)}`,
        '# HELP canvaz_realtime_connections Offene WebSocket-Verbindungen.',
        '# TYPE canvaz_realtime_connections gauge',
        `canvaz_realtime_connections ${String(sources.realtimeConnections)}`,
        '# HELP canvaz_board_rooms Offene Boardraeume.',
        '# TYPE canvaz_board_rooms gauge',
        `canvaz_board_rooms ${String(sources.boardRooms)}`,
        '# HELP canvaz_db_pool_connections Verbindungen des Datenbankpools.',
        '# TYPE canvaz_db_pool_connections gauge',
        `canvaz_db_pool_connections{state="total"} ${String(sources.dbPoolTotal)}`,
        `canvaz_db_pool_connections{state="idle"} ${String(sources.dbPoolIdle)}`,
        `canvaz_db_pool_connections{state="waiting"} ${String(sources.dbPoolWaiting)}`,
      ]
      return `${lines.join('\n')}\n`
    },
  }
}
