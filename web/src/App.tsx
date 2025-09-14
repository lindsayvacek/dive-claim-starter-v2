// App.tsx — Dive Guide Claim (lock-safe)
// Features:
// - Create Job (with customer contact)
// - Details modal: description + contact (admin or assigned guide via RLS)
// - Claim / Unclaim (lock-safe RPCs on DB), Assign to guide (admin), Mark complete, Cancel job
// - Admin "All Jobs" with optional "Include canceled"
// - Scrollable modals
//
// Requires ./supabase client and these RPCs in DB:
// claim_job (lock-safe), unclaim_job (lock-safe), assign_job, complete_job, cancel_job

import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";

// ---------- Types ----------
type JobContact = {
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
};

type Job = {
  id: string;
  title: string;
  date: string;            // YYYY-MM-DD
  call_time: string;       // HH:MM
  location: string | null;
  pay: number | null;
  status: "open" | "assigned" | "complete" | "canceled";
  claimed_by: string | null;
  notes?: string | null;
  requirements?: string[] | null;
  job_contacts?: JobContact[]; // one-to-one (array from Supabase relation)
};

type Profile = {
  id: string;
  full_name: string | null;
  role: "admin" | "guide";
};

// ---------- App ----------
export default function App() {
  const [session, setSession] = useState<any>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  const [openJobs, setOpenJobs] = useState<Job[]>([]);
  const [myJobs, setMyJobs] = useState<Job[]>([]);
  const [allJobs, setAllJobs] = useState<Job[]>([]); // admin view
  const [includeCanceled, setIncludeCanceled] = useState<boolean>(false); // admin toggle

  const [claimerMap, setClaimerMap] = useState<Record<string, string>>({}); // userId -> name

  const [msg, setMsg] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"open" | "my" | "all" | "create">("open");

  // Edit modal state
  const [editing, setEditing] = useState<Job | null>(null);
  const [eTitle, setETitle] = useState("");
  const [eDate, setEDate] = useState("");
  const [eCall, setECall] = useState("");
  const [eLocation, setELocation] = useState("");
  const [ePay, setEPay] = useState<string>("");
  const [eReqs, setEReqs] = useState("");
  const [eNotes, setENotes] = useState("");
  const [eStatus, setEStatus] = useState<Job["status"]>("open");
  const [eCustName, setECustName] = useState("");
  const [eCustPhone, setECustPhone] = useState("");
  const [eCustEmail, setECustEmail] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Details modal
  const [viewing, setViewing] = useState<Job | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewClaimer, setViewClaimer] = useState<string | null>(null);

  // Admin assignment helpers
  const [guides, setGuides] = useState<Profile[]>([]);
  const [assignTo, setAssignTo] = useState<string>("");
  const [assigning, setAssigning] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [claimingId, setClaimingId] = useState<string | null>(null);

  // --- Auth state ---
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // --- Load data on login + subscribe to changes ---
  useEffect(() => {
    if (!session) {
      setProfile(null);
      setOpenJobs([]);
      setMyJobs([]);
      setAllJobs([]);
      setClaimerMap({});
      setGuides([]);
      return;
    }
    (async () => {
      await loadProfile();
      await Promise.all([loadOpenJobs(), loadMyJobs(), loadAllJobs(includeCanceled)]);
      if ((await isAdminNow())) await loadGuides();
    })();

    const ch = supabase
      .channel("jobs-realtime-combined")
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs" }, async () => {
        await Promise.all([loadOpenJobs(), loadMyJobs(), loadAllJobs(includeCanceled)]);
        if (viewing) await openDetails(viewing);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Reload All Jobs when toggle changes
  useEffect(() => {
    if (session && profile?.role === "admin") loadAllJobs(includeCanceled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeCanceled]);

  async function isAdminNow() {
    const userId = (await supabase.auth.getUser()).data.user?.id;
    if (!userId) return false;
    const { data } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
    return data?.role === "admin";
  }

  async function loadGuides() {
    const { data } = await supabase
      .from("profiles")
      .select("id, full_name, role")
      .eq("role", "guide")
      .order("full_name", { nullsFirst: true, ascending: true });
    setGuides((data as Profile[]) || []);
  }

  async function loadProfile() {
    const userId = (await supabase.auth.getUser()).data.user?.id;
    if (!userId) return;
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name, role")
      .eq("id", userId)
      .maybeSingle();
    if (!error && data) setProfile(data as Profile);
  }

  // Only show jobs that are truly claimable: status=open AND claimed_by is null
  async function loadOpenJobs() {
    const { data, error } = await supabase
      .from("jobs")
      .select("id,title,date,call_time,location,pay,status,claimed_by")
      .eq("status", "open")
      .is("claimed_by", null)
      .order("date");
    if (!error) setOpenJobs((data as Job[]) || []);
  }

  async function loadMyJobs() {
    const user = (await supabase.auth.getUser()).data.user;
    if (!user) return;
    const { data, error } = await supabase
      .from("jobs")
      .select("id,title,date,call_time,location,pay,status,claimed_by,notes,requirements, job_contacts(customer_name,customer_phone,customer_email)")
      .eq("claimed_by", user.id)
      .order("date");
    if (!error) setMyJobs((data as Job[]) || []);
  }

  // Admin view: show open + assigned (and optionally canceled) and who claimed them
  async function loadAllJobs(includeCanceledFlag: boolean) {
    const statuses = includeCanceledFlag ? ["open", "assigned", "canceled"] : ["open", "assigned"];
    const { data, error } = await supabase
      .from("jobs")
      .select("id,title,date,call_time,location,pay,status,claimed_by,notes,requirements, job_contacts(customer_name,customer_phone,customer_email)")
      .in("status", statuses)
      .order("date");
    if (error) return;
    const rows = (data as Job[]) || [];
    setAllJobs(rows);

    // build claimer map
    const ids = Array.from(new Set(rows.map(r => r.claimed_by).filter((v): v is string => !!v)));
    if (ids.length) {
      const { data: profs, error: perr } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", ids);
      if (!perr && profs) {
        const next: Record<string, string> = {};
        for (const p of profs as any[]) next[p.id] = p.full_name || "(no name)";
        setClaimerMap(next);
      }
    } else {
      setClaimerMap({});
    }
  }

  async function signIn(email: string) {
    await supabase.auth.signInWithOtp({ email });
    alert("Magic link sent. Check your email to finish signing in.");
  }

  async function signOut() {
    await supabase.auth.signOut();
    setProfile(null);
    setOpenJobs([]);
    setMyJobs([]);
    setAllJobs([]);
    setClaimerMap({});
    setGuides([]);
  }

  // ---- Actions (call DB RPCs) ----
  async function claim(jobId: string) {
    setMsg("");
    setClaimingId(jobId);
    try {
      const { data, error } = await supabase.rpc("claim_job_v2", { p_job_id: jobId });
      if (!error && data === true) {
        setMsg("✅ Claimed!");
      } else {
        // Check row state for a helpful message
        const { data: row } = await supabase
          .from("jobs")
          .select("status, claimed_by")
          .eq("id", jobId)
          .maybeSingle();
        const c = row?.claimed_by ? (row.claimed_by as string) : null;
        if (!error && data !== true) {
          setMsg(`⚠️ Couldn't claim. Status=${row?.status ?? "?"}, claimed_by=${c ? c.slice(0,8) : "null"}`);
        } else if (error) {
          setMsg(`❌ ${error.message}`);
        }
        // Admin fallback: assign to self if truly open
        const user = (await supabase.auth.getUser()).data.user;
        if (user && (await isAdminNow()) && row?.status === "open" && !row?.claimed_by) {
          const { data: aData, error: aErr } = await supabase.rpc("assign_job", { p_job_id: jobId, p_guide_id: user.id });
          if (!aErr && aData === true) {
            // override any prior message
            setMsg("✅ Claimed!");
            setMsg("✅ Claimed (via admin assign).");
          }
        }
      }
    } finally {
      await Promise.all([loadOpenJobs(), loadMyJobs(), loadAllJobs(includeCanceled)]);
      if (viewing) await openDetails(viewing);
      setClaimingId(null);
    }
  }

  async function unclaim(jobId: string) {
    setMsg("");
    const { data, error } = await supabase.rpc("unclaim_job", { p_job_id: jobId });
    if (error) {
      setMsg("❌ Error unclaiming the job.");
      return;
    }
    if (data === true) {
      setMsg("↩️ Returned to pool.");
      await Promise.all([loadOpenJobs(), loadMyJobs(), loadAllJobs(includeCanceled)]);
    } else {
      setMsg("⚠️ You don't have permission to unclaim this job.");
    }
  }

  async function assign(jobId: string, guideId: string) {
    try {
      setAssigning(true);
      const { data, error } = await supabase.rpc("assign_job", { p_job_id: jobId, p_guide_id: guideId });
      if (error) throw error;
      if (data !== true) throw new Error("Assignment failed.");
      setMsg("✅ Assigned to guide.");
      await Promise.all([loadOpenJobs(), loadMyJobs(), loadAllJobs(includeCanceled)]);
      if (viewing) await openDetails(viewing);
    } catch (e: any) {
      alert(e?.message || "Failed to assign guide.");
    } finally {
      setAssigning(false);
    }
  }

  async function markComplete(jobId: string) {
    try {
      setCompleting(true);
      const { data, error } = await supabase.rpc("complete_job", { p_job_id: jobId });
      if (error) throw error;
      if (data !== true) throw new Error("Could not mark complete.");
      setMsg("🎉 Marked complete.");
      await Promise.all([loadOpenJobs(), loadMyJobs(), loadAllJobs(includeCanceled)]);
      if (viewing) await openDetails(viewing);
    } catch (e: any) {
      alert(e?.message || "Failed to mark complete.");
    } finally {
      setCompleting(false);
    }
  }

  async function cancelJob(jobId: string) {
    try {
      const { data, error } = await supabase.rpc("cancel_job", { p_job_id: jobId });
      if (error) throw error;
      if (data !== true) throw new Error("Could not cancel.");
      setMsg("🚫 Job canceled.");
      await Promise.all([loadOpenJobs(), loadMyJobs(), loadAllJobs(includeCanceled)]);
      if (viewing) await openDetails(viewing);
    } catch (e: any) {
      alert(e?.message || "Failed to cancel job.");
    }
  }

  // ---- Edit helpers ----
  function openEdit(job: Job) {
    setEditing(job);
    setETitle(job.title || "");
    setEDate(job.date || "");
    setECall(job.call_time || "");
    setELocation(job.location || "");
    setEPay(job.pay != null ? String(job.pay) : "");
    setEReqs((job.requirements || []).join(", "));
    setENotes(job.notes || "");
    setEStatus(job.status);
    const c = job.job_contacts?.[0];
    setECustName(c?.customer_name || "");
    setECustPhone(c?.customer_phone || "");
    setECustEmail(c?.customer_email || "");
  }

  async function saveEdit() {
    if (!editing) return;
    try {
      setSavingEdit(true);
      // Update job
      const reqArray = eReqs.split(",").map(s => s.trim()).filter(Boolean);
      const upd: any = {
        title: eTitle,
        date: eDate,
        call_time: eCall,
        location: eLocation || null,
        pay: ePay ? Number(ePay) : null,
        requirements: reqArray.length ? reqArray : null,
        notes: eNotes || null,
        status: eStatus,
      };
      const { error: jErr } = await supabase.from("jobs").update(upd).eq("id", editing.id);
      if (jErr) throw jErr;

      // Upsert contact for admins
      const { error: cErr } = await supabase.from("job_contacts").upsert({
        job_id: editing.id,
        customer_name: eCustName || null,
        customer_phone: eCustPhone || null,
        customer_email: eCustEmail || null,
      }, { onConflict: "job_id" });
      if (cErr) throw cErr;

      setMsg("✅ Job updated.");
      setEditing(null);
      await Promise.all([loadOpenJobs(), loadMyJobs(), loadAllJobs(includeCanceled)]);
    } catch (e: any) {
      alert(e?.message || "Failed to update job.");
    } finally {
      setSavingEdit(false);
    }
  }

  // ---- Details helpers ----
  async function openDetails(job: Job) {
    try {
      setViewLoading(true);
      setViewing(job);
      setViewClaimer(null);

      const { data: row, error } = await supabase
        .from("jobs")
        .select(`
          id,title,date,call_time,location,pay,status,claimed_by,notes,requirements,
          job_contacts (customer_name,customer_phone,customer_email)
        `)
        .eq("id", job.id)
        .maybeSingle();
      if (!error && row) {
        const r = row as Job;
        setViewing(r);
        setAssignTo(r.claimed_by || "");
        if (r.claimed_by) {
          const { data: prof } = await supabase
            .from("profiles")
            .select("full_name")
            .eq("id", r.claimed_by)
            .maybeSingle();
          setViewClaimer(prof?.full_name || null);
        }
      }
      if (profile?.role === "admin" && guides.length === 0) await loadGuides();
    } finally {
      setViewLoading(false);
    }
  }

  if (!session) return <Auth onSignIn={signIn} />;

  const email = session?.user?.email as string | undefined;
  const isAdmin = profile?.role === "admin";
  const myId = session?.user?.id as string | undefined;

  return (
    <main style={styles.wrap}>
      <header style={styles.header}>
        <div>
          <div style={styles.h1}>Dive Guide — Jobs</div>
          <div style={styles.subtle}>
            {email ? `Signed in as ${email}` : ""} {isAdmin ? "· Admin" : "· Guide"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={signOut} style={styles.ghostBtn}>Sign out</button>
        </div>
      </header>

      {/* Tabs */}
      <div style={styles.tabs}>
        <button
          style={{ ...styles.tabBtn, ...(activeTab === "open" ? styles.tabActive : {}) }}
          onClick={() => setActiveTab("open")}
        >
          Open Jobs
        </button>
        <button
          style={{ ...styles.tabBtn, ...(activeTab === "my" ? styles.tabActive : {}) }}
          onClick={() => setActiveTab("my")}
        >
          My Jobs
        </button>
        {isAdmin && (
          <button
            style={{ ...styles.tabBtn, ...(activeTab === "all" ? styles.tabActive : {}) }}
            onClick={() => setActiveTab("all")}
          >
            All Jobs (admin)
          </button>
        )}
        {isAdmin && (
          <button
            style={{ ...styles.tabBtn, ...(activeTab === "create" ? styles.tabActive : {}) }}
            onClick={() => setActiveTab("create")}
          >
            Create Job
          </button>
        )}
      </div>

      {/* Messages */}
      {msg && <div style={{ marginBottom: 12 }}>{msg}</div>}

      {/* Content */}
      {activeTab === "open" && (
        <JobList jobs={openJobs} claimingId={claimingId} onClaim={claim} onUnclaim={unclaim} onView={openDetails} showClaimButton showClaimer={false} claimerMap={{}} showStatus={false} isAdmin={isAdmin} myId={myId} onEdit={() => {}} />
      )}

      {activeTab === "my" && (
        <JobList jobs={myJobs} claimingId={claimingId} onClaim={() => {}} onUnclaim={unclaim} onView={openDetails} showClaimButton={false} showClaimer={false} claimerMap={{}} showStatus isAdmin={isAdmin} myId={myId} onEdit={() => {}} />
      )}

      {activeTab === "all" && isAdmin && (
        <>
          <div style={{ margin: "6px 0 10px 2px", display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={includeCanceled} onChange={(e) => setIncludeCanceled(e.target.checked)} />
              Include canceled
            </label>
          </div>
          <JobList
            jobs={allJobs} claimingId={claimingId}
            onClaim={(id) => claim(id)}
            onUnclaim={unclaim}
            onView={openDetails}
            showClaimButton
            showClaimer
            claimerMap={claimerMap}
            showStatus
            isAdmin
            myId={myId}
            onEdit={(job) => openEdit(job)}
          />
        </>
      )}

      {activeTab === "create" && (
        isAdmin ? (
          <CreateJob onCreated={async () => {
            setActiveTab("all");
            await Promise.all([loadOpenJobs(), loadMyJobs(), loadAllJobs(includeCanceled)]);
            setMsg("✅ Job created.");
          }} />
        ) : (
          <div style={{ marginTop: 16 }}>You need admin access to create jobs.</div>
        )
      )}

      {/* Edit Modal */}
      {editing && (
        <div style={styles.modalOverlay} onClick={() => !savingEdit && setEditing(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontWeight: 700 }}>Edit Job</div>
              <button style={styles.ghostBtn} onClick={() => setEditing(null)} disabled={savingEdit}>Close</button>
            </div>
            <EditForm
              title={eTitle} setTitle={setETitle}
              date={eDate} setDate={setEDate}
              call={eCall} setCall={setECall}
              location={eLocation} setLocation={setELocation}
              pay={ePay} setPay={setEPay}
              reqs={eReqs} setReqs={setEReqs}
              notes={eNotes} setNotes={setENotes}
              status={eStatus} setStatus={setEStatus}
              custName={eCustName} setCustName={setECustName}
              custPhone={eCustPhone} setCustPhone={setECustPhone}
              custEmail={eCustEmail} setCustEmail={setECustEmail}
            />
            <div style={{ position: "sticky", bottom: 0, background: "#fff", paddingTop: 8 }}>
              <button style={{ ...styles.primaryBtn, width: "100%" }} disabled={savingEdit} onClick={saveEdit}>
                {savingEdit ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Details Modal */}
      {viewing && (
        <div style={styles.modalOverlay} onClick={() => !viewLoading && setViewing(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontWeight: 700 }}>Job Details</div>
              <button style={styles.ghostBtn} onClick={() => setViewing(null)} disabled={viewLoading}>Close</button>
            </div>

            {viewLoading ? (
              <div>Loading…</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                <div><strong>{viewing.title}</strong></div>
                <div style={styles.subtle}>
                  {viewing.date} · call {viewing.call_time} · {viewing.location || "—"} · {viewing.pay ? `$${viewing.pay}` : ""}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <StatusBadge status={viewing.status} />
                  {viewing.claimed_by && (
                    <div><strong>Claimed by:</strong> {viewClaimer || viewing.claimed_by.slice(0,8)}</div>
                  )}
                </div>

                {viewing.requirements?.length ? (
                  <div><strong>Requirements:</strong> {viewing.requirements.join(", ")}</div>
                ) : null}

                {viewing.notes ? (
                  <div><strong>Description:</strong> {viewing.notes}</div>
                ) : null}

                {/* Contact info is visible to admin or assigned guide via RLS */}
                {viewing.job_contacts?.[0] && (
                  <div style={{ borderTop: "1px solid #eee", paddingTop: 8 }}>
                    <div style={{ fontWeight: 600 }}>Customer Contact</div>
                    <div>Name: {viewing.job_contacts[0].customer_name || "—"}</div>
                    <div>Phone: {viewing.job_contacts[0].customer_phone || "—"}</div>
                    <div>Email: {viewing.job_contacts[0].customer_email || "—"}</div>
                  </div>
                )}

                <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
                  {viewing.status === "open" && !viewing.claimed_by && (
                    <button style={styles.primaryBtn} onClick={() => claim(viewing.id)}>Claim</button>
                  )}
                  {viewing.status === "assigned" && (isAdmin || viewing.claimed_by === myId) && (
                    <button style={styles.ghostBtn} onClick={() => unclaim(viewing.id)}>Unclaim</button>
                  )}
                  {isAdmin && (
                    <button style={styles.ghostBtn} onClick={() => { setViewing(null); openEdit(viewing); }}>Edit</button>
                  )}
                  {(isAdmin || viewing.claimed_by === myId) && viewing.status === "assigned" && (
                    <button style={styles.primaryBtn} disabled={completing} onClick={() => markComplete(viewing.id)}>
                      {completing ? "Marking…" : "Mark complete"}
                    </button>
                  )}
                  {isAdmin && viewing.status !== "canceled" && viewing.status !== "complete" && (
                    <button style={styles.dangerBtn} onClick={() => cancelJob(viewing.id)}>
                      Cancel job
                    </button>
                  )}
                </div>

                {/* Admin: Assign to guide */}
                {isAdmin && (
                  <div style={{ borderTop: "1px solid #eee", paddingTop: 8 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Assign to guide</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <select
                        style={styles.input}
                        value={assignTo}
                        onChange={(e) => setAssignTo(e.target.value)}
                      >
                        <option value="">— Select guide —</option>
                        {guides.map(g => (
                          <option key={g.id} value={g.id}>{g.full_name || g.id.slice(0,8)}</option>
                        ))}
                      </select>
                      <button
                        style={styles.primaryBtn}
                        disabled={!assignTo || assigning}
                        onClick={() => assign(viewing.id, assignTo)}
                      >
                        {assigning ? "Assigning…" : "Assign"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

// ---------- Reusable small form for editing ----------
function EditForm(props: {
  title: string; setTitle: (v: string) => void;
  date: string; setDate: (v: string) => void;
  call: string; setCall: (v: string) => void;
  location: string; setLocation: (v: string) => void;
  pay: string; setPay: (v: string) => void;
  reqs: string; setReqs: (v: string) => void;
  notes: string; setNotes: (v: string) => void;
  status: Job["status"]; setStatus: (v: Job["status"]) => void;
  custName: string; setCustName: (v: string) => void;
  custPhone: string; setCustPhone: (v: string) => void;
  custEmail: string; setCustEmail: (v: string) => void;
}) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label style={styles.label}>Title
        <input style={styles.input} value={props.title} onChange={(e) => props.setTitle(e.target.value)} />
      </label>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <label style={styles.label}>Date
          <input type="date" style={styles.input} value={props.date} onChange={(e) => props.setDate(e.target.value)} />
        </label>
        <label style={styles.label}>Call time
          <input type="time" style={styles.input} value={props.call} onChange={(e) => props.setCall(e.target.value)} />
        </label>
      </div>

      <label style={styles.label}>Location
        <input style={styles.input} value={props.location} onChange={(e) => props.setLocation(e.target.value)} />
      </label>

      <label style={styles.label}>Pay (USD)
        <input type="number" style={styles.input} value={props.pay} onChange={(e) => props.setPay(e.target.value)} />
      </label>

      <label style={styles.label}>Requirements (comma-separated)
        <input style={styles.input} value={props.reqs} onChange={(e) => props.setReqs(e.target.value)} />
      </label>

      <label style={styles.label}>Notes
        <textarea style={{ ...styles.input, minHeight: 70 }} value={props.notes} onChange={(e) => props.setNotes(e.target.value)} />
      </label>

      <label style={styles.label}>Status
        <select style={styles.input} value={props.status} onChange={(e) => props.setStatus(e.target.value as any)}>
          <option value="open">open</option>
          <option value="assigned">assigned</option>
          <option value="complete">complete</option>
          <option value="canceled">canceled</option>
        </select>
      </label>

      <div style={{ borderTop: "1px solid #eee", paddingTop: 8, fontWeight: 600 }}>Customer Contact</div>
      <label style={styles.label}>Name
        <input style={styles.input} value={props.custName} onChange={(e) => props.setCustName(e.target.value)} />
      </label>
      <label style={styles.label}>Phone
        <input style={styles.input} value={props.custPhone} onChange={(e) => props.setCustPhone(e.target.value)} />
      </label>
      <label style={styles.label}>Email
        <input type="email" style={styles.input} value={props.custEmail} onChange={(e) => props.setCustEmail(e.target.value)} />
      </label>
    </div>
  );
}

// ---------- Job List ----------
function JobList({ jobs,
  onClaim,
  onUnclaim,
  onView,
  showClaimButton,
  showClaimer,
  claimerMap,
  showStatus,
  isAdmin,
  myId,
  onEdit, claimingId,
}: {
  claimingId?: string | null;
  jobs: Job[];
  onClaim: (id: string) => void;
  onUnclaim: (id: string) => void;
  onView: (job: Job) => void;
  showClaimButton: boolean;
  showClaimer: boolean;
  claimerMap: Record<string, string>;
  showStatus: boolean;
  isAdmin?: boolean;
  myId?: string;
  onEdit: (job: Job) => void;
}) {
  if (!jobs.length) return <div style={styles.card}>No jobs here yet.</div>;

  return (
    <ul style={{ display: "grid", gap: 12 }}>
      {jobs.map((j) => {
        const claimerName = j.claimed_by ? (claimerMap[j.claimed_by] || j.claimed_by.slice(0, 8)) : null;
        const contact = j.job_contacts?.[0];
        const iAmClaimer = myId && j.claimed_by === myId;
        return (
          <li key={j.id} style={styles.card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontWeight: 600 }}>{j.title}</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {showStatus && <StatusBadge status={j.status} />}
                <button style={styles.ghostBtn} onClick={() => onView(j)}>Details</button>
                {isAdmin && <button style={styles.ghostBtn} onClick={() => onEdit(j)}>Edit</button>}
              </div>
            </div>
            <div style={styles.subtle}>
              {j.date} · call {j.call_time} · {j.location || "—"} · {j.pay ? `$${j.pay}` : ""}
            </div>
            {showClaimer && j.claimed_by && (
              <div style={{ marginTop: 6, fontSize: 14 }}>
                <strong>Claimed by:</strong> {claimerName}
              </div>
            )}
            {/* Contact block when loaded (admin or assigned guide) */}
            {contact && (
              <div style={{ marginTop: 6, fontSize: 14 }}>
                <div><strong>Customer:</strong> {contact.customer_name || "—"}</div>
                <div><strong>Phone:</strong> {contact.customer_phone || "—"}</div>
                <div><strong>Email:</strong> {contact.customer_email || "—"}</div>
              </div>
            )}
            {showClaimButton && j.status === "open" && !j.claimed_by && (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button style={styles.primaryBtn} disabled={claimingId===j.id} onClick={() => onClaim(j.id)}>{claimingId===j.id ? "Claiming…" : "Claim"}</button>
              </div>
            )}
            {j.status === "assigned" && (iAmClaimer || isAdmin) && (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button style={styles.ghostBtn} onClick={() => onUnclaim(j.id)}>Unclaim</button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function StatusBadge({ status }: {
  claimingId?: string | null; status: Job["status"] }) {
  const bg = status === "open" ? "#eefcf5"
    : status === "assigned" ? "#eef2ff"
    : status === "complete" ? "#f0fdf4"
    : "#fff7ed";
  const border = status === "open" ? "#0a7"
    : status === "assigned" ? "#6366f1"
    : status === "complete" ? "#16a34a"
    : "#ea580c";
  return (
    <span style={{ padding: "2px 8px", borderRadius: 999, border: `1px solid ${border}`, background: bg, fontSize: 12 }}>
      {status}
    </span>
  );
}

// ---------- Create Job (Admin) ----------
function CreateJob({ onCreated }: {
  claimingId?: string | null; onCreated: () => Promise<void> }) {
  const [title, setTitle] = useState("Santa Cruz Guide");
  const [date, setDate] = useState<string>(() => {
    const d = new Date(Date.now() + 24 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  });
  const [callTime, setCallTime] = useState("06:30");
  const [location, setLocation] = useState("Santa Cruz Island");
  const [pay, setPay] = useState<string>("250");
  const [requirements, setRequirements] = useState("DM");
  const [notes, setNotes] = useState("");

  // Customer contact fields
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>("");

  const reqArray = useMemo(
    () => requirements.split(",").map((r) => r.trim()).filter(Boolean),
    [requirements]
  );

  async function submit() {
    try {
      setSaving(true);
      setError("");

      const user = (await supabase.auth.getUser()).data.user;
      if (!user) throw new Error("Not signed in");

      // 1) Create the job
      const jobPayload: any = {
        title,
        date,
        call_time: callTime,
        location,
        pay: pay ? Number(pay) : null,
        requirements: reqArray.length ? reqArray : null,
        notes: notes || null,
        created_by: user.id,
        status: "open",
      };

      const { data: jobRow, error: jobErr } = await supabase
        .from("jobs")
        .insert(jobPayload)
        .select("id")
        .single();

      if (jobErr) {
        if (String(jobErr.message).toLowerCase().includes("violates row-level security")) {
          throw new Error("You need admin access to create jobs.");
        }
        throw jobErr;
      }

      // 2) Attach customer contact
      const { error: contactErr } = await supabase.from("job_contacts").insert({
        job_id: jobRow.id,
        customer_name: customerName || null,
        customer_phone: customerPhone || null,
        customer_email: customerEmail || null,
      });
      if (contactErr) {
        await supabase.from("jobs").delete().eq("id", jobRow.id);
        throw new Error("Failed to save contact info. Please try again.");
      }

      // Reset
      setTitle("Santa Cruz Guide");
      setDate(new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10));
      setCallTime("06:30");
      setLocation("Santa Cruz Island");
      setPay("250");
      setRequirements("DM");
      setNotes("");
      setCustomerName("");
      setCustomerPhone("");
      setCustomerEmail("");

      await onCreated();
    } catch (e: any) {
      setError(e?.message || "Failed to create job.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10, maxWidth: 560 }}>
      {error && <div style={{ color: "#c00" }}>{error}</div>}

      <label style={styles.label}>Title
        <input style={styles.input} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <label style={styles.label}>Date
          <input type="date" style={styles.input} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label style={styles.label}>Call time
          <input type="time" style={styles.input} value={callTime} onChange={(e) => setCallTime(e.target.value)} />
        </label>
      </div>

      <label style={styles.label}>Location
        <input style={styles.input} value={location} onChange={(e) => setLocation(e.target.value)} />
      </label>

      <label style={styles.label}>Pay (USD)
        <input type="number" style={styles.input} value={pay} onChange={(e) => setPay(e.target.value)} />
      </label>

      <label style={styles.label}>Requirements (comma-separated)
        <input style={styles.input} value={requirements} onChange={(e) => setRequirements(e.target.value)} />
      </label>

      <label style={styles.label}>Notes (optional)
        <textarea style={{ ...styles.input, minHeight: 80 }} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      <div style={{ borderTop: "1px solid #eee", marginTop: 8, paddingTop: 8, fontWeight: 600 }}>
        Customer Contact (stored securely; visible to admin & assigned guide)
      </div>
      <label style={styles.label}>Customer name
        <input style={styles.input} value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
      </label>
      <label style={styles.label}>Customer phone
        <input style={styles.input} value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
      </label>
      <label style={styles.label}>Customer email
        <input type="email" style={styles.input} value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} />
      </label>

      <button style={styles.primaryBtn} disabled={saving} onClick={submit}>
        {saving ? "Saving…" : "Create Job"}
      </button>
    </div>
  );
}

// ---------- Auth ----------
function Auth({ onSignIn }: {
  claimingId?: string | null; onSignIn: (email: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  return (
    <div style={{ padding: 24, maxWidth: 360, margin: "40px auto", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Sign in</h1>
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        style={{ border: "1px solid #ccc", borderRadius: 8, padding: 10, width: "100%", marginBottom: 8 }}
      />
      <button onClick={() => onSignIn(email)} style={styles.primaryBtnFull}>
        Send magic link
      </button>
    </div>
  );
}

// ---------- Styles ----------
const styles: Record<string, any> = {
  wrap: { padding: 16, maxWidth: 860, margin: "0 auto", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
  h1: { fontSize: 24, fontWeight: 700 },
  subtle: { opacity: 0.8, fontSize: 14 },
  tabs: { display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" },
  tabBtn: { padding: "8px 12px", border: "1px solid #ddd", borderRadius: 10, background: "#fff", cursor: "pointer" },
  tabActive: { background: "#f4f4f5", borderColor: "#bbb", fontWeight: 600 },
  card: { border: "1px solid #ddd", borderRadius: 12, padding: 12, background: "#fff" },
  ghostBtn: { padding: "8px 10px", border: "1px solid #ddd", borderRadius: 10, background: "#fff", cursor: "pointer" },
  primaryBtn: { padding: "8px 12px", border: "1px solid #0a7", borderRadius: 10, background: "#eafff6", cursor: "pointer" },
  primaryBtnFull: { padding: "10px 12px", border: "1px solid #0a7", borderRadius: 10, background: "#eafff6", cursor: "pointer", width: "100%" },
  label: { display: "grid", gap: 6, fontSize: 14 },
  input: { border: "1px solid #ccc", borderRadius: 8, padding: 10, width: "100%" },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "grid", placeItems: "center", padding: 16, zIndex: 50, overflowY: "auto" },
  modal: { width: "min(680px, 95vw)", background: "#fff", borderRadius: 12, padding: 14, boxShadow: "0 10px 30px rgba(0,0,0,0.2)", maxHeight: "90vh", overflowY: "auto", overscrollBehavior: "contain", WebkitOverflowScrolling: "touch" },
  dangerBtn: { padding: "8px 12px", border: "1px solid #b91c1c", borderRadius: 10, background: "#fee2e2", cursor: "pointer" },
};

