"""
Copy every CheckMuna row from one Supabase project to another.

    python scripts/migrate_supabase.py

For moving to a new Supabase account. Reads each table from the OLD
project through its REST API and upserts it into the NEW one, in
foreign-key order, then checks the row counts match. Standard library
only — nothing to install.

Before running
  1. In the NEW project's SQL Editor, run supabase-full-schema.sql.
     (Not supabase-schema.sql: the full schema makes detection ids
     copyable, and has every column the old project may hold.)
  2. Have both projects' Project URL and service_role key to hand
     (Project Settings → API). Use the service_role key, not anon — RLS
     hides every row from anon.

The four values are read from OLD_SUPABASE_URL, OLD_SUPABASE_KEY,
NEW_SUPABASE_URL and NEW_SUPABASE_KEY if set, otherwise asked for (keys
without echo).

Safe to re-run: every row is upserted on its primary key, so a second run
after an interruption fills in what is missing and duplicates nothing.
It never deletes or changes anything in the old project.

Copied: the five report tables and dashboard_users (password hashes come
across as-is, so everyone keeps their login). Not copied:
dashboard_sessions — everyone signs in once more on the new project.

Egress: this reads every stored photo from the old project once, which
counts against that project's egress allowance — on a free plan with many
photos, run it once rather than repeatedly.
"""
import getpass
import json
import os
import sys
import time
import urllib.error
import urllib.request

# (table, primary key, rows per request). Photo-carrying tables use small
# pages: a reports row can hold a ~270 KB cover photo, an images row one
# packaging photo.
TABLES = [
    ('reports',                  'id',                 25),
    ('report_label_checks',      'report_id',          200),
    ('report_damage_checks',     'report_id',          200),
    ('report_damage_images',     'report_id,ordinal',  10),
    ('report_damage_detections', 'id',                 500),
    ('dashboard_users',          'id',                 200),
]

# Computed by Postgres; it refuses a value for them.
GENERATED = {'reports': {'has_image'}}


def ask(env, prompt, secret=False):
    v = os.environ.get(env, '').strip()
    if v:
        return v
    v = (getpass.getpass if secret else input)(prompt + ': ').strip()
    if not v:
        sys.exit(f'{env} is required.')
    return v


class Project:
    def __init__(self, url, key):
        self.base = url.rstrip('/') + '/rest/v1'
        self.headers = {'apikey': key, 'Content-Type': 'application/json'}
        # Legacy service_role keys are JWTs and go in Authorization too; the
        # newer sb_secret_ keys are accepted only in the apikey header.
        if key.startswith('eyJ'):
            self.headers['Authorization'] = 'Bearer ' + key

    def request(self, method, path, body=None, extra=None):
        data = None if body is None else json.dumps(body).encode()
        for attempt in range(4):
            req = urllib.request.Request(
                self.base + path, data=data, method=method,
                headers={**self.headers, **(extra or {})})
            try:
                with urllib.request.urlopen(req, timeout=120) as res:
                    raw = res.read()
                    return res.headers, (json.loads(raw) if raw else None)
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors='replace')
                if e.code < 500 or attempt == 3:
                    sys.exit(f'\n{method} {path} → HTTP {e.code}\n{detail}')
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt == 3:
                    sys.exit(f'\n{method} {path} failed: {e}')
            time.sleep(2 ** attempt)

    def count(self, table):
        headers, _ = self.request(
            'HEAD', f'/{table}?select=*',
            extra={'Prefer': 'count=exact', 'Range': '0-0'})
        # Content-Range: 0-0/123  (or */0 when empty)
        return int(headers.get('Content-Range', '*/0').split('/')[-1])

    def table_exists(self, table):
        try:
            self.count(table)
            return True
        except SystemExit:
            return False


def copy_table(old, new, table, pk, page):
    total = old.count(table)
    if total == 0:
        print(f'  {table:<26} empty')
        return
    order = ','.join(c + '.asc' for c in pk.split(','))
    skip = GENERATED.get(table, set())
    done = 0
    while done < total:
        _, rows = old.request('GET', f'/{table}?select=*&order={order}'
                                     f'&limit={page}&offset={done}')
        if not rows:
            break
        for row in rows:
            for col in skip:
                row.pop(col, None)
            # An old project from before the sync migration has no
            # updated_at; created_at is the honest value for it.
            if table == 'reports' and 'updated_at' not in row:
                row['updated_at'] = row.get('created_at')
        new.request('POST', f'/{table}?on_conflict={pk}', rows,
                    extra={'Prefer': 'resolution=merge-duplicates,return=minimal'})
        done += len(rows)
        print(f'\r  {table:<26} {done}/{total}', end='', flush=True)
    print()


def main():
    print('Copy CheckMuna data between Supabase projects.\n')
    old = Project(ask('OLD_SUPABASE_URL', 'OLD project URL'),
                  ask('OLD_SUPABASE_KEY', 'OLD service_role key', secret=True))
    new = Project(ask('NEW_SUPABASE_URL', 'NEW project URL'),
                  ask('NEW_SUPABASE_KEY', 'NEW service_role key', secret=True))
    if old.base == new.base:
        sys.exit('OLD and NEW are the same project.')

    if not new.table_exists('reports'):
        sys.exit('The NEW project has no reports table — run '
                 'supabase-full-schema.sql in its SQL Editor first.')

    print('\nCopying:')
    for table, pk, page in TABLES:
        if not old.table_exists(table):
            print(f'  {table:<26} not in old project, skipped')
            continue
        copy_table(old, new, table, pk, page)

    # Copied detections kept their ids; move the identity sequence past
    # them so the next upload doesn't collide.
    new.request('POST', '/rpc/checkmuna_sync_detection_ids', {})

    print('\nRow counts (old → new):')
    ok = True
    for table, _, _ in TABLES:
        if not old.table_exists(table):
            continue
        a, b = old.count(table), new.count(table)
        flag = 'ok' if b >= a else 'MISSING ROWS'
        ok = ok and b >= a
        print(f'  {table:<26} {a:>6} → {b:<6} {flag}')

    if not ok:
        sys.exit('\nSome rows did not arrive. Re-run the script; it only '
                 'fills in what is missing.')
    print('\nDone. Next: point Vercel at the new project (SUPABASE_URL and '
          'SUPABASE_SERVICE_ROLE_KEY), redeploy, and sign in again.')


if __name__ == '__main__':
    main()
