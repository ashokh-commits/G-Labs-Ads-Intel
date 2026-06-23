"""Named query helpers — keeps SQL out of the route handlers."""
from datetime import datetime


# ---------- inserts ----------
def insert_invoice(conn, session_id, inv):
    cur = conn.execute(
        """INSERT INTO invoices
           (session_id, invoice_number, customer_name, invoice_date, total, balance, status)
           VALUES (?,?,?,?,?,?,?)""",
        (session_id, inv["invoice_number"], inv["customer_name"],
         inv["invoice_date"], inv["total"], inv["balance"], inv["status"]),
    )
    return cur.lastrowid


def insert_transaction(conn, session_id, txn):
    cur = conn.execute(
        """INSERT INTO transactions
           (session_id, date, description, reference, amount, direction, source_file, raw_text)
           VALUES (?,?,?,?,?,?,?,?)""",
        (session_id, txn["date"], txn["description"], txn.get("reference"),
         txn["amount"], txn["direction"], txn.get("source_file"), txn.get("raw_text")),
    )
    return cur.lastrowid


def insert_income_match(conn, session_id, transaction_id, invoice_id, score, method, status="suggested"):
    conn.execute(
        """INSERT INTO income_matches
           (session_id, transaction_id, invoice_id, score, method, status)
           VALUES (?,?,?,?,?,?)""",
        (session_id, transaction_id, invoice_id, score, method, status),
    )


# ---------- session reset ----------
def clear_session(conn, session_id):
    for t in ("income_matches", "expense_vouchers", "transactions", "invoices"):
        conn.execute(f"DELETE FROM {t} WHERE session_id = ?", (session_id,))


# ---------- reads ----------
def get_invoices(conn, session_id):
    return conn.execute(
        "SELECT * FROM invoices WHERE session_id=? ORDER BY invoice_date", (session_id,)
    ).fetchall()


def get_transactions(conn, session_id, direction=None):
    if direction:
        return conn.execute(
            "SELECT * FROM transactions WHERE session_id=? AND direction=? ORDER BY date",
            (session_id, direction),
        ).fetchall()
    return conn.execute(
        "SELECT * FROM transactions WHERE session_id=? ORDER BY date", (session_id,)
    ).fetchall()


def get_income_matches(conn, session_id):
    """Suggested/confirmed matches joined with both sides for the review table."""
    return conn.execute(
        """SELECT m.*, t.date AS txn_date, t.description AS txn_desc,
                  t.amount AS txn_amount, t.reference AS txn_ref,
                  i.invoice_number, i.customer_name, i.total AS inv_total,
                  i.invoice_date
           FROM income_matches m
           JOIN transactions t ON t.id = m.transaction_id
           JOIN invoices i      ON i.id = m.invoice_id
           WHERE m.session_id=? AND m.status != 'rejected'
           ORDER BY m.score DESC""",
        (session_id,),
    ).fetchall()


def set_match_status(conn, match_id, status):
    conn.execute("UPDATE income_matches SET status=? WHERE id=?", (status, match_id))


def get_unpaid_invoices(conn, session_id):
    """Invoices with no confirmed deposit matched."""
    return conn.execute(
        """SELECT i.* FROM invoices i
           WHERE i.session_id=?
             AND i.id NOT IN (
               SELECT invoice_id FROM income_matches
               WHERE session_id=? AND status='confirmed')
           ORDER BY i.invoice_date""",
        (session_id, session_id),
    ).fetchall()


def get_uninvoiced_deposits(conn, session_id):
    """Credit transactions with no confirmed invoice match."""
    return conn.execute(
        """SELECT t.* FROM transactions t
           WHERE t.session_id=? AND t.direction='credit'
             AND t.id NOT IN (
               SELECT transaction_id FROM income_matches
               WHERE session_id=? AND status='confirmed')
           ORDER BY t.date""",
        (session_id, session_id),
    ).fetchall()


# ---------- expenses ----------
def get_debits_with_vouchers(conn, session_id):
    """All debit transactions left-joined to any voucher already created."""
    return conn.execute(
        """SELECT t.*, v.id AS voucher_id, v.payee, v.purpose, v.category,
                  v.needs_invoice, v.output_path
           FROM transactions t
           LEFT JOIN expense_vouchers v
                  ON v.transaction_id = t.id AND v.session_id = t.session_id
           WHERE t.session_id=? AND t.direction='debit'
           ORDER BY t.date""",
        (session_id,),
    ).fetchall()


def upsert_voucher(conn, session_id, transaction_id, payee, purpose, category,
                   needs_invoice, output_path):
    existing = conn.execute(
        "SELECT id FROM expense_vouchers WHERE session_id=? AND transaction_id=?",
        (session_id, transaction_id),
    ).fetchone()
    now = datetime.now().isoformat(timespec="seconds")
    if existing:
        conn.execute(
            """UPDATE expense_vouchers
               SET payee=?, purpose=?, category=?, needs_invoice=?, output_path=?, created_at=?
               WHERE id=?""",
            (payee, purpose, category, needs_invoice, output_path, now, existing["id"]),
        )
        return existing["id"]
    cur = conn.execute(
        """INSERT INTO expense_vouchers
           (session_id, transaction_id, payee, purpose, category, needs_invoice, output_path, created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (session_id, transaction_id, payee, purpose, category, needs_invoice, output_path, now),
    )
    return cur.lastrowid


def get_voucher(conn, voucher_id):
    return conn.execute("SELECT * FROM expense_vouchers WHERE id=?", (voucher_id,)).fetchone()


def get_vouchers(conn, session_id, needs_invoice=None):
    if needs_invoice is None:
        return conn.execute(
            "SELECT * FROM expense_vouchers WHERE session_id=? ORDER BY created_at", (session_id,)
        ).fetchall()
    return conn.execute(
        "SELECT v.*, t.date AS txn_date, t.amount AS txn_amount, t.description AS txn_desc "
        "FROM expense_vouchers v JOIN transactions t ON t.id=v.transaction_id "
        "WHERE v.session_id=? AND v.needs_invoice=? ORDER BY t.date",
        (session_id, needs_invoice),
    ).fetchall()
