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
  CANVAZ_STORAGE_FILESYSTEM_ROOT: '/srv/canvaz/assets',
}

/** Vollstaendige S3-Umgebung. Der Adapterwechsel ist ausschliesslich Konfiguration. */
const s3Env = {
  ...validEnv,
  CANVAZ_STORAGE_ADAPTER: 's3',
  CANVAZ_S3_ENDPOINT: 'https://s3.example.com',
  CANVAZ_S3_REGION: 'eu-central-1',
  CANVAZ_S3_BUCKET: 'canvaz-assets',
  CANVAZ_S3_ACCESS_KEY_ID: 'schluessel',
  CANVAZ_S3_SECRET_ACCESS_KEY: 'geheimnis',
}

describe('Konfiguration', () => {
  it('liest eine vollstaendige Umgebung typisiert ein', () => {
    const config = loadConfig(validEnv)

    expect(config.port).toBe(3000)
    expect(config.storage.adapter).toBe('filesystem')
    expect(config.sessionTtlSeconds).toBe(12 * 3600)
    expect(config.secureCookies).toBe(true)
    expect(config.oidc?.clientId).toBe('canvaz')
    expect(config.maxSceneBytes).toBe(5 * 1024 * 1024)
    expect(config.storage.maxAssetBytes).toBe(5 * 1024 * 1024)
    expect(config.storage.filesystem).toEqual({ root: '/srv/canvaz/assets' })
    expect(config.storage.s3).toBeNull()
  })

  it('liest die S3-Umgebung vollstaendig und ohne Ersatzwerte ein', () => {
    const config = loadConfig(s3Env)

    expect(config.storage.adapter).toBe('s3')
    expect(config.storage.filesystem).toBeNull()
    expect(config.storage.s3).toEqual({
      endpoint: 'https://s3.example.com',
      region: 'eu-central-1',
      bucket: 'canvaz-assets',
      accessKeyId: 'schluessel',
      secretAccessKey: 'geheimnis',
      // AWS-Standard; MinIO braucht ausdruecklich true.
      forcePathStyle: false,
    })
    expect(loadConfig({ ...s3Env, CANVAZ_S3_FORCE_PATH_STYLE: 'true' }).storage.s3?.forcePathStyle).toBe(true)
  })

  it('nennt fehlende adapterspezifische Pflichtwerte beim Namen', () => {
    // Der Dateisystem-Adapter hat bewusst keinen Standardpfad: ein Ersatzwert im Containerlayer saehe aus
    // wie Persistenz und waere beim naechsten Neustart weg.
    const ohneWurzel = { ...validEnv, CANVAZ_STORAGE_FILESYSTEM_ROOT: '' }
    expect(() => loadConfig(ohneWurzel)).toThrow(ConfigError)
    try {
      loadConfig(ohneWurzel)
    } catch (error) {
      expect((error as ConfigError).problems).toContain('CANVAZ_STORAGE_FILESYSTEM_ROOT fehlt')
    }

    try {
      loadConfig({ ...validEnv, CANVAZ_STORAGE_ADAPTER: 's3' })
    } catch (error) {
      expect((error as ConfigError).problems).toEqual([
        'CANVAZ_S3_ENDPOINT fehlt',
        'CANVAZ_S3_REGION fehlt',
        'CANVAZ_S3_BUCKET fehlt',
        'CANVAZ_S3_ACCESS_KEY_ID fehlt',
        'CANVAZ_S3_SECRET_ACCESS_KEY fehlt',
      ])
    }
    // Und umgekehrt: wer S3 faehrt, stolpert nicht ueber ein fehlendes Wurzelverzeichnis.
    expect(() => loadConfig({ ...s3Env, CANVAZ_STORAGE_FILESYSTEM_ROOT: '' })).not.toThrow()
  })

  it('nimmt eine eigene Assetgrenze nur innerhalb der zulaessigen Spanne an', () => {
    expect(loadConfig({ ...validEnv, CANVAZ_MAX_ASSET_BYTES: '1048576' }).storage.maxAssetBytes).toBe(1_048_576)
    expect(() => loadConfig({ ...validEnv, CANVAZ_MAX_ASSET_BYTES: '512' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...validEnv, CANVAZ_MAX_ASSET_BYTES: '999999999' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...s3Env, CANVAZ_S3_FORCE_PATH_STYLE: 'vielleicht' })).toThrow(ConfigError)
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
    // OIDC ist nicht darunter: ohne jede seiner Variablen ist der Weg schlicht nicht zugeschaltet.
    expect(problems).not.toContain('CANVAZ_OIDC_CLIENT_SECRET fehlt')
  })

  it('startet ohne jede OIDC-Variable und schaltet den externen Weg damit ab', () => {
    const ohneOidc = {
      CANVAZ_BASE_URL: validEnv.CANVAZ_BASE_URL,
      DATABASE_URL: validEnv.DATABASE_URL,
      CANVAZ_SESSION_SECRET: validEnv.CANVAZ_SESSION_SECRET,
      CANVAZ_STORAGE_FILESYSTEM_ROOT: validEnv.CANVAZ_STORAGE_FILESYSTEM_ROOT,
    }

    expect(loadConfig(ohneOidc).oidc).toBeNull()
  })

  it('nimmt eine halbe OIDC-Konfiguration nicht als Verzicht hin', () => {
    let caught: unknown
    try {
      loadConfig({ ...validEnv, CANVAZ_OIDC_CLIENT_SECRET: '', CANVAZ_OIDC_CLIENT_ID: '' })
    } catch (error) {
      caught = error
    }

    expect((caught as ConfigError).problems).toEqual([
      'CANVAZ_OIDC_CLIENT_ID fehlt',
      'CANVAZ_OIDC_CLIENT_SECRET fehlt',
    ])
  })

  it('nimmt eine eigene Anmelde-Ratengrenze nur innerhalb der zulaessigen Spanne an', () => {
    expect(loadConfig(validEnv).authRateLimitPerMinute).toBe(10)
    expect(loadConfig({ ...validEnv, CANVAZ_AUTH_RATE_LIMIT_PER_MINUTE: '30' }).authRateLimitPerMinute).toBe(30)
    expect(() => loadConfig({ ...validEnv, CANVAZ_AUTH_RATE_LIMIT_PER_MINUTE: '1' })).toThrow(ConfigError)
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
