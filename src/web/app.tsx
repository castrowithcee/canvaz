/**
 * Anwendungshuelle der SPA.
 *
 * Drei Zustaende: laedt, nicht angemeldet, angemeldet. Die Oberflaeche blendet nichts als Sicherheitsgrenze
 * aus - jede geschuetzte Antwort kommt bereits serverseitig geprueft. Bewusst ohne UI-Framework. Eine
 * Sitzung des Systemadmins ohne belegten zweiten Faktor zeigt statt der Huelle Einrichtung oder Abfrage
 * (`second-factor.tsx`); der Server laesst ihr ohnehin nichts anderes zu.
 *
 * Die angemeldete Anwendung ist eine dauerhafte Huelle aus Kopfzeile, Explorer und Inhaltsbereich; die
 * gezeigte Ansicht entscheidet die Adresse (siehe `router.ts`). Daneben stehen **genau drei** weitere
 * Adressen: die Gastansicht unter `GUEST_APP_PATH`, das Einloesen einer Einladung unter `INVITE_APP_PATH`
 * und dasselbe fuer eine Wiederherstellung unter `RECOVERY_APP_PATH`. Sie werden vor jedem Sitzungszustand
 * entschieden, damit weder ein Gast noch ein Eingeladener erst eine Anmeldung oder gar eine Huelle mit
 * Arbeitsbereichen bekommt.
 *
 * ## Ein Stand fuer Baum und Inhalt
 *
 * Ordner und Boards des aktiven Arbeitsbereichs laedt die Huelle **einmal** (`useExplorer`) und gibt
 * denselben Stand an Seitenleiste und Inhaltsflaeche. Sie zeigen damit nie zwei verschiedene Baeume, und
 * eine Mutation aktualisiert beide in einem Zug. Ein globaler Store waere dafuer eine Ebene zu viel.
 *
 * ## Eine Navigation, zwei Breiten
 *
 * Die Seitenleiste ist auf jeder Breite derselbe Knoten: ein natives `dialog`. Breit ist sie eine Spalte
 * des Rasters und laesst sich einklappen (der Zustand ueberlebt das Neuladen); schmal ist sie eine
 * temporaere Ebene mit Fokusfang, Escape und Fokusrueckgabe von der Plattform. Umgeschaltet wird per CSS;
 * das Javascript entscheidet allein, worauf der eine Schalter der Kopfzeile wirkt.
 *
 * ## Der Editor tritt aus der Huelle heraus
 *
 * Die Boardroute zeigt den Editor im Vollbild; Kopfzeile und Haupt-Seitenleiste treten dafuer ab. Was ein
 * Board braucht, traegt er selbst: seine schwebende Gruppe den Rueckweg in den zuletzt gezeigten
 * Bibliothekskontext, seine Informationsleiste die Boardaufgaben. Eine eigene Detailseite gibt es dafuer nicht
 * mehr - fuer dieselbe Handlung soll es genau einen Ort geben.
 *
 * Der Anwendungsserver liefert fuer jeden unbekannten GET-Pfad dieselbe `index.html` (siehe
 * `server/http.ts`); ein Neuladen tief im Baum landet deshalb wieder in derselben Ansicht.
 */

import { Suspense, useCallback, useEffect, useState } from 'react'
import {
  ChevronsUpDown,
  CircleUserRound,
  EllipsisVertical,
  Layers,
  LogOut,
  PanelLeft,
  Plus,
  RotateCcw,
  Settings,
  Trash2,
  Users,
} from 'lucide-react'

