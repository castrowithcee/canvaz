-- Boards, Szenenversionen und Assetmetadaten.
--
-- Ein Board gehoert genau einem Workspace und hat genau einen fachlichen Owner. Jede Szenenversion und jeder
-- Assetdatensatz traegt seinen Boardbezug; der Assetdatensatz zusaetzlich den Workspacebezug, damit ein
-- Abruf ohne Workspacegrenze gar nicht erst formulierbar ist.
--
-- Kein Hard Delete: der Lebenszyklus kennt nur 'active' und 'archived'. Die Fremdschluessel beschreiben,
-- was beim direkten Loeschen in der Datenbank geschieht - ueber die Anwendung gibt es diesen Weg nicht.

create table boards (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references workspaces (id) on delete cascade,
    title text not null,
    -- Genau ein fachlicher Owner. `restrict` statt `cascade`: ein Board ohne Owner waere ein Datensatz ohne
    -- Verantwortlichen, deshalb wird das Loeschen des Nutzers verweigert statt die Invariante gebrochen.
    owner_user_id uuid not null references users (id) on delete restrict,
    status text not null default 'active',
    -- Fortlaufende Nummer der zuletzt gespeicherten Szene. 0 heisst: noch nie gespeichert.
    current_scene_version integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint boards_title_not_blank check (length(btrim(title)) > 0),
    constraint boards_title_length check (length(title) <= 120),
    constraint boards_status_valid check (status in ('active', 'archived')),
    constraint boards_scene_version_not_negative check (current_scene_version >= 0),
    -- Zusammengesetzter Schluessel als Ziel des Assetfremdschluessels: er macht den doppelt gefuehrten
    -- Workspacebezug eines Assets nachweislich konsistent statt nur redundant.
    constraint boards_id_workspace_unique unique (id, workspace_id)
);

-- Die Boardliste laeuft immer ueber Workspace und Status; der Titel bestimmt die Sortierung und den Filter.
create index boards_workspace_status_title_idx on boards (workspace_id, status, lower(title));
create index boards_owner_idx on boards (owner_user_id);

comment on table boards is
    'Zeichenflaeche innerhalb genau eines Workspace. Archiviert heisst lesbar, aber unveraenderlich.';
comment on column boards.title is
    'Bewusst nicht eindeutig: eine Eindeutigkeitsverletzung wuerde fremde Boardtitel verraten.';
comment on column boards.current_scene_version is
    'Grundlage der optimistischen Versionspruefung. Wird nur zusammen mit einer neuen scene_versions-Zeile erhoeht.';

create table scene_versions (
    board_id uuid not null references boards (id) on delete cascade,
    version integer not null,
    -- Vollstaendiger Snapshot nach dem Vertrag in src/contracts/scene.ts. jsonb statt text, damit die
    -- Datenbank ein gueltiges JSON-Objekt garantiert; Schluesselreihenfolge traegt im Vertrag keine
    -- Bedeutung. Ein NUL-Zeichen kann jsonb nicht speichern und wird deshalb schon im Server abgewiesen.
    scene jsonb not null,
    author_user_id uuid references users (id) on delete set null,
    created_at timestamptz not null default now(),
    -- Der zusammengesetzte Primaerschluessel ist die Versionspruefung: zwei Speicherungen auf derselben
    -- Ausgangsversion koennen nicht beide eine Zeile anlegen.
    constraint scene_versions_pkey primary key (board_id, version),
    constraint scene_versions_version_positive check (version >= 1),
    constraint scene_versions_scene_is_object check (jsonb_typeof(scene) = 'object')
);

comment on table scene_versions is
    'Fortlaufende Szenenstaende eines Boards. Anhaengend statt ueberschreibend, damit die Historie sauber entsteht.';
comment on column scene_versions.author_user_id is
    'Urheber der Speicherung. Bleibt beim Loeschen des Nutzers als null erhalten, damit die Historie ihn ueberlebt.';

create table board_assets (
    id uuid primary key default gen_random_uuid(),
    board_id uuid not null,
    -- Redundant zum Board und genau deshalb abgesichert: der zusammengesetzte Fremdschluessel unten erzwingt,
    -- dass es derselbe Workspace ist. Ein Abruf kann damit nie an der Workspacegrenze vorbei formuliert
    -- werden. Ein zweiter Fremdschluessel nur auf `board_id` waere daneben ohne Wirkung.
    workspace_id uuid not null,
    -- Kennung der Datei im Szenenvertrag (BinaryFileRef.id). Kein UUID-Format: sie stammt aus dem Editor.
    file_id text not null,
    file_name text,
    mime_type text not null,
    byte_size bigint not null,
    checksum_sha256 text not null,
    storage_key text not null,
    created_at timestamptz not null default now(),
    constraint board_assets_workspace_matches_board
        foreign key (board_id, workspace_id) references boards (id, workspace_id) on delete cascade,
    constraint board_assets_file_unique unique (board_id, file_id),
    -- Der Speicherschluessel ist instanzweit eindeutig; zwei Datensaetze duerfen nie dieselben Bytes meinen.
    constraint board_assets_storage_key_unique unique (storage_key),
    constraint board_assets_file_id_not_blank check (length(btrim(file_id)) > 0),
    constraint board_assets_mime_type_not_blank check (length(btrim(mime_type)) > 0),
    constraint board_assets_byte_size_positive check (byte_size > 0),
    -- SHA-256 in Hex: 64 Zeichen, klein geschrieben.
    constraint board_assets_checksum_format check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
    constraint board_assets_storage_key_not_blank check (length(btrim(storage_key)) > 0)
);

create index board_assets_workspace_idx on board_assets (workspace_id);

comment on table board_assets is
    'Metadaten der Bildassets eines Boards. Die Bytes liegen hinter dem Storage-Port und nie in dieser Tabelle.';

-- Boards sind ein neuer Zieltyp des Nachweises. Die Aufzaehlung bleibt geschlossen, damit ein Tippfehler
-- im Anwendungscode nicht als neuer Zieltyp durchgeht.
alter table audit_events drop constraint audit_events_target_type_valid;
alter table audit_events add constraint audit_events_target_type_valid
    check (target_type in ('workspace', 'membership', 'board'));
