import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import type { AppConfig } from "../../shared/config";
import { Migration20261014000001_initial_schema } from "./migrations/Migration20261014000001_initial_schema";
import { ALL_SCHEMAS } from "./schemas/records";

export function buildOrmConfig(config: Pick<AppConfig, "db">) {
  return defineConfig({
    clientUrl: config.db.url,
    entities: ALL_SCHEMAS,
    // No global EntityManager: every unit of work runs in its own fork.
    allowGlobalContext: false,
    discovery: { disableDynamicFileAccess: true },
    pool: { min: 1, max: config.db.poolMax },
    extensions: [Migrator],
    migrations: {
      tableName: "mikro_orm_migrations",
      transactional: true,
      silent: true,
      allOrNothing: true,
      // Explicit list: migrations are versioned in code, no glob / TS loader magic.
      migrationsList: [{ name: "Migration20261014000001_initial_schema", class: Migration20261014000001_initial_schema }],
    },
    debug: false,
  });
}
