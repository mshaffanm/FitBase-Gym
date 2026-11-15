// server.ts
import "dotenv/config";
import express from "express";
import path2 from "node:path";
import { pathToFileURL } from "node:url";
import crypto2 from "node:crypto";
import multer from "multer";
import { EventEmitter } from "node:events";

// server/aiConcierge.ts
import { GoogleGenAI, ThinkingLevel } from "@google/genai";

// server/store.ts
import crypto from "node:crypto";
import path from "node:path";

// server/supabase.ts
import { createClient } from "@supabase/supabase-js";
var SupabaseConfigError = class extends Error {
  constructor(message = "Supabase is not configured. Set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY in environment secrets.") {
    super(message);
    this.statusCode = 503;
    this.name = "SupabaseConfigError";
  }
};
function readEnv(primary, fallback) {
  const val = process.env[primary]?.trim() || (fallback ? process.env[fallback]?.trim() : "");
  return val || "";
}
function getSupabasePublicConfig() {
  const supabaseUrl = readEnv("SUPABASE_URL", "VITE_SUPABASE_URL");
  const supabaseAnonKey = readEnv("SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY");
  return {
    supabaseUrl: supabaseUrl || null,
    supabaseAnonKey: supabaseAnonKey || null
  };
}
function isSupabaseConfigured() {
  const { supabaseUrl, supabaseAnonKey } = getSupabasePublicConfig();
  const serviceKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  return Boolean(supabaseUrl && supabaseAnonKey && serviceKey);
}
var cachedAdminClient = null;
var cachedAnonClient = null;
function getSupabaseAdmin() {
  const { supabaseUrl } = getSupabasePublicConfig();
  const serviceRoleKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new SupabaseConfigError();
  }
  if (!cachedAdminClient) {
    cachedAdminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }
  return cachedAdminClient;
}
function getSupabaseAnon() {
  const { supabaseUrl, supabaseAnonKey } = getSupabasePublicConfig();
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new SupabaseConfigError();
  }
  if (!cachedAnonClient) {
    cachedAnonClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }
  return cachedAnonClient;
}

