/**
 * Die gemeinsamen Bausteine der Oberflaeche.
 *
 * Jede Ansicht hatte bisher ihren eigenen `Notice` und ihren eigenen Satz fuer "wird geladen" und "hier ist
 * nichts". Diese Datei loest diese Wiederholungen ab: dieselbe Auszeichnung, dieselben Klassen aus
 * `styles.css`, dieselbe Rolle fuer Hilfsmittel - unabhaengig davon, welche Ansicht meldet.
 *
 * Die Bausteine entscheiden nichts. Sie stellen dar, was ihnen die Ansicht uebergibt; welche Aktion erlaubt
 * ist und welche Daten sichtbar sind, bleibt Sache des Servers.
 */

import type { ReactNode } from 'react'

/**
 * Art eines Hinweises.
 *
 * `error` meldet sich als `alert` - ein Fehler unterbricht. Alles andere als `status`: es wird ergaenzend
 * vorgelesen und draengt sich nicht dazwischen.
 */
export type NoticeKind = 'error' | 'info' | 'success'

const NOTICE_CLASSES: Readonly<Record<NoticeKind, string>> = {
  error: 'notice notice--error',
  info: 'notice',
  success: 'notice notice--success',
}

/** Hinweis, Fehlermeldung oder Rueckmeldung - ueberall dieselbe Form. */
export function Notice({
  text,
  kind = 'error',
  children,
}: {
  /** Die Meldung in einem Satz. Ein Baustein mit eigenem Aufbau uebergibt stattdessen `children`. */
  readonly text?: string
  readonly kind?: NoticeKind
  readonly children?: ReactNode
}) {
  return (
    <div className={NOTICE_CLASSES[kind]} role={kind === 'error' ? 'alert' : 'status'}>
      {text !== undefined && <p>{text}</p>}
      {children}
    </div>
  )
}

/**
 * Ladeanzeige.
 *
 * Immer mit Text und immer in einem Live-Bereich: wer nicht sieht, dass sich etwas dreht, soll hoeren, dass
 * etwas laedt.
 */
export function Loading({ text }: { readonly text: string }) {
  return (
    <p className="loading" aria-live="polite">
      {text}
    </p>
  )
}

/** Leerer Zustand: er benennt, warum hier nichts steht, und - wo es einen gibt - den naechsten Schritt. */
export function Empty({ text, children }: { readonly text?: string; readonly children?: ReactNode }) {
  return (
    <p className="empty">
      {text}
      {children}
    </p>
  )
}

/**
 * Bestaetigung einer nicht folgenlosen Aktion.
 *
 * Bewusst kein modaler Dialog: der Block steht im Fluss der Seite, braucht keinen Fokuskaefig und keine
 * eigene Escape-Behandlung. `danger` ist dem vorbehalten, was sich nicht zuruecknehmen laesst.
 */
export function ConfirmDialog({
  danger = false,
  children,
}: {
  readonly danger?: boolean
  readonly children: ReactNode
}) {
  return (
    <div className={danger ? 'dialog dialog--danger' : 'dialog'} role="alert">
      {children}
    </div>
  )
}
