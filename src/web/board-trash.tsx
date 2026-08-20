/**
 * Papierkorb genau eines Arbeitsbereichs.
 *
 * Die Liste ist **serverseitig gefiltert**: sie enthaelt ausschliesslich Boards, die der Anfragende auch
 * zuruecknehmen und endgueltig entfernen darf. Diese Datei siebt nichts nach und leitet keine Berechtigung
 * ab; sie zeigt, was der Endpunkt liefert, und jede Ablehnung als Text.
 *
 * Eine Zeile fuehrt bewusst **nicht** in den Editor: ein Board im Papierkorb ist fachlich nicht vorhanden.
 *
 * Zuruecknehmen und endgueltiges Entfernen nehmen dieselbe Auswahl - ein Board ist die Auswahl mit einem.
 * Die Antwort ist immer 200 und nennt je Kennung ein eigenes Ergebnis; genau diese Teilergebnisse zeigt die
 * Ansicht, statt aus einem Gesamtstatus etwas abzuleiten, das der Server nicht gesagt hat.
 */

import { useCallback, useEffect, useState } from 'react'

import type { BoardTrashEntryView, MeResponse, TrashActionResultView, WorkspaceView } from '../contracts/api.js'
import { ApiError, fetchBoardTrash, purgeBoardsFromTrash, restoreBoardsFromTrash } from './api.js'
import { Link } from './router.js'
import { ConfirmDialog, Empty, Loading, Notice } from './ui.js'

function messageOf(cause: unknown, fallback: string): string {
  if (!(cause instanceof ApiError)) {
    return fallback
  }
  if (cause.status === 403) {
    return `Dafuer fehlt dir die Berechtigung. ${cause.message}`
  }
  return cause.message
}

/** Verbleibende Frist als Satz. Angefangene Tage zaehlen mit - abgelaufen ist erst, was wirklich vorbei ist. */
function remainingText(purgeAt: string, now: number): string {
  const remaining = Date.parse(purgeAt) - now
  if (Number.isNaN(remaining)) {
    return 'unbekannt'
  }
  if (remaining <= 0) {
    return 'Frist abgelaufen'
  }
  const days = Math.ceil(remaining / 86_400_000)
  return days === 1 ? 'noch weniger als ein Tag' : `noch ${String(days)} Tage`
}

type Ergebnis = {
  readonly kind: 'restore' | 'purge'
  readonly entries: readonly (TrashActionResultView & { readonly title: string })[]
}

