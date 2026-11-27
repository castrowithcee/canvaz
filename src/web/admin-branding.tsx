/**
 * Instance branding page of the system administration: name, default accent and logo.
 *
 * Name and accent are saved together, the logo is a separate action. Type and size are checked only by the
 * server.
 */

import { useEffect, useState } from 'react'
import { ImageUp, Palette, Trash2 } from 'lucide-react'

import type { AccentColor, AdminBrandingView, MeResponse } from '../contracts/api.js'
import { ACCENT_COLORS, DEFAULT_APPEARANCE, MAX_BRANDING_LOGO_BYTES, MAX_INSTANCE_NAME_LENGTH } from '../contracts/api.js'
import {
  ApiError,
  brandingLogoUrl,
  fetchAdminBranding,
  removeAdminBrandingLogo,
  saveAdminBranding,
  uploadAdminBrandingLogo,
} from './api.js'
import { Badge, Button, Field, Loading, Notice, PageState, actionClass } from './ui.js'

const ACCENT_LABELS: Readonly<Record<AccentColor, string>> = {
  violett: 'Violett',
  blau: 'Blau',
  petrol: 'Petrol',
  fuchsia: 'Fuchsia',
  graphit: 'Graphit',
}

const PRODUCT_NAME = 'Canvaz'
const LOGO_TYPES = 'image/png,image/jpeg,image/webp'

function logoError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 413) return `Das Logo ist zu gross. Erlaubt sind hoechstens ${String(MAX_BRANDING_LOGO_BYTES / 1024)} KB.`
    if (cause.status === 415) return 'Dieses Dateiformat ist nicht erlaubt. Erlaubt sind PNG, JPEG und WebP.'
    if (cause.status === 400) return 'Die Datei ist leer oder kein lesbares Bild.'
    return cause.message
  }
  return 'Das Logo konnte nicht hochgeladen werden.'
}

export function AdminBranding({ me }: { readonly me: MeResponse }) {
  const [branding, setBranding] = useState<AdminBrandingView | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setLoadError(false)
    fetchAdminBranding()
      .then(setBranding)
      .catch(() => {
        setLoadError(true)
      })
  }, [attempt])

  return (
    <section aria-labelledby="branding">
      <h2 id="branding">Branding</h2>
      <p>Name, Logo und Standard-Akzentfarbe der Instanz.</p>
      {loadError ? (
        <PageState kind="error" title="Das Branding konnte nicht geladen werden.">
          <Button
            onClick={() => {
              setAttempt((n) => n + 1)
            }}
          >
            Erneut laden
          </Button>
        </PageState>
      ) : branding === null ? (
        <Loading text="Branding wird geladen ..." />
      ) : (
        <>
          <IdentityForm csrf={me.csrfToken} branding={branding} onSaved={setBranding} />
          <LogoSection csrf={me.csrfToken} branding={branding} onChanged={setBranding} />
        </>
      )}
    </section>
  )
}

