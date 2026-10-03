/**
 * Versionsverlauf, Export und Import eines Boards - als eigenes Overlay.
 *
 * Kein Abschnitt der Informationsleiste mehr: der Verlauf ist breiter, als es dort schmal neben der
 * Zeichenflaeche Platz haette, und braucht dafuer keinen zweiten Ort. Ausgeloest wird er ueber ein
 * benanntes Symbol der schwebenden Gruppe (`board/board-view.tsx`); geoeffnet und geschlossen wird er wie
 * jeder andere Dialog dieser Anwendung - Fokusfang, `Escape` und Fokusrueckgabe kommen von der Plattform
 * (`overlays.tsx`).
 *
 * Die Liste selbst bleibt kompakt: eine Zeile je Version, das senkrechte Drei-Punkte-Menue traegt "Ansehen"
 * und - nur mit dem Recht - "Wiederherstellen". Export, Import, aktueller Stand und Aufbewahrungsgrenze
 * gehoeren fachlich zum selben Verlauf und stehen deshalb im selben Overlay.
 *
 * Die Ansicht entscheidet nichts. Ob wiederhergestellt werden darf, sagt die Serverantwort (`mayRestore`);
 * ob importiert werden darf, sagt die Rolle des Boards ueber `mayChangeBoard` - dieselbe Funktion, mit der
 * der Server entscheidet. Jede Ablehnung erscheint als Text, statt dass eine Schaltflaeche verschwindet.
 *
 * ## Der Konfliktschutz ist sichtbar
 *
 * Eine Wiederherstellung nennt immer den Stand, den diese Ansicht gerade zeigt. Hat inzwischen jemand
 * anderes gespeichert, antwortet der Server mit 409 und schreibt **nichts**; die Liste laedt dann neu und
 * benennt genau das. Erst der naechste, bewusste Klick auf dem frisch geladenen Stand ist die Bestaetigung -
 * ein unerkannt neuerer Stand wird damit nie ueberschrieben.
 */

import { useCallback, useEffect, useState } from 'react'
import { EllipsisVertical, Eye, RotateCcw } from 'lucide-react'

import type { BoardSceneVersionView, BoardView, MeResponse } from '../contracts/api.js'
import type { EffectiveBoardRole } from '../domain/board/policy.js'
import { mayChangeBoard } from '../domain/board/policy.js'
import {
  ApiError,
  fetchBoardExport,
  fetchBoardVersions,
  importBoardScene,
  restoreBoardVersion,
} from './api.js'
import { Dialog, Menu, MenuItem } from './overlays.js'
import { Badge, Button, Empty, Loading, Notice, useRowSelection } from './ui.js'

/** Uebersetzt eine Serverantwort in einen Satz. 404 und 403 bekommen bewusst eigene Texte. */
function messageOf(cause: unknown, fallback: string): string {
  if (!(cause instanceof ApiError)) {
    return fallback
  }
  if (cause.status === 404) {
    return 'Dieses Board ist nicht (mehr) fuer dich freigegeben oder existiert nicht.'
  }
  if (cause.status === 403) {
    return `Dafuer fehlt dir die Berechtigung. ${cause.message}`
  }
  return cause.message
}

function viewerRoleOf(board: BoardView): EffectiveBoardRole {
  return { kind: 'member', role: board.viewerRole }
}

function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString('de-DE')
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${(bytes / 1024).toFixed(1)} KiB`
}

/** Dateiname des Exports. Nur harmlose Zeichen: er landet im Downloadordner des Empfaengers. */
function exportFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug === '' ? 'board' : slug}.excalidraw`
}

/**
 * Reicht die Datei an den Browser.
 *
 * Ein `blob:`-Verweis und ein Klick auf einen `download`-Anker: die Bytes entstehen im Browser aus der
 * bereits autorisierten Antwort, es gibt also keine zweite, oeffentliche Adresse fuer denselben Inhalt.
 */
