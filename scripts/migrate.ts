/**
 * Versioned, reversible migrations.
 *   bun run migrate          -> up (all pending)
 *   bun run migrate down     -> revert the last one
 *   bun run migrate status   -> executed / pending
 */
import { MikroORM } from "@mikro-orm/postgresql";
import { buildOrmConfig } from "../src/infrastructure/persistence/mikro-orm.config";
import { loadConfig } from "../src/shared/config";

const command = process.argv[2] ?? "up";
const orm = await MikroORM.init(buildOrmConfig(loadConfig()));
const migrator = orm.getMigrator();
try {
  if (command === "up") {
    const done = await migrator.up();
    console.log(`migrated up: ${done.map((m) => m.name).join(", ") || "(nothing pending)"}`);
  } else if (command === "down") {
    const done = await migrator.down();
    console.log(`migrated down: ${done.map((m) => m.name).join(", ") || "(nothing to revert)"}`);
  } else if (command === "status") {
    console.log("executed:", (await migrator.getExecutedMigrations()).map((m) => m.name));
    console.log("pending:", (await migrator.getPendingMigrations()).map((m) => m.name));
  } else {
    throw new Error(`unknown command ${command}`);
  }
} finally {
  await orm.close();
}