export function BoardTrash({
  me,
  workspace,
  onChanged,
}: {
  readonly me: MeResponse
  readonly workspace: WorkspaceView
  /** Meldet der Huelle, dass sich an den Boards etwas geaendert hat. */
  readonly onChanged: () => void
}) {
  const [state, setState] = useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly boards: readonly BoardTrashEntryView[]; readonly retentionDays: number }
    | { readonly kind: 'failed'; readonly message: string }
  >({ kind: 'loading' })
  const [selected, setSelected] = useState<readonly string[]>([])
  /** Gesetzt heisst: das endgueltige Loeschen dieser Auswahl wartet auf die gesonderte Bestaetigung. */
  const [confirming, setConfirming] = useState<readonly string[] | null>(null)
  const [results, setResults] = useState<Ergebnis | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const workspaceId = workspace.id

  const load = useCallback(() => {
    fetchBoardTrash(workspaceId)
      .then((response) => {
        setState({ kind: 'ready', boards: response.boards, retentionDays: response.retentionDays })
      })
      .catch((cause: unknown) => {
        setState({ kind: 'failed', message: messageOf(cause, 'Der Papierkorb konnte nicht geladen werden.') })
      })
  }, [workspaceId])

  useEffect(load, [load])

  if (state.kind === 'loading') {
    return (
      <section aria-labelledby="papierkorb-heading">
        <h2 id="papierkorb-heading">Papierkorb</h2>
        <Loading text="Der Papierkorb wird geladen …" />
      </section>
    )
  }
  if (state.kind === 'failed') {
    return (
      <section aria-labelledby="papierkorb-heading">
        <h2 id="papierkorb-heading">Papierkorb</h2>
        <Notice text={state.message} />
      </section>
    )
  }

  const { boards, retentionDays } = state
  const now = Date.now()
  const titleOf = (boardId: string): string =>
    boards.find((entry) => entry.id === boardId)?.title ?? 'Dieses Board'

  function run(kind: 'restore' | 'purge', boardIds: readonly string[]): void {
    setBusy(true)
    setActionError(null)
    const titles = boardIds.map((boardId) => titleOf(boardId))
    const call =
      kind === 'restore'
        ? restoreBoardsFromTrash(me.csrfToken, boardIds)
        : purgeBoardsFromTrash(me.csrfToken, boardIds)
    call
      .then((response) => {
        setResults({
          kind,
          entries: response.results.map((result, index) => ({
            ...result,
            title: titles[index] ?? titleOf(result.boardId),
          })),
        })
        setSelected([])
        setConfirming(null)
        load()
        onChanged()
      })
      .catch((cause: unknown) => {
        setActionError(
          messageOf(
            cause,
            kind === 'restore'
              ? 'Die Auswahl konnte nicht wiederhergestellt werden.'
              : 'Die Auswahl konnte nicht endgueltig geloescht werden.',
          ),
        )
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <section aria-labelledby="papierkorb-heading">
      <h2 id="papierkorb-heading">Papierkorb von {workspace.name}</h2>
      <p>
        Ein geloeschtes Board bleibt {String(retentionDays)} Tage hier und ist in dieser Zeit
        wiederherzustellen. Danach entfernt die Instanz es ohne Zutun endgueltig.
      </p>
      <p>
        <Link route={{ kind: 'arbeitsbereich', workspaceId, folder: null }}>Zur Boardliste</Link>
      </p>

      {actionError !== null && <Notice text={actionError} />}

      {results !== null && (
        <Notice kind="success">
          <p>{results.kind === 'restore' ? 'Wiederhergestellt:' : 'Endgueltig geloescht:'}</p>
          <ul className="list list--bullets">
            {results.entries.map((entry) => (
              <li key={entry.boardId}>
                {entry.title}: {entry.ok ? 'erledigt' : (entry.error ?? 'fehlgeschlagen')}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      {boards.length === 0 && <Empty text="Der Papierkorb dieses Arbeitsbereichs ist leer." />}

      {boards.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Geloeschte Boards in {workspace.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Auswahl</th>
                  <th scope="col">Titel</th>
                  <th scope="col">Urspruenglicher Ordner</th>
                  <th scope="col">Geloescht von</th>
                  <th scope="col">Geloescht am</th>
                  <th scope="col">Frist</th>
                  <th scope="col">Aktion</th>
                </tr>
              </thead>
              <tbody>
                {boards.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <input
                        type="checkbox"
                        id={`trash-select-${entry.id}`}
                        checked={selected.includes(entry.id)}
                        onChange={(event) => {
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, entry.id]
                              : current.filter((id) => id !== entry.id),
                          )
                          setConfirming(null)
                        }}
                      />
                      <label className="visually-hidden" htmlFor={`trash-select-${entry.id}`}>
                        {entry.title} auswaehlen
                      </label>
                    </td>
                    <td>
                      {entry.title}
                      {entry.status === 'archived' && ' (archiviert)'}
                    </td>
                    <td>{entry.folderName ?? 'Arbeitsbereich (kein Ordner)'}</td>
                    <td>{entry.deletedByDisplayName ?? 'Konto entfernt'}</td>
                    <td>{new Date(entry.deletedAt).toLocaleString('de-DE')}</td>
                    <td>{remainingText(entry.purgeAt, now)}</td>
                    <td>
                      <span className="actions">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            run('restore', [entry.id])
                          }}
                        >
                          {entry.title} wiederherstellen
                        </button>
                        <button
                          className="button--danger"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setActionError(null)
                            setConfirming([entry.id])
                          }}
                        >
                          {entry.title} endgueltig loeschen
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h5>Auswahl</h5>
          <p className="actions">
            <button
              type="button"
              disabled={busy || selected.length === 0}
              onClick={() => {
                run('restore', selected)
              }}
            >
              Auswahl wiederherstellen ({String(selected.length)})
            </button>
            <button
              className="button--danger"
              type="button"
              disabled={busy || selected.length === 0}
              onClick={() => {
                setActionError(null)
                setConfirming(selected)
              }}
            >
              Auswahl endgueltig loeschen ({String(selected.length)})
            </button>
          </p>
        </>
      )}

      {/* Das endgueltige Loeschen ist nicht rueckgaengig zu machen und bekommt deshalb eine eigene,
          deutlichere Bestaetigung als das Loeschen in den Papierkorb. */}
      {confirming !== null && confirming.length > 0 && (
        <ConfirmDialog danger>
          <p>
            <strong>
              {confirming.length === 1
                ? `${titleOf(confirming[0] ?? '')} endgueltig loeschen?`
                : `${String(confirming.length)} Boards endgueltig loeschen?`}
            </strong>
          </p>
          <p>
            Szenen, Versionen, Bilder, Freigaben und Gastlinks werden dabei vollstaendig entfernt. Das ist
            <strong> nicht rueckgaengig zu machen</strong> und auch nicht mehr wiederherzustellen.
          </p>
          <ul className="list list--bullets">
            {confirming.map((boardId) => (
              <li key={boardId}>{titleOf(boardId)}</li>
            ))}
          </ul>
          <p className="actions">
            <button
              className="button--danger"
              type="button"
              disabled={busy}
              onClick={() => {
                run('purge', confirming)
              }}
            >
              Ja, endgueltig loeschen
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(null)
              }}
            >
              Endgueltiges Loeschen abbrechen
            </button>
          </p>
        </ConfirmDialog>
      )}
    </section>
  )
}
