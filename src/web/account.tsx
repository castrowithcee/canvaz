/**
 * Anmeldung, Einloesen einer Einladung und Passwortwechsel.
 *
 * Die Anmeldeseite zeigt **nur die Wege, die es hier gibt**: der lokale immer, der externe nur mit
 * konfiguriertem Provider (`/api/auth/methods`). Was sie anbietet, entscheidet damit der Server und nicht
 * eine Annahme im Browser.
 *
 * Der erzwungene Wechsel nach einem Initialpasswort ist keine Anzeige dieser Datei: die Anmeldung liefert
 * dann gar keine Sitzung, und erst der Wechsel legt eine an. Die Oberflaeche zeigt nur, was ohnehin gilt.
 *
 * Kein Passwort und kein Einladungswert wird hier gespeichert, gemerkt oder in die Adresszeile geschrieben.
 * Der Einladungswert steht im Fragment der aufgerufenen Adresse und wird nach dem Lesen daraus entfernt.
 */

import { useCallback, useEffect, useState } from 'react'

import type { AuthMethodsResponse, MeResponse } from '../contracts/api.js'
import { AUTH_LOGIN_PATH, MIN_PASSWORD_LENGTH } from '../contracts/api.js'
import { ApiError, changePassword, fetchAuthMethods, localLogin, redeemInvitation } from './api.js'

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback
}

function Notice({ text }: { readonly text: string }) {
  return (
    <p className="notice notice--error" role="alert">
      {text}
    </p>
  )
}

function PasswordField({
  id,
  label,
  value,
  autoComplete,
  onChange,
}: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly autoComplete: 'current-password' | 'new-password'
  readonly onChange: (value: string) => void
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="password"
        value={value}
        autoComplete={autoComplete}
        required
        minLength={autoComplete === 'new-password' ? MIN_PASSWORD_LENGTH : undefined}
        onChange={(event) => {
          onChange(event.target.value)
        }}
      />
    </div>
  )
}

/**
 * Erzwungener Wechsel eines Initialpassworts.
 *
 * Er verlangt dasselbe Passwort noch einmal: der Server kennt an dieser Stelle keine Sitzung, und ohne den
 * bisherigen Wert wuerde ein fremder Aufruf genuegen.
 */
function ForcedPasswordChange({ email, onChanged }: { readonly email: string; readonly onChanged: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        changePassword({ email, currentPassword, newPassword })
          .then(onChanged)
          .catch((cause: unknown) => {
            setBusy(false)
            setError(messageOf(cause, 'Das Passwort konnte nicht gewechselt werden.'))
          })
      }}
    >
      <p>
        Dieses Konto hat ein vergebenes Passwort. Bitte setze jetzt ein eigenes; danach bist du angemeldet.
      </p>
      <PasswordField
        id="aktuelles-passwort"
        label="Vergebenes Passwort"
        value={currentPassword}
        autoComplete="current-password"
        onChange={setCurrentPassword}
      />
      <PasswordField
        id="neues-passwort"
        label={`Neues Passwort (mindestens ${String(MIN_PASSWORD_LENGTH)} Zeichen)`}
        value={newPassword}
        autoComplete="new-password"
        onChange={setNewPassword}
      />
      <p>
        <button type="submit" disabled={busy}>
          Passwort setzen und anmelden
        </button>
      </p>
      {error !== null && <Notice text={error} />}
    </form>
  )
}

function LocalLogin({ onSignedIn }: { readonly onSignedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mustChange, setMustChange] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (mustChange) {
    return <ForcedPasswordChange email={email} onChanged={onSignedIn} />
  }

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        localLogin({ email, password })
          .then((result) => {
            if (result.status === 'password-change-required') {
              setMustChange(true)
              setBusy(false)
              return
            }
            onSignedIn()
          })
          .catch((cause: unknown) => {
            setBusy(false)
            setError(messageOf(cause, 'Die Anmeldung ist fehlgeschlagen.'))
          })
      }}
    >
      <div className="field">
        <label htmlFor="anmelde-adresse">E-Mail-Adresse</label>
        <input
          id="anmelde-adresse"
          type="email"
          value={email}
          autoComplete="username"
          required
          onChange={(event) => {
            setEmail(event.target.value)
          }}
        />
      </div>
      <PasswordField
        id="anmelde-passwort"
        label="Passwort"
        value={password}
        autoComplete="current-password"
        onChange={setPassword}
      />
      <p>
        <button type="submit" disabled={busy}>
          Anmelden
        </button>
      </p>
      {error !== null && <Notice text={error} />}
    </form>
  )
}

