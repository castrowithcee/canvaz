/**
 * Zweiter Faktor des Systemadmins: Einrichtung, Abfrage nach der Anmeldung und Verwaltung im Konto.
 *
 * Die Oberflaeche zeigt nur, was ohnehin gilt: ohne belegten zweiten Faktor lehnt der Server jeden Endpunkt
 * ausser Profil, Abmeldung und diesen hier ab. Deshalb steht die Abfrage **vor** der Anwendungshuelle und
 * nicht in ihr - eine Huelle, deren Anfragen alle scheitern, waere nur eine verwirrende Fehlerseite.
 *
 * Kein Geheimnis und kein Ersatzcode wird hier gespeichert, gemerkt oder in die Adresszeile geschrieben.
 * Beides steht nur im Zustand der Komponente, solange die Ansicht es zeigt.
 *
 * Ein QR-Code fehlt bewusst: die Einrichtung macht genau ein Konto genau einmal, und jede Authenticator-App
 * nimmt den Schluessel auch zur Handeingabe oder ueber die `otpauth://`-Adresse an. Eine Bibliothek mehr im
 * Bundle traegt dafuer nicht genug.
 */

import { useState } from 'react'
import { Copy, KeyRound, LogOut, ShieldCheck } from 'lucide-react'

import type { MeResponse, SecondFactorEnrollResponse } from '../contracts/api.js'
import {
  ApiError,
  confirmSecondFactor,
  enrollSecondFactor,
  logout,
  renewBackupCodes,
  verifySecondFactor,
} from './api.js'
import { Button, Field, Notice } from './ui.js'

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback
}

/** Der Schluessel in Vierergruppen: so laesst er sich abtippen, ohne die Stelle zu verlieren. */
function grouped(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ')
}

/**
 * Eingabe eines Codes. Sechs Ziffern aus der App oder - wo erlaubt - ein Ersatzcode; der Browser bekommt
 * dafuer die passende Tastatur und den Hinweis auf Einmalcodes (`one-time-code`).
 */
type CodeMode = 'totp' | 'backup' | 'either'

const CODE_HINTS: Readonly<Record<CodeMode, string>> = {
  totp: 'Sechs Ziffern, alle 30 Sekunden neu.',
  backup: 'Format XXXXX-XXXXX; Gross- und Kleinschreibung zaehlen nicht.',
  either: 'Sechs Ziffern aus der App oder ein Ersatzcode im Format XXXXX-XXXXX.',
}

function CodeField({
  id,
  label,
  value,
  mode,
  onChange,
}: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly mode: CodeMode
  readonly onChange: (value: string) => void
}) {
  return (
    <Field id={id} label={label} hint={CODE_HINTS[mode]}>
      <input
        id={id}
        className="code-input"
        type="text"
        value={value}
        required
        autoComplete="one-time-code"
        inputMode={mode === 'totp' ? 'numeric' : 'text'}
        autoCapitalize={mode === 'totp' ? 'off' : 'characters'}
        spellCheck={false}
        maxLength={mode === 'totp' ? 8 : 16}
        aria-describedby={`${id}-hint`}
        onChange={(event) => {
          onChange(event.target.value)
        }}
      />
    </Field>
  )
}

/**
 * Die Ersatzcodes einer Ausgabe - genau einmal.
 *
 * "Weiter" wird erst moeglich, wenn bestaetigt ist, dass die Codes abgelegt sind: danach zeigt sie niemand
 * mehr, auch der Server nicht.
 */
function BackupCodes({ codes, onDone }: { readonly codes: readonly string[]; readonly onDone: () => void }) {
  const [stored, setStored] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  return (
    <div className="stack card">
      <Notice kind="info" text="Diese Ersatzcodes erscheinen nur jetzt. Jeder gilt genau einmal, wenn die App nicht zur Hand ist." />
      <ol className="backup-codes" aria-label="Ersatzcodes">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ol>
      <p>
        <Button
          icon={Copy}
          onClick={() => {
            navigator.clipboard
              .writeText(codes.join('\n'))
              .then(() => {
                setCopied('Die Ersatzcodes stehen in der Zwischenablage.')
              })
              .catch(() => {
                setCopied('Kopieren war nicht moeglich. Bitte die Codes von Hand abschreiben.')
              })
          }}
        >
          Alle kopieren
        </Button>
      </p>
      <p className="hint" role="status">
        {copied ?? ''}
      </p>
      <label className="choice">
        <input
          type="checkbox"
          checked={stored}
          onChange={(event) => {
            setStored(event.target.checked)
          }}
        />
        Ich habe die Ersatzcodes sicher abgelegt, etwa im Passwortmanager.
      </label>
      <p>
        <Button variant="primary" disabled={!stored} onClick={onDone}>
          Weiter
        </Button>
      </p>
    </div>
  )
}