function offerDownload(fileName: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * Welche Zeilenhandlungen eine Version traegt.
 *
 * Reine Rechnung ohne Zustand: "Ansehen" gibt es immer, "Wiederherstellen" nur mit dem Recht dazu und nie
 * auf den aktuellen Stand selbst - eine Wiederherstellung auf sich selbst waere ohne Wirkung.
 */
export function versionRowActions(
  current: boolean,
  restorable: boolean,
): { readonly view: true; readonly restore: boolean } {
  return { view: true, restore: restorable && !current }
}

type RowSelection = ReturnType<ReturnType<typeof useRowSelection>>

function VersionRow({
  version,
  current,
  restorable,
  selection,
  onPreview,
  onRequestRestore,
}: {
  readonly version: BoardSceneVersionView
  readonly current: boolean
  readonly restorable: boolean
  readonly selection: RowSelection
  readonly onPreview: (version: number) => void
  readonly onRequestRestore: (version: number) => void
}) {
  const actions = versionRowActions(current, restorable)
  const label = `Version ${String(version.version)}`

  return (
    <li className={`${selection.className} version-row`} onClick={selection.onClick}>
      <span className="row__label">
        {label}
        {current && <Badge tone="accent">Aktueller Stand</Badge>}
      </span>
      <span className="version-row__meta">
        <span>{formatMoment(version.createdAt)}</span>
        <span>{version.authorDisplayName ?? 'Gastzugang'}</span>
        <span>{String(version.elementCount)} Elemente</span>
        <span>{formatBytes(version.byteSize)}</span>
      </span>
      <span className="row__actions">
        <Menu label={`Aktionen fuer ${label}`} icon={EllipsisVertical} variant="quiet">
          <MenuItem icon={Eye} title={`${label} im Nur-Lesen-Modus ansehen`} onSelect={() => { onPreview(version.version) }}>
            Ansehen
          </MenuItem>
          {actions.restore && (
            <MenuItem
              icon={RotateCcw}
              title={`${label} als neuen Stand wiederherstellen`}
              onSelect={() => {
                onRequestRestore(version.version)
              }}
            >
              Wiederherstellen
            </MenuItem>
          )}
        </Menu>
      </span>
    </li>
  )
}

type Loaded = {
  readonly board: BoardView
  readonly versions: readonly BoardSceneVersionView[]
  readonly retention: number
  readonly mayRestore: boolean
}

function BoardVersionsContent({
  me,
  boardId,
  workspaceArchived,
  onPreview,
  onChanged,
}: {
  readonly me: MeResponse
  readonly boardId: string
  /** Ein archivierter Arbeitsbereich ist vollstaendig unveraenderlich - unabhaengig von jeder Boardrolle. */
  readonly workspaceArchived: boolean
  /** Oeffnet die Read-only-Vorschau genau einer Version. */
  readonly onPreview: (version: number) => void
  readonly onChanged: () => void
}) {
  const [state, setState] = useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly loaded: Loaded }
    | { readonly kind: 'failed'; readonly message: string }
  >({ kind: 'loading' })
  const [actionError, setActionError] = useState<string | null>(null)
  /** Rueckmeldung ueber eine gelungene Wiederherstellung, einen Import oder einen erkannten Konflikt. */
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [chosen, setChosen] = useState<File | null>(null)
  /** Version, deren Wiederherstellung gerade bestaetigt wird; `null` heisst: keine Bestaetigung offen. */
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null)
  const [restoreBusy, setRestoreBusy] = useState(false)
  const rowSelection = useRowSelection()

  const load = useCallback(() => {
    fetchBoardVersions(boardId)
      .then((response) => {
        setState({
          kind: 'ready',
          loaded: {
            board: response.board,
            versions: response.versions,
            retention: response.retention,
            mayRestore: response.mayRestore,
          },
        })
      })
      .catch((cause: unknown) => {
        setState({ kind: 'failed', message: messageOf(cause, 'Die Versionen konnten nicht geladen werden.') })
      })
  }, [boardId])

  useEffect(load, [load])

  function reload(): void {
    load()
    onChanged()
  }

  if (state.kind === 'loading') {
    return <Loading text="Versionen werden geladen …" />
  }
  if (state.kind === 'failed') {
    return <Notice text={state.message} />
  }

  const { board, versions, retention, mayRestore } = state.loaded
  /** Ein Import schreibt eine neue Szenenversion; er verlangt deshalb genau das Schreibrecht der Szene. */
  const importable = !workspaceArchived && board.status === 'active' && mayChangeBoard(viewerRoleOf(board))
  const restorable = mayRestore && !workspaceArchived && board.status === 'active'

  function importChosenFile(file: File): void {
    setBusy(true)
    setActionError(null)
    setNote(null)
    file
      .text()
      .then((text) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          throw new ApiError(0, 'Die Datei enthaelt kein gueltiges JSON.')
        }
        return importBoardScene(me.csrfToken, { boardId, baseVersion: board.sceneVersion, file: parsed })
      })
      .then((response) => {
        setChosen(null)
        setNote(
          `Import uebernommen als Version ${String(response.version)}: ` +
            `${String(response.importedElements)} Elemente, ${String(response.importedFiles)} Bilder. ` +
            'Der bisherige Stand bleibt als eigene Version erhalten.',
        )
        reload()
      })
      .catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.status === 409) {
          setNote(
            'Dieses Board wurde inzwischen gespeichert. Es wurde nichts uebernommen, und die Liste ist ' +
              'neu geladen. Ein erneuter Import ersetzt den jetzt angezeigten Stand.',
          )
          reload()
          return
        }
        setActionError(messageOf(cause, 'Die Datei konnte nicht importiert werden.'))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  function confirmRestore(): void {
    if (restoreTarget === null) {
      return
    }
    setRestoreBusy(true)
    setActionError(null)
    // Der gezeigte Stand ist die Ausgangsversion. Weicht er ab, lehnt der Server ab und schreibt nichts -
    // die Bestaetigung ist dann ein zweiter Klick auf dem neuen Stand.
    restoreBoardVersion(me.csrfToken, { boardId, version: restoreTarget, baseVersion: board.sceneVersion })
      .then((response) => {
        setRestoreTarget(null)
        setNote(
          `Wiederhergestellt als Version ${String(response.version)}. ` +
            'Der bisherige Stand bleibt als eigene Version erhalten.',
        )
        reload()
      })
      .catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.status === 409) {
          setRestoreTarget(null)
          setNote(
            'Dieses Board wurde inzwischen gespeichert. Es wurde nichts ueberschrieben, und die Liste ist ' +
              'neu geladen. Ein erneuter Klick stellt auf dem jetzt angezeigten Stand wieder her.',
          )
          reload()
          return
        }
        setActionError(messageOf(cause, 'Die Version konnte nicht wiederhergestellt werden.'))
      })
      .finally(() => {
        setRestoreBusy(false)
      })
  }

  return (
    <div className="stack">
      <p>
        Aktueller Stand:{' '}
        <strong>{board.sceneVersion === 0 ? 'noch nie gespeichert' : `Version ${String(board.sceneVersion)}`}</strong>.
        Aufbewahrt werden die juengsten {String(retention)} Versionen; aeltere fallen bei der naechsten
        Speicherung heraus.
      </p>
      {!mayRestore && (
        <p className="hint">
          Wiederherstellen kann der Owner dieses Boards sowie die Verwaltung des Arbeitsbereichs. Ansehen und
          exportieren darfst du jede aufbewahrte Version.
        </p>
      )}
      {actionError !== null && actionError !== '' && <Notice text={actionError} />}
      {note !== null && (
        <Notice kind="success">
          <p>{note}</p>
          <p className="actions">
            <Button
              onClick={() => {
                setNote(null)
              }}
            >
              Hinweis ausblenden
            </Button>
          </p>
        </Notice>
      )}

      <h3>Verlauf</h3>
      {versions.length === 0 ? (
        <Empty text="Zu diesem Board wurde noch nichts gespeichert. Sobald jemand zeichnet, entstehen hier Versionen." />
      ) : (
        <ul className="rows">
          {versions.map((version) => (
            <VersionRow
              key={version.version}
              version={version}
              current={version.version === board.sceneVersion}
              restorable={restorable}
              selection={rowSelection(String(version.version))}
              onPreview={onPreview}
              onRequestRestore={setRestoreTarget}
            />
          ))}
        </ul>
      )}

      <h3>Export</h3>
      <p>
        Der Export ist eine einzelne <code>.excalidraw</code>-Datei im offenen Format, mit allen Bildern des
        Boards darin. Sie laesst sich in jeder Excalidraw-Installation oeffnen und hier wieder importieren.
      </p>
      <p>
        <Button
          busy={busy}
          onClick={() => {
            setBusy(true)
            setActionError(null)
            fetchBoardExport(boardId)
              .then((file) => {
                offerDownload(exportFileName(board.title), JSON.stringify(file))
              })
              .catch((cause: unknown) => {
                setActionError(messageOf(cause, 'Der Export ist fehlgeschlagen.'))
              })
              .finally(() => {
                setBusy(false)
              })
          }}
        >
          {board.title} als .excalidraw-Datei exportieren
        </Button>
      </p>

      <h3>Import</h3>
      {!importable ? (
        <Empty text="Importieren darf, wer die Szene dieses Boards speichern darf - in einem aktiven Arbeitsbereich und einem nicht archivierten Board." />
      ) : (
        <>
          <p>
            Ein Import ersetzt den Inhalt dieses Boards durch den der Datei. Er legt dafuer eine{' '}
            <strong>neue Version</strong> an: der bisherige Stand bleibt in der Liste unten stehen und laesst
            sich jederzeit wiederherstellen.
          </p>
          <form
            className="stack card"
            onSubmit={(event) => {
              event.preventDefault()
              if (chosen !== null) {
                importChosenFile(chosen)
              }
            }}
          >
            <div className="field">
              <label htmlFor="board-import-file">Excalidraw-Datei</label>
              <input
                id="board-import-file"
                type="file"
                accept=".excalidraw,application/json"
                onChange={(event) => {
                  setChosen(event.target.files?.[0] ?? null)
                  setActionError(null)
                }}
              />
            </div>
            <p>
              <Button variant="primary" type="submit" disabled={busy || chosen === null}>
                Datei importieren
              </Button>
            </p>
          </form>
        </>
      )}

      <Dialog
        open={restoreTarget !== null}
        title={restoreTarget === null ? 'Version wiederherstellen' : `Version ${String(restoreTarget)} wiederherstellen`}
        onClose={() => {
          setRestoreTarget(null)
        }}
      >
        {restoreTarget !== null && (
          <div className="stack">
            <p>
              Version {String(restoreTarget)} wird als <strong>neue Version</strong> wiederhergestellt. Der
              aktuelle Stand ({board.sceneVersion === 0 ? 'noch nie gespeichert' : `Version ${String(board.sceneVersion)}`})
              bleibt dabei als eigene Version in der Historie erhalten und laesst sich jederzeit selbst wieder
              herstellen.
            </p>
            <p className="actions">
              <Button variant="primary" busy={restoreBusy} onClick={confirmRestore}>
                Ja, Version {String(restoreTarget)} wiederherstellen
              </Button>
              <Button
                disabled={restoreBusy}
                onClick={() => {
                  setRestoreTarget(null)
                }}
              >
                Abbrechen
              </Button>
            </p>
          </div>
        )}
      </Dialog>
    </div>
  )
}

export function BoardVersionsOverlay({
  me,
  boardId,
  boardTitle,
  workspaceArchived,
  open,
  onPreview,
  onChanged,
  onClose,
}: {
  readonly me: MeResponse
  readonly boardId: string
  /** Titel der Kopfzeile - der Editor kennt ihn bereits, ein eigener Ladevorgang dafuer waere doppelt. */
  readonly boardTitle: string
  readonly workspaceArchived: boolean
  readonly open: boolean
  /** Oeffnet die Read-only-Vorschau genau einer Version. */
  readonly onPreview: (version: number) => void
  readonly onChanged: () => void
  readonly onClose: () => void
}) {
  return (
    <Dialog open={open} title={`Versionsverlauf von ${boardTitle}`} wide onClose={onClose}>
      {/* Frischer Ladevorgang bei jedem Oeffnen statt eines Stands, der waehrend der Schliesszeit veraltet. */}
      {open && (
        <BoardVersionsContent
          me={me}
          boardId={boardId}
          workspaceArchived={workspaceArchived}
          onPreview={onPreview}
          onChanged={onChanged}
        />
      )}
    </Dialog>
  )
}
