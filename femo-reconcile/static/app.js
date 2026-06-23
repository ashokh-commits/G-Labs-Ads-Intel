// Minimal AJAX glue: confirm/reject income matches, generate expense vouchers.

document.addEventListener("click", async (e) => {
  // --- income confirm / reject ---
  const mbtn = e.target.closest("button[data-match]");
  if (mbtn) {
    const id = mbtn.dataset.match;
    const action = mbtn.dataset.action;
    const res = await fetch(`/match/${id}/${action}`, { method: "POST" });
    if (!res.ok) return alert("Action failed");
    const row = document.getElementById(`match-${id}`);
    if (action === "confirm") {
      row.classList.add("status-confirmed");
      mbtn.parentElement.innerHTML = '<span class="tag tag-ok">Confirmed</span>';
    } else {
      row.classList.add("status-rejected");
      row.querySelector("td:last-child").innerHTML = '<span class="muted">Rejected</span>';
    }
    return;
  }

  // --- generate voucher ---
  const gbtn = e.target.closest(".gen-voucher");
  if (gbtn) {
    const row = gbtn.closest(".expense-row");
    const payload = new URLSearchParams({
      transaction_id: row.dataset.txn,
      payee: row.querySelector(".f-payee").value,
      purpose: row.querySelector(".f-purpose").value,
      category: row.querySelector(".f-category").value,
      needs_invoice: row.querySelector(".f-needs").checked ? "1" : "",
    });
    gbtn.disabled = true;
    gbtn.textContent = "…";
    const res = await fetch("/voucher", { method: "POST", body: payload });
    gbtn.disabled = false;
    gbtn.textContent = "Generate";
    const data = await res.json();
    if (!data.ok) return alert("Voucher failed: " + (data.error || ""));
    row.querySelector(".vlink").innerHTML =
      `<a href="${data.download}">PDF</a>`;
  }
});
