"""FEMO Reconciliation Tool — local Flask app.

Run:  python app.py   ->  http://localhost:5000
Everything stays on this machine. No external calls.
"""
import io
import os
import uuid
import zipfile

from flask import (Flask, render_template, request, redirect, url_for,
                   session, send_file, jsonify, flash)

import config
from db import models, queries
from parsers.invoice_csv import parse_invoice_csv
from parsers.bank_pdf import parse_bank_pdf
from engine.matcher import match_income
from generator.voucher import generate_voucher

app = Flask(__name__)
app.secret_key = config.SECRET_KEY

os.makedirs(config.UPLOAD_DIR, exist_ok=True)
os.makedirs(config.VOUCHER_DIR, exist_ok=True)
models.init_db()


def _sid():
    if "sid" not in session:
        session["sid"] = uuid.uuid4().hex
    return session["sid"]


def _money(v):
    try:
        return f"{config.CURRENCY_SYMBOL} {float(v):,.2f}"
    except (TypeError, ValueError):
        return f"{config.CURRENCY_SYMBOL} 0.00"


app.jinja_env.filters["money"] = _money


@app.route("/")
def index():
    return redirect(url_for("upload"))


@app.route("/upload", methods=["GET", "POST"])
def upload():
    if request.method == "GET":
        return render_template("upload.html", cfg=config)

    sid = _sid()
    conn = models.connect()
    queries.clear_session(conn, sid)

    warnings = []
    # --- invoices CSV ---
    csv_file = request.files.get("invoices_csv")
    inv_rows = []
    if csv_file and csv_file.filename:
        csv_path = os.path.join(config.UPLOAD_DIR, f"{sid}_{csv_file.filename}")
        csv_file.save(csv_path)
        try:
            for inv in parse_invoice_csv(csv_path):
                inv["id"] = queries.insert_invoice(conn, sid, inv)
                inv_rows.append(inv)
        except ValueError as e:
            flash(f"Invoice CSV error: {e}", "error")

    # --- bank statements (one or more PDFs) ---
    txn_rows = []
    for pdf_file in request.files.getlist("bank_pdfs"):
        if not pdf_file or not pdf_file.filename:
            continue
        pdf_path = os.path.join(config.UPLOAD_DIR, f"{sid}_{pdf_file.filename}")
        pdf_file.save(pdf_path)
        try:
            txns, meta = parse_bank_pdf(pdf_path)
        except Exception as e:  # pdfplumber raises various low-level errors
            flash(f"Could not read {pdf_file.filename}: {e}", "error")
            continue
        if not meta["recognized"]:
            warnings.append(f"{pdf_file.filename}: bank format not recognised — "
                            "please review the extracted rows carefully.")
        if not txns:
            warnings.append(f"{pdf_file.filename}: no transactions detected.")
        for t in txns:
            t["id"] = queries.insert_transaction(conn, sid, t)
            txn_rows.append(t)

    # --- run income matcher ---
    matches = match_income(txn_rows, inv_rows)
    for m in matches:
        queries.insert_income_match(conn, sid, m["transaction_id"], m["invoice_id"],
                                    m["score"], m["method"])
    conn.commit()
    conn.close()

    for w in warnings:
        flash(w, "warning")
    flash(f"Loaded {len(inv_rows)} invoices and {len(txn_rows)} bank transactions; "
          f"{len(matches)} income matches suggested.", "success")
    return redirect(url_for("income"))


@app.route("/income")
def income():
    conn = models.connect()
    sid = _sid()
    data = {
        "matches": queries.get_income_matches(conn, sid),
        "unpaid": queries.get_unpaid_invoices(conn, sid),
        "uninvoiced": queries.get_uninvoiced_deposits(conn, sid),
    }
    conn.close()
    return render_template("income.html", cfg=config, **data)


