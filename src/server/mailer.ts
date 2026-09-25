/**
 * Postausgang der Instanz.
 *
 * Diese Nachrichten verlassen Canvaz: die Einladung, die ein Konto uebergibt, die Mitteilung, dass ein
 * Passwort administrativ zurueckgesetzt wurde, und fuer den Systemadmin die Mitteilungen ueber eine
 * Aenderung seines zweiten Faktors und ueber eine Betreiber-Wiederherstellung. Jede geht an die Adresse des
 * betroffenen Kontos und an keine andere. Die Selbstwiederherstellung schreibt stattdessen an die
 * Wiederherstellungsadresse: den Bestaetigungslink an die neue, Ruecksetzungslink und Mitteilung ueber die
 * Ruecksetzung an die bestaetigte.
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
import { PASSWORD_RESET_TTL_MINUTES, RECOVERY_EMAIL_CONFIRM_TTL_HOURS } from '../domain/identity/self-recovery.js'
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
    // Ohne implizites TLS muss der Server STARTTLS anbieten, sonst bricht der Versand vor der Nachricht ab.
    // Nur die ausdrueckliche Ausnahme laesst eine Klartextverbindung zu.
    requireTLS: !config.allowInsecure,
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

/** Was sich am zweiten Faktor geaendert hat. */
export type SecondFactorChange = 'enrolled' | 'backup-codes' | 'removed-by-recovery'

const SECOND_FACTOR_CHANGE_TEXTS: Readonly<Record<SecondFactorChange, string>> = {
  enrolled: 'fuer Ihr Canvaz-Konto wurde ein zweiter Faktor (Authenticator-App) neu eingerichtet.',
  'backup-codes': 'fuer Ihr Canvaz-Konto wurden neue Ersatzcodes ausgegeben; die bisherigen gelten nicht mehr.',
  'removed-by-recovery':
    'der zweite Faktor Ihres Canvaz-Kontos wurde mit einer Betreiber-Wiederherstellung entfernt. Bei der\nnaechsten Anmeldung richten Sie ihn neu ein.',
}

/**
 * Mitteilung ueber eine Aenderung des zweiten Faktors. Sie traegt weder Geheimnis noch Ersatzcode - nur,
 * dass etwas geschehen ist, damit der Inhaber eine fremde Aenderung bemerkt.
 */
export function secondFactorChangedMail(to: string, displayName: string, change: SecondFactorChange, baseUrl: string): Mail {
  return {
    to,
    subject: 'Ihr zweiter Faktor fuer Canvaz wurde geaendert',
    text: [
      `Hallo ${displayName},`,
      '',
      SECOND_FACTOR_CHANGE_TEXTS[change],
      'Alle anderen Sitzungen dieses Kontos wurden dabei beendet.',
      '',
      baseUrl,
      '',
      'Waren Sie das nicht, verstaendigen Sie sofort den Betrieb der Instanz: er stellt den Zugang mit',
      '`admin:recover` wieder her.',
      '',
    ].join('\n'),
  }
}

/**
 * Mitteilung ueber eine Betreiber-Wiederherstellung. Der Link steht ausdruecklich **nicht** darin: er geht
 * ausserhalb der Anwendung an den Inhaber, und ein Postfach soll ihn nie allein tragen.
 */
export function adminRecoveryMail(to: string, displayName: string, expiresAt: Date, baseUrl: string): Mail {
  return {
    to,
    subject: 'Wiederherstellung Ihres Canvaz-Adminzugangs',
    text: [
      `Hallo ${displayName},`,
      '',
      'der Betrieb hat den Zugang Ihres Canvaz-Adminkontos wiederhergestellt. Alle Sitzungen wurden beendet;',
      `ein einmaliger Wiederherstellungslink gilt bis ${expiresAt.toISOString()} und erreicht Sie auf dem`,
      'vereinbarten Weg - nicht mit dieser Nachricht. Mit seiner Einloesung wird Ihr zweiter Faktor entfernt',
      'und bei der naechsten Anmeldung neu eingerichtet.',
      '',
      baseUrl,
      '',
      'Haben Sie die Wiederherstellung nicht angefragt, verstaendigen Sie sofort den Betrieb.',
      '',
    ].join('\n'),
  }
}

/** Bestaetigung einer Wiederherstellungsadresse. Geht an die neue Adresse und belegt deren Besitz. */
export function recoveryEmailConfirmMail(to: string, displayName: string, url: string): Mail {
  return {
    to,
    subject: 'Wiederherstellungsadresse fuer Canvaz bestaetigen',
    text: [
      `Hallo ${displayName},`,
      '',
      'diese Adresse wurde als Wiederherstellungsadresse Ihres Canvaz-Kontos eingetragen. Ueber diesen Link',
      'bestaetigen Sie sie:',
      '',
      url,
      '',
      `Der Link gilt ${String(RECOVERY_EMAIL_CONFIRM_TTL_HOURS)} Stunden und laesst sich genau einmal einloesen.`,
      'Haben Sie das nicht veranlasst, ignorieren Sie diese Nachricht - ohne Bestaetigung passiert nichts.',
      '',
    ].join('\n'),
  }
}

/** Ruecksetzungslink der Selbstwiederherstellung. Geht ausschliesslich an die bestaetigte Adresse. */
export function selfResetLinkMail(to: string, displayName: string, url: string): Mail {
  return {
    to,
    subject: 'Canvaz-Passwort zuruecksetzen',
    text: [
      `Hallo ${displayName},`,
      '',
      'fuer Ihr Canvaz-Konto wurde ein neues Passwort angefragt. Ueber diesen Link vergeben Sie es:',
      '',
      url,
      '',
      `Der Link gilt ${String(PASSWORD_RESET_TTL_MINUTES)} Minuten und laesst sich genau einmal einloesen.`,
      'Haben Sie das nicht angefragt, ignorieren Sie diese Nachricht: Ihr Passwort und Ihre Sitzungen bleiben',
      'unveraendert.',
      '',
    ].join('\n'),
  }
}

/** Mitteilung nach einer Selbstwiederherstellung - ohne Link und ohne Passwort. */
export function selfResetDoneMail(to: string, displayName: string, baseUrl: string): Mail {
  return {
    to,
    subject: 'Ihr Canvaz-Passwort wurde geaendert',
    text: [
      `Hallo ${displayName},`,
      '',
      'das Passwort Ihres Canvaz-Kontos wurde ueber einen Ruecksetzungslink neu gesetzt. Alle Sitzungen',
      'wurden dabei beendet; melden Sie sich mit dem neuen Passwort an.',
      '',
      baseUrl,
      '',
      'Waren Sie das nicht, wenden Sie sich sofort an Ihre Administration.',
      '',
    ].join('\n'),
  }
}
