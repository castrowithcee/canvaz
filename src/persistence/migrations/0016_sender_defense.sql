-- Absenderabwehr gegen gehaeufte Fehlanmeldungen (#35, Meilenstein 1).
--
-- Drei Tabellen fuer drei verschiedene Zwecke:
--
-- 1. `sender_failure_counter` zaehlt Fehlschlaege je Absender in einem 24-Stunden-Fenster. Der Schluessel ist
--    ein HMAC ueber die Adresse (IPv4) bzw. das /64-Praefix (IPv6) mit einem taeglich rotierenden, nur im
--    Prozessspeicher gehaltenen Schluessel (`src/server/sender-defense.ts`) - dieselbe Bauart wie
--    `login_throttle`, nur mit einem ausschliesslich fluechtigen statt einem dauerhaften Schluessel: ein
--    Neustart macht bestehende Zeilen unauffindbar und setzt die Zaehlung damit faktisch zurueck.
--
-- 2. `sender_block` haelt eine vorlaeufige Sperre. Anders als beim Zaehler steht die Adresse hier im
--    **Klartext**: eine ausgeloeste Sperre ist selbst ein sicherheitsrelevanter Vorgang, den der Betrieb
--    nachvollziehen koennen muss (Grund, Zaehlerstand, Zeitpunkte, Ablauf). Die Anwendung sperrt darueber
--    nie selbst dauerhaft und greift nie auf Firewall oder Proxy zu.
--
-- 3. `sender_block_proposal` haelt den Vorschlag einer dauerhaften Sperre, wenn dieselbe Adresse innerhalb
--    von 30 Tagen ein zweites Mal vorlaeufig gesperrt wird. Status und Entscheidungszeitpunkt bedienen die
--    Betreiberentscheidung aus Meilenstein 2; dieses Schema legt nur die Zeile an.

create table sender_failure_counter (
    key_hash text primary key,
    attempts integer not null,
    window_started_at timestamptz not null,
    constraint sender_failure_counter_key_hash_format check (key_hash ~ '^[0-9a-f]{64}$'),
    constraint sender_failure_counter_attempts_positive check (attempts > 0)
);

create index sender_failure_counter_window_idx on sender_failure_counter (window_started_at);

comment on table sender_failure_counter is
    'Fehlschlaege je Absender im laufenden 24h-Fenster. Gespeichert wird nur ein HMAC mit taeglich rotierendem, fluechtigem Schluessel - nie eine Adresse.';

create table sender_block (
    address text primary key,
    address_kind text not null check (address_kind in ('ipv4', 'ipv6-64')),
    reason text not null,
    failure_count integer not null check (failure_count > 0),
    created_at timestamptz not null,
    expires_at timestamptz not null,
    constraint sender_block_expires_after_created check (expires_at > created_at)
);

create index sender_block_expires_idx on sender_block (expires_at);

comment on table sender_block is
    'Vorlaeufige Sperre eines Absenders (Adresse oder IPv6-/64-Praefix) im Klartext, mit Grund, Zaehlerstand und Ablauf. Nie eine dauerhafte Sperre und nie ein Zugriff auf Firewall oder Proxy.';

create table sender_block_proposal (
    id uuid primary key default gen_random_uuid(),
    address text not null,
    address_kind text not null check (address_kind in ('ipv4', 'ipv6-64')),
    reason text not null,
    first_blocked_at timestamptz not null,
    second_blocked_at timestamptz not null,
    created_at timestamptz not null default now(),
    status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
    decided_at timestamptz,
    constraint sender_block_proposal_decided_consistency check ((status = 'pending') = (decided_at is null))
);

create index sender_block_proposal_status_idx on sender_block_proposal (status);

comment on table sender_block_proposal is
    'Vorschlag einer dauerhaften Sperre nach einer zweiten vorlaeufigen Sperre derselben Adresse innerhalb von 30 Tagen. Die Entscheidung selbst ist Meilenstein 2.';
