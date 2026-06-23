import os

import pdfplumber

from generator.voucher import generate_voucher


def test_voucher_pdf_marks_internal(tmp_path):
    txn = {"date": "2025-06-15", "description": "PAYMENT TO GLOBAL REPRO",
           "amount": 1373.00, "reference": None, "source_file": "hlb_jun.pdf"}
    path = generate_voucher(99, txn, payee="Global Repro Sdn Bhd",
                            purpose="Printing", category="Printing & Production",
                            out_dir=str(tmp_path))
    assert os.path.exists(path) and os.path.getsize(path) > 0
    with pdfplumber.open(path) as pdf:
        text = " ".join((p.extract_text() or "") for p in pdf.pages).upper()
    assert "INTERNAL PAYMENT VOUCHER" in text
    assert "NOT A SUPPLIER TAX INVOICE" in text
    assert "1,373.00" in text
