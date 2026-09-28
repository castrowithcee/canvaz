-- Wiederherstellung des Systemadminzugangs per Betreiberbefehl.
--
-- Ein Wiederherstellungswert ist technisch dasselbe wie eine Einladung: befristet, genau einmal einloesbar,
-- widerrufbar und nur als SHA-256-Hash gespeichert. Er bekommt deshalb keine eigene Tabelle, sondern einen
-- Zweck an derselben Zeile. So widerruft jede neue Einladung und jede Deaktivierung auch einen offenen
-- Wiederherstellungswert, und das Einloesen bleibt ein einziger, gepruefter Weg.
--
-- Der Zweck ist zugleich der Nachweis des Vorfalls: eine Zeile mit `purpose = 'recovery'` belegt Zeitpunkt,
-- Konto, Frist und Einloesung - ohne jedes Geheimnis. Bestehende Zeilen sind Einladungen.

alter table user_invitations
    add column purpose text not null default 'invitation',
    add constraint user_invitations_purpose_valid check (purpose in ('invitation', 'recovery'));

comment on column user_invitations.purpose is
    'invitation: Uebergabe eines Kontos (72 Stunden). recovery: Wiederherstellung per Betreiberbefehl (kurz befristet).';
