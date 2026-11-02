/**
 * Own API keys in the account: create, see, revoke. Shown only with a release by the system admin.
 *
 * The key value lives only in the state of this component while the one-time view is open; it is never
 * stored, logged or written to the address bar.
 *
 * A key needs a fresh login. When the server answers with `fresh-login-required`, the session ends, the
 * sign-in follows, and a fixed marker in `sessionStorage` (no address, so nothing to redirect to) brings
 * the user back to the account.
 */

import { useCallback, useEffect, useState } from 'react'
import { Ban, Copy, KeyRound } from 'lucide-react'

import type {
  BoardView,
  FolderView,
  MeResponse,
  OwnApiKeyView,
  WorkspaceView,
} from '../contracts/api.js'
import { FRESH_LOGIN_REQUIRED_CODE } from '../contracts/api.js'
import { DEFAULT_API_KEY_LIFETIME_DAYS, MAX_API_KEY_LIFETIME_DAYS } from '../domain/identity/api-key.js'
import {
  ApiError,
  createOwnApiKey,
  fetchBoards,
  fetchFolders,
  fetchOwnApiKeys,
  fetchWorkspaces,
  logout,
  revokeOwnApiKey,
} from './api.js'
import { Dialog } from './overlays.js'
import { Badge, Button, Field, Notice, TableSkeleton } from './ui.js'

const RETURN_MARKER = 'canvaz.returnToAccount'

function markReturnToAccount(): void {
  try {
    window.sessionStorage.setItem(RETURN_MARKER, '1')
  } catch {
    // Without storage the user lands on the start page after sign-in; nothing else depends on it.
  }
}

/** True once after a sign-in that was triggered by a key request. */
export function consumeReturnToAccount(): boolean {
  try {
    const marked = window.sessionStorage.getItem(RETURN_MARKER) === '1'
    window.sessionStorage.removeItem(RETURN_MARKER)
    return marked
  } catch {
    return false
  }
}

const COLUMNS = ['Name', 'Ziel', 'Stufe', 'Ablauf', 'Zuletzt benutzt', 'Zustand', 'Aktion']

const LEVEL_LABELS: Record<'read' | 'edit', string> = { read: 'Lesen', edit: 'Bearbeiten' }

const TARGET_LABELS: Record<OwnApiKeyView['target']['kind'], string> = {
  workspace: 'Arbeitsbereich',
  folder: 'Ordner (mit Teilbaum)',
  board: 'Board',
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback
}

function StateBadge({ state }: { readonly state: OwnApiKeyView['state'] }) {
  switch (state) {
    case 'active':
      return <Badge tone="success">aktiv</Badge>
    case 'expired':
      return <Badge>abgelaufen</Badge>
    case 'revoked':
      return <Badge tone="danger">widerrufen</Badge>
  }
}

function IssuedValue({ name, value, onDone }: { readonly name: string; readonly value: string; readonly onDone: () => void }) {
  const [copied, setCopied] = useState<string | null>(null)

  return (
    <div className="stack card">
      <Notice
        kind="info"
        text={`Der Key "${name}" erscheint nur jetzt. Er wird nicht erneut angezeigt; bei Verlust widerrufst du ihn und legst einen neuen an.`}
      />
      <p>
        <code aria-label="API-Key-Wert">{value}</code>
      </p>
      <p className="actions">
        <Button
          icon={Copy}
          onClick={() => {
            navigator.clipboard
              .writeText(value)
              .then(() => {
                setCopied('Der Key steht in der Zwischenablage.')
              })
              .catch(() => {
                setCopied('Kopieren war nicht moeglich. Bitte den Key von Hand abschreiben.')
              })
          }}
        >
          Key kopieren
        </Button>
        <Button variant="primary" onClick={onDone}>
          Fertig
        </Button>
      </p>
      {copied !== null && (
        <p className="hint" role="status">
          {copied}
        </p>
      )}
    </div>
  )
}

