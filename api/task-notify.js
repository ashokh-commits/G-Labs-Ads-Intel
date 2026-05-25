/**
 * G6 Labs — Task Notification
 * Sends email via Resend when a task is assigned
 */

const RESEND_KEY = process.env.RESEND_API_KEY;

const ASSIGNEE_EMAILS = {
  ashokh: 'ashokh@trisquare.com.my',
  diva:   'diva@g6labs.asia',
  anisa:  'anisa@g6labs.asia',
  all:    null, // no email for 'all'
};

module.exports = async function sendTaskNotification(task, assignedBy) {
  if (!RESEND_KEY) return;
  const email = ASSIGNEE_EMAILS[task.assignee];
  if (!email) return;

  const priorityColor = { urgent:'#ef4444', high:'#f59e0b', medium:'#4f9cf9', low:'#8b92a8' };
  const catEmoji      = { ads:'📊', content:'✍️', design:'🎨', report:'📋', general:'📌' };

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#0f1117;font-family:Arial,sans-serif">
<div style="max-width:560px;margin:0 auto">
  <div style="background:#181b23;border:1px solid #2a2f42;border-radius:12px 12px 0 0;padding:20px 24px">
    <div style="font-size:15px;font-weight:600;color:#e8ecf4">G6 Labs — Task Manager</div>
    <div style="font-size:11px;color:#8b92a8;margin-top:3px">New task assigned to you</div>
  </div>
  <div style="background:#1e2230;border:1px solid #2a2f42;border-top:none;padding:22px 24px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
      <span style="font-size:22px">${catEmoji[task.category]||'📌'}</span>
      <div>
        <div style="font-size:16px;font-weight:600;color:#e8ecf4">${task.title}</div>
        <div style="font-size:12px;color:#8b92a8;margin-top:2px">${task.frequency} · ${task.category}</div>
      </div>
    </div>
    ${task.description ? `<div style="font-size:13px;color:#8b92a8;margin-bottom:14px;padding:12px;background:#111318;border-radius:8px;line-height:1.6">${task.description}</div>` : ''}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      <span style="font-size:11px;padding:3px 10px;border-radius:4px;background:${priorityColor[task.priority]||'#4f9cf9'}22;color:${priorityColor[task.priority]||'#4f9cf9'};font-weight:600;border:1px solid ${priorityColor[task.priority]||'#4f9cf9'}44">${(task.priority||'medium').toUpperCase()}</span>
      ${task.due_date ? `<span style="font-size:11px;padding:3px 10px;border-radius:4px;background:#2d1a00;color:#f59e0b;border:1px solid #f59e0b44">Due: ${task.due_date}${task.due_time?' at '+task.due_time:''}</span>` : ''}
    </div>
    <div style="font-size:12px;color:#5a6080">Assigned by <strong style="color:#8b92a8">${assignedBy}</strong></div>
  </div>
  <div style="background:#181b23;border:1px solid #2a2f42;border-top:none;border-radius:0 0 12px 12px;padding:16px 24px;text-align:center">
    <a href="https://g6labs.vercel.app" style="display:inline-block;background:#4f9cf9;color:#fff;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none">Open Task Manager →</a>
    <div style="font-size:10px;color:#5a6080;margin-top:12px">G6 Labs Asia · Task Manager</div>
  </div>
</div></body></html>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from:    'G6 Task Manager <alerts@resend.dev>',
        to:      [email],
        subject: `📋 New task assigned: ${task.title}`,
        html,
      }),
    });
    const d = await r.json();
    console.log('[Task Notify] Sent to', email, '— ID:', d.id);
  } catch(e) {
    console.error('[Task Notify] Failed:', e.message);
  }
};
