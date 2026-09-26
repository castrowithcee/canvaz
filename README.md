# Canvaz

Selbst gehostete Kollaborationsplattform. Ein TypeScript/Node-Anwendungsserver liefert die React/Vite-SPA
und die HTTP-API aus; PostgreSQL ist die massgebliche Datenhaltung.

Planung, Architekturentscheidungen und Betriebswissen liegen im getrennten Repository `canvaz-ops`.

## Struktur

| Pfad | Rolle |
| --- | --- |
| `src/domain` | Reiner Fachkern: Modelle, Invarianten, Repository- und Storage-Ports. Kein IO. |
| `src/contracts` | Zwischen Server und SPA geteilte Typen (HTTP-Vertraege, Szenenvertrag). |
| `src/server` | Konfiguration, HTTP, Routentabelle, lokale und externe Anmeldung, Guards, WebSocket-Einstieg, Boardraeume, Composition Root. |
| `src/persistence` | Adapter zur Aussenwelt: Pool, SQL-Migrationen, Repository- und Storage-Umsetzungen. |
| `src/web` | React/Vite-SPA inklusive Editor-Port und Excalidraw-Adapter. |
| `tests` | `unit` (ohne IO), `integration` (echte Datenbank), `support` (Testhilfen). |
| `Dockerfile`, `compose.prod.yml`, `docker/` | Laufzeitimage, Produktionsbereitstellung, Reverse Proxy und Betriebswerkzeug. |

Excalidraw (exakt `0.18.1`) erscheint ausschliesslich in `src/web/board/excalidraw-adapter.ts`. Die
Reconciliation in `src/domain/board/reconcile.ts` ist Eigencode.

## Lokal starten

`compose.yml` ist der lokale Stack: Anwendung, PostgreSQL und SeaweedFS. Die Anwendung gibt selbst **keinen
Hostport** ab - sie haengt an einem Reverse Proxy, der aus seinem eigenen Stack dem Netz `canvaz` beitritt
und unter dem Namen der Instanz antwortet.

```sh
npm install
cp .env.example .env             # Platzhalter ersetzen; .env ist gitignoriert
docker network create canvaz     # einmalig; der Proxy haengt darin und darf es nicht verlieren
docker compose up -d --build     # Anwendung, PostgreSQL und SeaweedFS
npm run db:migrate
npm run admin:bootstrap -- --name "Vorname Nachname" --email adresse@example.com   # einmalig
```

Danach antwortet die Instanz unter dem Namen aus `CANVAZ_BASE_URL`. Sitzungscookie und OIDC-Rueckkehr
haengen an genau dieser Herkunft: ein zweiter Weg auf dieselbe Instanz waere ohnehin nur ein halber.

Ohne Proxy - oder waehrend der Arbeit an der Oberflaeche - laufen dieselben Teile auf dem Host:

```sh
npm run db:up                    # nur PostgreSQL und SeaweedFS aus compose.yml
npm run start:server             # API und gebaute SPA auf Port 3000
npm run dev                      # alternativ: Vite auf Port 5173 mit Proxy auf /api
```

Die Hostports von Datenbank und Objektspeicher sind bewusst **55432** und **59000** statt 5432 und 9000,
damit sie nicht mit anderen lokalen Diensten kollidieren; sie bleiben am Loopback, weil Testlauf, Migration
und `admin:bootstrap` auf dem Host laufen und kein HTTP sprechen. Die Datenbank `canvaz_test` wird beim
ersten Start mit angelegt und gehoert den Integrationstests; SeaweedFS ist der Gegenpart des
`s3`-Storage-Adapters und wird nur fuer dessen Pruefung gebraucht.

Der Server startet nicht mit unvollstaendiger Konfiguration; fehlende Umgebungsvariablen werden beim Start
gesammelt gemeldet. Siehe `.env.example`.

## Anmeldung

Es gibt **zwei Wege auf dasselbe Profil**: die lokale Anmeldung, die diese Instanz selbst verwaltet, und
optional einen externen Identity Provider. Ohne konfigurierten Provider startet und arbeitet die Instanz
vollstaendig; mit Provider steht der externe Weg zusaetzlich zur Verfuegung. Die Anmeldeseite zeigt genau
die Wege, die es hier gibt (`/api/auth/methods`).

Der Anmeldeweg entscheidet ausschliesslich die **Identitaet**, nie eine Berechtigung. Rolle, Status und
Mitgliedschaften haengen unveraendert am Profil, und `authenticate()` bleibt die einzige Definition von
"angemeldet".

### Lokale Benutzerverwaltung

Konten legt **ausschliesslich ein Systemadmin** an; eine Selbstregistrierung gibt es nicht, und die Instanz
versendet keine Mail. Bei der Anlage waehlt er einen der beiden Wege der Uebergabe - beide werden ausserhalb
der Anwendung uebermittelt:

- **Initialpasswort**: der Systemadmin vergibt es. Es steht in keiner Antwort und in keinem Protokoll. Die
  erste Anmeldung damit legt **keine Sitzung** an, sondern verlangt den Wechsel; erst der Wechsel meldet an.
- **Einladungslink**: befristet (72 Stunden), genau einmal einloesbar, jederzeit widerrufbar. Der Wert ist
  kryptografisch zufaellig, wird nur als SHA-256-Hash gespeichert und erscheint genau einmal - in der
  Antwort der Anlage. Die Adresse traegt ihn im Fragment (`/einladung#<token>`), das der Browser nicht
  mitsendet. Ein verlorener Link wird widerrufen und neu erzeugt.

Dieselben beiden Wege dienen der **Ruecksetzung** durch den Systemadmin. Eine Ruecksetzung und ein Wechsel
widerrufen jede bestehende Sitzung des Kontos und schliessen dessen offene Verbindungen.

Passwoerter liegen ausschliesslich als **scrypt**-Hash (`N=2^15`, `r=8`, `p=1`, 16 Byte Salz, `node:crypto`)
in `local_credentials`; das Format traegt seine Parameter selbst, damit ein gespeicherter Hash pruefbar
bleibt, wenn sie spaeter steigen. Ein Passwort braucht mindestens zwoelf Zeichen und hat sonst keine
Zusammensetzungsregeln.

Anmeldung, Passwortwechsel und Einloesen liegen hinter einer **eigenen, engen Ratengrenze**
(`CANVAZ_AUTH_RATE_LIMIT_PER_MINUTE`, Standard 10 Versuche je Minute und Client) und pruefen die Herkunft
wie der WebSocket-Upgrade; ein CSRF-Token tragen sie nicht, weil es noch keine Sitzung gibt. Eine unbekannte
Adresse und ein falsches Passwort ergeben dieselbe Antwort und kosten dieselbe Rechenzeit.

### Erster Systemadmin

Er entsteht **einmalig auf dem Host** und nicht durch eine Anmeldung:

```sh
npm run admin:bootstrap -- --name "Vorname Nachname" --email adresse@example.com
# im Container: node dist/server/bootstrap-cli.js --name "..." --email "..."
```

Der Aufruf legt genau einen Systemadmin an und gibt seinen Einladungslink auf der Standardausgabe aus. Die
Pruefung "gibt es schon einen Systemadmin?" laeuft unter einer Advisory-Sperre bis zum Commit; zwei
gleichzeitige Aufrufe ergeben nie zwei Administratoren. Sobald einer existiert, verweigert der Vorgang seine
Arbeit - weitere Konten entstehen in der Systemadministration. **Es gibt keine fest codierten Zugangsdaten**
im Image und in keiner Konfigurationsvorlage; das Passwort setzt der Empfaenger selbst beim Einloesen.

Die fruehere Regel "der erste angemeldete Nutzer wird Systemadmin" ist damit abgeloest: eine Anmeldung
vergibt keine Rechte mehr.

**Bekannte Grenze:** eine Instanz hat genau **einen** Systemadmin - den aus diesem Vorgang. Es gibt keine
nachtraegliche Rollenvergabe; in der Systemadministration angelegte Konten sind gewoehnliche Nutzer. Geht
der Zugang zum Bootstrap-Konto verloren, laesst er sich nur ueber einen direkten Datenbankzugriff wieder
herstellen (Einladung fuer dieses Konto oder `is_system_admin` auf einem anderen setzen).

### Postausgang (optional)

Ohne konfigurierten Postausgang verschickt die Instanz **nichts**: ein Einladungslink steht genau einmal in
der Antwort der Anlage, und wer ihn zustellt, entscheidet der Betrieb. Mit Postausgang kommen genau zwei
Nachrichten dazu, beide an die Adresse des betroffenen Kontos:

| Anlass | Inhalt |
| --- | --- |
| Konto angelegt oder Einladung erneuert | der Einladungslink, gueltig 72 Stunden und einmal einloesbar |
| Passwort administrativ zurueckgesetzt | die Mitteilung, dass es zurueckgesetzt wurde - **ohne** das neue Passwort |

Ein Passwort steht in keiner Nachricht. Ein Postfach ist kein Ort fuer ein Geheimnis, das ohne zweiten
Faktor Zugang gibt; das neue Initialpasswort geht den Weg, den die Administration mit dem Konto vereinbart
hat.

Konfiguriert wird der Weg wie OIDC: **ganz oder gar nicht**. Ohne jede der Variablen gibt es ihn nicht;
sobald eine gesetzt ist, gelten Server (`CANVAZ_SMTP_HOST`) und Absender (`CANVAZ_MAIL_FROM`) als gewollt
und ein fehlender Wert ist ein Startfehler. `CANVAZ_SMTP_PORT` ist ohne Angabe 587, implizites TLS
(`CANVAZ_SMTP_SECURE`) folgt dem Port - 465 ja, sonst ist STARTTLS **Pflicht**: bietet der Server es nicht
an oder scheitert es, bricht der Versand ab, bevor Anmeldung, Empfaenger oder Inhalt den Server erreichen.
`CANVAZ_SMTP_USER` und `CANVAZ_SMTP_PASSWORD` gehoeren zusammen oder entfallen beide; ein Postausgang im
eigenen Netz verlangt haeufig keine Anmeldung. Die Anwendung kennt ausschliesslich diese Variablen: welcher
Server dahintersteht, ist Sache der Umgebung und steht in keiner Datei dieses Repositorys.

`CANVAZ_SMTP_ALLOW_INSECURE=true` hebt die STARTTLS-Pflicht auf; ohne Angabe gilt `false`. Die Ausnahme ist
nur fuer einen isolierten lokalen Relay im selben vertrauenswuerdigen Netz gedacht, etwa einen
Auffangserver der Entwicklung. Ein externer Relay laeuft nie mit ihr: Einladungslinks und Zugangsdaten
gingen sonst im Klartext ueber das Netz.

**Der Versand ist eine Zustellung und keine Bedingung.** Das Konto ist angelegt, bevor die erste Verbindung
zum Postausgang steht. Ein nicht erreichbarer Server macht daraus keinen Fehlschlag: der Vorgang antwortet
wie ohne Postausgang, der Link steht in der Antwort, und der Fehlversuch erscheint als `mail.failed` im
Protokoll - mit Empfaenger und Anlass, nie mit Inhalt, weil der bei einer Einladung den Wert traegt.

### Externe Anmeldung (optional)

Ist ein Provider konfiguriert, laeuft der externe Weg als Authorization Code Flow mit PKCE, `state` und
`nonce`. Der ID-Token wird vollstaendig geprueft - Signatur gegen das JWKS des Issuers sowie `iss`, `aud`,
`exp`, `iat`/`nbf` und `nonce`. Dafuer ist `openid-client` im Einsatz; Signaturpruefung und JWKS-Handling
sind kein Eigenbau. Ohne die vier `CANVAZ_OIDC_*`-Variablen entstehen die beiden Routen gar nicht erst; eine
**halb** gesetzte Konfiguration ist dagegen ein Startfehler und kein stiller Verzicht.

Eine unbekannte externe Identitaet mit einer **bestaetigten** Adresse, zu der es bereits ein Profil gibt,
wird mit diesem Profil verknuepft, statt ein zweites anzulegen. So fuehren beide Wege auf dasselbe Konto -
mit denselben Rechten. Ein neu provisioniertes Profil bekommt nie Systemadminrechte.

**Tokens des Identity Providers werden nie gespeichert.** Aus dem geprueften Token entsteht nur das lokale
Profil. Die Sitzung ist serverseitig und widerrufbar: im HttpOnly-Cookie `canvaz_session` steht ein
zufaelliges Geheimnis, in der Datenbank nur dessen SHA-256-Hash. Unter HTTPS heisst das Cookie
`__Host-canvaz_session` (ebenso `__Host-canvaz_oidc_flow`), damit keine Nachbardomain es ueberschreiben
kann. Zustandsaendernde Endpunkte verlangen zusaetzlich das an die Sitzung gebundene CSRF-Token im Header
`x-canvaz-csrf`; die SPA erhaelt es von `/api/me`.

