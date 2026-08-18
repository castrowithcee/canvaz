# Canvaz

Selbst gehostete Kollaborationsplattform. Ein TypeScript/Node-Anwendungsserver liefert die React/Vite-SPA
und die HTTP-API aus; PostgreSQL ist die massgebliche Datenhaltung.

Planung, Architekturentscheidungen und Betriebswissen liegen im getrennten Repository `canvaz-ops`.

## Struktur

| Pfad | Rolle |
| --- | --- |
| `src/domain` | Reiner Fachkern: Modelle, Invarianten, Repository- und Storage-Ports. Kein IO. |
| `src/contracts` | Zwischen Server und SPA geteilte Typen (HTTP-Vertraege, Szenenvertrag). |
| `src/server` | Konfiguration, HTTP, Routentabelle, OIDC-Anmeldung, Guards, WebSocket-Einstieg, Composition Root. |
| `src/persistence` | PostgreSQL-Adapter: Pool, SQL-Migrationen, Repository-Umsetzungen. |
| `src/web` | React/Vite-SPA inklusive Editor-Port und Excalidraw-Adapter. |
| `tests` | `unit` (ohne IO), `integration` (echte Datenbank), `e2e` (Playwright), `support` (Testhilfen). |

Excalidraw (exakt `0.18.1`) erscheint ausschliesslich in `src/web/board/excalidraw-adapter.ts`. Die
Reconciliation in `src/domain/board/reconcile.ts` ist Eigencode.

## Lokal starten

```sh
npm install
cp .env.example .env      # Platzhalter ersetzen; .env ist gitignoriert
npm run db:up             # PostgreSQL im Container, Hostport 55432
npm run db:migrate
npm run start:server      # API und gebaute SPA auf Port 3000
npm run dev               # alternativ: Vite auf Port 5173 mit Proxy auf /api
```

`npm run db:up` startet die Datenbank aus `compose.yml`. Der Hostport ist bewusst **55432** statt 5432,
damit er nicht mit anderen lokalen Diensten kollidiert. Die Datenbank `canvaz_test` wird beim ersten Start
mit angelegt und gehoert den Integrationstests.

Der Server startet nicht mit unvollstaendiger Konfiguration; fehlende Umgebungsvariablen werden beim Start
gesammelt gemeldet. Siehe `.env.example`.

## Anmeldung

Die Anmeldung laeuft ausschliesslich ueber OpenID Connect (Authorization Code Flow mit PKCE, `state` und
`nonce`). Der ID-Token wird vollstaendig geprueft - Signatur gegen das JWKS des Issuers sowie `iss`, `aud`,
`exp`, `iat`/`nbf` und `nonce`. Dafuer ist `openid-client` im Einsatz; Signaturpruefung und JWKS-Handling
sind kein Eigenbau.

**Tokens des Identity Providers werden nie gespeichert.** Aus dem geprueften Token entsteht nur das lokale
Profil. Die Sitzung ist serverseitig und widerrufbar: im HttpOnly-Cookie `canvaz_session` steht ein
zufaelliges Geheimnis, in der Datenbank nur dessen SHA-256-Hash. Zustandsaendernde Endpunkte verlangen
zusaetzlich das an die Sitzung gebundene CSRF-Token im Header `x-canvaz-csrf`; die SPA erhaelt es von
`/api/me`.

Der transiente Flow-Zustand (`state`, `nonce`, `code_verifier`) liegt in einem verschluesselten,
kurzlebigen HttpOnly-Cookie (`canvaz_oidc_flow`, zehn Minuten). Der Callback verwirft es vor der
Codeeinloesung, damit es genau einmal gilt.

Der erste angemeldete Nutzer einer leeren Instanz wird Systemadmin. Es gibt keine fest codierten
Zugangsdaten.

| Methode | Pfad | Zugang |
| --- | --- | --- |
| GET | `/api/health` | oeffentlich |
| GET | `/api/auth/login` | oeffentlich, leitet zum Identity Provider |
| GET | `/api/auth/callback` | oeffentlich, Pfad stammt aus `CANVAZ_OIDC_REDIRECT_URI` |
| POST | `/api/auth/logout` | angemeldet + CSRF-Token |
| GET | `/api/me` | angemeldet |
| GET | `/api/admin/users` | angemeldet + Systemadmin |
| POST | `/api/admin/users/status` | angemeldet + Systemadmin + CSRF-Token |
| GET (Upgrade) | `/api/realtime` | angemeldet; WebSocket-Einstieg fuer die spaetere Realtime-Strecke |

