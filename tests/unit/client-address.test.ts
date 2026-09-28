/**
 * Client-Adresse: Ermittlung, Klassifizierung und der Plausibilitaetshinweis.
 */

import type { IncomingMessage } from 'node:http'

import { describe, expect, it } from 'vitest'

import type { LogFields, LogLevel } from '../../src/server/log.js'
import type { AddressClass, ClientAddressMonitor } from '../../src/server/client-address.js'
import { createClientAddressMonitor, resolveClientAddress } from '../../src/server/client-address.js'

/** Nur die beiden Felder, die `resolveClientAddress` liest. */
function request(headers: Record<string, string | string[]>, remoteAddress: string): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

describe('Ermittlung und Klassifizierung', () => {
  it('erkennt eine oeffentliche IPv4-Adresse ohne Proxy', () => {
    expect(resolveClientAddress(request({}, '203.0.113.7'), false)).toEqual({
      address: '203.0.113.7',
      class: 'public',
    })
  })

  it('erkennt eine oeffentliche IPv6-Adresse, auch IPv4-gemappt', () => {
    expect(resolveClientAddress(request({}, '2001:db8::1'), false).class).toBe('public')
    expect(resolveClientAddress(request({}, '::ffff:203.0.113.7'), false)).toEqual({
      address: '::ffff:203.0.113.7',
      class: 'public',
    })
  })

  it('erkennt private Bereiche', () => {
    expect(resolveClientAddress(request({}, '10.1.2.3'), false).class).toBe('private')
    expect(resolveClientAddress(request({}, '192.168.1.1'), false).class).toBe('private')
    expect(resolveClientAddress(request({}, '100.64.0.5'), false).class).toBe('private')
    expect(resolveClientAddress(request({}, 'fd00::1'), false).class).toBe('private')
  })

  it('erkennt Loopback', () => {
    expect(resolveClientAddress(request({}, '127.0.0.1'), false).class).toBe('loopback')
    expect(resolveClientAddress(request({}, '::1'), false).class).toBe('loopback')
  })

  it('erkennt die Proxyadresse: fehlendes x-forwarded-for hinter vertrautem Proxy', () => {
    expect(resolveClientAddress(request({}, '172.18.0.1'), true)).toEqual({ address: '172.18.0.1', class: 'proxy' })
  })

  it('erkennt die Proxyadresse: letzter Eintrag deckt sich mit der Verbindungsadresse', () => {
    expect(resolveClientAddress(request({ 'x-forwarded-for': '172.18.0.1' }, '172.18.0.1'), true)).toEqual({
      address: '172.18.0.1',
      class: 'proxy',
    })
  })

  it('nimmt mit vertrautem Proxy den letzten Eintrag aus x-forwarded-for als Client', () => {
    expect(
      resolveClientAddress(request({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }, '172.18.0.1'), true),
    ).toEqual({ address: '203.0.113.7', class: 'public' })
  })

  it('ignoriert x-forwarded-for ohne vertrauten Proxy', () => {
    expect(resolveClientAddress(request({ 'x-forwarded-for': '203.0.113.7' }, '10.0.0.1'), false)).toEqual({
      address: '10.0.0.1',
      class: 'private',
    })
  })
})

type LogEntry = { readonly level: LogLevel; readonly event: string; readonly fields: LogFields }

describe('Plausibilitaetshinweis', () => {
  function logCollector(): { readonly entries: LogEntry[]; readonly logger: (level: LogLevel, event: string, fields?: LogFields) => void } {
    const entries: LogEntry[] = []
    return { entries, logger: (level, event, fields = {}) => entries.push({ level, event, fields }) }
  }

  /** 90% nicht-oeffentlich - jede zehnte Anfrage oeffentlich, der Rest privat. */
  function mostlyPrivate(i: number): AddressClass {
    return i % 10 === 0 ? 'public' : 'private'
  }

  function feed(monitor: ClientAddressMonitor, count: number, classOf: (i: number) => AddressClass): void {
    for (let i = 0; i < count; i += 1) {
      monitor.record({ address: 'x', class: classOf(i) })
    }
  }

  function warnings(entries: readonly LogEntry[]): readonly LogEntry[] {
    return entries.filter((entry) => entry.event === 'client-address.mostly-internal')
  }

  it('bleibt unbekannt unter der Mindeststichprobe', () => {
    const { logger, entries } = logCollector()
    const monitor = createClientAddressMonitor(logger)
    feed(monitor, 10, () => 'private')
    expect(monitor.plausibility()).toBe('unknown')
    expect(entries).toHaveLength(0)
  })

  it('warnt beim Uebergang zu implausibel, aber nicht erneut, solange es dabei bleibt', () => {
    const { logger, entries } = logCollector()
    const monitor = createClientAddressMonitor(logger)

    // Ein volles Fenster ueberwiegend privater Anfragen: die Warnung feuert beim Erreichen der
    // Mindeststichprobe (bei 50 von 200) und nicht noch einmal fuer den Rest desselben Fensters.
    feed(monitor, 200, mostlyPrivate)
    expect(monitor.plausibility()).toBe('implausible')
    expect(warnings(entries)).toHaveLength(1)
    // Keine Adresse und keine Klasse je Anfrage im Log, nur Zaehlwerte.
    expect(warnings(entries)[0]?.fields).toEqual({ sampleSize: 50, nonPublicPercent: 90 })

    // Ueber mehrere weitere Fenster hinweg bleibt es bei genau der einen Warnung, solange es implausibel bleibt.
    feed(monitor, 400, mostlyPrivate)
    expect(monitor.plausibility()).toBe('implausible')
    expect(warnings(entries)).toHaveLength(1)
  })

  it('warnt erneut, wenn es nach einer Erholung wieder implausibel wird', () => {
    const { logger, entries } = logCollector()
    const monitor = createClientAddressMonitor(logger)

    feed(monitor, 200, mostlyPrivate)
    expect(monitor.plausibility()).toBe('implausible')
    expect(warnings(entries)).toHaveLength(1)

    // Ein volles Fenster ueberwiegend oeffentlicher Anfragen: der Zustand erholt sich, ohne dass die
    // Erholung selbst eine Meldung ausloest.
    feed(monitor, 200, () => 'public')
    expect(monitor.plausibility()).toBe('plausible')
    expect(warnings(entries)).toHaveLength(1)

    // Ein erneuter Einbruch darf wieder warnen.
    feed(monitor, 200, mostlyPrivate)
    expect(monitor.plausibility()).toBe('implausible')
    expect(warnings(entries)).toHaveLength(2)
  })

  it('bleibt plausibel, wenn die Adressen ueberwiegend oeffentlich sind', () => {
    const { logger, entries } = logCollector()
    const monitor = createClientAddressMonitor(logger)
    feed(monitor, 60, () => 'public')
    expect(monitor.plausibility()).toBe('plausible')
    expect(entries).toHaveLength(0)
  })
})
