-- Normalized structural fingerprint of the public schema (for diffing two DBs).
-- Order-stable, no data, no credentials.
SELECT 'TABLE ' || c.relname
       || ' rls=' || c.relrowsecurity
       || ' force=' || c.relforcerowsecurity AS line
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'

UNION ALL
SELECT 'COLUMN ' || table_name || '.' || column_name || ' ' || data_type
       || ' null=' || is_nullable || ' default=' || coalesce(column_default, '-')
FROM information_schema.columns WHERE table_schema = 'public'

UNION ALL
SELECT 'CONSTRAINT ' || conrelid::regclass::text || ' ' || conname || ' ' || contype::text
       || ' confdeltype=' || coalesce(confdeltype::text, '-')
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace

UNION ALL
SELECT 'INDEX ' || indexname || ' :: ' || indexdef
FROM pg_indexes WHERE schemaname = 'public' AND indexname NOT LIKE '%_pkey'

UNION ALL
SELECT 'GRANT ' || grantee || ' ' || table_name || ' ' || privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'service_role')

ORDER BY 1;
