/**
 * Anwendungshuelle der SPA.
 *
 * Drei Zustaende: laedt, nicht angemeldet, angemeldet. Die Oberflaeche blendet nichts als Sicherheitsgrenze
 * aus - jede geschuetzte Antwort kommt bereits serverseitig geprueft. Bewusst ohne UI-Framework: das Paket
 * braucht eine Anmeldeseite, eine Huelle und eine Nutzerliste.
 *
 * Daneben steht **genau eine** weitere Route: die Gastansicht unter `GUEST_APP_PATH`. Sie wird vor jedem
 * Sitzungszustand entschieden, damit ein Gast nicht erst eine Anmeldung angeboten bekommt und die Huelle mit
 * Arbeitsbereichen, Mitgliedern und Boards fuer ihn gar nicht erst entsteht. Einen Router braucht es dafuer
 * nicht: es sind zwei Adressen, und der Anwendungsserver liefert fuer beide dieselbe `index.html`.
 */

import { Suspense, useCallback, useEffect, useState } from 'react'

import type { BoardView, LoginErrorCode, MeResponse, UserView, WorkspaceView } from '../contracts/api.js'
import { AUTH_LOGIN_PATH, GUEST_APP_PATH, LOGIN_ERROR_PARAM } from '../contracts/api.js'
import { ApiError, fetchAdminUsers, fetchMe, logout, setUserStatus } from './api.js'
import { BoardEditor } from './board/lazy-editor.js'
import { GuestApp } from './guest.js'
import { Workspaces } from './workspaces.js'

const LOGIN_ERROR_TEXTS: Readonly<Record<LoginErrorCode, string>> = {
  abgebrochen: 'Die Anmeldung wurde beim Identity Provider abgebrochen.',
  'provider-fehler': 'Der Identity Provider war nicht erreichbar. Bitte spaeter erneut versuchen.',
  'flow-abgelaufen': 'Die Anmeldung hat zu lange gedauert und wurde verworfen. Bitte neu beginnen.',
  'ungueltige-antwort': 'Die Antwort des Identity Providers war nicht gueltig. Bitte neu anmelden.',
  'code-ungueltig': 'Der Anmeldecode war abgelaufen oder bereits verbraucht. Bitte neu anmelden.',
  'nutzer-deaktiviert': 'Dieses Konto ist deaktiviert. Bitte an die Systemadministration wenden.',
  unbekannt: 'Die Anmeldung ist unerwartet fehlgeschlagen. Bitte erneut versuchen.',
}

function readLoginError(): string | null {
  const code = new URLSearchParams(window.location.search).get(LOGIN_ERROR_PARAM)
  if (code === null) {
    return null
  }
  return LOGIN_ERROR_TEXTS[code as LoginErrorCode] ?? LOGIN_ERROR_TEXTS.unbekannt
}

function clearLoginError(): void {
  const url = new URL(window.location.href)
  url.searchParams.delete(LOGIN_ERROR_PARAM)
  window.history.replaceState(null, '', url.pathname + url.search)
}