@app.route("/match/<int:match_id>/<action>", methods=["POST"])
def match_action(match_id, action):
    if action not in ("confirm", "reject"):
        return jsonify({"ok": False}), 400
    conn = models.connect()
    queries.set_match_status(conn, match_id,
                             "confirmed" if action == "confirm" else "rejected")
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/expenses")
def expenses():
    conn = models.connect()
    debits = queries.get_debits_with_vouchers(conn, _sid())
    conn.close()
    return render_template("expenses.html", cfg=config, debits=debits)


@app.route("/voucher", methods=["POST"])
def voucher():
    sid = _sid()
    txn_id = int(request.form["transaction_id"])
    payee = request.form.get("payee", "").strip()
    purpose = request.form.get("purpose", "").strip()
    category = request.form.get("category", "").strip()
    needs_invoice = 1 if request.form.get("needs_invoice") else 0

    conn = models.connect()
    txn = conn.execute("SELECT * FROM transactions WHERE id=?", (txn_id,)).fetchone()
    if not txn:
        conn.close()
        return jsonify({"ok": False, "error": "transaction not found"}), 404

    # Reserve a voucher row first to get a stable id for the filename.
    vid = queries.upsert_voucher(conn, sid, txn_id, payee, purpose, category,
                                 needs_invoice, output_path=None)
    path = generate_voucher(vid, dict(txn), payee, purpose, category)
    queries.upsert_voucher(conn, sid, txn_id, payee, purpose, category,
                           needs_invoice, output_path=path)
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "voucher_id": vid,
                    "download": url_for("download_voucher", voucher_id=vid)})


@app.route("/voucher/<int:voucher_id>/download")
def download_voucher(voucher_id):
    conn = models.connect()
    v = queries.get_voucher(conn, voucher_id)
    conn.close()
    if not v or not v["output_path"] or not os.path.exists(v["output_path"]):
        return "Voucher not found", 404
    return send_file(v["output_path"], as_attachment=True,
                     download_name=os.path.basename(v["output_path"]))


@app.route("/chase")
def chase():
    conn = models.connect()
    pending = queries.get_vouchers(conn, _sid(), needs_invoice=1)
    conn.close()
    return render_template("chase.html", cfg=config, pending=pending)


@app.route("/summary")
def summary():
    conn = models.connect()
    sid = _sid()
    invoices = queries.get_invoices(conn, sid)
    credits = queries.get_transactions(conn, sid, "credit")
    debits = queries.get_transactions(conn, sid, "debit")
    unpaid = queries.get_unpaid_invoices(conn, sid)
    uninvoiced = queries.get_uninvoiced_deposits(conn, sid)
    vouchers = queries.get_vouchers(conn, sid)
    voucher_txn_ids = {v["transaction_id"] for v in vouchers}
    conn.close()

    s = {
        "total_invoiced": sum(i["total"] for i in invoices),
        "total_deposits": sum(t["amount"] for t in credits),
        "total_outgoings": sum(t["amount"] for t in debits),
        "unpaid_count": len(unpaid),
        "unpaid_total": sum(i["total"] for i in unpaid),
        "uninvoiced_count": len(uninvoiced),
        "uninvoiced_total": sum(t["amount"] for t in uninvoiced),
        "debit_count": len(debits),
        "documented_count": sum(1 for d in debits if d["id"] in voucher_txn_ids),
        "documented_total": sum(d["amount"] for d in debits if d["id"] in voucher_txn_ids),
        "undocumented_total": sum(d["amount"] for d in debits if d["id"] not in voucher_txn_ids),
    }
    return render_template("summary.html", cfg=config, s=s)


@app.route("/export/zip")
def export_zip():
    conn = models.connect()
    vouchers = queries.get_vouchers(conn, _sid())
    conn.close()
    paths = [v["output_path"] for v in vouchers
             if v["output_path"] and os.path.exists(v["output_path"])]
    if not paths:
        flash("No vouchers generated yet.", "warning")
        return redirect(url_for("expenses"))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in paths:
            zf.write(p, os.path.basename(p))
    buf.seek(0)
    return send_file(buf, as_attachment=True, download_name="femo_payment_vouchers.zip",
                     mimetype="application/zip")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
