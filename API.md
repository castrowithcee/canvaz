# API-Keys

API-Keys erlauben Automationen den Zugriff auf Boards, ohne dass sich jemand mit Passwort und zweitem Faktor
anmeldet. Ein Key handelt immer im Namen seines Nutzers.

## Freigabe

Der Systemadmin legt je Nutzer fest, ob und wie weit dieser API-Keys verwenden darf: `off`, `read` oder
`edit`. Standard ist `off`. Die Freigabe verwaltet die Systemadministration der Anwendung.

## Reichweite

- **Ziel:** Ein Key gilt fuer genau einen Arbeitsbereich, einen Ordner samt seinem Teilbaum oder ein Board.
- **Stufe:** `read` oder `edit`. Wirksam ist das Minimum aus Key-Stufe und der aktuellen Freigabe des
  Nutzers, berechnet bei jeder Verwendung. Entzug und Herabstufung wirken daher sofort. Ist die Freigabe
  `off`, ist jeder Key des Nutzers ungueltig.
- **Rechte:** Ein Key hat hoechstens die aktuellen Rechte seines Nutzers und nie Systemadminrechte, auch
  nicht, wenn der Inhaber Systemadmin ist.

## Lebenszyklus

- Jeder Key laeuft ab: standardmaessig nach 90 Tagen, hoechstens nach 365.
- Ein Nutzer hat hoechstens 25 aktive Keys (nicht widerrufen, nicht abgelaufen).
- Gespeichert wird nur der Hash. Der Wert erscheint genau einmal bei der Anlage und ist danach nicht
  wieder abrufbar. Er erscheint in keinem Protokoll und keinem Nachweis.
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
