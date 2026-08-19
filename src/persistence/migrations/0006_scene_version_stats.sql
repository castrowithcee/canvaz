-- Kopfdaten einer Szenenversion neben dem Snapshot.
--
-- Die Versionshistorie zeigt Zeitpunkt, Urheber und Umfang, aber nie den Inhalt. Ohne diese beiden Spalten
-- muesste die Liste den Umfang aus dem Snapshot selbst gewinnen (`jsonb_array_length`, `length(scene::text)`)
-- und damit bei jedem Aufruf so viele vollstaendige Szenen anfassen, wie sie Zeilen zeigt - bei der
-- Aufbewahrungsgrenze also bis zu hundert Snapshots von je mehreren Megabyte fuer eine Ansicht, die den
-- Inhalt gar nicht darstellt. Mit ihnen liest die Liste ausschliesslich schmale Spalten.
--
-- Bewusst **keine** generierte Spalte: `scene::text` und `pg_column_size` sind nicht immutable und taugen
-- deshalb nicht als `generated always as ... stored`. Geschrieben werden die Werte stattdessen dort, wo die
-- Zeile ohnehin entsteht - im selben `insert`, aus demselben Snapshot.
--
-- Die Werte sind beschreibend und tragen keine Entscheidung: keine Berechtigung, keine Versionspruefung und
-- keine Aufbewahrung haengt an ihnen. Ein abweichender Wert waere eine falsche Anzeige, nie ein falscher
-- Zugriff.

alter table scene_versions
    add column element_count integer not null default 0,
    add column byte_size integer not null default 0;

-- Bestandszeilen bekommen ihre Kopfdaten einmalig aus dem Snapshot. Ein beschaedigter Datensatz, dessen
-- `elements` kein Array ist, zaehlt null statt die Migration scheitern zu lassen: sie wird beim Lesen
-- ohnehin als beschaedigt gemeldet, und eine Anzeigezahl darf keine Migration blockieren.
update scene_versions
   set element_count = coalesce(
           jsonb_array_length(
               case when jsonb_typeof(scene -> 'elements') = 'array' then scene -> 'elements' else '[]'::jsonb end
           ), 0),
       byte_size = length(scene::text);

alter table scene_versions
    add constraint scene_versions_element_count_not_negative check (element_count >= 0),
    add constraint scene_versions_byte_size_not_negative check (byte_size >= 0);

comment on column scene_versions.element_count is
    'Zahl der Elemente einschliesslich Tombstones. Rein beschreibend fuer die Versionshistorie.';
comment on column scene_versions.byte_size is
    'Groesse des serialisierten Snapshots in Bytes. Rein beschreibend fuer die Versionshistorie.';
