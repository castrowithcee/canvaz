#!/usr/bin/env bash
#
# Betriebswerkzeug der Produktionsinstanz: Sicherung, Wiederherstellung, Ueberwachung.
#
#   docker/canvaz-ops.sh backup           verschluesseltes Archiv aus Datenbank und Assets
#   docker/canvaz-ops.sh restore <datei>  Archiv in die laufende Umgebung zurueckspielen
#   docker/canvaz-ops.sh check            Bereitschaft, Sicherungsalter, Fehlerrate, Plattenplatz
#
# Aufruf aus dem Verzeichnis mit `compose.prod.yml`. Die Werte kommen aus `.env.production`; Passphrase und
# Zugangsdaten stehen ausschliesslich dort und nie in diesem Skript.
#
# Bewusst ein Shellskript und kein Sicherungsdienst: gebraucht werden `pg_dump`, `tar` und `gpg` - alle
# bereits vorhanden, alle ohne eigenen Zustand. Ein zusaetzlicher Dienst waere ein weiterer Container mit
# Zugriff auf Datenbank und Assets, also genau der Zugriff, den eine selbst gehostete Instanz klein halten
# will.

set -euo pipefail

export COMPOSE_FILE="${COMPOSE_FILE:-compose.prod.yml}"
export COMPOSE_ENV_FILES="${COMPOSE_ENV_FILES:-.env.production}"

if [[ ! -f "$COMPOSE_ENV_FILES" ]]; then
    echo "Keine Produktionsumgebung unter $COMPOSE_ENV_FILES." >&2
    exit 2
fi
# shellcheck disable=SC1090
set -a && . "./$COMPOSE_ENV_FILES" && set +a

BACKUP_DIR="${CANVAZ_BACKUP_DIR:-/var/backups/canvaz}"
RETENTION_DAYS="${CANVAZ_BACKUP_RETENTION_DAYS:-14}"
MAX_AGE_HOURS="${CANVAZ_BACKUP_MAX_AGE_HOURS:-24}"
ADAPTER="${CANVAZ_STORAGE_ADAPTER:-filesystem}"
ASSET_ROOT=/var/lib/canvaz/assets

