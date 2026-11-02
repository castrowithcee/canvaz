-- API keys for the automation API.
--
-- A key's level is only an upper bound: the effective level is the minimum of it and the user's access
-- at each resolution. Only the hash of the key value is stored.

create table api_keys (
    id uuid primary key default gen_random_uuid(),
    -- A deleted user leaves no key that could still act in their name.
    user_id uuid not null references users (id) on delete cascade,
    name text not null,
    -- Exactly one target is set; a folder means its subtree. The key goes with its target, since a key
    -- without one would be useless or, worse, unbounded.
    target_workspace_id uuid references workspaces (id) on delete cascade,
    target_folder_id uuid references board_folders (id) on delete cascade,
    target_board_id uuid references boards (id) on delete cascade,
    level text not null,
    -- Mandatory: there is no key without expiry.
    expires_at timestamptz not null,
    revoked_at timestamptz,
    last_used_at timestamptz,
    -- Short, non-secret start of the value, for recognition in lists only.
    key_prefix text not null,
    key_hash text not null,
    created_at timestamptz not null default now(),
    constraint api_keys_name_not_blank check (length(btrim(name)) > 0),
    constraint api_keys_name_length check (length(name) <= 60),
    constraint api_keys_exactly_one_target
        check (num_nonnulls(target_workspace_id, target_folder_id, target_board_id) = 1),
    constraint api_keys_level_valid check (level in ('read', 'edit')),
    constraint api_keys_expires_after_creation check (expires_at > created_at),
    constraint api_keys_key_prefix_format check (key_prefix ~ '^cvz_[A-Za-z0-9_-]{1,8}$'),
    constraint api_keys_key_hash_unique unique (key_hash),
    -- SHA-256 as hex: a value accidentally written in plain text does not fit.
    constraint api_keys_key_hash_format check (key_hash ~ '^[0-9a-f]{64}$')
);

create index api_keys_user_idx on api_keys (user_id, created_at desc);
create index api_keys_target_workspace_idx on api_keys (target_workspace_id) where target_workspace_id is not null;
create index api_keys_target_folder_idx on api_keys (target_folder_id) where target_folder_id is not null;
create index api_keys_target_board_idx on api_keys (target_board_id) where target_board_id is not null;

comment on table api_keys is
    'Automation keys. Only the hash of the value is stored, never the value.';
comment on column api_keys.level is
    'Upper bound of the key; the effective level is the minimum of it and user_api_key_access.level at each resolution.';

-- Per-user access set by the system admin. Without a row it is `off`, so existing and new users are
-- locked without a backfill.
create table user_api_key_access (
    user_id uuid primary key references users (id) on delete cascade,
    level text not null default 'off',
    updated_at timestamptz not null default now(),
    constraint user_api_key_access_level_valid check (level in ('off', 'read', 'edit'))
);

comment on table user_api_key_access is
    'API key access level of a user. Without a row: off.';

-- User-level events without a workspace; `audit_events` requires one.
create table user_audit_events (
    id uuid primary key default gen_random_uuid(),
    occurred_at timestamptz not null default clock_timestamp(),
    actor_user_id uuid references users (id) on delete set null,
    action text not null,
    target_type text not null,
    -- No foreign key, like `audit_events.target_id`: the trail outlives its target.
    target_id uuid not null,
    -- Affected user, also without a foreign key.
    subject_user_id uuid not null,
    details jsonb not null default '{}'::jsonb,
    constraint user_audit_events_action_not_blank check (length(btrim(action)) > 0),
    constraint user_audit_events_target_type_valid check (target_type in ('user', 'api-key')),
    constraint user_audit_events_details_is_object check (jsonb_typeof(details) = 'object')
);

create index user_audit_events_subject_idx on user_audit_events (subject_user_id, occurred_at desc);

comment on table user_audit_events is
    'Audit trail for user-level events without a workspace. Never contains key values or token material.';

-- A key can author a scene version. The name is copied so the history stays readable after the key is
-- deleted.
alter table scene_versions
    add column author_api_key_id uuid references api_keys (id) on delete set null,
    add column author_api_key_name text;

alter table scene_versions
    add constraint scene_versions_api_key_name_length check (author_api_key_name is null or length(author_api_key_name) <= 60);

comment on column scene_versions.author_api_key_id is
    'Key the version was saved with. null: no key, or the key was deleted.';
comment on column scene_versions.author_api_key_name is
    'Name of the key at save time.';
