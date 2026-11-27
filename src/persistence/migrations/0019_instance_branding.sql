-- Instance branding: exactly one row. An empty name means the product name, an empty accent the default
-- accent. The logo bytes live in the asset storage under `branding/`; only its key and type are kept here.

create table instance_branding (
    singleton boolean primary key default true,
    instance_name text not null default '',
    accent text not null default '',
    logo_key text,
    logo_type text,
    updated_at timestamptz not null default now(),
    -- No foreign key: the single row must outlive any user, and the actor id is only a record.
    updated_by uuid,
    constraint instance_branding_single_row check (singleton),
    constraint instance_branding_name_length check (length(instance_name) <= 60),
    constraint instance_branding_accent_valid
        check (accent in ('', 'violett', 'blau', 'petrol', 'fuchsia', 'graphit')),
    constraint instance_branding_logo_complete check ((logo_key is null) = (logo_type is null)),
    constraint instance_branding_logo_type_valid
        check (logo_type is null or logo_type in ('image/png', 'image/jpeg', 'image/webp'))
);

insert into instance_branding (singleton) values (true);