export function ApiKeySettings({ me, onSignedOut }: { readonly me: MeResponse; readonly onSignedOut: () => void }) {
  const access = me.apiKeyAccess
  const [keys, setKeys] = useState<readonly OwnApiKeyView[] | null>(null)
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceView[]>([])
  const [folders, setFolders] = useState<readonly FolderView[]>([])
  const [boards, setBoards] = useState<readonly BoardView[]>([])
  const [name, setName] = useState('')
  const [kind, setKind] = useState<OwnApiKeyView['target']['kind']>('workspace')
  const [workspaceId, setWorkspaceId] = useState('')
  const [objectId, setObjectId] = useState('')
  const [level, setLevel] = useState<'read' | 'edit'>('read')
  const [days, setDays] = useState(String(DEFAULT_API_KEY_LIFETIME_DAYS))
  const [issued, setIssued] = useState<{ readonly name: string; readonly value: string } | null>(null)
  const [revokeFor, setRevokeFor] = useState<OwnApiKeyView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadKeys = useCallback(() => {
    fetchOwnApiKeys()
      .then((response) => {
        setKeys(response.keys)
      })
      .catch((cause: unknown) => {
        setKeys([])
        setError(messageOf(cause, 'Die API-Keys konnten nicht geladen werden.'))
      })
  }, [])

  useEffect(() => {
    if (access === 'off') {
      return
    }
    loadKeys()
    fetchWorkspaces()
      .then((response) => {
        setWorkspaces(response.workspaces)
        setWorkspaceId((current) => (current === '' ? (response.workspaces[0]?.id ?? '') : current))
      })
      .catch(() => {
        setWorkspaces([])
      })
  }, [access, loadKeys])

  useEffect(() => {
    setObjectId('')
    setFolders([])
    setBoards([])
    if (workspaceId === '' || kind === 'workspace') {
      return
    }
    const load =
      kind === 'folder'
        ? fetchFolders(workspaceId).then((response) => {
            setFolders(response.folders)
          })
        : fetchBoards(workspaceId, { status: 'active', query: '' }).then((response) => {
            setBoards(response.boards)
          })
    load.catch(() => {
      setError('Die Auswahl konnte nicht geladen werden.')
    })
  }, [kind, workspaceId])

  if (access === 'off') {
    return null
  }

  const targetId = kind === 'workspace' ? workspaceId : objectId
  const levels: readonly ('read' | 'edit')[] = access === 'edit' ? ['read', 'edit'] : ['read']

  function create(): void {
    setBusy(true)
    setError(null)
    createOwnApiKey(me.csrfToken, {
      name,
      target: { kind, id: targetId },
      level,
      lifetimeDays: Number(days),
    })
      .then((created) => {
        setIssued({ name: created.key.name, value: created.value })
        setName('')
        loadKeys()
      })
      .catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.code === FRESH_LOGIN_REQUIRED_CODE) {
          markReturnToAccount()
          logout(me.csrfToken).finally(onSignedOut)
          return
        }
        setError(messageOf(cause, 'Der API-Key konnte nicht angelegt werden.'))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  function revoke(key: OwnApiKeyView): void {
    setError(null)
    revokeOwnApiKey(me.csrfToken, { keyId: key.id })
      .then(loadKeys)
      .catch((cause: unknown) => {
        setError(messageOf(cause, 'Der API-Key konnte nicht widerrufen werden.'))
      })
  }

  return (
    <section aria-labelledby="api-keys">
      <h2 id="api-keys">API-Keys</h2>
      <p className="hint">
        Freigegeben bis zur Stufe {LEVEL_LABELS[access]}. Ein neuer Key
        verlangt eine Anmeldung, die hoechstens zehn Minuten zurueckliegt; sonst wirst du zur erneuten Anmeldung
        gefuehrt und kehrst danach hierher zurueck.
      </p>

      {issued !== null && (
        <IssuedValue
          name={issued.name}
          value={issued.value}
          onDone={() => {
            setIssued(null)
          }}
        />
      )}

      <form
        className="stack card"
        onSubmit={(event) => {
          event.preventDefault()
          create()
        }}
      >
        <Field id="api-key-name" label="Name">
          <input
            id="api-key-name"
            type="text"
            value={name}
            maxLength={60}
            required
            onChange={(event) => {
              setName(event.target.value)
            }}
          />
        </Field>
        <Field id="api-key-kind" label="Gilt fuer">
          <select
            id="api-key-kind"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as OwnApiKeyView['target']['kind'])
            }}
          >
            {Object.entries(TARGET_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="api-key-workspace" label="Arbeitsbereich">
          <select
            id="api-key-workspace"
            value={workspaceId}
            required
            onChange={(event) => {
              setWorkspaceId(event.target.value)
            }}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </Field>
        {kind !== 'workspace' && (
          <Field id="api-key-object" label={kind === 'folder' ? 'Ordner' : 'Board'}>
            <select
              id="api-key-object"
              value={objectId}
              required
              onChange={(event) => {
                setObjectId(event.target.value)
              }}
            >
              <option value="">Bitte waehlen</option>
              {kind === 'folder'
                ? folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))
                : boards.map((board) => (
                    <option key={board.id} value={board.id}>
                      {board.title}
                    </option>
                  ))}
            </select>
          </Field>
        )}
        <Field id="api-key-level" label="Stufe">
          <select
            id="api-key-level"
            value={level}
            onChange={(event) => {
              setLevel(event.target.value as 'read' | 'edit')
            }}
          >
            {levels.map((candidate) => (
              <option key={candidate} value={candidate}>
                {LEVEL_LABELS[candidate]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="api-key-days"
          label="Ablauf in Tagen"
          hint={`Standard ${String(DEFAULT_API_KEY_LIFETIME_DAYS)}, hoechstens ${String(MAX_API_KEY_LIFETIME_DAYS)}.`}
        >
          <input
            id="api-key-days"
            type="number"
            min={1}
            max={MAX_API_KEY_LIFETIME_DAYS}
            step={1}
            value={days}
            required
            aria-describedby="api-key-days-hint"
            onChange={(event) => {
              setDays(event.target.value)
            }}
          />
        </Field>
        <p>
          <Button variant="primary" icon={KeyRound} type="submit" busy={busy} disabled={targetId === ''}>
            API-Key anlegen
          </Button>
        </p>
        {error !== null && <Notice text={error} />}
      </form>

      {keys === null && <TableSkeleton columns={COLUMNS} label="API-Keys werden geladen …" />}
      {keys !== null && keys.length === 0 && <p className="hint">Noch kein API-Key angelegt.</p>}
      {keys !== null && keys.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Eigene API-Keys</caption>
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td data-label="Name">
                    {key.name} <span className="hint">({key.prefix}…)</span>
                  </td>
                  <td data-label="Ziel">
                    {TARGET_LABELS[key.target.kind]}: {key.target.name ?? 'nicht mehr sichtbar'}
                  </td>
                  <td data-label="Stufe">{LEVEL_LABELS[key.level]}</td>
                  <td data-label="Ablauf">{new Date(key.expiresAt).toLocaleString('de-DE')}</td>
                  <td data-label="Zuletzt benutzt">
                    {key.lastUsedAt === null ? '—' : new Date(key.lastUsedAt).toLocaleString('de-DE')}
                  </td>
                  <td data-label="Zustand">
                    <StateBadge state={key.state} />
                  </td>
                  <td data-label="Aktion">
                    {key.state === 'active' && (
                      <Button
                        variant="danger"
                        icon={Ban}
                        aria-label={`API-Key ${key.name} widerrufen`}
                        onClick={() => {
                          setRevokeFor(key)
                        }}
                      >
                        Widerrufen
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={revokeFor !== null}
        danger
        title="API-Key widerrufen"
        onClose={() => {
          setRevokeFor(null)
        }}
      >
        <p>
          Der Key <strong>{revokeFor?.name}</strong> gilt danach nicht mehr und laesst sich nicht
          wiederherstellen.
        </p>
        <p className="actions">
          <Button
            variant="danger"
            icon={Ban}
            onClick={() => {
              const key = revokeFor
              setRevokeFor(null)
              if (key !== null) {
                revoke(key)
              }
            }}
          >
            API-Key widerrufen
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              setRevokeFor(null)
            }}
          >
            Abbrechen
          </Button>
        </p>
      </Dialog>
    </section>
  )
}
