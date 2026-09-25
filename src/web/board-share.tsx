/**
 * Freigabeverwaltung eines Boards: interne Freigaben, Ownerschaft und oeffentliche Gastlinks.
 *
 * Ein Abschnitt im Fluss seiner Umgebung und kein eigener Dialog: die Ueberschriften bleiben in der
 * Dokumentstruktur, und weder Fokuskaefig noch Escape werden hier nachgebaut. Der Abschnitt steht heute im
 * Bereich "Freigaben" der Board-Sidebar (`board-panel.tsx`); sie traegt Name und Schliessweg.
 *
 * Die Oberflaeche entscheidet nichts. Sie bietet an, was der Server laut seiner Antwort ohnehin traegt, und
 * zeigt jede Ablehnung als Text - der Owner steht in `board.ownerUserId`, die Freigaben kommen aus
 * `/api/boards/grants`, die Auswahl der Empfaenger aus `/api/workspaces/members`. Eine eigene
 * Rollenrechnung gibt es hier nicht.
 *
 * **Das Klartexttoken eines Gastlinks erscheint genau einmal.** Es steht ausschliesslich in der Antwort auf
 * die Anlage, lebt danach nur im Zustand dieser Ansicht und wird nirgends abgelegt - weder in
 * `localStorage` noch in der Adresse. Wer die Ansicht verlaesst, bekommt es nicht zurueck.
 */

import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'

import type {
  BoardGrantRoleView,
  BoardGrantView,
  BoardShareLinkView,
  BoardView,
  GuestRoleView,
  MeResponse,
  WorkspaceMemberView,
} from '../contracts/api.js'
import { MAX_SHARE_LINK_HOURS } from '../domain/board/guest.js'
import type { EffectiveBoardRole } from '../domain/board/policy.js'
import { mayManageBoard } from '../domain/board/policy.js'
import {
  ApiError,
  changeBoardGrantRole,
  createBoardShareLink,
  fetchBoardGrants,
  fetchBoardShareLinks,
  fetchWorkspaceMembers,
  revokeBoardGrant,
  revokeBoardShareLink,
  shareBoard,
  transferBoardOwnership,
} from './api.js'
import { ConfirmDialog, Empty, Loading, Notice } from './ui.js'

const GRANT_ROLES: readonly BoardGrantRoleView[] = ['editor', 'viewer']

const GRANT_ROLE_LABELS: Readonly<Record<BoardGrantRoleView, string>> = {
  editor: 'Editor',
  viewer: 'Viewer',
}

/** Die Wirkung einer Rolle in einem Satz - eine Rollenwahl ohne sie waere geraten. */
const GRANT_ROLE_HINTS: Readonly<Record<BoardGrantRoleView, string>> = {
  editor:
    'Editor: darf die Zeichnung aendern und speichern, Bilder hochladen und das Board umbenennen oder archivieren.',
  viewer: 'Viewer: darf das Board oeffnen und lesen. Jede Aenderung lehnt der Server ab.',
}

const GUEST_ROLES: readonly GuestRoleView[] = ['guest-viewer', 'guest-editor']

const GUEST_ROLE_LABELS: Readonly<Record<GuestRoleView, string>> = {
  'guest-viewer': 'Gast: nur lesen',
  'guest-editor': 'Gast: lesen und bearbeiten',
}

const GUEST_ROLE_HINTS: Readonly<Record<GuestRoleView, string>> = {
  'guest-viewer': 'Wer diesen Link oeffnet, sieht das Board und kann nichts daran aendern.',
  'guest-editor': 'Wer diesen Link oeffnet, darf die Zeichnung dieses Boards aendern und speichern.',
}

/** Uebersetzt eine Serverantwort in einen Satz. 404 und 403 bekommen bewusst eigene Texte. */
function messageOf(cause: unknown, fallback: string): string {
  if (!(cause instanceof ApiError)) {
    return fallback
  }
  if (cause.status === 404) {
    return 'Dieses Board ist nicht (mehr) fuer dich freigegeben oder existiert nicht.'
  }
  if (cause.status === 403) {
    return `Dafuer fehlt dir die Berechtigung. ${cause.message}`
  }
  return cause.message
}

