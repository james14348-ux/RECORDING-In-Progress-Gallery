(() => {
  const C = window.GALLERY_CONFIG;
  const $ = (id) => document.getElementById(id);
  const PAGE = 24;
  const MAX_TAGS = 8;
  const ALL_TAGS = C.tagGroups.flatMap((g) => g.tags);

  // A random id for this browser, so each person can like a photo once.
  const voter = (() => {
    try {
      let v = localStorage.getItem("gallery-voter");
      if (!v) { v = crypto.randomUUID(); localStorage.setItem("gallery-voter", v); }
      return v;
    } catch (_) { return crypto.randomUUID(); }
  })();

  const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey, {
    auth: { persistSession: false },
    global: { headers: { "x-voter": voter } },
  });

  $("lnk-modrinth").href = C.modrinth;
  $("lnk-github").href = C.github;

  // ------------------------------------------------------------ gallery state
  let offset = 0, filter = null, sort = "new", loading = false, generation = 0;
  const photos = new Map(); // id -> { p, url, liked, buttons: [] }

  function chip(label, pressed, onClick) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = label;
    b.setAttribute("aria-pressed", String(pressed));
    b.addEventListener("click", () => onClick(b));
    return b;
  }

  const filterChips = $("chips");
  const filterChip = (t) => chip(t ?? "All", t === null, (b) => {
    filter = t;
    filterChips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
    reload();
  });
  filterChips.append(filterChip(null));
  C.tagGroups.forEach((g) => {
    const sep = document.createElement("span"); sep.className = "chip-sep"; sep.setAttribute("aria-hidden", "true");
    filterChips.append(sep, ...g.tags.map(filterChip));
  });

  document.querySelectorAll("#sort [data-sort]").forEach((b) => b.addEventListener("click", () => {
    if (sort === b.dataset.sort) return;
    sort = b.dataset.sort;
    document.querySelectorAll("#sort [data-sort]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    reload();
  }));

  function reload() {
    offset = 0;
    generation++;
    loading = false;
    photos.clear();
    $("grid").replaceChildren();
    load();
  }

  async function load() {
    if (loading) return;
    loading = true;
    const gen = generation;
    $("more").hidden = true;
    $("status").textContent = "Loading photos…";
    $("status").hidden = false;
    try {
      let q = sb.from("photos")
        .select("id,path,author,caption,tags,width,height,created_at,approved_at,like_count,pinned_at")
        .eq("status", "approved");
      if (filter) q = q.contains("tags", [filter]);
      // Pinned photos first (newest pin on top), in "All" and in every tag they have.
      q = q.order("pinned_at", { ascending: false, nullsFirst: false });
      if (sort === "liked") q = q.order("like_count", { ascending: false }).order("approved_at", { ascending: false });
      else q = q.order("approved_at", { ascending: sort === "old" });
      const { data, error } = await q.order("id").range(offset, offset + PAGE - 1);
      if (error) throw error;

      const urls = {}, mine = new Set();
      if (data.length) {
        const ids = data.map((p) => p.id);
        const [signed, liked] = await Promise.all([
          sb.storage.from(C.bucket).createSignedUrls(data.map((p) => p.path), 60 * 60 * 6),
          sb.from("likes").select("photo_id").in("photo_id", ids),
        ]);
        if (signed.error) throw signed.error;
        signed.data.forEach((s) => { if (s.signedUrl) urls[s.path] = s.signedUrl; });
        (liked.data || []).forEach((l) => mine.add(l.photo_id));
      }
      if (gen !== generation) return; // the sort or filter changed while loading

      data.forEach((p) => {
        if (!urls[p.path] || photos.has(p.id)) return;
        const entry = { p, url: urls[p.path], liked: mine.has(p.id), buttons: [] };
        photos.set(p.id, entry);
        $("grid").append(tile(entry));
      });
      offset += data.length;

      if (offset === 0) {
        $("status").textContent = filter ? `No "${filter}" photos yet.` : "No photos yet. Be the first!";
      } else {
        $("status").hidden = true;
      }
      $("more").hidden = data.length < PAGE;
    } catch (err) {
      console.error(err);
      if (gen === generation) $("status").textContent = "Couldn't load the photos. Try refreshing the page.";
    } finally {
      if (gen === generation) loading = false;
    }
  }

  // ------------------------------------------------------------ likes
  const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.8 4.5c2.2 0 3.6 1.2 5.2 3.1 1.6-1.9 3-3.1 5.2-3.1 3.8 0 5.9 3.9 4.4 7.3C19.5 16.4 12 21 12 21z"/></svg>';

  function likeButton(entry) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "like";
    b.innerHTML = HEART + "<span></span>";
    b.addEventListener("click", (e) => { e.stopPropagation(); toggleLike(entry, b); });
    b.addEventListener("keydown", (e) => e.stopPropagation());
    entry.buttons.push(b);
    paint(entry);
    return b;
  }

  function paint(entry) {
    entry.buttons.forEach((b) => {
      b.setAttribute("aria-pressed", String(entry.liked));
      b.setAttribute("aria-label", `${entry.liked ? "Unlike" : "Like"} (${entry.p.like_count} like${entry.p.like_count === 1 ? "" : "s"})`);
      b.querySelector("span").textContent = entry.p.like_count;
    });
  }

  async function toggleLike(entry, button) {
    if (entry.busy) return;
    entry.busy = true;
    const was = entry.liked;
    entry.liked = !was;
    entry.p.like_count = Math.max(0, entry.p.like_count + (was ? -1 : 1));
    paint(entry);
    if (!was) { button.classList.remove("pop"); void button.offsetWidth; button.classList.add("pop"); }
    try {
      const res = was
        ? await sb.from("likes").delete().eq("photo_id", entry.p.id).eq("voter", voter)
        : await sb.from("likes").insert({ photo_id: entry.p.id, voter });
      // 23505 = already liked from this browser (e.g. in another tab): keep it shown as liked.
      if (res.error && res.error.code !== "23505") throw res.error;
      if (res.error && res.error.code === "23505") entry.p.like_count--;
    } catch (err) {
      console.error(err);
      entry.liked = was;
      entry.p.like_count = Math.max(0, entry.p.like_count + (was ? 1 : -1));
    }
    entry.busy = false;
    paint(entry);
  }

  // ------------------------------------------------------------ tiles + viewer
  function tile(entry) {
    const { p, url } = entry;
    const fig = document.createElement("figure");
    fig.className = "shot"; fig.tabIndex = 0;
    fig.setAttribute("role", "button");
    fig.setAttribute("aria-label", `Photo by ${p.author}${p.caption ? ": " + p.caption : ""}`);
    const img = document.createElement("img");
    img.src = url; img.loading = "lazy"; img.alt = p.caption || `Photo by ${p.author}`;
    if (p.width && p.height) { img.width = p.width; img.height = p.height; }
    const frame = document.createElement("span"); frame.className = "frame";
    const meta = document.createElement("figcaption"); meta.className = "meta";
    meta.textContent = p.author + (p.caption ? " — " + p.caption : "");
    fig.append(img, frame, meta, likeButton(entry));
    if (p.pinned_at) {
      fig.classList.add("pinned");
      const badge = document.createElement("span"); badge.className = "pin-badge"; badge.innerHTML = PIN + "Pinned";
      fig.append(badge);
    }
    entry.tile = fig;
    const open = () => view(entry);
    fig.addEventListener("click", open);
    fig.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    return fig;
  }

  const PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3l6 6-3 1-4 4 1 5-2 2-4-4-5 5H3v-1l5-5-4-4 2-2 5 1 4-4z"/></svg>';

  let viewerButton = null;
  function view(entry) {
    modTools(entry);
    const { p, url } = entry;
    $("viewer-img").src = url;
    $("viewer-img").alt = p.caption || `Photo by ${p.author}`;
    $("viewer-title").textContent = new Date(p.approved_at || p.created_at).toLocaleDateString();
    $("viewer-caption").textContent = p.caption;
    $("viewer-caption").hidden = !p.caption;
    $("viewer-by").textContent = "by " + p.author;
    $("viewer-tags").replaceChildren(...(p.tags || []).map((t) => {
      const s = document.createElement("span"); s.className = "tag"; s.textContent = t; return s;
    }));
    if (viewerButton) viewerButton.owner.buttons = viewerButton.owner.buttons.filter((b) => b !== viewerButton.el);
    const el = likeButton(entry);
    viewerButton = { el, owner: entry };
    $("viewer-like").replaceChildren(el);
    $("viewer").showModal();
  }

  // ------------------------------------------------------------ moderator tools
  // If this browser is signed in on moderate.html, the photo viewer also gets Pin, Hide and Delete buttons.
  // The database rules decide what's allowed; these buttons just save a trip to the moderation page.
  let mod = null;
  (async () => {
    try {
      const key = `sb-${new URL(C.supabaseUrl).hostname.split(".")[0]}-auth-token`;
      if (!localStorage.getItem(key)) return;
      const client = window.supabase.createClient(C.supabaseUrl, C.supabaseKey);
      const { data: { session } } = await client.auth.getSession();
      if (!session) return;
      const { data: ok } = await client.rpc("is_admin");
      if (ok) mod = client;
    } catch (_) { /* not a moderator */ }
  })();

  function modButton(label, cls, fn) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn " + cls; b.textContent = label;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try { await fn(); } catch (err) { console.error(err); alert("That didn't work: " + (err.message || err)); }
      finally { b.disabled = false; }
    });
    return b;
  }

  function modTools(entry) {
    const box = $("viewer-mod");
    box.hidden = !mod;
    if (!mod) return;
    const { p } = entry;
    const gone = () => { entry.tile?.remove(); photos.delete(p.id); $("viewer").close(); };
    const label = document.createElement("span"); label.className = "msg"; label.textContent = "Moderator:";
    box.replaceChildren(
      label,
      modButton(p.pinned_at ? "Unpin" : "Pin to top", "", async () => {
        const { error } = await mod.from("photos").update({ pinned_at: p.pinned_at ? null : new Date().toISOString() }).eq("id", p.id);
        if (error) throw error;
        $("viewer").close();
        reload();
      }),
      modButton("Hide", "", async () => {
        const { error } = await mod.from("photos").update({ status: "pending" }).eq("id", p.id);
        if (error) throw error;
        gone();
      }),
      modButton("Delete", "danger", async () => {
        if (!confirm("Delete this photo for good?")) return;
        const rm = await mod.storage.from(C.bucket).remove([p.path]);
        if (rm.error) throw rm.error;
        const { error } = await mod.from("photos").delete().eq("id", p.id);
        if (error) throw error;
        gone();
      }),
    );
  }

  $("more").addEventListener("click", load);
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  document.querySelectorAll("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));

  // ------------------------------------------------------------ upload
  let picked = null; // { blob, type, ext, width, height }
  const chosenTags = new Set();
  const tagBox = $("upload-tags");
  C.tagGroups.forEach((g) => {
    const row = document.createElement("div"); row.className = "tag-group";
    const name = document.createElement("span"); name.className = "tag-group-name"; name.textContent = g.name;
    row.append(name, ...g.tags.map((t) => chip(t, false, (b) => {
      if (chosenTags.has(t)) chosenTags.delete(t);
      else if (chosenTags.size < MAX_TAGS) chosenTags.add(t);
      else { msg(`Up to ${MAX_TAGS} tags per photo.`, "err"); return; }
      b.setAttribute("aria-pressed", String(chosenTags.has(t)));
    })));
    tagBox.append(row);
  });

  try { $("author").value = localStorage.getItem("gallery-author") || ""; } catch (_) {}

  const msg = (text, kind = "") => { $("upload-msg").textContent = text; $("upload-msg").className = "msg " + kind; };
  const ready = () => { $("send").disabled = !(picked && $("own").checked); };
  $("own").addEventListener("change", ready);

  $("open-upload").addEventListener("click", () => { msg(""); $("upload").showModal(); });

  const drop = $("drop");
  $("file").addEventListener("change", () => pick($("file").files[0]));
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => { e.preventDefault(); pick(e.dataTransfer.files[0]); });

  function toBlob(canvas, type, quality) {
    return new Promise((res) => canvas.toBlob(res, type, quality));
  }

  // Shrink to at most 1920 px on the long side and re-encode as WebP (JPEG where WebP isn't supported).
  async function compress(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
    const width = Math.round(bmp.width * scale), height = Math.round(bmp.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, width, height);
    bmp.close?.();
    for (const q of [0.88, 0.75, 0.6]) {
      let blob = await toBlob(canvas, "image/webp", q), type = "image/webp", ext = "webp";
      if (!blob || blob.type !== "image/webp") { blob = await toBlob(canvas, "image/jpeg", q); type = "image/jpeg"; ext = "jpg"; }
      if (blob && blob.size <= 2.8 * 1024 * 1024) return { blob, type, ext, width, height };
    }
    throw new Error("too big");
  }

  async function pick(file) {
    picked = null; ready();
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { msg("Please choose a PNG, JPG or WebP image.", "err"); return; }
    if (file.size > 40 * 1024 * 1024) { msg("That file is too large (over 40 MB).", "err"); return; }
    msg("Preparing photo…");
    try {
      picked = await compress(file);
      drop.style.backgroundImage = `url(${URL.createObjectURL(picked.blob)})`;
      drop.classList.add("has");
      msg(`${picked.width}×${picked.height}, ${(picked.blob.size / 1024).toFixed(0)} KB`);
    } catch (err) {
      console.error(err);
      msg("Couldn't read that image. Try a different file.", "err");
    }
    ready();
  }

  $("upload-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!picked || !$("own").checked) return;
    const author = $("author").value.trim().slice(0, 40) || "Anonymous";
    const caption = $("caption").value.trim().slice(0, 200);
    try { localStorage.setItem("gallery-author", author === "Anonymous" ? "" : author); } catch (_) {}
    $("send").disabled = true;
    msg("Uploading…");
    const path = `${crypto.randomUUID()}.${picked.ext}`;
    try {
      const up = await sb.storage.from(C.bucket).upload(path, picked.blob, { contentType: picked.type, upsert: false });
      if (up.error) throw up.error;
      const ins = await sb.from("photos").insert({
        path, author, caption, tags: ALL_TAGS.filter((t) => chosenTags.has(t)), width: picked.width, height: picked.height,
      });
      if (ins.error) throw ins.error;
      msg("Thanks! Your photo will appear once it's been checked.", "good");
      picked = null;
      drop.style.backgroundImage = ""; drop.classList.remove("has");
      $("file").value = ""; $("caption").value = "";
    } catch (err) {
      console.error(err);
      const busy = /row-level security|policy/i.test(err.message || "");
      msg(busy ? "Too many photos are waiting to be checked right now. Please try again later."
               : "Upload failed. Please try again.", "err");
    }
    ready();
  });

  load();
})();