/**
 * Einrichtung: Schluessel zeigen, Code der App bestaetigen, Ersatzcodes zeigen.
 *
 * `started` ist eine bereits begonnene Einrichtung (Neueinrichtung aus dem Konto, die den aktuellen Code
 * schon verlangt hat); ohne sie beginnt die Ansicht selbst.
 */
function Enrollment({
  csrfToken,
  started,
  onDone,
}: {
  readonly csrfToken: string
  readonly started: SecondFactorEnrollResponse | null
  readonly onDone: () => void
}) {
  const [enrollment, setEnrollment] = useState<SecondFactorEnrollResponse | null>(started)
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<readonly string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (codes !== null) {
    return <BackupCodes codes={codes} onDone={onDone} />
  }

  if (enrollment === null) {
    return (
      <div className="stack card">
        <p>
          Das Konto der Systemadministration braucht zusaetzlich zum Passwort einen zweiten Faktor: eine
          Authenticator-App auf einem Geraet, das nur dir gehoert (etwa Aegis, Google Authenticator,
          Microsoft Authenticator oder ein Passwortmanager mit TOTP).
        </p>
        <p>
          <Button
            variant="primary"
            icon={ShieldCheck}
            busy={busy}
            onClick={() => {
              setBusy(true)
              setError(null)
              enrollSecondFactor(csrfToken)
                .then(setEnrollment)
                .catch((cause: unknown) => {
                  setError(messageOf(cause, 'Die Einrichtung konnte nicht beginnen.'))
                })
                .finally(() => {
                  setBusy(false)
                })
            }}
          >
            Einrichtung beginnen
          </Button>
        </p>
        {error !== null && <Notice text={error} />}
      </div>
    )
  }

  return (
    <form
      className="stack card"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        confirmSecondFactor(csrfToken, code)
          .then((result) => {
            setCodes(result.backupCodes)
          })
          .catch((cause: unknown) => {
            setBusy(false)
            setError(messageOf(cause, 'Der Code konnte nicht bestaetigt werden.'))
          })
      }}
    >
      <ol className="steps">
        <li>
          Neues Konto in der Authenticator-App anlegen und diesen Schluessel eintragen (zeitbasiert, sechs
          Stellen, 30 Sekunden):
          <code className="secret-key" aria-label={`Schluessel ${enrollment.secret.split('').join(' ')}`}>
            {grouped(enrollment.secret)}
          </code>
          <span className="hint">
            Auf einem Geraet mit App geht es auch direkt:{' '}
            <a href={enrollment.otpauthUri}>In der Authenticator-App oeffnen</a>
          </span>
        </li>
        <li>Den Code eingeben, den die App jetzt anzeigt. Erst dann ist der zweite Faktor aktiv.</li>
      </ol>
      <CodeField id="einrichtung-code" label="Code aus der App" value={code} mode="totp" onChange={setCode} />
      <p>
        <Button variant="primary" icon={KeyRound} type="submit" busy={busy}>
          Bestaetigen
        </Button>
      </p>
      {error !== null && <Notice text={error} />}
    </form>
  )
}

/** Abfrage nach der Anmeldung: Code aus der App oder ein Ersatzcode. */
function Challenge({ csrfToken, onDone }: { readonly csrfToken: string; readonly onDone: () => void }) {
  const [backup, setBackup] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <form
      className="stack card"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        verifySecondFactor(csrfToken, code)
          .then(onDone)
          .catch((cause: unknown) => {
            setBusy(false)
            setError(messageOf(cause, 'Der Code konnte nicht geprueft werden.'))
          })
      }}
    >
      <CodeField
        id="anmeldung-code"
        label={backup ? 'Ersatzcode' : 'Code aus der Authenticator-App'}
        value={code}
        mode={backup ? 'backup' : 'totp'}
        onChange={setCode}
      />
      <p>
        <Button variant="primary" icon={KeyRound} type="submit" busy={busy}>
          Bestaetigen
        </Button>
      </p>
      <p>
        <Button
          variant="quiet"
          onClick={() => {
            setBackup((was) => !was)
            setCode('')
            setError(null)
          }}
        >
          {backup ? 'Stattdessen den Code aus der App verwenden' : 'Stattdessen einen Ersatzcode verwenden'}
        </Button>
      </p>
      {error !== null && <Notice text={error} />}
      <p className="hint">
        Weder App noch Ersatzcode zur Hand? Den Zugang stellt nur der Betrieb der Instanz wieder her
        (<code>admin:recover</code>); dabei wird der zweite Faktor neu eingerichtet.
      </p>
    </form>
  )
}