function LoginView({ error }: { readonly error: string | null }) {
  return (
    <main className="shell">
      <h1>Canvaz</h1>
      <p>Die Anmeldung laeuft ueber den Identity Provider dieser Instanz.</p>
      {error !== null && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      <p>
        <a className="button" href={AUTH_LOGIN_PATH}>
          {error === null ? 'Mit Identity Provider anmelden' : 'Anmeldung erneut versuchen'}
        </a>
      </p>
    </main>
  )
}

function statusLabel(status: UserView['status']): string {
  return status === 'active' ? 'aktiv' : 'deaktiviert'
}

function AdminUsers({ me }: { readonly me: MeResponse }) {
  const [users, setUsers] = useState<readonly UserView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    fetchAdminUsers()
      .then((response) => {
        setUsers(response.users)
      })
      .catch((cause: unknown) => {
        setUsers([])
        setError(cause instanceof ApiError ? cause.message : 'Die Nutzerliste konnte nicht geladen werden.')
      })
  }, [])

  useEffect(load, [load])

  function toggle(user: UserView): void {
    setPendingId(user.id)
    setError(null)
    setUserStatus(me.csrfToken, { userId: user.id, status: user.status === 'active' ? 'deactivated' : 'active' })
      .then((updated) => {
        setUsers((current) => current?.map((entry) => (entry.id === updated.id ? updated : entry)) ?? null)
      })
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : 'Die Aenderung konnte nicht gespeichert werden.')
      })
      .finally(() => {
        setPendingId(null)
      })
  }

  return (
    <section aria-labelledby="admin-heading">
      <h2 id="admin-heading">Systemadministration</h2>
      {error !== null && (
        <p className="notice notice--error" role="alert">
          {error} <button type="button" onClick={load}>Erneut laden</button>
        </p>
      )}
      {users === null && <p aria-live="polite">Nutzer werden geladen …</p>}
      {users !== null && users.length === 0 && error === null && <p>Es gibt noch keine Nutzer.</p>}
      {users !== null && users.length > 0 && (
        <table className="users">
          <caption className="visually-hidden">Alle Nutzer dieser Instanz</caption>
          <thead>
            <tr>
              <th scope="col">Anzeigename</th>
              <th scope="col">E-Mail</th>
              <th scope="col">Status</th>
              <th scope="col">Rolle</th>
              <th scope="col">Angelegt</th>
              <th scope="col">Aktion</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isSelf = user.id === me.user.id
              const activate = user.status !== 'active'
              // Ein gesperrter Knopf ist nicht fokussierbar, ein `title` daran wuerde nie vorgelesen. Die
              // Begruendung steht deshalb als Text daneben und ist dem Knopf zugeordnet.
              const reasonId = isSelf && !activate ? `sperrgrund-${user.id}` : undefined
              return (
                <tr key={user.id}>
                  <td>{user.displayName}</td>
                  <td>{user.email ?? '—'}</td>
                  <td>{statusLabel(user.status)}</td>
                  <td>{user.isSystemAdmin ? 'Systemadmin' : 'Nutzer'}</td>
                  <td>{new Date(user.createdAt).toLocaleDateString('de-DE')}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => {
                        toggle(user)
                      }}
                      disabled={(isSelf && !activate) || pendingId === user.id}
                      aria-describedby={reasonId}
                    >
                      {activate ? `${user.displayName} aktivieren` : `${user.displayName} deaktivieren`}
                    </button>
                    {reasonId !== undefined && (
                      <p className="hint" id={reasonId}>
                        Ein Systemadmin kann sich nicht selbst deaktivieren.
                      </p>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** Geoeffnetes Board samt Zustand seines Arbeitsbereichs; letzterer entscheidet ueber die Schreibbarkeit. */
type OpenBoard = { readonly board: BoardView; readonly workspaceArchived: boolean }

function Shell({ me, onSignedOut }: { readonly me: MeResponse; readonly onSignedOut: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [openBoard, setOpenBoard] = useState<OpenBoard | null>(null)

  function open(board: BoardView, workspace: WorkspaceView): void {
    setOpenBoard({ board, workspaceArchived: workspace.status === 'archived' })
  }

  // Der Editor braucht die ganze Flaeche; die Verwaltungsansicht bleibt im Zustand der Anwendung erhalten.
  if (openBoard !== null) {
    return (
      <Suspense
        fallback={
          <main className="shell" aria-live="polite">
            <h1>Canvaz</h1>
            <p>Editor wird geladen …</p>
          </main>
        }
      >
        <BoardEditor
          key={openBoard.board.id}
          boardId={openBoard.board.id}
          csrfToken={me.csrfToken}
          workspaceArchived={openBoard.workspaceArchived}
          guestRole={null}
          guestName={null}
          onClose={() => {
            setOpenBoard(null)
          }}
        />
      </Suspense>
    )
  }

  function signOut(): void {
    setBusy(true)
    setError(null)
    logout(me.csrfToken)
      .then((response) => {
        if (response.endSessionUrl !== null) {
          window.location.assign(response.endSessionUrl)
          return
        }
        onSignedOut()
      })
      .catch((cause: unknown) => {
        setBusy(false)
        setError(cause instanceof ApiError ? cause.message : 'Die Abmeldung ist fehlgeschlagen.')
      })
  }

  return (
    <div className="shell">
      <header className="shell__header">
        <h1>Canvaz</h1>
        <div className="shell__account">
          <span>
            Angemeldet als <strong>{me.user.displayName}</strong>
            {me.user.email !== null && <> ({me.user.email})</>}
            {me.user.isSystemAdmin && <> · Systemadmin</>}
          </span>
          <button type="button" onClick={signOut} disabled={busy}>
            Abmelden
          </button>
        </div>
      </header>
      {error !== null && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      <main>
        <Workspaces me={me} onOpenBoard={open} />
        {me.user.isSystemAdmin && <AdminUsers me={me} />}
      </main>
    </div>
  )
}

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'anonymous'; readonly error: string | null }
  | { readonly kind: 'authenticated'; readonly me: MeResponse }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Sitzungsgebundene Ansicht: alles ausser der Gastroute.
 *
 * Steht als eigene Komponente, damit die Gastansicht ohne ihre Zustaende und ohne ihre Sitzungspruefung
 * auskommt - ein Gast fragt `/api/me` gar nicht erst.
 */
function MemberApp() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  const load = useCallback(() => {
    setState({ kind: 'loading' })
    fetchMe()
      .then((me) => {
        if (me === null) {
          setState({ kind: 'anonymous', error: readLoginError() })
          return
        }
        clearLoginError()
        setState({ kind: 'authenticated', me })
      })
      .catch(() => {
        setState({ kind: 'failed', message: 'Der Server ist gerade nicht erreichbar.' })
      })
  }, [])

  useEffect(load, [load])

  if (state.kind === 'loading') {
    return (
      <main className="shell" aria-live="polite">
        <h1>Canvaz</h1>
        <p>Sitzung wird geprueft …</p>
      </main>
    )
  }
  if (state.kind === 'failed') {
    return (
      <main className="shell">
        <h1>Canvaz</h1>
        <p className="notice notice--error" role="alert">
          {state.message}
        </p>
        <p>
          <button type="button" onClick={load}>
            Erneut versuchen
          </button>
        </p>
      </main>
    )
  }
  if (state.kind === 'anonymous') {
    return <LoginView error={state.error} />
  }
  return <Shell me={state.me} onSignedOut={load} />
}

export function App() {
  // Die Adresse aendert sich waehrend einer Sitzung nicht; die Entscheidung faellt deshalb einmal und ohne
  // eigenen Zustand.
  if (window.location.pathname === GUEST_APP_PATH) {
    return <GuestApp />
  }
  return <MemberApp />
}