import type { AppearanceView, LoginErrorCode, MeResponse, WorkspaceView } from '../contracts/api.js'
import { GUEST_APP_PATH, INVITE_APP_PATH, LOGIN_ERROR_PARAM, RECOVERY_APP_PATH } from '../contracts/api.js'
import { MAX_WORKSPACE_NAME_LENGTH } from '../domain/workspace/model.js'
import { AppearanceSettings, InviteApp, LoginView, PasswordSettings } from './account.js'
import { AdminUsers } from './admin-users.js'
import { ApiError, createWorkspace, fetchMe, fetchWorkspaces, logout } from './api.js'
import { applyAppearance } from './appearance.js'
import { BoardEditor } from './board/lazy-editor.js'
import { BoardTrash } from './board-trash.js'
import { Boards } from './boards.js'
import { Dashboard } from './dashboard.js'
import type { Explorer } from './explorer.js'
import { ExplorerTree, useExplorer } from './explorer.js'
import { GuestApp } from './guest.js'
import { SecondFactorGate, SecondFactorSettings } from './second-factor.js'
import { Drawer, Menu, MenuItem, MenuLinkItem, NameDialog } from './overlays.js'
import type { AppRoute, BoardPanelView } from './router.js'
import { closeLayer, Link, navigate, navigateBack, routeHref, useRoute } from './router.js'
import { actionClass, Button, IconButton, Loading, Notice, PageState } from './ui.js'
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
  navShown,
  navLabel,
  onToggleNav,
  onSignedOut,
}: {
  readonly me: MeResponse
  readonly route: AppRoute
  /** Die Seitenleiste, auf die der Ausloeser in der Kopfzeile wirkt. */
  readonly navId: string
  /** Steht die Seitenleiste gerade da? Breit heisst das ausgeklappt, schmal geoeffnet. */
  readonly navShown: boolean
  readonly navLabel: string
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
        <IconButton
          label={navLabel}
          icon={PanelLeft}
          extraClass="app__nav-toggle"
          aria-expanded={navShown}
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
 * Der Explorer der Seitenleiste: Wechsel des Arbeitsbereichs, sein Baum und seine seltenen Verwaltungswege.
 *
 * Die Gruppe "Arbeitsbereiche" trennt Wechsel und Handlungen: die Auswahl enthaelt nur Arbeitsbereiche, an
 * der Ueberschrift stehen das Plus fuer das direkte Anlegen und das Menue mit den Verwaltungswegen. Der Baum
 * darunter navigiert und legt nichts an: Anlegen, Umbenennen, Verschieben und Entfernen von Ordnern und
 * Boards stehen an den Objekten der Inhaltsflaeche (`boards.tsx`), damit es je Handlung genau einen Ort gibt.
 * Welche Ordner und Boards jemand sieht, entscheidet weiterhin der Server.
 */
function Sidebar({
  me,
  workspaces,
  active,
  route,
  explorer,
  onWorkspaceCreated,
}: {
  readonly me: MeResponse
  readonly workspaces: readonly WorkspaceView[]
  readonly active: WorkspaceView | null
  readonly route: AppRoute
  readonly explorer: Explorer
  readonly onWorkspaceCreated: (workspace: WorkspaceView) => void
}) {
  const [creating, setCreating] = useState(false)

  return (
    <nav aria-label="Arbeitsbereich und Boards">
      <div className="sidebar__head">
        <h2 className="sidebar__title">Arbeitsbereiche</h2>
        <IconButton
          label="Arbeitsbereich anlegen"
          icon={Plus}
          variant="quiet"
          onClick={() => {
            setCreating(true)
          }}
        />
        <Menu label="Arbeitsbereiche verwalten" icon={EllipsisVertical}>
          <MenuLinkItem>
            <Link
              className="menu__item"
              role="menuitem"
              route={{ kind: 'arbeitsbereiche' }}
              current={route.kind === 'arbeitsbereiche'}
            >
              <Layers size={16} aria-hidden="true" />
              Arbeitsbereiche verwalten
            </Link>
          </MenuLinkItem>
          {active !== null && (
            <>
              <li className="menu__label" role="presentation">
                {active.name}
              </li>
              <MenuLinkItem>
                <Link
                  className="menu__item"
                  role="menuitem"
                  route={{ kind: 'mitglieder', workspaceId: active.id }}
                  current={route.kind === 'mitglieder'}
                >
                  <Users size={16} aria-hidden="true" />
                  Mitglieder
                </Link>
              </MenuLinkItem>
              <MenuLinkItem>
                <Link
                  className="menu__item"
                  role="menuitem"
                  route={{ kind: 'papierkorb', workspaceId: active.id }}
                  current={route.kind === 'papierkorb'}
                >
                  <Trash2 size={16} aria-hidden="true" />
                  Papierkorb
                </Link>
              </MenuLinkItem>
              <MenuLinkItem>
                <Link
                  className="menu__item"
                  role="menuitem"
                  route={{ kind: 'einstellungen', workspaceId: active.id }}
                  current={route.kind === 'einstellungen'}
                >
                  <Settings size={16} aria-hidden="true" />
                  Einstellungen
                </Link>
              </MenuLinkItem>
            </>
          )}
        </Menu>
      </div>
      {active === null ? (
        <p className="hint">Noch kein Arbeitsbereich.</p>
      ) : (
        <Menu
          label={`Arbeitsbereich wechseln, aktuell ${active.name}`}
          icon={ChevronsUpDown}
          text={`${active.name}${active.status === 'active' ? '' : ' (archiviert)'}`}
        >
          {workspaces.map((workspace) => (
            <MenuLinkItem key={workspace.id}>
              <Link
                className="menu__item"
                role="menuitem"
                route={{ kind: 'arbeitsbereich', workspaceId: workspace.id, folder: null }}
                current={workspace.id === active.id}
              >
                {workspace.name}
                {workspace.status === 'active' ? '' : ' (archiviert)'}
              </Link>
            </MenuLinkItem>
          ))}
        </Menu>
      )}

      {active !== null && (
        <>
          <h2 className="sidebar__title">Boards</h2>
          <ExplorerTree
            workspace={active}
            explorer={explorer}
            selection={route.kind === 'arbeitsbereich' ? route.folder : null}
            openBoardId={route.kind === 'board' ? route.boardId : null}
          />
        </>
      )}

      <NameDialog
        open={creating}
        title="Arbeitsbereich anlegen"
        label="Name des neuen Arbeitsbereichs"
        maxLength={MAX_WORKSPACE_NAME_LENGTH}
        submitLabel="Arbeitsbereich anlegen"
        errorOf={(cause) =>
          cause instanceof ApiError ? cause.message : 'Der Arbeitsbereich konnte nicht angelegt werden.'
        }
        onSubmit={(name) =>
          createWorkspace(me.csrfToken, name).then((workspace) => {
            setCreating(false)
            onWorkspaceCreated(workspace)
          })
        }
        onClose={() => {
          setCreating(false)
        }}
      />
    </nav>
  )
}

const UNKNOWN_WORKSPACE = 'Dieser Arbeitsbereich ist nicht (mehr) fuer dich freigegeben oder existiert nicht.'

/** Die Seitenleiste ist derselbe Knoten, auf den der Ausloeser in der Kopfzeile wirkt. */
const NAV_ID = 'navigation'

/** Der eingeklappte Zustand der breiten Seitenleiste. Er gehoert diesem Geraet, nicht dem Konto. */
const COLLAPSED_KEY = 'canvaz:explorer-eingeklappt'

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    // Ein Browser ohne Speicher (privates Fenster, gesperrte Seitendaten) faengt einfach ausgeklappt an.
    return false
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // Ohne Speicher bleibt der Zustand fuer diese Sitzung; das ist kein Fehler, den jemand sehen muesste.
  }
}

