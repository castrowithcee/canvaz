/**
 * Kontenverwaltung der Systemadministration.
 *
 * Anlegen, Zugang uebergeben, zuruecksetzen, Einladung widerrufen, aktivieren und deaktivieren. Die Ansicht
 * blendet nichts als Sicherheitsgrenze aus - jede Aktion wird serverseitig entschieden, und jede Ablehnung
 * erscheint hier als Text.
 *
 * Ein **Einladungslink erscheint genau einmal**, direkt nach seiner Erzeugung. Er wird nirgends
 * zwischengespeichert und ist danach nicht wieder abrufbar; ein verlorener Link wird widerrufen und neu
 * erzeugt. Ein Initialpasswort vergibt der Systemadmin selbst und uebergibt es ausserhalb der Anwendung -
 * die Instanz versendet nichts.
 */

import { useCallback, useEffect, useState } from 'react'

import type { AdminUserView, MeResponse } from '../contracts/api.js'
import { MIN_PASSWORD_LENGTH } from '../contracts/api.js'
import {
  ApiError,
  createUser,
  createUserInvitation,
  fetchAdminUsers,
  resetUserPassword,
  revokeUserInvitation,
  setUserStatus,
} from './api.js'
import { Empty, Loading, Notice } from './ui.js'

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback
}

function statusLabel(status: AdminUserView['status']): string {
  return status === 'active' ? 'aktiv' : 'deaktiviert'
}

function accessLabel(user: AdminUserView): string {
  if (user.invitationExpiresAt !== null) {
    return `Einladung offen bis ${new Date(user.invitationExpiresAt).toLocaleString('de-DE')}`
  }
  return user.hasPassword ? 'lokales Passwort' : 'kein lokaler Zugang'
}

/** Ein frisch erzeugter Einladungslink. Er steht genau hier und wird nirgends aufbewahrt. */
function InvitationHint({ url }: { readonly url: string }) {
  return (
    <Notice kind="success">
      <p>Einladungslink (gilt genau einmal, ausserhalb der Anwendung uebergeben):</p>
      <p>
        <code>{url}</code>
      </p>
    </Notice>
  )
}

function CreateAccount({ me, onCreated }: { readonly me: MeResponse; readonly onCreated: () => void }) {
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [mode, setMode] = useState<'invitation' | 'password'>('invitation')
  const [initialPassword, setInitialPassword] = useState('')
  const [invitation, setInvitation] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <form
      className="stack card"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        setInvitation(null)
        createUser(me.csrfToken, {
          displayName,
          email,
          ...(mode === 'password' ? { initialPassword } : {}),
        })
          .then((created) => {
            setDisplayName('')
            setEmail('')
            setInitialPassword('')
            setInvitation(created.invitationUrl)
            onCreated()
          })
          .catch((cause: unknown) => {
            setError(messageOf(cause, 'Das Konto konnte nicht angelegt werden.'))
          })
          .finally(() => {
            setBusy(false)
          })
      }}
    >
      <div className="field">
        <label htmlFor="konto-name">Anzeigename</label>
        <input
          id="konto-name"
          value={displayName}
          maxLength={80}
          required
          onChange={(event) => {
            setDisplayName(event.target.value)
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="konto-adresse">E-Mail-Adresse (zugleich der Anmeldename)</label>
        <input
          id="konto-adresse"
          type="email"
          value={email}
          required
          onChange={(event) => {
            setEmail(event.target.value)
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="konto-weg">Uebergabe</label>
        <select
          id="konto-weg"
          value={mode}
          onChange={(event) => {
            setMode(event.target.value === 'password' ? 'password' : 'invitation')
          }}
        >
          <option value="invitation">Befristeter Einladungslink</option>
          <option value="password">Initialpasswort</option>
        </select>
      </div>
      {mode === 'password' && (
        <div className="field">
          <label htmlFor="konto-passwort">
            Initialpasswort (mindestens {MIN_PASSWORD_LENGTH} Zeichen, Wechsel bei der ersten Anmeldung)
          </label>
          <input
            id="konto-passwort"
            type="password"
            value={initialPassword}
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required
            onChange={(event) => {
              setInitialPassword(event.target.value)
            }}
          />
        </div>
      )}
      <p>
        <button className="button--primary" type="submit" disabled={busy}>
          Konto anlegen
        </button>
      </p>
      {invitation !== null && <InvitationHint url={invitation} />}
      {error !== null && <Notice text={error} />}
    </form>
  )
}

/** Ruecksetzung auf ein neues Initialpasswort. Sie beendet jede Sitzung des Kontos. */
function ResetPassword({
  me,
  user,
  onDone,
}: {
  readonly me: MeResponse
  readonly user: AdminUserView
  readonly onDone: () => void
}) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <form
      className="stack card"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        resetUserPassword(me.csrfToken, { userId: user.id, password })
          .then(() => {
            setPassword('')
            onDone()
          })
          .catch((cause: unknown) => {
            setError(messageOf(cause, 'Das Passwort konnte nicht zurueckgesetzt werden.'))
          })
          .finally(() => {
            setBusy(false)
          })
      }}
    >
      <div className="field">
        <label htmlFor={`reset-${user.id}`}>Neues Initialpasswort fuer {user.displayName}</label>
        <input
          id={`reset-${user.id}`}
          type="password"
          value={password}
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
          onChange={(event) => {
            setPassword(event.target.value)
          }}
        />
      </div>
      <p>
        <button className="button--primary" type="submit" disabled={busy}>
          Passwort setzen
        </button>
      </p>
      {error !== null && <Notice text={error} />}
    </form>
  )
}

