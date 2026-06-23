from engine.matcher import match_income


def _inv(id, number, total, date, customer="Acme"):
    return {"id": id, "invoice_number": number, "total": total,
            "invoice_date": date, "customer_name": customer}


def _txn(id, amount, date, direction="credit", desc="", ref=None):
    return {"id": id, "amount": amount, "date": date, "direction": direction,
            "description": desc, "reference": ref}


def test_invoice_number_reference_scores_full():
    invoices = [_inv(1, "FEMO-INV-250017", 6933.00, "2025-06-28")]
    txns = [_txn(10, 6933.00, "2025-07-02", desc="IBG TRANSFER INV-250017 VOICE")]
    res = match_income(txns, invoices)
    assert len(res) == 1
    assert res[0]["method"] == "reference"
    assert res[0]["score"] == 1.0


def test_amount_date_match_without_reference():
    invoices = [_inv(1, "FEMO-INV-250007", 3000.00, "2025-04-01", "Toothland Dental Clinic")]
    txns = [_txn(10, 3000.00, "2025-04-03", desc="TOOTHLAND DENTAL CLINIC PAYMENT")]
    res = match_income(txns, invoices)
    assert len(res) == 1
    assert res[0]["invoice_id"] == 1
    assert res[0]["score"] >= 0.70


def test_wrong_amount_does_not_match():
    invoices = [_inv(1, "FEMO-INV-250007", 3000.00, "2025-04-01")]
    txns = [_txn(10, 999.00, "2025-04-03", desc="RANDOM DEPOSIT")]
    res = match_income(txns, invoices)
    assert res == []


def test_invoice_matched_only_once():
    invoices = [_inv(1, "FEMO-INV-250007", 3000.00, "2025-04-01")]
    txns = [_txn(10, 3000.00, "2025-04-02", ref="INV-250007"),
            _txn(11, 3000.00, "2025-04-02", ref="INV-250007")]
    res = match_income(txns, invoices)
    assert len(res) == 1