/**
 * Die Rolle, die der Server fuer dieses Board nennt. Ob sie die Verwaltung traegt, entscheidet
 * `mayManageBoard` - dieselbe Funktion wie auf der Serverseite. Diese Datei prueft keine Berechtigung selbst.
 */
function viewerRoleOf(board: BoardView): EffectiveBoardRole {
  return { kind: 'member', role: board.viewerRole }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('de-DE')
}

/** Was ein Nutzer heisst, wenn eine Zeile beides zeigen darf. */
function nameOf(member: { readonly displayName: string; readonly email: string | null }): string {
  return member.email === null ? member.displayName : `${member.displayName} (${member.email})`
}

function GrantRow({
  me,
  board,
  grant,
  manageable,
  onChanged,
  onError,
}: {
  readonly me: MeResponse
  readonly board: BoardView
  readonly grant: BoardGrantView
  readonly manageable: boolean
  readonly onChanged: () => void
  readonly onError: (message: string) => void
}) {
  const [role, setRole] = useState<BoardGrantRoleView>(grant.role)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setRole(grant.role)
  }, [grant.role])

  function run(action: Promise<unknown>, fallback: string): void {
    setBusy(true)
    onError('')
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
      <td data-label="Name">{grant.displayName}</td>
      <td data-label="E-Mail">{grant.email ?? '—'}</td>
      <td data-label="Rolle">
        {!manageable && GRANT_ROLE_LABELS[grant.role]}
        {manageable && (
        <select
          aria-label={`Boardrolle von ${grant.displayName}`}
          value={role}
          onChange={(event) => {
            setRole(event.target.value as BoardGrantRoleView)
          }}
        >
          {GRANT_ROLES.map((candidate) => (
            <option key={candidate} value={candidate}>
              {GRANT_ROLE_LABELS[candidate]}
            </option>
          ))}
        </select>
        )}
      </td>
      <td data-label="Freigegeben">{formatDate(grant.grantedAt)}</td>
      <td data-label="Aktion">
        {manageable && (
          <span className="actions">
            <button
              type="button"
              disabled={busy || role === grant.role}
              onClick={() => {
                run(
                  changeBoardGrantRole(me.csrfToken, { boardId: board.id, userId: grant.userId, role }),
                  'Die Rolle konnte nicht geaendert werden.',
                )
              }}
            >
              Rolle von {grant.displayName} speichern
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                run(
                  revokeBoardGrant(me.csrfToken, { boardId: board.id, userId: grant.userId }),
                  'Die Freigabe konnte nicht entzogen werden.',
                )
              }}
            >
              Zugriff von {grant.displayName} entziehen
            </button>
          </span>
        )}
      </td>
    </tr>
  )
}

/**
 * Freigabe an ein Mitglied des Arbeitsbereichs.
 *
 * Die Auswahl kommt aus der Mitgliederliste des Arbeitsbereichs und nicht aus dem Nutzerverzeichnis: eine
 * Boardrolle bekommt ohnehin nur, wer bereits Mitglied ist. Gesucht wird deshalb in dieser Liste, nicht
 * gegen ein zweites Verzeichnis.
 */
