"""Central configuration for the FEMO reconciliation tool.

All tunables live here so the rest of the code stays declarative.
"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# --- Company details (printed on vouchers) ---
COMPANY_NAME = "FEMO MALAYSIA"
COMPANY_BANK = "HONG LEONG"
COMPANY_ACCOUNT_NO = "39500285955"
CURRENCY = "MYR"
CURRENCY_SYMBOL = "RM"

# --- Paths ---
DB_PATH = os.path.join(BASE_DIR, "femo.db")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
VOUCHER_DIR = os.path.join(BASE_DIR, "generated", "vouchers")

# --- Matching ---
# Income matching tolerances. Amounts are matched on full invoice Total only (v1).
AMOUNT_TOLERANCE = 0.01          # ringgit; exact-match slack for float rounding
DATE_WINDOW_DAYS = 30            # deposit must fall within N days of invoice date
SUGGEST_THRESHOLD = 0.70         # composite score at/above which a match is suggested
NAME_FUZZY_FLOOR = 0.60          # rapidfuzz ratio (0-1) below which name is ignored

# Composite weights when matching by amount+date+name (no invoice-number ref present)
WEIGHT_AMOUNT = 0.55
WEIGHT_DATE = 0.30
WEIGHT_NAME = 0.15

# Expense voucher categories offered in the UI dropdown
EXPENSE_CATEGORIES = [
    "Advertising (Google/Meta Ads)",
    "Subcontractor / Freelancer",
    "Printing & Production",
    "Software & Subscriptions",
    "Bank Charges",
    "Office & Supplies",
    "Professional Fees",
    "Other",
]

# Flask
SECRET_KEY = "femo-reconcile-local-only"
