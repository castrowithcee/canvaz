-- Workspaces, Mitgliedschaften und Auditereignisse.
--
-- Der Workspace ist die aeussere Datengrenze: jeder fachliche Datensatz spaeterer Pakete traegt seinen
-- Workspacebezug, und auch das Auditereignis haengt an genau einem Workspace.

create table workspaces (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    status text not null default 'active',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint workspaces_name_not_blank check (length(btrim(name)) > 0),
    constraint workspaces_name_length check (length(name) <= 80),
    constraint workspaces_status_valid check (status in ('active', 'archived'))
);

comment on table workspaces is
    'Aeussere Datengrenze der Instanz. Die Kennung ist die UUID; einen zusaetzlichen Slug gibt es bewusst nicht.';
comment on column workspaces.name is
    'Bewusst nicht instanzweit eindeutig: eine Eindeutigkeitsverletzung wuerde fremde Workspaces verraten.';
comment on column workspaces.status is 'archiviert heisst lesbar, aber unveraenderlich; nur das Entarchivieren bleibt moeglich.';

create table workspace_memberships (
    workspace_id uuid not null references workspaces (id) on delete cascade,
    user_id uuid not null references users (id) on delete cascade,
    role text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- Eindeutig je Paar aus Workspace und Nutzer: der zusammengesetzte Primaerschluessel ist die
    -- Eindeutigkeit. Eine zusaetzliche Ersatzkennung gaebe es nur, um sie nirgends zu verwenden.
    constraint workspace_memberships_pkey primary key (workspace_id, user_id),
    constraint workspace_memberships_role_valid check (role in ('owner', 'admin', 'member'))
);

-- Beide Fremdschluessel raeumen bewusst auf: eine Mitgliedschaft ohne Workspace oder ohne Nutzer waere eine
-- verwaiste Berechtigung. Nutzer werden im Betrieb deaktiviert statt geloescht; die Deaktivierung entzieht
-- den Zugriff bereits ueber `authenticate()` und die Policy, unabhaengig von der Mitgliedschaft.
create index workspace_memberships_user_id_idx on workspace_memberships (user_id);

comment on table workspace_memberships is 'Rolle eines Nutzers in einem Workspace. Genau eine Rolle je Paar.';

create table audit_events (
    id uuid primary key default gen_random_uuid(),
    -- clock_timestamp() statt now(): innerhalb einer Transaktion ist now() konstant, und mehrere Ereignisse
    -- derselben Aenderung waeren nicht mehr in ihrer Reihenfolge lesbar.
    occurred_at timestamptz not null default clock_timestamp(),
    actor_user_id uuid references users (id) on delete set null,
    action text not null,
    target_type text not null,
    target_id uuid not null,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    details jsonb not null default '{}'::jsonb,
    constraint audit_events_action_not_blank check (length(btrim(action)) > 0),
    constraint audit_events_target_type_valid check (target_type in ('workspace', 'membership')),
    constraint audit_events_details_is_object check (jsonb_typeof(details) = 'object')
);

-- Der Akteur wird beim Loeschen eines Nutzers auf null gesetzt statt mitgeloescht: die Historie einer
-- Rollenaenderung soll den Nutzer ueberleben. `target_id` traegt bewusst keinen Fremdschluessel - das Ziel
-- einer entfernten Mitgliedschaft existiert nach dem Ereignis nicht mehr, genau darum geht es.
create index audit_events_workspace_idx on audit_events (workspace_id, occurred_at desc);
create index audit_events_actor_idx on audit_events (actor_user_id);

comment on table audit_events is
    'Nachweis von Rollen- und Mitgliedschaftsaenderungen. Enthaelt nie Tokenmaterial und nie Boardinhalte.';
comment on column audit_events.details is 'Strukturierte Metadaten der Aenderung, etwa vorherige und neue Rolle.';
