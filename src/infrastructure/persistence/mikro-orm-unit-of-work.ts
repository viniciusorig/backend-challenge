import type { MikroORM } from "@mikro-orm/postgresql";
import type { UnitOfWork, WageringStore } from "../../application/ports/repositories";
import { translateDbError } from "./db-errors";
import { createStore } from "./mikro-orm-store";

export interface UnitOfWorkOptions {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

/**
 * One SQL transaction per call (READ COMMITTED). `lock_timeout` bounds how long
 * a hot wallet can make a request wait; hitting it surfaces as a transient
 * LOCK_TIMEOUT error that callers retry or report as 503.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions,
  ) {}

  async transactional<T>(work: (store: WageringStore) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(
          `SET LOCAL lock_timeout = ${Math.trunc(this.options.lockTimeoutMs)}; SET LOCAL statement_timeout = ${Math.trunc(this.options.statementTimeoutMs)}`,
        );
        return work(createStore(em));
      });
    } catch (error) {
      throw translateDbError(error);
    }
  }

  async read<T>(work: (store: WageringStore) => Promise<T>): Promise<T> {
    try {
      return await work(createStore(this.orm.em.fork()));
    } catch (error) {
      throw translateDbError(error);
    }
  }
}
