/**
 * Freigabelinks eines Boards und der Beitritt eines Gastes.
 *
 * Zwei Seiten desselben Vorgangs, deshalb in einer Datei: der Owner erzeugt, sieht und widerruft die Links,
 * und ein Externer tauscht ein Token gegen eine Gastsession. Beide Seiten laufen ueber dieselben
 * Konventionen wie der Rest der Anwendung - Transaktion, Zeilensperre, Entscheidung in der Policy, Antwort
 * erst nach dem Commit.
 *
 * ## Das Token erscheint genau einmal
 *
 * Beim Anlegen entsteht ein zufaelliges Geheimnis. Gespeichert wird ausschliesslich sein Hash, in die
 * Antwort geht es genau einmal, und danach gibt es keinen Weg mehr, es zurueckzubekommen - auch nicht fuer
 * den Owner, auch nicht ueber die Liste. Ein verlorener Link wird widerrufen und neu angelegt.
 *
 * Es steht deshalb auch in **keiner** Protokollzeile, in keinem Auditereignis und in keiner Fehlermeldung.
 * Die Adresse traegt es im Fragment (`/gast#<token>`), das der Browser gar nicht erst mitsendet; ein
 * Zugriffsprotokoll oder ein Referrer kann es damit nicht aufnehmen.
 *
 * ## Der Beitritt ist der einzige Endpunkt ohne Sitzung
 *
 * Er verhaelt sich wie eine Anmeldung: kein CSRF-Token (es gibt noch keine Sitzung, an die es gebunden
 * waere), dafuer dieselbe Herkunftspruefung wie der WebSocket-Upgrade. Ein fremder Ursprung kann damit
 * niemandem unbemerkt eine Gastsession in den Browser setzen.
 */

import type { IncomingMessage } from 'node:http'

import type {
  BoardShareLinkView,
  BoardShareLinksResponse,
  CreateBoardShareLinkResponse,
  GuestSessionResponse,
} from '../contracts/api.js'
import {
  BOARD_GUEST_JOIN_PATH,
  BOARD_GUEST_SESSION_PATH,
  BOARD_ID_PARAM,
  BOARD_SHARE_LINK_CREATE_PATH,
  BOARD_SHARE_LINK_REPLACE_PATH,
  BOARD_SHARE_LINK_REVOKE_PATH,
  BOARD_SHARE_LINKS_PATH,
  GUEST_APP_PATH,
  MAX_SHARE_LINK_RECIPIENTS,
} from '../contracts/api.js'
import type { AuthenticatedGuest, BoardShareLink } from '../domain/board/guest.js'
import type { AuthenticatedSession } from '../domain/identity/model.js'
import { normalizeEmail } from '../domain/identity/local-auth.js'
import {
  DEFAULT_GUEST_ROLE,
  MAX_GUEST_DISPLAY_NAME_LENGTH,
  guestSessionExpiry,
  normalizeGuestDisplayName,
  parseGuestRole,
  parseShareLinkExpiry,
} from '../domain/board/guest.js'
import type { BoardAccess, BoardShareLinkEntry, BoardStore } from '../domain/board/repositories.js'
import { NOT_FOUND, createBoardGate } from './board-access.js'
import { toBoardView, toGuestBoardView } from './board-views.js'
import type { AppContext } from './context.js'
import { requireSession } from './guard.js'
import {
  createGuestSessionToken,
  createShareToken,
  guestCsrfTokenFor,
  hashGuestToken,
  resolveGuestSession,
  setGuestCookie,
} from './guest-session.js'
import type { Route } from './http.js'
import { readJsonBody, sendError, sendJson } from './http.js'
import { deliverShareLink, shareLinkMail } from './mailer.js'
import { createQuota } from './rate-limit.js'
import type { Reply } from './reply.js'
import { fail, isReply, ok, readUuid, send } from './reply.js'
import { asRequester } from './requester.js'

/** Linkmails je Nutzer und Stunde. Gezaehlt werden Mails (Empfaenger), nicht Anfragen. */
const SHARE_LINK_MAILS_PER_HOUR = 20
const HOUR_MS = 3_600_000

