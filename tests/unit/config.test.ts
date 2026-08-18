import { describe, expect, it } from 'vitest'

import { ConfigError, loadConfig } from '../../src/server/config.js'

const validEnv = {
  CANVAZ_BASE_URL: 'https://canvaz.example.com',
  DATABASE_URL: 'postgres://canvaz:geheim@db:5432/canvaz',
  CANVAZ_SESSION_SECRET: 'a'.repeat(32),
  CANVAZ_OIDC_ISSUER: 'https://idp.example.com/realms/canvaz',
  CANVAZ_OIDC_CLIENT_ID: 'canvaz',
  CANVAZ_OIDC_CLIENT_SECRET: 'client-secret',
  CANVAZ_OIDC_REDIRECT_URI: 'https://canvaz.example.com/api/auth/callback',
}

describe('Konfiguration', () => {
  it('liest eine vollstaendige Umgebung typisiert ein', () => {
    const config = loadConfig(validEnv)

    expect(config.port).toBe(3000)
    expect(config.storage.adapter).toBe('filesystem')
    expect(config.sessionTtlSeconds).toBe(12 * 3600)
    expect(config.secureCookies).toBe(true)
    expect(config.oidc.clientId).toBe('canvaz')
    expect(config.maxSceneBytes).toBe(5 * 1024 * 1024)
  })

  it('nimmt eine eigene Szenengrenze nur innerhalb der zulaessigen Spanne an', () => {
    expect(loadConfig({ ...validEnv, CANVAZ_MAX_SCENE_BYTES: '1048576' }).maxSceneBytes).toBe(1_048_576)
    expect(() => loadConfig({ ...validEnv, CANVAZ_MAX_SCENE_BYTES: '1024' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...validEnv, CANVAZ_MAX_SCENE_BYTES: '999999999' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...validEnv, CANVAZ_MAX_SCENE_BYTES: 'viel' })).toThrow(ConfigError)
  })

  it('meldet alle fehlenden Pflichtwerte auf einmal statt still zu ersetzen', () => {
    let caught: unknown
    try {
      loadConfig({})
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ConfigError)
    const problems = (caught as ConfigError).problems
    expect(problems).toContain('DATABASE_URL fehlt')
    expect(problems).toContain('CANVAZ_SESSION_SECRET fehlt')
    expect(problems).toContain('CANVAZ_OIDC_CLIENT_SECRET fehlt')
  })

  it('weist ein zu kurzes Session-Geheimnis und falsche Werte zurueck', () => {
    expect(() => loadConfig({ ...validEnv, CANVAZ_SESSION_SECRET: 'kurz' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: 'mysql://db/canvaz' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...validEnv, CANVAZ_STORAGE_ADAPTER: 'ftp' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...validEnv, CANVAZ_PORT: '0' })).toThrow(ConfigError)
  })

  it('verlangt eine Redirect-URI unter der eigenen Basis-URL', () => {
    expect(() =>
      loadConfig({ ...validEnv, CANVAZ_OIDC_REDIRECT_URI: 'https://fremd.example.com/api/auth/callback' }),
    ).toThrow(ConfigError)
  })

  it('setzt unsichere Cookies nur ohne TLS-Basis-URL', () => {
    const config = loadConfig({
      ...validEnv,
      CANVAZ_BASE_URL: 'http://localhost:3000',
      CANVAZ_OIDC_REDIRECT_URI: 'http://localhost:3000/api/auth/callback',
    })

    expect(config.secureCookies).toBe(false)
  })
})
