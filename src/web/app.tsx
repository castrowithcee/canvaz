/**
 * Anwendungshuelle der SPA.
 *
 * Drei Zustaende: laedt, nicht angemeldet, angemeldet. Die Oberflaeche blendet nichts als Sicherheitsgrenze
 * aus - jede geschuetzte Antwort kommt bereits serverseitig geprueft. Bewusst ohne UI-Framework: das Paket
 * braucht eine Anmeldeseite, eine Huelle und eine Nutzerliste.
 *
 * Daneben stehen **genau zwei** weitere Routen: die Gastansicht unter `GUEST_APP_PATH` und das Einloesen
 * einer Einladung unter `INVITE_APP_PATH`. Beide werden vor jedem Sitzungszustand entschieden, damit weder
 * ein Gast noch ein Eingeladener erst eine Anmeldung angeboten bekommt. Einen Router braucht es dafuer
 * nicht: es sind drei Adressen, und der Anwendungsserver liefert fuer alle dieselbe `index.html`.
 */

import { Suspense, useCallback, useEffect, useState } from 'react'

import type { BoardView, LoginErrorCode, MeResponse, WorkspaceView } from '../contracts/api.js'
import { GUEST_APP_PATH, INVITE_APP_PATH, LOGIN_ERROR_PARAM } from '../contracts/api.js'
import { InviteApp, LoginView, PasswordSettings } from './account.js'
import { AdminUsers } from './admin-users.js'
import { ApiError, fetchMe, logout } from './api.js'
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
  'konto-nicht-zuordenbar':
    'Diese Anmeldung laesst sich keinem Konto dieser Instanz zuordnen. Bitte an die Systemadministration wenden.',
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

/** Geoeffnetes Board samt Zustand seines Arbeitsbereichs; letzterer entscheidet ueber die Schreibbarkeit. */
type OpenBoard = {
  readonly board: BoardView
  readonly workspaceArchived: boolean
  /**
   * `null` heisst: der aktuelle Stand. Sonst die Read-only-Vorschau genau dieser Version - derselbe Editor,
   * dieselbe Flaeche, aber ohne Boardraum und ohne jede Speicherung.
   */
  readonly previewVersion: number | null
}

function Shell({
  me,
  onSignedOut,
  onReload,
}: {
  readonly me: MeResponse
  readonly onSignedOut: () => void
  readonly onReload: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [openBoard, setOpenBoard] = useState<OpenBoard | null>(null)

  function open(board: BoardView, workspace: WorkspaceView, previewVersion?: number): void {
    setOpenBoard({
      board,
      workspaceArchived: workspace.status === 'archived',
      previewVersion: previewVersion ?? null,
    })
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
          key={`${openBoard.board.id}:${String(openBoard.previewVersion ?? 0)}`}
          boardId={openBoard.board.id}
          csrfToken={me.csrfToken}
          workspaceArchived={openBoard.workspaceArchived}
          previewVersion={openBoard.previewVersion}
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
        <PasswordSettings me={me} onChanged={onReload} />
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
    return <LoginView error={state.error} onSignedIn={load} />
  }
  return <Shell me={state.me} onSignedOut={load} onReload={load} />
}

export function App() {
  // Die Adresse aendert sich waehrend einer Sitzung nicht; die Entscheidung faellt deshalb einmal und ohne
  // eigenen Zustand.
  if (window.location.pathname === GUEST_APP_PATH) {
    return <GuestApp />
  }
  if (window.location.pathname === INVITE_APP_PATH) {
    return <InviteApp />
  }
  return <MemberApp />
}
