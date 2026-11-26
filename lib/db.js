// Database connection helper - lib/db.js
const path = require('path');

let db;

function openSqlite(dbPath) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA journal_mode = WAL;');
    raw.exec('PRAGMA foreign_keys = ON;');

    return {
      prepare(sql) {
        const stmt = raw.prepare(sql);
        return {
          get: (...params) => stmt.get(...params),
          all: (...params) => stmt.all(...params),
          run: (...params) => stmt.run(...params)
        };
      },
      exec(sql) {
        return raw.exec(sql);
      },
      pragma(statement) {
        return raw.exec(`PRAGMA ${statement};`);
      },
      transaction(fn) {
        return (...args) => {
          raw.exec('BEGIN');
          try {
            const result = fn(...args);
            raw.exec('COMMIT');
            return result;
          } catch (err) {
            try { raw.exec('ROLLBACK'); } catch (_) {}
            throw err;
          }
        };
      },
      close() {
        raw.close();
      }
    };
  } catch (err) {
    const Database = require('better-sqlite3');
    const raw = new Database(dbPath);
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    return raw;
  }
}

function getDb() {
  if (!db) {
    const dbPath = path.join(__dirname, '..', 'lungi_shop.db');
    db = openSqlite(dbPath);
  }
  return db;
}

module.exports = { getDb, openSqlite };
