-- Persoenliches Erscheinungsbild der Produktschale: Farbschema und Akzentfarbe.
--
-- Additiv und ohne Rueckfuellung: ein Nutzer ohne Zeile hat nichts gewaehlt und bekommt die Standardwahl
-- des Vertrags (`DEFAULT_APPEARANCE` - Systemvorgabe, bisherige Akzentfarbe). Jedes vorhandene Konto sieht
-- damit nach der Migration genau das, was es vorher sah.
--
-- Die Wahl gehoert dem Nutzer und nicht einem Geraet: sie folgt ihm auf jedes Geraet, auf dem er sich
-- anmeldet. Sie betrifft ausschliesslich die Oberflaeche, nie Boardinhalte, und ist deshalb keine Spalte
-- von `users` - das fachliche Profil bleibt, wie es ist.

create table user_appearance (
    -- Genau eine Zeile je Nutzer oder keine. Mit dem Konto verschwindet auch seine Wahl.
    user_id uuid primary key references users (id) on delete cascade,
    -- Die Aufzaehlungen stehen auch im Vertrag (`COLOR_SCHEMES`, `ACCENT_COLORS`); die Datenbank weist
    -- jeden anderen Wert zurueck, statt ihn still zu speichern.
    color_scheme text not null,
    accent text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint user_appearance_color_scheme_known check (color_scheme in ('system', 'light', 'dark')),
    constraint user_appearance_accent_known check (accent in ('violett', 'blau', 'petrol', 'fuchsia', 'graphit'))
);

comment on table user_appearance is
    'Farbschema und Akzentfarbe der Produktschale je Nutzer. Ohne Zeile gilt die Standardwahl.';