/**
 * `recipients` aus dem Anfragekoerper: fehlt es, gibt es keine; sonst 1 bis 5 gueltige Adressen ohne
 * Duplikate. `null` heisst ungueltig.
 */
function parseRecipients(raw: unknown): readonly string[] | null {
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SHARE_LINK_RECIPIENTS) {
    return null
  }
  const normalized = raw.map(normalizeEmail)
  return normalized.every((email) => email !== null) ? [...new Set(normalized)] : null
}

function toShareLinkView(entry: BoardShareLinkEntry): BoardShareLinkView {
  return {
    id: entry.id,
    role: entry.role,
    createdByDisplayName: entry.createdByDisplayName,
    createdAt: entry.createdAt.toISOString(),
    expiresAt: entry.expiresAt?.toISOString() ?? null,
    revokedAt: entry.revokedAt?.toISOString() ?? null,
    guestCount: entry.guestCount,
  }
}

/** Die frisch angelegte Zeile hat naturgemaess noch keinen Gast und keinen Widerruf. */
function toCreatedView(link: BoardShareLink, createdByDisplayName: string): BoardShareLinkView {
  return toShareLinkView({ ...link, createdByDisplayName, guestCount: 0 })
}

function toGuestSessionResponse(
  access: BoardAccess,
  guest: AuthenticatedGuest,
  csrfToken: string,
): GuestSessionResponse {
  return {
    // Dieselbe reduzierte Sicht wie in der Szenenantwort - sie entsteht an genau einer Stelle, und ihre
    // Rolle kommt wie dort aus der Policy.
    board: toGuestBoardView({ kind: 'guest', guest }, access),
    role: guest.role,
    displayName: guest.session.displayName,
    csrfToken,
    expiresAt: guest.session.expiresAt.toISOString(),
  }
}

