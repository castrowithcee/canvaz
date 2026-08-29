/**
 * Arbeitsbereiche und Mitgliederverwaltung.
 *
 * Die Oberflaeche blendet aus, was die eigene Rolle nicht traegt - das ist Bequemlichkeit, keine
 * Sicherheitsgrenze. Jede Aktion wird serverseitig entschieden, und jede Ablehnung wird hier als Text
 * gezeigt, statt sie zu verschlucken.
 *
 * Jede Ansicht hat genau **eine** Hauptaktion. Was sich nicht zuruecknehmen laesst - ein Mitglied entfernen,
 * einen Arbeitsbereich archivieren - steht als eigene, gefaehrliche Aktion getrennt davon und nennt seine
 * Folge in einem modalen Dialog, bevor es geschieht.
 */

import { useCallback, useEffect, useState } from 'react'
import { Archive, ArchiveRestore, RotateCcw, Search, Trash2, UserPlus } from 'lucide-react'

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
import { Dialog } from './overlays.js'
import { Link } from './router.js'
import { Badge, Button, describedBy, Field, Notice, PageState, TableSkeleton } from './ui.js'

const ROLE_LABELS: Readonly<Record<WorkspaceRoleView, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Mitglied',
}

const ROLES: readonly WorkspaceRoleView[] = ['owner', 'admin', 'member']

const MEMBER_COLUMNS = ['Name', 'E-Mail', 'Rolle', 'Aktion']

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

/** Rolle und Zustand als Marke: beide werden gelesen, nicht bedient. */
function RoleBadge({ role }: { readonly role: WorkspaceRoleView | null }) {
  return role === null ? <span>—</span> : <Badge tone={role === 'owner' ? 'accent' : 'neutral'}>{ROLE_LABELS[role]}</Badge>
}

