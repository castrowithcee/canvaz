/**
 * Postausgang der Instanz.
 *
 * Genau zwei Nachrichten verlassen Canvaz: die Einladung, die ein Konto uebergibt, und die Mitteilung, dass
 * ein Passwort administrativ zurueckgesetzt wurde. Beide gehen an die Adresse des betroffenen Kontos und an
 * keine andere.
 *
 * ## Was in einer Mail steht und was nicht
 *
 * Der Einladungswert steht im Link - er ist der Zweck der Nachricht und nirgends sonst gespeichert. Ein
 * Passwort steht in **keiner** Nachricht: eine Ruecksetzung meldet, dass sie stattgefunden hat, und nennt
 * das neue Initialpasswort ausdruecklich nicht. Ein Postfach ist kein Ort fuer ein Geheimnis, das ohne
 * zweiten Faktor Zugang gibt.
 *
 * ## Der Versand ist eine Zustellung und keine Bedingung
 *
 * Die Anlage eines Kontos ist abgeschlossen, bevor hier etwas passiert. Ein nicht erreichbarer Server macht
 * daraus keinen Fehlschlag: der Einladungslink steht wie ohne Postausgang in der Antwort der Anlage, und ein
 * Administrator kann ihn selbst zustellen. Deshalb faengt `deliver` jeden Fehler und protokolliert ihn,
 * statt ihn in die Route zurueckzugeben.
 */

import { createTransport } from 'nodemailer'
import type { Transporter } from 'nodemailer'

import { INVITATION_TTL_HOURS } from '../domain/identity/local-auth.js'
import type { MailConfig } from './config.js'
import type { Logger } from './log.js'
import { describeError } from './log.js'

export type Mail = {
  readonly to: string
  readonly subject: string
  readonly text: string
}

/** Der Port. Die Anwendung kennt nur ihn; ob dahinter SMTP steht, weiss allein die Composition Root. */
export type Mailer = (mail: Mail) => Promise<void>

/**
 * Kurze Fristen statt der Voreinstellungen von zwei Minuten: hinter dem Versand wartet eine HTTP-Antwort,
 * und ein Postausgang, der nicht antwortet, darf sie nicht so lange aufhalten.
 */
const CONNECTION_TIMEOUT_MS = 10_000
const GREETING_TIMEOUT_MS = 10_000
const SOCKET_TIMEOUT_MS = 20_000

export function createSmtpMailer(config: MailConfig): Mailer {
  // Ein Transport fuer den ganzen Prozess: er haelt die Verbindung und baut sie nicht je Nachricht neu auf.
  const transport: Transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.auth === null ? {} : { auth: { user: config.auth.user, pass: config.auth.password } }),
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  })
  return async (mail: Mail): Promise<void> => {
    await transport.sendMail({
      from: `Canvaz <${config.from}>`,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    })
  }
}

/**
 * Zustellversuch ohne Rueckweg in die Route.
 *
 * Protokolliert wird die Empfaengeradresse und die Art der Nachricht - nie ihr Inhalt, weil der bei der
 * Einladung den Wert traegt.
 */
export async function deliver(
  mailer: Mailer | null,
  logger: Logger,
  kind: string,
  mail: Mail,
): Promise<void> {
  if (mailer === null) {
    return
  }
  try {
    await mailer(mail)
    logger('info', 'mail.sent', { kind, to: mail.to })
  } catch (error) {
    logger('error', 'mail.failed', { kind, to: mail.to, error: describeError(error) })
  }
}

export function invitationMail(to: string, displayName: string, url: string): Mail {
  return {
    to,
    subject: 'Ihr Zugang zu Canvaz',
    text: [
      `Hallo ${displayName},`,
      '',
      'fuer Sie wurde ein Zugang zu Canvaz angelegt. Ueber diesen Link vergeben Sie Ihr Passwort:',
      '',
      url,
      '',
      `Der Link gilt ${String(INVITATION_TTL_HOURS)} Stunden und laesst sich genau einmal einloesen.`,
      'Haben Sie ihn nicht erwartet, ignorieren Sie diese Nachricht - ohne Einloesung passiert nichts.',
      '',
    ].join('\n'),
  }
}

export function passwordResetMail(to: string, displayName: string, baseUrl: string): Mail {
  return {
    to,
    subject: 'Ihr Canvaz-Passwort wurde zurueckgesetzt',
    text: [
      `Hallo ${displayName},`,
      '',
      'die Administration hat das Passwort Ihres Canvaz-Kontos zurueckgesetzt. Alle offenen Sitzungen',
      'wurden dabei beendet.',
      '',
      'Das neue Passwort steht ausdruecklich nicht in dieser Nachricht; Sie erhalten es auf dem Weg, den',
      'Ihre Administration mit Ihnen vereinbart hat. Bei der naechsten Anmeldung vergeben Sie sofort ein',
      'eigenes.',
      '',
      baseUrl,
      '',
      'Haben Sie die Ruecksetzung nicht angefragt, wenden Sie sich an Ihre Administration.',
      '',
    ].join('\n'),
  }
}
