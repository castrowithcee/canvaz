-- Zweiter Faktor des Systemadmins: TOTP-Geheimnis, Ersatzcodes und der Nachweis an der Sitzung.
--
-- **Kein Geheimnis im Klartext.** Das TOTP-Geheimnis liegt ausschliesslich mit AES-256-GCM versiegelt vor
-- (`src/server/second-factor.ts`); der Schluessel steht in `CANVAZ_MFA_ENCRYPTION_KEY` und nie in der
-- Datenbank. Ein Ersatzcode liegt ausschliesslich als HMAC-SHA-256 mit einem daraus abgeleiteten Schluessel
-- vor. Ein Leseleck der Datenbank ergibt damit weder einen gueltigen Code noch einen, den man offline raten
-- koennte.

-- Wann die Sitzung den zweiten Faktor belegt hat. Bestehende Sitzungen haben ihn nicht: eine
-- Systemadminsitzung von vor dieser Migration ist danach eingeschraenkt und fuehrt zu Einrichtung oder Abfrage.
alter table sessions add column second_factor_verified_at timestamptz;

comment on column sessions.second_factor_verified_at is
    'Zeitpunkt des belegten zweiten Faktors; null heisst: nicht belegt. Nur bei Faktorpflicht (Systemadmin) von Bedeutung.';

-- Genau eine Zeile je Konto: das aktive Geheimnis und daneben hoechstens eine angefangene Einrichtung. Die
-- angefangene wird erst mit einem gueltigen Code aktiv; bis dahin gilt das bisherige Geheimnis oder keines.
create table user_totp_factors (
    user_id uuid primary key references users (id) on delete cascade,
    secret_sealed text,
    confirmed_at timestamptz,
    -- Zeitschritt (30 Sekunden seit der Epoche) des zuletzt angenommenen Codes: Schutz gegen Wiederholung.
    last_used_step bigint,
    pending_sealed text,
    pending_created_at timestamptz,
    updated_at timestamptz not null default now(),
    -- Versiegelt heisst `v1.<iv>.<chiffrat>.<tag>`, jeweils base64url. Ein versehentlich im Klartext
    -- geschriebenes Base32-Geheimnis passt hier nicht hinein und scheitert an der Datenbank.
    constraint user_totp_factors_secret_sealed
        check (secret_sealed is null or secret_sealed ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
    constraint user_totp_factors_pending_sealed
        check (pending_sealed is null or pending_sealed ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
    constraint user_totp_factors_active_complete check ((secret_sealed is null) = (confirmed_at is null)),
    constraint user_totp_factors_pending_complete check ((pending_sealed is null) = (pending_created_at is null))
);

comment on table user_totp_factors is
    'TOTP-Faktor je Konto. Geheimnisse nur AES-256-GCM-versiegelt; der Schluessel liegt ausserhalb der Datenbank.';

-- Einmalige Ersatzcodes. Jede Ausgabe ersetzt alle bisherigen Zeilen des Kontos; eingeloest wird ein Code
-- durch `used_at`, und zwar bedingt auf `used_at is null` - gleichzeitig eingeloest gewinnt genau einer.
create table user_backup_codes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users (id) on delete cascade,
    code_hash text not null,
    created_at timestamptz not null default now(),
    used_at timestamptz,
    constraint user_backup_codes_unique unique (user_id, code_hash),
    -- HMAC-SHA-256 in Hex, wie die uebrigen Hashes des Schemas.
    constraint user_backup_codes_hash_format check (code_hash ~ '^[0-9a-f]{64}$')
);

comment on table user_backup_codes is
    'Einmalige Ersatzcodes des zweiten Faktors. Gespeichert wird nur ein HMAC, nie der Code.';
