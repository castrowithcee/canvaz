/**
 * Die gemeinsamen Bausteine der Oberflaeche.
 *
 * Jede Ansicht hatte bisher ihre eigene Aktionszeile, ihr eigenes Feld und ihren eigenen Satz fuer "wird
 * geladen" und "hier ist nichts". Diese Datei loest diese Wiederholungen ab: dieselbe Auszeichnung,
 * dieselben Klassen aus `styles.css`, dieselbe Rolle fuer Hilfsmittel - unabhaengig davon, welche Ansicht
 * meldet. Varianten werden **hier** erweitert und nicht je Ansicht nachgebaut.
 *
 * Die Bausteine entscheiden nichts. Sie stellen dar, was ihnen die Ansicht uebergibt; welche Aktion erlaubt
 * ist und welche Daten sichtbar sind, bleibt Sache des Servers.
 *
 * Die Symbole kommen aus `lucide-react` und liegen als SVG im Bundle. Es wird zur Laufzeit nichts
 * nachgeladen. Eine Schaltflaeche, die nur aus einem Symbol besteht, traegt immer einen zugaenglichen Namen.
 */

import type { ComponentPropsWithRef, ReactNode } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Inbox,
  Loader2,
  Lock,
  SearchX,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/* ------------------------------------------------------------- Aktionen */

/**
 * Gewicht einer Aktion.
 *
 * `primary` ist der Hauptweg und steht hoechstens einmal je aktivem Bereich. `normal` ist die gewoehnliche
 * Nebenaktion, `quiet` die beilaeufige, `danger` die nicht folgenlose.
 */
export type ActionVariant = 'primary' | 'normal' | 'quiet' | 'danger'

const VARIANT_CLASSES: Readonly<Record<ActionVariant, string>> = {
  primary: 'button button--primary',
  normal: 'button',
  quiet: 'button button--quiet',
  danger: 'button button--danger',
}

/**
 * Die Klassen einer Aktion.
 *
 * Auch ein Link kann eine Aktion sein (`Link className={actionClass('primary')}`). Er bekommt dieselbe
 * Gestalt wie die Schaltflaeche, ohne dass eine Ansicht die Klassennamen selbst zusammensetzt.
 */
export function actionClass(variant: ActionVariant = 'normal', extra?: string): string {
  return extra === undefined ? VARIANT_CLASSES[variant] : `${VARIANT_CLASSES[variant]} ${extra}`
}

type ButtonProps = Omit<ComponentPropsWithRef<'button'>, 'className'> & {
  readonly variant?: ActionVariant
  /** Symbol vor der Beschriftung. Es ist Schmuck: die Beschriftung traegt die Bedeutung. */
  readonly icon?: LucideIcon
  /** Laufende Aktion: der Knopf zeigt sie an und verhindert die Doppelausfuehrung. */
  readonly busy?: boolean
  readonly extraClass?: string
}

/** Schaltflaeche mit Gewicht, Symbol und Laufzustand. */
export function Button({
  variant = 'normal',
  icon: Icon,
  busy = false,
  extraClass,
  disabled = false,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={actionClass(variant, extraClass)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? (
        <Loader2 className="loading__spinner" size={16} aria-hidden="true" />
      ) : (
        Icon !== undefined && <Icon size={16} aria-hidden="true" />
      )}
      {children}
    </button>
  )
}

/** Schaltflaeche aus einem Symbol. `label` ist ihr Name - fuer Hilfsmittel und als Kurzhinweis. */
export function IconButton({
  label,
  icon: Icon,
  variant = 'normal',
  extraClass,
  type = 'button',
  ...rest
}: Omit<ButtonProps, 'children' | 'icon' | 'busy'> & {
  readonly label: string
  readonly icon: LucideIcon
}) {
  return (
    <button
      {...rest}
      type={type}
      className={actionClass(variant, extraClass === undefined ? 'icon-button' : `icon-button ${extraClass}`)}
      aria-label={label}
      title={label}
    >
      <Icon size={18} aria-hidden="true" />
    </button>
  )
}

/* ------------------------------------------------------------- Formular */

/**
 * Ein Formularfeld mit Beschriftung, Begleittext und Fehlermeldung.
 *
 * Begleittext und Fehler sind dem Bedienelement ueber `aria-describedby` zugeordnet; die Ansicht setzt dafuer
 * dieselbe `id` am Eingabefeld und uebergibt sie hier.
 */
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  readonly id: string
  readonly label: ReactNode
  readonly hint?: string
  readonly error?: string
  readonly children: ReactNode
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint !== undefined && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  )
}

/** Die `aria-describedby`-Liste eines Feldes: nur die Teile, die es wirklich gibt. */
export function describedBy(id: string, hint: boolean, error: boolean): string | undefined {
  const parts = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(
    (part): part is string => part !== null,
  )
  return parts.length === 0 ? undefined : parts.join(' ')
}

/* --------------------------------------------------------------- Marken */

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'danger'

