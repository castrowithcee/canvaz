-- Selbstwiederherstellung eines lokalen Passworts ueber eine bestaetigte Wiederherstellungsadresse.
--
-- Zwei getrennte Merkmale je Konto: ob der Systemadmin den Weg **freigeschaltet** hat (`allowed`, Standard
-- aus) und welche Adresse der Inhaber **nachweislich** besitzt (`email` mit `verified_at`). Die Adresse ist
-- bewusst keine Spalte von `users`: sie ist weder Anmeldename noch Zuordnung einer externen Identitaet, und
-- eine Aenderung des Anmeldenamens verschiebt sie nicht still auf eine andere Adresse.
--
-- Die Werte der Links liegen in einer eigenen Tabelle statt als weiterer Zweck in `user_invitations`: eine
-- Einladung meldet beim Einloesen an und erscheint in der Systemadministration als offener Zugang; beides
-- darf ein Bestaetigungs- oder Ruecksetzungslink nie. Gespeichert wird wie dort nur der SHA-256-Hash.

create table user_self_recovery (
    user_id uuid primary key references users (id) on delete cascade,
    allowed boolean not null default false,
    email text,
    verified_at timestamptz,
    updated_at timestamptz not null default now(),
    -- Dieselbe Normalisierung wie `users.email`.
    constraint user_self_recovery_email_normalized check (
        email is null or (email = lower(btrim(email)) and position('@' in email) > 1)
    ),
    -- Eine Adresse steht hier erst, wenn sie bestaetigt ist; eine offene Bestaetigung liegt als Link vor.
    constraint user_self_recovery_verified_complete check ((email is null) = (verified_at is null))
);

comment on table user_self_recovery is
    'Freischaltung der Selbstwiederherstellung durch den Systemadmin und die bestaetigte Wiederherstellungsadresse.';

create table recovery_email_tokens (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users (id) on delete cascade,
    -- confirm: Besitznachweis einer neuen Adresse. reset: Ruecksetzung des Passworts.
    purpose text not null,
    -- Die Adresse, an die der Link ging: bei `confirm` die zu bestaetigende, bei `reset` die bestaetigte.
    email text not null,
    token_hash text not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    redeemed_at timestamptz,
    revoked_at timestamptz,
    constraint recovery_email_tokens_purpose_valid check (purpose in ('confirm', 'reset')),
    constraint recovery_email_tokens_token_hash_unique unique (token_hash),
    constraint recovery_email_tokens_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
    constraint recovery_email_tokens_expires_after_creation check (expires_at > created_at)
);

create index recovery_email_tokens_open_idx on recovery_email_tokens (user_id, purpose)
    where redeemed_at is null and revoked_at is null;

comment on table recovery_email_tokens is
    'Bestaetigungs- und Ruecksetzungslinks der Selbstwiederherstellung. Gespeichert wird nur der Hash, nie der Wert.';
