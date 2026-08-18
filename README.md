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
| `src/persistence` | Adapter zur Aussenwelt: Pool, SQL-Migrationen, Repository- und Storage-Umsetzungen. |
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

`npm run db:up` startet PostgreSQL und MinIO aus `compose.yml`. Die Hostports sind bewusst **55432** und
**59000** statt 5432 und 9000, damit sie nicht mit anderen lokalen Diensten kollidieren. Die Datenbank
`canvaz_test` wird beim ersten Start mit angelegt und gehoert den Integrationstests; MinIO ist der
Gegenpart des `s3`-Storage-Adapters und wird nur fuer dessen Pruefung gebraucht.

Der Server startet nicht mit unvollstaendiger Konfiguration; fehlende Umgebungsvariablen werden beim Start
gesammelt gemeldet. Siehe `.env.example`.

## Anmeldung

Die Anmeldung laeuft ausschliesslich ueber OpenID Connect (Authorization Code Flow mit PKCE, `state` und
`nonce`). Der ID-Token wird vollstaendig geprueft - Signatur gegen das JWKS des Issuers sowie `iss`, `aud`,
`exp`, `iat`/`nbf` und `nonce`. Dafuer ist `openid-client` im Einsatz; Signaturpruefung und JWKS-Handling
sind kein Eigenbau.

**Tokens des Identity Providers werden nie gespeichert.** Aus dem geprueften Token entsteht nur das lokale
Profil. Die Sitzung ist serverseitig und widerrufbar: im HttpOnly-Cookie `canvaz_session` steht ein
zufaelliges Geheimnis, in der Datenbank nur dessen SHA-256-Hash. Unter HTTPS heisst das Cookie
`__Host-canvaz_session` (ebenso `__Host-canvaz_oidc_flow`), damit keine Nachbardomain es ueberschreiben
kann. Zustandsaendernde Endpunkte verlangen zusaetzlich das an die Sitzung gebundene CSRF-Token im Header
`x-canvaz-csrf`; die SPA erhaelt es von `/api/me`.

Jede Antwort traegt `Content-Security-Policy` (`default-src 'self'`, `frame-ancestors 'none'`,
`object-src 'none'`, `base-uri 'self'`), `X-Content-Type-Options: nosniff` und `Referrer-Policy: no-referrer`.
HSTS setzt bewusst die TLS-Terminierung des Deployments, nicht die Anwendung.

Der transiente Flow-Zustand (`state`, `nonce`, `code_verifier`) liegt in einem verschluesselten,
kurzlebigen HttpOnly-Cookie (`canvaz_oidc_flow`, zehn Minuten). Der Callback verwirft es vor der
Codeeinloesung, damit es genau einmal gilt.

Der erste angemeldete Nutzer einer leeren Instanz wird Systemadmin. Die Entscheidung faellt serialisiert
(Advisory Lock in der Provisionierungstransaktion), sodass auch zwei gleichzeitige Erstanmeldungen genau
einen Systemadmin ergeben. Es gibt keine fest codierten Zugangsdaten.

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