Externe ohne Konto erreichen genau ein Board ueber einen **Gastlink** (siehe
[Oeffentliche Gastfreigaben](#oeffentliche-gastfreigaben)). Sie bekommen dabei eine eigene, kurzlebige
Gastsession mit eigenem Cookie (`canvaz_guest`, unter HTTPS `__Host-canvaz_guest`), eigenem Hash in der
Datenbank und einem eigenen, an die Gastsession gebundenen CSRF-Token im selben Header. Eine angemeldete
Sitzung hat Vorrang: wer intern angemeldet ist, handelt als er selbst, auch wenn im selben Browser noch ein
Gastcookie liegt.

Jede Antwort traegt `Content-Security-Policy` (`default-src 'self'`, `frame-ancestors 'none'`,
`object-src 'none'`, `base-uri 'self'`), `X-Content-Type-Options: nosniff` und `Referrer-Policy: no-referrer`.
HSTS setzt bewusst die TLS-Terminierung des Deployments, nicht die Anwendung; in der mitgelieferten
Produktionsbereitstellung setzt es der Reverse Proxy (`docker/Caddyfile`).

Jeder Pfad unter `/api/` liegt zusaetzlich hinter einer **Ratengrenze je Client**
(`CANVAZ_RATE_LIMIT_PER_MINUTE`, Standard 600 Anfragen je Minute, Eimer mit gleichmaessiger Nachfuellung).
Darueber antwortet die Instanz mit `429` und `Retry-After`. Hinter einem Reverse Proxy zaehlt sie den
letzten Eintrag aus `x-forwarded-for` - den, den der Proxy selbst angehaengt hat - und nur dann, wenn
`CANVAZ_TRUSTED_PROXY=true` gesetzt ist; ohne Proxy waere die Kopfzeile frei erfunden.

Der transiente Flow-Zustand (`state`, `nonce`, `code_verifier`) liegt in einem verschluesselten,
kurzlebigen HttpOnly-Cookie (`canvaz_oidc_flow`, zehn Minuten). Der Callback verwirft es vor der
Codeeinloesung, damit es genau einmal gilt.

| Methode | Pfad | Zugang |
| --- | --- | --- |
| GET | `/api/health` | oeffentlich; Lebendigkeit samt Datenbankkontakt |
| GET | `/api/ready` | oeffentlich; Bereitschaft, siehe [Betrieb auf einem VPS](#betrieb-auf-einem-vps) |
| GET | `/api/metrics` | nur im internen Netz; der Reverse Proxy beantwortet ihn nach aussen mit 404 |
| GET | `/api/auth/methods` | oeffentlich; welche Anmeldewege es hier gibt |
| POST | `/api/auth/local/login` | oeffentlich, eigene Ratengrenze und Herkunftspruefung |
| POST | `/api/auth/local/password` | oeffentlich, verlangt das bisherige Passwort |
| POST | `/api/auth/invitation/redeem` | oeffentlich, verlangt einen gueltigen Einladungswert |
| GET | `/api/auth/login` | oeffentlich, leitet zum Identity Provider; **nur mit OIDC-Konfiguration** |
| GET | `/api/auth/callback` | oeffentlich, Pfad stammt aus `CANVAZ_OIDC_REDIRECT_URI`; **nur mit OIDC-Konfiguration** |
| POST | `/api/auth/logout` | angemeldet + CSRF-Token |
| GET | `/api/me` | angemeldet |
| GET | `/api/admin/users` | angemeldet + Systemadmin |
| POST | `/api/admin/users/create` | angemeldet + Systemadmin + CSRF-Token |
| POST | `/api/admin/users/password` | angemeldet + Systemadmin + CSRF-Token |
| POST | `/api/admin/users/invitation` | angemeldet + Systemadmin + CSRF-Token |
| POST | `/api/admin/users/invitation/revoke` | angemeldet + Systemadmin + CSRF-Token |
| POST | `/api/admin/users/status` | angemeldet + Systemadmin + CSRF-Token |
| GET (Upgrade) | `/api/realtime` | angemeldet **oder** gueltige Gastsession; WebSocket-Einstieg der Realtime-Strecke |
| POST | `/api/boards/guest/join` | oeffentlich, verlangt ein gueltiges Freigabetoken und die eigene Herkunft |
| GET | `/api/boards/guest/session` | gueltige Gastsession |

Die Endpunkte der Arbeitsbereiche stehen im Abschnitt [Arbeitsbereiche und Rollen](#arbeitsbereiche-und-rollen),
die der Boards im Abschnitt [Boards und Szenen](#boards-und-szenen).

Logout und Deaktivierung widerrufen Sitzungen serverseitig und schliessen offene WebSocket-Verbindungen
sofort; ein Upgrade danach wird abgelehnt. Eine Deaktivierung wirkt dabei auf **beide** Anmeldewege und
entwertet zusaetzlich eine noch offene Einladung. Auch der Ablauf der Sitzung schliesst eine offene Verbindung.
Fuer einen Gast gilt dasselbe, und zusaetzlich beendet der Widerruf seines Freigabelinks jede offene
Verbindung, die daraus entstanden ist.
Ein Upgrade mit fremdem `Origin` wird abgewiesen, weil der CSRF-Header beim Handshake nicht greift.

## Arbeitsbereiche und Rollen

Ein **Arbeitsbereich** ist die aeussere Datengrenze der Instanz: jeder fachliche Datensatz traegt seinen
Workspacebezug, und ein Nutzer sieht ausschliesslich Arbeitsbereiche, denen er angehoert.

Bestaetigte Rollen sind `owner`, `admin` und `member`. **Boardrollen sind eine eigene Ebene darunter** und
wirken zusaetzlich zur Mitgliedschaft (siehe *Boards und Szenen*). **Gastrollen stehen daneben und nicht
darunter**: ein Gast aus einem Freigabelink ist in keinem Arbeitsbereich Mitglied und erreicht ausschliesslich
das eine Board seines Links.

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
unadministrierbar wird, aber seine eigene Liste bleibt leer, und der Inhaltszugriff auf Boards haengt an der
Mitgliedschaft, nicht an dieser Stufe.

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

Zwei unabhaengige Eingaben entscheiden ueber einen internen Nutzer, in dieser Reihenfolge:

1. Die **Workspace-Mitgliedschaft** ist die Eintrittskarte. Ohne Rolle im Arbeitsbereich gibt es keinen
   Boardzugriff, und **keine Boardrolle kann das umgehen**.
2. Die **Boardrolle** (`owner`, `editor`, `viewer`) verfeinert die Mitgliedschaft je Board. Sie wirkt
   *zusaetzlich* zur Mitgliedschaft und wird als Freigabe an einen vorhandenen internen Nutzer vergeben.

Ein **Gast** aus einem Freigabelink steht vor derselben Funktion, aber auf einem eigenen Weg: er hat weder
Mitgliedschaft noch Boardrolle, und seine einzige Eingabe ist der Grant seines Links
(`BoardSubject.guestGrant`). Beide Wege schliessen sich aus - ein Gast bekommt nie eine interne Stufe, und
ein Mitglied nie einen Gastgrant.

**Ohne ausdrueckliche Freigabe gilt `editor`.** Ein Arbeitsbereich ist ein gemeinsamer Arbeitsraum; eine
Freigabe schraenkt darin gezielt ein oder benennt jemanden ausdruecklich, statt jedem Mitglied den Zugang
erst einzeln eroeffnen zu muessen. Deshalb bleibt der Entzug einer Freigabe genau das: die ausdrueckliche
Boardrolle faellt weg, und es gilt wieder die Mitgliedschaft.

| Aktion | Board-`owner` | Workspace-`owner` | `editor` (auch ohne Freigabe) | `viewer` | `guest-editor` | `guest-viewer` | Nichtmitglied | Systemadmin ohne Mitgliedschaft | deaktiviert |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Board sehen, oeffnen, Szene laden | ja | ja | ja | ja | ja | ja | nein | nein | nein |
| umbenennen, archivieren, entarchivieren | ja | ja | ja | nein | nein | nein | nein | nein | nein |
| Szene speichern, Bild hochladen, importieren | ja | ja | ja | nein | ja | nein | nein | nein | nein |
| Version wiederherstellen | ja | ja | nein | nein | nein | nein | nein | nein | nein |
| Freigaben und Gastlinks verwalten | ja | ja | nein | nein | nein | nein | nein | nein | nein |
| Ownerschaft uebertragen | ja | ja | nein | nein | nein | nein | nein | nein | nein |

Die beiden Gastspalten gelten **nur fuer das eine Board des jeweiligen Links**. Jedes andere Board - auch ein
Nachbarboard desselben Arbeitsbereichs - ist fuer einen Gast nicht vorhanden.

Ein Board **anlegen** darf jedes Mitglied eines aktiven Arbeitsbereichs: vor der Anlage gibt es noch kein
Board und damit auch keine Boardrolle, ueber die zu entscheiden waere. Der Ersteller wird sein Owner.

Der **Workspace-Owner** steht auf jedem Board seines Arbeitsbereichs auf Ownerstufe - auch auf einem, das
ihm nicht gehoert. Ohne das waere ein Board, dessen Owner den Arbeitsbereich verlassen hat oder deaktiviert
wurde, dauerhaft unverwaltbar; es ist dieselbe Ueberlegung, aus der ein Systemadmin jeden Arbeitsbereich
verwaltet. Ein Workspace-`admin` bekommt diese Stufe bewusst **nicht**: er verwaltet Mitglieder, nicht die
Verantwortung fuer einzelne Boards.

Ein **Systemadmin ohne Mitgliedschaft** hat keinen Inhaltszugriff. Er verwaltet Arbeitsbereiche, damit keiner
unadministrierbar wird; ein Board sieht fuer ihn aus wie eine erfundene Kennung - eine Boardrolle hilft ihm
dabei nicht. Ein **deaktivierter** Nutzer verliert jeden Zugriff bereits in `authenticate()`.

**Archiviert heisst lesbar, aber unveraenderlich** - auf beiden Ebenen und fuer jede Boardrolle. In einem
archivierten Arbeitsbereich laesst sich kein Board mehr anlegen, umbenennen, archivieren, speichern oder
freigeben. Bei einem archivierten Board bleibt nur das Entarchivieren.

**Jede Boardantwort nennt die effektive Rolle des Anfragenden** (`viewerRole`, in der Boardliste und in
beiden Formen der Szenenantwort). Sie wird nicht in einer Route aus Rollenfeldern nachgebaut, sondern kommt
aus `effectiveBoardRole` - derselben Funktion, aus der `decideBoardAccess` seine Stufe bildet: erst
`board:read`, dann die Stufe, mit der weitergerechnet wird. Was diese Rolle traegt, beantworten
`mayChangeBoard` und `mayManageBoard`, und **die Entscheidung selbst benutzt genau diese beiden**. Damit gibt
es keine zweite Wahrheit: eine Oberflaeche kann anbieten, was der Server ohnehin zulaesst, ohne die Regeln
nachzubauen - und bleibt trotzdem nur Bequemlichkeit, weil abgelehnt weiterhin am Endpunkt wird.

Der **Archivzustand geht in die Rolle nicht ein**. Er steht im Board und im Arbeitsbereich; ihn in die Rolle
zu falten wuerde aus einem Owner scheinbar einen Viewer machen, der dann nicht einmal mehr entarchivieren
duerfte.

### Interne Freigaben

Eine **Freigabe** gibt einem vorhandenen internen Nutzer eine eigene Rolle auf genau einem Board. Vergeben
werden ausschliesslich `editor` und `viewer`; die Ownerschaft ist keine Freigabe, sondern die Spalte
`boards.owner_user_id`. Sie wird uebertragen und nie vergeben - dadurch hat ein Board immer **genau einen**
Owner, strukturell und nicht nur durch Anwendungslogik. Der Check-Constraint auf `board_grants.role` laesst
`owner` gar nicht erst zu.

Freigegeben wird nur an **Mitglieder desselben Arbeitsbereichs** und nur an aktive Nutzer. Beides wird in
derselben Transaktion gelesen, in der geschrieben wird, und die Nutzerzeile ist dabei lesegesperrt: eine
gleichzeitige Deaktivierung oder ein gleichzeitiger Mitgliedschaftsentzug hinterlaesst keine Freigabe auf
einem ueberholten Stand. Eine Zeile, die einer fehlenden Mitgliedschaft widerspricht, entsteht damit gar
nicht erst - sie waere ohnehin wirkungslos.

Bei der **Uebertragung der Ownerschaft** faellt der bisherige Owner auf seine Mitgliedschaft zurueck, und
eine bestehende Freigabezeile des neuen Owners wird entfernt: sie waere von diesem Moment an wirkungslos und
beim naechsten Wechsel eine stille Herabstufung.

Eine Freigabe kann sich **nicht selbst weitergeben**: ein `editor` verwaltet keine Freigaben, sonst waere
jede Abstufung mit einem Schritt wieder aufgehoben. Und der Owner kann sich seine Ownerschaft nicht
entziehen - dafuer gibt es nur die Uebertragung.

**In der Oberflaeche** steht die Freigabeverwaltung als Abschnitt im Fluss der Boardliste und nicht als
modaler Dialog - dieselbe Entscheidung wie ueberall sonst in dieser SPA: kein Fokuskaefig, keine eigene
Escape-Behandlung, jede Ueberschrift bleibt in der Dokumentstruktur. Der Abschnitt zeigt den Owner, die
vorhandenen Freigaben mit ihrer Rolle, die Auswahl der Empfaenger aus der Mitgliederliste des
Arbeitsbereichs und zu jeder Rolle einen Satz ueber ihre Wirkung. Die Uebertragung der Ownerschaft geschieht
in zwei Schritten: Auswahl, dann eine ausdrueckliche Bestaetigung, die benennt, was danach gilt.

Angeboten wird der Abschnitt dort, wo die Serverantwort die Verwaltung ohnehin traegt - `viewerRole` der
`BoardView`, gelesen mit `mayManageBoard`. Dasselbe gilt fuer Umbenennen und Archivieren in der Boardliste
(`mayChangeBoard`): ein `viewer` bekommt diese Schaltflaechen gar nicht erst angeboten. Das ist
Bequemlichkeit und keine Grenze: **entschieden wird jede einzelne Aktion serverseitig**, und jede Ablehnung
erscheint als Text statt zu verschwinden.

### Oeffentliche Gastfreigaben

Ein **Freigabelink** oeffnet genau ein Board fuer Menschen ohne Konto dieser Instanz. Er ist die einzige
Stelle, an der Boardinhalt ohne Workspace-Mitgliedschaft erreichbar wird, und deshalb eng geschnitten:

- **Genau ein Board, genau eine Gastrolle.** `guest-viewer` liest, `guest-editor` liest und speichert die
  Szene. Ohne ausdrueckliche Wahl gilt `guest-viewer` - Schreibrecht nach aussen ist eine bewusste
  Entscheidung. Umbenennen, Archivieren, Freigabeverwaltung und Ownerschaft bleiben einem Gast in **jedem**
  Zustand verwehrt, und Gastrollen sind eigene Werte: `editor` oder `viewer` werden hier gar nicht erst
  angenommen.
- **Das Token steht nur als Hash in der Datenbank**, genau wie das Sitzungsgeheimnis. Ein Leseleck der
  Datenbank oeffnet kein Board.
- **Das Klartexttoken erscheint genau einmal**, in der Antwort auf das Anlegen. Es laesst sich danach
  nirgends wieder abrufen - auch nicht vom Owner, auch nicht ueber die Liste. Ein verlorener Link wird
  widerrufen und neu angelegt.
- Die geteilte Adresse traegt es im **Fragment** (`/gast#<token>`). Ein Fragment sendet der Browser nicht
  mit; damit erreicht das Token weder ein Zugriffsprotokoll noch einen Referrer noch einen Zwischenspeicher.
  Es steht ebenso wenig in einer Protokollzeile, einem Auditereignis oder einer Fehlermeldung.
- **Optionaler Ablauf, jederzeitiger Widerruf.** Ohne Ablaufangabe laeuft ein Link nicht von selbst ab; das
  steht so in der Liste, und der Widerruf bleibt sein Ende.

Aus einem Link entsteht beim Beitritt eine **Gastsession**: serverseitig, widerrufbar, mit einem selbst
gewaehlten Anzeigenamen und **vier Stunden** Lebensdauer. Sie ueberlebt ihren Link nie - laeuft der Link
frueher ab, endet auch sie frueher. Ein Gastkonto entsteht dabei nicht: es gibt kein Profil, keine
Mitgliedschaft und keine Anmeldung, nur diese eine Sitzung fuer dieses eine Board.

**Ablauf und Widerruf wirken sofort**, auf neue wie auf bestehende Gastsessions: jede Aufloesung eines
Gastzugriffs prueft Gastsession **und** Link in derselben Abfrage, und nichts davon wird zwischengespeichert.
Der Widerruf schliesst zusaetzlich offene Realtime-Verbindungen dieses Links unmittelbar (siehe
*Echtzeit-Kollaboration*).

**Was ein Gast erreicht, ist der Inhalt seines Boards - und sonst nichts.** Vier Endpunkte nehmen eine
Gastsession an: Szene laden und speichern, Bild abrufen und hochladen. Jede andere Strecke - Boardliste,
Freigaben, Gastlinks, Ownerschaft, Arbeitsbereiche, Mitglieder, Systemadministration - verlangt eine interne
Sitzung und antwortet einem Gast mit **401**: sie ist fuer ihn nicht vorhanden, nicht bloss verboten. Ein
fremdes Board ergibt **404**, ununterscheidbar von einer erfundenen Kennung.

Eine gespeicherte Szenenversion eines Gastes traegt **keinen** Autor (`scene_versions.author_user_id` bleibt
leer): ein Gast ist kein Nutzer und steht in keiner Nutzerspalte.

**Ein Gastlink offenbart keinen Arbeitsbereich und keinen internen Nutzer.** Jede Antwort an einen Gast
zeigt vom Board nur `GuestBoardView` - Kennung, Titel, Status, Version und seine eigene Gastrolle
(`viewerRole`, dieselbe, die er mit dem Beitritt ohnehin erfaehrt). Keine Workspacekennung, keine
Ownerkennung, kein Owner-Anzeigename. Das gilt fuer den Gastzugang (`/api/boards/guest/session`) und fuer die
Szene (`GET /api/boards/scene`) gleichermassen; die uebrigen Antworten auf seinem Weg tragen ohnehin nur
Inhalt (`version`/`savedAt` beim Speichern, `BinaryFileRef` beim Bild, dessen Speicherschluessel aus
Boardkennung, Dateikennung und Pruefsumme entsteht).

Der Szenenendpunkt hat dafuer **zwei Antwortformen, die sich im Typ unterscheiden**: `SceneResponse` ist die
Vereinigung aus `BoardSceneResponse` (`viewer: 'member'`, volle `BoardView`) und `GuestBoardSceneResponse`
(`viewer: 'guest'`, `GuestBoardView`). Wer die Antwort verarbeitet, muss auf `viewer` verzweigen und kommt
an die Boardsicht sonst nicht heran - der Unterschied laesst sich damit nicht versehentlich uebergehen. Die
beiden Sichten entstehen an genau einer Stelle (`src/server/board-views.ts`), und die Gastsicht zaehlt ihre
Felder einzeln auf, statt aus der vollen Sicht etwas wegzulassen: ein spaeter ergaenztes Feld der
`BoardView` landet dadurch nicht von selbst beim Gast.

**In der Oberflaeche** verwaltet der Owner die Gastlinks im selben Abschnitt wie die internen Freigaben:
anlegen mit Rollenwahl (Voreinstellung `guest-viewer`) und optionaler Laufzeit in Stunden, die vorhandenen
Links mit Rolle, Erzeuger, Ablauf, Zustand und Zahl der Beitritte, und der Widerruf je Zeile. Der
Klartextlink erscheint **genau einmal**, unmittelbar nach der Anlage und mit dem Hinweis, dass er danach
nicht erneut abrufbar ist; die Liste zeigt ihn nie, und abgelegt wird er nirgends.

**Ein Gast oeffnet `/gast#<token>`.** Die SPA behandelt das als eigene Route noch vor jedem Sitzungszustand:
sie fragt `/api/me` gar nicht erst, liest das Token aus dem Fragment, fragt nach einem Anzeigenamen, tritt
bei und zeigt danach den Editor fuer genau dieses eine Board. Arbeitsbereich, Mitglieder und Boardliste
kommen darin nicht vor, und es gibt keinen Weg dorthin - auch keinen Rueckweg aus dem Editor. Nach dem
Beitritt nimmt die Ansicht das Token aus der Adresszeile; ein neu geladener Tab findet ueber sein Gastcookie
zurueck ins Board. Liegt dagegen ein Token in der Adresse, wird immer beigetreten: welches Board es meint,
weiss allein der Server, und ein vorhandenes Gastcookie koennte zu einem anderen gehoeren. Ist im selben Browser
eine interne Sitzung offen, hat sie Vorrang (siehe *Bekannte Grenzen*); bleibt das Board dadurch unsichtbar,
benennt die Gastansicht genau diese Ursache.

Was es bewusst **nicht** gibt: dauerhafte externe Konten, Gastmitgliedschaften in einem Arbeitsbereich,
Einladungen per E-Mail und weitere Gastrollen.

### Endpunkte

Alle verlangen eine Sitzung; alle zustandsaendernden zusaetzlich das CSRF-Token im Header `x-canvaz-csrf`.
Die Antwort entsteht in der Transaktion und wird erst nach dem Commit gesendet.

| Methode | Pfad | Berechtigung | Ohne Berechtigung | Konflikt |
| --- | --- | --- | --- | --- |
| GET | `/api/boards?workspaceId=&status=&q=` | Mitglied im Arbeitsbereich | 404 | — |
| POST | `/api/boards` | `board:create` | 404 unsichtbar, sonst 403 | — |
| POST | `/api/boards/duplicate` | `board:read` auf der Quelle + `board:create` im selben Arbeitsbereich | 404 unsichtbar, sonst 403 | 409 archivierte Quelle |
| POST | `/api/boards/rename` | `board:rename` | 404 unsichtbar, sonst 403 | — |
| POST | `/api/boards/status` | `board:archive` / `board:unarchive` | 404 unsichtbar, sonst 403 | — |
| GET | `/api/boards/scene?boardId=` | `board:read` | 404 | — |
| POST | `/api/boards/scene` | `scene:write` | 404 unsichtbar, sonst 403 | 409 |
| POST | `/api/boards/assets?boardId=&fileId=` | `scene:write` | 404 unsichtbar, sonst 403 | 409 |
| GET | `/api/boards/assets?boardId=&fileId=` | `board:read` | 404 | — |
| GET | `/api/boards/grants?boardId=` | `board:read` | 404 | — |
| POST | `/api/boards/grants/add` | `grant:manage` | 404 unsichtbar, sonst 403 | 409 |
| POST | `/api/boards/grants/role` | `grant:manage` | 404 unsichtbar, sonst 403 | — |
| POST | `/api/boards/grants/remove` | `grant:manage` | 404 unsichtbar, sonst 403 | 409 |
| POST | `/api/boards/owner` | `board:transfer-ownership` | 404 unsichtbar, sonst 403 | — |
| GET | `/api/boards/share-links?boardId=` | `grant:manage` | 404 unsichtbar, sonst 403 | — |
| POST | `/api/boards/share-links/create` | `grant:manage` | 404 unsichtbar, sonst 403 | — |
| POST | `/api/boards/share-links/revoke` | `grant:manage` | 404 unsichtbar, sonst 403 | — |
| GET | `/api/boards/versions?boardId=` | `board:read` | 404 | — |
| GET | `/api/boards/versions/scene?boardId=&version=` | `board:read` | 404 | — |
| POST | `/api/boards/versions/restore` | `scene:restore` | 404 unsichtbar, sonst 403 | 409 |
| GET | `/api/boards/export?boardId=` | `board:read` | 404 | — |
| POST | `/api/boards/import` | `scene:write` | 404 unsichtbar, sonst 403 | 409 |
| POST | `/api/boards/guest/join` | oeffentlich, gueltiges Token | 404 | — |
| GET | `/api/boards/guest/session` | gueltige Gastsession | 401 | — |

Die vier Endpunkte, die zusaetzlich eine **Gastsession** annehmen, sind `GET`/`POST` auf
`/api/boards/scene` und `/api/boards/assets`. Fuer sie entscheidet dieselbe Policy wie fuer ein Mitglied;
alle uebrigen Zeilen dieser Tabelle verlangen eine interne Sitzung. `GET /api/boards/scene` antwortet einem
Gast in der eigenen, reduzierten Form (`viewer: 'guest'`, siehe oben).

`status` trennt die aktive Liste von der Archivansicht (Standard `active`), `q` filtert nach einem Teilstring
im Titel - ohne Platzhalterdeutung, damit `%` und `_` keine Wirkung haben.

**404 statt 403, wo die Existenz sonst durchscheinen wuerde**, genau wie bei den Arbeitsbereichen.

Die **409** der Freigaberouten sind benannt: eine bereits bestehende Freigabe, eine Freigabe an den
Board-Owner (er traegt seine Rolle in `boards.owner_user_id`) und der Versuch, dem Owner seine Ownerschaft zu
entziehen. Ein unbekannter Zielnutzer ergibt 404, ein deaktivierter oder nicht zum Arbeitsbereich gehoerender
400 - beides erst **nach** der Berechtigungspruefung, damit die Antwort nicht verraet, welche Nutzerkennungen
es gibt.

Freigegeben wird an Nutzer, die bereits Mitglied des Arbeitsbereichs sind; die Auswahl kommt aus
`/api/workspaces/members`. Ein eigenes Nutzerverzeichnis hat die Boardebene deshalb nicht.

### Duplizieren

Ein Board laesst sich **innerhalb seines Arbeitsbereichs** kopieren - angeboten im Kontextmenue der Boardzeile
mit Titelvorschlag (`<Titel> (Kopie)`) und derselben Ordnerauswahl wie beim Verschieben. Kopiert wird der
**zuletzt gespeicherte** Stand samt der Bytes jedes darin genannten Bildes; die Kopie hat eine eigene Kennung,
eigene Assetdatensaetze unter eigenen Speicherschluesseln und gehoert dem Anfragenden. Freigaben, Gastlinks,
Verlauf und Archivzustand bleiben am Original: die Kopie beginnt aktiv mit dem kopierten Stand als Version 1.
Eine archivierte Quelle wird nicht kopiert (409), und in einem archivierten Arbeitsbereich fehlt
`board:create` (403).

Board, Assetdatensaetze und erste Version entstehen in **einer** Transaktion. Scheitert der Vorgang davor -
etwa beim Schreiben der Bytes -, entfernt die Route die schon geschriebenen Schluessel wieder: sie gehoeren zu
einer Boardkennung, die nie sichtbar wurde, und kein anderer Vorgang kann sie brauchen. Nur ein Fehler im
Commit selbst laesst sie liegen und benennt sie als `board.asset.orphan`, weil sein Ausgang offen ist.

### Optimistische Versionspruefung

Jede Speicherung nennt in `baseVersion` die Version, auf der sie aufsetzt. Stimmt sie nicht mehr mit
`boards.current_scene_version` ueberein, antwortet der Server mit **409** und der aktuellen Version; es wird
**nichts** ueberschrieben. Die Pruefung laeuft in einer Transaktion, die die Boardzeile sperrt
(`select ... for no key update`), und der zusammengesetzte Primaerschluessel `(board_id, version)` ist die
zweite Absicherung. Zwei gleichzeitige Speicherungen auf derselben Ausgangsversion ergeben deshalb genau eine
neue Version und genau eine 409.

Diese Pruefung bleibt die Wahrheit ueber die Persistenz - **auch fuer die Echtzeitstrecke**. Ein
Realtime-Checkpoint geht denselben Weg und kann sie nicht umgehen (siehe *Echtzeit-Kollaboration*).

Ohne Echtzeitverbindung speichert die Oberflaeche verzoegert nach der letzten Aenderung und auf Knopfdruck.
Nach einem Konflikt hoert sie auf, automatisch zu speichern: mit der neuen Ausgangsversion weiterzumachen
waere genau das stille Ueberschreiben, das die Pruefung verhindern soll. Die Zeichnung bleibt im Browser, und
der Mensch entscheidet.

### Versionierung und Serialisierung

**Jede angenommene Speicherung legt eine neue Zeile in `scene_versions` an.** Das ist keine Zutat, sondern die
Pruefung selbst: der Primaerschluessel `(board_id, version)` macht zwei Schreibvorgaenge auf derselben
Ausgangsversion unmoeglich. Verdichtet wird bewusst nicht, damit die Daten fuer die Versionshistorie
sauber entstehen. Damit die Historie nicht unbegrenzt waechst, bleiben die juengsten **100** Versionen je
Board erhalten (`CANVAZ_SCENE_VERSION_RETENTION`, erlaubt 10 bis 1000); aeltere fallen bei der naechsten
Speicherung heraus. Die begruendete Zusage ist die Begrenztheit, nicht die Zahl - eine unbegrenzte Historie
gibt es nicht.

Serialisiert wird der Vertrag aus `src/contracts/scene.ts`: Elemente, die persistierte Teilmenge des AppState
und die Referenzen auf Bilddateien. Unbekannte Zusatzfelder werden **nur in `elements`** unveraendert
durchgereicht, damit ein Upstream-Sprung keine Daten verliert; in `appState`, in `files[*]` und auf oberster
Snapshot-Ebene gilt dagegen eine feste Teilmenge, und alles andere wird beim Einlesen verworfen. Tombstones (`isDeleted`) bleiben erhalten, weil eine Loeschung selbst
Information ist. Kamera und Auswahl sind clientlokal und werden bewusst nicht gespeichert. Damit bleibt alles
erhalten, was ein `.excalidraw`-Export braucht.

Ein **beschaedigter Datensatz wird als Fehler gemeldet und nie als leeres Board geoeffnet** - sonst wuerde die
naechste Speicherung die Zeichnung endgueltig ueberschreiben. Ein Board ohne jede Speicherung hat Version `0`
und liefert den leeren Ausgangsstand; das ist sein tatsaechlicher Inhalt und kein Ersatz fuer einen Fehler.

Die Groesse eines Snapshots ist mit `CANVAZ_MAX_SCENE_BYTES` begrenzt (Standard 5 MiB); sie gilt auch fuer
einen wiederhergestellten oder importierten Stand. Die Grenze gilt schon
fuer den Anfragekoerper, sodass ein zu grosser Koerper nie vollstaendig im Speicher landet. **Angenommen wird nur, was sich auch zuruecklesen laesst.** PostgreSQL
kann in `jsonb` weder ein NUL-Zeichen noch ein einsames Surrogat speichern, und eine nicht endliche Zahl
(`1e400` ist gueltiges JSON und wird beim Parsen zu `Infinity`) wuerde beim Serialisieren still zu `null`.
Alle drei werden mit 400 abgelehnt, statt beim Schreiben zu scheitern oder den Wert unbemerkt zu veraendern;
geprueft wird rekursiv, einschliesslich der durchgereichten Zusatzfelder von Elementen. Aus demselben Grund
ist die Verschachtelungstiefe auf 256 Ebenen begrenzt (`MAX_SCENE_DEPTH`): tiefer bricht `JSON.stringify`
selbst mit einem `RangeError` ab, und daraus wuerde ein unbenannter Serverfehler statt einer benannten
Ablehnung. Echte Szenen sind flach; die Grenze liegt weit ueber allem, was der Editor erzeugt.

### Versionsverlauf, Vorschau und Wiederherstellung

Jede angenommene Speicherung und jeder Realtime-Checkpoint legt eine Zeile in `scene_versions` an - die
Historie entsteht nicht zusaetzlich, sondern ist die Versionspruefung selbst. Wer ein Board sehen darf, sieht
seine aufbewahrten Staende mit Zeitpunkt, Urheber und Umfang; **Umfang und Groesse stehen als eigene Spalten
neben dem Snapshot** (`element_count`, `byte_size`), damit die Liste nicht so viele vollstaendige Szenen
lesen muss, wie sie Zeilen zeigt.

**Die Vorschau ist read-only, weil sie nichts anderes kann.** Sie laeuft ueber einen eigenen, nur lesenden
Endpunkt, tritt keinem Boardraum bei und kennt keine Ausgangsversion fuer eine Speicherung. Es gibt damit
keinen Weg, aus einer Vorschau versehentlich einen Schreibvorgang zu machen - wer den Stand uebernehmen
will, stellt ihn ausdruecklich wieder her.

**Eine Wiederherstellung loescht nichts.** Sie schreibt eine **neue** Version mit dem Inhalt der alten; der
bisherige Stand bleibt als eigene Version daneben stehen, und der Weg zurueck ist derselbe Weg noch einmal.
Wiederherstellen darf der Board-Owner, der Workspace-Owner und - als einziger Fall, der nicht aus der
Boardstufe folgt - der Workspace-`admin`: er verwaltet den Arbeitsbereich, damit dessen Bestand nicht an
einer einzelnen Person haengt. Ein `editor` darf es nicht, obwohl er jede einzelne Zeichnung aendern
koennte; Freigaben, Gastlinks und Ownerschaft bleiben dem `admin` umgekehrt weiterhin verwehrt. Entschieden
wird das in `decideBoardAccess` ueber die eigene Aktion `scene:restore` - es gibt keine zweite
Entscheidungsstelle.

#### Kein unerkannt neuerer Stand

Eine Wiederherstellung nennt in `baseVersion` den Stand, den der Anfragende gesehen hat - genau wie jede
Speicherung. Weicht er ab, antwortet der Server mit **409** und der aktuellen Version, und es wird
**nichts** geschrieben; die Oberflaeche laedt die Liste neu und benennt genau das. Erst der naechste,
bewusste Klick auf dem frisch geladenen Stand ist die Bestaetigung. Fuer den Import gilt dieselbe Pruefung.

#### Warum die Elementversionen dabei steigen

Der gesamte Abgleich entscheidet je Element ueber `version` und nicht ueber den Zeitpunkt. Wuerde eine
Wiederherstellung die alten Elemente unveraendert zurueckschreiben, traegt jeder verbundene Browser die
neueren Fassungen weiterhin mit hoeherer `version` - und der naechste Abgleich machte die Wiederherstellung
still rueckgaengig. `supersedeSnapshot` (`src/domain/board/versioning.ts`) hebt deshalb jedes
wiederhergestellte Element ueber die Version, die es im aktuellen Stand hatte, und beerdigt als Tombstone,
was nur der aktuelle Stand kennt. Das ist **kein** Element-Diff: es wird nichts verglichen und nichts
zusammengefuehrt, sondern genau die Aussage festgeschrieben, dass dieser Stand jenen ersetzt.

Der Boardraum wird danach **ersetzt statt zusammengefuehrt** (`BoardRooms.restored`) und schickt jedem
Teilnehmer einen vollstaendigen `snapshot`. Ohne offenen Raum passiert nichts - der naechste Beitritt laedt
den neuen Stand ohnehin aus der Datenbank.

### Export und Import

Exportiert und importiert wird das offene `.excalidraw`-Format - dieselbe Datei, die der Editor selbst
schreibt und liest. Die Bilder stehen darin als eingebettete `data:`-URL, sodass ein Board **eine einzige
Datei** bleibt; ein eigenes Archivformat waere ein Einschluss und braeuchte einen eigenen Packer. Das
Excalidraw-Paket ist dafuer nicht noetig: `src/domain/board/excalidraw-file.ts` beschreibt ein
dokumentiertes JSON-Dateiformat und importiert nichts aus dem Editor.

Exportieren darf, wer das Board lesen darf; importieren, wer seine Szene speichern darf. Ein Import ersetzt
den Inhalt und legt dafuer eine neue Version an - der bisherige Stand bleibt in der Historie.

**Eine Importdatei ist nicht vertrauenswuerdig** und wird vollstaendig geprueft, bevor irgendetwas davon
gespeichert wird:

| Fall | Antwort |
| --- | --- |
| kein `.excalidraw`, unbekannte Formatversion, ungueltige Elemente oder Ansichtsangaben | 400 |
| Verweis auf ein Bild **ausserhalb** der Datei (`http(s)://` statt `data:`) | 400, nichts wird nachgeladen |
| Elementverweis mit ausfuehrbarem Inhalt (`javascript:`, auch mit eingestreuten Steuerzeichen) | 400 |
| mehr als 100 eingebettete Bilder | 400 |
| eingebettetes Bild ohne erlaubtes Bildformat oder mit falsch behauptetem Typ | 415 |
| einzelnes Bild ueber `CANVAZ_MAX_ASSET_BYTES`, Datei ueber `CANVAZ_MAX_IMPORT_BYTES` | 413 |
| Dateikennung, zu der im Board bereits ein **anderer** Inhalt liegt | 409 |
| Board inzwischen gespeichert (`baseVersion` ueberholt) | 409 |

Die Bilder laufen durch **dieselbe** Signaturpruefung wie ein Upload: die Magic Bytes muessen ein erlaubtes
Format ergeben und zum in der Data-URL genannten Typ passen. Der Speicherschluessel entsteht wie immer
inhaltsadressiert aus Boardkennung, Dateikennung und Pruefsumme, und die Dateikennung muss dieselbe gepruefte
Form haben wie beim Upload. Die Groesse eines Imports ist mit `CANVAZ_MAX_IMPORT_BYTES` begrenzt (Standard
20 MiB) - deutlich mehr als ein Snapshot, weil Base64 die Bytes um rund ein Drittel aufblaeht.

**In der Oberflaeche** steht das alles als Abschnitt im Fluss der Boardliste, direkt neben den Freigaben und
aus derselben Boardzeile erreichbar - dieselbe Entscheidung wie ueberall in dieser SPA: kein Dialog, kein
Fokuskaefig, jede Ueberschrift bleibt in der Dokumentstruktur. Der Abschnitt zeigt den aktuellen Stand und
die Aufbewahrungsgrenze, dann Export, dann Import mit dem Hinweis, dass er den Inhalt ersetzt und der
bisherige Stand erhalten bleibt, und zuletzt den Verlauf mit *Ansehen* und *Wiederherstellen* je Zeile. Die
Vorschau oeffnet denselben Editor auf der ganzen Flaeche und benennt im Kopf, dass sie eine Vorschau ist.
Angeboten wird, was der Server ohnehin traegt (`mayRestore` der Antwort, `mayChangeBoard` fuer den Import) -
Bequemlichkeit und keine Grenze.

### Editor und Content-Security-Policy

Excalidraw ist exakt auf `0.18.1` gepinnt und erscheint ausschliesslich in
`src/web/board/excalidraw-adapter.ts` - Komponente wie Typen. Server, Protokoll und Persistenz kennen nur den
eigenen strukturellen Elementvertrag.

**Die Content-Security-Policy wurde dafuer nicht gelockert.** Damit das gilt, liegen die Schriften des Editors
im eigenen Build: `vite.config.ts` kopiert sie nach `dist/web/excalidraw-assets/fonts`, und
`src/web/board/excalidraw-assets.ts` setzt `window.EXCALIDRAW_ASSET_PATH` darauf. Excalidraw haengt an jede
Schriftquelle zusaetzlich einen fest verdrahteten CDN-Rueckfall an; er steht hinter der eigenen Quelle, wird
nie benutzt und wird von der Policy blockiert. Beides ist im Browser nachpruefbar: keine Anfrage erreicht
eine fremde Herkunft, und die Schriften kommen aus dem eigenen Build.

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
| `s3` | `src/persistence/asset-storage-s3.ts` | Spricht AWS S3 und S3-kompatible Server ueber signierte HTTP-Anfragen (AWS Signature Version 4, `node:crypto` und `fetch`). Ein einzelnes `PUT` ist die atomare Einheit des Objektspeichers. Im Betrieb ein externer Anbieter, den der Betreiber selbst stellt; in Entwicklung und CI ist SeaweedFS der Testpartner. |

**Kein S3-SDK.** Gebraucht werden drei Aufrufe auf genau einem Bucket. `@aws-sdk/client-s3` braechte
Paginierung, Multipart, Presigning, Retry-Strategien, eine Credential-Provider-Kette und einen
Middleware-Stack mit - nichts davon wird hier verwendet, und es waeren mehrere Dutzend zusaetzliche Pakete
in einer selbst gehosteten Anwendung. Der einzige nicht triviale Teil ist die Signatur; sie ist
vollstaendig spezifiziert und in wenigen Zeilen geschrieben. Belegt wird das gegen ein echtes SeaweedFS als
Testpartner, nicht gegen eine Attrappe.

Der Speicherschluessel ist **inhaltsadressiert und traegt die Dateikennung**:
`boards/<boardId>/<fileId>/<sha256>`. Dieselbe Datei im selben Board ergibt denselben Schluessel, ein
Wiederholungsversuch ueberschreibt sich selbst, und der erlaubte Zeichenvorrat (`assertStorageKey`) macht
einen Ausbruch aus dem Namensraum gar nicht erst formulierbar. Die Dateikennung gehoert dazu, weil
`board_assets` einen Datensatz je Kennung fuehrt und den Schluessel instanzweit eindeutig verlangt: zwei
Kennungen mit identischem Inhalt sind ein gueltiger Fall, und ihre Bytes gehoeren jeweils genau einem
Datensatz.

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
| `CANVAZ_S3_FORCE_PATH_STYLE` | `s3` | `true` fuer Anbieter ohne Bucket-Subdomains (etwa SeaweedFS im Test), Standard `false` (AWS) |

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

Das ist eine **Signaturpruefung, keine vollstaendige Formatvalidierung**: geprueft werden die Magic Bytes und
ihre Uebereinstimmung mit dem behaupteten Typ, nicht die Struktur der Datei - eine 8 Byte grosse Datei aus
reiner PNG-Signatur wird angenommen. Entschaerft wird das beim Abruf: ausgeliefert wird der in der Datenbank
gespeicherte `content-type`, dazu `nosniff` und `no-store`, sodass der Browser nichts anderes daraus macht.
Ein Decoderlauf je Upload waere die naechste Stufe und braucht eine eigene Entscheidung.

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
data: blob:` seit Beginn erlaubt. Im Browser nachpruefbar: ein Bild wird eingefuegt, hochgeladen,
gespeichert und nach dem Neuladen wieder dargestellt.

Mit dem Bild kommt allerdings ein zweiter, **gewollt blockierter** Verstoss dazu: Excalidraw kompiliert fuer
die Schriftreduktion ein Harfbuzz-WebAssembly und braeuchte dafuer `'wasm-unsafe-eval'` in `script-src`. Die
Policy erlaubt es **nicht**. Zeichnen, Bilder, Speichern und Laden funktionieren ohne; im Browser sind beide
Befunde in einem Durchgang sichtbar. Betroffen waere allein der Export mit reduzierten Schriften, und das
ist kein Gegenstand dieses Pakets; die Lockerung waere eine eigene Entscheidung mit eigener Begruendung.

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

**Der Anwendungscode loescht ueberhaupt keine Bytes.** Auch nicht als Aufraeumung eines gescheiterten
Uploads: schlaegt die Transaktion oder ihr Commit fehl, nachdem die Bytes geschrieben wurden, bleiben sie
liegen und werden als `board.asset.orphan` protokolliert. Eine Kompensationsloeschung koennte Bytes
erwischen, die ein gleichzeitiger zweiter Versuch derselben Datei gerade unter seinem Datensatz braucht, und
Datenverlust wiegt schwerer als ein liegen gebliebenes Objekt. Weil der Schluessel inhaltsadressiert ist,
schreibt ein Wiederholungsversuch genau denselben Schluessel erneut; es waechst also kein Muell mit.

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
- Der Storage-Port kennt keine Bereinigung verwaister Bytes. Bytes ohne Metadatensatz entstehen, wenn ein
  Upload nach dem Schreiben der Bytes scheitert; das wird als `board.asset.orphan` protokolliert. Ein
  Aufraeumlauf braucht dieselbe gesonderte Entscheidung wie das Hard Delete.
- Der Dateisystem-Adapter loest Symlinks nicht auf. Die Wurzel ist eine Konfigurationszusage, keine Sandbox
  gegen den Betreiber des Volumes; was den Pfad in der Wurzel haelt, ist allein die gepruefte Form des
  Schluessels (`assertStorageKey`), und die entsteht ausschliesslich aus Boardkennung, Dateikennung und
  Pruefsumme.
- `SceneSnapshot.files[].storageKey` kommt zwar vom Server, wird beim Abruf aber nicht verwendet: massgeblich
  ist ausschliesslich `board_assets.storage_key`. Ein Client kann ueber die Szene keinen fremden Schluessel
  erreichbar machen.
- `board_grants.user_id` traegt `on delete cascade`: ein direktes Loeschen eines Nutzers in der Datenbank
  raeumt seine Freigaben mit ab. Ueber die Anwendung gibt es kein Loeschen, nur Deaktivierung - und die
  entzieht den Zugriff bereits ueber `authenticate()` und die Policy.
- Wird ein Nutzer aus dem Arbeitsbereich entfernt, bleiben seine Freigabezeilen stehen. Sie sind wirkungslos
  (ohne Mitgliedschaft ist das Board unsichtbar) und wirken bei einer Wiederaufnahme in denselben
  Arbeitsbereich erneut. Ein Aufraeumen waere eine eigene Entscheidung; die Sicherheit haengt nicht daran.
- Der Board-Owner kann ohne Mitgliedschaft im Arbeitsbereich sein - etwa nach einem Mitgliedschaftsentzug.
  Das Board bleibt trotzdem verwaltbar, weil der Workspace-Owner auf jedem Board Ownerstufe traegt.
- **Wer den Gastlink hat, ist der Gast.** Ein Link unterscheidet die Menschen nicht, die ihn benutzen; jeder
  Beitritt bekommt zwar eine eigene Gastsession, aber der Anzeigename ist frei gewaehlt und belegt nichts.
  Wer einzelne Personen unterscheiden oder gezielt entziehen will, legt getrennte Links an oder nimmt sie als
  interne Nutzer auf.
- Ein Widerruf trifft immer den **ganzen** Link und damit alle daraus entstandenen Gastsessions. Eine
  einzelne Gastsession laesst sich nicht gesondert beenden.
- **Die interne Sitzung hat Vorrang vor dem Gastcookie.** Ein angemeldeter Nutzer, der einen Gastlink
  oeffnet, handelt als er selbst; gehoert er dem Arbeitsbereich nicht an, sieht er das Board deshalb nicht,
  obwohl der Link gilt. Beide Zugaenge zu verrechnen waere ein zweiter Entscheidungsweg fuer denselben
  Zugriff - der Ausweg ist die Abmeldung oder eine Aufnahme als internes Mitglied.
- Abgelaufene Zeilen in `board_guest_sessions` werden nicht aufgeraeumt; sie tragen keinen Zugriff mehr, weil
  jede Aufloesung Ablauf und Widerruf mitprueft. Ein Aufraeumlauf braucht dieselbe gesonderte Entscheidung
  wie das Hard Delete.
- `board_guest_sessions.share_link_id` traegt `on delete cascade`: ein direktes Loeschen eines Links in der
  Datenbank nimmt seine Gastsessions mit. Ueber die Anwendung gibt es nur den Widerruf - er erhaelt den
  Nachweis.

### Invarianten

- Der Ersteller wird Board-Owner. **Ein Board hat immer genau einen Owner**: er steht in der `not null`-Spalte
  `boards.owner_user_id`, und `board_grants` kann die Rolle `owner` gar nicht tragen.
- Jede Freigabe- und Ownerschaftsaenderung sperrt zuerst die Boardzeile (`select ... for no key update`).
  Dadurch sind gleichzeitige Uebertragungen serialisiert, und die Entscheidung faellt nie auf einem
  veralteten Stand - dieselbe Absicherung wie bei der Ownerinvariante des Arbeitsbereichs.
- Eine Freigabe entsteht nur fuer einen aktiven Nutzer, der Mitglied desselben Arbeitsbereichs ist. Status
  und Mitgliedschaft werden in derselben Transaktion gelesen, in der geschrieben wird.
- Von Freigabetoken und Gastgeheimnis steht ausschliesslich der SHA-256-Hash in der Datenbank; ein
  Check-Constraint laesst dort nichts anderes als 64 Hexzeichen zu.
- Eine Gastsession gehoert immer zum Board ihres Links: der zusammengesetzte Fremdschluessel
  `(share_link_id, board_id)` macht jede andere Zeile strukturell unmoeglich.
- Eine Gastsession ueberlebt ihren Link nie; ihr Ablauf ist am Ablauf des Links gedeckelt.
- Die Antwort entsteht in der Transaktion und wird erst nach dem Commit gesendet.

### Nachweis

Anlage, Umbenennung, Archivierung und Entarchivierung eines Boards schreiben ein Ereignis nach
`audit_events` (`targetType: 'board'`), ebenso die Uebertragung der Ownerschaft
(`board.ownership-transferred` mit bisherigem und neuem Owner). Jede Freigabe, Rollenaenderung und jeder
Entzug schreibt `board-grant.added`, `board-grant.role-changed` oder `board-grant.removed`
(`targetType: 'board-grant'`, Ziel ist der betroffene Nutzer, Boardbezug und Rollen stehen in `details`).
Aenderung und Nachweis entstehen in derselben Transaktion; eine abgelehnte Aenderung schreibt nichts.

Fuer Gastfreigaben gibt es drei Ereignisse mit `targetType: 'board-share-link'` und dem Link als Ziel:
`board-share-link.created` und `board-share-link.revoked` (Akteur ist der Owner, `details` traegt Board,
Rolle und Ablauf) sowie `board-guest.joined`. Dieses eine Ereignis hat **keinen** internen Akteur - ein Gast
ist kein Nutzer -, und `details` nennt Board, Rolle, Gastsession und den gewaehlten Anzeigenamen. **Kein
Token steht in einem dieser Ereignisse**, weder das des Links noch das der Gastsession.

Wiederherstellung und Import schreiben `board.scene-restored` und `board.scene-imported`
(`targetType: 'board'`): das erste nennt die wiederhergestellte, die neue und die bisherige Version, das
zweite die neue Version sowie die Zahl uebernommener Elemente und Bilder. **Kein Boardinhalt steht darin** -
nur Zahlen und Bezuege.

Einzelne Speicherungen schreiben keinen Nachweis: sie sind Inhalt, nicht Verwaltung, und `audit_events`
enthaelt nie Boardinhalte und nie Tokenmaterial. Die Historie der Inhalte steht in `scene_versions`.

## Echtzeit-Kollaboration

Mehrere Menschen zeichnen gleichzeitig auf demselben Board. Traeger ist **eine** WebSocket-Strecke
(`/api/realtime`) mit **einem Raum je Board**, gehalten im Speicher genau dieser Instanz. Es gibt bewusst
kein Redis und keine Koordination ueber Prozessgrenzen; die Zielgroesse sind fuenf gleichzeitige Bearbeiter
je Board.

### Zustandsmaschine einer Verbindung

```
verbunden --join--> beigetreten --leave--> verbunden
    |                    |
    +--------------------+--> geschlossen (Socket zu, Sitzung ungueltig, Zugriff entzogen)
```

`verbunden` nimmt ausschliesslich `join` an, `beigetreten` alles andere; eine Verbindung ist zu jedem
Zeitpunkt in hoechstens einem Raum. Jede unpassende Nachricht wird benannt abgelehnt und laesst die
Verbindung in ihrem bisherigen Zustand - es gibt keinen undefinierten Zwischenzustand.

### Protokoll

`src/contracts/realtime.ts` ist der gesamte Vertrag und zugleich die einzige Stelle, die eingehende
Nachrichten validiert (`parseClientMessage`). `REALTIME_PROTOCOL_VERSION` steht im `ready` des Servers und
im `join` des Clients; weichen sie ab, wird der Beitritt abgelehnt, statt halb verstandene Nachrichten zu
verarbeiten.

| Richtung | Typ | Nutzlast |
| --- | --- | --- |
| Server → Client | `ready` | `protocolVersion`, `userId` - authentifiziert, aber in keinem Raum |
| Client → Server | `join` | `protocolVersion`, `boardId` |
| Server → Client | `joined` | `boardId`, `clientId`, `canWrite`, `version`, vollstaendige `scene`, `peers` |
| Client → Server | `scene-change` | `boardId`, geaenderte `elements`, `appState` oder `null`, `fileIds` |
| Server → Client | `scene-change` | `boardId`, uebernommene `elements`, `appState`, neue `files` |
| Client → Server | `presence` | `boardId`, `pointer` oder `null`, `selectedElementIds` |
| Server → Client | `presence` | `boardId`, vollstaendiges Teilnehmerfeld `peers` |
| Client → Server | `resync` | `boardId` |
| Server → Client | `snapshot` | `boardId`, `version`, vollstaendige `scene` |
| Client → Server | `leave` | `boardId` |
| Server → Client | `left` | `boardId` |
| Server → Client | `access` | `boardId`, `canWrite` - die Berechtigung hat sich geaendert |
| Server → Client | `saved` | `boardId`, `version`, `savedAt` |
| Server → Client | `error` | `code`, `message` |

`fileIds` nennt ausschliesslich Kennungen: Groesse, Typ und Speicherschluessel loest der Server aus
`board_assets` auf. Bytes laufen nie ueber diesen Kanal, sondern weiterhin ueber den autorisierten
Assetendpunkt.

### Wer darf was

**Die WebSocket-Grenze prueft nicht schwaecher als die HTTP-API.** Es gibt genau eine Stelle, an der aus
einer Verbindung eine Berechtigung wird (`resolveAccess` in `src/server/board-rooms.ts`), und sie ruft
dieselbe Funktion auf wie jede Route: `decideBoardAccess`. Gelesen wird bei **jedem** Aufruf frisch, ohne
Zwischenspeicher.

`resolveAccess` liest dabei **Mitgliedschaft, Boardrolle und - bei einem Gast - die Rolle seines noch
gueltigen Links aus demselben Datensatz** und baut denselben `BoardSubject`, den auch die Routen bauen.

- **Beim Beitritt** entscheidet `board:read`. Wer nicht lesen darf, bekommt `board-nicht-gefunden` - genau
  dieselbe Antwort wie fuer eine erfundene Kennung. Ob es das Board gibt, erfaehrt er nicht.
- **Bei jeder Aenderungsnachricht** wird `scene:write` erneut aufgeloest. Eine manipulierte Nachricht eines
  Teilnehmers ohne Schreibrecht wird verworfen, veraendert den Raumzustand nicht und erreicht niemanden.
- **Beim Checkpoint** entscheidet dieselbe Policy noch einmal unter der Zeilensperre des Boards.
- **Stille Verbindungen** werden alle zwei Sekunden nachgeprueft. Ein Mitgliedschaftsentzug beendet die
  Verbindung mit dem Schliessgrund `4403`, eine Archivierung oder eine Herabstufung auf `viewer` stuft sie
  auf Nur-Lesen herab (`access`) - beides ohne dass sich jemand neu anmelden muss. Deaktivierung und Logout
  schliessen bereits auf der Sitzungsebene (`4401`).

Eine **Rollenaenderung waehrend einer offenen Verbindung** wirkt sofort und ohne Protokollaenderung: die
Herabstufung auf `viewer` schickt ein `access` mit `canWrite: false`, und die naechste Aenderungsnachricht
wird mit `kein-schreibrecht` abgelehnt. Der Entzug der Freigabe stellt umgekehrt den Standard wieder her und
schickt `access` mit `canWrite: true`. Nur der Verlust der **Mitgliedschaft** beendet die Verbindung - eine
Boardrolle traegt ohne sie nichts.

Presence ist ausdruecklich **kein** Schreibzugriff auf den Boardzustand; sie setzt Raummitgliedschaft
voraus, die beim Beitritt geprueft und durch den Wiederholungslauf laufend bestaetigt wird.

**Gaeste sitzen im selben Raum.** Ein Gast aus einem Freigabelink tritt demselben Boardraum bei, mit
demselben Protokoll und derselben Presence: sein selbst gewaehlter Anzeigename, ob er schreiben darf, Zeiger
und Auswahl - keine Adresse, keine Kennung, keine Rolle. Fuer ihn gilt jede Grenze dieses Abschnitts
unveraendert, und `ready.userId` traegt statt einer Nutzerkennung die seiner Gastsession.

Ueber die Strecke erreicht ihn damit **keine Workspacekennung und keine interne Nutzerkennung**: `joined`
und `snapshot` tragen Boardkennung, Version und Szene, `presence` das Teilnehmerfeld, `error` einen festen
Text. Die **Anzeigenamen der gerade anwesenden Mitbearbeiter** sind der eine gewollte Ausnahmefall - ohne sie
waere eine gemeinsame Zeichenflaeche anonym.

Ablauf und Widerruf seines Links wirken auf die offene Verbindung wie ein Mitgliedschaftsentzug: die
naechste Aufloesung findet nichts mehr und beendet sie. Der Widerruf schliesst sie zusaetzlich **sofort**,
statt bis zur naechsten Nachpruefung zu warten - genau wie ein Logout eine interne Sitzung schliesst. Ein
Wiederaufbau scheitert danach bereits am Upgrade. Ein Rollenwechsel des Links wuerde ihn wie jede andere
Herabstufung auf Nur-Lesen stellen (`access`); das Protokoll aendert sich fuer nichts davon.

### Was Presence uebertraegt

Eine fluechtige Verbindungskennung, den Anzeigenamen, ob dieser Teilnehmer schreiben darf, den Zeiger und die
Auswahl. **Keine E-Mail, keine Nutzerkennung, keine Rolle.** Bei einem Gast ist der Anzeigename der, den er
sich beim Beitritt selbst gegeben hat; ob ein Teilnehmer Mitglied oder Gast ist, uebertraegt Presence nicht.
Presence wird nie persistiert und verschwindet mit der Verbindung.

Uebertragen wird gebuendelt, in beide Richtungen: der Browser sammelt Zeigerstaende und geaenderte Elemente
und schickt sie hoechstens alle **50 ms**, der Raum verschickt hoechstens alle **100 ms** ein vollstaendiges
Teilnehmerfeld. Ungebuendelt waeren das bei fuenf Bearbeitern mehrere hundert Nachrichten je Sekunde; 100 ms
liegen unter der Wahrnehmungsschwelle fuer einen fremden Mauszeiger, und weil die Reconciliation ueber
`version` entscheidet und nicht ueber die Reihenfolge, kann ein zurueckgehaltener Zwischenstand nichts
verlieren - er wird schlicht vom neueren ueberholt.

### Fanout und Konvergenz

Der Raum haelt den geteilten Zustand im Speicher. Eine eingehende Aenderung wird ueber
`reconcileElements` zusammengefuehrt; weitergegeben werden **nur die tatsaechlich uebernommenen** Elemente,
und nie an den Absender zurueck. Eine verspaetete Nachricht mit aelterer Version aendert damit nichts und
loest auch keinen Fanout aus. Es gibt keine zentrale Sequenznummer: hoehere `version` gewinnt, bei
Gleichstand der kleinere `versionNonce`, Loeschungen bleiben als Tombstone.

### Checkpoints

Der Raum schreibt **nicht bei jeder Aenderung**, sondern getaktet:

- **2 Sekunden** nach der letzten Aenderung (Ruhe), und
- spaetestens **10 Sekunden** nach der ersten unpersistierten Aenderung (Obergrenze), und
- **sofort**, wenn der letzte Teilnehmer den Raum verlaesst oder der Server geordnet beendet wird.

Die Ruhezeit macht eine abgeschlossene Zeichnung schnell sicher, die Obergrenze begrenzt den Verlust bei
durchgehendem Zeichnen auf zehn Sekunden Arbeit. Eine Speicherung je Aenderung wuerde `scene_versions` mit
jedem Mausklick fuellen und die Historie unlesbar machen.

**Ein Checkpoint kann keinen neueren Stand ueberschreiben.** Er laeuft durch dieselbe Transaktion wie die
HTTP-Speicherung: Zeilensperre auf dem Board, Berechtigungspruefung, `append` auf `version + 1` gegen den
Primaerschluessel `(board_id, version)`. Steht in `boards.current_scene_version` inzwischen eine hoehere
Nummer, wird der persistierte Stand zuerst per Reconciliation in den Raum zusammengefuehrt und erst danach
die naechste Version geschrieben - je Element entscheidet die Version, nicht der Zeitpunkt der Speicherung.
Wird der Checkpoint abgelehnt (etwa weil das Board inzwischen archiviert ist), bleibt der Raum unpersistiert
statt an der Policy vorbei zu schreiben.

### Wiederaufnahme nach einem Abbruch

Bricht die Verbindung ab, baut der Browser sie selbst wieder auf: **exponentiell wachsender Abstand ab
500 ms bis 15 s, zur Haelfte gewuerfelt**. Die Streuung ist kein Beiwerk - ohne sie traefen nach einem
Serverneustart alle Browser im selben Augenblick wieder ein.

Der Abgleich laeuft in genau zwei Schritten und braucht kein Nachfordern verpasster Teilstuecke:

1. Der Server liefert beim Wiederbeitritt den **vollstaendigen** Raumzustand (`joined`).
2. Der Client schickt danach **seine eigenen Elemente erneut**. Was waehrend der Trennung lokal entstanden
   ist, kennt nur er.

Beide Richtungen laufen durch dieselbe Reconciliation. Ein aelterer Stand kann deshalb keinen neueren
verdraengen, egal in welcher Reihenfolge er eintrifft - eine verspaetete Nachricht nach dem Reconnect
aendert nichts und loest auch keinen Fanout aus. Ausgehende Nachrichten werden auf 200 Elemente aufgeteilt,
damit der Nachsendeschub nie die Rahmengrenze reisst.

Faellt der Abbruch genau in einen laufenden Abschluss-Checkpoint, wartet der Wiederbeitritt auf dessen
Ende, statt den Raum neben ihm aus einem aelteren Stand zu laden.

Nach vier Schliessgruenden versucht es der Browser **nicht** erneut, weil sich daran nichts aendern wuerde:
`4401` (Sitzung ungueltig), `4403` (Boardzugriff entzogen), `4429` (zu viele Verbindungen oder Nachrichten)
und `1009` (Rahmen zu gross).

### Herzschlag

Alle **30 Sekunden** geht ein Ping an jede Verbindung; wer eine Runde nicht antwortet, wird beim naechsten
Takt hart beendet. Damit ist ein halb offener Socket - Kabel gezogen, Laptop zugeklappt, Proxy ohne FIN -
spaetestens nach einer Minute weg, statt Raumplatz und einen Presence-Eintrag als Karteileiche zu halten.
Der Abstand orientiert sich an den ueblichen 60 Sekunden Leerlaufgrenze eines Reverse Proxys.

### Grenzen an der Socketgrenze

Alle Werte sind Implementierungsgrenzen mit Reserve gegenueber dem Lastziel und sind konfigurierbar
(`createRealtimeGateway`, `createBoardRooms`; die Raumgroesse folgt `CANVAZ_MAX_SCENE_BYTES`). Keine davon
fuehrt zu einem unbenannten Fehler, und keine hinterlaesst einen Raum, der nicht weiterarbeitet.

| Grenze | Standard | Bei Ueberschreitung | Warum dieser Wert |
| --- | --- | --- | --- |
| Rahmengroesse (`maxPayload`) | `CANVAZ_MAX_SCENE_BYTES`, 5 MiB | `ws` verwirft den Rahmen und schliesst mit `1009` | Mehr kann auch ein gespeicherter Snapshot nie tragen |
| Elemente je Nachricht | 2 000 | `zu-viele-elemente`, **nichts** uebernommen | Weit ueber jeder laufenden Aenderung; gekappt waere stiller Datenverlust |
| Nachrichten je Verbindung | 120/s, Eimer 240 | `zu-viele-nachrichten`; bei Dauerflut Schliessen mit `4429` | Der Browser buendelt auf hoechstens 40/s - dreifache Reserve, zwei Sekunden Nachholschub |
| Akkumulierter Raumzustand | `CANVAZ_MAX_SCENE_BYTES`, 5 MiB | `raum-zu-gross`, Aenderung verworfen, Raum bleibt benutzbar | Der Raum haelt genau das, was ein Checkpoint schreibt und die HTTP-Speicherung wieder annehmen muss |
| Teilnehmer je Raum | 10 | `raum-voll` beim Beitritt, Anwesende unberuehrt | Der Reservewert des Produktvertrags |
| Verbindungen je Nutzer (Gast: je Gastsession) | 5 | `zu-viele-verbindungen` und Schliessen mit `4429` | Fuenf Tabs sind grosszuegig; ein Konto darf die zehn Verbindungen nicht allein belegen |

Geprueft wird die **projizierte** Groesse, nicht die aktuelle: eine Aenderung, die den Raum kleiner macht
oder gleich gross laesst, kommt auch an der Grenze noch durch. Ein volles Board bleibt damit vollstaendig
bedienbar - nur weiteres Wachstum wird benannt abgelehnt.

### Backpressure

Jede ausgehende Nachricht laeuft ueber genau eine Stelle (`deliver`), und genau dort steht die Leiter vom
harmlosen zum harten Mittel. Die Reihenfolge folgt dem, was ein spaeterer Stand von selbst nachliefert:

1. **Ab 64 KiB Rueckstau: Presence verwerfen.** Ein Teilnehmerfeld ist fluechtig und wird vom naechsten
   vollstaendig ersetzt. Das Verwerfen kostet nichts.
2. **Ab 1 MiB: auch Aenderungen verwerfen** - aber die Verbindung wird als abgleichbeduerftig vermerkt und
   bekommt, sobald ihr Puffer abgeflossen ist, einen **vollstaendigen** `snapshot` statt der verpassten
   Teilstuecke. Kein stiller Verlust. Ein Megabyte ist der Punkt, an dem einzelne Teilstuecke nicht mehr
   billiger sind als ein frischer Gesamtstand.
3. **Ab 4 MiB: trennen** (`4408`). Wer einen szenengrossen Puffer nicht abnimmt, liest nicht mehr; dann ist
   ein neuer Aufbau mit Rueckzugstakt billiger als weiter zu puffern. Der Schliessgrund ist ausdruecklich
   kein Endzustand - der Browser verbindet sich neu und gleicht ab.

Nie verworfen werden `joined`, `snapshot`, `saved`, `access`, `left` und `error`: sie sind klein und tragen
Bedeutung, die kein spaeterer Stand nachliefert. Eine Verbindung, die dauerhaft gar nichts mehr abnimmt,
faellt ohnehin dem Herzschlag zum Opfer.

### Gemessen

`tests/integration/realtime-load.test.ts` misst gegen die Zielwerte des Produktvertrags, mit den
**Standardtakten** und nicht mit verkuerzten Testwerten:

| Messung | Aufbau | Ergebnis | Schwelle im Test |
| --- | --- | --- | --- |
| Zustellzeit einer Aenderung an **alle** neun Gegenstellen | 5 Bearbeiter, 10 Verbindungen, 100 Aenderungen im 50-ms-Takt | p50 8,3 ms, p95 9,7 ms, Spitze 22,0 ms | p95 < 150 ms, Spitze < 500 ms |
| Zustellzeit einer Zeigerbewegung an **alle** neun Gegenstellen | 5 Bearbeiter, 10 Verbindungen, 100 Bewegungen im 150-ms-Takt | p50 102,2 ms, p95 104,2 ms, Spitze 104,6 ms | p95 < 250 ms, Spitze < 600 ms |
| Checkpoint-Takt unter Dauerlast | 5 Bearbeiter, 575 Aenderungen in 11,5 s | 1 Checkpoint waehrend der Last, 1 weiterer nach der Ruhezeit | Obergrenze gegriffen, weniger als ein Zehntel der Aenderungen als Versionen |
| Ressourcenverhalten | dieselbe Last | Raum haelt 5 Elemente statt 100 Nachrichten, `scene_versions` bleibt unter der Aufbewahrungsgrenze, Raumzahl faellt auf 0 | fest zugesichert |

Die Schwellen sind Obergrenzen mit Reserve, keine Bestwerte: der Bezugspunkt ist die Wahrnehmung. Eine
gemeinsame Zeichenflaeche fuehlt sich gleichzeitig an, solange eine fremde Aenderung innerhalb von etwa
hundert Millisekunden erscheint; 150 ms fuer das 95. Perzentil lassen darueber hinaus Reserve fuer eine
belastete Maschine, ohne einen echten Einbruch durchzulassen.

### Im Editor

Der Editor zeigt Verbindungsstatus, Speicherstatus und die Mitbearbeiter namentlich. Es gibt immer genau
einen Weg, wie eine Zeichnung sicher wird:

- **Live verbunden**: der Raum verteilt und persistiert; der Speicherstatus kommt vom Server (`saved`).
- **Nicht verbunden**: die verzoegerte Speicherung ueber die HTTP-API uebernimmt wieder.

Ein **laufender kurzer Wiederverbindungsversuch** ist bewusst keiner der beiden Faelle: solange er laeuft,
speichert die Ansicht nicht selbst. Eine Speicherung gegen die Checkpoints des Raums erzeugte sonst einen
Konflikt, den es fachlich gar nicht gibt. Erst nach fuenf Sekunden ohne Strecke uebernimmt die
HTTP-Speicherung wieder.

Sichtbar und als `role="status"` beziehungsweise `role="alert"` auch fuer eine Sprachausgabe hoerbar sind:
der Verbindungsverlust, der laufende Versuch mit seiner Nummer, der erfolgreiche Abgleich nach der
Wiederaufnahme mit Uhrzeit, jede benannt abgelehnte Nachricht (mit einer Schaltflaeche zum Ausblenden) und
jedes Speicherproblem.

**Nur Lesen ist ein benannter Zustand.** Der Editor sagt in einem `role="status"`-Bereich, ob er bearbeitet
oder nur liest, und im zweiten Fall warum: archivierter Arbeitsbereich, archiviertes Board, fehlendes
Schreibrecht oder ein Freigabelink mit Leserecht. Er bietet dann keine Speicheraktion an, und die
Zeichenflaeche steht im Lesemodus. Behauptet wird dabei nichts: die Szenenantwort nennt die effektive Rolle
(`viewerRole`), und ob sie aendern darf, sagt `mayChangeBoard` - dieselbe Funktion, mit der der Server
entscheidet. Der Modus steht damit schon **vor** dem Beitritt in den Boardraum fest und auch dann, wenn die
Realtime-Strecke gar nicht zustande kommt. Die Grenze liegt trotzdem im Server; die Ansicht stellt sie nur
dar.

**Aendert sich das Recht waehrend der Sitzung, wechselt die Ansicht ohne Neuladen.** Ein `access` mit
`canWrite: false` stellt die Zeichenflaeche auf Lesen, nimmt die Speicheraktion weg und benennt den Wechsel;
ein `access` mit `canWrite: true` stellt beides wieder her. Niemand muss dafuer neu laden oder sich neu
anmelden.

Derselbe Editor traegt beide Wege. Er kennt vom Board nur Titel und Status - genau das, was in **beiden**
Antwortformen von `GET /api/boards/scene` steht - und verzweigt auf `viewer`, statt aus einer Gastantwort
Felder zu lesen, die es dort nicht gibt.

Ein Verbindungsverlust ist damit sichtbar und fuehrt nicht zu stillem Datenverlust. Die
Content-Security-Policy wurde dafuer **nicht** gelockert: `connect-src` faellt auf `default-src 'self'`
zurueck, und `'self'` deckt die gleichnamige WebSocket-Herkunft ab.

### Bekannte Grenzen

- **Genau eine Instanz.** Raeume leben im Prozessspeicher; zwei Anwendungsserver haetten zwei getrennte
  Raeume fuer dasselbe Board. Horizontale Skalierung braucht eine eigene Entscheidung.
- **Kein garantierter Offlinemodus.** Der Browser haelt waehrend einer Trennung seinen lokalen Stand und
  schickt ihn nach der Wiederaufnahme erneut; wer den Tab dabei schliesst, verliert die Zeichnung, sofern
  die HTTP-Speicherung sie nicht bereits uebernommen hat. Ein Zwischenspeicher im Browser ist bewusst nicht
  gebaut.
- **Volles Board bleibt voll.** Ist die Obergrenze des Raumzustands erreicht, wird Wachstum benannt
  abgelehnt. Loeschen hilft nur begrenzt, weil ein Tombstone ungefaehr so gross ist wie das Element selbst.
  Verdichtete Tombstones waeren der Ausbauweg, wenn das im Betrieb je auftritt.
- **Gaeste zaehlen wie Bearbeiter.** Ein Gast belegt einen der zehn Plaetze eines Raums und faellt unter
  dieselben Grenzen; ein breit geteilter Link kann einen Raum damit fuellen, und weitere Beitritte werden
  dann benannt mit `raum-voll` abgelehnt. Wer den Zulauf begrenzen will, befristet oder widerruft den Link.
- Der Zeigezustand wird an Zeigerbewegungen gehaengt. Eine Auswahl ohne jede Mausbewegung (etwa per
  Tastatur) wird erst mit der naechsten Bewegung sichtbar.

## Identity Provider einrichten (Beispiel Authentik)

Der externe Weg ist **optional**: ohne die vier `CANVAZ_OIDC_*`-Variablen laeuft die Instanz allein mit der
lokalen Benutzerverwaltung. Wer ihn zuschaltet, setzt alle vier - sonst startet der Server nicht.

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

## Betrieb auf einem VPS

Zielbild ist ein **einzelner gewoehnlicher Linux-VPS** mit Docker Engine und Compose v2 - kein Cluster, keine
providerabhaengige Sonderfunktion und keine Host- oder Festplattenverschluesselung. Die Instanz besteht
ausschliesslich aus drei Diensten: einem Reverse Proxy mit TLS, dem Anwendungsserver und PostgreSQL - und
zwar unabhaengig vom gewaehlten Storage-Adapter. Wer `s3` faehrt, spricht einen externen, selbst gestellten
Objektspeicher an; diese Instanz liefert dafuer keinen eigenen Dienst mit.

| Datei | Rolle |
| --- | --- |
| `Dockerfile` | Zweistufiges Laufzeitimage: gebaute SPA und gebauter Server, ohne Werkzeugkette und ohne Quelltext. Laeuft unprivilegiert. |
| `compose.prod.yml` | Die Bereitstellung. `compose.yml` daneben bleibt die Entwicklungsumgebung und startet nur Datenbank und SeaweedFS. |
| `docker/Caddyfile` | TLS, HSTS, Bereitschaftspruefung des Upstreams, Abriegelung des Metrikendpunkts. |
| `docker/canvaz-ops.sh` | `backup`, `restore`, `check`. |
| `.env.production.example` | Vorlage der Laufzeitkonfiguration. Die ausgefuellte `.env.production` bleibt auf dem Host. |

### Voraussetzungen

- Linux-VPS mit Docker Engine und Docker Compose v2, `gpg` und `tar` auf dem Host.
- Ein persistentes Volume in der Standardkonfiguration des Anbieters. Die Anwendung setzt **keine**
  Hostverschluesselung, kein LUKS, kein KMS und keinen verschluesselten Bootvorgang voraus; portabel wird
  ein Sicherungsarchiv dadurch, dass es verschluesselt geschrieben wird, nicht durch den Datentraeger.
- Ein DNS-Eintrag auf den Host und die Ports 80/443 erreichbar - Caddy holt darueber das Zertifikat.
- Optional ein registrierter OIDC-Client (siehe
  [Identity Provider einrichten](#identity-provider-einrichten-beispiel-authentik)). Ohne ihn laeuft die
  Instanz allein mit der lokalen Benutzerverwaltung.
- Kapazitaetsziel sind 30 angelegte Nutzer, fuenf gleichzeitige Bearbeiter auf einem Board und zehn
  gleichzeitige Verbindungen. Dafuer traegt **ein** Anwendungsprozess; die Messung dazu steht unter
  [Gemessen](#gemessen).

### Installation

```sh
cp .env.production.example .env.production   # Platzhalter ersetzen, Datei bleibt auf dem Host
export COMPOSE_FILE=compose.prod.yml
export COMPOSE_ENV_FILES=.env.production

docker compose pull                                          # veroeffentlichtes Image aus CANVAZ_IMAGE
docker compose up --detach
docker compose run --rm app node dist/persistence/migrate-cli.js
docker compose run --rm app node dist/server/bootstrap-cli.js --name "Vorname Nachname" --email adresse@example.com
```

Danach antwortet `https://<CANVAZ_SITE_ADDRESS>/api/ready` mit `200`. Der letzte Aufruf legt den einzigen
Systemadmin an und gibt dessen Einladungslink aus; er gilt genau einmal und befristet. Feste Zugangsdaten
gibt es nicht.

Nach aussen offen sind ausschliesslich die beiden Ports des Reverse Proxy. Anwendungsserver und Datenbank
haben keinen veroeffentlichten Port und sind nur im Compose-Netz erreichbar; ein externer Objektspeicher im
Modus `s3` liegt ohnehin ausserhalb dieses Compose-Netzes. Kein Geheimnis steht im Repository: alle Werte
kommen aus `.env.production`, und der Server startet gar nicht erst, wenn einer davon fehlt.

### Getrennte Konfiguration

| Umgebung | Woher | Besonderheit |
| --- | --- | --- |
| Entwicklung | `.env` aus `.env.example`, `compose.yml` | Datenbank und SeaweedFS auf hohen Hostports, Klartext-HTTP. |
| Test | `CANVAZ_TEST_DATABASE_URL`, `CANVAZ_TEST_S3_ENDPOINT`, sonst Werte im Testaufbau | eigene Datenbank `canvaz_test`. |
| Produktion | `.env.production` aus `.env.production.example`, `compose.prod.yml` | TLS, Reverse Proxy, persistente Volumes, `CANVAZ_TRUSTED_PROXY=true`. |

### Gesundheit, Bereitschaft, Metriken und Logs

`/api/health` beantwortet die Frage **lebt dieser Prozess** (mit Datenbankkontakt) und haengt am
Container-Healthcheck. `/api/ready` beantwortet die Frage **darf diese Instanz Verkehr bekommen**: sie
prueft Datenbank *und* konfigurierten Assetspeicher und antwortet sonst mit `503` samt Angabe, welche der
beiden fehlt. Der Reverse Proxy fragt genau diesen Pfad (`health_uri /api/ready`, alle fuenf Sekunden) und
nimmt die Instanz aus dem Verkehr, solange sie nicht bereit ist. Der Grund steht als eine Logzeile
(`ready.failed`) im Serverlog, nie in der oeffentlich erreichbaren Antwort.

Die Echtzeitstrecke haengt am selben HTTP-Server wie die API; ihr Upgrade laeuft durch denselben Proxy und
faellt damit unter dieselbe Bereitschaft. Wie viele Verbindungen und Raeume offen sind, steht in den
Metriken.

`/api/metrics` liefert das Prometheus-Textformat mit den Kernwerten: Laufzeit, beantwortete Anfragen je
Statusklasse, wegen der Ratengrenze abgelehnte Anfragen, offene WebSocket-Verbindungen, offene Boardraeume
und die Verbindungen des Datenbankpools. Es gibt bewusst **kein** Pfad-, Nutzer- oder Boardlabel: eine
Metrik mit solchen Werten waere eine zweite, unbeaufsichtigte Ausgabe von Nutzungsdaten. Der Endpunkt hat
keinen eigenen Zugriffsschutz und gehoert deshalb ins interne Netz - der Reverse Proxy beantwortet ihn von
aussen mit `404`.

Logs sind eine JSON-Zeile je Ereignis auf stdout, eingesammelt vom Docker-Logtreiber mit begrenzter Groesse
(`max-size: 10m`, fuenf Dateien) - ein unbegrenztes Log fuellt sonst die Platte und nimmt die Datenbank mit.
Ein Fehler wird auf Name und Meldung reduziert; weder OIDC- noch Freigabetokens noch Boardinhalte kommen
darin vor.

### Alarme

`docker/canvaz-ops.sh check` prueft in einem Lauf, ob der Anwendungscontainer laeuft, ob die Instanz bereit
ist, ob seit dem letzten Lauf ungewoehnlich viele `5xx` entstanden sind, ob die Volumes volllaufen und ob
die juengste Sicherung noch innerhalb des RPO liegt. Jeder Befund ist eine JSON-Zeile auf stderr in
derselben Form wie das Anwendungslog, und der Aufruf endet mit Exitcode 1 - genau das, was ein Cronjob als
Alarm weitergibt.

```cron
*/10 * * * *  cd /opt/canvaz && docker/canvaz-ops.sh check
15 3 * * *    cd /opt/canvaz && docker/canvaz-ops.sh backup
```

### Sicherung und Wiederherstellung

`docker/canvaz-ops.sh backup` schreibt **einen** verschluesselten Stand aus Datenbank und Assets:

- `pg_dump --format=custom` der Datenbank, **zuerst**, dann die Assets. Die Reihenfolge ist die
  Konsistenzzusage: Assets werden nur angelegt, nie geloescht, deshalb liegt ein zwischenzeitlich
  hochgeladenes Bild danach ohne Datensatz im Speicher und stoert niemanden - andersherum verwiese ein
  Datensatz auf Bytes, die im Archiv fehlen.
- Die Assets als `tar`, nur im Modus `filesystem` aus dem Volume. Im Modus `s3` liegen die Bytes bei einem
  externen Objektspeicher, den diese Instanz nicht mitliefert; ihre Sicherung ist Sache des Betreibers bzw.
  des Anbieters, und das Archiv enthaelt dafuer keinen eigenen Stand.
- Ein `meta`-Eintrag mit Zeitpunkt, Adapter, Image und angewendeter Schemaversion.
- Verschluesselt mit `gpg --symmetric` (AES-256) **bevor** das Archiv seinen Platz hat. Die Passphrase steht
  in einer Datei ausserhalb des Repositories (`CANVAZ_BACKUP_PASSPHRASE_FILE`). Aufbewahrung sind 14 Tage;
  aeltere Archive entfernt derselbe Lauf.

`docker/canvaz-ops.sh restore <archiv>` haelt die Anwendung an, spielt die Datenbank zurueck - im Modus
`filesystem` zusaetzlich die Assets - und startet sie wieder. Bestaetigt sind **RPO 24 Stunden** (taegliche
Sicherung) und **RTO 4 Stunden**; der Drill in einer leeren Umgebung - Stack hochfahren, migrieren,
wiederherstellen - dauert bei diesem Datenumfang Sekunden und ist von der Sicherungsgroesse, nicht vom
Verfahren begrenzt.

### Assetspeicher wechseln

Der Wechsel zwischen `filesystem` und `s3` ist ausschliesslich Konfiguration - `CANVAZ_STORAGE_ADAPTER` und
die zugehoerigen Werte. Kein Anwendungscode kennt den Unterschied, und die Datenbank bleibt unberuehrt: die
Speicherschluessel sind in beiden Modi dieselben.

```sh
docker/canvaz-ops.sh backup                    # Stand im alten Modus, insbesondere die Datenbank
# CANVAZ_STORAGE_ADAPTER und die S3-Werte in .env.production auf den externen Anbieter umstellen
docker compose up --detach
docker/canvaz-ops.sh restore <archiv>          # spielt die Datenbank zurueck
```

Den Bucket legt der Betreiber beim gewaehlten Anbieter an, nicht die Anwendung: sie braeuchte dafuer
dauerhaft Rechte, die sie im Betrieb nicht hat. Fehlt er, meldet `/api/ready` `storage: error` und der
Proxy haelt den Verkehr zurueck. Vorhandene Assetbytes migriert `docker/canvaz-ops.sh` beim Wechsel auf
`s3` nicht automatisch dorthin - das ist Sache des Betreibers bzw. des Anbieters (siehe
[Sicherung und Wiederherstellung](#sicherung-und-wiederherstellung)).

### Update und Rollback

```sh
docker/canvaz-ops.sh backup                                     # Stand vor dem Update
# CANVAZ_IMAGE in .env.production auf die neue Version setzen
docker compose pull && docker compose up --detach
docker compose run --rm app node dist/persistence/migrate-cli.js
curl https://<CANVAZ_SITE_ADDRESS>/api/ready
```

Der Rueckweg ist derselbe Weg mit der alten Versionsnummer in `CANVAZ_IMAGE`. Solange das Update keine
Migration mitgebracht hat, genuegt das - das Schema ist unveraendert und der alte Stand arbeitet auf
denselben Daten weiter. Hat es eine Migration mitgebracht, gehoert die vor dem Update genommene Sicherung
dazu: erst `restore`, dann das alte Image. Deshalb steht die Sicherung im Ablauf **vor** dem Update und
nicht daneben.

### Bekannte Grenzen

- **Eine** Anwendungsinstanz. Ein Neustart ist eine kurze Unterbrechung, kein unterbrechungsfreier Wechsel;
  Hochverfuegbarkeit und eine zweite Realtime-Instanz sind ausdruecklich nicht Teil dieses Stands.
- Die Bereitschaftspruefung des Proxy laeuft alle fuenf Sekunden. In diesem Fenster kann eine Anfrage noch
  eine gerade unbereit gewordene Instanz erreichen und einen Fehler bekommen, statt vom Proxy gehalten zu
  werden.
- Das Laufzeitimage traegt die Bibliotheken der SPA mit, obwohl der Serverprozess sie nie laedt (siehe den
  Vermerk im `Dockerfile`).
- Der Metrikendpunkt hat keinen eigenen Zugriffsschutz; seine Grenze ist das interne Netz.
- Die Sicherung ist ein Vollstand. Bei deutlich groesseren Datenmengen als dem Kapazitaetsziel waere ein
  inkrementelles Verfahren noetig.

## Pruefungen

```sh
npm run lint
npm run typecheck
npm run build
npm test              # Unit- und Integrationstests
npm run test:unit     # nur ohne Datenbank
npm audit --audit-level=high
```

Die Integrationstests brauchen eine laufende Datenbank **und ein laufendes SeaweedFS** (`npm run db:up`).
Die Verbindungen lassen sich ueber `CANVAZ_TEST_DATABASE_URL` und `CANVAZ_TEST_S3_ENDPOINT` uebersteuern.

`tests/integration/asset-storage.test.ts` enthaelt die **gemeinsame Contract-Testsuite des Storage-Ports**:
genau eine Suite (`assetStorageContract`), zweimal ausgefuehrt - einmal gegen `filesystem`, einmal gegen
`s3` vor einem echten SeaweedFS, das AWS-Signaturen tatsaechlich prueft (Gegenprobe mit falschem Geheimnis
inklusive). Innerhalb der Suite gibt es keine Fallunterscheidung und keinen Adapternamen; sie kennt
ausschliesslich `AssetStoragePort`. Der Neustart-Nachweis in
`tests/integration/board-assets.test.ts` laeuft ebenfalls fuer beide Adapter: hochladen, den
Anwendungsprozess vollstaendig ersetzen, abrufen, Bytes vergleichen.

`tests/integration/account-mails.test.ts` prueft die zwei Nachrichten der Kontoverwaltung an der echten
Anwendung: die Einladung traegt denselben Link wie die Antwort, eine erneuerte Einladung nicht mehr den
alten, und die Mitteilung ueber eine Ruecksetzung nennt das neue Passwort nicht. Der Test kennt keinen
SMTP-Server - er sammelt am Port der Anwendung, weil dort die Zusage liegt und nicht im Transport.

`tests/integration/realtime.test.ts` faehrt die Echtzeitstrecke ueber **echte WebSocket-Verbindungen**:
Beitritt mit und ohne Berechtigung, Entzug und Archivierung waehrend bestehender Verbindung, manipulierte
Nachrichten, Konfliktfaelle und Checkpoints.

`tests/integration/board-grants.test.ts` prueft die internen Freigaben: die Wirkung jeder Boardrolle an dem,
was der Betroffene danach tatsaechlich noch darf, die Negativfaelle der vier Routen, die Ownerinvariante
gegen die Datenbank sowie Herabstufung und Entzug waehrend einer bestehenden WebSocket-Verbindung.
`tests/unit/board-policy.test.ts` durchlaeuft die Rollenmatrix vollstaendig - jede Kombination aus
Workspace-Rolle, Boardrolle, Workspace- und Boardstatus sowie Nutzerstatus gegen eine von Hand gesetzte
Erwartungstabelle.

`tests/integration/board-share-links.test.ts` prueft die Gastfreigaben auf demselben Weg: anlegen, auflisten,
widerrufen, beitreten, ablaufen; dass das Token weder in der Liste noch in der Datenbank, im Log oder im
Nachweis auftaucht; dass **keine** Antwort an einen Gast eine Workspacekennung, eine interne Nutzerkennung
oder einen internen Anzeigenamen enthaelt - gemessen am Rohkoerper der Antwort und am gesamten
Nachrichtenprotokoll seiner WebSocket-Verbindung; dass ein Gast an keinem fremden Board, keinem Workspace-,
Mitglieder- und keinem Adminendpunkt ankommt; und dass Widerruf wie Ablauf eine **offene** WebSocket-Verbindung beenden und ihren Wiederaufbau
verhindern. `tests/unit/board-guest.test.ts` durchlaeuft dazu die Gasttabelle vollstaendig - beide
Gastrollen gegen jede Aktion sowie jeden Board- und Workspacezustand, einschliesslich des Falls, der einen
Gast ausmacht: ein anderes Board als das seines Links.

`tests/integration/operations.test.ts` prueft die Betriebsendpunkte gegen echte Fehlerlagen statt gegen
Attrappen: eine Datenbank, die nicht antwortet, und ein Assetspeicher, den es nicht gibt, muessen `/api/ready`
auf `503` bringen; der Abbruch einer leerlaufenden Datenbankverbindung wird echt herbeigefuehrt
(`pg_terminate_backend`) und darf den Prozess nicht beenden.

Pruefungen an der echten Oberflaeche laufen nicht als Suite im Repo, sondern manuell mit der
`agent-browser`-CLI.

Die Integrationstests sprechen einen echten OIDC-Provider an: `tests/support/oidc-provider.ts`
signiert ID-Tokens mit RSA und liefert ein echtes JWKS aus. Fehlerlagen (falscher Issuer, falsche Audience,
abgelaufener Token, falsche Nonce, nicht erreichbarer Provider) entstehen dadurch, dass sich dieser Provider
falsch verhaelt. Der Anwendungscode hat keinen Testmodus und keinen Sonderpfad.

## Migrationen

Versionierte SQL-Dateien in `src/persistence/migrations`, angewendete Versionen stehen in
`schema_migrations`. Jede Datei laeuft in einer eigenen Transaktion, ein Advisory Lock verhindert
Parallelanwendung. Anwenden mit `npm run db:migrate`; im Betrieb mit
`docker compose run --rm app node dist/persistence/migrate-cli.js`. Der Anwendungsserver migriert nicht von
selbst - ein Neustart soll nie unbeabsichtigt das Schema aendern.

**Der Rueckweg ist die Sicherung, nicht ein zweites SQL-Skript.** Es gibt bewusst keine `down`-Dateien: eine
Migration, die Daten zusammenfuehrt oder eine Spalte entfernt, laesst sich nicht sinnvoll rueckwaerts
schreiben, und ein Rueckweg, der im Ernstfall nicht traegt, ist schlimmer als keiner. Der belastbare Weg
zurueck ist deshalb der Stand vor dem Update:

```sh
docker/canvaz-ops.sh backup                  # vor jeder Migration
docker compose run --rm app node dist/persistence/migrate-cli.js
# falls das Update zurueckgenommen werden muss:
docker/canvaz-ops.sh restore <archiv>        # Schema und Daten wieder auf dem alten Stand
# CANVAZ_IMAGE auf die alte Version, docker compose up --detach
```

Additive Migrationen - neue Tabellen, neue Spalten mit Standardwert - brauchen ihn nicht: die vorherige
Anwendungsversion laeuft auf dem neuen Schema weiter, und der Rueckweg ist allein das alte Image.
