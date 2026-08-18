/**
 * Strukturierte Protokollierung.
 *
 * Eine JSON-Zeile je Ereignis, damit Betrieb und Tests sie maschinell lesen koennen. Der Logger nimmt
 * bewusst nur flache, benannte Felder entgegen: Tokenmaterial hat hier keinen Platz, und ein durchgereichtes
 * Fehlerobjekt wird auf Name und Meldung reduziert, damit kein Anfragekoerper mit Token im Log landet.
 */

export type LogLevel = 'info' | 'warn' | 'error'

export type LogFields = Readonly<Record<string, string | number | boolean | null>>

export type Logger = (level: LogLevel, event: string, fields?: LogFields) => void

export const consoleLogger: Logger = (level, event, fields = {}) => {
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...fields })
  if (level === 'error') {
    console.error(line)
  } else {
    console.log(line)
  }
}

/** Reduziert einen unbekannten Fehler auf eine kurze, protokollierbare Kennung ohne Nutzlast. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return typeof error === 'string' ? error : 'unbekannter Fehler'
}
