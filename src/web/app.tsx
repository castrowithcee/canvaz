/**
 * Anwendungshuelle der SPA.
 *
 * Drei Zustaende: laedt, nicht angemeldet, angemeldet. Die Oberflaeche blendet nichts als Sicherheitsgrenze
 * aus - jede geschuetzte Antwort kommt bereits serverseitig geprueft. Bewusst ohne UI-Framework.
 *
 * Die angemeldete Anwendung ist eine dauerhafte Huelle aus Kopfzeile, Seitenleiste und Inhaltsbereich; die
 * gezeigte Ansicht entscheidet die Adresse (siehe `router.ts`). Daneben stehen **genau zwei** weitere
 * Adressen: die Gastansicht unter `GUEST_APP_PATH` und das Einloesen einer Einladung unter
 * `INVITE_APP_PATH`. Beide werden vor jedem Sitzungszustand entschieden, damit weder ein Gast noch ein
 * Eingeladener erst eine Anmeldung oder gar eine Huelle mit Arbeitsbereichen bekommt.
 *
 * Der Anwendungsserver liefert fuer jeden unbekannten GET-Pfad dieselbe `index.html` (siehe
 * `server/http.ts`); ein Neuladen tief im Baum landet deshalb wieder in derselben Ansicht.
 */

import { Suspense, useCallback, useEffect, useState } from 'react'

import type { BoardView, FolderView, LoginErrorCode, MeResponse, WorkspaceView } from '../contracts/api.js'
import { GUEST_APP_PATH, INVITE_APP_PATH, LOGIN_ERROR_PARAM } from '../contracts/api.js'
import { InviteApp, LoginView, PasswordSettings } from './account.js'
import { AdminUsers } from './admin-users.js'
import { ApiError, fetchBoards, fetchFolders, fetchMe, fetchWorkspaces, logout } from './api.js'
import { BoardEditor } from './board/lazy-editor.js'
import { Boards } from './boards.js'
import { Dashboard } from './dashboard.js'
import { FolderTree } from './folders.js'
import { GuestApp } from './guest.js'
import type { AppRoute } from './router.js'
import { Link, navigate, navigateBack, useRoute } from './router.js'
import { WorkspaceMembers, WorkspaceOverview, WorkspaceSettings } from './workspaces.js'

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
  window.history.replaceState(window.history.state, '', url.pathname + url.search)
}

function Notice({ text }: { readonly text: string }) {
  return (
    <p className="notice notice--error" role="alert">
      {text}
    </p>
  )
}

/** Eine benannte Ansicht statt eines leeren Bildschirms - fuer unbekannte, fremde und fehlende Objekte. */
function NotFound({ text }: { readonly text: string }) {
  return (
    <section aria-labelledby="nicht-gefunden">
      <h2 id="nicht-gefunden">Diese Ansicht gibt es nicht</h2>
      <p>{text}</p>
      <p>
        <Link className="button" route={{ kind: 'einstieg', filter: null }}>
          Zum Dashboard
        </Link>
      </p>
    </section>
  )
}

function Header({
  me,
  route,
  onSignedOut,
}: {
  readonly me: MeResponse
  readonly route: AppRoute
  readonly onSignedOut: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
    <header className="app__header">
      <h1 className="app__brand">
        <Link route={{ kind: 'einstieg', filter: null }}>Canvaz</Link>
      </h1>
      <nav className="app__nav" aria-label="Konto und Verwaltung">
        <Link route={{ kind: 'konto' }} current={route.kind === 'konto'}>
          {me.user.displayName}
          {me.user.email === null ? '' : ` (${me.user.email})`}
        </Link>
        {me.user.isSystemAdmin && (
          <Link route={{ kind: 'konten' }} current={route.kind === 'konten'}>
            Kontenverwaltung
          </Link>
        )}
        <button type="button" onClick={signOut} disabled={busy}>
          Abmelden
        </button>
      </nav>
      {error !== null && <Notice text={error} />}
    </header>
  )
}

/**
 * Seitenleiste: aktiver Arbeitsbereich, Wechsel, sein Ordnerbaum und seine Boards.
 *
 * Baum und Boardliste werden hier eigens geladen. Es sind damit dieselben Abfragen wie in der Boardansicht,
 * aber unabhaengig von deren Filtern - die Seitenleiste zeigt immer den ganzen Baum und alle aktiven
 * Boards, auch waehrend die Ansicht einen Ordner, das Archiv oder einen Suchtreffer zeigt.
 *
 * Der Baum nennt ausschliesslich Ordner. Er ist Navigation und keine Berechtigung: welche Boards ein
 * gewaehlter Ordner zeigt, entscheidet weiterhin der Server.
 */
