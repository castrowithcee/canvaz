-- Ordner eines Arbeitsbereichs und die Ablage der Boards darin.
--
-- Additiv: `board_folders` kommt hinzu, `boards` bekommt eine Spalte mit Standardwert null. Jedes
-- vorhandene Board liegt danach unmittelbar im Arbeitsbereich und bleibt unveraendert erreichbar - die
-- Boardliste ohne Ordnerfilter ist dieselbe Abfrage wie zuvor.
--
-- Ordner sind **Gliederung und keine Berechtigung**. Es gibt deshalb keine Rechtezeile an einem Ordner und
-- keinen Bezug von einer Freigabe auf einen: wer ein Board sehen darf, entscheiden weiterhin Mitgliedschaft
-- und Boardrolle.

create table board_folders (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references workspaces (id) on delete cascade,
    -- Redundant zum Elternordner und genau deshalb abgesichert: der zusammengesetzte Fremdschluessel unten
    -- erzwingt, dass es derselbe Arbeitsbereich ist. Ein Ordner ueber Arbeitsbereichsgrenzen hinweg ist
    -- damit gar nicht erst schreibbar - unabhaengig davon, was die Anwendung prueft.
    parent_id uuid,
    name text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- Ziel des zusammengesetzten Fremdschluessels von Unterordnern und Boards.
    constraint board_folders_id_workspace_unique unique (id, workspace_id),
    -- `restrict`: einen Ordner mit Unterordnern loescht die Anwendung nie direkt, sondern haengt sie zuerst
    -- um. Ein `cascade` wuerde beim direkten Loeschen in der Datenbank einen ganzen Teilbaum mitnehmen.
    constraint board_folders_parent_in_workspace
        foreign key (parent_id, workspace_id) references board_folders (id, workspace_id) on delete restrict,
    constraint board_folders_name_not_blank check (length(btrim(name)) > 0),
    constraint board_folders_name_length check (length(name) <= 80),
    constraint board_folders_not_own_parent check (parent_id is null or parent_id <> id)
);

-- Eindeutiger Name je Elternknoten, ohne Ruecksicht auf Gross- und Kleinschreibung. `nulls not distinct`
-- fasst die Ordner unmittelbar im Arbeitsbereich als eine Geschwisterschaft: ohne den Zusatz waeren zwei
-- gleichnamige Ordner auf oberster Ebene erlaubt, weil null in einem Index sonst von null verschieden ist.
create unique index board_folders_name_unique
    on board_folders (workspace_id, parent_id, lower(name)) nulls not distinct;

create index board_folders_parent_idx on board_folders (parent_id);

comment on table board_folders is
    'Frei waehlbare Gliederung eines Arbeitsbereichs. Traegt selbst keine Rechte und aendert keine Sichtbarkeit.';
comment on column board_folders.parent_id is
    'null heisst: unmittelbar im Arbeitsbereich. Zyklus und Tiefengrenze prueft der Fachkern unter der Workspacesperre.';

-- Ordnerablage des Boards. Genau einer oder keiner - ein Board in mehreren Ordnern gibt es nicht.
-- `on delete set null` ist der Rueckfall der Datenbank; ueber die Anwendung entsteht er nie, weil das
-- Entfernen eines Ordners seinen Inhalt zuerst an den Elternknoten haengt.
alter table boards add column folder_id uuid;
alter table boards add constraint boards_folder_in_workspace
    foreign key (folder_id, workspace_id) references board_folders (id, workspace_id) on delete set null;

create index boards_folder_idx on boards (folder_id);

comment on column boards.folder_id is
    'null heisst: unmittelbar im Arbeitsbereich. Die Ablage ist Darstellung und veraendert keine Berechtigung.';

-- Ordner sind ein neuer Zieltyp des Nachweises. Die Aufzaehlung bleibt geschlossen, damit ein Tippfehler im
-- Anwendungscode nicht als neuer Zieltyp durchgeht.
alter table audit_events drop constraint audit_events_target_type_valid;
alter table audit_events add constraint audit_events_target_type_valid
    check (target_type in ('workspace', 'membership', 'board', 'board-grant', 'board-share-link', 'board-folder'));
