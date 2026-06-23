"""Extract transactions from a bank statement PDF.

Strategy:
  1. Detect the bank format from the first page's text.
  2. Try pdfplumber table extraction; map columns via the format profile.
  3. If no usable table, fall back to a line-by-line regex heuristic.

Every transaction is normalised to:
  {date(ISO), description, reference, amount(>0), direction('debit'|'credit'),
   source_file, raw_text}

`recognized` on the result tells the UI whether to warn the user to eyeball the
extracted rows (True for a known bank, False for the GENERIC fallback).
"""
import os
import re

import pdfplumber
from dateutil import parser as dateparser

from parsers.bank_formats import detect_format, GENERIC

# A money token like 1,234.56 or 1234.56 (optionally trailing DR/CR)
_MONEY = r"[\d,]+\.\d{2}"
_DATE_AT_START = re.compile(r"^\s*(\d{1,2}[/\-\s][A-Za-z0-9]{2,9}[/\-\s]\d{2,4})\b")
_INV_REF = re.compile(r"\bINV[-\s]?\d{4,}\b", re.IGNORECASE)


def _to_iso(token):
    try:
        return dateparser.parse(token.strip(), dayfirst=True).date().isoformat()
    except (ValueError, OverflowError, TypeError):
        return None


def _money(token):
    if token is None:
        return None
    t = str(token).replace(",", "").strip()
    t = re.sub(r"\s*(DR|CR)\s*$", "", t, flags=re.IGNORECASE)
    if re.fullmatch(r"\d+\.\d{2}", t):
        return round(float(t), 2)
    return None


def _extract_ref(description):
    m = _INV_REF.search(description or "")
    if not m:
        return None
    return re.sub(r"\s", "", m.group(0)).upper().replace("INV", "INV-").replace("--", "-")


def _from_tables(page, fmt):
    rows = []
    for table in page.extract_tables() or []:
        for cells in table:
            cells = [(c or "").strip() for c in cells]
            if fmt.date_col is None or fmt.date_col >= len(cells):
                continue
            iso = _to_iso(cells[fmt.date_col])
            if not iso:
                continue
            desc = cells[fmt.desc_col] if fmt.desc_col < len(cells) else ""
            debit = _money(cells[fmt.debit_col]) if fmt.debit_col is not None and fmt.debit_col < len(cells) else None
            credit = _money(cells[fmt.credit_col]) if fmt.credit_col is not None and fmt.credit_col < len(cells) else None
            row = _build(iso, desc, debit, credit, " ".join(cells))
            if row:
                rows.append(row)
    return rows


def _from_lines(text):
    """Heuristic: a line begins with a date and ends with money amount(s)."""
    rows = []
    for line in (text or "").splitlines():
        if not _DATE_AT_START.search(line):
            continue
        iso = _to_iso(_DATE_AT_START.search(line).group(1))
        if not iso:
            continue
        amounts = re.findall(_MONEY + r"(?:\s*(?:DR|CR))?", line)
        parsed = [a for a in (_money(x) for x in amounts) if a is not None]
        if not parsed:
            continue
        # Strip the leading date and trailing numbers to get the description.
        desc = re.sub(_DATE_AT_START, "", line)
        desc = re.sub(_MONEY + r"(?:\s*(?:DR|CR))?", "", desc).strip(" -|\t")
        # Direction: explicit DR/CR suffix wins; else assume the first amount is
        # the movement and the last is the running balance.
        low = line.lower()
        if re.search(r"\bcr\b", low):
            credit, debit = parsed[0], None
        elif re.search(r"\bdr\b", low):
            debit, credit = parsed[0], None
        else:
            # Two+ numbers: first is the txn amount, last is balance (unknown sign).
            # Default unknown movements to debit so they surface for review.
            debit, credit = parsed[0], None
        row = _build(iso, desc, debit, credit, line)
        if row:
            rows.append(row)
    return rows


def _build(iso, desc, debit, credit, raw):
    if debit and debit > 0:
        amount, direction = debit, "debit"
    elif credit and credit > 0:
        amount, direction = credit, "credit"
    else:
        return None
    return {
        "date": iso,
        "description": desc,
        "reference": _extract_ref(desc),
        "amount": amount,
        "direction": direction,
        "raw_text": raw,
    }


def parse_bank_pdf(path):
    """Return (transactions, meta) where meta has format key + recognized flag."""
    transactions = []
    fmt = GENERIC
    with pdfplumber.open(path) as pdf:
        first_text = pdf.pages[0].extract_text() if pdf.pages else ""
        fmt = detect_format(first_text or "")
        for page in pdf.pages:
            page_rows = []
            if fmt.date_col is not None:
                page_rows = _from_tables(page, fmt)
            if not page_rows:
                page_rows = _from_lines(page.extract_text() or "")
            transactions.extend(page_rows)

    source = os.path.basename(path)
    for t in transactions:
        t["source_file"] = source

    meta = {"format": fmt.key, "recognized": fmt is not GENERIC}
    return transactions, meta
