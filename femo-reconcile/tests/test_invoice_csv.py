import os

from parsers.invoice_csv import parse_invoice_csv

SAMPLE = os.path.join(os.path.dirname(__file__), "..", "sample", "sample_invoices.csv")


def _by_number(rows):
    return {r["invoice_number"]: r for r in rows}


def test_groups_multirow_invoice_once():
    rows = parse_invoice_csv(SAMPLE)
    nums = [r["invoice_number"] for r in rows]
    # INV-250017 spans 6 line-item rows but must appear exactly once.
    assert nums.count("FEMO-INV-250017") == 1


def test_uses_invoice_total_not_line_item():
    rows = _by_number(parse_invoice_csv(SAMPLE))
    assert rows["FEMO-INV-250017"]["total"] == 6933.00
    assert rows["FEMO-INV-250014"]["total"] == 1635.66   # tax-inclusive
    assert rows["FEMO-INV-250018"]["total"] == 3240.00


def test_core_fields_present():
    rows = _by_number(parse_invoice_csv(SAMPLE))
    inv = rows["FEMO-INV-250007"]
    assert inv["customer_name"] == "Toothland Dental Clinic"
    assert inv["invoice_date"] == "2025-04-01"
    assert inv["total"] == 3000.00