Die Endpunkte der Arbeitsbereiche stehen im Abschnitt [Arbeitsbereiche und Rollen](#arbeitsbereiche-und-rollen),
die der Boards im Abschnitt [Boards und Szenen](#boards-und-szenen).

Logout und Deaktivierung widerrufen Sitzungen serverseitig und schliessen offene WebSocket-Verbindungen
sofort; ein Upgrade danach wird abgelehnt. Auch der Ablauf der Sitzung schliesst eine offene Verbindung.
Ein Upgrade mit fremdem `Origin` wird abgewiesen, weil der CSRF-Header beim Handshake nicht greift.

## Arbeitsbereiche und Rollen

Ein **Arbeitsbereich** ist die aeussere Datengrenze der Instanz: jeder fachliche Datensatz traegt seinen
Workspacebezug, und ein Nutzer sieht ausschliesslich Arbeitsbereiche, denen er angehoert.

Bestaetigte Rollen sind `owner`, `admin` und `member`. Boardrollen und Gastrollen sind eine eigene Ebene und
folgen in einem spaeteren Paket.

### Eine Stelle entscheidet

`src/domain/workspace/policy.ts` ist die einzige Stelle, die ueber eine Workspaceberechtigung entscheidet -
eine reine Funktion ohne IO, standardmaessig verweigernd. In den Routen steht kein Rollenvergleich, sondern
nur der Aufruf und die Uebersetzung der Ablehnung. Was die Oberflaeche ausblendet, ist Bequemlichkeit und
keine Grenze.

| Aktion | owner | admin | member | Nichtmitglied | Systemadmin ohne Mitgliedschaft | deaktiviert |
| --- | --- | --- | --- | --- | --- | --- |
| lesen (Stammdaten, Mitglieder) | ja | ja | ja | nein | ja | nein |
| umbenennen | ja | ja | nein | nein | ja | nein |
| archivieren, entarchivieren | ja | nein | nein | nein | ja | nein |
| Mitglied als `member`/`admin` aufnehmen | ja | ja | nein | nein | ja | nein |
| Mitglied als `owner` aufnehmen | ja | nein | nein | nein | ja | nein |
| Rolle aendern oder Mitglied entfernen, sofern kein `owner` beteiligt ist | ja | ja | nein | nein | ja | nein |
| Rolle aendern oder Mitglied entfernen, wenn ein `owner` beteiligt ist | ja | nein | nein | nein | ja | nein |

In einem **archivierten** Arbeitsbereich ist nur noch das Entarchivieren moeglich; alles andere bleibt
lesbar und wird abgelehnt. Ein **deaktivierter** Nutzer verliert jeden Zugriff, unabhaengig von jeder
Mitgliedschaft - die Sitzung selbst wird bereits von `authenticate()` verweigert, und die Policy lehnt
zusaetzlich ab.

Ein **Systemadmin ist nicht automatisch Mitglied**. Er verwaltet jeden Arbeitsbereich, damit keiner
unadministrierbar wird, aber seine eigene Liste bleibt leer, und der spaetere Inhaltszugriff auf Boards
haengt an der Mitgliedschaft, nicht an dieser Stufe.

### Invarianten

- Der Ersteller wird Owner; Arbeitsbereich und Ownermitgliedschaft entstehen in einer Transaktion.
- Ein Arbeitsbereich hat immer mindestens einen Owner. Der letzte Owner kann weder entfernt noch
  herabgestuft werden.
- Jede Aenderung sperrt zuerst die Workspacezeile (`select ... for update`). Dadurch sind gleichzeitige
  Mitgliedschaftsaenderungen serialisiert, und die Ownerzaehlung entscheidet nie auf einem veralteten Stand.
- Die Antwort entsteht in der Transaktion und wird erst nach dem Commit gesendet. Scheitert der Commit,
  bekommt der Client einen Fehler statt einer Erfolgsmeldung ueber eine zurueckgerollte Aenderung.

### Bekannte Grenzen

- `workspace_memberships.user_id` traegt `on delete cascade`: ein direktes Loeschen eines Nutzers in der
  Datenbank kann einen Arbeitsbereich ownerlos machen. Ueber die Anwendung gibt es kein Loeschen, nur
  Deaktivierung; die Ownerinvariante gilt in der Anwendungsschicht.
- `audit_events.workspace_id` traegt `on delete cascade`: ein direktes Loeschen eines Arbeitsbereichs in der
  Datenbank entfernt seine Nachweise. Ueber die Anwendung gibt es kein Loeschen, nur Archivierung.

### Endpunkte

Alle verlangen eine Sitzung; alle zustandsaendernden zusaetzlich das CSRF-Token im Header `x-canvaz-csrf`.

| Methode | Pfad | Berechtigung | Antwort ohne Berechtigung |
| --- | --- | --- | --- |
| GET | `/api/workspaces` | eigene Mitgliedschaften | 401 ohne Sitzung |
| POST | `/api/workspaces` | jeder aktive Nutzer | 401 ohne Sitzung |
| POST | `/api/workspaces/rename` | `workspace:rename` | 404 unsichtbar, sonst 403 |
| POST | `/api/workspaces/status` | `workspace:archive` / `workspace:unarchive` | 404 unsichtbar, sonst 403 |
| GET | `/api/workspaces/members?workspaceId=` | `workspace:read` | 404 |
| GET | `/api/workspaces/members/candidates?workspaceId=&q=` | `member:add` | 404 unsichtbar, sonst 403 |
| POST | `/api/workspaces/members/add` | `member:add` | 404 unsichtbar, sonst 403 |
| POST | `/api/workspaces/members/role` | `member:change-role` | 404 unsichtbar, sonst 403 |
| POST | `/api/workspaces/members/remove` | `member:remove` | 404 unsichtbar, sonst 403 |

**404 statt 403, wo die Existenz sonst durchscheinen wuerde.** Wer einen Arbeitsbereich nicht sehen darf,
bekommt dieselbe Antwort wie fuer eine frei erfundene Kennung; erst wer ihn sehen darf, bekommt mit 403 eine
ehrliche Auskunft ueber die fehlende Berechtigung. Der letzte Owner und eine bereits bestehende
Mitgliedschaft ergeben 409.

Mitglieder werden aus den vorhandenen internen Nutzern ausgewaehlt. Es gibt keine Einladung per E-Mail und
keine externen Konten.

**Das interne Nutzerverzeichnis ist keine Auskunft fuer jeden Angemeldeten.** Einen eigenen Arbeitsbereich
legt jeder aktive Nutzer voraussetzungslos an; eine Vollliste hinter `member:add` waere damit fuer jeden
erreichbar. Deshalb gibt es nur eine gezielte Suche: der Suchbegriff ist Pflicht (mindestens drei Zeichen)
und muss die Adresse oder den Anzeigenamen **vollstaendig** treffen (Gross- und Kleinschreibung egal,
Praefixe und Platzhalter nicht). Es werden hoechstens fuenf Treffer geliefert, bestehende Mitglieder und
deaktivierte Nutzer nie. Die Adresse steht nur dann im Treffer, wenn genau nach ihr gesucht wurde - wer
ueber den Anzeigenamen gefunden wird, gibt sie nicht preis.

### Nachweis

Jede Erstellung, Umbenennung, Archivierung sowie jede Rollen- und Mitgliedschaftsaenderung schreibt ein
Ereignis nach `audit_events` - Akteur, Aktion, Zieltyp und -kennung, Workspacebezug, Zeitpunkt und
strukturierte Metadaten. Aenderung und Nachweis entstehen in derselben Transaktion. Tokenmaterial und
Boardinhalte stehen dort nie. Eine Leseansicht gibt es bewusst noch nicht; die Ereignisse sind ueber
`WorkspaceStore.audit` und SQL abfragbar.


## Boards und Szenen

Ein **Board** ist eine Zeichenflaeche innerhalb genau eines Arbeitsbereichs und hat genau einen fachlichen
Owner. Jede Szenenversion und jeder Assetdatensatz traegt seinen Boardbezug; der Assetdatensatz zusaetzlich
den Workspacebezug.

### Wer darf was

`src/domain/board/policy.ts` entscheidet jede Boardaktion - eine reine Funktion ohne IO, standardmaessig
verweigernd. Sie baut auf der Workspace-Policy auf, statt sie umzubauen: `decideWorkspaceAccess(...,
{ kind: 'workspace:read' })` ist die Vorbedingung jeder Boardaktion. `src/domain/workspace/policy.ts` kennt
weiterhin keine Boards.

In diesem Paket entscheidet die **Workspace-Mitgliedschaft**: `owner`, `admin` und `member` duerfen im
aktiven Arbeitsbereich jedes Board lesen, anlegen, umbenennen, archivieren und seine Szene speichern. Die
feingranularen Boardrollen (`owner`, `editor`, `viewer`) und Gastlinks setzen spaeter genau hier an, nicht in
der Workspace-Policy.

Ein **Systemadmin ohne Mitgliedschaft** hat keinen Inhaltszugriff. Er verwaltet Arbeitsbereiche, damit keiner
unadministrierbar wird; ein Board sieht fuer ihn aus wie eine erfundene Kennung. Ein **deaktivierter** Nutzer
verliert jeden Zugriff bereits in `authenticate()`.

**Archiviert heisst lesbar, aber unveraenderlich** - auf beiden Ebenen. In einem archivierten Arbeitsbereich
laesst sich kein Board mehr anlegen, umbenennen, archivieren oder speichern. Bei einem archivierten Board
bleibt nur das Entarchivieren.

### Endpunkte

Alle verlangen eine Sitzung; alle zustandsaendernden zusaetzlich das CSRF-Token im Header `x-canvaz-csrf`.
Die Antwort entsteht in der Transaktion und wird erst nach dem Commit gesendet.

| Methode | Pfad | Berechtigung | Ohne Berechtigung | Konflikt |
| --- | --- | --- | --- | --- |
| GET | `/api/boards?workspaceId=&status=&q=` | Mitglied im Arbeitsbereich | 404 | — |
| POST | `/api/boards` | `board:create` | 404 unsichtbar, sonst 403 | — |
| POST | `/api/boards/rename` | `board:rename` | 404 unsichtbar, sonst 403 | — |
| POST | `/api/boards/status` | `board:archive` / `board:unarchive` | 404 unsichtbar, sonst 403 | — |
| GET | `/api/boards/scene?boardId=` | `board:read` | 404 | — |
| POST | `/api/boards/scene` | `scene:write` | 404 unsichtbar, sonst 403 | 409 |
| POST | `/api/boards/assets?boardId=&fileId=` | `scene:write` | 404 unsichtbar, sonst 403 | 409 |
| GET | `/api/boards/assets?boardId=&fileId=` | `board:read` | 404 | — |

`status` trennt die aktive Liste von der Archivansicht (Standard `active`), `q` filtert nach einem Teilstring
im Titel - ohne Platzhalterdeutung, damit `%` und `_` keine Wirkung haben.

**404 statt 403, wo die Existenz sonst durchscheinen wuerde**, genau wie bei den Arbeitsbereichen.

### Optimistische Versionspruefung

Jede Speicherung nennt in `baseVersion` die Version, auf der sie aufsetzt. Stimmt sie nicht mehr mit
`boards.current_scene_version` ueberein, antwortet der Server mit **409** und der aktuellen Version; es wird
**nichts** ueberschrieben. Die Pruefung laeuft in einer Transaktion, die die Boardzeile sperrt
(`select ... for no key update`), und der zusammengesetzte Primaerschluessel `(board_id, version)` ist die
zweite Absicherung. Zwei gleichzeitige Speicherungen auf derselben Ausgangsversion ergeben deshalb genau eine
neue Version und genau eine 409.

Die Oberflaeche speichert verzoegert nach der letzten Aenderung und auf Knopfdruck. Nach einem Konflikt hoert
sie auf, automatisch zu speichern: mit der neuen Ausgangsversion weiterzumachen waere genau das stille
Ueberschreiben, das die Pruefung verhindern soll. Die Zeichnung bleibt im Browser, und der Mensch entscheidet.
Mehrbenutzerbetrieb in Echtzeit kommt in einem eigenen Paket; zwei offene Browser sehen sich hier noch nicht,
koennen sich aber auch nicht gegenseitig ueberschreiben.

### Versionierung und Serialisierung

**Jede angenommene Speicherung legt eine neue Zeile in `scene_versions` an.** Das ist keine Zutat, sondern die
Pruefung selbst: der Primaerschluessel `(board_id, version)` macht zwei Schreibvorgaenge auf derselben
Ausgangsversion unmoeglich. Verdichtet wird bewusst nicht, damit die Daten fuer die spaetere Versionshistorie
sauber entstehen. Damit die Historie nicht unbegrenzt waechst, bleiben die juengsten **100** Versionen je
Board erhalten (`SCENE_VERSION_RETENTION`); aeltere fallen bei der naechsten Speicherung heraus.

Serialisiert wird der Vertrag aus `src/contracts/scene.ts`: Elemente, die persistierte Teilmenge des AppState
und die Referenzen auf Bilddateien. Unbekannte Elementfelder werden unveraendert durchgereicht, damit ein
Upstream-Sprung keine Daten verliert; Tombstones (`isDeleted`) bleiben erhalten, weil eine Loeschung selbst
Information ist. Kamera und Auswahl sind clientlokal und werden bewusst nicht gespeichert. Damit bleibt alles
erhalten, was ein `.excalidraw`-Export braucht.

Ein **beschaedigter Datensatz wird als Fehler gemeldet und nie als leeres Board geoeffnet** - sonst wuerde die
naechste Speicherung die Zeichnung endgueltig ueberschreiben. Ein Board ohne jede Speicherung hat Version `0`
und liefert den leeren Ausgangsstand; das ist sein tatsaechlicher Inhalt und kein Ersatz fuer einen Fehler.

Die Groesse eines Snapshots ist mit `CANVAZ_MAX_SCENE_BYTES` begrenzt (Standard 5 MiB). Die Grenze gilt schon
fuer den Anfragekoerper, sodass ein zu grosser Koerper nie vollstaendig im Speicher landet. PostgreSQL kann in
`jsonb` kein NUL-Zeichen speichern; eine Szene mit einem solchen Zeichen wird mit 400 abgelehnt, statt beim
Schreiben zu scheitern.

### Editor und Content-Security-Policy

Excalidraw ist exakt auf `0.18.1` gepinnt und erscheint ausschliesslich in
`src/web/board/excalidraw-adapter.ts` - Komponente wie Typen. Server, Protokoll und Persistenz kennen nur den
eigenen strukturellen Elementvertrag.

**Die Content-Security-Policy wurde dafuer nicht gelockert.** Damit das gilt, liegen die Schriften des Editors
im eigenen Build: `vite.config.ts` kopiert sie nach `dist/web/excalidraw-assets/fonts`, und
`src/web/board/excalidraw-assets.ts` setzt `window.EXCALIDRAW_ASSET_PATH` darauf. Excalidraw haengt an jede
Schriftquelle zusaetzlich einen fest verdrahteten CDN-Rueckfall an; er steht hinter der eigenen Quelle, wird
nie benutzt und wird von der Policy blockiert. Der Browsertest belegt beides: keine Anfrage erreicht eine
fremde Herkunft, und die Schriften kommen nachweislich aus dem eigenen Build.

Der Editor wird erst beim Oeffnen eines Boards nachgeladen. Das haelt den Einstieg klein (rund 215 kB, 67 kB
gzip) und stellt sicher, dass der eigene Assetpfad vor dem Schriftregister von Excalidraw steht.

### Bildassets

Ein **Asset** sind die Bytes eines Bildes, das in einem Board liegt. Die Metadaten stehen in `board_assets`
(Board- und Workspacebezug, Dateikennung, MIME-Typ, Groesse, Pruefsumme, Speicherschluessel), die Bytes
liegen hinter dem Storage-Port. **Die Datenbank ist die Wahrheit ueber ein Asset, der Storage-Port kennt nur
Schluessel und Bytes.**

#### Ein Port, zwei Adapter

`src/domain/storage/asset-storage-port.ts` ist der gesamte Vertrag:

```ts
put(key: string, bytes: Uint8Array): Promise<void>
get(key: string): Promise<Uint8Array | null>
delete(key: string): Promise<void>
```

| Adapter | Umsetzung | Zusagen |
| --- | --- | --- |
| `filesystem` | `src/persistence/asset-storage-filesystem.ts` | Schreibt ausschliesslich unter `CANVAZ_STORAGE_FILESYSTEM_ROOT`. Geschrieben wird in eine temporaere Datei im Zielverzeichnis und dann per `rename` gezogen - ein Abbruch hinterlaesst nie eine halbe Datei unter dem gueltigen Schluessel. |
| `s3` | `src/persistence/asset-storage-s3.ts` | Spricht S3 und MinIO ueber signierte HTTP-Anfragen (AWS Signature Version 4, `node:crypto` und `fetch`). Ein einzelnes `PUT` ist die atomare Einheit des Objektspeichers. |

**Kein S3-SDK.** Gebraucht werden drei Aufrufe auf genau einem Bucket. `@aws-sdk/client-s3` braechte
Paginierung, Multipart, Presigning, Retry-Strategien, eine Credential-Provider-Kette und einen
Middleware-Stack mit - nichts davon wird hier verwendet, und es waeren mehrere Dutzend zusaetzliche Pakete
in einer selbst gehosteten Anwendung. Der einzige nicht triviale Teil ist die Signatur; sie ist
vollstaendig spezifiziert und in wenigen Zeilen geschrieben. Belegt wird das gegen ein echtes MinIO, nicht
gegen eine Attrappe.

Der Speicherschluessel ist **inhaltsadressiert**: `boards/<boardId>/<sha256>`. Derselbe Inhalt im selben
Board ergibt denselben Schluessel, ein Wiederholungsversuch ueberschreibt sich selbst, und der erlaubte
Zeichenvorrat (`assertStorageKey`) macht einen Ausbruch aus dem Namensraum gar nicht erst formulierbar.

**Der Adapterwechsel ist ausschliesslich Laufzeitkonfiguration.** Die Wahl faellt an genau einer Stelle
(`src/persistence/asset-storage.ts`); Routen, Domain und Datenbank kennen nur `AssetStoragePort`. Fehlende
adapterspezifische Pflichtwerte fuehren zum Startfehler, gesammelt wie jeder andere Konfigurationsfehler.

| Variable | Gilt fuer | Bedeutung |
| --- | --- | --- |
| `CANVAZ_STORAGE_ADAPTER` | beide | `filesystem` (Standard) oder `s3` |
| `CANVAZ_MAX_ASSET_BYTES` | beide | Obergrenze je Datei, Standard 5 MiB (erlaubt 16 KiB bis 64 MiB) |
| `CANVAZ_STORAGE_FILESYSTEM_ROOT` | `filesystem` | Wurzelverzeichnis, **Pflicht ohne Standardwert** |
| `CANVAZ_S3_ENDPOINT` | `s3` | Basis-URL des Dienstes |
| `CANVAZ_S3_REGION` | `s3` | Region der Signatur |
| `CANVAZ_S3_BUCKET` | `s3` | Bucket, vom Betreiber angelegt |
| `CANVAZ_S3_ACCESS_KEY_ID`, `CANVAZ_S3_SECRET_ACCESS_KEY` | `s3` | Zugangsdaten |
| `CANVAZ_S3_FORCE_PATH_STYLE` | `s3` | `true` fuer MinIO, Standard `false` (AWS) |

Fuer das Wurzelverzeichnis gibt es bewusst **keinen** Standardwert: es muss ein persistentes Volume sein.
Ein Ersatzpfad im Containerlayer saehe aus wie Persistenz und waere beim naechsten Neustart weg.

#### Endpunkte

| Methode | Pfad | Berechtigung | Ohne Berechtigung | Falscher Typ | Zu gross |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/boards/assets?boardId=&fileId=&fileName=` | `scene:write` + CSRF-Token | 404 unsichtbar, sonst 403 | 415 | 413 |
| GET | `/api/boards/assets?boardId=&fileId=` | `board:read` | 404 | — | — |

Der Upload traegt die Bytes **roh** im Anfragekoerper; Board, Dateikennung und Dateiname stehen in der
Abfragezeichenfolge. Das spart die Base64-Aufblaehung und einen Parser fuer mehrteilige Koerper. Ein Bild
ist Inhalt des Boards, deshalb entscheidet dieselbe Aktion wie fuer die Szene: in einem archivierten Board
oder Arbeitsbereich bleiben Bilder lesbar, aber es kommt keines mehr dazu (403).

Weitere Antworten: 401 ohne Sitzung, 403 ohne CSRF-Token, 400 ohne Inhalt oder mit ungueltiger
Dateikennung, 400 bei abgebrochenem Transfer, **409**, wenn dieselbe Dateikennung im selben Board bereits
einen **anderen** Inhalt traegt. Derselbe Inhalt unter derselben Kennung ist dagegen idempotent und
antwortet mit 200 statt 201, ohne ein zweites Mal zu speichern.

#### Was der Client behauptet, zaehlt nicht

Geprueft wird der **Inhalt**: die Signaturbytes muessen ein erlaubtes Format ergeben **und** mit dem
behaupteten Content-Type uebereinstimmen. Eine `.png`-Endung mit Skriptinhalt scheitert daran ebenso wie
ein echtes PNG, das als JPEG angekuendigt wird.

Erlaubt sind `image/png`, `image/jpeg`, `image/gif` und `image/webp`. **SVG fehlt bewusst**: es ist ein
Dokument mit Skript- und Verweisfaehigkeit, kein Rasterbild; es aus einer Instanz auszuliefern, die auch
Sitzungen fuehrt, waere eine eigene Entscheidung mit eigener Absicherung.

#### Der Abruf ist nicht erratbar und ueberlebt keinen Entzug

Es gibt **keine oeffentliche und keine vorsignierte Bild-URL**. Jeder Abruf laeuft ueber dieselbe Sitzung
und dieselbe Entscheidung (`decideBoardAccess`) wie das Oeffnen des Boards; das Bucket-Objekt oder die
Datei im Volume ist von aussen nie erreichbar. Damit gibt es nichts, was ein Nutzer nach dem Entzug seiner
Berechtigung noch einloesen koennte - der naechste Abruf beantwortet dieselbe URL mit 404.

Eine geratene Dateikennung ist von einer fremden nicht zu unterscheiden: die Abfrage traegt immer den
Boardbezug (`findByFileId(boardId, fileId)`), es gibt keinen Weg zu einem Asset ohne ihn.

Die Antwort traegt den in der Datenbank gespeicherten Typ - nie den beim Upload behaupteten -, dazu
`X-Content-Type-Options: nosniff` und `Cache-Control: private, no-store`. Berechtigungsabhaengiger Inhalt
gehoert in keinen geteilten und in keinen privaten Zwischenspeicher.

**Die Content-Security-Policy wurde dafuer nicht angefasst.** Der Editor holt die Bytes ueber `fetch` von
der eigenen Herkunft (`default-src 'self'`) und bettet sie als `data:`-Verweis ein, was `img-src 'self'
data: blob:` seit Beginn erlaubt. Der Browsertest belegt es: ein Bild wird eingefuegt, hochgeladen,
gespeichert und nach dem Neuladen wieder dargestellt.

Mit dem Bild kommt allerdings ein zweiter, **gewollt blockierter** Verstoss dazu: Excalidraw kompiliert fuer
die Schriftreduktion ein Harfbuzz-WebAssembly und braeuchte dafuer `'wasm-unsafe-eval'` in `script-src`. Die
Policy erlaubt es **nicht**. Zeichnen, Bilder, Speichern und Laden funktionieren ohne - der Browsertest
zeigt beides in einem Lauf. Betroffen waere allein der Export mit reduzierten Schriften, und das ist kein
Gegenstand dieses Pakets; die Lockerung waere eine eigene Entscheidung mit eigener Begruendung.

#### Aufraeumen und Archivieren

**Es wird nichts geloescht.** Weder wenn ein Bildelement aus der Szene entfernt wird, noch beim Archivieren
eines Boards oder Arbeitsbereichs. Zwei Gruende:

1. Die Historie in `scene_versions` haelt bis zu 100 aeltere Staende, und die verweisen weiter auf das Bild.
   Ein Hard Delete wuerde ein Rueckgaengig oder einen Blick in die Historie ins Leere laufen lassen.
2. Archivieren ist ausdruecklich umkehrbar und macht unveraenderlich, nicht unvollstaendig. Ein Board muss
   aus dem Archiv verlustfrei zurueckkehren.

Ein Hard Delete braucht laut Aufgabenvertrag eine gesonderte Entscheidung - mitsamt Aufbewahrungsfrist,
Wirkung auf die Historie und Nachweis. Bis dahin leben Assets so lange wie ihr Board. `board_assets` traegt
`on delete cascade` auf `(board_id, workspace_id)`; das beschreibt, was beim direkten Loeschen in der
Datenbank geschieht, ueber die Anwendung gibt es diesen Weg nicht.

Der einzige Loeschvorgang im Anwendungscode ist die Aufraeumung eines gescheiterten Uploads: schlaegt die
Transaktion oder ihr Commit fehl, nachdem die Bytes geschrieben wurden, werden genau diese Bytes wieder
entfernt. Sonst blieben unerreichbare Bytes ohne Metadatensatz zurueck.

#### Editor

Ein eingefuegtes Bild geht **zuerst** ueber den Upload und **erst danach** in die Szene: Groesse und
Speicherschluessel kommen aus der Antwort des Servers, der Client denkt sie sich nicht aus. Solange ein
Upload laeuft, wird die Szene nicht gespeichert - ein Stand, der auf ein noch nicht hochgeladenes Bild
verweist, waere beim naechsten Oeffnen unvollstaendig. Beim Oeffnen holt die Boardansicht die Bytes jedes
in `SceneSnapshot.files` genannten Bildes einzeln ueber den autorisierten Endpunkt.

Excalidraw-Typen bleiben dabei in `src/web/board/excalidraw-adapter.ts`: der Port reicht Data-URLs als
schlichte Zeichenketten heraus und herein.

### Bekannte Grenzen

- `boards.owner_user_id` traegt `on delete restrict`: ein Board ohne Owner waere ein Datensatz ohne
  Verantwortlichen, deshalb verweigert die Datenbank das direkte Loeschen eines Nutzers, dem noch Boards
  gehoeren. Ueber die Anwendung gibt es kein Loeschen, nur Deaktivierung.
- `boards.workspace_id` und `scene_versions.board_id` tragen `on delete cascade`: ein direktes Loeschen in
  der Datenbank nimmt Boards und ihre Szenen mit. Ueber die Anwendung gibt es nur Archivierung.
- Ein Board wird beim Archivieren des Arbeitsbereichs nicht selbst archiviert; es wird durch den Zustand des
  Arbeitsbereichs unveraenderlich. Das haelt die Rueckkehr aus dem Archiv verlustfrei.
- Der Storage-Port kennt keine Bereinigung verwaister Bytes. Bytes ohne Metadatensatz koennen nur entstehen,
  wenn die Aufraeumung eines gescheiterten Uploads selbst scheitert; das wird als `board.asset.orphan`
  protokolliert. Ein Aufraeumlauf braucht dieselbe gesonderte Entscheidung wie das Hard Delete.
- `SceneSnapshot.files[].storageKey` kommt zwar vom Server, wird beim Abruf aber nicht verwendet: massgeblich
  ist ausschliesslich `board_assets.storage_key`. Ein Client kann ueber die Szene keinen fremden Schluessel
  erreichbar machen.

### Nachweis

Anlage, Umbenennung, Archivierung und Entarchivierung eines Boards schreiben ein Ereignis nach
`audit_events` (`targetType: 'board'`). Einzelne Speicherungen tun das nicht: sie sind Inhalt, nicht
Verwaltung, und `audit_events` enthaelt nie Boardinhalte. Die Historie der Inhalte steht in `scene_versions`.

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
   `preferred_username` (optional, fuer Anzeigename und Adresse). Die Adresse wird nur mit
   `email_verified: true` uebernommen; fehlt der Claim oder steht er auf `false`, bleibt das Profil ohne
   Adresse.
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

Die Integrationstests brauchen eine laufende Datenbank **und ein laufendes MinIO** (`npm run db:up`). Die
Verbindungen lassen sich ueber `CANVAZ_TEST_DATABASE_URL` und `CANVAZ_TEST_S3_ENDPOINT` uebersteuern.

`tests/integration/asset-storage.test.ts` enthaelt die **gemeinsame Contract-Testsuite des Storage-Ports**:
genau eine Suite (`assetStorageContract`), zweimal ausgefuehrt - einmal gegen `filesystem`, einmal gegen
`s3` vor einem echten MinIO. Innerhalb der Suite gibt es keine Fallunterscheidung und keinen Adapternamen;
sie kennt ausschliesslich `AssetStoragePort`. Der Neustart-Nachweis in
`tests/integration/board-assets.test.ts` laeuft ebenfalls fuer beide Adapter: hochladen, den
Anwendungsprozess vollstaendig ersetzen, abrufen, Bytes vergleichen.

Integrations- und Browsertests sprechen einen echten OIDC-Provider an: `tests/support/oidc-provider.ts`
signiert ID-Tokens mit RSA und liefert ein echtes JWKS aus. Fehlerlagen (falscher Issuer, falsche Audience,
abgelaufener Token, falsche Nonce, nicht erreichbarer Provider) entstehen dadurch, dass sich dieser Provider
falsch verhaelt. Der Anwendungscode hat keinen Testmodus und keinen Sonderpfad.

## Migrationen

Versionierte SQL-Dateien in `src/persistence/migrations`, angewendete Versionen stehen in
`schema_migrations`. Jede Datei laeuft in einer eigenen Transaktion, ein Advisory Lock verhindert
Parallelanwendung. Anwenden mit `npm run db:migrate`; der Anwendungsserver migriert nicht von selbst.
