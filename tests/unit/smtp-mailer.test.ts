/**
 * Der SMTP-Postausgang gegen einen Relay, der kein STARTTLS anbietet.
 *
 * Der Relay ist ein minimaler SMTP-Dialog auf der Loopback-Schnittstelle, gestartet von diesem Test. Zwei
 * Zusagen:
 *
 * - Ohne implizites TLS und ohne Ausnahme bricht der Versand ab, bevor ein Absender, Empfaenger oder Inhalt
 *   den Relay erreicht.
 * - Mit der ausdruecklichen Ausnahme geht die Nachricht im Klartext durch - der Weg fuer einen isolierten
 *   lokalen Relay.
 */

import { createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { MailConfig } from '../../src/server/config.js'
import { createSmtpMailer } from '../../src/server/mailer.js'

const MAIL = { to: 'person@example.com', subject: 'Ihr Zugang zu Canvaz', text: 'https://canvaz.example/einladung' }

let relay: Server
let port: number
const sockets = new Set<Socket>()
const commands: string[] = []
const messages: string[] = []

/** Ein Relay, der auf EHLO kein STARTTLS nennt und den Befehl ablehnt. */
function startRelay(): Promise<Server> {
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    let data: string | null = null
    socket.write('220 relay ESMTP\r\n')
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let end: number
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (data !== null) {
          if (line === '.') {
            messages.push(data)
            data = null
            socket.write('250 queued\r\n')
          } else {
            data += `${line}\n`
          }
          continue
        }
        commands.push(line)
        const verb = line.split(' ')[0]?.toUpperCase()
        if (verb === 'EHLO') socket.write('250-relay\r\n250 8BITMIME\r\n')
        else if (verb === 'STARTTLS') socket.write('502 5.5.1 not supported\r\n')
        else if (verb === 'MAIL' || verb === 'RCPT' || verb === 'RSET') socket.write('250 ok\r\n')
        else if (verb === 'DATA') {
          data = ''
          socket.write('354 go ahead\r\n')
        } else if (verb === 'QUIT') socket.end('221 bye\r\n')
        else socket.write('502 unknown\r\n')
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function config(allowInsecure: boolean): MailConfig {
  return { host: '127.0.0.1', port, secure: false, allowInsecure, auth: null, from: 'canvaz@example.com' }
}

beforeAll(async () => {
  relay = await startRelay()
  port = (relay.address() as AddressInfo).port
})

afterAll(async () => {
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => relay.close(resolve))
})

beforeEach(() => {
  commands.length = 0
  messages.length = 0
})

describe('SMTP-Postausgang ohne STARTTLS beim Relay', () => {
  it('bricht ohne Ausnahme ab, bevor die Nachricht den Relay erreicht', async () => {
    await expect(createSmtpMailer(config(false))(MAIL)).rejects.toMatchObject({ code: 'ETLS' })

    expect(commands.some((line) => /^(MAIL|RCPT|DATA)\b/i.test(line))).toBe(false)
    expect(messages).toHaveLength(0)
  })

  it('stellt mit der ausdruecklichen Ausnahme im Klartext zu', async () => {
    await createSmtpMailer(config(true))(MAIL)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('To: person@example.com')
    expect(messages[0]).toContain(MAIL.text)
  })
})
