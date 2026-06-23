"""SQLite schema + connection helper.

The DB is created on first use. A single file (femo.db) holds everything.
"""
import sqlite3

import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    date        TEXT,            -- ISO YYYY-MM-DD
    description TEXT,
    reference   TEXT,            -- e.g. INV-250017 pulled from description
    amount      REAL,            -- always positive
    direction   TEXT,            -- 'debit' | 'credit'
    source_file TEXT,
    raw_text    TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     TEXT NOT NULL,
    invoice_number TEXT,
    customer_name  TEXT,
    invoice_date   TEXT,         -- ISO YYYY-MM-DD
    total          REAL,
    balance        REAL,
    status         TEXT
);

CREATE TABLE IF NOT EXISTS income_matches (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     TEXT NOT NULL,
    transaction_id INTEGER REFERENCES transactions(id),
    invoice_id     INTEGER REFERENCES invoices(id),
    score          REAL,
    method         TEXT,         -- 'reference' | 'amount_date' | 'fuzzy'
    status         TEXT          -- 'suggested' | 'confirmed' | 'rejected'
);

CREATE TABLE IF NOT EXISTS expense_vouchers (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     TEXT NOT NULL,
    transaction_id INTEGER REFERENCES transactions(id),
    payee          TEXT,
    purpose        TEXT,
    category       TEXT,
    needs_invoice  INTEGER DEFAULT 1,   -- 1 = real supplier invoice still wanted
    output_path    TEXT,
    created_at     TEXT
);
"""


def connect(db_path=None):
    conn = sqlite3.connect(db_path or config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path=None):
    conn = connect(db_path)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn
