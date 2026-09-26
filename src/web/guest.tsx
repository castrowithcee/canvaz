/**
 * Gastansicht.
 *
 * Eine eigene Route (`/gast`) und ein eigener Einstieg: ein Gast hat keine Anmeldung, keinen
 * Arbeitsbereich, keine Mitglieder- und keine Boardliste. Diese Ansicht bietet deshalb genau zwei Bilder -
 * die Eingabe des Anzeigenamens und danach den Editor fuer genau das eine Board seines Links. Einen Weg zur
 * Verwaltungsansicht gibt es hier nicht; die Huelle der angemeldeten Nutzer wird gar nicht erst gerendert.
 *
 * ## Woher das Token kommt
 *
 * Aus dem **Fragment** der Adresse (`/gast#<token>`). Ein Fragment sendet der Browser nicht mit - es
 * erreicht damit weder ein Zugriffsprotokoll noch einen Referrer. Diese Ansicht liest es einmal beim Laden,
 * haelt es ausschliesslich im Speicher (nie in `localStorage` oder `sessionStorage`) und nimmt es nach dem
 * Beitritt aus der Adresszeile.
 *
 * **Liegt ein Token vor, wird immer beigetreten.** Ein vorhandenes Gastcookie koennte zu einem anderen Board
 * gehoeren, und welches Board das Token meint, weiss allein der Server. Ohne Token gilt umgekehrt das
 * Cookie: so uebersteht ein neu geladener Tab den Beitritt, ohne ihn zu wiederholen.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { GuestSessionResponse } from '../contracts/api.js'
import { MAX_GUEST_DISPLAY_NAME_LENGTH } from '../domain/board/guest.js'
import { ApiError, fetchGuestSession, joinBoardAsGuest } from './api.js'
import { BoardEditor } from './board/lazy-editor.js'

/** Das Token steht im Fragment und ist base64url kodiert; es braucht keine Dekodierung. */
function readTokenFromFragment(): string | null {
  const fragment = window.location.hash.replace(/^#/, '')
  return fragment.length === 0 ? null : fragment
}

/** Nimmt das Token aus der Adresszeile, sobald es eingeloest ist. Der Verlauf behaelt es ohnehin nicht lange. */
function clearFragment(): void {
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback
}

type State =
  | { readonly kind: 'checking' }
  /** Token vorhanden, Anzeigename fehlt noch. */
  | { readonly kind: 'join' }
  | { readonly kind: 'ready'; readonly session: GuestSessionResponse }
  /** Kein Token in der Adresse und kein gueltiger Gastzugang im Browser. */
  | { readonly kind: 'invalid' }
  | { readonly kind: 'failed'; readonly message: string }

function Shell({ children }: { readonly children: ReactNode }) {
  return (
    <main className="shell">
      <h1>Canvaz</h1>
      {children}
    </main>
  )
}

function JoinForm({
  token,
  onJoined,
}: {
  readonly token: string
  readonly onJoined: (session: GuestSessionResponse) => void
}) {
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <>
      <p>
        Du wurdest zu einem Board eingeladen. Gib einen Anzeigenamen an; er erscheint waehrend der Sitzung bei
        den Mitbearbeitern dieses Boards. Ein Konto brauchst du dafuer nicht.
      </p>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setError(null)
          joinBoardAsGuest(token, displayName)
            .then((session) => {
              clearFragment()
              onJoined(session)
            })
            .catch((cause: unknown) => {
              setError(
                cause instanceof ApiError && cause.status === 404
                  ? 'Dieser Freigabelink gilt nicht mehr. Bitte wende dich an die Person, die ihn geteilt hat.'
                  : messageOf(cause, 'Der Beitritt ist fehlgeschlagen.'),
              )
            })
            .finally(() => {
              setBusy(false)
            })
        }}
      >
        <div className="field">
          <label htmlFor="guest-name">Dein Anzeigename</label>
          <input
            id="guest-name"
            name="displayName"
            aria-describedby="guest-name-hint"
            value={displayName}
            maxLength={MAX_GUEST_DISPLAY_NAME_LENGTH}
            required
            autoFocus
            onChange={(event) => {
              setDisplayName(event.target.value)
            }}
          />
        </div>
        <p className="hint" id="guest-name-hint">
          Hoechstens {String(MAX_GUEST_DISPLAY_NAME_LENGTH)} Zeichen. Der Gastzugang gilt fuer genau dieses
          eine Board und endet von selbst.
        </p>
        <p>
          <button type="submit" disabled={busy || displayName.trim().length === 0}>
            Board als Gast oeffnen
          </button>
        </p>
        {error !== null && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}
      </form>
    </>
  )
}

export function GuestApp() {
  const [state, setState] = useState<State>({ kind: 'checking' })
  /** Das Klartexttoken. Es lebt ausschliesslich hier und wird nirgends abgelegt. */
  const tokenRef = useRef<string | null>(null)

  const load = useCallback(() => {
    const token = tokenRef.current ?? readTokenFromFragment()
    tokenRef.current = token
    if (token !== null) {
      setState({ kind: 'join' })
      return
    }
    setState({ kind: 'checking' })
    fetchGuestSession()
      .then((session) => {
        setState(session === null ? { kind: 'invalid' } : { kind: 'ready', session })
      })
      .catch((cause: unknown) => {
        setState({ kind: 'failed', message: messageOf(cause, 'Der Server ist gerade nicht erreichbar.') })
      })
  }, [])

  useEffect(load, [load])

  if (state.kind === 'checking') {
    return (
      <Shell>
        <p aria-live="polite">Gastzugang wird geprueft …</p>
      </Shell>
    )
  }
  if (state.kind === 'failed') {
    return (
      <Shell>
        <p className="notice notice--error" role="alert">
          {state.message}
        </p>
        <p>
          <button type="button" onClick={load}>
            Erneut versuchen
          </button>
        </p>
      </Shell>
    )
  }
  if (state.kind === 'invalid') {
    return (
      <Shell>
        <p className="notice notice--error" role="alert">
          Dieser Gastzugang gilt nicht mehr. Er ist abgelaufen oder wurde widerrufen.
        </p>
        <p>
          Oeffne den Freigabelink erneut, den du bekommen hast. Gilt auch er nicht mehr, braucht es einen
          neuen - ein Link laesst sich nicht wiederherstellen.
        </p>
      </Shell>
    )
  }
  if (state.kind === 'join') {
    const token = tokenRef.current
    if (token === null) {
      return (
        <Shell>
          <p className="notice notice--error" role="alert">
            In dieser Adresse steht kein Freigabelink.
          </p>
        </Shell>
      )
    }
    return (
      <Shell>
        <JoinForm
          token={token}
          onJoined={(session) => {
            tokenRef.current = null
            setState({ kind: 'ready', session })
          }}
        />
      </Shell>
    )
  }

  const { session } = state
  return (
    <Suspense
      fallback={
        <Shell>
          <p aria-live="polite">Editor wird geladen …</p>
        </Shell>
      }
    >
      <BoardEditor
        boardId={session.board.id}
        csrfToken={session.csrfToken}
        // Ein Gast erfaehrt nichts ueber den Arbeitsbereich seines Boards. Ist er archiviert, sagt der
        // Server das ueber das Schreibrecht - die Ansicht muss es nicht wissen, um es anzuzeigen.
        workspaceArchived={false}
        guestName={session.displayName}
        onClose={null}
      />
    </Suspense>
  )
}
