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
- Freigabeaenderungen und Widerrufe durch den Systemadmin werden nachgewiesen.