function StatusBadge({ status }: { readonly status: WorkspaceView['status'] }) {
  return status === 'active' ? <Badge tone="success">aktiv</Badge> : <Badge>archiviert</Badge>
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
      <Field id="workspace-name" label="Name des neuen Arbeitsbereichs">
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
      </Field>
      <p>
        <Button variant="primary" type="submit" busy={busy} disabled={name.trim().length === 0}>
          Arbeitsbereich anlegen
        </Button>
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
        <Field
          id="member-search"
          label="Nutzer suchen (E-Mail-Adresse oder vollstaendiger Anzeigename)"
          hint={`Mindestens ${String(WORKSPACE_MEMBER_QUERY_MIN_LENGTH)} Zeichen. Es gibt bewusst keine Liste aller Nutzer: angezeigt werden nur genaue Treffer, hoechstens ${String(WORKSPACE_MEMBER_MAX_CANDIDATES)}.`}
        >
          <input
            id="member-search"
            type="search"
            aria-describedby={describedBy('member-search', true, false)}
            value={query}
            maxLength={320}
            onChange={(event) => {
              setQuery(event.target.value)
            }}
          />
        </Field>
        <p>
          {/* Die Suche ist der Zwischenschritt; die Hauptaktion dieser Ansicht ist das Hinzufuegen. */}
          <Button icon={Search} type="submit" busy={search.kind === 'searching'} disabled={!searchable}>
            Suchen
          </Button>
        </p>
      </form>

      {search.kind === 'found' && search.users.length === 0 && (
        <PageState
          kind="no-results"
          title="Kein Treffer"
          description="Adresse oder Anzeigename muessen genau stimmen."
        />
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
          <Field id="member-role" label="Rolle">
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
          </Field>
          <p>
            <Button variant="primary" icon={UserPlus} type="submit" busy={busy} disabled={userId === ''}>
              Mitglied hinzufuegen
            </Button>
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
  const [confirmRemove, setConfirmRemove] = useState(false)

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
          <RoleBadge role={member.role} />
        )}
      </td>
      <td>
        {editable && (
          <span className="actions">
            <Button
              busy={busy}
              disabled={role === member.role}
              aria-label={`Rolle von ${member.displayName} speichern`}
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
              Rolle speichern
            </Button>
            <Button
              variant="danger"
              icon={Trash2}
              busy={busy}
              aria-label={`${member.displayName} entfernen`}
              onClick={() => {
                setConfirmRemove(true)
              }}
            >
              Entfernen
            </Button>
          </span>
        )}
        {editable && (
          <Dialog
              open={confirmRemove}
              danger
              title="Mitglied entfernen"
              onClose={() => {
                setConfirmRemove(false)
              }}
            >
              <p>
                <strong>{member.displayName}</strong> verliert damit jeden Zugang zu diesem Arbeitsbereich und
                zu den Boards, die nur darueber freigegeben sind. Die Boards selbst bleiben bestehen.
              </p>
              <p className="actions">
                <Button
                  variant="danger"
                  icon={Trash2}
                  busy={busy}
                  onClick={() => {
                    setConfirmRemove(false)
                    run(
                      removeWorkspaceMember(me.csrfToken, {
                        workspaceId: workspace.id,
                        userId: member.userId,
                      }),
                      'Das Mitglied konnte nicht entfernt werden.',
                    )
                  }}
                >
                  Endgueltig entfernen
                </Button>
                <Button
                  variant="quiet"
                  onClick={() => {
                    setConfirmRemove(false)
                  }}
                >
                  Abbrechen
                </Button>
              </p>
          </Dialog>
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
  const [confirmArchive, setConfirmArchive] = useState(false)

  useEffect(() => {
    setName(workspace.name)
  }, [workspace.name])

  const canManage = workspace.role === 'owner' || workspace.role === 'admin' || me.user.isSystemAdmin
  const canArchive = workspace.role === 'owner' || me.user.isSystemAdmin
  const active = workspace.status === 'active'

  function changeStatus(): void {
    setConfirmArchive(false)
    setError(null)
    setWorkspaceStatus(me.csrfToken, {
      workspaceId: workspace.id,
      status: active ? 'archived' : 'active',
    })
      .then(onChanged)
      .catch((cause: unknown) => {
        setError(messageOf(cause, 'Der Status konnte nicht geaendert werden.'))
      })
  }

  return (
    <section aria-labelledby="workspace-settings-heading">
      <h2 id="workspace-settings-heading">
        Einstellungen: {workspace.name} <StatusBadge status={workspace.status} />
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
          <Field id="workspace-rename" label="Arbeitsbereich umbenennen">
            <input
              id="workspace-rename"
              value={name}
              maxLength={80}
              required
              onChange={(event) => {
                setName(event.target.value)
              }}
            />
          </Field>
          <p>
            <Button variant="primary" type="submit" disabled={name.trim().length === 0}>
              Namen speichern
            </Button>
          </p>
        </form>
      )}

      {canArchive && (
        <p>
          <Button
            variant={active ? 'danger' : 'normal'}
            icon={active ? Archive : ArchiveRestore}
            onClick={() => {
              setConfirmArchive(true)
            }}
          >
            {active ? 'Arbeitsbereich archivieren' : 'Archivierung aufheben'}
          </Button>
        </p>
      )}

      <Dialog
        open={confirmArchive}
        danger={active}
        title={active ? 'Arbeitsbereich archivieren' : 'Archivierung aufheben'}
        onClose={() => {
          setConfirmArchive(false)
        }}
      >
        <p>
          {active
            ? `"${workspace.name}" bleibt danach lesbar, laesst sich aber nicht mehr aendern: keine neuen Boards, keine Mitgliederaenderung, keine Bearbeitung.`
            : `"${workspace.name}" wird wieder aenderbar. Boards, Ordner und Mitgliedschaften bleiben, wie sie sind.`}
        </p>
        <p className="actions">
          <Button variant={active ? 'danger' : 'primary'} icon={active ? Archive : ArchiveRestore} onClick={changeStatus}>
            {active ? 'Jetzt archivieren' : 'Jetzt wieder freigeben'}
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              setConfirmArchive(false)
            }}
          >
            Abbrechen
          </Button>
        </p>
      </Dialog>

      {!canManage && !canArchive && (
        <PageState
          kind="forbidden"
          title="Keine Einstellungen fuer deine Rolle"
          description="Deine Rolle traegt keine Einstellungen dieses Arbeitsbereichs."
        />
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
      {/* Die Tabelle steht fest; sie laedt in ihrer eigenen Form und nicht als Drehmarke. */}
      {state.kind === 'loading' && (
        <TableSkeleton columns={MEMBER_COLUMNS} label="Mitglieder werden geladen …" />
      )}
      {state.kind === 'failed' && (
        <PageState kind="error" title="Das hat nicht geklappt" description={state.message}>
          <Button variant="primary" icon={RotateCcw} onClick={load}>
            Erneut laden
          </Button>
        </PageState>
      )}
      {actionError !== null && <Notice text={actionError} />}

      {state.kind === 'ready' && (
        <>
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Mitglieder von {workspace.name}</caption>
              <thead>
                <tr>
                  {MEMBER_COLUMNS.map((column) => (
                    <th key={column} scope="col">
                      {column}
                    </th>
                  ))}
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
        <PageState
          kind="empty"
          title="Noch kein Arbeitsbereich"
          description="Du gehoerst noch keinem Arbeitsbereich an. Lege den ersten an."
        />
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
                  <td>
                    <RoleBadge role={workspace.role} />
                  </td>
                  <td>
                    <StatusBadge status={workspace.status} />
                  </td>
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
