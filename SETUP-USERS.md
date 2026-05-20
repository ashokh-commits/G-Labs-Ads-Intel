# G6 Labs Dashboard — Login Setup Guide

## Step 1: Add 2 env variables in Netlify

Go to: Netlify → Project configuration → Environment variables

### JWT_SECRET
Key: JWT_SECRET
Value: make up a long random string e.g. "G6LabsAsia2026!SecretXkP9mQnR7"
Keep this secret. Never share it.

### USERS_CONFIG
Key: USERS_CONFIG
Value: the JSON from Step 3 below

---

## Step 2: Generate password hashes

After first deploy, open browser console on any page and run:

```js
fetch('/api/auth/hash', {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ password: 'the_password_here', secret: 'YOUR_JWT_SECRET' })
}).then(r=>r.json()).then(console.log)
```

Copy the "hash" value. Do this for each user with their own password.

---

## Step 3: Set USERS_CONFIG in Netlify

```json
[
  {
    "userId": "ashokh",
    "name": "Ashokh",
    "passwordHash": "HASH_FROM_STEP_2",
    "role": "admin",
    "accounts": ["*"]
  },
  {
    "userId": "isihat_client",
    "name": "I-Sihat",
    "passwordHash": "HASH_FROM_STEP_2",
    "role": "client",
    "accounts": ["854069203683598"]
  },
  {
    "userId": "angdental_client",
    "name": "Ang Dental",
    "passwordHash": "HASH_FROM_STEP_2",
    "role": "client",
    "accounts": ["523654495274543"]
  }
]
```

### Role permissions:
- admin  → sees all accounts, all features
- client → sees ONLY their assigned account IDs

### Account IDs:
- I-Sihat Dental Care 2: 854069203683598
- I-Sihat Dental Care:   185825224320502
- Ang Dental:            523654495274543
- Toothland Dental:      429121129294808
- Putih Dental:          548718067784065
- Smile Borneo:          5841452755981834
- Purple Antz:           1027194858744741
- SVASIKA:               509470387773096

---

## Step 4: Redeploy

Netlify → Deploys → Trigger deploy → Deploy site

---

## Security features:
- Passwords hashed with HMAC-SHA256, never stored plain
- JWT tokens expire after 4 hours
- Token in memory only (not localStorage — XSS safe)
- 5 failed attempts = 15 min IP lockout
- Client accounts enforced server-side
- All API calls require valid token
