-- Lokale Anmeldedaten und Einladungen neben der vorhandenen externen Identitaet.
--
-- Das fachliche Profil in `users` bleibt unveraendert die eine Wahrheit: eine lokale Anmeldung und eine
-- externe Identitaet sind zwei Wege auf **dasselbe** Profil und aendern seine Rechte nicht. Deshalb haengen
-- beide Tabellen an `users` und tragen selbst weder Rolle noch Status.
--
-- **Gespeichert wird nie ein Klartext.** Ein Passwort steht ausschliesslich als Hash eines fuer Passwoerter
-- geeigneten Verfahrens (scrypt, siehe `src/server/password.ts`) in `local_credentials.password_hash`; ein
-- Einladungswert ausschliesslich als SHA-256-Hash - dieselbe Bauweise wie beim Sitzungsgeheimnis und beim
-- Freigabetoken eines Boards.

create table local_credentials (
    -- Genau eine Zeile je Nutzer: ein Konto hat ein Passwort oder keines. Der Primaerschluessel ist deshalb
    -- der Nutzer selbst und nicht eine eigene Kennung.
    user_id uuid primary key references users (id) on delete cascade,
    password_hash text not null,
    -- Nach einem Initialpasswort und nach jeder administrativen Ruecksetzung wahr: der Inhaber muss es
    -- wechseln, bevor eine Sitzung entsteht. Der Wechsel setzt das Feld zurueck.
    must_change_password boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- Ein versehentlich im Klartext geschriebenes Passwort passt hier nicht hinein und scheitert an der
    -- Datenbank, statt still zu wirken: das Format ist das des Kodierers in `src/server/password.ts`.
    constraint local_credentials_password_hash_format
        check (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$')
);

comment on table local_credentials is
    'Lokale Anmeldedaten eines Nutzers. Gespeichert wird ausschliesslich der Passworthash, nie das Passwort.';
comment on column local_credentials.must_change_password is
    'Initialpasswort oder Ruecksetzung: die Anmeldung fuehrt zum Wechsel und legt vorher keine Sitzung an.';

-- Einladung eines administrativ angelegten Kontos.
--
-- Sie ist der zweite Weg der Uebergabe: statt eines Initialpassworts bekommt der Empfaenger einen befristeten
-- Link und setzt sein Passwort selbst. Genau einmal einloesbar (`redeemed_at`), jederzeit widerrufbar
-- (`revoked_at`) und in jedem Fall befristet (`expires_at`).
create table user_invitations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users (id) on delete cascade,
    token_hash text not null,
    -- Der Einladende ueberlebt seine eigene Loeschung nicht als Fremdschluessel, der Nachweis aber schon.
    created_by_user_id uuid references users (id) on delete set null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    redeemed_at timestamptz,
    revoked_at timestamptz,
    constraint user_invitations_token_hash_unique unique (token_hash),
    -- SHA-256 in Hex: 64 Zeichen, klein geschrieben - wie bei Sitzungs- und Freigabetokens.
    constraint user_invitations_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
    constraint user_invitations_expires_after_creation check (expires_at > created_at)
);

create index user_invitations_user_idx on user_invitations (user_id, created_at desc);

comment on table user_invitations is
    'Befristete, genau einmal einloesbare Einladung. Gespeichert wird nur der Hash, nie der Einladungswert.';
comment on column user_invitations.redeemed_at is
    'Einmalverwendung: gesetzt wird sie in derselben Transaktion, die das Passwort schreibt.';
