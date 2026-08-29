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
import { CircleUserRound, LogOut, PanelLeft, RotateCcw } from 'lucide-react'

import type { BoardView, FolderView, LoginErrorCode, MeResponse, WorkspaceView } from '../contracts/api.js'
import { GUEST_APP_PATH, INVITE_APP_PATH, LOGIN_ERROR_PARAM } from '../contracts/api.js'
import { InviteApp, LoginView, PasswordSettings } from './account.js'
import { AdminUsers } from './admin-users.js'
import { ApiError, fetchBoards, fetchFolders, fetchMe, fetchWorkspaces, logout } from './api.js'
import { BoardEditor } from './board/lazy-editor.js'
import { BoardDetails } from './board-details.js'
import { BoardTrash } from './board-trash.js'
import { Boards } from './boards.js'
import { Dashboard } from './dashboard.js'
import { FolderTree } from './folders.js'
import { GuestApp } from './guest.js'
import { Drawer, Menu, MenuItem, MenuLinkItem } from './overlays.js'
import type { AppRoute } from './router.js'
import { Link, navigateBack, routeHref, useRoute } from './router.js'
import { actionClass, Button, IconButton, Loading, Notice, PageState, Skeleton } from './ui.js'
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

/** Eine benannte Ansicht statt eines leeren Bildschirms - fuer unbekannte, fremde und fehlende Objekte. */
function NotFound({ text, forbidden = false }: { readonly text: string; readonly forbidden?: boolean }) {
  return (
    <section aria-labelledby="nicht-gefunden">
      <h2 id="nicht-gefunden" className="visually-hidden">
        Diese Ansicht gibt es nicht
      </h2>
      <PageState
        kind={forbidden ? 'forbidden' : 'not-found'}
        title={forbidden ? 'Dafuer fehlt dir die Berechtigung' : 'Diese Ansicht gibt es nicht'}
        description={text}
      >
        <Link className={actionClass('primary')} route={{ kind: 'einstieg', filter: null }}>
          Zum Dashboard
        </Link>
      </PageState>
    </section>
  )
}

/** Gemeinsame Fehlermeldung mit genau einem naechsten Schritt: es noch einmal versuchen. */
function LoadFailed({ text, onRetry }: { readonly text: string; readonly onRetry: () => void }) {
  return (
    <PageState kind="error" title="Das hat nicht geklappt" description={text}>
      <Button variant="primary" icon={RotateCcw} onClick={onRetry}>
        Erneut laden
      </Button>
    </PageState>
  )
}

