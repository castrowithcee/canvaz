/**
 * Arbeitsbereiche und Mitgliederverwaltung.
 *
 * Die Oberflaeche blendet aus, was die eigene Rolle nicht traegt - das ist Bequemlichkeit, keine
 * Sicherheitsgrenze. Jede Aktion wird serverseitig entschieden, und jede Ablehnung wird hier als Text
 * gezeigt, statt sie zu verschlucken. Bewusst ohne UI-Framework und ohne Dialoge: Formulare stehen im
 * Fluss der Seite, damit es keine Fokusfalle und keine eigene Escape-Behandlung braucht.
 */

import { useCallback, useEffect, useState } from 'react'

import type {
  MeResponse,
  WorkspaceMemberView,
  WorkspaceRoleView,
  WorkspaceView,
  DirectoryUserView,
} from '../contracts/api.js'
import { WORKSPACE_MEMBER_MAX_CANDIDATES, WORKSPACE_MEMBER_QUERY_MIN_LENGTH } from '../contracts/api.js'
import {
  ApiError,
  addWorkspaceMember,
  changeWorkspaceMemberRole,
  createWorkspace,
  fetchMemberCandidates,
  fetchWorkspaceMembers,
  removeWorkspaceMember,
  renameWorkspace,
  setWorkspaceStatus,
} from './api.js'
import { Link } from './router.js'
import { Empty, Loading, Notice } from './ui.js'

const ROLE_LABELS: Readonly<Record<WorkspaceRoleView, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Mitglied',
}

const ROLES: readonly WorkspaceRoleView[] = ['owner', 'admin', 'member']

/**
 * Uebersetzt eine Serverantwort in einen Satz. 404 und 403 bekommen bewusst eigene Texte: das eine heisst
 * "gibt es fuer dich nicht", das andere "gibt es, aber nicht fuer diese Aktion".
 */
function messageOf(cause: unknown, fallback: string): string {
  if (!(cause instanceof ApiError)) {
    return fallback
  }
  if (cause.status === 404) {
    return 'Dieser Arbeitsbereich ist nicht (mehr) fuer dich freigegeben oder existiert nicht.'
  }
  if (cause.status === 403) {
    return `Dafuer fehlt dir die Berechtigung. ${cause.message}`
  }
  return cause.message
}

function CreateWorkspace({ me, onCreated }: { readonly me: MeResponse; readonly onCreated: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <form
      className="stack card"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        createWorkspace(me.csrfToken, name)
          .then(() => {
            setName('')
            onCreated()
          })
          .catch((cause: unknown) => {
            setError(messageOf(cause, 'Der Arbeitsbereich konnte nicht angelegt werden.'))
          })
          .finally(() => {
            setBusy(false)
          })
      }}
    >
      <div className="field">
        <label htmlFor="workspace-name">Name des neuen Arbeitsbereichs</label>
        <input
          id="workspace-name"
          name="name"
          value={name}
          maxLength={80}
          required
          onChange={(event) => {
            setName(event.target.value)
          }}
        />
      </div>
      <p>
        <button className="button--primary" type="submit" disabled={busy || name.trim().length === 0}>
          Arbeitsbereich anlegen
        </button>
      </p>
      {error !== null && <Notice text={error} />}
    </form>
  )
}

/**
 * Aufnahme eines Mitglieds ueber eine gezielte Suche.
 *
 * Bewusst keine Auswahlliste aller Nutzer: das interne Verzeichnis ist keine Auskunft fuer jeden
 * Angemeldeten. Gesucht wird nach der Adresse oder dem vollstaendigen Anzeigenamen, und der Server liefert
 * nur genaue Treffer. Ohne Suche bleibt die Ansicht leer.
 */