const BADGE_CLASSES: Readonly<Record<BadgeTone, string>> = {
  neutral: 'badge',
  accent: 'badge badge--accent',
  success: 'badge badge--success',
  danger: 'badge badge--danger',
}

/** Kurze Zustandsmarke: Rolle, Status, Zugang. Sie benennt, sie schaltet nichts. */
export function Badge({ tone = 'neutral', children }: { readonly tone?: BadgeTone; readonly children: ReactNode }) {
  return <span className={BADGE_CLASSES[tone]}>{children}</span>
}

/* ------------------------------------------------------------ Meldungen */

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

const NOTICE_ICONS: Readonly<Record<NoticeKind, LucideIcon>> = {
  error: AlertTriangle,
  info: Info,
  success: CheckCircle2,
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
  const Icon = NOTICE_ICONS[kind]
  return (
    <div className={NOTICE_CLASSES[kind]} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon className="notice__icon" size={18} aria-hidden="true" />
      <div className="notice__body">
        {text !== undefined && <p>{text}</p>}
        {children}
      </div>
    </div>
  )
}

/* -------------------------------------------------------- Ladezustaende */

/**
 * Ladeanzeige ohne bekannte Form.
 *
 * Immer mit Text und immer in einem Live-Bereich: wer nicht sieht, dass sich etwas dreht, soll hoeren, dass
 * etwas laedt. Wo die Form der Antwort schon feststeht, steht stattdessen ein Skeleton.
 */
export function Loading({ text }: { readonly text: string }) {
  return (
    <p className="loading" aria-live="polite">
      <Loader2 className="loading__spinner" size={16} aria-hidden="true" />
      {text}
    </p>
  )
}

/** Ein einzelner Platzhalterbalken. Seine Breite kommt aus der Umgebung, in der er steht. */
export function Skeleton() {
  return <span className="skeleton" />
}

/**
 * Layoutgetreuer Platzhalter fuer eine bekannte Tabelle.
 *
 * Er hat die Spalten und Zeilen des Ergebnisses; die Seite springt beim Eintreffen der Daten nicht.
 * Angekuendigt wird er einmal als Text, damit Hilfsmittel nicht die Balken vorlesen.
 */
export function TableSkeleton({
  columns,
  rows = 3,
  label,
}: {
  readonly columns: readonly string[]
  readonly rows?: number
  readonly label: string
}) {
  return (
    <div className="table-wrap" aria-busy="true">
      <p className="visually-hidden" aria-live="polite">
        {label}
      </p>
      <table className="table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody aria-hidden="true">
          {Array.from({ length: rows }, (_unused, row) => (
            <tr key={row}>
              {columns.map((column) => (
                <td key={column}>
                  <Skeleton />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* -------------------------------------------------------- Seitenzustand */

/**
 * Art eines Seitenzustands.
 *
 * Sie entscheidet Symbol und Ton - nicht der Text. Damit sieht "nichts vorhanden" ueberall gleich aus und
 * unterscheidet sich sichtbar von "keine Treffer", "nicht erlaubt" und "fehlgeschlagen".
 */
export type PageStateKind = 'empty' | 'no-results' | 'error' | 'forbidden' | 'not-found'

const PAGE_STATE_ICONS: Readonly<Record<PageStateKind, LucideIcon>> = {
  empty: Inbox,
  'no-results': SearchX,
  error: AlertTriangle,
  forbidden: Lock,
  'not-found': SearchX,
}

/** Gemeinsame Form fuer leer, keine Treffer, nicht erlaubt, nicht gefunden und fehlgeschlagen. */
export function PageState({
  kind,
  title,
  description,
  children,
}: {
  readonly kind: PageStateKind
  readonly title: string
  readonly description?: string
  /** Der naechste Schritt - erneut laden, anlegen, zurueck. Hoechstens eine Hauptaktion. */
  readonly children?: ReactNode
}) {
  const Icon = PAGE_STATE_ICONS[kind]
  return (
    <div
      className={kind === 'error' ? 'page-state page-state--error' : 'page-state'}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      <Icon className="page-state__icon" size={28} aria-hidden="true" />
      <h3>{title}</h3>
      {description !== undefined && <p>{description}</p>}
      {children !== undefined && <div className="page-state__actions">{children}</div>}
    </div>
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
 * Bestaetigung einer nicht folgenlosen Aktion **im Fluss der Seite**.
 *
 * Kein Fokuskaefig und keine eigene Escape-Behandlung: der Block bleibt in der Dokumentstruktur und behaelt
 * den Zusammenhang zu seiner Zeile. Wo eine Aktion die ganze Aufmerksamkeit verlangt, steht stattdessen
 * `Dialog` aus `overlays.tsx`. `danger` ist dem vorbehalten, was sich nicht zuruecknehmen laesst.
 */
export function ConfirmDialog({
  danger = false,
  children,
}: {
  readonly danger?: boolean
  readonly children: ReactNode
}) {
  return (
    <div className={danger ? 'confirm confirm--danger' : 'confirm'} role="alert">
      {children}
    </div>
  )
}
