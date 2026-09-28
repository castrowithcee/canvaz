-- Papierkorb der Boards und der Wechsel des Arbeitsbereichs.
--
-- Additiv: `boards` bekommt zwei Spalten mit Standardwert null. Jedes vorhandene Board ist danach
-- unveraendert erreichbar - `deleted_at is null` ist der Normalfall und die Bedingung, die jede Liste und
-- jeder Zugriffsweg mitfuehrt.
--
-- **Der Papierkorb ist eine eigene Achse und kein weiterer Status.** `status` sagt weiterhin, ob ein Board
-- veraenderlich ist ('active') oder nur noch lesbar ('archived'); `deleted_at` sagt, ob es ueberhaupt noch
-- vorhanden ist. Zusammengelegt waere beides nicht mehr trennbar: ein archiviertes Board wuerde beim
-- Wiederherstellen still aktiv, und die Anwendung muesste sich seinen vorherigen Zustand anderswo merken.
--
-- Der urspruengliche Ordner bekommt bewusst **keine** eigene Spalte: `folder_id` bleibt beim Loeschen
-- stehen. Wird der Ordner in der Zwischenzeit entfernt, haengt ihn `board_folders.dissolve` wie jedes
-- andere Board an den Elternknoten um - ein Board im Papierkorb zeigt damit nie auf einen Ordner, den es
-- nicht mehr gibt, und das Wiederherstellen braucht dafuer keine zweite Wahrheit.

alter table boards add column deleted_at timestamptz;
-- `set null`: der Nachweis, **wann** geloescht wurde, ueberlebt das Konto der loeschenden Person.
alter table boards add column deleted_by_user_id uuid references users (id) on delete set null;

alter table boards add constraint boards_deleted_by_requires_deleted_at
    check (deleted_by_user_id is null or deleted_at is not null);

-- Der fristgesteuerte Lauf fragt instanzweit nach abgelaufenen Boards. Partiell, weil der Normalfall
-- (nicht geloescht) den Index nicht belasten soll: er ist so gross wie der Papierkorb und nicht wie die
-- Boardtabelle.
create index boards_trash_idx on boards (deleted_at) where deleted_at is not null;

comment on column boards.deleted_at is
    'null heisst: nicht im Papierkorb. Sonst der Zeitpunkt, ab dem die Aufbewahrungsfrist laeuft.';
comment on column boards.deleted_by_user_id is
    'Wer das Board in den Papierkorb gelegt hat. null heisst: das Konto wurde inzwischen entfernt.';

-- Verschieben in einen anderen Arbeitsbereich.
--
-- Assets und Freigabelinks fuehren den Workspacebezug doppelt und sind ueber den zusammengesetzten
-- Fremdschluessel an `boards (id, workspace_id)` gebunden. Genau diese Absicherung macht den Wechsel
-- unschreibbar, solange die Pruefung am Ende jeder einzelnen Anweisung steht: der Elternschluessel und die
-- Kinder koennen nicht gleichzeitig in einer Anweisung wandern.
--
-- `deferrable initially immediate` aendert daran nichts im Normalbetrieb - jede gewoehnliche Anweisung wird
-- weiterhin sofort geprueft. Nur die Transaktion des Wechsels stellt die Pruefung ausdruecklich auf das
-- Transaktionsende zurueck und aendert Board, Assets und Links darin gemeinsam. Die Zusage bleibt damit
-- dieselbe: nach dem Commit gehoeren alle drei zum selben Arbeitsbereich.
alter table board_assets
    alter constraint board_assets_workspace_matches_board deferrable initially immediate;
alter table board_share_links
    alter constraint board_share_links_workspace_matches_board deferrable initially immediate;