Logout und Deaktivierung widerrufen Sitzungen serverseitig und schliessen offene WebSocket-Verbindungen
sofort; ein Upgrade danach wird abgelehnt.

## Identity Provider einrichten (Beispiel Authentik)

Die Konfiguration bleibt generisch: gesetzt wird nur der Issuer, den Rest holt die Anwendung ueber
Discovery (`<issuer>/.well-known/openid-configuration`). Fuer Authentik:

1. **Provider anlegen**: Typ *OAuth2/OpenID Provider*.
   - Client type: **Confidential**
   - Authorization flow: der gewuenschte Anmeldeflow (z. B. `default-provider-authorization-explicit-consent`)
   - Redirect URI (Strict): `https://<canvaz-host>/api/auth/callback` - identisch mit
     `CANVAZ_OIDC_REDIRECT_URI` und unter derselben Herkunft wie `CANVAZ_BASE_URL`
   - Signing key: ein RSA-Schluessel (`RS256`)
   - Scopes: `openid`, `profile`, `email`
2. **Application anlegen** und dem Provider zuordnen. Ueber die Gruppenbindung der Application steuert
   Authentik, wer sich anmelden darf.
3. **Claims**: Canvaz benoetigt `sub` und `iss` (zwingend) sowie `email`, `email_verified`, `name` und
   `preferred_username` (optional, fuer Anzeigename und Adresse). Eine nicht bestaetigte Adresse
   (`email_verified: false`) wird bewusst nicht uebernommen.
4. **Werte uebernehmen**:

   | Umgebungsvariable | Wert aus Authentik |
   | --- | --- |
   | `CANVAZ_OIDC_ISSUER` | *OpenID Configuration Issuer*, z. B. `https://authentik.example.com/application/o/canvaz/` |
   | `CANVAZ_OIDC_CLIENT_ID` | *Client ID* des Providers |
   | `CANVAZ_OIDC_CLIENT_SECRET` | *Client Secret* des Providers |
   | `CANVAZ_OIDC_REDIRECT_URI` | dieselbe Redirect-URI wie oben |

   Alle vier Werte sind Laufzeitkonfiguration und stehen nie im Repository.

Ein RP-initiiertes Logout wird genutzt, sobald der Issuer ein `end_session_endpoint` veroeffentlicht -
Authentik tut das.

Ein Nachweis gegen eine laufende Authentik-Instanz steht noch aus; dafuer fehlen Instanz und Zugangsdaten.
Die automatisierten Tests laufen gegen einen standardkonformen Test-Provider mit echtem JWKS.

## Pruefungen

```sh
npm run lint
npm run typecheck
npm run build
npm test              # Unit- und Integrationstests
npm run test:unit     # nur ohne Datenbank
npm run test:e2e      # Playwright, benoetigt einmalig `npx playwright install chromium`
npm audit --audit-level=high
```

Die Integrationstests brauchen eine laufende Datenbank (`npm run db:up`). Ihre Verbindung laesst sich ueber
`CANVAZ_TEST_DATABASE_URL` uebersteuern.

Integrations- und Browsertests sprechen einen echten OIDC-Provider an: `tests/support/oidc-provider.ts`
signiert ID-Tokens mit RSA und liefert ein echtes JWKS aus. Fehlerlagen (falscher Issuer, falsche Audience,
abgelaufener Token, falsche Nonce, nicht erreichbarer Provider) entstehen dadurch, dass sich dieser Provider
falsch verhaelt. Der Anwendungscode hat keinen Testmodus und keinen Sonderpfad.

## Migrationen

Versionierte SQL-Dateien in `src/persistence/migrations`, angewendete Versionen stehen in
`schema_migrations`. Jede Datei laeuft in einer eigenen Transaktion, ein Advisory Lock verhindert
Parallelanwendung. Anwenden mit `npm run db:migrate`; der Anwendungsserver migriert nicht von selbst.
