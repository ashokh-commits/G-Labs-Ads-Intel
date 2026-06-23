"""Income matching: pair incoming bank deposits (credits) with sales invoices.

Priority:
  1. Invoice number present in the deposit reference/description -> score 1.0.
  2. Exact full-amount match within the date window -> scored by date proximity.
  3. Fuzzy customer-name vs description as a weak tiebreaker.

Each invoice is matched at most once (greedy by score). Returns a list of match
dicts ready for db.queries.insert_income_match.
"""
import re

from rapidfuzz import fuzz
from dateutil import parser as dateparser

import config


def _norm_inv(text):
    """Normalise an invoice token for comparison: keep trailing digits."""
    if not text:
        return None
    m = re.search(r"(\d{4,})\s*$", text.strip())
    return m.group(1) if m else None


def _days_apart(a_iso, b_iso):
    try:
        a = dateparser.parse(a_iso).date()
        b = dateparser.parse(b_iso).date()
        return abs((a - b).days)
    except (ValueError, TypeError, OverflowError):
        return None


def _date_score(days):
    if days is None:
        return 0.3
    if days == 0:
        return 1.0
    if days <= 3:
        return 0.9
    if days <= 7:
        return 0.7
    if days <= 14:
        return 0.4
    if days <= config.DATE_WINDOW_DAYS:
        return 0.1
    return 0.0


def _amount_match(txn_amount, inv_total):
    return abs(round(txn_amount - inv_total, 2)) <= config.AMOUNT_TOLERANCE


def _ref_contains_invoice(txn, invoice):
    inv_digits = _norm_inv(invoice["invoice_number"])
    if not inv_digits:
        return False
    haystack = f"{txn.get('reference') or ''} {txn.get('description') or ''}"
    digits_in_text = re.findall(r"\d{4,}", haystack)
    return any(inv_digits in d or d in inv_digits for d in digits_in_text)


def match_income(transactions, invoices):
    """transactions/invoices are dict-like rows with an 'id' key.

    Returns list of dicts: transaction_id, invoice_id, score, method.
    """
    credits = [t for t in transactions if t["direction"] == "credit"]
    used_invoices = set()
    results = []

    # Pass 1: invoice-number reference (strongest signal).
    for txn in credits:
        for inv in invoices:
            if inv["id"] in used_invoices:
                continue
            if _ref_contains_invoice(txn, inv):
                results.append({"transaction_id": txn["id"], "invoice_id": inv["id"],
                                "score": 1.0, "method": "reference"})
                used_invoices.add(inv["id"])
                txn["_matched"] = True
                break

    # Pass 2 + 3: amount/date and fuzzy name for whatever is left.
    for txn in credits:
        if txn.get("_matched"):
            continue
        best = None
        for inv in invoices:
            if inv["id"] in used_invoices:
                continue
            if not _amount_match(txn["amount"], inv["total"]):
                continue
            days = _days_apart(txn["date"], inv["invoice_date"])
            date_s = _date_score(days)
            name_ratio = fuzz.token_sort_ratio(
                (txn.get("description") or "").upper(),
                (inv["customer_name"] or "").upper(),
            ) / 100.0
            name_s = name_ratio if name_ratio >= config.NAME_FUZZY_FLOOR else 0.0
            # Amount already matched exactly -> full amount weight.
            score = (config.WEIGHT_AMOUNT * 1.0
                     + config.WEIGHT_DATE * date_s
                     + config.WEIGHT_NAME * name_s)
            method = "fuzzy" if name_s > 0 else "amount_date"
            if best is None or score > best["score"]:
                best = {"transaction_id": txn["id"], "invoice_id": inv["id"],
                        "score": round(score, 3), "method": method}
        if best and best["score"] >= config.SUGGEST_THRESHOLD:
            results.append(best)
            used_invoices.add(best["invoice_id"])

    return results
