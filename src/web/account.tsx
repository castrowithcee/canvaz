/**
 * Anmeldung, Einloesen einer Einladung, Passwortwechsel und das eigene Erscheinungsbild.
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
 *
 * Jede Ansicht hat genau **eine** Hauptaktion: den Weg, der hier weiterfuehrt. Der Weg ueber den Identity
 * Provider steht daneben als gewoehnliche Aktion.
 */

import { useCallback, useEffect, useState } from 'react'
import { Eye, EyeOff, KeyRound, LogIn, Palette } from 'lucide-react'

import type { AccentColor, AppearanceView, AuthMethodsResponse, ColorScheme, MeResponse } from '../contracts/api.js'
import { ACCENT_COLORS, AUTH_LOGIN_PATH, COLOR_SCHEMES, MIN_PASSWORD_LENGTH } from '../contracts/api.js'
import { ApiError, changePassword, fetchAuthMethods, localLogin, redeemInvitation, saveAppearance } from './api.js'
import { actionClass, Button, Field, IconButton, Notice } from './ui.js'

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback
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
  const [visible, setVisible] = useState(false)

  return (
    <Field id={id} label={label}>
      <div className="password-field">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          autoComplete={autoComplete}
          required
          minLength={autoComplete === 'new-password' ? MIN_PASSWORD_LENGTH : undefined}
          onChange={(event) => {
            onChange(event.target.value)
          }}
        />
        <IconButton
          label={visible ? `${label} verbergen` : `${label} anzeigen`}
          icon={visible ? EyeOff : Eye}
          variant="quiet"
          extraClass="password-field__toggle"
          aria-pressed={visible}
          onClick={() => {
            setVisible((was) => !was)
          }}
        />
      </div>
    </Field>
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
      className="stack card"
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
        <Button variant="primary" icon={KeyRound} type="submit" busy={busy}>
          Passwort setzen und anmelden
        </Button>
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
      className="stack card"
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
      <Field id="anmelde-adresse" label="E-Mail-Adresse">
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
      </Field>
      <PasswordField
        id="anmelde-passwort"
        label="Passwort"
        value={password}
        autoComplete="current-password"
        onChange={setPassword}
      />
      <p>
        <Button variant="primary" icon={LogIn} type="submit" busy={busy}>
          Anmelden
        </Button>
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
            {/* Gewoehnliche Aktion: die Hauptaktion dieser Seite ist und bleibt die lokale Anmeldung. */}
            <a className={actionClass()} href={AUTH_LOGIN_PATH}>
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

/** Texte je Zweck; Einloesung und Endpunkt sind dieselben. */
const REDEEM_TEXTS = {
  invitation: {
    heading: 'Einladung einloesen',
    note: null,
    incomplete: 'Dieser Einladungslink ist unvollstaendig. Bitte den vollstaendigen Link verwenden.',
    failed: 'Die Einladung konnte nicht eingeloest werden.',
  },
  recovery: {
    heading: 'Zugang wiederherstellen',
    note: 'Die Wiederherstellung entfernt den bisherigen zweiten Faktor; danach richtest du ihn neu ein.',
    incomplete: 'Dieser Wiederherstellungslink ist unvollstaendig. Bitte den vollstaendigen Link verwenden.',
    failed: 'Der Zugang konnte nicht wiederhergestellt werden.',
  },
} as const

export function InviteApp({ purpose }: { readonly purpose: keyof typeof REDEEM_TEXTS }) {
  const texts = REDEEM_TEXTS[purpose]
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
        <Notice text={texts.incomplete} />
      </main>
    )
  }

  return (
    <main className="shell">
      <h1>Canvaz</h1>
      <section aria-labelledby="einladung">
        <h2 id="einladung">{texts.heading}</h2>
        <form
          className="stack card"
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
                setError(messageOf(cause, texts.failed))
              })
          }}
        >
          <p>Bitte setze dein Passwort. Der Link gilt genau einmal.</p>
          {texts.note !== null && <p className="hint">{texts.note}</p>}
          <PasswordField
            id="einladung-passwort"
            label={`Passwort (mindestens ${String(MIN_PASSWORD_LENGTH)} Zeichen)`}
            value={password}
            autoComplete="new-password"
            onChange={setPassword}
          />
          <p>
            <Button variant="primary" icon={KeyRound} type="submit" busy={busy}>
              Passwort setzen und anmelden
            </Button>
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
      <form className="stack card" onSubmit={submit}>
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
          <Button variant="primary" icon={KeyRound} type="submit" busy={busy}>
            Passwort wechseln
          </Button>
        </p>
        {done && error === null && <Notice kind="success" text="Das Passwort wurde gewechselt." />}
        {error !== null && <Notice text={error} />}
      </form>
    </section>
  )
}

