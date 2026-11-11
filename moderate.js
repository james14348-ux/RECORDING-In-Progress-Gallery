(() => {
  const C = window.GALLERY_CONFIG;
  const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey);
  const $ = (id) => document.getElementById(id);
  let tab = "pending";

  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  $("viewer").addEventListener("click", (e) => { if (e.target === $("viewer")) $("viewer").close(); });

  async function start() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { $("login").hidden = false; $("panel").hidden = true; $("logout").hidden = true; return; }
    const { data: admin } = await sb.rpc("is_admin");
    if (!admin) {
      $("login").hidden = false;
      $("login-msg").textContent = "This account isn't a moderator.";
      $("login-msg").className = "msg err";
      await sb.auth.signOut();
      return;
    }
    $("login").hidden = true; $("panel").hidden = false; $("logout").hidden = false;
    load();
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("login-msg").textContent = "Signing in…"; $("login-msg").className = "msg";
    const { error } = await sb.auth.signInWithPassword({ email: $("email").value, password: $("password").value });
    if (error) { $("login-msg").textContent = "Wrong email or password."; $("login-msg").className = "msg err"; return; }
    $("password").value = "";
    start();
  });

  $("logout").addEventListener("click", async (e) => { e.preventDefault(); await sb.auth.signOut(); start(); });

  document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
    tab = b.dataset.tab;
    document.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    load();
  }));

  let stats = {}; // uploader tag -> { uploads, banned }

  async function load() {
    $("list").replaceChildren();
    $("status").textContent = "Loading…"; $("status").hidden = false;
    if (tab === "bans") return loadBans();
    let q = sb.from("photos").select("*").eq("status", tab);
    if (tab === "pending") q = q.order("created_at", { ascending: true });
    else q = q.order("pinned_at", { ascending: false, nullsFirst: false }).order("approved_at", { ascending: false });
    const { data, error } = await q.limit(200);
    if (error) { $("status").textContent = "Couldn't load: " + error.message; return; }
    $("count").textContent = `${data.length} photo${data.length === 1 ? "" : "s"}${data.length === 200 ? " (first 200)" : ""}`;
    if (!data.length) { $("status").textContent = tab === "pending" ? "Nothing waiting. All caught up." : "No approved photos yet."; return; }
    const { data: signed } = await sb.storage.from(C.bucket).createSignedUrls(data.map((p) => p.path), 3600);
    const urls = Object.fromEntries((signed || []).map((s) => [s.path, s.signedUrl]));
    const tags = [...new Set(data.map((p) => p.uploader).filter(Boolean))];
    stats = {};
    if (tags.length) {
      const { data: rows } = await sb.rpc("uploader_stats", { tags });
      (rows || []).forEach((r) => { stats[r.uploader] = r; });
    }
    data.forEach((p) => $("list").append(card(p, urls[p.path])));
    $("status").hidden = true;
  }

  async function loadBans() {
    const { data, error } = await sb.from("bans").select("*").order("banned_at", { ascending: false });
    if (error) { $("status").textContent = "Couldn't load: " + error.message; return; }
    $("count").textContent = `${data.length} banned`;
    if (!data.length) { $("status").textContent = "Nobody is banned."; return; }
    data.forEach((b) => {
      const el = document.createElement("article"); el.className = "card";
      const body = document.createElement("div"); body.className = "body";
      const who = document.createElement("div"); who.className = "msg";
      who.textContent = `Uploader ${b.uploader.slice(0, 4)} · banned ${new Date(b.banned_at).toLocaleString()}`;
      const note = document.createElement("div"); note.textContent = b.note || "(no note)";
      if (!b.note) note.style.color = "var(--muted)";
      const row = document.createElement("div"); row.className = "row";
      row.append(button("Unban", "", async () => {
        const { error: e } = await sb.from("bans").delete().eq("uploader", b.uploader);
        if (e) { alert("Couldn't unban: " + e.message); return; }
        el.remove();
      }));
      body.append(who, note, row); el.append(body);
      $("list").append(el);
    });
    $("status").hidden = true;
  }

  // Ban an uploader, optionally deleting every photo of theirs that's still waiting.
  async function ban(tag) {
    const note = prompt("Ban this uploader? They won't be able to upload or like any more.\n\nOptional note (why):", "");
    if (note === null) return;
    const { error } = await sb.from("bans").insert({ uploader: tag, note: note.slice(0, 200) });
    if (error && error.code !== "23505") { alert("Couldn't ban: " + error.message); return; }
    const { data: waiting } = await sb.from("photos").select("id,path").eq("uploader", tag).eq("status", "pending");
    if (waiting && waiting.length && confirm(`Also delete their ${waiting.length} waiting photo${waiting.length === 1 ? "" : "s"}?`)) {
      await sb.storage.from(C.bucket).remove(waiting.map((p) => p.path));
      await sb.from("photos").delete().in("id", waiting.map((p) => p.id));
    }
    load();
  }

  function button(label, cls, fn) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn " + cls; b.textContent = label;
    b.addEventListener("click", async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } });
    return b;
  }

  function card(p, url) {
    const el = document.createElement("article"); el.className = "card";
    const img = document.createElement("img"); img.alt = p.caption || "Uploaded photo"; img.loading = "lazy";
    if (url) { img.src = url; img.addEventListener("click", () => { $("viewer-img").src = url; $("viewer").showModal(); }); }
    const body = document.createElement("div"); body.className = "body";
    const by = document.createElement("div"); by.className = "msg";
    by.textContent = `${p.author} · ${new Date(p.created_at).toLocaleString()} · ${p.width}×${p.height}`
      + (p.status === "approved" ? ` · ♥ ${p.like_count ?? 0}` : "")
      + (p.pinned_at ? " · PINNED" : "");
    const who = document.createElement("div"); who.className = "msg";
    const st = p.uploader && stats[p.uploader];
    who.textContent = !p.uploader ? "Uploader unknown (sent before tagging)"
      : `Uploader ${p.uploader.slice(0, 4)} · ${st ? st.uploads : "?"} upload${st && st.uploads === 1 ? "" : "s"}`
        + (st && st.banned ? " · BANNED" : "");
    if (st && st.banned) who.classList.add("err");
    const cap = document.createElement("div"); cap.textContent = p.caption || "(no caption)";
    if (!p.caption) cap.style.color = "var(--muted)";
    const tags = document.createElement("div"); tags.className = "tagline";
    (p.tags || []).forEach((t) => { const s = document.createElement("span"); s.className = "tag"; s.textContent = t; tags.append(s); });
    const row = document.createElement("div"); row.className = "row";

    const setStatus = async (status) => {
      const { error } = await sb.from("photos").update({ status }).eq("id", p.id);
      if (error) { alert("Couldn't update: " + error.message); return; }
      el.remove();
    };
    const remove = async () => {
      if (!confirm("Delete this photo for good?")) return;
      const rm = await sb.storage.from(C.bucket).remove([p.path]);
      if (rm.error) { alert("Couldn't delete the file: " + rm.error.message); return; }
      const { error } = await sb.from("photos").delete().eq("id", p.id);
      if (error) { alert("Couldn't delete the entry: " + error.message); return; }
      el.remove();
    };

    if (p.status === "pending") row.append(button("Approve", "ok", () => setStatus("approved")));
    else {
      row.append(button(p.pinned_at ? "Unpin" : "Pin to top", "", async () => {
        const { error } = await sb.from("photos").update({ pinned_at: p.pinned_at ? null : new Date().toISOString() }).eq("id", p.id);
        if (error) { alert("Couldn't update: " + error.message); return; }
        load();
      }));
      row.append(button("Hide again", "", () => setStatus("pending")));
    }
    row.append(button("Delete", "danger", remove));
    if (p.uploader && !(st && st.banned)) row.append(button("Ban uploader", "danger", () => ban(p.uploader)));

    body.append(by, who, cap, tags, row);
    el.append(img, body);
    return el;
  }

  start();
})();