function AddMember({
  me,
  workspace,
  canAssignOwner,
  onAdded,
}: {
  readonly me: MeResponse
  readonly workspace: WorkspaceView
  readonly canAssignOwner: boolean
  readonly onAdded: () => void
}) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<
    | { readonly kind: 'idle' }
    | { readonly kind: 'searching' }
    | { readonly kind: 'found'; readonly users: readonly DirectoryUserView[] }
    | { readonly kind: 'failed'; readonly message: string }
  >({ kind: 'idle' })
  const [userId, setUserId] = useState('')
  const [role, setRole] = useState<WorkspaceRoleView>('member')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const term = query.trim()
  const searchable = term.length >= WORKSPACE_MEMBER_QUERY_MIN_LENGTH

  function runSearch(): void {
    setError(null)
    setUserId('')
    setSearch({ kind: 'searching' })
    fetchMemberCandidates(workspace.id, term)
      .then((response) => {
        setSearch({ kind: 'found', users: response.users })
        setUserId(response.users[0]?.id ?? '')
      })
      .catch((cause: unknown) => {
        setSearch({ kind: 'failed', message: messageOf(cause, 'Die Nutzersuche ist fehlgeschlagen.') })
      })
  }

  const assignable = canAssignOwner ? ROLES : ROLES.filter((candidate) => candidate !== 'owner')

  return (
    <>
      <form
        className="stack card"
        onSubmit={(event) => {
          event.preventDefault()
          runSearch()
        }}
      >
        <div className="field">
          <label htmlFor="member-search">Nutzer suchen (E-Mail-Adresse oder vollstaendiger Anzeigename)</label>
          <input
            id="member-search"
            type="search"
            aria-describedby="member-search-hint"
            value={query}
            maxLength={320}
            onChange={(event) => {
              setQuery(event.target.value)
            }}
          />
        </div>
        <p className="hint" id="member-search-hint">
          Mindestens {String(WORKSPACE_MEMBER_QUERY_MIN_LENGTH)} Zeichen. Es gibt bewusst keine Liste aller
          Nutzer: angezeigt werden nur genaue Treffer, hoechstens {String(WORKSPACE_MEMBER_MAX_CANDIDATES)}.
        </p>
        <p>
          <button className="button--primary" type="submit" disabled={!searchable}>
            Suchen
          </button>
        </p>
      </form>

      {search.kind === 'searching' && <Loading text="Es wird gesucht …" />}
      {search.kind === 'found' && search.users.length === 0 && (
        <Empty text="Kein Treffer. Adresse oder Anzeigename muessen genau stimmen." />
      )}
      {search.kind === 'failed' && <Notice text={search.message} />}

      {search.kind === 'found' && search.users.length > 0 && (
        <form
          className="stack card"
          onSubmit={(event) => {
            event.preventDefault()
            setBusy(true)
            setError(null)
            addWorkspaceMember(me.csrfToken, { workspaceId: workspace.id, userId, role })
              .then(() => {
                onAdded()
                // Erneut suchen: der aufgenommene Nutzer ist jetzt Mitglied und faellt aus den Treffern.
                runSearch()
              })
              .catch((cause: unknown) => {
                setError(messageOf(cause, 'Das Mitglied konnte nicht hinzugefuegt werden.'))
              })
              .finally(() => {
                setBusy(false)
              })
          }}
        >
          <fieldset>
            <legend>Treffer</legend>
            {search.users.map((user) => (
              <p key={user.id}>
                <input
                  type="radio"
                  id={`member-candidate-${user.id}`}
                  name="member-candidate"
                  value={user.id}
                  checked={userId === user.id}
                  onChange={() => {
                    setUserId(user.id)
                  }}
                />{' '}
                <label htmlFor={`member-candidate-${user.id}`}>
                  {user.displayName}
                  {user.email === null ? '' : ` (${user.email})`}
                </label>
              </p>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor="member-role">Rolle</label>
            <select
              id="member-role"
              value={role}
              onChange={(event) => {
                setRole(event.target.value as WorkspaceRoleView)
              }}
            >
              {assignable.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {ROLE_LABELS[candidate]}
                </option>
              ))}
            </select>
          </div>
          <p>
            <button className="button--primary" type="submit" disabled={busy || userId === ''}>
              Mitglied hinzufuegen
            </button>
          </p>
          {error !== null && <Notice text={error} />}
        </form>
      )}
    </>
  )
}

