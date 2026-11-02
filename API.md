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
- Freigabeaenderungen und Widerrufe durch den Systemadmin werden nachgewiesen.

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
