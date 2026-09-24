-- Persoenliche Bibliothek wiederverwendbarer Zeichnungsteile je Nutzer.
--
-- Additiv und ohne Rueckfuellung: ein Nutzer ohne Zeile hat eine leere Bibliothek (Revision 0). Die
-- Bibliothek gehoert dem Nutzer und keinem Board; sie steht deshalb weder im Szenen-Snapshot noch in dessen
-- Versionen und aendert beides nie.

create table user_library (
    -- Genau eine Zeile je Nutzer oder keine. Mit dem Konto verschwindet auch seine Bibliothek.
    user_id uuid primary key references users (id) on delete cascade,
    -- Die Eintraege im Format des Editors. Struktur, Groesse und fehlende Medien prueft die Anwendung vor dem
    -- Schreiben; die Datenbank haelt nur fest, dass es eine Liste ist.
    items jsonb not null,
    -- Zaehlt jede bestaetigte Speicherung. Eine Speicherung auf einer ueberholten Revision schreibt nichts:
    -- zwei Fenster ueberschreiben sich damit nie still.
    revision integer not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint user_library_items_array check (jsonb_typeof(items) = 'array'),
    constraint user_library_revision_positive check (revision > 0)
);

comment on table user_library is
    'Persoenliche Bibliothek je Nutzer. Ohne Zeile ist sie leer; unabhaengig von Boards und Versionen.';
