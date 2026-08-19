-- Oeffentliche Gastfreigaben eines Boards.
--
-- Ein Freigabelink oeffnet genau ein Board fuer Externe ohne Konto dieser Instanz. Er ist damit die einzige
-- Stelle, an der Boardinhalt ohne Workspace-Mitgliedschaft erreichbar wird, und deshalb eng geschnitten:
-- genau ein Board, genau eine Gastrolle, optionaler Ablauf, jederzeitiger Widerruf.
--
-- **Gespeichert wird ausschliesslich der Hash des Tokens** - dieselbe Bauweise wie beim Sitzungsgeheimnis
-- in `sessions.token_hash`. Ein Leseleck der Datenbank oeffnet damit kein Board. Das Token selbst existiert
-- nur im Speicher des Servers, waehrend die Anlageantwort entsteht, und danach nur noch beim Empfaenger.

create table board_share_links (
    id uuid primary key default gen_random_uuid(),
    board_id uuid not null,
    -- Redundant zum Board und genau deshalb abgesichert: der zusammengesetzte Fremdschluessel unten
    -- erzwingt, dass es derselbe Workspace ist. Ein Link kann damit nie an der Workspacegrenze vorbei
    -- entstehen - dasselbe Muster wie bei Freigaben und Assets.
    workspace_id uuid not null,
    token_hash text not null,
    role text not null,
    -- Der Erzeuger ueberlebt seine eigene Loeschung nicht als Fremdschluessel, der Link aber schon: er
    -- gehoert dem Board, nicht der Person. `set null` statt `cascade`, damit ein Widerruf eine bewusste
    -- Handlung bleibt und nicht als Nebenwirkung geschieht.
    created_by_user_id uuid references users (id) on delete set null,
    created_at timestamptz not null default now(),
    -- null heisst: laeuft nicht von selbst ab. Er endet dann ausschliesslich durch Widerruf.
    expires_at timestamptz,
    revoked_at timestamptz,
    -- Zwei Links duerfen nie dasselbe Geheimnis meinen; der eindeutige Index ist zugleich der Zugriffspfad
    -- der Aufloesung.
    constraint board_share_links_token_hash_unique unique (token_hash),
    -- SHA-256 in Hex: 64 Zeichen, klein geschrieben. Ein versehentlich im Klartext geschriebenes Token
    -- passt hier nicht hinein und scheitert an der Datenbank statt still zu wirken.
    constraint board_share_links_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
    constraint board_share_links_role_valid check (role in ('guest-viewer', 'guest-editor')),
    constraint board_share_links_expires_after_creation check (expires_at is null or expires_at > created_at),
    constraint board_share_links_workspace_matches_board
        foreign key (board_id, workspace_id) references boards (id, workspace_id) on delete cascade,
    -- Ziel des zusammengesetzten Fremdschluessels der Gastsession: er macht deren doppelt gefuehrten
    -- Boardbezug nachweislich konsistent statt nur redundant.
    constraint board_share_links_id_board_unique unique (id, board_id)
);

create index board_share_links_board_idx on board_share_links (board_id, created_at desc);
create index board_share_links_workspace_idx on board_share_links (workspace_id);

comment on table board_share_links is
    'Oeffentlicher Zugang zu genau einem Board. Gespeichert wird nur der Hash des Tokens, nie das Token.';
comment on column board_share_links.role is
    'Gastrollen sind eigene Werte und keine Boardrollen: ein Gast erhaelt nie eine interne Stufe.';
comment on column board_share_links.revoked_at is
    'Widerruf wirkt sofort auf neue und bestehende Gastsessions; die Aufloesung prueft ihn bei jedem Zugriff.';

-- Kurzlebige Sitzung eines Gastes, gueltig fuer genau ein Board.
--
-- Sie ist die serverseitige Entsprechung der internen `sessions`: eigenes Geheimnis im Cookie, nur der Hash
-- in der Datenbank, jederzeit widerrufbar. Der Unterschied ist ihr Umfang - sie traegt kein Nutzerprofil,
-- sondern nur einen selbst gewaehlten Anzeigenamen und die Bindung an ein einziges Board.
create table board_guest_sessions (
    id uuid primary key default gen_random_uuid(),
    share_link_id uuid not null,
    -- Redundant zum Link und genau deshalb abgesichert: der zusammengesetzte Fremdschluessel unten erzwingt,
    -- dass es dasselbe Board ist. Eine Gastsession fuer ein anderes Board als das ihres Links ist damit
    -- strukturell unmoeglich und nicht nur durch Anwendungslogik ausgeschlossen.
    board_id uuid not null,
    token_hash text not null,
    display_name text not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    revoked_at timestamptz,
    constraint board_guest_sessions_token_hash_unique unique (token_hash),
    constraint board_guest_sessions_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
    constraint board_guest_sessions_display_name_not_blank check (length(btrim(display_name)) > 0),
    constraint board_guest_sessions_display_name_length check (length(display_name) <= 60),
    constraint board_guest_sessions_expires_after_creation check (expires_at > created_at),
    -- `cascade`: ein geloeschter Link laesst keine Gastsession zurueck, die auf ihn zeigt. Der regulaere Weg
    -- ist trotzdem der Widerruf - er erhaelt den Nachweis, das Loeschen nicht.
    constraint board_guest_sessions_link_matches_board
        foreign key (share_link_id, board_id) references board_share_links (id, board_id) on delete cascade
);

create index board_guest_sessions_link_idx on board_guest_sessions (share_link_id);
create index board_guest_sessions_expires_at_idx on board_guest_sessions (expires_at);

comment on table board_guest_sessions is
    'Kurzlebige, widerrufbare Sitzung eines Gastes fuer genau ein Board. Gespeichert wird nur der Hash.';
comment on column board_guest_sessions.display_name is
    'Selbst gewaehlt beim Beitritt. Rein beschreibend, ohne jede Berechtigungswirkung.';

-- Eine Szenenversion kann jetzt auch von einem Gast stammen. Ein Gast ist kein Nutzer und steht deshalb
-- nicht in dieser Spalte; sie bleibt dann leer.
comment on column scene_versions.author_user_id is
    'Urheber der Speicherung. null heisst: ein Gast hat gespeichert oder der Nutzer wurde geloescht.';

-- Freigabelinks sind ein neuer Zieltyp des Nachweises. Die Aufzaehlung bleibt geschlossen, damit ein
-- Tippfehler im Anwendungscode nicht als neuer Zieltyp durchgeht.
alter table audit_events drop constraint audit_events_target_type_valid;
alter table audit_events add constraint audit_events_target_type_valid
    check (target_type in ('workspace', 'membership', 'board', 'board-grant', 'board-share-link'));

-- Der Beitritt eines Gastes ist das einzige Ereignis ohne internen Akteur. Die Spalte war bereits
-- nullable; der Kommentar sagt jetzt, dass null zwei verschiedene Dinge bedeuten kann.
comment on column audit_events.actor_user_id is
    'Interner Akteur. null heisst: ein Gast hat gehandelt oder der Nutzer wurde spaeter geloescht.';