function Header({
  me,
  route,
  navId,
  navOpen,
  onToggleNav,
  onSignedOut,
}: {
  readonly me: MeResponse
  readonly route: AppRoute
  /** Die Seitenleiste, die der Ausloeser in der Kopfzeile oeffnet. */
  readonly navId: string
  readonly navOpen: boolean
  readonly onToggleNav: () => void
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

  const account = `${me.user.displayName}${me.user.email === null ? '' : ` (${me.user.email})`}`

  return (
    <header className="app__header">
      <div className="flex items-center gap-2">
        {/* Nur auf schmalen Flaechen sichtbar; breiter steht die Seitenleiste ohnehin da. */}
        <IconButton
          label={navOpen ? 'Navigation schliessen' : 'Navigation oeffnen'}
          icon={PanelLeft}
          extraClass="app__nav-toggle"
          aria-expanded={navOpen}
          aria-controls={navId}
          onClick={onToggleNav}
        />
        <h1 className="app__brand">
          <Link route={{ kind: 'einstieg', filter: null }}>Canvaz</Link>
        </h1>
      </div>
      <nav className="app__nav" aria-label="Konto und Verwaltung">
        <Menu label={`Konto und Verwaltung, angemeldet als ${account}`} icon={CircleUserRound}>
          <li className="menu__label" role="presentation">
            {account}
          </li>
          <MenuLinkItem>
            <Link className="menu__item" role="menuitem" route={{ kind: 'konto' }} current={route.kind === 'konto'}>
              Konto
            </Link>
          </MenuLinkItem>
          {me.user.isSystemAdmin && (
            <MenuLinkItem>
              <Link
                className="menu__item"
                role="menuitem"
                route={{ kind: 'konten' }}
                current={route.kind === 'konten'}
              >
                Kontenverwaltung
              </Link>
            </MenuLinkItem>
          )}
          <MenuItem icon={LogOut} onSelect={signOut} disabled={busy}>
            Abmelden
          </MenuItem>
        </Menu>
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
    <nav aria-label="Arbeitsbereich und Boards">
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
          {/* Die Form der Liste steht fest, also haelt sie der Platzhalter - keine allgemeine Drehmarke. */}
          {boards === null && (
            <ul className="sidebar__list" aria-busy="true">
              <li className="visually-hidden" aria-live="polite">
                Boards werden geladen …
              </li>
              {[0, 1, 2].map((row) => (
                <li key={row} className="skeleton-row" aria-hidden="true">
                  <Skeleton />
                </li>
              ))}
            </ul>
          )}
          {error !== null && (
            <Notice>
              <p>{error}</p>
              <p className="actions">
                <Button icon={RotateCcw} onClick={load}>
                  Erneut laden
                </Button>
              </p>
            </Notice>
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
            {' · '}
            <Link route={{ kind: 'papierkorb', workspaceId: active.id }} current={route.kind === 'papierkorb'}>
              Papierkorb
            </Link>
          </p>
        </>
      )}
    </nav>
  )
}

const UNKNOWN_WORKSPACE = 'Dieser Arbeitsbereich ist nicht (mehr) fuer dich freigegeben oder existiert nicht.'

/** Die Seitenleiste ist derselbe Knoten, den der Ausloeser in der Kopfzeile oeffnet. */
const NAV_ID = 'navigation'

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
    case 'papierkorb':
    case 'boarddetails':
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
      if (route.kind === 'papierkorb') {
        return <BoardTrash me={me} workspace={workspace} onChanged={onBoardsChanged} />
      }
      if (route.kind === 'boarddetails') {
        return (
          <BoardDetails
            me={me}
            workspace={workspace}
            workspaces={workspaces}
            boardId={route.boardId}
            onChanged={onBoardsChanged}
          />
        )
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
        <NotFound forbidden text="Die Kontenverwaltung steht nur der Systemadministration offen." />
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
  /** Nur auf schmalen Flaechen von Belang: dort ist die Seitenleiste eine temporaere Ebene. */
  const [navOpen, setNavOpen] = useState(false)
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

  // Nach einem Schritt in der Navigation ist die Ebene erledigt.
  const href = routeHref(route)
  useEffect(() => {
    setNavOpen(false)
  }, [href])

  // Wird das Fenster breit, ist die Leiste ohnehin eine Spalte; eine offene Ebene waere dann nur im Weg.
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 48rem)')
    const sync = (): void => {
      if (wide.matches) {
        setNavOpen(false)
      }
    }
    wide.addEventListener('change', sync)
    return () => {
      wide.removeEventListener('change', sync)
    }
  }, [])

  if (workspaces === null) {
    return (
      <main className="shell">
        <h1>Canvaz</h1>
        <Loading text="Arbeitsbereiche werden geladen …" />
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
          <main className="shell">
            <h1>Canvaz</h1>
            <Loading text="Editor wird geladen …" />
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
      <a className="skip" href="#inhalt">
        Zum Inhalt springen
      </a>
      <Header
        me={me}
        route={route}
        navId={NAV_ID}
        navOpen={navOpen}
        onToggleNav={() => {
          setNavOpen((was) => !was)
        }}
        onSignedOut={onSignedOut}
      />
      <Drawer
        id={NAV_ID}
        open={navOpen}
        title="Navigation"
        className="app__sidebar"
        onClose={() => {
          setNavOpen(false)
        }}
      >
        {/*
          * Ein Schritt in der Navigation schliesst die Ebene - auch, wenn er auf die gerade gezeigte Ansicht
          * fuehrt und die Adresse sich deshalb nicht aendert.
          */}
        <div
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest('a') !== null) {
              setNavOpen(false)
            }
          }}
        >
          <Sidebar workspaces={workspaces} active={activeWorkspace} route={route} boardsToken={boardsToken} />
        </div>
      </Drawer>
      <main className="app__main" id="inhalt" tabIndex={-1}>
        {error !== null && <LoadFailed text={error} onRetry={load} />}
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
      <main className="shell">
        <h1>Canvaz</h1>
        <Loading text="Sitzung wird geprueft …" />
      </main>
    )
  }
  if (state.kind === 'failed') {
    return (
      <main className="shell">
        <h1>Canvaz</h1>
        <LoadFailed text={state.message} onRetry={load} />
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
