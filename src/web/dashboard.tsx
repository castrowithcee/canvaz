/**
 * Dashboard: der Einstieg nach der Anmeldung.
 *
 * Es zeigt die zuletzt geaenderten Boards **aller** Arbeitsbereiche, in denen der Anfragende Mitglied ist,
 * und legt ein neues Board ohne Umweg ueber die Arbeitsbereichsverwaltung an. Von jeder Zeile fuehrt ein
 * Klick in den Editor.
 *
 * **Gefiltert und sortiert wird serverseitig.** Diese Datei rechnet nichts aus: welche Boards zugaenglich
 * sind, entscheidet der Endpunkt, und die vier Filter sind Sichten auf genau diese Menge. Der aktive Filter
 * steht in der Adresse (siehe `router.tsx`) und ueberlebt damit ein Neuladen und ein Teilen des Links.
 *
 * Von einer externen Freigabe steht hier ausschliesslich, **dass** sie besteht - nie ein Token und nie eine
 * Adresse. Die Verwaltung von Freigaben gehoert nicht hierher.
 */

import { useCallback, useEffect, useState } from 'react'

import type { DashboardBoardView, DashboardFilterView, MeResponse, WorkspaceView } from '../contracts/api.js'
import { DASHBOARD_FILTERS } from '../contracts/api.js'
import { MAX_BOARD_TITLE_LENGTH } from '../domain/board/model.js'
import { ApiError, createBoard, fetchDashboard } from './api.js'
import { Link, navigate } from './router.js'

/** Beschriftung der vier Filter. Dieselbe Reihenfolge wie `DASHBOARD_FILTERS`. */
const FILTER_LABELS: Readonly<Record<DashboardFilterView, string>> = {
  owned: 'Meine Boards',
  'shared-by-me': 'Von mir geteilt',
  'shared-with-me': 'Mit mir geteilt',
  'shared-externally': 'Mit extern geteilt',
}

/** Woher der Zugriff auf diese Zeile stammt - in Worten, damit die Liste ohne Filter lesbar bleibt. */
const ORIGIN_LABELS: Readonly<Record<DashboardBoardView['accessOrigin'], string>> = {
  owner: 'Eigenes Board',
  grant: 'Mit mir geteilt',
  workspace: 'Ueber den Arbeitsbereich',
}

const ROLE_LABELS: Readonly<Record<DashboardBoardView['viewerRole'], string>> = {
  owner: 'Owner',
  editor: 'Editor',
  viewer: 'Viewer',
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback
}

/**
 * Die Freigabemarken einer Zeile. Sie nennen den Zustand und bieten keine Aenderung an - geteilt wird in der
 * Freigabeverwaltung des Boards.
 */
function ShareMarks({ board }: { readonly board: DashboardBoardView }) {
  const marks: string[] = []
  if (board.sharedInternally) {
    marks.push('intern freigegeben')
  }
  if (board.sharedExternally) {
    marks.push('extern freigegeben')
  }
  return marks.length === 0 ? null : <span className="hint"> · {marks.join(' · ')}</span>
}

