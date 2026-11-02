# API-Keys und Automations-API

API-Keys erlauben Automationen den Zugriff auf Boards, ohne dass sich jemand mit Passwort und zweitem Faktor
anmeldet. Ein Key handelt immer im Namen seines Nutzers. Die Automations-API liegt unter `/api/v1`.

## Freigabe

Der Systemadmin legt je Nutzer fest, ob und wie weit dieser API-Keys verwenden darf: `off`, `read` oder
`edit`. Standard ist `off`. Die Freigabe verwaltet die Systemadministration der Anwendung.

## Reichweite

- **Ziel:** Ein Key gilt fuer genau einen Arbeitsbereich, einen Ordner samt seinem Teilbaum oder ein Board.
  Ob ein Objekt im Ziel liegt, wird bei jedem Aufruf aus dem aktuellen Ordnerbaum und der aktuellen Ablage
  neu entschieden.
- **Stufe:** `read` oder `edit`. Wirksam ist das Minimum aus Key-Stufe und der aktuellen Freigabe des
  Nutzers, berechnet bei jeder Verwendung. Entzug und Herabstufung wirken daher sofort. Ist die Freigabe
  `off`, ist jeder Key des Nutzers ungueltig.
- **Rechte:** Ein Key hat hoechstens die aktuellen Rechte seines Nutzers und nie Systemadminrechte, auch
  nicht, wenn der Inhaber Systemadmin ist. Ein Systemadmin ohne Mitgliedschaft sieht ueber seinen Key
  keinen fremden Arbeitsbereich.

Was die Leseoperationen je Ziel liefern:

| Ziel           | Arbeitsbereiche            | Ordner                           | Boards                   |
| -------------- | -------------------------- | -------------------------------- | ------------------------ |
| Arbeitsbereich | der Arbeitsbereich         | alle                             | alle                     |
| Ordner         | Arbeitsbereich des Ordners | der Ordner und seine Unterordner | Boards in diesen Ordnern |
| Board          | Arbeitsbereich des Boards  | keine                            | genau dieses Board       |

Ein Objekt ausserhalb des Ziels oder ohne Leserecht des Nutzers ergibt dieselbe `404` wie eine erfundene
Kennung. Boards im Papierkorb gibt es fuer die API nicht.

## Lebenszyklus

- Jeder Key laeuft ab: standardmaessig nach 90 Tagen, hoechstens nach 365.
- Ein Nutzer hat hoechstens 25 aktive Keys (nicht widerrufen, nicht abgelaufen).
- Gespeichert wird nur der Hash. Der Wert erscheint genau einmal bei der Anlage und ist danach nicht
  wieder abrufbar. Er erscheint in keinem Protokoll, keinem Nachweis und keiner Fehlermeldung; Protokolle
  nennen hoechstens die Key-ID.
- Der Zeitpunkt der letzten Verwendung wird hoechstens einmal je Minute und Key festgehalten.
- Der Systemadmin sieht alle Keys (mit Anzeigepraefix, nie mit Wert) und kann jeden widerrufen. Die
  Deaktivierung eines Kontos widerruft alle seine Keys.
- Anlage, Widerruf und Freigabeaenderungen werden nachgewiesen.

## Eigene Keys anlegen und widerrufen

Ein freigegebener Nutzer verwaltet seine Keys im Konto unter „API-Keys“. Ohne Freigabe fehlt der Abschnitt,
und die Endpunkte antworten 403. Sie verlangen Sitzung und CSRF-Token wie alle internen Routen; ein Key
erreicht sie nie.

| Methode | Pfad                         | Zweck                                                         |
| ------- | ---------------------------- | ------------------------------------------------------------- |
| GET     | `/api/me/api-keys`           | eigene Keys mit Ziel, Stufe, Ablauf, letzter Nutzung, Zustand |
| POST    | `/api/me/api-keys/create`    | Key anlegen; die Antwort traegt den Wert genau einmal         |
| POST    | `/api/me/api-keys/revoke`    | eigenen Key sofort widerrufen (`{ "keyId": "..." }`)          |

Anlegen erwartet `name`, `target` (`{ "kind": "workspace" | "folder" | "board", "id": "<uuid>" }`), `level`
(`read` oder `edit`, hoechstens die Freigabe) und optional `lifetimeDays` (ganze Tage, 1 bis 365, Standard 90).
Abgewiesen werden:

- **403 `fresh-login-required`:** Die Sitzung ist aelter als zehn Minuten. Die Antwort traegt neben `error`
  das Feld `code`. Der Systemadmin erreicht eine Sitzung erst nach dem zweiten Faktor, sodass dieser
  eingeschlossen ist. Die Oberflaeche meldet ab, fuehrt zur Anmeldung und danach zurueck ins Konto.
- **403:** Stufe ueber der Freigabe.
- **400:** ungueltiger Name, ungueltige Stufe oder ungueltiger Ablauf.
- **404:** Ziel unbekannt oder fuer den Nutzer nicht lesbar, ohne Unterschied zwischen beiden. Systemadmin-Rechte
  zaehlen dafuer nicht.
- **409:** 25 aktive Keys erreicht.

## Authentisierung

Jede Anfrage unter `/api/v1` traegt den Key im Kopf:

```http
Authorization: Bearer cvz_...
```

