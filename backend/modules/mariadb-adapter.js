// modules/mariadb-adapter.js — MariaDB adapter. MariaDB speaks the MySQL wire
// protocol, so this adapter reuses the MySQL implementation via the "mysql2"
// driver while reporting itself (and its limitations) honestly as MariaDB.
import { MySqlAdapter } from './mysql-adapter.js';
import { registerAdapter } from './database-adapters.js';

export class MariaDbAdapter extends MySqlAdapter {
  constructor(connectionId, config) {
    super(connectionId, config, 'mariadb');
  }

  async health() {
    const base = await super.health();
    if (base.status === 'ok') base.provider = 'mariadb';
    return base;
  }
}

registerAdapter('mariadb', MariaDbAdapter);

export async function register(ctx) {
  ctx.log.debug?.('mariadb-adapter registered (shares mysql2 driver)');
}