function AddGrant({
  me,
  board,
  candidates,
  onChanged,
}: {
  readonly me: MeResponse
  readonly board: BoardView
  readonly candidates: readonly WorkspaceMemberView[]
  readonly onChanged: () => void
}) {
  const [query, setQuery] = useState('')
  const [userId, setUserId] = useState('')
  const [role, setRole] = useState<BoardGrantRoleView>('viewer')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const term = query.trim().toLowerCase()
  const matches = candidates.filter(
    (member) =>
      term === '' ||
      member.displayName.toLowerCase().includes(term) ||
      (member.email ?? '').toLowerCase().includes(term),
  )
  const selected = matches.find((member) => member.userId === userId) ?? null

  if (candidates.length === 0) {
    return <Empty text="Alle Mitglieder dieses Arbeitsbereichs haben bereits eine eigene Rolle auf diesem Board." />
  }

  return (
    <form
      className="stack card"
      onSubmit={(event) => {
        event.preventDefault()
        if (selected === null) {
          return
        }
        setBusy(true)
        setError(null)
        shareBoard(me.csrfToken, { boardId: board.id, userId: selected.userId, role })
          .then(() => {
            setUserId('')
            setQuery('')
            onChanged()
          })
          .catch((cause: unknown) => {
            setError(messageOf(cause, 'Die Freigabe konnte nicht angelegt werden.'))
          })
          .finally(() => {
            setBusy(false)
          })
      }}
    >
      <div className="field">
        <label htmlFor="grant-search">Mitglied suchen (Anzeigename oder E-Mail-Adresse)</label>
        <input
          id="grant-search"
          type="search"
          aria-describedby="grant-search-hint"
          value={query}
          maxLength={320}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
        />
      </div>
      <p className="hint" id="grant-search-hint">
        Eine Boardrolle bekommt nur, wer bereits Mitglied dieses Arbeitsbereichs ist. Gesucht wird deshalb in
        seiner Mitgliederliste.
      </p>

      <fieldset>
        <legend>Empfaenger der Freigabe</legend>
        {matches.length === 0 && <Empty text="Kein Mitglied passt zu dieser Suche." />}
        {matches.map((member) => (
          <p key={member.userId}>
            <input
              type="radio"
              id={`grant-candidate-${member.userId}`}
              name="grant-candidate"
              value={member.userId}
              checked={userId === member.userId}
              onChange={() => {
                setUserId(member.userId)
              }}
            />{' '}
            <label htmlFor={`grant-candidate-${member.userId}`}>{nameOf(member)}</label>
          </p>
        ))}
      </fieldset>

      <div className="field">
        <label htmlFor="grant-role">Rolle auf diesem Board</label>
        <select
          id="grant-role"
          aria-describedby="grant-role-hint"
          value={role}
          onChange={(event) => {
            setRole(event.target.value as BoardGrantRoleView)
          }}
        >
          {GRANT_ROLES.map((candidate) => (
            <option key={candidate} value={candidate}>
              {GRANT_ROLE_LABELS[candidate]}
            </option>
          ))}
        </select>
      </div>
      <p className="hint" id="grant-role-hint">
        {GRANT_ROLE_HINTS[role]}
      </p>
      <p>
        <button className="button--primary" type="submit" disabled={busy || selected === null}>
          {selected === null ? 'Board freigeben' : `Board fuer ${selected.displayName} freigeben`}
        </button>
      </p>
      {error !== null && <Notice text={error} />}
    </form>
  )
}

/**
 * Uebertragung der Ownerschaft.
 *
 * Zwei Schritte, weil der Schritt nicht rueckgaengig zu machen ist: erst die Auswahl, dann eine
 * ausdrueckliche Bestaetigung, die benennt, was danach gilt.
 */