// server/store.ts
var UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
var BIOMETRIC_SALT = process.env.BIOMETRIC_SALT || "fitbase-biometric-hmac-v2";
var TIER_FEES = {
  "Student Package": 6e3,
  "Official Package": 7e3,
  "3 Months Package": 16e3,
  "6 Months Package": 3e4,
  "12 Months Package": 5e4
};
var TIER_DURATION_DAYS = {
  "Student Package": 30,
  "Official Package": 30,
  "3 Months Package": 90,
  "6 Months Package": 180,
  "12 Months Package": 365
};
function addDaysIso(baseIsoDate, days) {
  const d = /* @__PURE__ */ new Date(`${baseIsoDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    const fallback = /* @__PURE__ */ new Date();
    fallback.setUTCDate(fallback.getUTCDate() + days);
    return fallback.toISOString().slice(0, 10);
  }
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function computeDaysRemaining(subscriptionEndDate) {
  const todayStr = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const today = (/* @__PURE__ */ new Date(`${todayStr}T00:00:00Z`)).getTime();
  const end = (/* @__PURE__ */ new Date(`${subscriptionEndDate.slice(0, 10)}T00:00:00Z`)).getTime();
  if (Number.isNaN(end)) return -1;
  return Math.round((end - today) / 864e5);
}
function isMembershipExpired(user) {
  if (user.role !== "member") return false;
  if (user.membershipActive === false) return true;
  if (!user.subscriptionEndDate) return true;
  return computeDaysRemaining(user.subscriptionEndDate) < 0;
}
function hashBiometricSignal(rawSignal) {
  return crypto.createHmac("sha256", BIOMETRIC_SALT).update(rawSignal.trim()).digest("hex");
}
function isValidHardwareBiometricSignal(rawSignal, credentialId) {
  const token = (rawSignal || credentialId || "").trim();
  if (token.length < 16) return false;
  if (/^FB-BIO-/i.test(token) || /^SIM-/i.test(token) || /^DEMO-/i.test(token)) {
    return false;
  }
  return true;
}
function mapProfileRow(row) {
  const tier = row.membership_tier || "Official Package";
  const baseFee = typeof row.base_monthly_fee_pkr === "number" ? row.base_monthly_fee_pkr : TIER_FEES[tier] || 7e3;
  const discount = typeof row.discount_pkr === "number" ? row.discount_pkr : 0;
  const monthlyFee = typeof row.monthly_fee_pkr === "number" ? row.monthly_fee_pkr : Math.max(0, baseFee - discount);
  return {
    id: String(row.id),
    memberCode: String(row.member_code || ""),
    name: String(row.name || ""),
    email: String(row.email || ""),
    phone: String(row.phone || ""),
    role: row.role || "member",
    membershipTier: tier,
    baseMonthlyFeePkr: baseFee,
    discountPkr: discount,
    discountReason: row.discount_reason ? String(row.discount_reason) : void 0,
    monthlyFeePkr: monthlyFee,
    feeStatus: row.fee_status || "Overdue",
    feePaidThrough: String(row.fee_paid_through || "Unpaid"),
    subscriptionEndDate: String(row.subscription_end_date || ""),
    lastReminderSentAt: row.last_reminder_sent_at ? String(row.last_reminder_sent_at) : void 0,
    joinDate: String(row.join_date || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10)),
    assignedTrainerId: row.assigned_trainer_id ? String(row.assigned_trainer_id) : void 0,
    emergencyContact: row.emergency_contact ? String(row.emergency_contact) : void 0,
    cnicLast4: row.cnic_last4 ? String(row.cnic_last4) : void 0,
    membershipActive: row.membership_active !== false,
    biometricStatus: row.biometric_status || "Not Enrolled",
    biometricFingerLabel: row.biometric_finger_label ? String(row.biometric_finger_label) : void 0,
    staffNotes: row.staff_notes ? String(row.staff_notes) : void 0
  };
}
function mapTrainerRow(row) {
  const portraitKeyRaw = String(row.portrait_key || "default");
  const validKeys = [
    "coach_bilal",
    "coach_ayesha",
    "coach_zohaib",
    "coach_nadia",
    "default"
  ];
  const portraitKey = validKeys.includes(portraitKeyRaw) ? portraitKeyRaw : "default";
  return {
    id: String(row.id),
    name: String(row.name || ""),
    specialty: String(row.specialty || ""),
    certifications: String(row.certifications || ""),
    experienceYears: Number(row.experience_years ?? 1),
    portraitKey,
    portraitUrl: row.portrait_url ? String(row.portrait_url) : null,
    activeClients: Number(row.active_clients ?? 0),
    sessionsThisMonth: Number(row.sessions_this_month ?? 0),
    attendanceCompletionRate: Number(row.attendance_completion_rate ?? 100),
    clientRetentionRate: Number(row.client_retention_rate ?? 100),
    rating: Number(row.rating ?? 5),
    bio: String(row.bio || ""),
    adminReviewNote: String(row.admin_review_note || ""),
    lastEvaluatedAt: String(row.last_evaluated_at || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10))
  };
}
function mapClassRow(row) {
  const bookedRaw = row.booked_member_ids;
  const bookedMemberIds = Array.isArray(bookedRaw) ? bookedRaw.map((id) => String(id)) : [];
  return {
    id: String(row.id),
    title: String(row.title || ""),
    discipline: row.discipline,
    dayOfWeek: row.day_of_week,
    startTime: String(row.start_time || ""),
    durationMin: Number(row.duration_min ?? 45),
    trainerId: row.trainer_id ? String(row.trainer_id) : "",
    trainerName: String(row.trainer_name || ""),
    zone: String(row.zone || ""),
    intensity: row.intensity || "Moderate",
    capacity: Number(row.capacity ?? 15),
    bookedMemberIds,
    audience: row.audience ? row.audience : void 0,
    slotLabel: row.slot_label ? String(row.slot_label) : void 0
  };
}
function mapBiometricRow(row) {
  return {
    id: String(row.id),
    memberId: String(row.member_id),
    memberCode: String(row.member_code || ""),
    sensorVendor: row.sensor_vendor || "ZKTeco SLK20R",
    fingerLabel: row.finger_label || "Right Index",
    enrollmentStatus: row.enrollment_status || "Enrolled",
    qualityScore: Number(row.quality_score ?? 95),
    enrolledAt: String(row.enrolled_at || ""),
    enrolledBy: String(row.enrolled_by || ""),
    lastMatchedAt: row.last_matched_at ? String(row.last_matched_at) : void 0,
    hardwareSerial: row.hardware_serial ? String(row.hardware_serial) : void 0,
    captureProtocol: row.capture_protocol ? row.capture_protocol : void 0,
    templateFormat: row.template_format ? row.template_format : void 0,
    credentialId: row.credential_id ? String(row.credential_id) : void 0,
    templateHash: String(row.template_hash || "")
  };
}
function sanitizeBiometricRow(row) {
  const { templateHash: _ignored, ...rest } = row;
  return rest;
}
function mapPerformanceRow(row) {
  return {
    id: String(row.id),
    memberId: String(row.member_id),
    date: String(row.date),
    metric: String(row.metric),
    category: row.category,
    value: Number(row.value),
    unit: String(row.unit),
    notes: row.notes ? String(row.notes) : ""
  };
}
function mapGoalRow(row) {
  return {
    id: String(row.id),
    memberId: String(row.member_id),
    title: String(row.title),
    metric: String(row.metric),
    startValue: Number(row.start_value ?? 0),
    currentValue: Number(row.current_value ?? 0),
    targetValue: Number(row.target_value ?? 0),
    unit: String(row.unit),
    deadline: String(row.deadline),
    status: row.status || "Active"
  };
}
function mapAttendanceRow(row) {
  return {
    id: String(row.id),
    memberId: String(row.member_id),
    memberName: String(row.member_name),
    memberCode: String(row.member_code),
    checkInTime: String(row.check_in_time),
    zoneOrClass: String(row.zone_or_class),
    verifiedBy: String(row.verified_by),
    verificationSource: row.verification_source ? row.verification_source : void 0,
    deviceName: row.device_name ? String(row.device_name) : void 0,
    matchConfidence: row.match_confidence !== null && row.match_confidence !== void 0 ? Number(row.match_confidence) : void 0,
    feeStatusAtCheckIn: row.fee_status_at_check_in ? row.fee_status_at_check_in : void 0,
    accessOutcome: row.access_outcome ? row.access_outcome : void 0
  };
}
function mapPaymentRow(row) {
  return {
    id: String(row.id),
    memberId: String(row.member_id),
    memberName: String(row.member_name),
    memberCode: String(row.member_code),
    membershipTier: row.membership_tier || "Official Package",
    billingMonth: String(row.billing_month),
    amountPkr: Number(row.amount_pkr),
    method: row.method,
    transactionRef: String(row.transaction_ref),
    receiptUrl: row.receipt_url ? String(row.receipt_url) : null,
    receiptFileName: row.receipt_file_name ? String(row.receipt_file_name) : null,
    notes: String(row.notes || ""),
    status: row.status || "Pending",
    submittedAt: String(row.submitted_at),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : void 0,
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : void 0,
    adminRemark: row.admin_remark ? String(row.admin_remark) : void 0
  };
}
function mapFeedbackRow(row) {
  return {
    id: String(row.id),
    memberId: row.member_id ? String(row.member_id) : null,
    authorName: String(row.author_name),
    authorEmail: String(row.author_email),
    category: row.category,
    trainerId: row.trainer_id ? String(row.trainer_id) : void 0,
    rating: Number(row.rating ?? 5),
    message: String(row.message),
    status: row.status || "Open",
    adminReply: row.admin_reply ? String(row.admin_reply) : void 0,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
function mapNotificationLogRow(row) {
  return {
    id: String(row.id),
    memberId: String(row.member_id),
    memberName: String(row.member_name),
    memberCode: String(row.member_code),
    phone: String(row.phone),
    channel: row.channel || "WhatsApp",
    provider: row.provider,
    daysRemaining: Number(row.days_remaining ?? 0),
    subscriptionEndDate: String(row.subscription_end_date),
    messagePreview: String(row.message_preview),
    deliveryStatus: row.delivery_status,
    providerMessageId: row.provider_message_id ? String(row.provider_message_id) : void 0,
    whatsappDeepLink: row.whatsapp_deep_link ? String(row.whatsapp_deep_link) : void 0,
    dispatchedAt: String(row.dispatched_at),
    triggerType: row.trigger_type || "Daily Cron"
  };
}
function mapNotificationSettingsRow(row) {
  if (!row) {
    return {
      reminderDaysBefore: 5,
      dailyCronTime: "08:00",
      whatsappEnabled: true,
      lastSweepAt: null,
      lastSweepMatchedCount: 0
    };
  }
  return {
    reminderDaysBefore: Number(row.reminder_days_before ?? 5),
    dailyCronTime: String(row.daily_cron_time || "08:00"),
    whatsappEnabled: row.whatsapp_enabled !== false,
    lastSweepAt: row.last_sweep_at ? String(row.last_sweep_at) : null,
    lastSweepMatchedCount: Number(row.last_sweep_matched_count ?? 0)
  };
}
function mapPasswordResetRow(row) {
  return {
    id: String(row.id),
    memberId: String(row.member_id),
    memberCode: String(row.member_code),
    memberName: String(row.member_name),
    email: String(row.email),
    phoneProvided: String(row.phone_provided),
    registeredPhone: String(row.registered_phone),
    note: row.note ? String(row.note) : void 0,
    status: row.status || "Pending",
    triggerSource: row.trigger_source || "Member Forgot Password",
    requestedAt: String(row.requested_at),
    resolvedAt: row.resolved_at ? String(row.resolved_at) : void 0,
    resolvedBy: row.resolved_by ? String(row.resolved_by) : void 0,
    resolutionNote: row.resolution_note ? String(row.resolution_note) : void 0
  };
}
async function getTrainers() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("trainers").select("*").order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map((r) => mapTrainerRow(r));
}
async function getGymClasses() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("gym_classes").select("*");
  if (error) throw new Error(error.message);
  return (data || []).map((r) => mapClassRow(r));
}
async function getNotificationSettings() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("notification_settings").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message);
  return mapNotificationSettingsRow(data ?? null);
}
async function getProfileById(id) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("profiles").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapProfileRow(data) : null;
}
async function getMemberProfiles() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("profiles").select("*").eq("role", "member").order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map((r) => mapProfileRow(r));
}

// server/aiConcierge.ts
var ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build"
    }
  }
});
function buildFitBaseSystemInstruction(trainers, classes) {
  const trainerLines = trainers.length > 0 ? trainers.map(
    (t) => `- ${t.name} (${t.specialty}; ${t.experienceYears} yrs exp; Certs: ${t.certifications}; Rating: ${t.rating}/5)`
  ).join("\n") : "- Certified male and female trainers are assigned daily on the Faisalabad floor.";
  const femaleClasses = classes.filter((c) => c.audience === "Female Only").slice(0, 10).map((c) => `- ${c.dayOfWeek}: ${c.title} (${c.slotLabel || c.startTime})`).join("\n");
  return `You are the official AI Concierge for FitBase Fitness Center in Faisalabad, Pakistan.
Answer visitors and members clearly, accurately, and concisely using ONLY the verified gym policies, pricing, schedules, and operational facts below.

### Brand & Credits
- Gym Name: FitBase Fitness Center
- Gym Owner: TAMHEED
- Built by: AI Specialist SHAFFAN (https://masudcollection.com)
- Address: Near Marhaba Mart, Green Avenue, East Canal Road, Faisalabad, Pakistan
- Official Website: www.fitbasegym.pk
- Contact / WhatsApp Numbers: 0312-8330203 and 0319-7663203 (WhatsApp: https://wa.me/923128330203)
- Official Instagram: @fitbasefitnesscenter (https://www.instagram.com/fitbasefitnesscenter?igsh=MW03ZmU3Y204Z2hkaQ%3D%3D&utm_source=qr)

### Membership Packages & Pricing (PKR \u2014 All Facilities Included)
1. Student Package: PKR ${(TIER_FEES["Student Package"] || 6e3).toLocaleString("en-PK")} / month
   - Policy: Must present a valid Student ID card at reception. Includes all gym, cardio, AC, locker, and female class facilities.
2. Official Package: PKR ${(TIER_FEES["Official Package"] || 7e3).toLocaleString("en-PK")} / month
   - Standard monthly full-access membership; all facilities included.
3. 3 Months Package: PKR ${(TIER_FEES["3 Months Package"] || 16e3).toLocaleString("en-PK")} total dues (90 days; all facilities included).
4. 6 Months Package (Best Value): PKR ${(TIER_FEES["6 Months Package"] || 3e4).toLocaleString("en-PK")} total dues (180 days; all facilities included).
5. 12 Months Package (Best Deal): PKR ${(TIER_FEES["12 Months Package"] || 5e4).toLocaleString("en-PK")} total dues (365 days; all facilities included).
- Custom Discounts: Reception staff can apply approved corporate, student, or promotional fee reductions during registration in the Reception Portal.

### Official Summer Timings
- Morning Co-Ed Timing: 6:00 AM \u2013 10:00 AM
- Ladies Only Timing: 10:00 AM \u2013 4:30 PM (Strictly female-only floor access with female coaching)
- Evening Co-Ed Timing: 5:00 PM \u2013 12:00 AM (Midnight)
- Friday: OFF DAY (Gym is closed every Friday).

### Weekly Fitness Classes (ONLY FEMALE \u2014 FREE, Included in Active Packages)
- Two Daily Sessions: 1st Class 11:30 AM \u2013 12:00 PM | 2nd Class 3:00 PM \u2013 3:30 PM (30 minutes each, free in all active packages)
- Monday: Upper Body Workout
- Tuesday: Lower Body Workout
- Wednesday: Full Body Workout (With Weights)
- Thursday: Yoga Class
- Friday: Off Day (Gym Closed)
- Saturday: Stick / Stepper Class
- Sunday: No Class (Gym open during regular Co-Ed and Ladies hours, no group female class scheduled)
${femaleClasses ? `Sample Scheduled Sessions:
${femaleClasses}` : ""}

### Facility Features ("Feel The Chill \u2014 AC On, Excuses Off")
- Fully Air-Conditioned (AC) training environment throughout
- State-of-the-art strength & selectorized machines, free weight plate-loaded bay, Olympic bars & dumbbell racks, commercial cardio deck (treadmills, StairMasters, ellipticals), and boxing/turf conditioning lane
- Executive changing rooms, safe/clean/hygienic floor, certified trainers

### Coaching Team
${trainerLines}

### Payments, Biometric Hardware Check-In & Gym Policies
- Accepted Payment Methods: JazzCash, EasyPaisa, Bank Transfer (IBFT), and Cash at Reception. Members upload transaction IDs and payment slip screenshots directly in the Member Portal for staff verification.
- Biometric Fingerprint Enrollment & Daily Check-In: FitBase uses physical fingerprint scanner hardware (ZKTeco SLK20R, SecuGen Hamster Pro 20, DigitalPersona U.are.U 4500, and WebAuthn biometric sensors) at reception. New members enroll their fingerprint during initial desk registration or via Member Profiles & Enrollment. All templates are cryptographically hashed with HMAC-SHA256 on the server (raw print images are never stored). Daily finger scans log real-time attendance and immediately cross-reference fee status (Paid = Access Granted, Pending Verification = Granted with Due Alert, Overdue = Hold / Clear Due at Reception).
- Strict Membership Validation: Expired memberships are denied portal access ("Membership Expired.") until renewed via Reception/Admin.
- Automated Renewal Reminders: The system runs a daily schedule checking subscription end dates and dispatches WhatsApp renewal reminders and in-portal expiration alerts ahead of expiry.
- Floor Etiquette & Rules: Valid Student ID required for Student Package; strictly Ladies Only from 10:00 AM \u2013 4:30 PM; clean indoor athletic shoes and towel required; re-rack weights after sets.

### Response Rules
- Keep answers crisp, helpful, and directly formatted (short paragraphs or clean bullet points).
- Always quote exact PKR prices, exact timings, and exact Friday Off status when asked.
- If asked about private individual account balances or receipts, instruct the member to sign into the Member Portal or message FitBase directly on WhatsApp (0312-8330203).
- Do not fabricate any policies, prices, or timings outside these facts.`;
}
async function askFitBaseConcierge(params) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is not configured on the server. Add your Gemini API key in Settings > Secrets."
    );
  }
  const trimmedMessage = params.message.trim();
  if (!trimmedMessage) {
    throw new Error("Please enter a question for the FitBase AI Concierge.");
  }
  const systemInstruction = buildFitBaseSystemInstruction(params.trainers, params.classes);
  const contents = [];
  if (Array.isArray(params.history)) {
    for (const turn of params.history.slice(-10)) {
      if (turn?.text?.trim() && (turn.role === "user" || turn.role === "model")) {
        contents.push({
          role: turn.role,
          parts: [{ text: turn.text.trim() }]
        });
      }
    }
  }
  contents.push({
    role: "user",
    parts: [{ text: trimmedMessage }]
  });
  const response = await ai.models.generateContent({
    model: "gemini-4-hydrogen",
    contents,
    config: {
      systemInstruction,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
    }
  });
  const text = response.text?.trim();
  if (!text) {
    throw new Error("The AI assistant returned an empty response. Please try asking again.");
  }
  return text;
}

// server.ts
var PORT = Number(process.env.PORT || 3e3);
var biometricEventBus = new EventEmitter();
biometricEventBus.setMaxListeners(50);
var RECEIPT_BUCKET = process.env.SUPABASE_RECEIPT_BUCKET || "receipts";
var storage = multer.memoryStorage();
var upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "application/pdf"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PNG, JPG, WEBP, SVG, or PDF receipts are supported."));
    }
  }
});
async function resolveUserFromToken(token) {
  if (!isSupabaseConfigured()) {
    throw new SupabaseConfigError();
  }
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    return null;
  }
  return getProfileById(data.user.id);
}
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  const token = header.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  try {
    const profile = await resolveUserFromToken(token);
    if (!profile) {
      res.status(401).json({ error: "Session expired or account not found. Please sign in again." });
      return;
    }
    req.authUser = profile;
    next();
  } catch (err) {
    if (err instanceof SupabaseConfigError) {
      res.status(503).json({ error: err.message });
      return;
    }
    res.status(401).json({ error: "Session expired. Please sign in again." });
  }
}
function requireActiveMember(req, res, next) {
  if (!req.authUser) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  if (isMembershipExpired(req.authUser)) {
    res.status(403).json({ error: "Membership Expired." });
    return;
  }
  next();
}
function requireAdmin(req, res, next) {
  if (!req.authUser || req.authUser.role !== "admin") {
    res.status(403).json({ error: "Administrator access required." });
    return;
  }
  next();
}
function requireStaff(req, res, next) {
  if (!req.authUser || req.authUser.role !== "admin" && req.authUser.role !== "reception") {
    res.status(403).json({ error: "Reception or Administrator access required." });
    return;
  }
  next();
}
function buildExpirationAlert(user, reminderDaysBefore) {
  const endDate = user.subscriptionEndDate || addDaysIso(user.joinDate, 30);
  const daysRemaining = computeDaysRemaining(endDate);
  if (daysRemaining < 0 || user.membershipActive === false) {
    return {
      status: "Expired",
      daysRemaining,
      subscriptionEndDate: endDate,
      message: "Membership Expired."
    };
  }
  if (daysRemaining <= reminderDaysBefore) {
    return {
      status: "Expiring Soon",
      daysRemaining,
      subscriptionEndDate: endDate,
      message: daysRemaining === 0 ? `Your FitBase subscription expires today (${endDate}). Please renew PKR ${user.monthlyFeePkr.toLocaleString("en-PK")} to avoid turnstile interruption.` : `Renewal due in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} (${endDate}). Submit PKR ${user.monthlyFeePkr.toLocaleString("en-PK")} via JazzCash, EasyPaisa, Bank Transfer, or Cash.`
    };
  }
  return {
    status: "Active",
    daysRemaining,
    subscriptionEndDate: endDate,
    message: `Subscription active through ${endDate} (${daysRemaining} days remaining).`
  };
}
function normalizeWhatsAppPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("0")) {
    return `92${digits.slice(1)}`;
  }
  if (digits.startsWith("92")) {
    return digits;
  }
  return digits || "923128330203";
}
function buildWhatsAppMessage(user, daysRemaining) {
  const timing = daysRemaining < 0 ? `expired ${Math.abs(daysRemaining)} day(s) ago (${user.subscriptionEndDate})` : daysRemaining === 0 ? `expires today (${user.subscriptionEndDate})` : `expires in ${daysRemaining} day(s) on ${user.subscriptionEndDate}`;
  return `Assalam-o-Alaikum ${user.name} (${user.memberCode}), your FitBase (${user.membershipTier}) membership ${timing}. Package dues: PKR ${user.monthlyFeePkr.toLocaleString("en-PK")}. Renew via JazzCash/EasyPaisa in the Member Portal or at Near Marhaba Mart, Green Avenue, East Canal Road, Faisalabad (0312-8330203).`;
}
async function dispatchWhatsAppReminder(user, daysRemaining, triggerType, settings) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const messagePreview = buildWhatsAppMessage(user, daysRemaining);
  const waDigits = normalizeWhatsAppPhone(user.phone);
  const whatsappDeepLink = `https://wa.me/${waDigits}?text=${encodeURIComponent(messagePreview)}`;
  const cloudToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const webhookUrl = process.env.WHATSAPP_WEBHOOK_URL?.trim();
  let provider = "WhatsApp Dispatch Queue";
  let deliveryStatus = "Queued (Configure API Token)";
  let providerMessageId;
  if (cloudToken && phoneNumberId) {
    provider = "WhatsApp Cloud API";
    try {
      const response = await fetch(
        `https://graph.facebook.com/v20.0/${encodeURIComponent(phoneNumberId)}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cloudToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: waDigits,
            type: "text",
            text: { body: messagePreview }
          })
        }
      );
      if (response.ok) {
        const json = await response.json();
        deliveryStatus = "Delivered";
        providerMessageId = json.messages?.[0]?.id;
      } else {
        deliveryStatus = "Failed";
      }
    } catch {
      deliveryStatus = "Failed";
    }
  } else if (webhookUrl) {
    provider = "WhatsApp Webhook";
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: `+${waDigits}`,
          memberCode: user.memberCode,
          memberName: user.name,
          subscriptionEndDate: user.subscriptionEndDate,
          daysRemaining,
          message: messagePreview
        })
      });
      deliveryStatus = response.ok ? "Delivered" : "Failed";
    } catch {
      deliveryStatus = "Failed";
    }
  }
  const logEntry = {
    id: `ntf-${Date.now()}-${crypto2.randomBytes(2).toString("hex")}`,
    memberId: user.id,
    memberName: user.name,
    memberCode: user.memberCode,
    phone: user.phone,
    channel: settings.whatsappEnabled ? "WhatsApp" : "In-Portal",
    provider: settings.whatsappEnabled ? provider : "Member Portal Alert",
    daysRemaining,
    subscriptionEndDate: user.subscriptionEndDate || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
    messagePreview,
    deliveryStatus: settings.whatsappEnabled ? deliveryStatus : "Delivered",
    providerMessageId,
    whatsappDeepLink,
    dispatchedAt: now,
    triggerType
  };
  const supabase = getSupabaseAdmin();
  await supabase.from("notification_logs").insert({
    id: logEntry.id,
    member_id: logEntry.memberId,
    member_name: logEntry.memberName,
    member_code: logEntry.memberCode,
    phone: logEntry.phone,
    channel: logEntry.channel,
    provider: logEntry.provider,
    days_remaining: logEntry.daysRemaining,
    subscription_end_date: logEntry.subscriptionEndDate,
    message_preview: logEntry.messagePreview,
    delivery_status: logEntry.deliveryStatus,
    provider_message_id: logEntry.providerMessageId || null,
    whatsapp_deep_link: logEntry.whatsappDeepLink || null,
    dispatched_at: logEntry.dispatchedAt,
    trigger_type: logEntry.triggerType
  });
  await supabase.from("profiles").update({ last_reminder_sent_at: now }).eq("id", user.id);
  return logEntry;
}
async function runExpirationSweep(triggerType) {
  const supabase = getSupabaseAdmin();
  const [settings, members] = await Promise.all([getNotificationSettings(), getMemberProfiles()]);
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const windowDays = settings.reminderDaysBefore ?? 5;
  let dispatchedCount = 0;
  for (const user of members) {
    if (user.membershipActive === false) continue;
    const endDate = user.subscriptionEndDate || addDaysIso(user.joinDate, 30);
    const daysRemaining = computeDaysRemaining(endDate);
    if (daysRemaining > windowDays) continue;
    if (triggerType === "Daily Cron" && user.lastReminderSentAt?.startsWith(today)) {
      continue;
    }
    await dispatchWhatsAppReminder(
      { ...user, subscriptionEndDate: endDate },
      daysRemaining,
      triggerType,
      settings
    );
    dispatchedCount += 1;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await supabase.from("notification_settings").upsert({
    id: 1,
    reminder_days_before: settings.reminderDaysBefore,
    daily_cron_time: settings.dailyCronTime,
    whatsapp_enabled: settings.whatsappEnabled,
    last_sweep_at: now,
    last_sweep_matched_count: dispatchedCount
  });
  return { dispatchedCount, lastSweepAt: now };
}
function createTemporaryPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 6; i += 1) {
    suffix += alphabet[crypto2.randomInt(0, alphabet.length)];
  }
  return `FB-${suffix}`;
}
function buildPasswordResetWhatsAppLink(user, tempPassword) {
  const waDigits = normalizeWhatsAppPhone(user.phone);
  const text = `Assalam-o-Alaikum ${user.name} (${user.memberCode}), your FitBase Member Portal password has been reset by Reception. Email: ${user.email} | Temporary Password: ${tempPassword}. Please sign in at the FitBase Member Portal.`;
  return `https://wa.me/${waDigits}?text=${encodeURIComponent(text)}`;
}
async function nextMemberCode() {
  const supabase = getSupabaseAdmin();
  const { count } = await supabase.from("profiles").select("*", { count: "exact", head: true }).eq("role", "member");
  const base = 1001 + (count || 0);
  const candidate = `FB-${base}`;
  const { data: existing } = await supabase.from("profiles").select("id").eq("member_code", candidate).maybeSingle();
  if (!existing) return candidate;
  return `FB-${base}-${crypto2.randomInt(10, 99)}`;
}
function createApp() {
  const app2 = express();
  app2.use(express.json({ limit: "2mb" }));
  app2.get("/api/public/config", (_req, res) => {
    res.json(getSupabasePublicConfig());
  });
  app2.get("/api/public/overview", async (_req, res) => {
    if (!isSupabaseConfigured()) {
      res.json({ classes: [], trainers: [], tiers: TIER_FEES });
      return;
    }
    try {
      const [classes, trainers] = await Promise.all([getGymClasses(), getTrainers()]);
      res.json({ classes, trainers, tiers: TIER_FEES });
    } catch {
      res.json({ classes: [], trainers: [], tiers: TIER_FEES });
    }
  });
  app2.post("/api/chat", async (req, res) => {
    const { message, history } = req.body;
    if (!message?.trim()) {
      res.status(400).json({ error: "Please type a message before sending." });
      return;
    }
    try {
      let trainers = [];
      let classes = [];
      if (isSupabaseConfigured()) {
        [trainers, classes] = await Promise.all([getTrainers(), getGymClasses()]);
      }
      const reply = await askFitBaseConcierge({
        message,
        history,
        trainers,
        classes
      });
      res.json({ reply });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "FitBase AI Concierge is temporarily unavailable. Please try again.";
      const status = msg.includes("GEMINI_API_KEY") ? 503 : 500;
      res.status(status).json({ error: msg });
    }
  });
  app2.post("/api/public/inquiries", async (req, res, next) => {
    try {
      const { name, email, message, category } = req.body;
      if (!name?.trim() || !email?.trim() || !message?.trim()) {
        res.status(400).json({ error: "Name, email, and message are required." });
        return;
      }
      const supabase = getSupabaseAdmin();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const id = `fbk-${Date.now()}-${crypto2.randomBytes(2).toString("hex")}`;
      const resolvedCategory = category === "Billing" || category === "Trainer" ? category : "General Inquiry";
      const { data, error } = await supabase.from("feedback_entries").insert({
        id,
        member_id: null,
        author_name: name.trim(),
        author_email: email.trim().toLowerCase(),
        category: resolvedCategory,
        rating: 5,
        message: message.trim(),
        status: "Open",
        created_at: now,
        updated_at: now
      }).select("*").single();
      if (error) {
        res.status(400).json({ error: error.message });
        return;
      }
      res.status(201).json({ entry: mapFeedbackRow(data) });
    } catch (err) {
      next(err);
    }
  });
  app2.post("/api/auth/login", async (req, res, next) => {
    try {
      const { email, password } = req.body;
      if (!email?.trim() || !password) {
        res.status(400).json({ error: "Email and password are required." });
        return;
      }
      const supabaseAnon = getSupabaseAnon();
      const { data: authData, error: authError } = await supabaseAnon.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password
      });
      if (authError || !authData.user || !authData.session) {
        res.status(401).json({ error: "Invalid email or password." });
        return;
      }
      const profile = await getProfileById(authData.user.id);
      if (!profile) {
        res.status(403).json({
          error: "Account profile record not found. Please contact FitBase Reception."
        });
        return;
      }
      if (isMembershipExpired(profile)) {
        res.status(403).json({ error: "Membership Expired." });
        return;
      }
      res.json({
        token: authData.session.access_token,
        refreshToken: authData.session.refresh_token,
        user: profile
      });
    } catch (err) {
      next(err);
    }
  });
  app2.post("/api/auth/register", async (req, res, next) => {
    try {
      const { name, email, phone, password, membershipTier } = req.body;
      if (!name?.trim() || !email?.trim() || !password || password.length < 6) {
        res.status(400).json({ error: "Name, valid email, and password (min 6 chars) are required." });
        return;
      }
      const tier = membershipTier && TIER_FEES[membershipTier] ? membershipTier : "Official Package";
      const normalizedEmail = email.trim().toLowerCase();
      const supabaseAdmin = getSupabaseAdmin();
      const supabaseAnon = getSupabaseAnon();
      const { data: existingProfile } = await supabaseAdmin.from("profiles").select("id").eq("email", normalizedEmail).maybeSingle();
      if (existingProfile) {
        res.status(409).json({ error: "An account with this email already exists." });
        return;
      }
      const { data: createdAuth, error: createAuthError } = await supabaseAdmin.auth.admin.createUser({
        email: normalizedEmail,
        password,
        email_confirm: true,
        user_metadata: { name: name.trim() }
      });
      if (createAuthError || !createdAuth.user) {
        const status = createAuthError?.message?.toLowerCase().includes("already") ? 409 : 400;
        res.status(status).json({
          error: createAuthError?.message || "Unable to register account."
        });
        return;
      }
      const trainers = await getTrainers();
      const memberCode = await nextMemberCode();
      const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const endDate = addDaysIso(today, TIER_DURATION_DAYS[tier] || 30);
      const { data: insertedProfile, error: profileError } = await supabaseAdmin.from("profiles").insert({
        id: createdAuth.user.id,
        member_code: memberCode,
        name: name.trim(),
        email: normalizedEmail,
        phone: phone?.trim() || "+92 312 8330203",
        role: "member",
        membership_tier: tier,
        base_monthly_fee_pkr: TIER_FEES[tier],
        discount_pkr: 0,
        monthly_fee_pkr: TIER_FEES[tier],
        fee_status: "Overdue",
        fee_paid_through: "Unpaid",
        subscription_end_date: endDate,
        join_date: today,
        assigned_trainer_id: trainers[0]?.id || null,
        membership_active: true,
        biometric_status: "Not Enrolled"
      }).select("*").single();
      if (profileError || !insertedProfile) {
        await supabaseAdmin.auth.admin.deleteUser(createdAuth.user.id);
        res.status(400).json({ error: profileError?.message || "Unable to create member profile." });
        return;
      }
      const { data: signInData, error: signInError } = await supabaseAnon.auth.signInWithPassword({
        email: normalizedEmail,
        password
      });
      if (signInError || !signInData.session) {
        res.status(500).json({ error: "Account created, please sign in." });
        return;
      }
      res.status(201).json({
        token: signInData.session.access_token,
        refreshToken: signInData.session.refresh_token,
        user: mapProfileRow(insertedProfile)
      });
    } catch (err) {
      next(err);
    }
  });
  app2.post("/api/auth/forgot-password", async (req, res, next) => {
    try {
      const { identifier, phone, note } = req.body;
      if (!identifier?.trim() || !phone?.trim()) {
        res.status(400).json({
          error: "Email address (or Member ID) and registered phone number are required."
        });
        return;
      }
      const supabase = getSupabaseAdmin();
      const lookup = identifier.trim();
      let memberRow = null;
      const { data: byEmail } = await supabase.from("profiles").select("*").eq("role", "member").ilike("email", lookup).limit(1).maybeSingle();
      if (byEmail) {
        memberRow = byEmail;
      } else {
        const { data: byCode } = await supabase.from("profiles").select("*").eq("role", "member").ilike("member_code", lookup).limit(1).maybeSingle();
        if (byCode) {
          memberRow = byCode;
        }
      }
      if (!memberRow) {
        res.status(404).json({
          error: "No FitBase member account found matching that email or member code."
        });
        return;
      }
      const member = mapProfileRow(memberRow);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const { data: existingPending } = await supabase.from("password_reset_requests").select("*").eq("member_id", member.id).eq("status", "Pending").maybeSingle();
      let savedRequest;
      if (existingPending) {
        const { data: updated, error: updateErr } = await supabase.from("password_reset_requests").update({
          phone_provided: phone.trim(),
          note: note?.trim() || String(existingPending.note || "Member forgot password."),
          requested_at: now
        }).eq("id", existingPending.id).select("*").single();
        if (updateErr) throw new Error(updateErr.message);
        savedRequest = mapPasswordResetRow(updated);
      } else {
        const newId = `pwr-${Date.now()}-${crypto2.randomBytes(2).toString("hex")}`;
        const { data: inserted, error: insertErr } = await supabase.from("password_reset_requests").insert({
          id: newId,
          member_id: member.id,
          member_code: member.memberCode,
          member_name: member.name,
          email: member.email,
          phone_provided: phone.trim(),
          registered_phone: member.phone,
          note: note?.trim() || "Member requested password reset from login screen.",
          status: "Pending",
          trigger_source: "Member Forgot Password",
          requested_at: now
        }).select("*").single();
        if (insertErr) throw new Error(insertErr.message);
        savedRequest = mapPasswordResetRow(inserted);
      }
      res.status(201).json({
        request: {
          id: savedRequest.id,
          memberCode: savedRequest.memberCode,
          memberName: savedRequest.memberName,
          status: savedRequest.status,
          requestedAt: savedRequest.requestedAt
        },
        message: "Your password reset request has been sent to the FitBase Reception Desk. Visit reception or contact 0312-8330203 on WhatsApp to receive your temporary password."
      });
    } catch (err) {
      next(err);
    }
  });
  app2.get("/api/auth/me", requireAuth, (req, res) => {
    if (isMembershipExpired(req.authUser)) {
      res.status(403).json({ error: "Membership Expired." });
      return;
    }
    res.json({ user: req.authUser });
  });
  app2.get(
    "/api/member/dashboard",
    requireAuth,
    requireActiveMember,
    async (req, res, next) => {
      try {
        const supabase = getSupabaseAdmin();
        const memberId = req.authUser.id;
        const [
          settings,
          notifRes,
          perfRes,
          goalsRes,
          attRes,
          payRes,
          classes,
          fbRes,
          trainers
        ] = await Promise.all([
          getNotificationSettings(),
          supabase.from("notification_logs").select("*").eq("member_id", memberId).order("dispatched_at", { ascending: false }),
          supabase.from("performance_logs").select("*").eq("member_id", memberId).order("date", { ascending: true }),
          supabase.from("member_goals").select("*").eq("member_id", memberId),
          supabase.from("attendance_logs").select("*").eq("member_id", memberId).order("check_in_time", { ascending: false }),
          supabase.from("payment_submissions").select("*").eq("member_id", memberId).order("submitted_at", { ascending: false }),
          getGymClasses(),
          supabase.from("feedback_entries").select("*").eq("member_id", memberId).order("created_at", { ascending: false }),
          getTrainers()
        ]);
        res.json({
          profile: req.authUser,
          expirationAlert: buildExpirationAlert(req.authUser, settings.reminderDaysBefore),
          notifications: (notifRes.data || []).map(
            (r) => mapNotificationLogRow(r)
          ),
          performanceLogs: (perfRes.data || []).map(
            (r) => mapPerformanceRow(r)
          ),
          goals: (goalsRes.data || []).map((r) => mapGoalRow(r)),
          attendanceLogs: (attRes.data || []).map(
            (r) => mapAttendanceRow(r)
          ),
          payments: (payRes.data || []).map((r) => mapPaymentRow(r)),
          classes,
          feedback: (fbRes.data || []).map((r) => mapFeedbackRow(r)),
          trainers
        });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.post(
    "/api/member/classes/:classId/toggle",
    requireAuth,
    requireActiveMember,
    async (req, res, next) => {
      try {
        const supabase = getSupabaseAdmin();
        const { data: clsRow, error: clsErr } = await supabase.from("gym_classes").select("*").eq("id", req.params.classId).maybeSingle();
        if (clsErr) throw new Error(clsErr.message);
        if (!clsRow) {
          res.status(404).json({ error: "Class not found." });
          return;
        }
        const cls = mapClassRow(clsRow);
        const userId = req.authUser.id;
        const isBooked = cls.bookedMemberIds.includes(userId);
        let nextBooked;
        if (isBooked) {
          nextBooked = cls.bookedMemberIds.filter((id) => id !== userId);
        } else {
          if (cls.bookedMemberIds.length >= cls.capacity) {
            res.status(400).json({ error: "Class is currently at full capacity." });
            return;
          }
          nextBooked = [...cls.bookedMemberIds, userId];
        }
        const { error: updateErr } = await supabase.from("gym_classes").update({ booked_member_ids: nextBooked }).eq("id", cls.id);
        if (updateErr) throw new Error(updateErr.message);
        const classes = await getGymClasses();
        res.json({ classes, booked: !isBooked });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.post(
    "/api/member/performance",
    requireAuth,
    requireActiveMember,
    async (req, res, next) => {
      try {
        const { date, metric, category, value, unit, notes } = req.body;
        if (!metric?.trim() || typeof value !== "number" || Number.isNaN(value) || !unit?.trim()) {
          res.status(400).json({ error: "Metric name, numeric value, and unit are required." });
          return;
        }
        const supabase = getSupabaseAdmin();
        const { data, error } = await supabase.from("performance_logs").insert({
          id: `prf-${Date.now()}-${crypto2.randomBytes(2).toString("hex")}`,
          member_id: req.authUser.id,
          date: date || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
          metric: metric.trim(),
          category: category || "Strength Lift",
          value,
          unit: unit.trim(),
          notes: notes?.trim() || ""
        }).select("*").single();
        if (error) throw new Error(error.message);
        res.status(201).json({ entry: mapPerformanceRow(data) });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.delete(
    "/api/member/performance/:logId",
    requireAuth,
    requireActiveMember,
    async (req, res, next) => {
      try {
        const supabase = getSupabaseAdmin();
        const { data: deleted, error } = await supabase.from("performance_logs").delete().eq("id", req.params.logId).eq("member_id", req.authUser.id).select("id");
        if (error) throw new Error(error.message);
        if (!deleted || deleted.length === 0) {
          res.status(404).json({ error: "Performance entry not found." });
          return;
        }
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.post(
    "/api/member/goals",
    requireAuth,
    requireActiveMember,
    async (req, res, next) => {
      try {
        const { title, metric, startValue, currentValue, targetValue, unit, deadline } = req.body;
        if (!title?.trim() || !metric?.trim() || typeof targetValue !== "number" || !unit?.trim() || !deadline) {
          res.status(400).json({ error: "Title, metric, target value, unit, and deadline are required." });
          return;
        }
        const start = typeof startValue === "number" ? startValue : 0;
        const current = typeof currentValue === "number" ? currentValue : start;
        const status = current >= targetValue && targetValue > start ? "Achieved" : "Active";
        const supabase = getSupabaseAdmin();
        const { data, error } = await supabase.from("member_goals").insert({
          id: `gol-${Date.now()}-${crypto2.randomBytes(2).toString("hex")}`,
          member_id: req.authUser.id,
          title: title.trim(),
          metric: metric.trim(),
          start_value: start,
          current_value: current,
          target_value: targetValue,
          unit: unit.trim(),
          deadline,
          status
        }).select("*").single();
        if (error) throw new Error(error.message);
        res.status(201).json({ goal: mapGoalRow(data) });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.patch(
    "/api/member/goals/:goalId",
    requireAuth,
    requireActiveMember,
    async (req, res, next) => {
      try {
        const { currentValue, status } = req.body;
        const patch = {};
        if (typeof currentValue === "number" && !Number.isNaN(currentValue)) {
          patch.current_value = currentValue;
        }
        if (status === "Active" || status === "Achieved") {
          patch.status = status;
        }
        const supabase = getSupabaseAdmin();
        const { data, error } = await supabase.from("member_goals").update(patch).eq("id", req.params.goalId).eq("member_id", req.authUser.id).select("*").maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) {
          res.status(404).json({ error: "Goal not found." });
          return;
        }
        res.json({ goal: mapGoalRow(data) });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.delete(
    "/api/member/goals/:goalId",
    requireAuth,
    requireActiveMember,
    async (req, res, next) => {
      try {
        const supabase = getSupabaseAdmin();
        const { data: deleted, error } = await supabase.from("member_goals").delete().eq("id", req.params.goalId).eq("member_id", req.authUser.id).select("id");
        if (error) throw new Error(error.message);
        if (!deleted || deleted.length === 0) {
          res.status(404).json({ error: "Goal not found." });
          return;
        }
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.post(
    "/api/member/attendance/checkin",
    requireAuth,
    requireActiveMember,
    async (req, res, next) => {
      try {
        const { zoneOrClass } = req.body;
        const supabase = getSupabaseAdmin();
        const { data, error } = await supabase.from("attendance_logs").insert({
          id: `att-${Date.now()}-${crypto2.randomBytes(2).toString("hex")}`,
          member_id: req.authUser.id,
          member_name: req.authUser.name,
          member_code: req.authUser.memberCode,
          check_in_time: (/* @__PURE__ */ new Date()).toISOString(),
          zone_or_class: zoneOrClass?.trim() || "Main Iron Rack Bay",
          verified_by: "Member Self Check-In",
          verification_source: "Member Self Check-In",
          fee_status_at_check_in: req.authUser.feeStatus,
          access_outcome: req.authUser.feeStatus === "Paid" ? "Granted" : "Granted with Due Alert"
        }).select("*").single();
        if (error) throw new Error(error.message);
        res.status(201).json({ entry: mapAttendanceRow(data) });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.post(
    "/api/member/payments",
    requireAuth,
    requireActiveMember,
    upload.single("receipt"),
    async (req, res, next) => {
      try {
        const { method, transactionRef, billingMonth, amountPkr, notes } = req.body;
        const validMethods = ["JazzCash", "EasyPaisa", "Cash", "Bank Transfer"];
        if (!method || !validMethods.includes(method)) {
          res.status(400).json({
            error: "Select a valid payment method (JazzCash, EasyPaisa, Cash, or Bank Transfer)."
          });
          return;
        }
        if (!transactionRef?.trim()) {
          res.status(400).json({ error: "Transaction Reference / Receipt Number is required." });
          return;
        }
        if (method !== "Cash" && !req.file) {
          res.status(400).json({
            error: "Please upload a payment screenshot or receipt for online/bank verification."
          });
          return;
        }
        const user = req.authUser;
        const parsedAmount = Number(amountPkr) || user.monthlyFeePkr || 7e3;
        const supabase = getSupabaseAdmin();
        let receiptUrl = null;
        if (req.file) {
          const ext = path2.extname(req.file.originalname || "").toLowerCase();
          const safeExt = [".png", ".jpg", ".jpeg", ".webp", ".pdf", ".svg"].includes(ext) ? ext : ".png";
          const objectPath = `${user.id}/receipt-${Date.now()}-${crypto2.randomBytes(4).toString("hex")}${safeExt}`;
          const { error: upErr } = await supabase.storage.from(RECEIPT_BUCKET).upload(objectPath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
          if (upErr) throw new Error(`Receipt upload failed: ${upErr.message}`);
          receiptUrl = supabase.storage.from(RECEIPT_BUCKET).getPublicUrl(objectPath).data.publicUrl;
        }
        const { data: insertedPay, error: payErr } = await supabase.from("payment_submissions").insert({
          id: `pay-${Date.now()}-${crypto2.randomBytes(2).toString("hex")}`,
          member_id: user.id,
          member_name: user.name,
          member_code: user.memberCode,
          membership_tier: user.membershipTier,
          billing_month: billingMonth?.trim() || (/* @__PURE__ */ new Date()).toISOString().slice(0, 7),
          amount_pkr: parsedAmount,
          method,
          transaction_ref: transactionRef.trim(),
          receipt_url: receiptUrl,
          receipt_file_name: req.file ? req.file.originalname : null,
          notes: notes?.trim() || "",
          status: "Pending",
          submitted_at: (/* @__PURE__ */ new Date()).toISOString()
        }).select("*").single();
        if (payErr) throw new Error(payErr.message);
        const { data: updatedProfile, error: profErr } = await supabase.from("profiles").update({ fee_status: "Pending Verification" }).eq("id", user.id).select("*").single();
        if (profErr) throw new Error(profErr.message);
        res.status(201).json({
          payment: mapPaymentRow(insertedPay),
          profile: mapProfileRow(updatedProfile)
        });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.post(
    "/api/member/feedback",
    requireAuth,
    requireActiveMember,
    async (req, res, next) => {
      try {
        const { category, trainerId, rating, message } = req.body;
        if (!message?.trim()) {
          res.status(400).json({ error: "Feedback message cannot be empty." });
          return;
        }
        const supabase = getSupabaseAdmin();
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const { data, error } = await supabase.from("feedback_entries").insert({
          id: `fbk-${Date.now()}-${crypto2.randomBytes(2).toString("hex")}`,
          member_id: req.authUser.id,
          author_name: req.authUser.name,
          author_email: req.authUser.email,
          category: category || "Facility",
          trainer_id: trainerId || null,
          rating: typeof rating === "number" ? Math.min(5, Math.max(1, rating)) : 5,
          message: message.trim(),
          status: "Open",
          created_at: now,
          updated_at: now
        }).select("*").single();
        if (error) throw new Error(error.message);
        res.status(201).json({ entry: mapFeedbackRow(data) });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.get("/api/admin/overview", requireAuth, requireAdmin, async (_req, res, next) => {
    try {
      const supabase = getSupabaseAdmin();
      const [
        members,
        trainers,
        settings,
        payRes,
        fbRes,
        attRes,
        bioRes,
        notifRes
      ] = await Promise.all([
        getMemberProfiles(),
        getTrainers(),
        getNotificationSettings(),
        supabase.from("payment_submissions").select("*").order("submitted_at", { ascending: false }),
        supabase.from("feedback_entries").select("*").order("created_at", { ascending: false }),
        supabase.from("attendance_logs").select("*").order("check_in_time", { ascending: false }).limit(30),
        supabase.from("biometric_profiles").select("*"),
        supabase.from("notification_logs").select("*").order("dispatched_at", { ascending: false }).limit(200)
      ]);
      const payments = (payRes.data || []).map((r) => mapPaymentRow(r));
      const feedback = (fbRes.data || []).map((r) => mapFeedbackRow(r));
      const attendance = (attRes.data || []).map(
        (r) => mapAttendanceRow(r)
      );
      const biometrics = (bioRes.data || []).map(
        (r) => sanitizeBiometricRow(mapBiometricRow(r))
      );
      const notificationLogs = (notifRes.data || []).map(
        (r) => mapNotificationLogRow(r)
      );
      const currentMonth = (/* @__PURE__ */ new Date()).toISOString().slice(0, 7);
      const todayPrefix = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const collectedThisMonthPkr = payments.filter((p) => p.status === "Approved" && p.billingMonth === currentMonth).reduce((acc, p) => acc + p.amountPkr, 0);
      const avgTrainerRating = trainers.length > 0 ? Number(
        (trainers.reduce((acc, t) => acc + t.rating, 0) / trainers.length).toFixed(2)
      ) : 0;
      const expiringSoonCount = members.filter(
        (m) => m.membershipActive !== false && computeDaysRemaining(m.subscriptionEndDate) <= settings.reminderDaysBefore
      ).length;
      res.json({
        metrics: {
          totalMembers: members.length,
          paidMembers: members.filter((m) => m.feeStatus === "Paid").length,
          pendingVerifications: payments.filter((p) => p.status === "Pending").length,
          overdueMembers: members.filter((m) => m.feeStatus === "Overdue").length,
          collectedThisMonthPkr,
          avgTrainerRating,
          openFeedbackCount: feedback.filter((f) => f.status !== "Resolved").length,
          todayCheckIns: attendance.filter((a) => a.checkInTime.startsWith(todayPrefix)).length,
          expiringSoonCount
        },
        members,
        payments,
        trainers,
        feedback,
        attendance,
        biometrics,
        notificationLogs,
        notificationSettings: settings
      });
    } catch (err) {
      next(err);
    }
  });
  app2.get("/api/reception/overview", requireAuth, requireStaff, async (_req, res, next) => {
    try {
      const supabase = getSupabaseAdmin();
      const [
        members,
        trainers,
        settings,
        bioRes,
        payRes,
        attRes,
        notifRes,
        resetRes
      ] = await Promise.all([
        getMemberProfiles(),
        getTrainers(),
        getNotificationSettings(),
        supabase.from("biometric_profiles").select("*"),
        supabase.from("payment_submissions").select("*").order("submitted_at", { ascending: false }),
        supabase.from("attendance_logs").select("*").order("check_in_time", { ascending: false }).limit(40),
        supabase.from("notification_logs").select("*").order("dispatched_at", { ascending: false }).limit(200),
        supabase.from("password_reset_requests").select("*").order("requested_at", { ascending: false })
      ]);
      const biometrics = (bioRes.data || []).map(
        (r) => sanitizeBiometricRow(mapBiometricRow(r))
      );
      const payments = (payRes.data || []).map((r) => mapPaymentRow(r));
      const attendance = (attRes.data || []).map(
        (r) => mapAttendanceRow(r)
      );
      const notificationLogs = (notifRes.data || []).map(
        (r) => mapNotificationLogRow(r)
      );
      const resetRequests = (resetRes.data || []).map(
        (r) => mapPasswordResetRow(r)
      );
      const sortedResetRequests = [...resetRequests].sort((a, b) => {
        if (a.status === "Pending" && b.status !== "Pending") return -1;
        if (a.status !== "Pending" && b.status === "Pending") return 1;
        return b.requestedAt.localeCompare(a.requestedAt);
      });
      const todayPrefix = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const todayLogs = attendance.filter((a) => a.checkInTime.startsWith(todayPrefix));
      const enrolledCount = biometrics.filter((b) => b.enrollmentStatus === "Enrolled").length;
      const overdueMembers = members.filter((m) => m.feeStatus === "Overdue");
      const pendingMembers = members.filter((m) => m.feeStatus === "Pending Verification");
      const totalPendingDuesPkr = [...overdueMembers, ...pendingMembers].reduce(
        (acc, m) => acc + (m.monthlyFeePkr || 0),
        0
      );
      const expiringSoonCount = members.filter(
        (m) => m.membershipActive !== false && computeDaysRemaining(m.subscriptionEndDate) <= settings.reminderDaysBefore
      ).length;
      res.json({
        metrics: {
          todayCheckIns: todayLogs.length,
          biometricCheckInsToday: todayLogs.filter(
            (a) => a.verificationSource === "Biometric Scanner"
          ).length,
          enrolledMembers: enrolledCount,
          totalMembers: members.length,
          overdueCount: overdueMembers.length,
          pendingVerificationCount: pendingMembers.length,
          totalPendingDuesPkr,
          expiringSoonCount,
          pendingPasswordResets: sortedResetRequests.filter((r) => r.status === "Pending").length
        },
        members,
        biometrics,
        payments,
        attendance,
        trainers,
        notificationLogs,
        notificationSettings: settings,
        passwordResetRequests: sortedResetRequests
      });
    } catch (err) {
      next(err);
    }
  });
  app2.post(
    "/api/reception/members",
    requireAuth,
    requireStaff,
    async (req, res, next) => {
      try {
        const {
          name,
          email,
          phone,
          membershipTier,
          discountPkr,
          discountReason,
          subscriptionEndDate,
          assignedTrainerId,
          emergencyContact,
          cnicLast4,
          staffNotes,
          password,
          biometricCapture
        } = req.body;
        if (!name?.trim() || !email?.trim() || !phone?.trim()) {
          res.status(400).json({ error: "Name, email, and phone are required." });
          return;
        }
        if (biometricCapture && !isValidHardwareBiometricSignal(biometricCapture.rawSignal, biometricCapture.credentialId)) {
          res.status(400).json({
            error: "Invalid or simulated biometric payload. Capture a live fingerprint directly from connected scanner hardware."
          });
          return;
        }
        const supabase = getSupabaseAdmin();
        const normalizedEmail = email.trim().toLowerCase();
        const { data: existingProfile } = await supabase.from("profiles").select("id").eq("email", normalizedEmail).maybeSingle();
        if (existingProfile) {
          res.status(409).json({ error: "A member with this email already exists." });
          return;
        }
        const initialPassword = password && password.length >= 6 ? password : createTemporaryPassword();
        const { data: createdAuth, error: createAuthError } = await supabase.auth.admin.createUser({
          email: normalizedEmail,
          password: initialPassword,
          email_confirm: true,
          user_metadata: { name: name.trim() }
        });
        if (createAuthError || !createdAuth.user) {
          res.status(400).json({
            error: createAuthError?.message || "Unable to provision auth user for member."
          });
          return;
        }
        const tier = membershipTier && TIER_FEES[membershipTier] ? membershipTier : "Official Package";
        const baseFee = TIER_FEES[tier];
        const parsedDiscount = Math.min(
          baseFee,
          Math.max(0, Math.round(Number(discountPkr) || 0))
        );
        const finalFee = Math.max(0, baseFee - parsedDiscount);
        const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
        const memberCode = await nextMemberCode();
        const resolvedEndDate = subscriptionEndDate?.trim() || addDaysIso(today, TIER_DURATION_DAYS[tier] || 30);
        const { data: insertedProfile, error: profErr } = await supabase.from("profiles").insert({
          id: createdAuth.user.id,
          member_code: memberCode,
          name: name.trim(),
          email: normalizedEmail,
          phone: phone.trim(),
          role: "member",
          membership_tier: tier,
          base_monthly_fee_pkr: baseFee,
          discount_pkr: parsedDiscount,
          discount_reason: parsedDiscount > 0 ? discountReason?.trim() || "Reception Desk Discount" : "",
          monthly_fee_pkr: finalFee,
          fee_status: "Overdue",
          fee_paid_through: "Unpaid",
          subscription_end_date: resolvedEndDate,
          join_date: today,
          assigned_trainer_id: assignedTrainerId?.trim() || null,
          emergency_contact: emergencyContact?.trim() || "",
          cnic_last4: cnicLast4 ? cnicLast4.replace(/\D/g, "").slice(-4) : "",
          membership_active: true,
          biometric_status: biometricCapture ? "Enrolled" : "Not Enrolled",
          biometric_finger_label: biometricCapture?.fingerLabel || null,
          staff_notes: staffNotes?.trim() || `Created at desk by ${req.authUser.name}`
        }).select("*").single();
        if (profErr || !insertedProfile) {
          await supabase.auth.admin.deleteUser(createdAuth.user.id);
          res.status(400).json({ error: profErr?.message || "Unable to save member profile." });
          return;
        }
        let createdBio;
        if (biometricCapture) {
          const tokenSource = (biometricCapture.rawSignal || biometricCapture.credentialId || "").trim();
          const now = (/* @__PURE__ */ new Date()).toISOString();
          const { data: bioRow, error: bioErr } = await supabase.from("biometric_profiles").insert({
            id: `bio-${Date.now()}-${crypto2.randomBytes(2).toString("hex")}`,
            member_id: createdAuth.user.id,
            member_code: memberCode,
            sensor_vendor: biometricCapture.sensorVendor || "ZKTeco SLK20R",
            finger_label: biometricCapture.fingerLabel || "Right Index",
            enrollment_status: "Enrolled",
            quality_score: typeof biometricCapture.qualityScore === "number" ? Math.min(100, Math.max(50, biometricCapture.qualityScore)) : 95,
            enrolled_at: now,
            enrolled_by: req.authUser.name,
            template_hash: hashBiometricSignal(tokenSource),
            hardware_serial: biometricCapture.hardwareSerial?.trim() || null,
            capture_protocol: biometricCapture.captureProtocol || "Local SDK Bridge",
            template_format: biometricCapture.templateFormat || "ISO-19794-2",
            credential_id: biometricCapture.credentialId?.trim() || null
          }).select("*").single();
          if (bioErr) throw new Error(bioErr.message);
          createdBio = mapBiometricRow(bioRow);
        }
        res.status(201).json({
          member: mapProfileRow(insertedProfile),
          ...createdBio ? { biometric: sanitizeBiometricRow(createdBio) } : {}
        });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.patch(
    "/api/reception/members/:memberId",
    requireAuth,
    requireStaff,
    async (req, res, next) => {
      try {
        const {
          name,
          phone,
          membershipTier,
          discountPkr,
          discountReason,
          subscriptionEndDate,
          assignedTrainerId,
          emergencyContact,
          cnicLast4,
          membershipActive,
          staffNotes
        } = req.body;
        const member = await getProfileById(req.params.memberId);
        if (!member || member.role !== "member") {
          res.status(404).json({ error: "Member profile not found." });
          return;
        }
        const nextTier = membershipTier && TIER_FEES[membershipTier] ? membershipTier : member.membershipTier;
        const baseFee = TIER_FEES[nextTier] || member.baseMonthlyFeePkr || 7e3;
        const nextDiscount = typeof discountPkr === "number" && !Number.isNaN(discountPkr) ? Math.min(baseFee, Math.max(0, Math.round(discountPkr))) : member.discountPkr || 0;
        const nextFee = Math.max(0, baseFee - nextDiscount);
        const patch = {
          membership_tier: nextTier,
          base_monthly_fee_pkr: baseFee,
          discount_pkr: nextDiscount,
          monthly_fee_pkr: nextFee
        };
        if (name?.trim()) patch.name = name.trim();
        if (phone?.trim()) patch.phone = phone.trim();
        if (typeof discountReason === "string") patch.discount_reason = discountReason.trim();
        if (typeof subscriptionEndDate === "string" && subscriptionEndDate.trim()) {
          patch.subscription_end_date = subscriptionEndDate.trim();
        }
        if (typeof assignedTrainerId === "string") {
          patch.assigned_trainer_id = assignedTrainerId.trim() || null;
        }
        if (typeof emergencyContact === "string") patch.emergency_contact = emergencyContact.trim();
        if (typeof cnicLast4 === "string") {
          patch.cnic_last4 = cnicLast4.replace(/\D/g, "").slice(-4);
        }
        if (typeof membershipActive === "boolean") patch.membership_active = membershipActive;
        if (typeof staffNotes === "string") patch.staff_notes = staffNotes.trim();
        const supabase = getSupabaseAdmin();
        const { data: updated, error } = await supabase.from("profiles").update(patch).eq("id", member.id).select("*").single();
        if (error) throw new Error(error.message);
        res.json({ member: mapProfileRow(updated) });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.post(
    "/api/reception/password-resets/:requestId/resolve",
    requireAuth,
    requireStaff,
    async (req, res, next) => {
      try {
        const { action, newPassword, resolutionNote } = req.body;
        if (action !== "reset" && action !== "dismiss") {
          res.status(400).json({ error: "Action must be reset or dismiss." });
          return;
        }
        const supabase = getSupabaseAdmin();
        const { data: resetRow, error: resetErr } = await supabase.from("password_reset_requests").select("*").eq("id", req.params.requestId).maybeSingle();
        if (resetErr) throw new Error(resetErr.message);
        if (!resetRow) {
          res.status(404).json({ error: "Password reset request not found." });
          return;
        }
        const resetReq = mapPasswordResetRow(resetRow);
        const now = (/* @__PURE__ */ new Date()).toISOString();
        if (action === "dismiss") {
          const { data: dismissed, error: disErr } = await supabase.from("password_reset_requests").update({
            status: "Dismissed",
            resolved_at: now,
            resolved_by: req.authUser.name,
            resolution_note: resolutionNote?.trim() || "Dismissed by reception desk."
          }).eq("id", resetReq.id).select("*").single();
          if (disErr) throw new Error(disErr.message);
          res.json({ request: mapPasswordResetRow(dismissed) });
          return;
        }
        const member = await getProfileById(resetReq.memberId);
        if (!member || member.role !== "member") {
          res.status(404).json({ error: "Linked member profile not found." });
          return;
        }
        const candidate = newPassword?.trim() || "";
        if (candidate && candidate.length < 6) {
          res.status(400).json({ error: "Temporary password must be at least 6 characters." });
          return;
        }
        const temporaryPassword = candidate || createTemporaryPassword();
        const { error: authUpdErr } = await supabase.auth.admin.updateUserById(member.id, {
          password: temporaryPassword
        });
        if (authUpdErr) throw new Error(authUpdErr.message);
        const { data: updatedReq, error: reqUpdErr } = await supabase.from("password_reset_requests").update({
          status: "Completed",
          resolved_at: now,
          resolved_by: req.authUser.name,
          resolution_note: resolutionNote?.trim() || "Temporary password generated and issued by reception."
        }).eq("id", resetReq.id).select("*").single();
        if (reqUpdErr) throw new Error(reqUpdErr.message);
        res.json({
          request: mapPasswordResetRow(updatedReq),
          temporaryPassword,
          whatsappDeepLink: buildPasswordResetWhatsAppLink(member, temporaryPassword)
        });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.post(
    "/api/reception/members/:memberId/reset-password",
    requireAuth,
    requireStaff,
    async (req, res, next) => {
      try {
        const { newPassword, resolutionNote } = req.body;
        const member = await getProfileById(req.params.memberId);
        if (!member || member.role !== "member") {
          res.status(404).json({ error: "Member not found." });
          return;
        }
        const candidate = newPassword?.trim() || "";
        if (candidate && candidate.length < 6) {
          res.status(400).json({ error: "Temporary password must be at least 6 characters." });
          return;
        }
        const supabase = getSupabaseAdmin();
        const temporaryPassword = candidate || createTemporaryPassword();
        const { error: authUpdErr } = await supabase.auth.admin.updateUserById(member.id, {
          password: temporaryPassword
        });
        if (authUpdErr) throw new Error(authUpdErr.message);
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const { data: pendingRow } = await supabase.from("password_reset_requests").select("*").eq("member_id", member.id).eq("status", "Pending").maybeSingle();
        let savedRequest;
        if (pendingRow) {
          const { data: updated, error: updErr } = await supabase.from("password_reset_requests").update({
            status: "Completed",
            resolved_at: now,
            resolved_by: req.authUser.name,
            resolution_note: resolutionNote?.trim() || "Password reset initiated by reception desk."
          }).eq("id", pendingRow.id).select("*").single();
          if (updErr) throw new Error(updErr.message);
          savedRequest = mapPasswordResetRow(updated);
        } else {
          const { data: inserted, error: insErr } = await supabase.from("password_reset_requests").insert({
            id: `pwr-${Date.now()}-${crypto2.randomBytes(2).toString("hex")}`,
            member_id: member.id,
            member_code: member.memberCode,
            member_name: member.name,
            email: member.email,
            phone_provided: member.phone,
            registered_phone: member.phone,
            note: resolutionNote?.trim() || "Staff-initiated member password reset.",
            status: "Completed",
            trigger_source: "Reception Initiated",
            requested_at: now,
            resolved_at: now,
            resolved_by: req.authUser.name,
            resolution_note: resolutionNote?.trim() || "Temporary password issued directly by reception."
          }).select("*").single();
          if (insErr) throw new Error(insErr.message);
          savedRequest = mapPasswordResetRow(inserted);
        }
        res.json({
          member,
          request: savedRequest,
          temporaryPassword,
          whatsappDeepLink: buildPasswordResetWhatsAppLink(member, temporaryPassword)
        });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.post(
    "/api/reception/biometric/enroll",
    requireAuth,
    requireStaff,
    async (req, res, next) => {
      try {
        const {
          memberId,
          sensorVendor,
          fingerLabel,
          rawSignal,
          qualityScore,
          hardwareSerial,
          captureProtocol,
          templateFormat,
          credentialId
        } = req.body;
        if (!memberId) {
          res.status(400).json({ error: "Member selection is required." });
          return;
        }
        if (!isValidHardwareBiometricSignal(rawSignal, credentialId)) {
          res.status(400).json({
            error: "Live fingerprint capture from physical scanner hardware is required. Connect Local SDK Bridge, WebUSB optical reader, or WebAuthn biometric sensor."
          });
          return;
        }
        const member = await getProfileById(memberId);
        if (!member || member.role !== "member") {
          res.status(404).json({ error: "Member not found." });
          return;
        }
        const supabase = getSupabaseAdmin();
        const tokenSource = (rawSignal || credentialId || "").trim();
        const templateHash = hashBiometricSignal(tokenSource);
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const vendor = sensorVendor || "ZKTeco SLK20R";
        const finger = fingerLabel || "Right Index";
        const quality = typeof qualityScore === "number" ? Math.min(100, Math.max(50, qualityScore)) : 95;
        const { data: existing } = await supabase.from("biometric_profiles").select("*").eq("member_id", member.id).maybeSingle();
        let savedBioRow;
        if (existing) {
          const { data: updatedBio, error: updErr } = await supabase.from("biometric_profiles").update({
            sensor_vendor: vendor,
            finger_label: finger,
            enrollment_status: "Enrolled",
            quality_score: quality,
            enrolled_at: now,
            enrolled_by: req.authUser.name,
            template_hash: templateHash,
            hardware_serial: hardwareSerial?.trim() || existing.hardware_serial || null,
            capture_protocol: captureProtocol || "Local SDK Bridge",
            template_format: templateFormat || "ISO-19794-2",
            credential_id: credentialId?.trim() || existing.credential_id || null
          }).eq("member_id", member.id).select("*").single();
          if (updErr) throw new Error(updErr.message);
          savedBioRow = mapBiometricRow(updatedBio);
        } else {
          const { data: insertedBio, error: insErr } = await supabase.from("biometric_profiles").insert({
            id: `bio-${Date.now()}-${crypto2.randomBytes(2).toString("hex")}`,
            member_id: member.id,
            member_code: member.memberCode,
            sensor_vendor: vendor,
            finger_label: finger,
            enrollment_status: "Enrolled",
            quality_score: quality,
            enrolled_at: now,
            enrolled_by: req.authUser.name,
            template_hash: templateHash,
            hardware_serial: hardwareSerial?.trim() || null,
            capture_protocol: captureProtocol || "Local SDK Bridge",
            template_format: templateFormat || "ISO-19794-2",
            credential_id: credentialId?.trim() || null
          }).select("*").single();
          if (insErr) throw new Error(insErr.message);
          savedBioRow = mapBiometricRow(insertedBio);
        }
        const { data: updatedProf, error: profErr } = await supabase.from("profiles").update({
          biometric_status: "Enrolled",
          biometric_finger_label: finger
        }).eq("id", member.id).select("*").single();
        if (profErr) throw new Error(profErr.message);
        res.status(201).json({
          biometric: sanitizeBiometricRow(savedBioRow),
          member: mapProfileRow(updatedProf)
        });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.patch(
    "/api/reception/biometric/:memberId/status",
    requireAuth,
    requireStaff,
    async (req, res, next) => {
      try {
        const { enrollmentStatus } = req.body;
        if (enrollmentStatus !== "Enrolled" && enrollmentStatus !== "Suspended" && enrollmentStatus !== "Not Enrolled") {
          res.status(400).json({ error: "Invalid biometric enrollment status." });
          return;
        }
        const supabase = getSupabaseAdmin();
        const [{ data: updatedBio, error: bioErr }, { data: updatedMember, error: memErr }] = await Promise.all([
          supabase.from("biometric_profiles").update({ enrollment_status: enrollmentStatus }).eq("member_id", req.params.memberId).select("*").maybeSingle(),
          supabase.from("profiles").update({ biometric_status: enrollmentStatus }).eq("id", req.params.memberId).eq("role", "member").select("*").maybeSingle()
        ]);
        if (bioErr) throw new Error(bioErr.message);
        if (memErr) throw new Error(memErr.message);
        if (!updatedBio || !updatedMember) {
          res.status(404).json({ error: "Biometric profile not found." });
          return;
        }
        res.json({
          biometric: sanitizeBiometricRow(mapBiometricRow(updatedBio)),
          member: mapProfileRow(updatedMember)
        });
      } catch (err) {
        next(err);
      }
    }
  );
  async function executeHardwareBiometricVerification(params) {
    const {
      rawSignal,
      credentialId,
      deviceName,
      hardwareSerial,
      captureProtocol,
      zoneOrClass,
      matchConfidence,
      operatorName
    } = params;
    if (!isValidHardwareBiometricSignal(rawSignal, credentialId)) {
      return {
        status: 400,
        error: "No valid hardware fingerprint template received. Place finger on the physical scanner to capture a live biometric signal."
      };
    }
    const supabase = getSupabaseAdmin();
    let bioRowRaw = null;
    if (credentialId && credentialId.trim().length >= 16) {
      const { data } = await supabase.from("biometric_profiles").select("*").eq("credential_id", credentialId.trim()).maybeSingle();
      if (data) bioRowRaw = data;
    }
    if (!bioRowRaw && rawSignal && rawSignal.trim().length >= 16) {
      const candidateHash = hashBiometricSignal(rawSignal.trim());
      const { data } = await supabase.from("biometric_profiles").select("*").eq("template_hash", candidateHash).maybeSingle();
      if (data) bioRowRaw = data;
    }
    if (!bioRowRaw) {
      return {
        status: 404,
        error: "Fingerprint template did not match any enrolled member. Enroll the member using live hardware capture first."
      };
    }
    const bioMatch = mapBiometricRow(bioRowRaw);
    if (bioMatch.enrollmentStatus !== "Enrolled") {
      return {
        status: 403,
        error: `Biometric access is currently ${bioMatch.enrollmentStatus} for ${bioMatch.memberCode}.`
      };
    }
    const member = await getProfileById(bioMatch.memberId);
    if (!member) {
      return { status: 404, error: "Linked member profile not found." };
    }
    if (isMembershipExpired(member)) {
      return {
        status: 403,
        error: "Membership Expired."
      };
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await supabase.from("biometric_profiles").update({ last_matched_at: now }).eq("id", bioMatch.id);
    bioMatch.lastMatchedAt = now;
    const confidence = typeof matchConfidence === "number" ? Number(Math.min(99.9, Math.max(85, matchConfidence)).toFixed(1)) : 99.1;
    const { data: pendingRows } = await supabase.from("payment_submissions").select("*").eq("member_id", member.id).eq("status", "Pending").order("submitted_at", { ascending: false });
    const pendingPayments = (pendingRows || []).map(
      (r) => mapPaymentRow(r)
    );
    let accessOutcome = "Granted";
    let alertLevel = "clear";
    let alertMessage = `Monthly fee is Paid through ${member.feePaidThrough}. Floor access cleared.`;
    if (member.feeStatus === "Pending Verification") {
      accessOutcome = "Granted with Due Alert";
      alertLevel = "pending_review";
      alertMessage = pendingPayments.length > 0 ? `${pendingPayments[0].method} slip (${pendingPayments[0].transactionRef}) awaiting staff verification.` : "Monthly fee is marked Pending Verification.";
    } else if (member.feeStatus === "Overdue") {
      accessOutcome = "Hold - Overdue";
      alertLevel = "overdue";
      alertMessage = `Monthly fee of PKR ${member.monthlyFeePkr.toLocaleString("en-PK")} is Overdue (last paid: ${member.feePaidThrough}).`;
    }
    const serialSuffix = hardwareSerial?.trim() || bioMatch.hardwareSerial;
    const baseDevice = deviceName?.trim() || bioMatch.sensorVendor;
    const protocolTag = captureProtocol || bioMatch.captureProtocol || "Hardware Reader";
    const resolvedDevice = serialSuffix ? `${baseDevice} \xB7 ${serialSuffix}` : baseDevice;
    const { data: attInserted, error: attErr } = await supabase.from("attendance_logs").insert({
      id: `att-${Date.now()}-${crypto2.randomBytes(2).toString("hex")}`,
      member_id: member.id,
      member_name: member.name,
      member_code: member.memberCode,
      check_in_time: now,
      zone_or_class: zoneOrClass?.trim() || "Main Turnstile Entry",
      verified_by: `${operatorName} \xB7 ${protocolTag}`,
      verification_source: "Biometric Scanner",
      device_name: resolvedDevice,
      match_confidence: confidence,
      fee_status_at_check_in: member.feeStatus,
      access_outcome: accessOutcome
    }).select("*").single();
    if (attErr) throw new Error(attErr.message);
    const { data: recentRows } = await supabase.from("attendance_logs").select("*").eq("member_id", member.id).order("check_in_time", { ascending: false }).limit(6);
    const attendanceEntry = mapAttendanceRow(attInserted);
    const recentLogs = (recentRows || []).map(
      (r) => mapAttendanceRow(r)
    );
    const payload = {
      matched: true,
      member,
      biometric: sanitizeBiometricRow(bioMatch),
      attendanceEntry,
      pendingPayments,
      recentLogs,
      alertLevel,
      alertMessage
    };
    biometricEventBus.emit("scan-verified", payload);
    return { status: 201, payload };
  }
  app2.post(
    "/api/reception/biometric/verify",
    requireAuth,
    requireStaff,
    async (req, res, next) => {
      try {
        const {
          rawSignal,
          credentialId,
          deviceName,
          hardwareSerial,
          captureProtocol,
          zoneOrClass,
          matchConfidence
        } = req.body;
        const outcome = await executeHardwareBiometricVerification({
          rawSignal,
          credentialId,
          deviceName,
          hardwareSerial,
          captureProtocol,
          zoneOrClass,
          matchConfidence,
          operatorName: req.authUser.name
        });
        if ("error" in outcome) {
          res.status(outcome.status).json({ error: outcome.error });
          return;
        }
        res.status(201).json(outcome.payload);
      } catch (err) {
        next(err);
      }
    }
  );
  app2.post("/api/reception/biometric/hardware-push", async (req, res, next) => {
    try {
      const configuredKey = process.env.HARDWARE_AGENT_KEY;
      const providedKey = req.header("X-Hardware-Agent-Key");
      const authHeader = req.header("Authorization");
      let operatorName = "Hardware Terminal Daemon";
      let authorized = false;
      if (configuredKey && providedKey && providedKey === configuredKey) {
        authorized = true;
      } else if (authHeader?.startsWith("Bearer ")) {
        try {
          const user = await resolveUserFromToken(authHeader.slice(7).trim());
          if (user && (user.role === "reception" || user.role === "admin")) {
            authorized = true;
            operatorName = user.name;
          }
        } catch {
          authorized = false;
        }
      }
      if (!authorized) {
        res.status(401).json({ error: "Unauthorized hardware terminal push." });
        return;
      }
      const { rawSignal, credentialId, deviceName, hardwareSerial, zoneOrClass, matchConfidence } = req.body;
      const outcome = await executeHardwareBiometricVerification({
        rawSignal,
        credentialId,
        deviceName,
        hardwareSerial,
        captureProtocol: "Local SDK Bridge",
        zoneOrClass,
        matchConfidence,
        operatorName
      });
      if ("error" in outcome) {
        res.status(outcome.status).json({ error: outcome.error });
        return;
      }
      res.status(201).json(outcome.payload);
    } catch (err) {
      next(err);
    }
  });
  app2.get("/api/reception/biometric/stream", async (req, res) => {
    const queryToken = typeof req.query.token === "string" ? req.query.token : "";
    const bearer = req.header("Authorization")?.replace(/^Bearer\s+/i, "") || queryToken;
    if (!bearer) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    try {
      const user = await resolveUserFromToken(bearer);
      if (!user) {
        res.status(401).json({ error: "Invalid session token." });
        return;
      }
      if (user.role !== "reception" && user.role !== "admin") {
        res.status(403).json({ error: "Staff clearance required." });
        return;
      }
    } catch {
      res.status(401).json({ error: "Invalid session token." });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const onVerified = (payload) => {
      res.write(`event: scan-verified
data: ${JSON.stringify(payload)}

`);
    };
    biometricEventBus.on("scan-verified", onVerified);
    const keepAlive = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 2e4);
    req.on("close", () => {
      clearInterval(keepAlive);
      biometricEventBus.off("scan-verified", onVerified);
    });
  });
  app2.post(
    "/api/admin/payments/:paymentId/review",
    requireAuth,
    requireStaff,
    async (req, res, next) => {
      try {
        const { action, adminRemark } = req.body;
        if (action !== "approve" && action !== "reject") {
          res.status(400).json({ error: "Action must be approve or reject." });
          return;
        }
        const supabase = getSupabaseAdmin();
        const { data: payRow, error: payFetchErr } = await supabase.from("payment_submissions").select("*").eq("id", req.params.paymentId).maybeSingle();
        if (payFetchErr) throw new Error(payFetchErr.message);
        if (!payRow) {
          res.status(404).json({ error: "Payment submission not found." });
          return;
        }
        const payment = mapPaymentRow(payRow);
        const remarkText = adminRemark?.trim() || (action === "approve" ? "Payment verified and credited." : "Transaction ID could not be matched. Please re-upload clear receipt.");
        const { data: updatedPay, error: payUpdErr } = await supabase.from("payment_submissions").update({
          status: action === "approve" ? "Approved" : "Rejected",
          reviewed_at: (/* @__PURE__ */ new Date()).toISOString(),
          reviewed_by: req.authUser.name,
          admin_remark: remarkText
        }).eq("id", payment.id).select("*").single();
        if (payUpdErr) throw new Error(payUpdErr.message);
        const member = await getProfileById(payment.memberId);
        if (member) {
          if (action === "approve") {
            const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
            const anchor = member.subscriptionEndDate && member.subscriptionEndDate > today ? member.subscriptionEndDate : today;
            const nextEnd = addDaysIso(anchor, TIER_DURATION_DAYS[member.membershipTier] || 30);
            await supabase.from("profiles").update({
              fee_status: "Paid",
              fee_paid_through: payment.billingMonth,
              subscription_end_date: nextEnd,
              membership_active: true
            }).eq("id", member.id);
          } else {
            await supabase.from("profiles").update({ fee_status: "Overdue" }).eq("id", member.id);
          }
        }
        res.json({ payment: mapPaymentRow(updatedPay) });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.post(
    "/api/admin/members/:memberId/fee-status",
    requireAuth,
    requireStaff,
    async (req, res, next) => {
      try {
        const { feeStatus, recordCashPayment, paymentMethod, transactionRef } = req.body;
        const member = await getProfileById(req.params.memberId);
        if (!member || member.role !== "member") {
          res.status(404).json({ error: "Member not found." });
          return;
        }
        const supabase = getSupabaseAdmin();
        const currentMonth = (/* @__PURE__ */ new Date()).toISOString().slice(0, 7);
        const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
        if (recordCashPayment) {
          const method = paymentMethod || "Cash";
          const anchor = member.subscriptionEndDate && member.subscriptionEndDate > today ? member.subscriptionEndDate : today;
          const nextEnd = addDaysIso(anchor, TIER_DURATION_DAYS[member.membershipTier] || 30);
          const now = (/* @__PURE__ */ new Date()).toISOString();
          await supabase.from("payment_submissions").insert({
            id: `pay-${Date.now()}-${crypto2.randomBytes(2).toString("hex")}`,
            member_id: member.id,
            member_name: member.name,
            member_code: member.memberCode,
            membership_tier: member.membershipTier,
            billing_month: currentMonth,
            amount_pkr: member.monthlyFeePkr,
            method,
            transaction_ref: transactionRef?.trim() || `${method === "Cash" ? "CASH-DESK" : "DESK-REF"}-${Date.now().toString().slice(-6)}`,
            receipt_url: null,
            receipt_file_name: null,
            notes: `Recorded at Reception/Admin Desk by ${req.authUser.name}.`,
            status: "Approved",
            submitted_at: now,
            reviewed_at: now,
            reviewed_by: req.authUser.name,
            admin_remark: "Verified directly at FitBase Reception Desk."
          });
          const { data: updatedProf, error: profErr } = await supabase.from("profiles").update({
            fee_status: "Paid",
            fee_paid_through: currentMonth,
            subscription_end_date: nextEnd,
            membership_active: true
          }).eq("id", member.id).select("*").single();
          if (profErr) throw new Error(profErr.message);
          res.json({ member: mapProfileRow(updatedProf) });
          return;
        }
        if (feeStatus) {
          const patch = { fee_status: feeStatus };
          if (feeStatus === "Paid") {
            patch.fee_paid_through = currentMonth;
          }
          const { data: updatedProf, error: profErr } = await supabase.from("profiles").update(patch).eq("id", member.id).select("*").single();
          if (profErr) throw new Error(profErr.message);
          res.json({ member: mapProfileRow(updatedProf) });
          return;
        }
        res.json({ member });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.post(
    "/api/staff/notifications/run-sweep",
    requireAuth,
    requireStaff,
    async (_req, res, next) => {
      try {
        const result = await runExpirationSweep("Manual Run");
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );
  app2.post(
    "/api/staff/notifications/send/:memberId",
    requireAuth,
    requireStaff,
    async (req, res, next) => {
      try {
        const member = await getProfileById(req.params.memberId);
        if (!member || member.role !== "member") {
          res.status(404).json({ error: "Member not found." });
          return;
        }
        const settings = await getNotificationSettings();
        const endDate = member.subscriptionEndDate || addDaysIso(member.joinDate, 30);
        const daysRemaining = computeDaysRemaining(endDate);
        const log = await dispatchWhatsAppReminder(member, daysRemaining, "Manual Run", settings);
        res.status(201).json({ log, whatsappDeepLink: log.whatsappDeepLink || "" });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.patch(
    "/api/staff/notifications/settings",
    requireAuth,
    requireStaff,
    async (req, res, next) => {
      try {
        const { reminderDaysBefore, dailyCronTime, whatsappEnabled } = req.body;
        const current = await getNotificationSettings();
        const nextReminder = typeof reminderDaysBefore === "number" && !Number.isNaN(reminderDaysBefore) ? Math.min(30, Math.max(1, Math.round(reminderDaysBefore))) : current.reminderDaysBefore;
        const nextCron = typeof dailyCronTime === "string" && /^\d{2}:\d{2}$/.test(dailyCronTime.trim()) ? dailyCronTime.trim() : current.dailyCronTime;
        const nextWa = typeof whatsappEnabled === "boolean" ? whatsappEnabled : current.whatsappEnabled;
        const supabase = getSupabaseAdmin();
        const { data, error } = await supabase.from("notification_settings").upsert({
          id: 1,
          reminder_days_before: nextReminder,
          daily_cron_time: nextCron,
          whatsapp_enabled: nextWa,
          last_sweep_at: current.lastSweepAt,
          last_sweep_matched_count: current.lastSweepMatchedCount
        }).select("*").single();
        if (error) throw new Error(error.message);
        res.json({ settings: mapNotificationSettingsRow(data) });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.post(
    "/api/admin/members/:memberId/checkin",
    requireAuth,
    requireStaff,
    async (req, res, next) => {
      try {
        const member = await getProfileById(req.params.memberId);
        if (!member || member.role !== "member") {
          res.status(404).json({ error: "Member not found." });
          return;
        }
        if (isMembershipExpired(member)) {
          res.status(403).json({ error: "Membership Expired." });
          return;
        }
        const supabase = getSupabaseAdmin();
        const { data, error } = await supabase.from("attendance_logs").insert({
          id: `att-${Date.now()}-${crypto2.randomBytes(2).toString("hex")}`,
          member_id: member.id,
          member_name: member.name,
          member_code: member.memberCode,
          check_in_time: (/* @__PURE__ */ new Date()).toISOString(),
          zone_or_class: "Main Gym Floor",
          verified_by: `${req.authUser.name} (Front Desk)`,
          verification_source: "Front Desk Manual",
          fee_status_at_check_in: member.feeStatus,
          access_outcome: member.feeStatus === "Paid" ? "Granted" : member.feeStatus === "Pending Verification" ? "Granted with Due Alert" : "Hold - Overdue"
        }).select("*").single();
        if (error) throw new Error(error.message);
        res.status(201).json({ entry: mapAttendanceRow(data) });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.post("/api/admin/trainers", requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const body = req.body;
      if (!body.name?.trim() || !body.specialty?.trim()) {
        res.status(400).json({ error: "Trainer name and specialty are required." });
        return;
      }
      const validKeys = [
        "coach_bilal",
        "coach_ayesha",
        "coach_zohaib",
        "coach_nadia",
        "default"
      ];
      const portraitKey = body.portraitKey && validKeys.includes(body.portraitKey) ? body.portraitKey : "default";
      const supabase = getSupabaseAdmin();
      const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const { data, error } = await supabase.from("trainers").insert({
        id: `trn-${Date.now()}-${crypto2.randomBytes(2).toString("hex")}`,
        name: body.name.trim(),
        specialty: body.specialty.trim(),
        certifications: body.certifications?.trim() || "Certified FitBase Coach",
        experience_years: Math.max(0, Math.round(Number(body.experienceYears ?? 1))),
        portrait_key: portraitKey,
        portrait_url: body.portraitUrl?.trim() || null,
        active_clients: Math.max(0, Math.round(Number(body.activeClients ?? 0))),
        sessions_this_month: Math.max(0, Math.round(Number(body.sessionsThisMonth ?? 0))),
        attendance_completion_rate: Math.min(
          100,
          Math.max(0, Math.round(Number(body.attendanceCompletionRate ?? 100)))
        ),
        client_retention_rate: Math.min(
          100,
          Math.max(0, Math.round(Number(body.clientRetentionRate ?? 100)))
        ),
        rating: Number(Math.min(5, Math.max(1, Number(body.rating ?? 5))).toFixed(1)),
        bio: body.bio?.trim() || "",
        admin_review_note: body.adminReviewNote?.trim() || "Added by FitBase Management.",
        last_evaluated_at: today
      }).select("*").single();
      if (error) throw new Error(error.message);
      res.status(201).json({ trainer: mapTrainerRow(data) });
    } catch (err) {
      next(err);
    }
  });
  app2.patch(
    "/api/admin/trainers/:trainerId",
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
      try {
        const body = req.body;
        const supabase = getSupabaseAdmin();
        const { data: existingRow, error: fetchErr } = await supabase.from("trainers").select("*").eq("id", req.params.trainerId).maybeSingle();
        if (fetchErr) throw new Error(fetchErr.message);
        if (!existingRow) {
          res.status(404).json({ error: "Trainer record not found." });
          return;
        }
        const patch = {
          last_evaluated_at: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10)
        };
        if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
        if (typeof body.specialty === "string" && body.specialty.trim()) {
          patch.specialty = body.specialty.trim();
        }
        if (typeof body.certifications === "string") {
          patch.certifications = body.certifications.trim();
        }
        if (typeof body.experienceYears === "number" && !Number.isNaN(body.experienceYears)) {
          patch.experience_years = Math.max(0, Math.round(body.experienceYears));
        }
        if (body.portraitKey) {
          patch.portrait_key = body.portraitKey;
        }
        if (body.portraitUrl !== void 0) {
          patch.portrait_url = body.portraitUrl?.trim() || null;
        }
        if (typeof body.activeClients === "number" && !Number.isNaN(body.activeClients)) {
          patch.active_clients = Math.max(0, Math.round(body.activeClients));
        }
        if (typeof body.sessionsThisMonth === "number" && !Number.isNaN(body.sessionsThisMonth)) {
          patch.sessions_this_month = Math.max(0, Math.round(body.sessionsThisMonth));
        }
        if (typeof body.attendanceCompletionRate === "number" && !Number.isNaN(body.attendanceCompletionRate)) {
          patch.attendance_completion_rate = Math.min(
            100,
            Math.max(0, Math.round(body.attendanceCompletionRate))
          );
        }
        if (typeof body.clientRetentionRate === "number" && !Number.isNaN(body.clientRetentionRate)) {
          patch.client_retention_rate = Math.min(
            100,
            Math.max(0, Math.round(body.clientRetentionRate))
          );
        }
        if (typeof body.rating === "number" && !Number.isNaN(body.rating)) {
          patch.rating = Number(Math.min(5, Math.max(1, body.rating)).toFixed(1));
        }
        if (typeof body.bio === "string") patch.bio = body.bio.trim();
        if (typeof body.adminReviewNote === "string") {
          patch.admin_review_note = body.adminReviewNote.trim();
        }
        const { data: updated, error: updErr } = await supabase.from("trainers").update(patch).eq("id", req.params.trainerId).select("*").single();
        if (updErr) throw new Error(updErr.message);
        if (typeof patch.name === "string") {
          await supabase.from("gym_classes").update({ trainer_name: patch.name }).eq("trainer_id", req.params.trainerId);
        }
        res.json({ trainer: mapTrainerRow(updated) });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.delete(
    "/api/admin/trainers/:trainerId",
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
      try {
        const supabase = getSupabaseAdmin();
        const { data: deleted, error } = await supabase.from("trainers").delete().eq("id", req.params.trainerId).select("id");
        if (error) throw new Error(error.message);
        if (!deleted || deleted.length === 0) {
          res.status(404).json({ error: "Trainer record not found." });
          return;
        }
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.patch(
    "/api/admin/feedback/:feedbackId",
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
      try {
        const { status, adminReply } = req.body;
        const patch = {
          updated_at: (/* @__PURE__ */ new Date()).toISOString()
        };
        if (status === "Open" || status === "In Review" || status === "Resolved") {
          patch.status = status;
        }
        if (typeof adminReply === "string") {
          patch.admin_reply = adminReply.trim();
        }
        const supabase = getSupabaseAdmin();
        const { data, error } = await supabase.from("feedback_entries").update(patch).eq("id", req.params.feedbackId).select("*").maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) {
          res.status(404).json({ error: "Feedback record not found." });
          return;
        }
        res.json({ entry: mapFeedbackRow(data) });
      } catch (err) {
        next(err);
      }
    }
  );
  app2.get("/api/cron/sweep", async (req, res, next) => {
    try {
      const secret = process.env.CRON_SECRET;
      if (!secret || req.header("Authorization") !== `Bearer ${secret}`) {
        res.status(401).json({ error: "Unauthorized cron invocation." });
        return;
      }
      res.json(await runExpirationSweep("Daily Cron"));
    } catch (err) {
      next(err);
    }
  });
  app2.use((err, _req, res, _next) => {
    if (err instanceof SupabaseConfigError) {
      res.status(503).json({ error: err.message });
      return;
    }
    if (err instanceof Error) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: "Unexpected server error." });
  });
  return app2;
}
async function startServer() {
  const app2 = createApp();
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app2.use(vite.middlewares);
  } else {
    const distDir = path2.resolve(process.cwd(), "dist");
    app2.use(express.static(distDir));
    app2.get("*", (_req, res) => {
      res.sendFile(path2.join(distDir, "index.html"));
    });
  }
  const checkDailyCron = async () => {
    if (!isSupabaseConfigured()) return;
    try {
      const settings = await getNotificationSettings();
      const now = /* @__PURE__ */ new Date();
      const today = now.toISOString().slice(0, 10);
      const currentHm = now.toTimeString().slice(0, 5);
      const targetHm = settings.dailyCronTime || "08:00";
      const alreadySweptToday = settings.lastSweepAt?.startsWith(today);
      if (!alreadySweptToday && currentHm >= targetHm) {
        await runExpirationSweep("Daily Cron");
      }
    } catch {
    }
  };
  void checkDailyCron();
  setInterval(() => {
    void checkDailyCron();
  }, 6e4);
  app2.listen(PORT, "0.0.0.0", () => {
    console.log(`FitBase Fitness Center server running on http://0.0.0.0:${PORT}`);
  });
}
if (!process.env.VERCEL && process.argv[1] && import.meta.url === pathToFileURL(path2.resolve(process.argv[1])).href) {
  void startServer();
}

// server/vercel.ts
var app = createApp();
var vercel_default = app;
export {
  vercel_default as default
};
