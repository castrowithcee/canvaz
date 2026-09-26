/**
 * Kontenverwaltung der Systemadministration.
 *
 * Anlegen, Zugang uebergeben, zuruecksetzen, Einladung widerrufen, Selbstwiederherstellung per Mail
 * freischalten, aktivieren und deaktivieren. Die Ansicht
 * blendet nichts als Sicherheitsgrenze aus - jede Aktion wird serverseitig entschieden, und jede Ablehnung
 * erscheint hier als Text.
 *
 * Ein **Einladungslink erscheint genau einmal**, direkt nach seiner Erzeugung. Er wird nirgends
 * zwischengespeichert und ist danach nicht wieder abrufbar; ein verlorener Link wird widerrufen und neu
 * erzeugt. Ein Initialpasswort vergibt der Systemadmin selbst und uebergibt es ausserhalb der Anwendung -
 * die Instanz versendet nichts.
 *
 * Die Hauptaktion dieser Ansicht ist das Anlegen eines Kontos. Die Aktionen einer Zeile sind Nebenaktionen;
 * das Zuruecksetzen eines Passworts und das Widerrufen einer Einladung nennen ihre Folge in einem Dialog.
 */

import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Mail, MailCheck, MailX, RotateCcw, UserCheck, UserPlus, UserX } from 'lucide-react'

import type { AdminUserView, ClientAddressResponse, MeResponse } from '../contracts/api.js'
import { MIN_PASSWORD_LENGTH } from '../contracts/api.js'
import {
  ApiError,
  createUser,
  createUserInvitation,
  fetchAdminUsers,
  fetchClientAddress,
  resetUserPassword,
  revokeUserInvitation,
  setUserSelfRecovery,
  setUserStatus,
} from './api.js'
import { Dialog } from './overlays.js'
import { Badge, Button, Field, Notice, PageState, TableSkeleton } from './ui.js'

const USER_COLUMNS = ['Anzeigename', 'E-Mail', 'Status', 'Rolle', 'Zugang', 'Aktion']

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback
}

function StatusBadge({ status }: { readonly status: AdminUserView['status'] }) {
  return status === 'active' ? <Badge tone="success">aktiv</Badge> : <Badge tone="danger">deaktiviert</Badge>
}

function AccessBadge({ user }: { readonly user: AdminUserView }) {
  if (user.invitationExpiresAt !== null) {
    return (
      <Badge tone="accent">
        Einladung offen bis {new Date(user.invitationExpiresAt).toLocaleString('de-DE')}
      </Badge>
    )
  }
  return user.hasPassword ? <Badge>lokales Passwort</Badge> : <Badge>kein lokaler Zugang</Badge>
}

/** Ob die Selbstwiederherstellung frei ist und ob der Inhaber schon eine Adresse bestaetigt hat. */
function SelfRecoveryBadge({ user }: { readonly user: AdminUserView }) {
  if (!user.selfRecoveryAllowed) {
    return null
  }
  return user.recoveryEmailVerified ? (
    <Badge tone="success">Mail-Ruecksetzung frei</Badge>
  ) : (
    <Badge>Mail-Ruecksetzung frei, Adresse unbestaetigt</Badge>
  )
}

function ClientAddressClassBadge({ addressClass }: { readonly addressClass: ClientAddressResponse['addressClass'] }) {
  switch (addressClass) {
    case 'public':
      return <Badge tone="success">oeffentlich</Badge>
    case 'private':
      return <Badge tone="accent">privat</Badge>
    case 'loopback':
      return <Badge>Loopback</Badge>
    case 'proxy':
      return <Badge tone="accent">Proxy</Badge>
    case 'unknown':
      return <Badge tone="danger">unbekannt</Badge>
  }
}

const PLAUSIBILITY_TEXT: Readonly<Record<ClientAddressResponse['plausibility'], string>> = {
  plausible: 'Diese Instanz sieht insgesamt plausible oeffentliche Client-Adressen.',
  implausible:
    'Ueberwiegend nicht-oeffentliche Adressen - vermutlich fehlt die Weiterleitung der echten Client-Adresse.',
  unknown: 'Noch keine ausreichende Datengrundlage fuer ein Urteil.',
}

/**
 * Zeigt, welche Adresse die Anwendung fuer die aktuelle Anfrage ermittelt - zur Pruefung von
 * `CANVAZ_TRUSTED_PROXY` und der Weiterleitung durch den Reverse Proxy, unabhaengig davon, ob Docker
 * rootful oder rootless laeuft. Die Adresse wird nirgends gespeichert; jede Aktualisierung ermittelt sie neu.
 */
