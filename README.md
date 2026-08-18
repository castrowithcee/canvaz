# Canvaz

Selbst gehostete Kollaborationsplattform. Ein TypeScript/Node-Anwendungsserver liefert die React/Vite-SPA
und die HTTP-API aus; PostgreSQL ist die massgebliche Datenhaltung.

Planung, Architekturentscheidungen und Betriebswissen liegen im getrennten Repository `canvaz-ops`.

## Struktur

| Pfad | Rolle |
| --- | --- |
| `src/domain` | Reiner Fachkern: Modelle, Invarianten, Repository- und Storage-Ports. Kein IO. |
| `src/contracts` | Zwischen Server und SPA geteilte Typen (HTTP-Vertraege, Szenenvertrag). |
| `src/server` | Konfiguration, HTTP, Routentabelle, Composition Root. |
| `src/persistence` | PostgreSQL-Adapter: Pool, SQL-Migrationen, Repository-Umsetzungen. |
| `src/web` | React/Vite-SPA inklusive Editor-Port und Excalidraw-Adapter. |
| `tests` | `unit` (ohne IO), `integration` (echte Datenbank), `e2e` (Playwright). |

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

## Migrationen

Versionierte SQL-Dateien in `src/persistence/migrations`, angewendete Versionen stehen in
`schema_migrations`. Jede Datei laeuft in einer eigenen Transaktion, ein Advisory Lock verhindert
Parallelanwendung. Anwenden mit `npm run db:migrate`; der Anwendungsserver migriert nicht von selbst.
