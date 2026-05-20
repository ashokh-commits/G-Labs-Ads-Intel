exports.handler = async () => {
  const RESEND_KEY  = process.env.RESEND_API_KEY;
  const ALERT_EMAIL = 'ashokh@trisquare.com.my';

  if (!RESEND_KEY) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'RESEND_API_KEY not set in environment variables' }),
    };
  }

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;background:#0f1117;font-family:'Helvetica Neue',Arial,sans-serif">
<div style="max-width:600px;margin:0 auto">

  <div style="background:#181b23;border:1px solid #2a2f42;border-radius:12px 12px 0 0;padding:22px 28px;display:flex;align-items:center">
    <div style="width:34px;height:34px;background:#4f9cf9;border-radius:8px;text-align:center;line-height:34px;font-weight:700;font-size:13px;color:#fff;margin-right:12px;flex-shrink:0">G6</div>
    <div>
      <div style="font-size:15px;font-weight:600;color:#e8ecf4">G6 Labs Ads Intelligence</div>
      <div style="font-size:11px;color:#8b92a8;margin-top:2px">Email test · ${new Date().toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', hour12: true })}</div>
    </div>
  </div>

  <div style="background:#052e16;border:1px solid #166534;border-top:none;padding:18px 28px">
    <div style="font-size:14px;font-weight:600;color:#4ade80">✅ Email alerts are working correctly</div>
    <div style="font-size:12px;color:#86efac;margin-top:6px">
      Your Resend API key is valid and emails are being delivered to <strong>${ALERT_EMAIL}</strong>.
      The alert scheduler will automatically send emails like this when issues are detected in your Meta Ads accounts.
    </div>
  </div>

  <div style="background:#1e2230;border:1px solid #2a2f42;border-top:none;padding:18px 28px">
    <div style="font-size:12px;color:#8b92a8;line-height:1.8">
      <div style="margin-bottom:8px;font-size:11px;color:#5a6080;text-transform:uppercase;letter-spacing:.07em;font-weight:600">Alert configuration</div>
      <div>📬 Sending to: <strong style="color:#e8ecf4">${ALERT_EMAIL}</strong></div>
      <div>⏱ Check frequency: <strong style="color:#e8ecf4">Every 15 minutes</strong></div>
      <div>🔴 CPL threshold: <strong style="color:#e8ecf4">RM ${process.env.THRESHOLD_CPL || '15'}</strong></div>
      <div>📉 CTR threshold: <strong style="color:#e8ecf4">${process.env.THRESHOLD_CTR || '0.5'}%</strong></div>
      <div>🔁 Frequency threshold: <strong style="color:#e8ecf4">${process.env.THRESHOLD_FREQ || '3'}×</strong></div>
    </div>
  </div>

  <div style="background:#181b23;border:1px solid #2a2f42;border-top:none;border-radius:0 0 12px 12px;padding:18px 28px;text-align:center">
    <a href="https://startling-sable-a03f13.netlify.app" style="display:inline-block;background:#4f9cf9;color:#fff;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none">
      View Dashboard →
    </a>
  </div>

  <div style="padding:14px 0;text-align:center;font-size:10px;color:#5a6080">
    G6 Labs Asia · This is a test email — no action required
  </div>
</div>
</body>
</html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_KEY}`,
      },
      body: JSON.stringify({
        from:    'G6 Ads Alert <alerts@resend.dev>',
        to:      [ALERT_EMAIL],
        subject: '✅ G6 Ads Alert — Email test successful',
        html,
      }),
    });

    const data = await res.json();

    if (data.error) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: data.error, message: 'Resend rejected the email — check your API key and domain setup' }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        message: `Test email sent to ${ALERT_EMAIL}`,
        resend_id: data.id,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