/**
 * Die Ansicht einer Sitzung ohne belegten zweiten Faktor: Einrichtung oder Abfrage, und die Abmeldung.
 * Nach Erfolg laedt die Anwendung das Profil neu - die Sitzung ist dann eine neue.
 */
export function SecondFactorGate({
  me,
  onDone,
  onSignedOut,
}: {
  readonly me: MeResponse
  readonly onDone: () => void
  readonly onSignedOut: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const setup = me.secondFactor.state === 'setup-required'

  return (
    <main className="shell">
      <h1>Canvaz</h1>
      <section aria-labelledby="zweiter-faktor">
        <h2 id="zweiter-faktor">{setup ? 'Zweiten Faktor einrichten' : 'Anmeldung bestaetigen'}</h2>
        <p>
          Angemeldet als <strong>{me.user.displayName}</strong>
          {me.user.email === null ? '' : ` (${me.user.email})`}
        </p>
        {setup ? <Enrollment csrfToken={me.csrfToken} started={null} onDone={onDone} /> : <Challenge csrfToken={me.csrfToken} onDone={onDone} />}
        <p>
          <Button
            icon={LogOut}
            onClick={() => {
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
                  setError(messageOf(cause, 'Die Abmeldung ist fehlgeschlagen.'))
                })
            }}
          >
            Abmelden
          </Button>
        </p>
        {error !== null && <Notice text={error} />}
      </section>
    </main>
  )
}

type Change =
  | { readonly kind: 'idle' }
  | { readonly kind: 'codes'; readonly codes: readonly string[] }
  | { readonly kind: 'enrollment'; readonly enrollment: SecondFactorEnrollResponse }

/**
 * Zweiter Faktor im eigenen Konto: neue Ersatzcodes oder eine neue App. Beides verlangt einen aktuellen Code
 * und beendet alle anderen Sitzungen; danach laedt die Anwendung das Profil neu.
 */
export function SecondFactorSettings({ me, onChanged }: { readonly me: MeResponse; readonly onChanged: () => void }) {
  const [code, setCode] = useState('')
  const [change, setChange] = useState<Change>({ kind: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (me.secondFactor.state !== 'verified') {
    return null
  }
  const remaining = me.secondFactor.backupCodesRemaining

  function run(action: 'codes' | 'enrollment'): void {
    setBusy(true)
    setError(null)
    const done =
      action === 'codes'
        ? renewBackupCodes(me.csrfToken, code).then((result) => {
            setChange({ kind: 'codes', codes: result.backupCodes })
          })
        : enrollSecondFactor(me.csrfToken, code).then((enrollment) => {
            setChange({ kind: 'enrollment', enrollment })
          })
    done
      .catch((cause: unknown) => {
        setError(messageOf(cause, 'Der zweite Faktor konnte nicht geaendert werden.'))
      })
      .finally(() => {
        setCode('')
        setBusy(false)
      })
  }

  return (
    <section aria-labelledby="zweiter-faktor">
      <h2 id="zweiter-faktor">Zweiter Faktor</h2>
      {change.kind === 'codes' && <BackupCodes codes={change.codes} onDone={onChanged} />}
      {change.kind === 'enrollment' && (
        <Enrollment csrfToken={me.csrfToken} started={change.enrollment} onDone={onChanged} />
      )}
      {change.kind === 'idle' && (
        <form
          className="stack card"
          onSubmit={(event) => {
            event.preventDefault()
            run('codes')
          }}
        >
          <p>
            Aktiv mit Authenticator-App. Noch {String(remaining)} von 10 Ersatzcodes unverbraucht.
          </p>
          {remaining <= 3 && <Notice kind="info" text="Nur noch wenige Ersatzcodes. Gib rechtzeitig neue aus." />}
          <CodeField
            id="faktor-code"
            label="Aktueller Code aus der App oder ein Ersatzcode"
            value={code}
            mode="either"
            onChange={setCode}
          />
          <p className="hint">
            Beide Aenderungen beenden alle anderen Sitzungen dieses Kontos; die bisherigen Ersatzcodes verfallen.
          </p>
          <p className="actions">
            <Button type="submit" busy={busy}>
              Neue Ersatzcodes ausgeben
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                run('enrollment')
              }}
            >
              Authenticator-App wechseln
            </Button>
          </p>
          {error !== null && <Notice text={error} />}
        </form>
      )}
    </section>
  )
}
