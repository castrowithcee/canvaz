/**
 * Ratengrenze der HTTP-API: der Eimer selbst und die Frage, wen er zaehlt.
 */

import type { IncomingMessage } from 'node:http'

import { describe, expect, it } from 'vitest'

import { clientKey, createRateLimiter } from '../../src/server/rate-limit.js'

/** Nur die beiden Felder, die `clientKey` liest. */
function request(headers: Record<string, string | string[]>, remoteAddress: string): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

describe('Ratengrenze', () => {
  it('laesst die Marken eines Clients zu und lehnt danach ab', () => {
    let jetzt = 0
    const limiter = createRateLimiter({ perMinute: 60, now: () => jetzt })

    for (let i = 0; i < 60; i += 1) {
      expect(limiter.take('a')).toBe(true)
    }
    expect(limiter.take('a')).toBe(false)

    // Eine Marke je Sekunde: nach einer Sekunde geht genau eine Anfrage.
    jetzt += 1000
    expect(limiter.take('a')).toBe(true)
    expect(limiter.take('a')).toBe(false)
  })

  it('zaehlt Clients getrennt', () => {
    const limiter = createRateLimiter({ perMinute: 60, now: () => 0 })
    for (let i = 0; i < 60; i += 1) {
      limiter.take('a')
    }

    expect(limiter.take('a')).toBe(false)
    expect(limiter.take('b')).toBe(true)
  })
})

describe('Wen die Grenze zaehlt', () => {
  it('nimmt ohne vertrauten Proxy ausschliesslich die Verbindungsadresse', () => {
    expect(clientKey(request({ 'x-forwarded-for': '9.9.9.9' }, '10.0.0.1'), false)).toBe('10.0.0.1')
  })

  it('nimmt mit vertrautem Proxy den letzten Eintrag - den der Proxy selbst angehaengt hat', () => {
    // Der erste Eintrag ist der vom Client behauptete; er darf die Zaehlung nicht verwaessern.
    expect(clientKey(request({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }, '10.0.0.1'), true)).toBe('203.0.113.7')
    expect(clientKey(request({}, '10.0.0.1'), true)).toBe('10.0.0.1')
  })
})