function TransferOwnership({
  me,
  board,
  candidates,
  onChanged,
}: {
  readonly me: MeResponse
  readonly board: BoardView
  readonly candidates: readonly WorkspaceMemberView[]
  readonly onChanged: () => void
}) {
  const [userId, setUserId] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selected = candidates.find((member) => member.userId === userId) ?? null

  if (candidates.length === 0) {
    return <Empty text="Dieser Arbeitsbereich hat kein weiteres Mitglied, das die Ownerschaft uebernehmen koennte." />
  }

  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="transfer-owner">Neuer Owner dieses Boards</label>
        <select
          id="transfer-owner"
          aria-describedby="transfer-owner-hint"
          value={userId}
          onChange={(event) => {
            setUserId(event.target.value)
            setConfirming(false)
          }}
        >
          <option value="">Bitte auswaehlen</option>
          {candidates.map((member) => (
            <option key={member.userId} value={member.userId}>
              {nameOf(member)}
            </option>
          ))}
        </select>
      </div>
      <p className="hint" id="transfer-owner-hint">
        Ein Board hat immer genau einen Owner. Nach der Uebertragung verwaltet der neue Owner Freigaben und
        Gastlinks; du behaeltst deine Rolle aus dem Arbeitsbereich. Eine bestehende Freigabe des neuen Owners
        faellt dabei weg.
      </p>
      {!confirming && (
        <p>
          <button
            type="button"
            disabled={selected === null}
            onClick={() => {
              setError(null)
              setConfirming(true)
            }}
          >
            Ownerschaft uebertragen
          </button>
        </p>
      )}
      {confirming && selected !== null && (
        <ConfirmDialog danger>
          <p>
            Ownerschaft von <strong>{board.title}</strong> wirklich an <strong>{selected.displayName}</strong>{' '}
            uebertragen? Du kannst das danach nicht selbst rueckgaengig machen.
          </p>
          <p className="actions">
            <button
              className="button--danger"
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                setError(null)
                transferBoardOwnership(me.csrfToken, { boardId: board.id, userId: selected.userId })
                  .then(() => {
                    setConfirming(false)
                    setUserId('')
                    onChanged()
                  })
                  .catch((cause: unknown) => {
                    setError(messageOf(cause, 'Die Ownerschaft konnte nicht uebertragen werden.'))
                  })
                  .finally(() => {
                    setBusy(false)
                  })
              }}
            >
              Ja, Ownerschaft an {selected.displayName} uebertragen
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false)
              }}
            >
              Uebertragung abbrechen
            </button>
          </p>
        </ConfirmDialog>
      )}
      {error !== null && <Notice text={error} />}
    </div>
  )
}

/** Zustand eines Links in einem Wort - abgeleitet aus den Zeitpunkten, die der Server nennt. */
function linkStatus(link: BoardShareLinkView, now: Date): string {
  if (link.revokedAt !== null) {
    return `widerrufen am ${formatDate(link.revokedAt)}`
  }
  if (link.expiresAt !== null && new Date(link.expiresAt).getTime() <= now.getTime()) {
    return `abgelaufen am ${formatDate(link.expiresAt)}`
  }
  return 'gueltig'
}

/**
 * Der Einmal-Hinweis mit dem Klartextlink der letzten Anlage. Er haelt selbst keinen Zustand: Link und
 * Kopierrueckmeldung liegen in `BoardShare`, damit ein Neuladen der Liste ihn nicht aushaengt.
 */
function CreatedLinkNotice({
  url,
  copied,
  onCopied,
  onHide,
}: {
  readonly url: string
  readonly copied: string | null
  readonly onCopied: (message: string) => void
  readonly onHide: () => void
}) {
  return (
    <Notice kind="success">
      <p>
        <strong>Dieser Link erscheint genau einmal.</strong> Er laesst sich danach nicht erneut abrufen - auch
        nicht ueber diese Liste. Kopiere ihn jetzt; ist er verloren, widerrufe ihn und lege einen neuen an.
      </p>
      <div className="field">
        <label htmlFor="share-link-url">Freigabelink</label>
        <input
          id="share-link-url"
          readOnly
          value={url}
          onFocus={(event) => {
            event.target.select()
          }}
        />
      </div>
      <p className="actions">
        <button
          className="button--primary"
          type="button"
          onClick={() => {
            navigator.clipboard
              .writeText(url)
              .then(() => {
                onCopied('Der Link steht in der Zwischenablage.')
              })
              .catch(() => {
                onCopied('Kopieren war nicht moeglich. Bitte den Link von Hand auswaehlen und kopieren.')
              })
          }}
        >
          Link kopieren
        </button>
        <button type="button" onClick={onHide}>
          Link ausblenden
        </button>
      </p>
      {/* Kein eigener Live-Bereich: die Rueckmeldung steht bereits im `role="status"` dieses Blocks. */}
      <p className="hint">{copied ?? ''}</p>
    </Notice>
  )
}

