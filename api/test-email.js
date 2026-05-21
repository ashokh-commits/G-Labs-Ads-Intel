const RESEND_KEY  = process.env.RESEND_API_KEY;
const ALERT_EMAIL = 'ashokh@trisquare.com.my';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (!RESEND_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not set' });

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#0f1117;font-family:Arial,sans-serif">
    <div style="max-width:600px;margin:0 auto;background:#181b23;border:1px solid #2a2f42;border-radius:12px;overflow:hidden">
      <div style="padding:22px 28px;border-bottom:1px solid #2a2f42">
        <div style="font-size:15px;font-weight:600;color:#e8ecf4">G6 Labs Ads Intelligence</div>
        <div style="font-size:11px;color:#8b92a8;margin-top:2px">Email test · ${new Date().toLocaleString('en-MY',{timeZone:'Asia/Kuala_Lumpur',hour12:true})}</div>
      </div>
      <div style="background:#052e16;border-top:none;padding:18px 28px">
        <div style="font-size:14px;font-weight:600;color:#4ade80">✅ Email alerts are working correctly</div>
        <div style="font-size:12px;color:#86efac;margin-top:6px">Delivering to <strong>${ALERT_EMAIL}</strong> via Resend.</div>
      </div>
      <div style="padding:18px 28px;text-align:center">
        <div style="font-size:11px;color:#5a6080">G6 Labs Asia · Automated alert system · Checks every 15 minutes</div>
      </div>
    </div>
  </body></html>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: 'G6 Ads Alert <alerts@resend.dev>', to: [ALERT_EMAIL], subject: '✅ G6 Ads Alert — Email test successful', html }),
    });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error });
    return res.status(200).json({ success: true, message: `Test email sent to ${ALERT_EMAIL}`, id: data.id });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