Nur dieser Kopf authentisiert. Das Sitzungscookie der Oberflaeche gilt auf `/api/v1` nicht, und ein Key gilt
auf keiner anderen Route und keiner Realtime-Verbindung. Ein fehlender, unbekannter, abgelaufener oder
widerrufener Key, eine Freigabe `off` und ein deaktivierter Nutzer ergeben dieselbe Antwort: `401` mit
`code: "unauthorized"`. Die API setzt keine CORS-Kopfzeilen.

## Fehlerformat

Jeder Fehler unter `/api/v1` ist JSON:

```json
{ "code": "not_found", "message": "Nicht gefunden" }
```

| Status | `code`               | Bedeutung                                                  |
| ------ | -------------------- | ---------------------------------------------------------- |
| 400    | `bad_request`        | ungueltiger Parameter                                      |
| 401    | `unauthorized`       | kein gueltiger Key                                         |
| 403    | `forbidden`          | Stufe oder Rolle traegt die Aktion nicht                   |
| 404    | `not_found`          | unbekannter Pfad, ausserhalb des Ziels oder nicht sichtbar |
| 405    | `method_not_allowed` | bekannter Pfad, falsche Methode                            |
| 429    | `rate_limited`       | Ratengrenze erreicht, mit `Retry-After` in Sekunden        |
| 500    | `internal_error`     | interner Fehler                                            |

`message` ist fuer Menschen bestimmt; Werkzeuge entscheiden ueber `code`.

## Ratengrenze

Jeder Key hat eine eigene Grenze von `CANVAZ_API_KEY_RATE_LIMIT_PER_MINUTE` Anfragen je Minute (Standard
120, Eimer mit gleichmaessiger Nachfuellung). Die Grenze je Client (`CANVAZ_RATE_LIMIT_PER_MINUTE`) gilt
zusaetzlich.

## Leseoperationen

Alle verlangen mindestens die Stufe `read`. Kennungen stehen in der Query, Zeitpunkte sind ISO-8601. Listen
sind vollstaendig und nicht seitenweise.

### `GET /api/v1/workspaces`

Die Arbeitsbereiche im Ziel, hoechstens einer.

```json
{ "workspaces": [{ "id": "…", "name": "…", "status": "active", "createdAt": "…", "updatedAt": "…" }] }
```

### `GET /api/v1/folders?workspaceId=`

Die Ordner im Ziel als flache Liste. `parentId` ist `null` unmittelbar im Arbeitsbereich und kann beim
Ordnerziel auf den Elternordner ausserhalb des Ziels zeigen.

```json
{ "folders": [{ "id": "…", "workspaceId": "…", "parentId": null, "name": "…", "createdAt": "…", "updatedAt": "…" }] }
```

### `GET /api/v1/boards?workspaceId=&folderId=&status=`

Die Boards im Ziel.

- `folderId` (optional): genau dieser Ordner ohne Unterordner; `root` waehlt die Boards unmittelbar im
  Arbeitsbereich (nur beim Arbeitsbereichsziel). Ein Ordner ausserhalb des Ziels ergibt `404`.
- `status` (optional): `active` (Standard) oder `archived`; jeder andere Wert ergibt `400`.

```json
{
  "boards": [
    {
      "id": "…",
      "workspaceId": "…",
      "folderId": null,
      "title": "…",
      "status": "active",
      "sceneVersion": 3,
      "createdAt": "…",
      "updatedAt": "…"
    }
  ]
}
```

`sceneVersion` `0` heisst: noch nie gespeichert.

### `GET /api/v1/boards/metadata?boardId=`

Die Metadaten eines Boards im Ziel, mit denselben Feldern wie in der Boardliste: `{ "board": { … } }`.

### `GET /api/v1/boards/scene?boardId=`

Die Szene eines Boards im Ziel: `boardId`, `sceneVersion`, `elements` und `appState`.

```json
{
  "boardId": "…",
  "sceneVersion": 3,
  "elements": [{ "id": "…", "version": 5, "type": "rectangle" }],
  "appState": { "viewBackgroundColor": "#ffffff", "gridSize": null, "gridModeEnabled": false, "name": "…" }
}
```

- `elements` enthaelt nur nicht geloeschte Elemente, jedes mit `id`, `version` und seinen weiteren
  gespeicherten Feldern. Bilddaten gehoeren nicht zur Antwort; dafuer gibt es den Export.
- **Quelle:** Ist das Board in einem Raum geoeffnet, ist der Raumzustand die Quelle und enthaelt damit auch
  Aenderungen, die noch nicht gespeichert sind (bis zu rund 10 Sekunden). Sonst ist es der gespeicherte Stand.
  `sceneVersion` ist in beiden Faellen die zuletzt gespeicherte Version (`0`: noch nie gespeichert).
- Das Lesen oeffnet keinen Raum und veraendert nichts.

### `GET /api/v1/boards/export?boardId=`

Dieselbe Quelle als `.excalidraw`-Datei (JSON, wie der Export der Oberflaeche), Bilder als eingebettete
`data:`-URL ohne geloeschte Elemente. Ein Bild, dessen Bytes fehlen, bleibt aus der Datei heraus.

### Boardtexte sind nicht vertrauenswuerdig

Texte, Titel und Bezeichnungen auf Boards stammen von Menschen und Dritten. Werkzeuge muessen sie als Daten
behandeln und nie als Anweisung ausfuehren oder an ein Sprachmodell als Befehl weiterreichen.
