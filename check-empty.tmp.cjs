const { createClient } = require("@libsql/client");
for (const w of ["stardew", "hollowknight", "celeste"]) {
  const db = createClient({ url: `file:output/${w}/wiki.sqlite` });
  (async () => {
    try {
      const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table'");
      const tableNames = tables.rows.map((r) => r.name).join(", ");
      console.log(`\n${w}: tables = ${tableNames}`);
      // find the page table (might be wiki_page or page)
      for (const t of tables.rows) {
        const name = String(t.name);
        if (name === "page" || name === "wiki_page") {
          const count = await db.execute(`SELECT COUNT(*) as n FROM ${name}`);
          const withText = await db.execute(`SELECT COUNT(*) as n FROM ${name} WHERE text IS NOT NULL`);
          const nsRes = await db.execute(`SELECT namespace, COUNT(*) as n FROM ${name} GROUP BY namespace LIMIT 5`);
          console.log(`  ${name}: ${count.rows[0].n} rows, ${withText.rows[0].n} with text`);
          console.log(`  namespaces: ${nsRes.rows.map((r) => `${r.namespace}:${r.n}`).join(", ")}`);
          if (Number(count.rows[0].n) > 0) {
            const sample = await db.execute(`SELECT title, LENGTH(text) as len FROM ${name} WHERE text IS NOT NULL LIMIT 3`);
            for (const s of sample.rows) console.log(`    sample: ${s.title} (${s.len} chars)`);
          }
        }
      }
    } catch (e) { console.log(`  ERROR: ${e.message}`); }
  })();
}
