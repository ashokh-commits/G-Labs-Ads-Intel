const crypto = require('crypto');

const META_TOKEN  = process.env.META_ACCESS_TOKEN;
const RESEND_KEY  = process.env.RESEND_API_KEY;
const ALERT_EMAIL = 'ashokh@trisquare.com.my';
const BASE        = 'https://graph.facebook.com/v21.0';

const ACCOUNTS = [
  { id: '854069203683598',  name: 'I-Sihat Dental Care 2' },
  { id: '185825224320502',  name: 'I-Sihat Dental Care' },
  { id: '523654495274543',  name: 'Ang Dental' },
  { id: '429121129294808',  name: 'Toothland Dental' },
  { id: '548718067784065',  name: 'Putih Dental' },
  { id: '5841452755981834', name: 'Smile Borneo' },
  { id: '1027194858744741', name: 'Purple Antz' },
  { id: '509470387773096',  name: 'SVASIKA' },
];

const THRESHOLDS = { CPL: parseFloat(process.env.THRESHOLD_CPL||'15'), CTR: parseFloat(process.env.THRESHOLD_CTR||'0.5'), FREQ: parseFloat(process.env.THRESHOLD_FREQ||'3') };

function fmtDate(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function getMonthStart(){const d=new Date();return fmtDate(new Date(d.getFullYear(),d.getMonth(),1))}
function getYesterday(){const d=new Date();d.setDate(d.getDate()-1);return fmtDate(d)}
function getMonthLabel(){return new Date().toLocaleString('en-MY',{month:'long',year:'numeric'})}
function getNowMY(){return new Date().toLocaleString('en-MY',{timeZone:'Asia/Kuala_Lumpur',weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:true})}
function rm(v){const n=parseFloat(v)||0;return 'RM '+n.toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2})}

async function fetchAds(accountId, since, until) {
  const fields = 'name,status,effective_status,campaign{name},insights{spend,impressions,ctr,frequency,cost_per_result,actions,results}';
  const filtering = JSON.stringify([{field:'impressions',operator:'GREATER_THAN',value:'0'}]);
  const url = `${BASE}/act_${accountId}/ads?fields=${encodeURIComponent(fields)}&time_range=${encodeURIComponent(JSON.stringify({since,until}))}&filtering=${encodeURIComponent(filtering)}&limit=200&access_token=${META_TOKEN}`;
  const r = await fetch(url);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return (data.data||[]).map(ad=>{
    const ins=ad.insights?.data?.[0]||{};
    let cpr='0';
    if(Array.isArray(ins.cost_per_result)&&ins.cost_per_result.length>0) cpr=ins.cost_per_result[0].value||'0';
    else if(typeof ins.cost_per_result==='string') cpr=ins.cost_per_result;
    let convs=0,clicks=0;
    if(Array.isArray(ins.actions)){
      const msg=ins.actions.find(a=>a.action_type==='onsite_conversion.messaging_conversation_started_7d'||a.action_type==='onsite_conversion.messaging_conversation_started');
      const lc=ins.actions.find(a=>a.action_type==='link_click');
      convs=parseInt(msg?.value||0);clicks=parseInt(lc?.value||0);
    }
    const spend=parseFloat(ins.spend||0);
    if(parseFloat(cpr)===0){if(convs>0)cpr=(spend/convs).toFixed(2);else if(clicks>0)cpr=(spend/clicks).toFixed(2);}
    return{name:ad.name||'Unnamed',camp:ad.campaign?.name||'',status:(ad.effective_status||ad.status||'').toLowerCase(),spend,impr:parseInt(ins.impressions||0),ctr:parseFloat(ins.ctr||0),freq:parseFloat(ins.frequency||0),cpr:parseFloat(cpr)||0};
  }).filter(ad=>ad.spend>0||ad.impr>0);
}

function checkAlerts(ad){
  const al=[],wa=[];
  if(ad.status==='active'&&ad.spend===0&&ad.impr===0) al.push({level:'critical',text:'Active but not delivering — zero impressions'});
  if(ad.cpr>0&&ad.cpr>THRESHOLDS.CPL) al.push({level:'critical',text:`CPL ${rm(ad.cpr)} exceeds RM ${THRESHOLDS.CPL} threshold`});
  if(ad.impr>500&&ad.ctr>0&&ad.ctr<THRESHOLDS.CTR) wa.push({level:'warning',text:`CTR ${ad.ctr.toFixed(2)}% below ${THRESHOLDS.CTR}% threshold`});
  if(ad.freq>THRESHOLDS.FREQ) wa.push({level:'warning',text:`Frequency ${ad.freq.toFixed(2)}× — audience fatigue risk`});
  return{al,wa};
}

