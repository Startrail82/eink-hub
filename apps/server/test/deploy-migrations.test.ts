import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'b8hub-deploy-mig-'));
const { openDb, schema, migrations } = await import('../src/db/index.js');

// Deploy-only: the fork combines two migrations that both touch `assignments`.
describe('deploy migrations', () => {
  it('keeps the location options when the schedules are rebuilt for several per Canvas', () => {
    const file = path.join(process.env.DATA_DIR!, 'old.db');
    const old = new Database(file);
    for (const m of migrations.slice(0, 12)) old.exec(m);
    old.pragma('user_version = 12');
    old.prepare(`INSERT INTO frames (id, name, host, upstream_token, created_at) VALUES (1, 'A', 'h', 't1', 1)`).run();
    old.prepare(`INSERT INTO assignments (id, frame_id, collection_id, show_location, hide_home_country) VALUES (5, 1, 2, 'city_country', 1)`).run();
    old.close();

    const db = openDb(file);
    expect(db.select().from(schema.assignments).get()).toMatchObject({ id: 5, showLocation: 'city_country', hideHomeCountry: true });
    db.insert(schema.assignments).values({ frameId: 1, collectionId: 3 }).run();
    expect(db.select().from(schema.assignments).all()).toHaveLength(2);
    db.$client.close();
  });
});
