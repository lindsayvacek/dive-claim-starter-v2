# Dive Guide Claim — Starter (No Edge Functions)

Simplest path: a single **RPC** `claim_job(job_id)` in Postgres handles the race-safe claim.
The web app calls it directly, so you don't need the Supabase CLI or Edge Functions.

## 1) Supabase setup
- Create a project at https://supabase.com
- In SQL editor, paste and run `supabase/sql/schema.sql`
- In Authentication, enable **Email OTP** (or SMS later).
- Create yourself a row in `profiles` with your `auth.users.id` and set `role='admin'`.

## 2) Web app
```bash
cd web
cp .env.example .env  # fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

Open http://localhost:5173 and sign in with Email OTP.

## 3) Test the claim
Insert a test job in `jobs` (as admin). Open the web app on two devices and press **Claim** simultaneously. One wins, the other receives the "someone else claimed" message.