const COLOR_SCHEME_LABELS: Readonly<Record<ColorScheme, string>> = {
  system: 'System',
  light: 'Hell',
  dark: 'Dunkel',
}

const ACCENT_LABELS: Readonly<Record<AccentColor, string>> = {
  violett: 'Violett (Standard)',
  blau: 'Blau',
  petrol: 'Petrol',
  fuchsia: 'Fuchsia',
  graphit: 'Graphit',
}

/**
 * Farbschema und Akzentfarbe des eigenen Kontos.
 *
 * Die Wahl wird erst mit dem Speichern wirksam und gilt dann sofort, ohne Neuladen, und auf jedem Geraet,
 * auf dem sich dieses Konto anmeldet. Sie betrifft nur die Oberflaeche um die Zeichenflaeche herum; die
 * Zeichenflaeche selbst folgt allein dem Farbschema.
 */
export function AppearanceSettings({
  me,
  onChanged,
}: {
  readonly me: MeResponse
  readonly onChanged: (appearance: AppearanceView) => void
}) {
  const [colorScheme, setColorScheme] = useState<ColorScheme>(me.appearance.colorScheme)
  const [accent, setAccent] = useState<AccentColor>(me.appearance.accent)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  return (
    <section aria-labelledby="erscheinungsbild">
      <h2 id="erscheinungsbild">Erscheinungsbild</h2>
      <form
        className="stack card"
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setError(null)
          setDone(false)
          saveAppearance(me.csrfToken, { colorScheme, accent })
            .then((saved) => {
              setDone(true)
              onChanged(saved)
            })
            .catch((cause: unknown) => {
              setError(messageOf(cause, 'Das Erscheinungsbild konnte nicht gespeichert werden.'))
            })
            .finally(() => {
              setBusy(false)
            })
        }}
      >
        <fieldset>
          <legend>Farbschema</legend>
          <div className="choice-group">
            {COLOR_SCHEMES.map((value) => (
              <label key={value} className="choice">
                <input
                  type="radio"
                  name="farbschema"
                  value={value}
                  checked={colorScheme === value}
                  onChange={() => {
                    setColorScheme(value)
                    setDone(false)
                  }}
                />
                {COLOR_SCHEME_LABELS[value]}
              </label>
            ))}
          </div>
          <p className="hint">System folgt der Einstellung des Geraets und wechselt mit ihr.</p>
        </fieldset>
        <fieldset>
          <legend>Akzentfarbe</legend>
          <div className="choice-group">
            {ACCENT_COLORS.map((value) => (
              <label key={value} className="choice">
                <input
                  type="radio"
                  name="akzentfarbe"
                  value={value}
                  checked={accent === value}
                  onChange={() => {
                    setAccent(value)
                    setDone(false)
                  }}
                />
                <span className="choice__swatch" data-accent={value} aria-hidden="true" />
                {ACCENT_LABELS[value]}
              </label>
            ))}
          </div>
        </fieldset>
        <p>
          <Button variant="primary" icon={Palette} type="submit" busy={busy}>
            Erscheinungsbild speichern
          </Button>
        </p>
        {done && error === null && <Notice kind="success" text="Das Erscheinungsbild wurde gespeichert." />}
        {error !== null && <Notice text={error} />}
      </form>
    </section>
  )
}