function ShareLinks({
  me,
  board,
  links,
  notice,
  onCreated,
  onChanged,
}: {
  readonly me: MeResponse
  readonly board: BoardView
  readonly links: readonly BoardShareLinkView[]
  /** Der Einmal-Hinweis der letzten Anlage, falls einer steht - zwischen Formular und Liste. */
  readonly notice: ReactNode
  /** Uebergibt den Klartextlink einer Anlage genau einmal an `BoardShare`. */
  readonly onCreated: (url: string) => void
  readonly onChanged: () => void
}) {
  const [role, setRole] = useState<GuestRoleView>('guest-viewer')
  const [hours, setHours] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const now = new Date()
  const trimmedHours = hours.trim()

  return (
    <>
      <form
        className="stack card"
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setError(null)
          const expiresInHours = trimmedHours === '' ? undefined : Number(trimmedHours)
          createBoardShareLink(me.csrfToken, {
            boardId: board.id,
            role,
            ...(expiresInHours === undefined ? {} : { expiresInHours }),
          })
            .then((response) => {
              onCreated(response.url)
              setHours('')
              onChanged()
            })
            .catch((cause: unknown) => {
              setError(messageOf(cause, 'Der Freigabelink konnte nicht angelegt werden.'))
            })
            .finally(() => {
              setBusy(false)
            })
        }}
      >
        <div className="field">
          <label htmlFor="share-link-role">Rolle des Gastlinks</label>
          <select
            id="share-link-role"
            aria-describedby="share-link-role-hint"
            value={role}
            onChange={(event) => {
              setRole(event.target.value as GuestRoleView)
            }}
          >
            {GUEST_ROLES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {GUEST_ROLE_LABELS[candidate]}
              </option>
            ))}
          </select>
        </div>
        <p className="hint" id="share-link-role-hint">
          {GUEST_ROLE_HINTS[role]} Ein Gast erreicht ausschliesslich dieses eine Board.
        </p>
        <div className="field">
          <label htmlFor="share-link-hours">Laufzeit in Stunden (leer lassen: kein Ablauf)</label>
          <input
            id="share-link-hours"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_SHARE_LINK_HOURS}
            aria-describedby="share-link-hours-hint"
            value={hours}
            onChange={(event) => {
              setHours(event.target.value)
            }}
          />
        </div>
        <p className="hint" id="share-link-hours-hint">
          Hoechstens {String(MAX_SHARE_LINK_HOURS)} Stunden. Ohne Angabe endet der Link erst mit dem Widerruf.
        </p>
        <p>
          <button className="button--primary" type="submit" disabled={busy}>
            Gastlink anlegen
          </button>
        </p>
        {error !== null && <Notice text={error} />}
      </form>

      {notice}

      {links.length === 0 ? (
        <Empty text="Fuer dieses Board gibt es noch keinen Gastlink." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Gastlinks von {board.title}</caption>
            <thead>
              <tr>
                <th scope="col">Rolle</th>
                <th scope="col">Angelegt von</th>
                <th scope="col">Angelegt</th>
                <th scope="col">Ablauf</th>
                <th scope="col">Zustand</th>
                <th scope="col">Gaeste</th>
                <th scope="col">Aktion</th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <ShareLinkRow key={link.id} me={me} board={board} link={link} now={now} onChanged={onChanged} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function ShareLinkRow({
  me,
  board,
  link,
  now,
  onChanged,
}: {
  readonly me: MeResponse
  readonly board: BoardView
  readonly link: BoardShareLinkView
  readonly now: Date
  readonly onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <tr>
      <td data-label="Rolle">{GUEST_ROLE_LABELS[link.role]}</td>
      <td data-label="Angelegt von">{link.createdByDisplayName ?? '—'}</td>
      <td data-label="Angelegt">{formatDate(link.createdAt)}</td>
      <td data-label="Ablauf">{link.expiresAt === null ? 'kein Ablauf' : formatDate(link.expiresAt)}</td>
      <td data-label="Zustand">{linkStatus(link, now)}</td>
      <td data-label="Gaeste">{String(link.guestCount)}</td>
      <td data-label="Aktion">
        {link.revokedAt === null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              setError(null)
              revokeBoardShareLink(me.csrfToken, { boardId: board.id, shareLinkId: link.id })
                .then(onChanged)
                .catch((cause: unknown) => {
                  setError(messageOf(cause, 'Der Freigabelink konnte nicht widerrufen werden.'))
                })
                .finally(() => {
                  setBusy(false)
                })
            }}
          >
            Gastlink vom {formatDate(link.createdAt)} widerrufen
          </button>
        )}
        {error !== null && <Notice text={error} />}
      </td>
    </tr>
  )
}