function Sidebar({
  workspaces,
  active,
  route,
  boardsToken,
}: {
  readonly workspaces: readonly WorkspaceView[]
  readonly active: WorkspaceView | null
  readonly route: AppRoute
  /** Aendert sich, sobald die Boardansicht die Liste veraendert hat; dann laedt die Leiste neu. */
  readonly boardsToken: number
}) {
  const [boards, setBoards] = useState<readonly BoardView[] | null>(null)
  const [folders, setFolders] = useState<readonly FolderView[]>([])
  const [error, setError] = useState<string | null>(null)
  const activeId = active?.id ?? null

  const load = useCallback(() => {
    if (activeId === null) {
      setBoards([])
      setFolders([])
      return
    }
    setError(null)
    fetchBoards(activeId, { status: 'active', query: '' })
      .then((response) => {
        setBoards(response.boards)
      })
      .catch(() => {
        setBoards([])
        setError('Die Boards konnten nicht geladen werden.')
      })
    fetchFolders(activeId)
      .then((response) => {
        setFolders(response.folders)
      })
      .catch(() => {
        setFolders([])
      })
  }, [activeId])

  useEffect(() => {
    setBoards(null)
    load()
  }, [load, boardsToken])

  const openBoardId = route.kind === 'board' ? route.boardId : null

  return (
    <nav className="app__sidebar" aria-label="Arbeitsbereich und Boards">
      <h2 className="sidebar__title">Arbeitsbereiche</h2>
      {workspaces.length === 0 && <p className="hint">Noch kein Arbeitsbereich.</p>}
      <ul className="sidebar__list">
        {workspaces.map((workspace) => (
          <li key={workspace.id}>
            <Link
              route={{ kind: 'arbeitsbereich', workspaceId: workspace.id, folder: null }}
              current={workspace.id === activeId}
            >
              {workspace.name}
              {workspace.status === 'active' ? '' : ' (archiviert)'}
            </Link>
          </li>
        ))}
      </ul>
      <p>
        <Link route={{ kind: 'arbeitsbereiche' }} current={route.kind === 'arbeitsbereiche'}>
          Arbeitsbereiche verwalten
        </Link>
      </p>

      {active !== null && (
        <>
          <h2 className="sidebar__title">Ordner in {active.name}</h2>
          <FolderTree
            workspaceId={active.id}
            folders={folders}
            active={route.kind === 'arbeitsbereich' ? route.folder : null}
          />

          <h2 className="sidebar__title">Boards in {active.name}</h2>
          {boards === null && <p aria-live="polite">Boards werden geladen …</p>}
          {error !== null && (
            <p className="notice notice--error" role="alert">
              {error}{' '}
              <button type="button" onClick={load}>
                Erneut laden
              </button>
            </p>
          )}
          {boards !== null && boards.length === 0 && error === null && (
            <p className="hint">Noch kein aktives Board.</p>
          )}
          <ul className="sidebar__list">
            {(boards ?? []).map((board) => (
              <li key={board.id}>
                <Link
                  route={{ kind: 'board', workspaceId: active.id, boardId: board.id, version: null }}
                  current={board.id === openBoardId}
                >
                  {board.title}
                </Link>
              </li>
            ))}
          </ul>
          <p>
            <Link route={{ kind: 'mitglieder', workspaceId: active.id }} current={route.kind === 'mitglieder'}>
              Mitglieder
            </Link>
            {' · '}
            <Link
              route={{ kind: 'einstellungen', workspaceId: active.id }}
              current={route.kind === 'einstellungen'}
            >
              Einstellungen
            </Link>
          </p>
        </>
      )}
    </nav>
  )
}

const UNKNOWN_WORKSPACE = 'Dieser Arbeitsbereich ist nicht (mehr) fuer dich freigegeben oder existiert nicht.'