function ClientAddressCheck() {
  const [result, setResult] = useState<ClientAddressResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const load = useCallback(() => {
    setPending(true)
    setError(null)
    fetchClientAddress()
      .then((response) => {
        setResult(response)
      })
      .catch((cause: unknown) => {
        setError(messageOf(cause, 'Die Client-Adresse konnte nicht ermittelt werden.'))
      })
      .finally(() => {
        setPending(false)
      })
  }, [])

  useEffect(load, [load])

  return (
    <section aria-labelledby="client-address-heading">
      <h3 id="client-address-heading">Client-Adresse dieser Anfrage</h3>
      {error !== null && (
        <Notice>
          <p>{error}</p>
        </Notice>
      )}
      {result !== null && (
        <>
          <p className="actions">
            <code>{result.address}</code>
            <ClientAddressClassBadge addressClass={result.addressClass} />
            <Badge tone={result.trustedProxy ? 'accent' : 'neutral'}>
              CANVAZ_TRUSTED_PROXY={result.trustedProxy ? 'true' : 'false'}
            </Badge>
          </p>
          <p>{PLAUSIBILITY_TEXT[result.plausibility]}</p>
        </>
      )}
      <p className="actions">
        <Button icon={RotateCcw} onClick={load} busy={pending} aria-label="Client-Adresse erneut ermitteln">
          Erneut ermitteln
        </Button>
      </p>
    </section>
  )
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
      <Field id="konto-name" label="Anzeigename">
        <input
          id="konto-name"
          value={displayName}
          maxLength={80}
          required
          onChange={(event) => {
            setDisplayName(event.target.value)
          }}
        />
      </Field>
      <Field id="konto-adresse" label="E-Mail-Adresse (zugleich der Anmeldename)">
        <input
          id="konto-adresse"
          type="email"
          value={email}
          required
          onChange={(event) => {
            setEmail(event.target.value)
          }}
        />
      </Field>
      <Field id="konto-weg" label="Uebergabe">
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
      </Field>
      {mode === 'password' && (
        <Field
          id="konto-passwort"
          label={`Initialpasswort (mindestens ${String(MIN_PASSWORD_LENGTH)} Zeichen, Wechsel bei der ersten Anmeldung)`}
        >
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
        </Field>
      )}
      <p>
        <Button variant="primary" icon={UserPlus} type="submit" busy={busy}>
          Konto anlegen
        </Button>
      </p>
      {invitation !== null && <InvitationHint url={invitation} />}
      {error !== null && <Notice text={error} />}
    </form>
  )
}

/** Ruecksetzung auf ein neues Initialpasswort. Sie beendet jede Sitzung des Kontos. */
function ResetPasswordDialog({
  me,
  user,
  onClose,
  onDone,
}: {
  readonly me: MeResponse
  /** Das Konto, dessen Passwort zurueckgesetzt wird; `null` heisst: der Dialog ist geschlossen. */
  readonly user: AdminUserView | null
  readonly onClose: () => void
  readonly onDone: () => void
}) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fieldId = 'reset-passwort'

  // Der Dialog bleibt fuer die ganze Tabelle derselbe Knoten - damit der Fokus verlaesslich zu seinem
  // Ausloeser zurueckkehrt. Beim Wechsel des Kontos beginnt er trotzdem leer.
  useEffect(() => {
    setPassword('')
    setError(null)
  }, [user])

  return (
    <Dialog
      open={user !== null}
      danger
      title={user === null ? 'Passwort zuruecksetzen' : `Passwort von ${user.displayName} zuruecksetzen`}
      onClose={onClose}
    >
      {user !== null && (
      <form
        className="stack"
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
        <p>
          Alle bestehenden Sitzungen dieses Kontos enden. Beim naechsten Anmelden verlangt Canvaz sofort ein
          eigenes Passwort. Uebergib den Wert ausserhalb der Anwendung.
        </p>
        <Field id={fieldId} label={`Neues Initialpasswort fuer ${user.displayName}`}>
          <input
            id={fieldId}
            type="password"
            value={password}
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required
            onChange={(event) => {
              setPassword(event.target.value)
            }}
          />
        </Field>
        <p className="actions">
          <Button variant="primary" icon={KeyRound} type="submit" busy={busy}>
            Passwort setzen
          </Button>
          <Button variant="quiet" onClick={onClose}>
            Abbrechen
          </Button>
        </p>
        {error !== null && <Notice text={error} />}
      </form>
      )}
    </Dialog>
  )
}

