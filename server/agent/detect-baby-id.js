import path from 'node:path';
import Database from 'better-sqlite3';

const databasePath = path.resolve(process.argv[2] || 'data/babynote.db');
const database = new Database(databasePath, { readonly: true });

try {
  const baby = database.prepare('SELECT id FROM babies ORDER BY id LIMIT 1').get();
  if (!baby) {
    console.error('No baby profile exists in the SQLite database.');
    process.exitCode = 2;
  } else {
    process.stdout.write(String(baby.id));
  }
} finally {
  database.close();
}