/** Ab hier ist die Seitenleiste eine Spalte des Rasters. Derselbe Wert steht in `styles.css`. */
const WIDE = '(min-width: 48rem)'

/** Der Inhaltsbereich: genau eine Ansicht, ausgewaehlt von der Adresse. */
function Content({
  me,
  route,
  workspaces,
  workspace,
  explorer,
  onWorkspacesChanged,
  onProfileChanged,
  onAppearanceChanged,
  onBoardsChanged,
}: {
  readonly me: MeResponse
  readonly route: AppRoute
  readonly workspaces: readonly WorkspaceView[]
  /** Der Arbeitsbereich der Adresse; `null`, wenn die Adresse keinen nennt oder er nicht sichtbar ist. */
  readonly workspace: WorkspaceView | null
  readonly explorer: Explorer
  readonly onWorkspacesChanged: () => void
  readonly onProfileChanged: () => void
  readonly onAppearanceChanged: (appearance: AppearanceView) => void
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
      return (
        <Boards
          me={me}
          workspace={workspace}
          folder={route.kind === 'arbeitsbereich' ? route.folder : null}
          explorer={explorer}
          onChanged={onBoardsChanged}
        />
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
          <AppearanceSettings me={me} onChanged={onAppearanceChanged} />
          <PasswordSettings me={me} onChanged={onProfileChanged} />
          <SecondFactorSettings me={me} onChanged={onProfileChanged} />
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
  onAppearanceChanged,
}: {
  readonly me: MeResponse
  readonly onSignedOut: () => void
  readonly onReload: () => void
  readonly onAppearanceChanged: (appearance: AppearanceView) => void
}) {
  const route = useRoute()
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Nur auf schmalen Flaechen von Belang: dort ist die Seitenleiste eine temporaere Ebene. */
  const [navOpen, setNavOpen] = useState(false)
  /** Nur auf breiten Flaechen von Belang: dort ist sie eine Spalte, die sich einklappen laesst. */
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches)
  /** Zuletzt besuchter Arbeitsbereich; er haelt die Seitenleiste auch in Konto- und Verwaltungsansichten. */
  const [lastWorkspaceId, setLastWorkspaceId] = useState<string | null>(null)
  /** Der zuletzt gezeigte Bibliothekskontext - der Rueckweg, wenn ein Board ohne eigene Historie schliesst. */
  const [library, setLibrary] = useState<{ readonly workspaceId: string; readonly folder: string | null } | null>(
    null,
  )

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

  useEffect(() => {
    if (route.kind === 'arbeitsbereich') {
      setLibrary({ workspaceId: route.workspaceId, folder: route.folder })
    }
  }, [route])

  // Nach einem Schritt in der Navigation ist die Ebene erledigt.
  const href = routeHref(route)
  useEffect(() => {
    setNavOpen(false)
  }, [href])

  // Wird das Fenster breit, ist die Leiste eine Spalte; eine offene Ebene waere dann nur im Weg.
  useEffect(() => {
    const query = window.matchMedia(WIDE)
    const sync = (): void => {
      setWide(query.matches)
      if (query.matches) {
        setNavOpen(false)
      }
    }
    query.addEventListener('change', sync)
    return () => {
      query.removeEventListener('change', sync)
    }
  }, [])

  const find = (id: string | null): WorkspaceView | null =>
    id === null || workspaces === null ? null : (workspaces.find((entry) => entry.id === id) ?? null)
  const routeWorkspace = find(routeWorkspaceId)
  const activeWorkspace = routeWorkspace ?? find(lastWorkspaceId) ?? workspaces?.[0] ?? null

  // Ein Stand fuer Baum und Inhalt. Der Aufruf steht vor jeder Verzweigung - Hooks sind unbedingt.
  const explorer = useExplorer(activeWorkspace?.id ?? null)

  if (workspaces === null) {
    return (
      <main className="shell">
        <h1>Canvaz</h1>
        <Loading text="Arbeitsbereiche werden geladen …" />
      </main>
    )
  }

  // Der Editor braucht die ganze Flaeche; Kopfzeile und Haupt-Seitenleiste treten dafuer ab. Seine eigene
  // schwebende Gruppe traegt den Rueckweg, die Informationsleiste die Boardaufgaben (`board/board-view.tsx`).
  if (route.kind === 'board' && routeWorkspace !== null) {
    const back: AppRoute = {
      kind: 'arbeitsbereich',
      workspaceId: routeWorkspace.id,
      folder: library !== null && library.workspaceId === routeWorkspace.id ? library.folder : null,
    }
    /**
     * Der offene Bereich der Informationsleiste steht in der Adresse.
     *
     * Oeffnen im Board legt einen Historieneintrag als Ebene an - `Zurueck` schliesst die Leiste damit
     * sinnvoll. Ein Bereichswechsel darin ersetzt ihn, sonst muesste man sich durch die Bereiche
     * zurueckklicken. Geschlossen wird ueber genau diesen Eintrag; kam die Adresse schon mit Bereich
     * (geteilter Link, Eintrag einer Liste), tritt die Boardadresse ohne Bereich an seine Stelle - das Board
     * bleibt offen.
     */
    const openPanel = (panel: BoardPanelView | null): void => {
      const target: AppRoute = {
        kind: 'board',
        workspaceId: routeWorkspace.id,
        boardId: route.boardId,
        version: route.version,
        panel,
      }
      if (panel === null) {
        closeLayer(target)
        return
      }
      navigate(target, { replace: route.panel !== null, layer: true })
    }
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
          /*
           * Der Arbeitsbereich gehoert in die Identitaet dieser Ansicht: ein Wechsel schliesst serverseitig
           * jede offene Verbindung des Boards (dokumentierte Folge). Ohne den Neuaufbau bliebe der Editor
           * mit dem abgewiesenen Raum zurueck und meldete das Board als nicht gefunden.
           */
          key={`${routeWorkspace.id}:${route.boardId}:${String(route.version ?? 0)}`}
          boardId={route.boardId}
          csrfToken={me.csrfToken}
          workspaceArchived={routeWorkspace.status === 'archived'}
          previewVersion={route.version}
          guestName={null}
          member={{
            me,
            workspace: routeWorkspace,
            workspaces,
            panel: route.panel,
            onPanel: openPanel,
            onChanged: explorer.reload,
            onPreview: (version) => {
              navigate({
                kind: 'board',
                workspaceId: routeWorkspace.id,
                boardId: route.boardId,
                version,
                panel: version === null ? route.panel : null,
              })
            },
          }}
          onClose={() => {
            navigateBack(back)
          }}
        />
      </Suspense>
    )
  }

  const navShown = wide ? !collapsed : navOpen
  const navLabel = wide
    ? collapsed
      ? 'Explorer ausklappen'
      : 'Explorer einklappen'
    : navOpen
      ? 'Navigation schliessen'
      : 'Navigation oeffnen'

  return (
    <div className={wide && collapsed ? 'app app--eingeklappt' : 'app'}>
      <a className="skip" href="#inhalt">
        Zum Inhalt springen
      </a>
      <Header
        me={me}
        route={route}
        navId={NAV_ID}
        navShown={navShown}
        navLabel={navLabel}
        onSignedOut={onSignedOut}
        onToggleNav={() => {
          if (wide) {
            setCollapsed((was) => {
              writeCollapsed(!was)
              return !was
            })
            return
          }
          setNavOpen((was) => !was)
        }}
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
          <Sidebar
            me={me}
            workspaces={workspaces}
            active={activeWorkspace}
            route={route}
            explorer={explorer}
            onWorkspaceCreated={(workspace) => {
              // Der neue Arbeitsbereich steht sofort in der Liste; sonst meldete die Zielansicht ihn bis zum
              // Neuladen als unbekannt.
              setWorkspaces((was) => [...(was ?? []), workspace])
              navigate({ kind: 'arbeitsbereich', workspaceId: workspace.id, folder: null })
              load()
            }}
          />
        </div>
      </Drawer>
      <main className="app__main" id="inhalt" tabIndex={-1}>
        {error !== null && <LoadFailed text={error} onRetry={load} />}
        <Content
          me={me}
          route={route}
          workspaces={workspaces}
          workspace={routeWorkspace}
          explorer={explorer}
          onWorkspacesChanged={load}
          onProfileChanged={onReload}
          onAppearanceChanged={onAppearanceChanged}
          onBoardsChanged={explorer.reload}
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

  // Das Erscheinungsbild folgt dem Profil: angemeldet die Wahl des Kontos, abgemeldet die Standardwahl.
  // Waehrend des Ladens bleibt stehen, was schon gilt - sonst blitzte ein Neuladen auf.
  const appearance = state.kind === 'authenticated' ? state.me.appearance : state.kind === 'anonymous' ? null : undefined
  useEffect(() => {
    if (appearance !== undefined) {
      applyAppearance(appearance)
    }
  }, [appearance])

  /** Eine gespeicherte Wahl gilt sofort; das Profil wird dafuer nicht neu geladen. */
  const changeAppearance = useCallback((next: AppearanceView) => {
    setState((current) =>
      current.kind === 'authenticated' ? { kind: 'authenticated', me: { ...current.me, appearance: next } } : current,
    )
  }, [])

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
  // Ohne belegten zweiten Faktor lehnt der Server alles ausser Profil, Abmeldung und Faktor ab; die Huelle
  // kaeme gar nicht erst zustande. Also zuerst Einrichtung oder Abfrage.
  const factor = state.me.secondFactor.state
  if (factor === 'setup-required' || factor === 'verification-required') {
    return <SecondFactorGate me={state.me} onDone={load} onSignedOut={load} />
  }
  return <Shell me={state.me} onSignedOut={load} onReload={load} onAppearanceChanged={changeAppearance} />
}

export function App() {
  // Gast und Einladung haben eine feste Adresse, die sich waehrend ihrer Sitzung nicht aendert; die
  // Entscheidung faellt deshalb einmal und vor jedem Sitzungszustand.
  if (window.location.pathname === GUEST_APP_PATH) {
    return <GuestApp />
  }
  if (window.location.pathname === INVITE_APP_PATH) {
    return <InviteApp purpose="invitation" />
  }
  if (window.location.pathname === RECOVERY_APP_PATH) {
    return <InviteApp purpose="recovery" />
  }
  return <MemberApp />
}
