"""Parse a Zoho Books invoice CSV export into one record per invoice.

The export is multi-row: each line item of an invoice is its own row, but the
invoice-level columns (Total, Customer Name, Invoice Date...) repeat on every
row. We group by Invoice Number and keep the invoice-level figures once.
"""
import pandas as pd
from dateutil import parser as dateparser


REQUIRED_COLS = ["Invoice Number", "Total", "Customer Name", "Invoice Date"]


def _to_iso(value):
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        return dateparser.parse(s, dayfirst=False).date().isoformat()
    except (ValueError, OverflowError):
        return None


def _to_float(value):
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return 0.0
    try:
        return round(float(str(value).replace(",", "").strip()), 2)
    except ValueError:
        return 0.0


def parse_invoice_csv(path):
    """Return a list of dicts, one per unique invoice number.

    Each dict: invoice_number, customer_name, invoice_date, total, balance, status
    """
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    missing = [c for c in REQUIRED_COLS if c not in df.columns]
    if missing:
        raise ValueError(f"CSV missing expected columns: {missing}")

    invoices = []
    # Group preserving first-seen order so output is stable/testable.
    for inv_no, group in df.groupby("Invoice Number", sort=False):
        inv_no = (inv_no or "").strip()
        if not inv_no:
            continue
        first = group.iloc[0]
        total = _to_float(first.get("Total"))
        if total <= 0:
            continue  # skip blank / zero invoices
        invoices.append({
            "invoice_number": inv_no,
            "customer_name": (first.get("Customer Name") or "").strip(),
            "invoice_date": _to_iso(first.get("Invoice Date")),
            "total": total,
            "balance": _to_float(first.get("Balance")),
            "status": (first.get("Invoice Status") or "").strip(),
        })
    return invoices