function MemberRow({
  me,
  workspace,
  member,
  canManage,
  canAssignOwner,
  onChanged,
  onError,
}: {
  readonly me: MeResponse
  readonly workspace: WorkspaceView
  readonly member: WorkspaceMemberView
  readonly canManage: boolean
  readonly canAssignOwner: boolean
  readonly onChanged: () => void
  readonly onError: (message: string) => void
}) {
  const [role, setRole] = useState<WorkspaceRoleView>(member.role)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setRole(member.role)
  }, [member.role])

  const assignable = canAssignOwner ? ROLES : ROLES.filter((candidate) => candidate !== 'owner')
  const editable = canManage && (canAssignOwner || member.role !== 'owner') && workspace.status === 'active'

  function run(action: Promise<unknown>, fallback: string): void {
    setBusy(true)
    action
      .then(onChanged)
      .catch((cause: unknown) => {
        onError(messageOf(cause, fallback))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <tr>
      <td>{member.displayName}</td>
      <td>{member.email ?? '—'}</td>
      <td>
        {editable ? (
          <select
            aria-label={`Rolle von ${member.displayName}`}
            value={role}
            onChange={(event) => {
              setRole(event.target.value as WorkspaceRoleView)
            }}
          >
            {assignable.map((candidate) => (
              <option key={candidate} value={candidate}>
                {ROLE_LABELS[candidate]}
              </option>
            ))}
          </select>
        ) : (
          ROLE_LABELS[member.role]
        )}
      </td>
      <td>
        {editable && (
          <span className="actions">
            <button
              type="button"
              disabled={busy || role === member.role}
              onClick={() => {
                run(
                  changeWorkspaceMemberRole(me.csrfToken, {
                    workspaceId: workspace.id,
                    userId: member.userId,
                    role,
                  }),
                  'Die Rolle konnte nicht geaendert werden.',
                )
              }}
            >
              Rolle von {member.displayName} speichern
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                run(
                  removeWorkspaceMember(me.csrfToken, { workspaceId: workspace.id, userId: member.userId }),
                  'Das Mitglied konnte nicht entfernt werden.',
                )
              }}
            >
              {member.displayName} entfernen
            </button>
          </span>
        )}
      </td>
    </tr>
  )
}

/**
 * Einstellungen eines Arbeitsbereichs: Name und Archivzustand.
 *
 * Was angeboten wird, richtet sich nach der vom Server genannten Rolle - Bequemlichkeit, keine Grenze.
 */
export function WorkspaceSettings({
  me,
  workspace,
  onChanged,
}: {
  readonly me: MeResponse
  readonly workspace: WorkspaceView
  readonly onChanged: () => void
}) {
  const [name, setName] = useState(workspace.name)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setName(workspace.name)
  }, [workspace.name])

  const canManage = workspace.role === 'owner' || workspace.role === 'admin' || me.user.isSystemAdmin
  const canArchive = workspace.role === 'owner' || me.user.isSystemAdmin
  const active = workspace.status === 'active'

  return (
    <section aria-labelledby="workspace-settings-heading">
      <h2 id="workspace-settings-heading">
        Einstellungen: {workspace.name}
        {active ? '' : ' (archiviert)'}
      </h2>
      {!active && <p className="hint">Ein archivierter Arbeitsbereich ist lesbar, aber nicht mehr aenderbar.</p>}
      {error !== null && <Notice text={error} />}

      {canManage && active && (
        <form
          className="stack card"
          onSubmit={(event) => {
            event.preventDefault()
            setError(null)
            renameWorkspace(me.csrfToken, { workspaceId: workspace.id, name })
              .then(onChanged)
              .catch((cause: unknown) => {
                setError(messageOf(cause, 'Der Arbeitsbereich konnte nicht umbenannt werden.'))
              })
          }}
        >
          <div className="field">
            <label htmlFor="workspace-rename">Arbeitsbereich umbenennen</label>
            <input
              id="workspace-rename"
              value={name}
              maxLength={80}
              required
              onChange={(event) => {
                setName(event.target.value)
              }}
            />
          </div>
          <p>
            <button className="button--primary" type="submit" disabled={name.trim().length === 0}>
              Namen speichern
            </button>
          </p>
        </form>
      )}

      {canArchive && (
        <p>
          <button
            type="button"
            onClick={() => {
              setError(null)
              setWorkspaceStatus(me.csrfToken, {
                workspaceId: workspace.id,
                status: active ? 'archived' : 'active',
              })
                .then(onChanged)
                .catch((cause: unknown) => {
                  setError(messageOf(cause, 'Der Status konnte nicht geaendert werden.'))
                })
            }}
          >
            {active ? 'Arbeitsbereich archivieren' : 'Archivierung aufheben'}
          </button>
        </p>
      )}

      {!canManage && !canArchive && (
        <Empty text="Deine Rolle traegt keine Einstellungen dieses Arbeitsbereichs." />
      )}
    </section>
  )
}

