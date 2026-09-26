-- Interne Boardfreigaben.
--
-- Eine Freigabe gibt einem **vorhandenen internen Nutzer** eine eigene Rolle auf genau einem Board,
-- zusaetzlich zu seiner Workspace-Mitgliedschaft. Sie ersetzt die Mitgliedschaft nicht: ohne Mitgliedschaft
-- im Arbeitsbereich bleibt das Board unsichtbar, und die Anwendung legt deshalb nur Freigaben fuer
-- Mitglieder an.
--
-- **Die Ownerschaft ist keine Freigabezeile.** Sie steht weiterhin in `boards.owner_user_id` - eine
-- `not null`-Spalte, die genau einen Owner traegt. Der Check unten laesst deshalb ausschliesslich die
-- delegierbaren Rollen zu; zwei Owner sind damit strukturell unmoeglich und nicht nur durch Anwendungslogik
-- ausgeschlossen. Ownerschaft wechselt ueber die Uebertragung, nie ueber eine zusaetzliche Zeile.

create table board_grants (
    board_id uuid not null,
    -- Redundant zum Board und genau deshalb abgesichert: der zusammengesetzte Fremdschluessel unten erzwingt,
    -- dass es derselbe Workspace ist. Eine Freigabe kann damit nie an der Workspacegrenze vorbei entstehen.
    workspace_id uuid not null,
    user_id uuid not null references users (id) on delete cascade,
    role text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- Genau eine Rolle je Paar aus Board und Nutzer; der zusammengesetzte Primaerschluessel ist die
    -- Eindeutigkeit. Eine zusaetzliche Ersatzkennung gaebe es nur, um sie nirgends zu verwenden.
    constraint board_grants_pkey primary key (board_id, user_id),
    constraint board_grants_role_valid check (role in ('editor', 'viewer')),
    constraint board_grants_workspace_matches_board
        foreign key (board_id, workspace_id) references boards (id, workspace_id) on delete cascade
);

-- Die Aufloesung fragt immer nach genau einem Paar aus Board und Nutzer; der Primaerschluessel traegt das.
-- Dieser Index traegt den umgekehrten Weg: alle Freigaben eines Nutzers, etwa beim Aufraeumen.
create index board_grants_user_idx on board_grants (user_id);
create index board_grants_workspace_idx on board_grants (workspace_id);

comment on table board_grants is
    'Eigene Boardrolle eines internen Nutzers. Wirkt zusaetzlich zur Workspace-Mitgliedschaft und nie an ihr vorbei.';
comment on column board_grants.role is
    'Nur delegierbare Rollen. Die Ownerschaft steht in boards.owner_user_id und ist damit genau einmal vergeben.';

-- Freigaben sind ein neuer Zieltyp des Nachweises. Die Aufzaehlung bleibt geschlossen, damit ein Tippfehler
-- im Anwendungscode nicht als neuer Zieltyp durchgeht.
alter table audit_events drop constraint audit_events_target_type_valid;
alter table audit_events add constraint audit_events_target_type_valid
    check (target_type in ('workspace', 'membership', 'board', 'board-grant'));
