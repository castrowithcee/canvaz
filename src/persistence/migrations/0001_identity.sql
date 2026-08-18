-- Identitaetsschema: lokales Benutzerprofil, externe Anmeldungen, serverseitige Sessions.
-- Workspaces, Mitgliedschaften und Boards folgen in eigenen Migrationen.

create table users (
    id uuid primary key default gen_random_uuid(),
    display_name text not null,
    email text,
    status text not null default 'active',
    is_system_admin boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint users_display_name_not_blank check (length(btrim(display_name)) > 0),
    constraint users_status_valid check (status in ('active', 'deactivated')),
    -- Adressen werden normalisiert gespeichert, damit der eindeutige Index nicht durch Gross-/Kleinschreibung umgangen wird.
    constraint users_email_normalized check (
        email is null or (email = lower(btrim(email)) and position('@' in email) > 1)
    )
);

create unique index users_email_unique on users (email) where email is not null;

comment on table users is 'Fachliches Benutzerprofil. Unabhaengig von der externen Anmeldung.';
comment on column users.is_system_admin is 'Einzige Rolle dieses Pakets; weitere Rollen haengen spaeter an Workspaces.';

create table external_identities (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users (id) on delete cascade,
    issuer text not null,
    subject text not null,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    constraint external_identities_issuer_not_blank check (length(btrim(issuer)) > 0),
    constraint external_identities_subject_not_blank check (length(btrim(subject)) > 0),
    constraint external_identities_issuer_subject_unique unique (issuer, subject)
);

create index external_identities_user_id_idx on external_identities (user_id);

comment on table external_identities is
    'Zuordnung externer OIDC-Anmeldungen zu Nutzern. Speichert bewusst keine Access-, ID- oder Refresh-Tokens.';

create table sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users (id) on delete cascade,
    token_hash text not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    revoked_at timestamptz,
    constraint sessions_token_hash_unique unique (token_hash),
    constraint sessions_expires_after_creation check (expires_at > created_at)
);

create index sessions_user_id_idx on sessions (user_id);
create index sessions_expires_at_idx on sessions (expires_at);

comment on table sessions is
    'Serverseitige, widerrufbare Sessions. Gespeichert wird nur der Hash des Session-Geheimnisses.';
