/**
 * Versionsverlauf, Export und Import eines Boards.
 *
 * Ein Abschnitt im Fluss seiner Umgebung und kein eigener Dialog - dieselbe Entscheidung wie bei den
 * Freigaben: kein Fokuskaefig, keine eigene Escape-Behandlung, jede Ueberschrift bleibt in der
 * Dokumentstruktur. Der Abschnitt steht im Bereich "Versionen" der Board-Sidebar (`board-panel.tsx`).
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
import { Empty, Loading, Notice } from './ui.js'

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

function VersionRow({
  me,
  board,
  version,
  restorable,
  onPreview,
  onRestored,
  onConflict,
  onError,
}: {
  readonly me: MeResponse
  readonly board: BoardView
  readonly version: BoardSceneVersionView
  readonly restorable: boolean
  readonly onPreview: (version: number) => void
  readonly onRestored: (version: number) => void
  /** Der Stand hat sich unter der Ansicht geaendert; nichts wurde geschrieben. */
  readonly onConflict: () => void
  readonly onError: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const current = version.version === board.sceneVersion

  return (
    <tr>
      <th scope="row">
        Version {String(version.version)}
        {current && <> (aktueller Stand)</>}
      </th>
      <td>{formatMoment(version.createdAt)}</td>
      <td>{version.authorDisplayName ?? 'Gastzugang'}</td>
      <td>{String(version.elementCount)}</td>
      <td>{formatBytes(version.byteSize)}</td>
      <td>
        <span className="actions">
        <button
          type="button"
          onClick={() => {
            onPreview(version.version)
          }}
        >
          Version {String(version.version)} ansehen
        </button>
        {restorable && !current && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              onError('')
              // Der gezeigte Stand ist die Ausgangsversion. Weicht er ab, lehnt der Server ab und
              // schreibt nichts - die Bestaetigung ist dann ein zweiter Klick auf dem neuen Stand.
              restoreBoardVersion(me.csrfToken, {
                boardId: board.id,
                version: version.version,
                baseVersion: board.sceneVersion,
              })
                .then((response) => {
                  onRestored(response.version)
                })
                .catch((cause: unknown) => {
                  if (cause instanceof ApiError && cause.status === 409) {
                    onConflict()
                    return
                  }
                  onError(messageOf(cause, 'Die Version konnte nicht wiederhergestellt werden.'))
                })
                .finally(() => {
                  setBusy(false)
                })
            }}
          >
            Version {String(version.version)} wiederherstellen
          </button>
        )}
        </span>
      </td>
    </tr>
  )
}

type Loaded = {
  readonly board: BoardView
  readonly versions: readonly BoardSceneVersionView[]
  readonly retention: number
  readonly mayRestore: boolean
}

export function BoardVersions({
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
    return (
      <section aria-labelledby="board-versions-heading">
        <h5 id="board-versions-heading">Versionen</h5>
        <Loading text="Versionen werden geladen …" />
      </section>
    )
  }
  if (state.kind === 'failed') {
    return (
      <section aria-labelledby="board-versions-heading">
        <h5 id="board-versions-heading">Versionen</h5>
        <Notice text={state.message} />
      </section>
    )
  }

  const { board, versions, retention, mayRestore } = state.loaded
  /** Ein Import schreibt eine neue Szenenversion; er verlangt deshalb genau das Schreibrecht der Szene. */
  const importable = !workspaceArchived && board.status === 'active' && mayChangeBoard(viewerRoleOf(board))

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

  return (
    <section aria-labelledby="board-versions-heading">
      <h5 id="board-versions-heading">Versionen von {board.title}</h5>
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
            <button
              type="button"
              onClick={() => {
                setNote(null)
              }}
            >
              Hinweis ausblenden
            </button>
          </p>
        </Notice>
      )}

      <h6>Export</h6>
      <p>
        Der Export ist eine einzelne <code>.excalidraw</code>-Datei im offenen Format, mit allen Bildern des
        Boards darin. Sie laesst sich in jeder Excalidraw-Installation oeffnen und hier wieder importieren.
      </p>
      <p>
        <button
          type="button"
          disabled={busy}
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
        </button>
      </p>

      <h6>Import</h6>
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
              <button className="button--primary" type="submit" disabled={busy || chosen === null}>
                Datei importieren
              </button>
            </p>
          </form>
        </>
      )}

      <h6>Verlauf</h6>
      {versions.length === 0 ? (
        <Empty text="Zu diesem Board wurde noch nichts gespeichert. Sobald jemand zeichnet, entstehen hier Versionen." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Aufbewahrte Versionen von {board.title}</caption>
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Gespeichert</th>
                <th scope="col">Von</th>
                <th scope="col">Elemente</th>
                <th scope="col">Groesse</th>
                <th scope="col">Aktion</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <VersionRow
                  key={version.version}
                  me={me}
                  board={board}
                  version={version}
                  restorable={mayRestore && !workspaceArchived && board.status === 'active'}
                  onPreview={onPreview}
                  onRestored={(created) => {
                    setNote(
                      `Wiederhergestellt als Version ${String(created)}. ` +
                        'Der bisherige Stand bleibt als eigene Version erhalten.',
                    )
                    reload()
                  }}
                  onConflict={() => {
                    setNote(
                      'Dieses Board wurde inzwischen gespeichert. Es wurde nichts ueberschrieben, und die ' +
                        'Liste ist neu geladen. Ein erneuter Klick stellt auf dem jetzt angezeigten Stand wieder her.',
                    )
                    reload()
                  }}
                  onError={setActionError}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