meldung() { printf '%s %s\n' "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# Arbeitsverzeichnis der laufenden Aktion. Global und nicht funktionslokal, damit der Aufraeumhaken es auch
# dann noch sieht, wenn das Skript mitten in einer Funktion abbricht - sonst bliebe ein unverschluesselter
# Zwischenstand liegen.
WORK=''
aufraeumen() {
    if [[ -n "$WORK" ]]; then
        rm --recursive --force "$WORK"
    fi
}
trap aufraeumen EXIT

# Eine JSON-Zeile je Alarm, in derselben Form wie das Anwendungslog - damit `check` aus einem Cronjob
# heraus dieselbe Sprache spricht wie die Instanz selbst.
alarm() {
    printf '{"level":"error","event":"%s","time":"%s","detail":"%s"}\n' \
        "$1" "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" "$2" >&2
}

passphrase_datei() {
    local datei="${CANVAZ_BACKUP_PASSPHRASE_FILE:-}"
    if [[ -z "$datei" || ! -r "$datei" ]]; then
        echo "CANVAZ_BACKUP_PASSPHRASE_FILE fehlt oder ist nicht lesbar." >&2
        exit 2
    fi
    printf '%s' "$datei"
}

# Assets als tar-Datei - nur im Modus `filesystem`. Im Modus `s3` liegen die Bytes bei einem externen,
# vom Betreiber selbst gestellten Objektspeicher; diese Instanz liefert dafuer keinen Dienst mehr mit und
# sichert seinen Inhalt deshalb nicht selbst. Die Sicherung der Assets ist dort Sache des Betreibers bzw.
# des Anbieters (z. B. dessen eigene Snapshot- oder Replikationsfunktion). Ein Archiv aus dem Modus `s3`
# enthaelt entsprechend nur Datenbank und Metadaten, kein `assets.tar`.
assets_lesen() {
    local ziel="$1"
    if [[ "$ADAPTER" == "s3" ]]; then
        meldung "Adapter s3: Assets liegen beim externen Objektspeicher, keine lokale Assetsicherung noetig."
        return 0
    fi
    docker compose run --rm -T --no-deps --entrypoint sh app \
        -c "tar --create --directory $ASSET_ROOT ." > "$ziel"
}

assets_schreiben() {
    local quelle="$1"
    if [[ "$ADAPTER" == "s3" ]]; then
        meldung "Adapter s3: Assets liegen beim externen Objektspeicher, keine lokale Wiederherstellung noetig."
        return 0
    fi
    docker compose run --rm -T --no-deps --entrypoint sh app \
        -c "tar --extract --directory $ASSET_ROOT" < "$quelle"
}

sichern() {
    local passphrase ziel
    passphrase="$(passphrase_datei)"
    mkdir -p "$BACKUP_DIR"
    WORK="$(mktemp --directory)"

    # **Reihenfolge:** erst die Datenbank, dann die Assets. Assets werden nur angelegt, nie geloescht; ein
    # Bild, das zwischen beiden Schritten entsteht, liegt danach ohne Datensatz im Speicher und stoert
    # niemanden. Andersherum verwiese ein Datensatz auf Bytes, die im Archiv fehlen.
    meldung "Datenbank wird gesichert"
    docker compose exec -T --env PGPASSWORD="$CANVAZ_DB_PASSWORD" postgres \
        pg_dump --host=127.0.0.1 --username=canvaz --dbname=canvaz --format=custom > "$WORK/database.dump"

    meldung "Assets werden gesichert (Adapter $ADAPTER)"
    assets_lesen "$WORK/assets.tar"

    {
        echo "zeitpunkt=$(date --utc +%Y-%m-%dT%H:%M:%SZ)"
        echo "adapter=$ADAPTER"
        echo "image=${CANVAZ_IMAGE:-canvaz:local}"
        echo "schema=$(docker compose exec -T --env PGPASSWORD="$CANVAZ_DB_PASSWORD" postgres \
            psql --host=127.0.0.1 --username=canvaz --dbname=canvaz --tuples-only --no-align \
            --command 'select max(version) from schema_migrations' | tr -d '[:space:]')"
    } > "$WORK/meta"

    ziel="$BACKUP_DIR/canvaz-$(date --utc +%Y%m%dT%H%M%SZ).tar.gpg"
    # Verschluesselt, bevor das Archiv seinen Platz hat: was den Host verlaesst, ist nie Klartext.
    tar --create --directory "$WORK" . |
        gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
            --passphrase-file "$passphrase" --output "$ziel"
    chmod 600 "$ziel"

    # Aufbewahrung: bestaetigt sind 14 Tage.
    find "$BACKUP_DIR" -maxdepth 1 -name 'canvaz-*.tar.gpg' -mtime "+$RETENTION_DAYS" -delete
    meldung "Sicherung fertig: $ziel ($(du --human-readable "$ziel" | cut -f1))"
}

wiederherstellen() {
    local archiv="$1" passphrase beginn dauer
    [[ -r "$archiv" ]] || {
        echo "Archiv $archiv nicht lesbar." >&2
        exit 2
    }
    passphrase="$(passphrase_datei)"
    beginn="$(date +%s)"
    WORK="$(mktemp --directory)"

    gpg --batch --quiet --decrypt --passphrase-file "$passphrase" "$archiv" | tar --extract --directory "$WORK"
    meldung "Archiv entpackt: $(tr '\n' ' ' < "$WORK/meta")"

    # Die Anwendung steht waehrend der Wiederherstellung still: ein laufender Boardraum wuerde seinen
    # Speicherstand ueber den gerade eingespielten schreiben.
    docker compose stop app > /dev/null
    docker compose up --detach --wait postgres > /dev/null

    meldung "Datenbank wird eingespielt"
    docker compose exec -T --env PGPASSWORD="$CANVAZ_DB_PASSWORD" postgres \
        pg_restore --host=127.0.0.1 --username=canvaz --dbname=canvaz --clean --if-exists --no-owner \
        < "$WORK/database.dump"

    meldung "Assets werden eingespielt (Adapter $ADAPTER)"
    assets_schreiben "$WORK/assets.tar"

    docker compose up --detach > /dev/null
    dauer=$(($(date +%s) - beginn))
    meldung "Wiederherstellung fertig in ${dauer}s"
}

pruefen() {
    local alarme=0 bereit metriken juengste alter fuenfhundert vorher stand

    if [[ "$(docker compose ps --status running --services 2> /dev/null | grep --count '^app$' || true)" != "1" ]]; then
        alarm 'ops.app.down' 'Der Anwendungscontainer laeuft nicht'
        alarme=1
    else
        bereit="$(docker compose exec -T app wget --quiet --output-document=- \
            http://127.0.0.1:3000/api/ready 2> /dev/null || true)"
        if [[ "$bereit" != *'"status":"ready"'* ]]; then
            alarm 'ops.not.ready' "Bereitschaft meldet: ${bereit:-keine Antwort}"
            alarme=1
        fi

        metriken="$(docker compose exec -T app wget --quiet --output-document=- \
            http://127.0.0.1:3000/api/metrics 2> /dev/null || true)"
        fuenfhundert="$(sed --quiet 's/^canvaz_http_responses_total{status="5xx"} //p' <<< "$metriken")"
        stand="$BACKUP_DIR/.check-state"
        vorher="$(cat "$stand" 2> /dev/null || echo 0)"
        if [[ -n "$fuenfhundert" ]]; then
            if ((fuenfhundert > vorher + 10)); then
                alarm 'ops.errors' "Seit der letzten Pruefung $((fuenfhundert - vorher)) Antworten mit 5xx"
                alarme=1
            fi
            mkdir -p "$BACKUP_DIR" && echo "$fuenfhundert" > "$stand"
        fi

        # Volllaufende Platte: der einzige Fehler, der beide Datenbestaende zugleich beschaedigt.
        for dienst in app:$ASSET_ROOT postgres:/var/lib/postgresql; do
            local belegt
            belegt="$(docker compose exec -T "${dienst%%:*}" df -P "${dienst##*:}" 2> /dev/null |
                awk 'NR==2 {gsub("%","",$5); print $5}')"
            if [[ -n "$belegt" ]] && ((belegt > 85)); then
                alarm 'ops.disk' "${dienst%%:*}: ${belegt}% belegt"
                alarme=1
            fi
        done
    fi

    # RPO: die juengste Sicherung darf nicht aelter als das bestaetigte Fenster sein.
    juengste="$(find "$BACKUP_DIR" -maxdepth 1 -name 'canvaz-*.tar.gpg' -printf '%T@\n' 2> /dev/null |
        sort --numeric-sort | tail -1)"
    if [[ -z "$juengste" ]]; then
        alarm 'ops.backup.missing' "Keine Sicherung in $BACKUP_DIR"
        alarme=1
    else
        alter=$((($(date +%s) - ${juengste%.*}) / 3600))
        if ((alter > MAX_AGE_HOURS)); then
            alarm 'ops.backup.stale' "Juengste Sicherung ist ${alter}h alt (erlaubt: ${MAX_AGE_HOURS}h)"
            alarme=1
        fi
    fi

    if ((alarme == 0)); then
        meldung "Alles in Ordnung"
    fi
    return "$alarme"
}

case "${1:-}" in
    backup) sichern ;;
    restore) wiederherstellen "${2:-}" ;;
    check) pruefen ;;
    *)
        echo "Aufruf: $0 backup | restore <archiv> | check" >&2
        exit 2
        ;;
esac