/** Mitglieder eines Arbeitsbereichs: Liste, Rollenwechsel, Entfernen und Aufnahme. */
export function WorkspaceMembers({
  me,
  workspace,
  onChanged,
}: {
  readonly me: MeResponse
  readonly workspace: WorkspaceView
  /** Ruft die Huelle: eine Rollenaenderung kann die eigene Sicht auf den Arbeitsbereich veraendern. */
  readonly onChanged: () => void
}) {
  const [state, setState] = useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly members: readonly WorkspaceMemberView[] }
    | { readonly kind: 'failed'; readonly message: string }
  >({ kind: 'loading' })
  const [actionError, setActionError] = useState<string | null>(null)

  const workspaceId = workspace.id
  const load = useCallback(() => {
    setActionError(null)
    fetchWorkspaceMembers(workspaceId)
      .then((response) => {
        setState({ kind: 'ready', members: response.members })
      })
      .catch((cause: unknown) => {
        setState({ kind: 'failed', message: messageOf(cause, 'Die Mitglieder konnten nicht geladen werden.') })
      })
  }, [workspaceId])

  useEffect(load, [load])

  function reload(): void {
    load()
    onChanged()
  }

  const isOwner = workspace.role === 'owner'
  const canManage = isOwner || workspace.role === 'admin' || me.user.isSystemAdmin
  const canAssignOwner = isOwner || me.user.isSystemAdmin
  const active = workspace.status === 'active'

  return (
    <section aria-labelledby="workspace-members-heading">
      <h2 id="workspace-members-heading">Mitglieder: {workspace.name}</h2>
      {state.kind === 'loading' && <Loading text="Mitglieder werden geladen …" />}
      {state.kind === 'failed' && (
        <>
          <Notice text={state.message} />
          <p className="actions">
            <button type="button" onClick={load}>
              Erneut laden
            </button>
          </p>
        </>
      )}
      {actionError !== null && <Notice text={actionError} />}

      {state.kind === 'ready' && (
        <>
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Mitglieder von {workspace.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">E-Mail</th>
                  <th scope="col">Rolle</th>
                  <th scope="col">Aktion</th>
                </tr>
              </thead>
              <tbody>
                {state.members.map((member) => (
                  <MemberRow
                    key={member.userId}
                    me={me}
                    workspace={workspace}
                    member={member}
                    canManage={canManage}
                    canAssignOwner={canAssignOwner}
                    onChanged={reload}
                    onError={setActionError}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {canManage && active && (
            <>
              <h3>Mitglied hinzufuegen</h3>
              <AddMember me={me} workspace={workspace} canAssignOwner={canAssignOwner} onAdded={reload} />
            </>
          )}
        </>
      )}
    </section>
  )
}

/**
 * Arbeitsbereichsverwaltung: die eigenen Arbeitsbereiche und das Anlegen eines neuen.
 *
 * Die Liste kommt aus der Huelle - dieselbe, aus der die Seitenleiste ihre Eintraege nimmt. Eine zweite
 * Abfrage derselben Daten waere nur eine zweite Wahrheit.
 */
export function WorkspaceOverview({
  me,
  workspaces,
  onChanged,
}: {
  readonly me: MeResponse
  readonly workspaces: readonly WorkspaceView[]
  readonly onChanged: () => void
}) {
  return (
    <section aria-labelledby="workspaces-heading">
      <h2 id="workspaces-heading">Arbeitsbereiche</h2>
      {workspaces.length === 0 && (
        <Empty text="Du gehoerst noch keinem Arbeitsbereich an. Lege den ersten an." />
      )}
      {workspaces.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Arbeitsbereiche, denen du angehoerst</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Rolle</th>
                <th scope="col">Status</th>
                <th scope="col">Ansichten</th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((workspace) => (
                <tr key={workspace.id}>
                  <td>
                    <Link route={{ kind: 'arbeitsbereich', workspaceId: workspace.id, folder: null }}>
                      {workspace.name}
                    </Link>
                  </td>
                  <td>{workspace.role === null ? '—' : ROLE_LABELS[workspace.role]}</td>
                  <td>{workspace.status === 'active' ? 'aktiv' : 'archiviert'}</td>
                  <td>
                    <Link route={{ kind: 'mitglieder', workspaceId: workspace.id }}>Mitglieder</Link>
                    {' · '}
                    <Link route={{ kind: 'einstellungen', workspaceId: workspace.id }}>Einstellungen</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Neuen Arbeitsbereich anlegen</h3>
      <CreateWorkspace me={me} onCreated={onChanged} />
    </section>
  )
}
