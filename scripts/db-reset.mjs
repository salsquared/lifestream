// Deletes the local SQLite database so it can be rebuilt from migrations + seed.
// P1.7 constrains this further: it must refuse unless a dump newer than the last
// write exists. That guard lands with the backup tooling in P11; until then the
// database holds nothing that is not reproducible from `db:migrate` + `db:seed`.
import { existsSync, unlinkSync } from 'node:fs';

const targets = ['data/lifestream.db', 'data/lifestream.db-journal'];
let removed = 0;
for (const t of targets) {
  if (existsSync(t)) {
    unlinkSync(t);
    console.log(`removed ${t}`);
    removed += 1;
  }
}
console.log(removed === 0 ? 'nothing to remove' : `db reset (${removed} file(s))`);
