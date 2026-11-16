import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { pool } from './db.js';

const targetUrl = process.env.NEON_DATABASE_URL;
const sourceUrl = process.env.DATABASE_URL;

const quote = (value: string) => '"' + value.replace(/"/g, '""') + '"';

if (targetUrl && sourceUrl && targetUrl !== sourceUrl) {
  const source = new Pool({ connectionString: sourceUrl, max: 2 });
  const sourceClient = await source.connect();
  const targetClient = await pool.connect();
  const tableOrder = [
    'organizations', 'branches', 'users', 'categories', 'suppliers', 'customers',
    'ingredients', 'products', 'recipes', 'orders', 'order_items', 'payments',
    'purchases', 'purchase_items', 'stock_movements', 'audit_logs'
  ];
  let copied = 0;
  try {
    const sourceTables = await sourceClient.query<{table_name:string}>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
    );
    const targetTables = await targetClient.query<{table_name:string}>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
    );
    const sourceSet = new Set(sourceTables.rows.map(row => row.table_name));
    const targetSet = new Set(targetTables.rows.map(row => row.table_name));
    await targetClient.query('BEGIN');
    for (const table of tableOrder) {
      if (!sourceSet.has(table) || !targetSet.has(table)) continue;
      const [sourceColumns, targetColumns] = await Promise.all([
        sourceClient.query<{column_name:string}>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
          [table]
        ),
        targetClient.query<{column_name:string}>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
          [table]
        )
      ]);
      const targetColumnSet = new Set(targetColumns.rows.map(row => row.column_name));
      const columns = sourceColumns.rows.map(row => row.column_name).filter(name => targetColumnSet.has(name));
      if (!columns.length) continue;
      let offset = 0;
      while (true) {
        const result = await sourceClient.query(
          'SELECT ' + columns.map(quote).join(',') + ' FROM ' + quote('public') + '.' + quote(table) + ' ORDER BY 1 LIMIT 300 OFFSET $1',
          [offset]
        );
        if (!result.rows.length) break;
        const values: unknown[] = [];
        const tuples = result.rows.map((row: Record<string, unknown>, rowIndex: number) => {
          const marks = columns.map((_, columnIndex) => {
            values.push(row[columns[columnIndex]]);
            return '$' + (rowIndex * columns.length + columnIndex + 1);
          });
          return '(' + marks.join(',') + ')';
        });
        const insert = 'INSERT INTO ' + quote('public') + '.' + quote(table) +
          ' (' + columns.map(quote).join(',') + ') VALUES ' + tuples.join(',') + ' ON CONFLICT DO NOTHING';
        const inserted = await targetClient.query(insert, values);
        copied += inserted.rowCount || 0;
        offset += result.rows.length;
        if (result.rows.length < 300) break;
      }
    }
    await targetClient.query('COMMIT');
    console.log('Legacy Render to Neon transfer finished. Newly inserted rows: ' + copied);
  } catch (error) {
    await targetClient.query('ROLLBACK');
    throw error;
  } finally {
    targetClient.release();
    sourceClient.release();
    await source.end();
  }
} else {
  console.log('Legacy transfer skipped: source or Neon connection is not configured.');
}

for (const file of ['001_initial.sql', '002_team_payroll.sql', '003_payroll_hardening.sql']) {
  const sql = await readFile(new URL('../db/migrations/' + file, import.meta.url), 'utf8');
  await pool.query(sql);
  console.log('Database migration applied: ' + file);
}
await pool.end();