async function sendEmail(subject, html) {
  if(!RESEND_KEY){console.error('[Alert] RESEND_API_KEY not set');return;}
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${RESEND_KEY}`},body:JSON.stringify({from:'G6 Ads Alert <alerts@resend.dev>',to:[ALERT_EMAIL],subject,html})});
  const d=await r.json();
  if(d.error)console.error('[Alert] Resend error:',JSON.stringify(d.error));
  else console.log('[Alert] Email sent:',d.id);
}

module.exports = async (req, res) => {
  const since=getMonthStart();let until=getYesterday();if(until<since)until=since; // 1st of month: yesterday is prev month → clamp (FB #100)
  console.log(`[Alert] Checking ${ACCOUNTS.length} accounts — ${since} to ${until}`);
  const allIssues={};let totalCritical=0,totalWarnings=0;
  for(const acc of ACCOUNTS){
    try{
      const ads=await fetchAds(acc.id,since,until);
      const issues=[];
      for(const ad of ads){
        const{al,wa}=checkAlerts(ad);
        al.forEach(i=>{issues.push({ad:ad.name,camp:ad.camp,issue:i.text,level:'critical'});totalCritical++;});
        wa.forEach(i=>{issues.push({ad:ad.name,camp:ad.camp,issue:i.text,level:'warning'});totalWarnings++;});
      }
      allIssues[acc.name]=issues;
    }catch(e){console.error(`[Alert] Failed ${acc.name}:`,e.message);}
  }
  const total=totalCritical+totalWarnings;
  if(total>0){
    const now=getNowMY(),month=getMonthLabel();
    let rows='';
    for(const[accName,issues] of Object.entries(allIssues)){
      if(!issues.length)continue;
      issues.forEach(i=>{const red=i.level==='critical';rows+=`<tr><td style="padding:10px 14px;border-bottom:1px solid #2a2f42;font-size:12px;color:#e8ecf4">${accName}</td><td style="padding:10px 14px;border-bottom:1px solid #2a2f42;font-size:12px;color:#8b92a8">${i.ad}</td><td style="padding:10px 14px;border-bottom:1px solid #2a2f42;font-size:12px;color:${red?'#ef4444':'#f59e0b'};font-weight:500">${red?'🔴':'🟡'} ${i.issue}</td></tr>`;});
    }
    const subject=totalCritical>0?`🔴 G6 Ads Alert — ${totalCritical} critical issue${totalCritical>1?'s':''} detected`:`🟡 G6 Ads Alert — ${totalWarnings} warning${totalWarnings>1?'s':''} detected`;
    const html=`<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#0f1117;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto"><div style="background:#181b23;border:1px solid #2a2f42;border-radius:12px 12px 0 0;padding:20px 24px"><div style="font-size:15px;font-weight:600;color:#e8ecf4">G6 Labs Ads Intelligence</div><div style="font-size:11px;color:#8b92a8;margin-top:3px">${month} · ${now}</div></div><div style="background:${totalCritical>0?'#2d0808':'#2d1a00'};border:1px solid ${totalCritical>0?'#7f1d1d':'#854d0e'};border-top:none;padding:14px 24px"><div style="font-size:13px;font-weight:600;color:${totalCritical>0?'#f87171':'#fbbf24'}">${totalCritical>0?'🔴':'🟡'} ${total} issue${total>1?'s':''} detected</div></div><div style="background:#1e2230;border:1px solid #2a2f42;border-top:none"><table style="width:100%;border-collapse:collapse"><thead><tr style="background:#252a3a"><th style="padding:9px 14px;text-align:left;font-size:10px;color:#5a6080;text-transform:uppercase">Account</th><th style="padding:9px 14px;text-align:left;font-size:10px;color:#5a6080;text-transform:uppercase">Ad</th><th style="padding:9px 14px;text-align:left;font-size:10px;color:#5a6080;text-transform:uppercase">Issue</th></tr></thead><tbody>${rows}</tbody></table></div><div style="background:#181b23;border:1px solid #2a2f42;border-top:none;border-radius:0 0 12px 12px;padding:18px 24px;text-align:center"><a href="https://g6labsasia.vercel.app" style="display:inline-block;background:#4f9cf9;color:#fff;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none">View Dashboard →</a><div style="font-size:10px;color:#5a6080;margin-top:12px">G6 Labs Asia · Checks every 15 mins</div></div></div></body></html>`;
    await sendEmail(subject,html);
  }else{console.log('[Alert] All clear');}
  return res.status(200).json({checked:ACCOUNTS.length,issues:total});
};