type Loaded = {
  readonly board: BoardView
  readonly grants: readonly BoardGrantView[]
  readonly members: readonly WorkspaceMemberView[]
}

type LinkState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly links: readonly BoardShareLinkView[] }
  /** Die eigene Rolle traegt die Gastlinks nicht; sie werden deshalb gar nicht erst angefragt. */
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly message: string }

export function BoardShare({
  me,
  boardId,
  onChanged,
}: {
  readonly me: MeResponse
  readonly boardId: string
  readonly onChanged: () => void
}) {
  const [state, setState] = useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly loaded: Loaded }
    | { readonly kind: 'failed'; readonly message: string }
  >({ kind: 'loading' })
  const [links, setLinks] = useState<LinkState>({ kind: 'loading' })
  const [actionError, setActionError] = useState<string | null>(null)
  /**
   * Das Klartexttoken der letzten Anlage und die Rueckmeldung zum Kopieren. Beides lebt nur hier - oberhalb
   * der Liste, damit ihr Neuladen den Hinweis nicht aushaengt - und wird nirgends gespeichert.
   */
  const [created, setCreated] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // Ein anderes Board beginnt ohne die Liste und ohne den Link des vorigen.
  useEffect(() => {
    setLinks({ kind: 'loading' })
    setCreated(null)
    setCopied(null)
  }, [boardId])

  // Ein Neuladen setzt die Gastlinks nicht zurueck: die bisherige Liste bleibt bis zum Ergebnis stehen.
  const load = useCallback(() => {
    setActionError(null)
    fetchBoardGrants(boardId)
      .then(async (response) => {
        // Die Empfaengerauswahl steht in der Mitgliederliste des Arbeitsbereichs; ein eigenes Verzeichnis
        // hat die Boardebene nicht.
        const members = await fetchWorkspaceMembers(response.board.workspaceId)
        setState({
          kind: 'ready',
          loaded: { board: response.board, grants: response.grants, members: members.members },
        })
        // Die Gastlinks sind ein eigener Ladevorgang: sie verlangen die Verwaltung, die Freigabeliste nur
        // das Leserecht. Wer die Rolle dafuer nicht traegt, bekommt hier gar keine Anfrage - und in der
        // Ansicht den Grund als Text.
        if (!mayManageBoard(viewerRoleOf(response.board))) {
          setLinks({ kind: 'unavailable' })
          return
        }
        await fetchBoardShareLinks(boardId)
          .then((linkResponse) => {
            setLinks({ kind: 'ready', links: linkResponse.links })
          })
          .catch((cause: unknown) => {
            setLinks({ kind: 'failed', message: messageOf(cause, 'Die Gastlinks konnten nicht geladen werden.') })
          })
      })
      .catch((cause: unknown) => {
        setState({ kind: 'failed', message: messageOf(cause, 'Die Freigaben konnten nicht geladen werden.') })
      })
  }, [boardId])

  useEffect(load, [load])

  function reload(): void {
    load()
    onChanged()
  }

  if (state.kind === 'loading') {
    return (
      <section aria-labelledby="board-share-heading">
        <h5 id="board-share-heading">Freigaben</h5>
        <Loading text="Freigaben werden geladen …" />
      </section>
    )
  }
  if (state.kind === 'failed') {
    return (
      <section aria-labelledby="board-share-heading">
        <h5 id="board-share-heading">Freigaben</h5>
        <Notice text={state.message} />
      </section>
    )
  }

  const { board, grants, members } = state.loaded
  /** Was der Server fuer diese Rolle zulaesst - nicht, was diese Ansicht fuer richtig haelt. */
  const manageable = mayManageBoard(viewerRoleOf(board))
  const granted = new Set(grants.map((grant) => grant.userId))
  /** Empfaenger einer neuen Freigabe: Mitglieder ohne eigene Boardrolle. Der Owner traegt seine bereits. */
  const openMembers = members.filter(
    (member) => member.userId !== board.ownerUserId && !granted.has(member.userId),
  )
  /** Uebernehmen kann jedes andere Mitglied - auch eines, das bereits eine Freigabe haelt. */
  const transferable = members.filter((member) => member.userId !== board.ownerUserId)
  const createdNotice =
    created === null ? null : (
      <CreatedLinkNotice
        url={created}
        copied={copied}
        onCopied={setCopied}
        onHide={() => {
          setCreated(null)
          setCopied(null)
        }}
      />
    )

  return (
    <section aria-labelledby="board-share-heading">
      <h5 id="board-share-heading">Freigaben von {board.title}</h5>
      <p>
        Owner: <strong>{board.ownerDisplayName}</strong>
        {board.ownerUserId === me.user.id && <> (du)</>}
      </p>
      {!manageable && (
        <p className="hint">
          Diese Freigaben kannst du sehen, aber nicht aendern: dafuer braucht es die Ownerschaft dieses
          Boards.
        </p>
      )}
      {board.status === 'archived' && (
        <p className="hint">
          Dieses Board ist archiviert. Freigaben und Gastlinks bleiben lesbar, aenderbar sind sie erst nach dem
          Entarchivieren.
        </p>
      )}
      {actionError !== null && actionError !== '' && <Notice text={actionError} />}

      <h6>Interne Freigaben</h6>
      {grants.length === 0 ? (
        <Empty text="Es gibt keine ausdrueckliche Freigabe. Damit gilt fuer jedes Mitglied des Arbeitsbereichs die Rolle seiner Mitgliedschaft." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Interne Freigaben von {board.title}</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">E-Mail</th>
                <th scope="col">Rolle</th>
                <th scope="col">Freigegeben</th>
                <th scope="col">Aktion</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <GrantRow
                  key={grant.userId}
                  me={me}
                  board={board}
                  grant={grant}
                  manageable={manageable}
                  onChanged={reload}
                  onError={setActionError}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {manageable && (
        <>
          <h6>Board freigeben</h6>
          <AddGrant me={me} board={board} candidates={openMembers} onChanged={reload} />

          <h6>Ownerschaft uebertragen</h6>
          <TransferOwnership me={me} board={board} candidates={transferable} onChanged={reload} />
        </>
      )}

      <h6>Gastlinks</h6>
      {links.kind === 'loading' && <Loading text="Gastlinks werden geladen …" />}
      {links.kind === 'unavailable' && <Empty text="Gastlinks sieht und verwaltet der Owner dieses Boards." />}
      {links.kind === 'failed' && <Notice text={links.message} />}
      {links.kind === 'ready' && (
        <ShareLinks
          me={me}
          board={board}
          links={links.links}
          notice={createdNotice}
          onCreated={(url) => {
            setCreated(url)
            setCopied(null)
          }}
          onChanged={reload}
        />
      )}
      {links.kind !== 'ready' && createdNotice}
    </section>
  )
}