/** Der Inhaltsbereich: genau eine Ansicht, ausgewaehlt von der Adresse. */
function Content({
  me,
  route,
  workspaces,
  workspace,
  onWorkspacesChanged,
  onProfileChanged,
  onBoardsChanged,
}: {
  readonly me: MeResponse
  readonly route: AppRoute
  readonly workspaces: readonly WorkspaceView[]
  /** Der Arbeitsbereich der Adresse; `null`, wenn die Adresse keinen nennt oder er nicht sichtbar ist. */
  readonly workspace: WorkspaceView | null
  readonly onWorkspacesChanged: () => void
  readonly onProfileChanged: () => void
  readonly onBoardsChanged: () => void
}) {
  switch (route.kind) {
    case 'einstieg':
      return (
        <Dashboard me={me} workspaces={workspaces} filter={route.filter} onBoardsChanged={onBoardsChanged} />
      )
    case 'arbeitsbereiche':
      return <WorkspaceOverview me={me} workspaces={workspaces} onChanged={onWorkspacesChanged} />
    case 'arbeitsbereich':
    case 'mitglieder':
    case 'einstellungen':
    case 'board': {
      if (workspace === null) {
        return <NotFound text={UNKNOWN_WORKSPACE} />
      }
      if (route.kind === 'mitglieder') {
        return <WorkspaceMembers me={me} workspace={workspace} onChanged={onWorkspacesChanged} />
      }
      if (route.kind === 'einstellungen') {
        return <WorkspaceSettings me={me} workspace={workspace} onChanged={onWorkspacesChanged} />
      }
      return (
        <section aria-labelledby="arbeitsbereich">
          <h2 id="arbeitsbereich">
            {workspace.name}
            {workspace.status === 'active' ? '' : ' (archiviert)'}
          </h2>
          <Boards
            me={me}
            workspace={workspace}
            folder={route.kind === 'arbeitsbereich' ? route.folder : null}
            onListChanged={onBoardsChanged}
            onOpenBoard={(board, previewVersion) => {
              navigate({
                kind: 'board',
                workspaceId: workspace.id,
                boardId: board.id,
                version: previewVersion ?? null,
              })
            }}
          />
        </section>
      )
    }
    case 'konto':
      return (
        <section aria-labelledby="konto">
          <h2 id="konto">Konto</h2>
          <p>
            Angemeldet als <strong>{me.user.displayName}</strong>
            {me.user.email === null ? '' : ` (${me.user.email})`}
            {me.user.isSystemAdmin && ' · Systemadmin'}
          </p>
          <PasswordSettings me={me} onChanged={onProfileChanged} />
        </section>
      )
    case 'konten':
      return me.user.isSystemAdmin ? (
        <AdminUsers me={me} />
      ) : (
        <NotFound text="Die Kontenverwaltung steht nur der Systemadministration offen." />
      )
    case 'unbekannt':
      return <NotFound text="Diese Adresse gehoert zu keiner Ansicht dieser Anwendung." />
  }
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
  const route = useRoute()
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [boardsToken, setBoardsToken] = useState(0)
  /** Zuletzt besuchter Arbeitsbereich; er haelt die Seitenleiste auch in Konto- und Verwaltungsansichten. */
  const [lastWorkspaceId, setLastWorkspaceId] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    fetchWorkspaces()
      .then((response) => {
        setWorkspaces(response.workspaces)
      })
      .catch((cause: unknown) => {
        setWorkspaces([])
        setError(
          cause instanceof ApiError ? cause.message : 'Die Arbeitsbereiche konnten nicht geladen werden.',
        )
      })
  }, [])

  useEffect(load, [load])

  const routeWorkspaceId = 'workspaceId' in route ? route.workspaceId : null
  useEffect(() => {
    if (routeWorkspaceId !== null) {
      setLastWorkspaceId(routeWorkspaceId)
    }
  }, [routeWorkspaceId])

  const bumpBoards = useCallback(() => {
    setBoardsToken((token) => token + 1)
  }, [])

  if (workspaces === null) {
    return (
      <main className="shell" aria-live="polite">
        <h1>Canvaz</h1>
        <p>Arbeitsbereiche werden geladen …</p>
      </main>
    )
  }

  const find = (id: string | null): WorkspaceView | null =>
    id === null ? null : (workspaces.find((entry) => entry.id === id) ?? null)
  const routeWorkspace = find(routeWorkspaceId)
  const activeWorkspace = routeWorkspace ?? find(lastWorkspaceId) ?? workspaces[0] ?? null

  // Der Editor braucht die ganze Flaeche; Kopfzeile und Seitenleiste treten dafuer ab.
  if (route.kind === 'board' && routeWorkspace !== null) {
    const back: AppRoute = { kind: 'arbeitsbereich', workspaceId: routeWorkspace.id, folder: null }
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
          key={`${route.boardId}:${String(route.version ?? 0)}`}
          boardId={route.boardId}
          csrfToken={me.csrfToken}
          workspaceArchived={routeWorkspace.status === 'archived'}
          previewVersion={route.version}
          guestName={null}
          onClose={() => {
            navigateBack(back)
          }}
        />
      </Suspense>
    )
  }

  return (
    <div className="app">
      <Header me={me} route={route} onSignedOut={onSignedOut} />
      <Sidebar workspaces={workspaces} active={activeWorkspace} route={route} boardsToken={boardsToken} />
      <main className="app__main">
        {error !== null && (
          <p className="notice notice--error" role="alert">
            {error}{' '}
            <button type="button" onClick={load}>
              Erneut laden
            </button>
          </p>
        )}
        <Content
          me={me}
          route={route}
          workspaces={workspaces}
          workspace={routeWorkspace}
          onWorkspacesChanged={load}
          onProfileChanged={onReload}
          onBoardsChanged={bumpBoards}
        />
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
  // Gast und Einladung haben eine feste Adresse, die sich waehrend ihrer Sitzung nicht aendert; die
  // Entscheidung faellt deshalb einmal und vor jedem Sitzungszustand.
  if (window.location.pathname === GUEST_APP_PATH) {
    return <GuestApp />
  }
  if (window.location.pathname === INVITE_APP_PATH) {
    return <InviteApp />
  }
  return <MemberApp />
}
