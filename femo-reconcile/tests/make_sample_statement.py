"""Generate a synthetic Hong-Leong-style statement PDF for testing/demo.

Run: python tests/make_sample_statement.py
Writes sample/sample_statement.pdf with a few debits and credits, including a
deposit that references INV-250017 so the matcher has something to find.
"""
import os

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

OUT = os.path.join(os.path.dirname(__file__), "..", "sample", "sample_statement.pdf")

ROWS = [
    # date         description                              debit      credit
    ("02/07/2025", "IBG TRANSFER FROM THE VOICE INV-250017", "",        "6,933.00"),
    ("03/04/2025", "FT TOOTHLAND DENTAL CLINIC",             "",        "3,000.00"),
    ("05/06/2025", "GLOBAL REPRO SDN BHD PRINTING",          "1,373.00", ""),
    ("06/06/2025", "GOOGLE ADS MALAYSIA",                    "542.26",  ""),
    ("10/06/2025", "META PLATFORMS ADVERTISING",             "379.67",  ""),
]


def main():
    c = canvas.Canvas(OUT, pagesize=A4)
    w, h = A4
    c.setFont("Helvetica-Bold", 14)
    c.drawString(40, h - 50, "HONG LEONG BANK")
    c.setFont("Helvetica", 9)
    c.drawString(40, h - 66, "Statement of Account  39500285955  FEMO MALAYSIA")

    c.setFont("Helvetica-Bold", 9)
    y = h - 95
    c.drawString(40, y, "Date")
    c.drawString(110, y, "Description")
    c.drawString(360, y, "Withdrawal")
    c.drawString(440, y, "Deposit")
    c.drawString(510, y, "Balance")
    c.setFont("Helvetica", 9)
    bal = 10000.0
    for date, desc, debit, credit in ROWS:
        y -= 18
        if debit:
            bal -= float(debit.replace(",", ""))
        if credit:
            bal += float(credit.replace(",", ""))
        c.drawString(40, y, date)
        c.drawString(110, y, desc)
        c.drawString(360, y, debit)
        c.drawString(440, y, credit)
        c.drawString(510, y, f"{bal:,.2f}")
    c.showPage()
    c.save()
    print("wrote", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