function IdentityForm({
  csrf,
  branding,
  onSaved,
}: {
  readonly csrf: string
  readonly branding: AdminBrandingView
  readonly onSaved: (branding: AdminBrandingView) => void
}) {
  const [name, setName] = useState(branding.storedInstanceName)
  const [accent, setAccent] = useState<AccentColor | null>(branding.accent)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const previewAccent = accent ?? DEFAULT_APPEARANCE.accent

  return (
    <form
      className="stack card"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        setDone(false)
        saveAdminBranding(csrf, { instanceName: name.trim(), accent })
          .then((saved) => {
            onSaved(saved)
            setName(saved.storedInstanceName)
            setDone(true)
          })
          .catch((cause: unknown) => {
            setError(cause instanceof ApiError ? cause.message : 'Das Branding konnte nicht gespeichert werden.')
          })
          .finally(() => {
            setBusy(false)
          })
      }}
    >
      <Field
        id="branding-name"
        label="Instanzname"
        hint={`Hoechstens ${String(MAX_INSTANCE_NAME_LENGTH)} Zeichen. Leer heisst: ${PRODUCT_NAME}.`}
      >
        <input
          id="branding-name"
          value={name}
          maxLength={MAX_INSTANCE_NAME_LENGTH}
          aria-describedby="branding-name-hint"
          placeholder={PRODUCT_NAME}
          onChange={(event) => {
            setName(event.target.value)
            setDone(false)
          }}
        />
      </Field>
      <fieldset>
        <legend>Standard-Akzentfarbe</legend>
        <div className="choice-group">
          <label className="choice">
            <input
              type="radio"
              name="branding-akzent"
              checked={accent === null}
              onChange={() => {
                setAccent(null)
                setDone(false)
              }}
            />
            <span className="choice__swatch" data-accent={DEFAULT_APPEARANCE.accent} aria-hidden="true" />
            Standard
          </label>
          {ACCENT_COLORS.map((value) => (
            <label key={value} className="choice">
              <input
                type="radio"
                name="branding-akzent"
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
        <p className="hint">Standard ist die bisherige Akzentfarbe (Violett). Freie Farben gibt es nicht.</p>
        <p data-accent={previewAccent} aria-hidden="true">
          <span className={actionClass('primary')}>Vorschau</span> <Badge tone="accent">Akzent</Badge>
        </p>
      </fieldset>
      <p>
        <Button variant="primary" icon={Palette} type="submit" busy={busy}>
          Branding speichern
        </Button>
      </p>
      {done && error === null && <Notice kind="success" text="Das Branding wurde gespeichert." />}
      {error !== null && <Notice text={error} />}
    </form>
  )
}

function LogoSection({
  csrf,
  branding,
  onChanged,
}: {
  readonly csrf: string
  readonly branding: AdminBrandingView
  readonly onChanged: (branding: AdminBrandingView) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [inputKey, setInputKey] = useState(0)
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  function run(kind: 'upload' | 'remove', action: Promise<AdminBrandingView>, success: string): void {
    setBusy(kind)
    setError(null)
    setDone(null)
    action
      .then((saved) => {
        onChanged(saved)
        setFile(null)
        setInputKey((n) => n + 1)
        setDone(success)
      })
      .catch((cause: unknown) => {
        setError(kind === 'upload' ? logoError(cause) : 'Das Logo konnte nicht entfernt werden.')
      })
      .finally(() => {
        setBusy(null)
      })
  }

  return (
    <section aria-labelledby="branding-logo">
      <h3 id="branding-logo">Logo</h3>
      <div className="stack card">
        {branding.logoVersion === null ? (
          <p className="empty">Kein Logo hinterlegt.</p>
        ) : (
          <img className="branding-logo" src={brandingLogoUrl(branding.logoVersion)} alt="Aktuelles Logo der Instanz" />
        )}
        <Field
          id="branding-logo-datei"
          label={branding.logoVersion === null ? 'Logo auswaehlen' : 'Neues Logo auswaehlen'}
          hint={`PNG, JPEG oder WebP, hoechstens ${String(MAX_BRANDING_LOGO_BYTES / 1024)} KB. Ein neues Logo ersetzt das aktuelle.`}
        >
          <input
            key={inputKey}
            id="branding-logo-datei"
            type="file"
            accept={LOGO_TYPES}
            aria-describedby="branding-logo-datei-hint"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null)
              setDone(null)
              setError(null)
            }}
          />
        </Field>
        <p className="row">
          <Button
            variant="primary"
            icon={ImageUp}
            busy={busy === 'upload'}
            disabled={file === null || busy !== null}
            onClick={() => {
              if (file !== null) run('upload', uploadAdminBrandingLogo(csrf, file), 'Das Logo wurde hochgeladen.')
            }}
          >
            Logo hochladen
          </Button>
          {branding.logoVersion !== null && (
            <Button
              variant="danger"
              icon={Trash2}
              busy={busy === 'remove'}
              disabled={busy !== null}
              onClick={() => {
                run('remove', removeAdminBrandingLogo(csrf), 'Das Logo wurde entfernt.')
              }}
            >
              Logo entfernen
            </Button>
          )}
        </p>
        {done !== null && error === null && <Notice kind="success" text={done} />}
        {error !== null && <Notice text={error} />}
      </div>
    </section>
  )
}