export function AdminUsers({ me }: { readonly me: MeResponse }) {
  const [users, setUsers] = useState<readonly AdminUserView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [resetFor, setResetFor] = useState<AdminUserView | null>(null)
  const [revokeFor, setRevokeFor] = useState<AdminUserView | null>(null)
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
            <Button icon={RotateCcw} onClick={load}>
              Erneut laden
            </Button>
          </p>
        </Notice>
      )}

      <h3>Konto anlegen</h3>
      <CreateAccount me={me} onCreated={load} />

      <h3>Konten</h3>
      {invitation !== null && <InvitationHint url={invitation} />}
      {users === null && <TableSkeleton columns={USER_COLUMNS} label="Nutzer werden geladen …" />}
      {users !== null && users.length === 0 && error === null && (
        <PageState kind="empty" title="Noch keine Konten" description="Es gibt noch keine Nutzer." />
      )}
      {users !== null && users.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Alle Nutzer dieser Instanz</caption>
            <thead>
              <tr>
                {USER_COLUMNS.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
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
                    <td data-label="Name">{user.displayName}</td>
                    <td data-label="E-Mail">{user.email ?? '—'}</td>
                    <td data-label="Status">
                      <StatusBadge status={user.status} />
                    </td>
                    <td data-label="Rolle">
                      {user.isSystemAdmin ? <Badge tone="accent">Systemadmin</Badge> : <Badge>Nutzer</Badge>}
                    </td>
                    <td data-label="Zugang">
                      <span className="actions">
                        <AccessBadge user={user} />
                        <SelfRecoveryBadge user={user} />
                      </span>
                    </td>
                    <td data-label="Aktion">
                      <span className="actions">
                        <Button
                          icon={activate ? UserCheck : UserX}
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
                          disabled={isSelf && !activate}
                          busy={busy}
                          aria-describedby={reasonId}
                          aria-label={
                            activate
                              ? `${user.displayName} aktivieren`
                              : `${user.displayName} deaktivieren`
                          }
                        >
                          {activate ? 'Aktivieren' : 'Deaktivieren'}
                        </Button>
                        <Button
                          icon={Mail}
                          onClick={() => {
                            invite(user)
                          }}
                          busy={busy}
                          aria-label={`Einladung fuer ${user.displayName} erzeugen`}
                        >
                          Einladung erzeugen
                        </Button>
                        <Button
                          icon={KeyRound}
                          onClick={() => {
                            setResetFor(user)
                          }}
                          busy={busy}
                          aria-label={`Passwort von ${user.displayName} zuruecksetzen`}
                        >
                          Passwort zuruecksetzen
                        </Button>
                        {/* Der Systemadmin hat ausschliesslich den Betreiberweg; der Server lehnt es ohnehin ab. */}
                        {!user.isSystemAdmin && (
                          <Button
                            icon={user.selfRecoveryAllowed ? MailX : MailCheck}
                            onClick={() => {
                              run(
                                user.id,
                                setUserSelfRecovery(me.csrfToken, {
                                  userId: user.id,
                                  allowed: !user.selfRecoveryAllowed,
                                }),
                                'Die Freischaltung konnte nicht geaendert werden.',
                              )
                            }}
                            busy={busy}
                            aria-label={
                              user.selfRecoveryAllowed
                                ? `Mail-Ruecksetzung fuer ${user.displayName} abschalten`
                                : `Mail-Ruecksetzung fuer ${user.displayName} freischalten`
                            }
                          >
                            {user.selfRecoveryAllowed ? 'Mail-Ruecksetzung abschalten' : 'Mail-Ruecksetzung freischalten'}
                          </Button>
                        )}
                        {user.invitationExpiresAt !== null && (
                          <Button
                            variant="danger"
                            icon={MailX}
                            onClick={() => {
                              setRevokeFor(user)
                            }}
                            busy={busy}
                            aria-label={`Einladung fuer ${user.displayName} widerrufen`}
                          >
                            Einladung widerrufen
                          </Button>
                        )}
                      </span>
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
        </div>
      )}

      <ClientAddressCheck />

      <ResetPasswordDialog
        me={me}
        user={resetFor}
        onClose={() => {
          setResetFor(null)
        }}
        onDone={() => {
          setResetFor(null)
          load()
        }}
      />

      <Dialog
        open={revokeFor !== null}
        danger
        title="Einladung widerrufen"
        onClose={() => {
          setRevokeFor(null)
        }}
      >
        <p>
          Der bereits versendete Link fuer <strong>{revokeFor?.displayName}</strong> gilt danach nicht mehr
          und laesst sich nicht wiederherstellen. Fuer einen neuen Zugang wird eine neue Einladung erzeugt.
        </p>
        <p className="actions">
          <Button
            variant="danger"
            icon={MailX}
            onClick={() => {
              const user = revokeFor
              setRevokeFor(null)
              if (user !== null) {
                run(
                  user.id,
                  revokeUserInvitation(me.csrfToken, user.id),
                  'Die Einladung konnte nicht widerrufen werden.',
                )
              }
            }}
          >
            Einladung widerrufen
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