export function Dashboard({
  me,
  workspaces,
  filter,
  onBoardsChanged,
}: {
  readonly me: MeResponse
  /** Alle sichtbaren Arbeitsbereiche - Grundlage der Zielauswahl beim Anlegen und des leeren Zustands. */
  readonly workspaces: readonly WorkspaceView[]
  readonly filter: DashboardFilterView | null
  /** Meldet ein neu angelegtes Board, damit die Seitenleiste der Huelle mitzieht. */
  readonly onBoardsChanged: () => void
}) {
  const [boards, setBoards] = useState<readonly DashboardBoardView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Der abgeschickte Suchbegriff. Gefiltert wird serverseitig, nicht im Browser. */
  const [query, setQuery] = useState('')
  const [term, setTerm] = useState('')
  const [title, setTitle] = useState('')
  const [targetId, setTargetId] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    fetchDashboard({ filter, query: term })
      .then((response) => {
        setBoards(response.boards)
      })
      .catch((cause: unknown) => {
        setBoards([])
        setError(messageOf(cause, 'Die Boards konnten nicht geladen werden.'))
      })
  }, [filter, term])

  useEffect(() => {
    setBoards(null)
    load()
  }, [load])

  // Ein Board anlegen darf jedes Mitglied eines aktiven Arbeitsbereichs; ein archivierter ist vollstaendig
  // unveraenderlich. Entschieden wird trotzdem am Endpunkt - die Auswahl ist Bequemlichkeit, keine Grenze.
  const targets = workspaces.filter((workspace) => workspace.status === 'active')
  const target = targets.find((workspace) => workspace.id === targetId) ?? targets[0] ?? null

  if (workspaces.length === 0) {
    return (
      <section aria-labelledby="dashboard">
        <h2 id="dashboard">Willkommen bei Canvaz</h2>
        <p>
          Du gehoerst noch keinem Arbeitsbereich an. Ein Board liegt immer in einem Arbeitsbereich - lege
          deshalb zuerst einen an, danach entsteht dein erstes Board hier.
        </p>
        <p>
          <Link className="button" route={{ kind: 'arbeitsbereiche' }}>
            Ersten Arbeitsbereich anlegen
          </Link>
        </p>
      </section>
    )
  }

  return (
    <section aria-labelledby="dashboard">
      <h2 id="dashboard">Zuletzt geaendert</h2>

      <nav className="dashboard__filters" aria-label="Sicht auf die Boardliste">
        <Link route={{ kind: 'einstieg', filter: null }} current={filter === null}>
          Alle Boards
        </Link>
        {DASHBOARD_FILTERS.map((candidate) => (
          <Link key={candidate} route={{ kind: 'einstieg', filter: candidate }} current={filter === candidate}>
            {FILTER_LABELS[candidate]}
          </Link>
        ))}
      </nav>

      <form
        className="field"
        onSubmit={(event) => {
          event.preventDefault()
          setTerm(query.trim())
        }}
      >
        <label htmlFor="dashboard-search">Boards nach Titel suchen</label>
        <input
          id="dashboard-search"
          type="search"
          value={query}
          maxLength={MAX_BOARD_TITLE_LENGTH}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
        />
        <p>
          <button type="submit">Liste filtern</button>{' '}
          {term !== '' && (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                setTerm('')
              }}
            >
              Suche aufheben
            </button>
          )}
        </p>
      </form>

      {error !== null && (
        <p className="notice notice--error" role="alert">
          {error}{' '}
          <button type="button" onClick={load}>
            Erneut laden
          </button>
        </p>
      )}

      {boards === null && <p aria-live="polite">Boards werden geladen …</p>}
      {boards !== null && boards.length === 0 && error === null && (
        <p>
          {term !== ''
            ? `Kein Board mit "${term}" im Titel.`
            : filter === null
              ? 'In deinen Arbeitsbereichen gibt es noch kein Board. Lege das erste an.'
              : `Kein Board unter "${FILTER_LABELS[filter]}".`}
        </p>
      )}
      {boards !== null && boards.length > 0 && (
        <table className="users">
          <caption className="visually-hidden">
            Zuletzt geaenderte Boards{filter === null ? '' : `, gefiltert nach "${FILTER_LABELS[filter]}"`}
          </caption>
          <thead>
            <tr>
              <th scope="col">Titel</th>
              <th scope="col">Arbeitsbereich</th>
              <th scope="col">Zugriff</th>
              <th scope="col">Meine Rolle</th>
              <th scope="col">Geaendert</th>
            </tr>
          </thead>
          <tbody>
            {boards.map((board) => (
              <tr key={board.id}>
                <td>
                  <Link
                    route={{
                      kind: 'board',
                      workspaceId: board.workspaceId,
                      boardId: board.id,
                      version: null,
                    }}
                  >
                    {board.title}
                  </Link>
                </td>
                <td>{board.workspaceName}</td>
                <td>
                  {ORIGIN_LABELS[board.accessOrigin]}
                  <ShareMarks board={board} />
                </td>
                <td>{ROLE_LABELS[board.viewerRole]}</td>
                <td>{new Date(board.updatedAt).toLocaleString('de-DE')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {target !== null && (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault()
            setCreating(true)
            setCreateError(null)
            // Das Dashboard legt flach an: es kennt keinen gewaehlten Ordner. Das Board landet unmittelbar
            // im Arbeitsbereich und laesst sich dort einsortieren.
            createBoard(me.csrfToken, target.id, title, null)
              .then((board) => {
                setTitle('')
                onBoardsChanged()
                // Direkt in den Editor: das Anlegen endet dort, wo gearbeitet wird, und nicht in einer Liste.
                navigate({ kind: 'board', workspaceId: board.workspaceId, boardId: board.id, version: null })
              })
              .catch((cause: unknown) => {
                setCreateError(messageOf(cause, 'Das Board konnte nicht angelegt werden.'))
              })
              .finally(() => {
                setCreating(false)
              })
          }}
        >
          <div className="field">
            <label htmlFor="dashboard-title">Titel des neuen Boards</label>
            <input
              id="dashboard-title"
              value={title}
              maxLength={MAX_BOARD_TITLE_LENGTH}
              required
              onChange={(event) => {
                setTitle(event.target.value)
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="dashboard-workspace">Arbeitsbereich</label>
            <select
              id="dashboard-workspace"
              value={target.id}
              onChange={(event) => {
                setTargetId(event.target.value)
              }}
            >
              {targets.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </div>
          <p>
            <button type="submit" disabled={creating || title.trim().length === 0}>
              Board anlegen und oeffnen
            </button>
          </p>
          {createError !== null && (
            <p className="notice notice--error" role="alert">
              {createError}
            </p>
          )}
        </form>
      )}
      {target === null && (
        <p className="hint">
          Alle deine Arbeitsbereiche sind archiviert; darin entsteht kein neues Board.{' '}
          <Link route={{ kind: 'arbeitsbereiche' }}>Arbeitsbereiche verwalten</Link>
        </p>
      )}
    </section>
  )
}
