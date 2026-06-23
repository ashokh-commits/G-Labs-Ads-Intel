# FEMO Reconciliation Tool

A 100% **local** web app for FEMO Malaysia (sole proprietor, non-SST) to:

1. **Reconcile income** — match Zoho Books sales-invoice CSV exports to incoming
   Hong Leong bank deposits. Flags unpaid invoices and deposits with no invoice.
2. **Document expenses** — for outgoing payments with no supplier invoice,
   generate an **internal payment voucher** (clearly self-generated, *not* a fake
   supplier invoice) plus a chase-list of invoices still to obtain.

Nothing leaves your machine. No API keys.

## ⚠️ Important — legal
The expense vouchers are **internal bookkeeping records only**. They are clearly
marked "NOT A SUPPLIER TAX INVOICE" and **cannot** be used on their own to claim
tax deductions. Always obtain the genuine supplier invoice where one exists.
Fabricating invoices that impersonate a vendor is fraud under the Income Tax Act
1967 — this tool deliberately does not do that.

## Setup

```bash
cd femo-reconcile
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
python app.py
# open http://localhost:5000
```

## Try it with sample data

```bash
python tests/make_sample_statement.py     # builds sample/sample_statement.pdf
```
Then on the Upload page choose `sample/sample_invoices.csv` and
`sample/sample_statement.pdf`.

## Tests

```bash
pip install pytest
pytest
```

## Adding another bank
Edit `parsers/bank_formats.py` and add a `BankFormat` entry with the right
header regex and column indices. No other code changes needed.
