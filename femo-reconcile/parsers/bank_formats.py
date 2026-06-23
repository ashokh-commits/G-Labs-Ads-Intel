"""Bank statement format profiles.

Each profile knows how to recognise its statement (header_pattern) and where the
columns sit. Adding a new bank = add one BankFormat entry. The GENERIC profile is
the fallback heuristic when no header matches.
"""
import re
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class BankFormat:
    key: str
    header_pattern: str          # regex tested against first-page text
    date_formats: List[str] = field(default_factory=list)  # dateutil handles most; hints only
    # Column index map for pdfplumber table rows (0-based). None => use heuristic.
    date_col: Optional[int] = None
    desc_col: Optional[int] = None
    debit_col: Optional[int] = None
    credit_col: Optional[int] = None


# Hong Leong statements commonly render: Date | Description | Withdrawal | Deposit | Balance
HONG_LEONG = BankFormat(
    key="HONG_LEONG",
    header_pattern=r"(HONG\s*LEONG)|(Withdrawal.*Deposit.*Balance)|(Debit.*Credit.*Balance)",
    date_col=0, desc_col=1, debit_col=2, credit_col=3,
)

GENERIC = BankFormat(key="GENERIC", header_pattern=r".*")

FORMATS = [HONG_LEONG]  # GENERIC is the explicit fallback, not auto-matched


def detect_format(first_page_text: str) -> BankFormat:
    text = first_page_text or ""
    for fmt in FORMATS:
        if re.search(fmt.header_pattern, text, re.IGNORECASE | re.DOTALL):
            return fmt
    return GENERIC