export function AdminUsers({ me }: { readonly me: MeResponse }) {
  const [users, setUsers] = useState<readonly AdminUserView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [resetFor, setResetFor] = useState<string | null>(null)
  const [invitation, setInvitation] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    fetchAdminUsers()
      .then((response) => {
        setUsers(response.users)
      })
      .catch((cause: unknown) => {
        setUsers([])
        setError(messageOf(cause, 'Die Nutzerliste konnte nicht geladen werden.'))
      })
  }, [])

  useEffect(load, [load])

  function run(userId: string, action: Promise<unknown>, fallback: string): void {
    setPendingId(userId)
    setError(null)
    action
      .then(() => {
        load()
      })
      .catch((cause: unknown) => {
        setError(messageOf(cause, fallback))
      })
      .finally(() => {
        setPendingId(null)
      })
  }

  function invite(user: AdminUserView): void {
    setPendingId(user.id)
    setError(null)
    setInvitation(null)
    createUserInvitation(me.csrfToken, user.id)
      .then((created) => {
        setInvitation(created.invitationUrl)
        load()
      })
      .catch((cause: unknown) => {
        setError(messageOf(cause, 'Die Einladung konnte nicht erzeugt werden.'))
      })
      .finally(() => {
        setPendingId(null)
      })
  }

  return (
    <section aria-labelledby="admin-heading">
      <h2 id="admin-heading">Systemadministration</h2>
      {error !== null && (
        <Notice>
          <p>{error}</p>
          <p className="actions">
            <button type="button" onClick={load}>
              Erneut laden
            </button>
          </p>
        </Notice>
      )}

      <h3>Konto anlegen</h3>
      <CreateAccount me={me} onCreated={load} />

      <h3>Konten</h3>
      {invitation !== null && <InvitationHint url={invitation} />}
      {users === null && <Loading text="Nutzer werden geladen …" />}
      {users !== null && users.length === 0 && error === null && <Empty text="Es gibt noch keine Nutzer." />}
      {users !== null && users.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Alle Nutzer dieser Instanz</caption>
            <thead>
              <tr>
                <th scope="col">Anzeigename</th>
                <th scope="col">E-Mail</th>
                <th scope="col">Status</th>
                <th scope="col">Rolle</th>
                <th scope="col">Zugang</th>
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
                const busy = pendingId === user.id
                return (
                  <tr key={user.id}>
                    <td>{user.displayName}</td>
                    <td>{user.email ?? '—'}</td>
                    <td>{statusLabel(user.status)}</td>
                    <td>{user.isSystemAdmin ? 'Systemadmin' : 'Nutzer'}</td>
                    <td>{accessLabel(user)}</td>
                    <td>
                      <span className="actions">
                        <button
                          type="button"
                          onClick={() => {
                            run(
                              user.id,
                              setUserStatus(me.csrfToken, {
                                userId: user.id,
                                status: activate ? 'active' : 'deactivated',
                              }),
                              'Die Aenderung konnte nicht gespeichert werden.',
                            )
                          }}
                          disabled={(isSelf && !activate) || busy}
                          aria-describedby={reasonId}
                        >
                          {activate ? `${user.displayName} aktivieren` : `${user.displayName} deaktivieren`}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            invite(user)
                          }}
                          disabled={busy}
                          aria-label={`Einladung fuer ${user.displayName} erzeugen`}
                        >
                          Einladung erzeugen
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setResetFor(resetFor === user.id ? null : user.id)
                          }}
                          disabled={busy}
                          aria-label={`Passwort von ${user.displayName} zuruecksetzen`}
                        >
                          Passwort zuruecksetzen
                        </button>
                        {user.invitationExpiresAt !== null && (
                          <button
                            type="button"
                            onClick={() => {
                              run(
                                user.id,
                                revokeUserInvitation(me.csrfToken, user.id),
                                'Die Einladung konnte nicht widerrufen werden.',
                              )
                            }}
                            disabled={busy}
                            aria-label={`Einladung fuer ${user.displayName} widerrufen`}
                          >
                            Einladung widerrufen
                          </button>
                        )}
                      </span>
                      {reasonId !== undefined && (
                        <p className="hint" id={reasonId}>
                          Ein Systemadmin kann sich nicht selbst deaktivieren.
                        </p>
                      )}
                      {resetFor === user.id && (
                        <ResetPassword
                          me={me}
                          user={user}
                          onDone={() => {
                            setResetFor(null)
                            load()
                          }}
                        />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
