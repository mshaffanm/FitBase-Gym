// Imports legacy gym data (members, payments, attendance) into FitBase Supabase.
// Usage (from project root, next to .env):
//   node import-legacy.mjs --dry-run     # preview only, writes nothing
//   node import-legacy.mjs               # real import (safe to re-run; skips what exists)
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const DRY = process.argv.includes('--dry-run');

// minimal .env loader
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const data = JSON.parse(fs.readFileSync('legacy-data.json', 'utf8'));
console.log(`Loaded: ${data.members.length} members, ${data.payments.length} payments, ${data.attendance.length} attendance rows` + (DRY ? '  [DRY RUN]' : ''));

async function fetchAll(table, cols) {
  const out = []; let from = 0;
  for (;;) {
    const { data: rows, error } = await sb.from(table).select(cols).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...rows); if (rows.length < 1000) break; from += 1000;
  }
  return out;
}
async function insertBatches(table, rows, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await sb.from(table).insert(rows.slice(i, i + size));
    if (error) throw new Error(`${table} batch @${i}: ${error.message}`);
    process.stdout.write(`\r  ${table}: ${Math.min(i + size, rows.length)}/${rows.length}`);
  }
  if (rows.length) process.stdout.write('\n');
}

// ---- 1. Members (auth user + profile) ----
const existing = await fetchAll('profiles', 'id,member_code,email');
const byCode = new Map(existing.map((p) => [p.member_code, p.id]));
const idMap = new Map(); // legacy_id -> uuid
const todo = [];
for (const m of data.members) {
  if (byCode.has(m.member_code)) idMap.set(m.legacy_id, byCode.get(m.member_code));
  else todo.push(m);
}
console.log(`Members already present: ${idMap.size}; to create: ${todo.length}`);

if (!DRY) {
  let done = 0, failed = 0;
  const queue = [...todo];
  async function worker() {
    while (queue.length) {
      const m = queue.shift();
      try {
        const { data: au, error: ae } = await sb.auth.admin.createUser({
          email: m.email, password: crypto.randomBytes(18).toString('base64url'),
          email_confirm: true, user_metadata: { name: m.name, legacy_id: m.legacy_id },
        });
        if (ae || !au.user) throw new Error(ae?.message || 'no user');
        const { error: pe } = await sb.from('profiles').insert({
          id: au.user.id, member_code: m.member_code, name: m.name, email: m.email, phone: m.phone,
          role: 'member', membership_tier: m.membership_tier,
          base_monthly_fee_pkr: m.base_monthly_fee_pkr, discount_pkr: 0, monthly_fee_pkr: m.monthly_fee_pkr,
          fee_status: m.fee_status, fee_paid_through: m.fee_paid_through,
          subscription_end_date: m.subscription_end_date, join_date: m.join_date,
          cnic_last4: m.cnic_last4, membership_active: m.membership_active,
          biometric_status: 'Not Enrolled', staff_notes: m.staff_notes,
        });
        if (pe) { await sb.auth.admin.deleteUser(au.user.id); throw new Error(pe.message); }
        idMap.set(m.legacy_id, au.user.id); done++;
      } catch (e) { failed++; console.error(`\n  FAILED ${m.member_code} ${m.name}: ${e.message}`); }
      if ((done + failed) % 25 === 0) process.stdout.write(`\r  members: ${done + failed}/${todo.length}`);
    }
  }
  await Promise.all(Array.from({ length: 5 }, worker));
  console.log(`\n  members created: ${done}, failed: ${failed}`);
}

const nameOf = new Map(data.members.map((m) => [m.legacy_id, m]));

// ---- 2. Payment history ----
const havePay = new Set((await fetchAll('payment_submissions', 'id')).map((r) => r.id));
const pays = data.payments.filter((p) => !havePay.has(p.id) && (DRY || idMap.has(p.legacy_id))).map((p) => {
  const m = nameOf.get(p.legacy_id);
  return {
    id: p.id, member_id: idMap.get(p.legacy_id), member_name: m.name, member_code: m.member_code,
    membership_tier: p.membership_tier, billing_month: p.billing_month, amount_pkr: p.amount_pkr,
    method: 'Cash', transaction_ref: `LEGACY-${p.id}`, notes: 'Imported from legacy Attendance system',
    status: 'Approved', submitted_at: p.submitted_at, reviewed_at: p.submitted_at,
    reviewed_by: 'Legacy Import', admin_remark: 'Migrated record',
  };
});
console.log(`Payments to insert: ${pays.length}`);
if (!DRY) await insertBatches('payment_submissions', pays);

// ---- 3. Attendance history ----
const haveAtt = new Set((await fetchAll('attendance_logs', 'id')).filter((r) => r.id.startsWith('legacy-att-')).map((r) => r.id));
const atts = data.attendance.filter((a) => !haveAtt.has(a.id) && (DRY || idMap.has(a.legacy_id))).map((a) => {
  const m = nameOf.get(a.legacy_id);
  return {
    id: a.id, member_id: idMap.get(a.legacy_id), member_name: m.name, member_code: m.member_code,
    check_in_time: a.check_in_time, zone_or_class: 'Main Floor', verified_by: 'Legacy Import',
    verification_source: 'Biometric Scanner', device_name: 'Legacy Attendance System',
    fee_status_at_check_in: null, access_outcome: 'Granted',
  };
});
console.log(`Attendance rows to insert: ${atts.length}`);
if (!DRY) await insertBatches('attendance_logs', atts);

console.log(DRY ? '\nDry run complete - nothing was written.' : '\nImport complete.');
