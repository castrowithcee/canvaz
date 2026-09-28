-- Anmeldeversuche je Zielkonto.
--
-- Die Ratengrenze je Client haelt ein verteiltes Durchprobieren nicht auf: viele Adressen teilen sich kein
-- Budget. Diese Tabelle zaehlt deshalb zusaetzlich je **eingegebener** Adresse, gleich von wo die Versuche
-- kommen - und ob es das Konto gibt: eine unbekannte Adresse wird genauso gezaehlt wie eine bekannte, sonst
-- verriete die Drosselung, welche Adressen existieren. Der Zustand liegt in der Datenbank, damit ein Neustart
-- der Anwendung ihn nicht zuruecksetzt.
--
-- **Keine Adresse im Klartext.** `key_hash` ist ein HMAC-SHA-256 der normalisierten Adresse mit dem
-- Sitzungsgeheimnis als Schluessel (`src/server/login-throttle.ts`); ohne das Geheimnis laesst sich aus der
-- Zeile nicht einmal pruefen, ob eine vermutete Adresse versucht wurde.
--
-- Ein festes Fenster ab dem ersten Versuch: wer das Budget erschoepft, wartet bis zu dessen Ende, und weitere
-- Versuche verlaengern es nicht. Eine dauerhafte Sperre, die jeder Fremde ausloesen koennte, gibt es nicht.
-- Abgelaufene Zeilen raeumt der naechste Versuch weg.

create table login_throttle (
    key_hash text primary key,
    attempts integer not null,
    window_started_at timestamptz not null,
    -- HMAC-SHA-256 in Hex: 64 Zeichen, klein geschrieben - wie die uebrigen Hashes des Schemas.
    constraint login_throttle_key_hash_format check (key_hash ~ '^[0-9a-f]{64}$'),
    constraint login_throttle_attempts_positive check (attempts > 0)
);

create index login_throttle_window_idx on login_throttle (window_started_at);

comment on table login_throttle is
    'Anmeldeversuche je Zielkonto im laufenden Fenster. Gespeichert wird nur ein HMAC der Adresse, nie die Adresse.';