export function LoginView({ error, onSignedIn }: { readonly error: string | null; readonly onSignedIn: () => void }) {
  const [methods, setMethods] = useState<AuthMethodsResponse | null>(null)

  useEffect(() => {
    fetchAuthMethods()
      .then(setMethods)
      // Faellt die Abfrage aus, bleibt der lokale Weg: er ist der einzige, den es immer gibt.
      .catch(() => {
        setMethods({ local: true, oidc: false })
      })
  }, [])

  return (
    <main className="shell">
      <h1>Canvaz</h1>
      {error !== null && <Notice text={error} />}
      <section aria-labelledby="anmeldung-lokal">
        <h2 id="anmeldung-lokal">Anmelden</h2>
        <LocalLogin onSignedIn={onSignedIn} />
      </section>
      {methods?.oidc === true && (
        <section aria-labelledby="anmeldung-extern">
          <h2 id="anmeldung-extern">Oder ueber den Identity Provider</h2>
          <p>
            <a className="button" href={AUTH_LOGIN_PATH}>
              Mit Identity Provider anmelden
            </a>
          </p>
        </section>
      )}
      <p className="hint">
        Konten legt die Systemadministration an. Eine Selbstregistrierung gibt es nicht.
      </p>
    </main>
  )
}

/** Der Einladungswert steht im Fragment; er wird einmal gelesen und danach aus der Adresszeile entfernt. */
function readInvitationToken(): string | null {
  const token = window.location.hash.replace(/^#/, '')
  return token.length === 0 ? null : token
}

export function InviteApp() {
  const [token] = useState(readInvitationToken)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (token !== null) {
      window.history.replaceState(null, '', window.location.pathname)
    }
  }, [token])

  if (token === null) {
    return (
      <main className="shell">
        <h1>Canvaz</h1>
        <Notice text="Dieser Einladungslink ist unvollstaendig. Bitte den vollstaendigen Link verwenden." />
      </main>
    )
  }

  return (
    <main className="shell">
      <h1>Canvaz</h1>
      <section aria-labelledby="einladung">
        <h2 id="einladung">Einladung einloesen</h2>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault()
            setBusy(true)
            setError(null)
            redeemInvitation({ token, password })
              .then(() => {
                // Nach dem Einloesen besteht eine Sitzung; die Anwendung startet auf der Startseite neu.
                window.location.assign('/')
              })
              .catch((cause: unknown) => {
                setBusy(false)
                setError(messageOf(cause, 'Die Einladung konnte nicht eingeloest werden.'))
              })
          }}
        >
          <p>Bitte setze dein Passwort. Der Link gilt genau einmal.</p>
          <PasswordField
            id="einladung-passwort"
            label={`Passwort (mindestens ${String(MIN_PASSWORD_LENGTH)} Zeichen)`}
            value={password}
            autoComplete="new-password"
            onChange={setPassword}
          />
          <p>
            <button type="submit" disabled={busy}>
              Passwort setzen und anmelden
            </button>
          </p>
          {error !== null && <Notice text={error} />}
        </form>
      </section>
    </main>
  )
}

/**
 * Freiwilliger Passwortwechsel eines angemeldeten Nutzers.
 *
 * Sichtbar nur mit Adresse am Profil: ohne sie gibt es keinen lokalen Anmeldenamen und damit nichts zu
 * wechseln - ein ausschliesslich extern angemeldetes Konto aendert sein Passwort beim Provider.
 */
export function PasswordSettings({ me, onChanged }: { readonly me: MeResponse; readonly onChanged: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const email = me.user.email

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault()
      if (email === null) {
        return
      }
      setBusy(true)
      setError(null)
      changePassword({ email, currentPassword, newPassword })
        .then(() => {
          setCurrentPassword('')
          setNewPassword('')
          setDone(true)
          // Der Wechsel beendet alle bisherigen Sitzungen und setzt eine neue: das Profil wird neu geladen.
          onChanged()
        })
        .catch((cause: unknown) => {
          setError(messageOf(cause, 'Das Passwort konnte nicht gewechselt werden.'))
        })
        .finally(() => {
          setBusy(false)
        })
    },
    [email, currentPassword, newPassword, onChanged],
  )

  if (email === null) {
    return null
  }

  return (
    <section aria-labelledby="passwort">
      <h2 id="passwort">Passwort</h2>
      <form className="stack" onSubmit={submit}>
        <PasswordField
          id="eigenes-aktuelles-passwort"
          label="Bisheriges Passwort"
          value={currentPassword}
          autoComplete="current-password"
          onChange={setCurrentPassword}
        />
        <PasswordField
          id="eigenes-neues-passwort"
          label={`Neues Passwort (mindestens ${String(MIN_PASSWORD_LENGTH)} Zeichen)`}
          value={newPassword}
          autoComplete="new-password"
          onChange={setNewPassword}
        />
        <p>
          <button type="submit" disabled={busy}>
            Passwort wechseln
          </button>
        </p>
        {done && error === null && <p className="hint">Das Passwort wurde gewechselt.</p>}
        {error !== null && <Notice text={error} />}
      </form>
    </section>
  )
}
