import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(repoRoot, process.env.EHDS_DATA_DIR || '../TRACK-3-ehds/data');
const tables = [
  ['patients', 'patient_id,sex,birth_date,region,data_holder,opted_out'],
  ['conditions', 'patient_id,icd10,description,onset_date'],
  ['medications', 'patient_id,atc,name,start_date,end_date'],
  ['observations', 'patient_id,loinc,name,value,unit,date'],
  ['encounters', 'encounter_id,patient_id,data_holder,type,start_date,end_date,primary_icd10'],
];

// Count logical CSV records while passing the original bytes straight to COPY.
// Quote state crosses chunks; escaped quote pairs cancel each other. Newlines
// inside quoted fields do not end records. Handles LF, CRLF and a final bare row.
class CsvRecordCounter extends Transform {
  records = 0;
  quoted = false;
  hasContent = false;

  _transform(chunk, _encoding, callback) {
    for (const byte of chunk) {
      if (byte === 34) this.quoted = !this.quoted;
      if (!this.quoted && (byte === 10 || byte === 13)) {
        if (this.hasContent) this.records++;
        this.hasContent = false;
      } else {
        this.hasContent = true;
      }
    }
    callback(null, chunk);
  }

  _flush(callback) {
    if (this.quoted) return callback(new Error('Unterminated quoted CSV field'));
    if (this.hasContent) this.records++;
    callback();
  }
}

async function checkHeader(path, expected) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead).toString('utf8')
      .split(/\r\n|\n|\r/, 1)[0].replace(/^\uFEFF/, '');
    if (header !== expected) throw new Error(`Unexpected CSV header: ${path}`);
  } finally {
    await file.close();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to a privileged Supabase Postgres connection string.');

  // Validate every input before opening a transaction or truncating any data.
  for (const [table, columns] of tables) {
    await checkHeader(resolve(dataDir, `${table}.csv`), columns);
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const counts = await sql.begin(async (tx) => {
      await tx`set local datestyle = 'ISO, YMD'`;
      await tx`truncate table public.conditions, public.medications, public.observations, public.encounters, public.patients`;
      const result = [];
      for (const [table, columns] of tables) {
        const counter = new CsvRecordCounter();
        // Table and column names come only from the fixed allowlist above.
        const writable = await tx.unsafe(
          `copy public.${table} (${columns}) from stdin with (format csv, header true, encoding 'UTF8')`,
        ).writable();
        await pipeline(createReadStream(resolve(dataDir, `${table}.csv`)), counter, writable);
        const [row] = await tx.unsafe(`select count(*) as count from public.${table}`);
        const count = Number(row.count);
        const expected = counter.records - 1; // Exclude the header.
        if (count !== expected) {
          throw new Error(`${table}: expected ${expected} CSV rows, found ${count} database rows`);
        }
        result.push([table, count]);
      }
      const [eligible] = await tx`select count(*) as count from public.eligible_patients`;
      result.push(['eligible_patients', Number(eligible.count)]);
      return result;
    });
    for (const [table, count] of counts) console.log(`${table}: ${count}`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  // Do not log connection details or CSV contents (which may include patient data).
  if (error.code === 'ENOENT') console.error(`Missing CSV input in ${dataDir}.`);
  else if (error.name === 'PostgresError') console.error(`Database load failed (${error.code}); transaction rolled back.`);
  else console.error(error.message);
  process.exitCode = 1;
});