export function createBoardShareRoutes(context: AppContext): readonly Route[] {
  const { boards: store, config } = context
  const { deny, loadVisibleBoard, withLockedBoard } = createBoardGate(context)
  const allowedOrigin = new URL(config.baseUrl).origin
  const mailQuota = createQuota({
    limit: SHARE_LINK_MAILS_PER_HOUR,
    windowMs: HOUR_MS,
    now: () => context.now().getTime(),
  })

  /**
   * Prueft `recipients` und bucht die Mails gegen die Grenze des Nutzers, bevor ein Link entsteht. Liefert
   * die Empfaenger oder die fertige Ablehnung. Gebucht ist auch dann, wenn die Transaktion danach scheitert:
   * die Grenze lieber zu streng als zu lax.
   */
  function reserveMails(auth: AuthenticatedSession, raw: unknown): readonly string[] | Reply {
    const recipients = parseRecipients(raw)
    if (recipients === null) {
      return fail(400, `recipients muss 1 bis ${String(MAX_SHARE_LINK_RECIPIENTS)} gueltige E-Mail-Adressen nennen`)
    }
    if (recipients.length === 0) {
      return recipients
    }
    if (context.mailer === null) {
      return fail(400, 'Diese Instanz hat keinen Postausgang; recipients ist nicht verfuegbar')
    }
    if (!mailQuota.take(auth.user.id, recipients.length)) {
      return fail(429, `Hoechstens ${String(SHARE_LINK_MAILS_PER_HOUR)} Linkmails pro Stunde`)
    }
    return recipients
  }

  /**
   * Versendet nach dem Commit und ausserhalb der Boardsperre und ergaenzt die 201-Antwort um die Zahlen.
   * Ein Fehlschlag macht den Link nicht ungueltig. Adresse und Link verlassen diese Funktion nie ins Log.
   */
  function sendAfterCommit(
    mail: ((to: string, url: string) => ReturnType<typeof shareLinkMail>) | null,
    recipients: readonly string[],
  ): (reply: Reply) => Promise<Reply> {
    return async (reply) => {
      const mailer = context.mailer
      if (mail === null || mailer === null || recipients.length === 0 || reply.status !== 201) {
        return reply
      }
      const created = reply.body as CreateBoardShareLinkResponse
      const results = await Promise.all(
        recipients.map((to) => deliverShareLink(mailer, mail(to, created.url))),
      )
      const sent = results.filter(Boolean).length
      return ok(201, { ...created, mails: { sent, failed: results.length - sent } })
    }
  }

  /**
   * Dieselbe Regel wie beim WebSocket-Upgrade: ein fehlender `Origin` wird angenommen, weil ein Browser ihn
   * bei einem POST immer sendet - eine Anfrage ohne den Header stammt also nicht aus einem Browser und
   * traegt kein fremd erzwungenes Cookie.
   */
  function hasAllowedOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin
    return origin === undefined || origin === allowedOrigin
  }

  /**
   * Creates a link with audit and log in the running transaction. Shared by create and replace so both
   * write the same evidence. The token exists only in the return value.
   */
  async function issueShareLink(
    tx: BoardStore,
    auth: AuthenticatedSession,
    access: BoardAccess,
    input: {
      readonly role: BoardShareLink['role']
      readonly expiresAt: Date | null
      readonly recipientCount: number
      readonly replacesId?: string
    },
  ): Promise<CreateBoardShareLinkResponse> {
    // From here on the plaintext token exists only in this variable and in the response.
    const token = createShareToken()
    const link = await tx.shareLinks.create({
      boardId: access.board.id,
      workspaceId: access.workspace.id,
      tokenHash: hashGuestToken(token),
      role: input.role,
      createdByUserId: auth.user.id,
      expiresAt: input.expiresAt,
    })
    await tx.audit.record({
      actorId: auth.user.id,
      action: 'board-share-link.created',
      targetType: 'board-share-link',
      targetId: link.id,
      workspaceId: access.workspace.id,
      // Share metadata, never the token and never board content.
      details: {
        boardId: access.board.id,
        role: link.role,
        expiresAt: link.expiresAt?.toISOString() ?? null,
        // Nur die Zahl: die Adressen werden nirgends gespeichert.
        recipientCount: input.recipientCount,
        ...(input.replacesId === undefined ? {} : { replacesShareLinkId: input.replacesId }),
      },
    })
    context.logger('info', 'board.share-link.created', {
      userId: auth.user.id,
      boardId: access.board.id,
      shareLinkId: link.id,
      role: link.role,
      ...(input.replacesId === undefined ? {} : { replacesShareLinkId: input.replacesId }),
    })
    return {
      link: toCreatedView(link, auth.user.displayName),
      // Fragment instead of query string: the token never reaches a server, log or referrer, not even ours.
      url: `${new URL(GUEST_APP_PATH, config.baseUrl).href}#${token}`,
    }
  }

  /** Revokes a link with audit and log in the running transaction; `null` if it does not exist. */
  async function revokeShareLink(
    tx: BoardStore,
    auth: AuthenticatedSession,
    access: BoardAccess,
    shareLinkId: string,
  ): Promise<BoardShareLink | null> {
    const link = await tx.shareLinks.revoke(access.board.id, shareLinkId, context.now())
    if (link === null) {
      return null
    }
    await tx.audit.record({
      actorId: auth.user.id,
      action: 'board-share-link.revoked',
      targetType: 'board-share-link',
      targetId: link.id,
      workspaceId: access.workspace.id,
      details: { boardId: access.board.id, role: link.role },
    })
    context.logger('info', 'board.share-link.revoked', {
      userId: auth.user.id,
      boardId: access.board.id,
      shareLinkId: link.id,
    })
    return link
  }

  return [
    /**
     * Liste der Freigabelinks eines Boards.
     *
     * Hinter `grant:manage` und nicht hinter `board:read`: wer ein Board nur sieht, muss nicht wissen, ueber
     * welche Wege es sonst noch erreichbar ist. Die Liste zeigt Rolle, Ablauf, Widerruf und die Zahl der
     * Beitritte - **nie** ein Token.
     */
    {
      method: 'GET',
      path: BOARD_SHARE_LINKS_PATH,
      handle: async ({ request, response, url }) => {
        const auth = await requireSession(context, request, response)
        if (auth === null) {
          return
        }
        const boardId = readUuid(url.searchParams.get(BOARD_ID_PARAM))
        if (boardId === null) {
          sendError(response, 404, NOT_FOUND.message)
          return
        }
        const access = await loadVisibleBoard(store, asRequester(auth), boardId, { lock: false })
        if (isReply(access)) {
          send(response, access)
          return
        }
        const denial = deny(asRequester(auth), access.workspace, access, 'grant:manage')
        if (denial !== null) {
          send(response, denial)
          return
        }
        const links = await store.shareLinks.listForBoard(boardId)
        // Diese Liste erreicht ausschliesslich der Board-Owner; sie traegt deshalb die volle Boardsicht.
        const body: BoardShareLinksResponse = {
          board: toBoardView(asRequester(auth), access),
          links: links.map(toShareLinkView),
          mailAvailable: context.mailer !== null,
        }
        send(response, ok(200, body))
      },
    },

    /**
     * Freigabelink anlegen.
     *
     * Ohne ausdrueckliche Rolle gilt `guest-viewer`: eine Freigabe nach aussen gibt so wenig wie moeglich,
     * und Schreibrecht ist eine bewusste Entscheidung. Ohne Ablaufangabe laeuft der Link nicht von selbst
     * ab - das steht so in der Liste, und der Widerruf bleibt sein Ende.
     */
    {
      method: 'POST',
      path: BOARD_SHARE_LINK_CREATE_PATH,
      handle: async ({ request, response }) => {
        let mail: Parameters<typeof sendAfterCommit>[0] = null
        let recipients: readonly string[] = []
        await withLockedBoard(request, response, async (tx, auth, access, body) => {
          const role = body['role'] === undefined ? DEFAULT_GUEST_ROLE : parseGuestRole(body['role'])
          if (role === null) {
            return fail(400, 'role muss guest-viewer oder guest-editor sein')
          }
          const now = context.now()
          const expiresAt = parseShareLinkExpiry(body['expiresAt'], now)
          if (expiresAt === null) {
            return fail(
              400,
              'expiresAt muss ein ISO-8601-Zeitpunkt mit Zeitzone sein, fruehestens in 15 Minuten und hoechstens in 365 Tagen',
            )
          }
          const denial = deny(asRequester(auth), access.workspace, access, 'grant:manage')
          if (denial !== null) {
            return denial
          }
          const reserved = reserveMails(auth, body['recipients'])
          if (isReply(reserved)) {
            return reserved
          }
          const expiry = expiresAt ?? null
          const created = await issueShareLink(tx, auth, access, {
            role,
            expiresAt: expiry,
            recipientCount: reserved.length,
          })
          recipients = reserved
          mail = (to, url) =>
            shareLinkMail(to, {
              ownerName: auth.user.displayName,
              boardTitle: access.board.title,
              role,
              expiresAt: expiry,
              url,
            })
          return ok(201, created)
        }, (reply) => sendAfterCommit(mail, recipients)(reply))
      },
    },

    /**
     * Freigabelink widerrufen.
     *
     * Der Widerruf wirkt auf **alle** aus dem Link entstandenen Gastsessions zugleich, weil jede Aufloesung
     * den Link mitprueft. Offene Realtime-Verbindungen werden zusaetzlich sofort geschlossen, statt auf die
     * naechste Nachpruefung zu warten - dieselbe Behandlung wie eine Sitzung beim Logout.
     *
     * Ein bereits widerrufener Link ergibt dieselbe 200 und laesst seinen Zeitpunkt stehen: der Nachweis
     * soll sagen, wann der Zugang endete.
     */
    {
      method: 'POST',
      path: BOARD_SHARE_LINK_REVOKE_PATH,
      handle: async ({ request, response }) => {
        // Halter statt einer lokalen Variablen: die Zuweisung geschieht im Rueckruf, und erst nach dem
        // Commit darf die Verbindung fallen.
        const revoked: { id: string | null } = { id: null }
        await withLockedBoard(request, response, async (tx, auth, access, body) => {
          const shareLinkId = readUuid(body['shareLinkId'])
          if (shareLinkId === null) {
            return fail(400, 'shareLinkId wird erwartet')
          }
          const denial = deny(asRequester(auth), access.workspace, access, 'grant:manage')
          if (denial !== null) {
            return denial
          }
          const link = await revokeShareLink(tx, auth, access, shareLinkId)
          if (link === null) {
            return fail(404, 'Freigabelink nicht gefunden')
          }
          revoked.id = link.id
          return ok(200, toShareLinkView({ ...link, createdByDisplayName: null, guestCount: 0 }))
        })
        if (revoked.id !== null) {
          // Erst nach dem Commit: eine zurueckgerollte Transaktion darf keine Verbindung beendet haben.
          context.realtime.closeShareLink(revoked.id)
        }
      },
    },

    /**
     * Replaces a share link in one step.
     *
     * Revoking the old and creating the new link run in one transaction under the board lock: if one
     * fails, the other does not happen. The new link keeps role and expiry unchanged. Only valid links
     * are replaced; a revoked, expired, foreign or invented one gives the same 404. The old link's
     * connections close only after the commit, as with revoke.
     */
    {
      method: 'POST',
      path: BOARD_SHARE_LINK_REPLACE_PATH,
      handle: async ({ request, response }) => {
        const revoked: { id: string | null } = { id: null }
        let mail: Parameters<typeof sendAfterCommit>[0] = null
        let recipients: readonly string[] = []
        await withLockedBoard(request, response, async (tx, auth, access, body) => {
          const shareLinkId = readUuid(body['shareLinkId'])
          if (shareLinkId === null) {
            return fail(400, 'shareLinkId wird erwartet')
          }
          const denial = deny(asRequester(auth), access.workspace, access, 'grant:manage')
          if (denial !== null) {
            return denial
          }
          const old = await tx.shareLinks.find(access.board.id, shareLinkId)
          if (old === null || old.revokedAt !== null || (old.expiresAt !== null && old.expiresAt <= context.now())) {
            return fail(404, 'Freigabelink nicht gefunden')
          }
          // Before the revoke: a request over the limit must not end the old link.
          const reserved = reserveMails(auth, body['recipients'])
          if (isReply(reserved)) {
            return reserved
          }
          // The row is held by the board lock, so the revoke hits the link that was checked.
          await revokeShareLink(tx, auth, access, old.id)
          const created = await issueShareLink(tx, auth, access, {
            role: old.role,
            expiresAt: old.expiresAt,
            recipientCount: reserved.length,
            replacesId: old.id,
          })
          revoked.id = old.id
          recipients = reserved
          mail = (to, url) =>
            shareLinkMail(to, {
              ownerName: auth.user.displayName,
              boardTitle: access.board.title,
              role: old.role,
              expiresAt: old.expiresAt,
              url,
            })
          return ok(201, created)
        }, (reply) => sendAfterCommit(mail, recipients)(reply))
        if (revoked.id !== null) {
          context.realtime.closeShareLink(revoked.id)
        }
      },
    },

    /**
     * Beitritt ueber einen Freigabelink.
     *
     * Der einzige Endpunkt der Boardebene ohne jede Sitzung - er legt sie ja erst an. Ein ungueltiges,
     * abgelaufenes oder widerrufenes Token ergibt dieselbe Antwort wie ein frei erfundenes: dass es den
     * Link einmal gab, erfaehrt niemand.
     */
    {
      method: 'POST',
      path: BOARD_GUEST_JOIN_PATH,
      handle: async ({ request, response }) => {
        if (!hasAllowedOrigin(request)) {
          context.logger('warn', 'board.guest.join.denied', { reason: 'fremde-herkunft' })
          sendError(response, 403, 'Ungueltige Herkunft')
          return
        }
        const body = await readJsonBody(request)
        if (body === null) {
          sendError(response, 400, 'Ungueltiger Anfragekoerper')
          return
        }
        const displayName = normalizeGuestDisplayName(body['displayName'])
        if (displayName === null) {
          sendError(
            response,
            400,
            `Ein Anzeigename mit 1 bis ${String(MAX_GUEST_DISPLAY_NAME_LENGTH)} Zeichen wird erwartet`,
          )
          return
        }
        const token = body['token']
        if (typeof token !== 'string' || token.length === 0) {
          // Kein eigener Fehlertext fuer ein fehlendes Token: er waere ein Hinweis darauf, wie eines aussieht.
          sendError(response, 404, 'Dieser Freigabelink gilt nicht mehr')
          return
        }
        const now = context.now()
        const tokenHash = hashGuestToken(token)

        const result = await store.transaction(async (tx) => {
          // Die Gueltigkeit des Links wird in derselben Transaktion gelesen, in der die Gastsession
          // entsteht: ein gleichzeitiger Widerruf hinterlaesst so keinen Gast auf einem ueberholten Stand.
          const link = await tx.shareLinks.findLiveByTokenHash(tokenHash, now)
          if (link === null) {
            return null
          }
          const secret = createGuestSessionToken()
          const session = await tx.guests.create({
            shareLinkId: link.id,
            boardId: link.boardId,
            tokenHash: hashGuestToken(secret),
            displayName,
            expiresAt: guestSessionExpiry(now, link),
          })
          // Das Board wird ueber **die eben angelegte Gastsession** geladen, nicht an ihr vorbei: damit
          // laeuft schon der Beitritt genau ueber den Weg, den jede spaetere Anfrage dieses Gastes nimmt.
          const board = await tx.boards.findForViewer(
            link.boardId,
            { kind: 'guest', guestSessionId: session.id },
            now,
          )
          if (board === null) {
            return null
          }
          await tx.audit.record({
            // Ein Gast ist kein interner Nutzer; der Nachweis nennt stattdessen Link und Gastsession.
            actorId: null,
            action: 'board-guest.joined',
            targetType: 'board-share-link',
            targetId: link.id,
            workspaceId: board.workspace.id,
            details: {
              boardId: link.boardId,
              role: link.role,
              guestSessionId: session.id,
              displayName: session.displayName,
            },
          })
          // Der ganze Zugriff, nicht nur der Datensatz: die Antwort nennt die Rolle des Gastes, und sie
          // kommt aus derselben Policy wie jede Entscheidung ueber ihn.
          return { secret, access: board, guest: { session, role: link.role } }
        })
        if (result === null) {
          context.logger('warn', 'board.guest.join.denied', { reason: 'link-ungueltig' })
          sendError(response, 404, 'Dieser Freigabelink gilt nicht mehr')
          return
        }
        context.logger('info', 'board.guest.joined', {
          boardId: result.access.board.id,
          shareLinkId: result.guest.session.shareLinkId,
          guestSessionId: result.guest.session.id,
        })
        setGuestCookie(response, config, result.secret, result.guest.session.expiresAt)
        sendJson(
          response,
          201,
          toGuestSessionResponse(
            result.access,
            result.guest,
            guestCsrfTokenFor(result.guest.session.id, config.sessionSecret),
          ),
        )
      },
    },

    /**
     * Eigener Gastzugang - die Entsprechung von `/api/me`.
     *
     * Liefert Board, Rolle und das an die Gastsession gebundene CSRF-Token. Er prueft dabei erneut, ob
     * Gastsession und Link noch leben; nach Ablauf oder Widerruf antwortet er wie ohne Cookie.
     */
    {
      method: 'GET',
      path: BOARD_GUEST_SESSION_PATH,
      handle: async ({ request, response }) => {
        const guest = await resolveGuestSession(store, config, request, context.now())
        if (guest === null) {
          sendError(response, 401, 'Kein gueltiger Gastzugang')
          return
        }
        const access = await store.boards.findForViewer(
          guest.session.boardId,
          { kind: 'guest', guestSessionId: guest.session.id },
          context.now(),
        )
        if (access === null) {
          sendError(response, 401, 'Kein gueltiger Gastzugang')
          return
        }
        sendJson(
          response,
          200,
          toGuestSessionResponse(access, guest, guestCsrfTokenFor(guest.session.id, config.sessionSecret)),
        )
      },
    },
  ]
}
