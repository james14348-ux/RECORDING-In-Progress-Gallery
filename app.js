(() => {
  const C = window.GALLERY_CONFIG;
  const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey, { auth: { persistSession: false } });
  const $ = (id) => document.getElementById(id);
  const PAGE = 24;

  $("lnk-modrinth").href = C.modrinth;
  $("lnk-github").href = C.github;

  // ------------------------------------------------------------ gallery
  let offset = 0, filter = null, loading = false;

  function chip(label, pressed, onClick) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = label;
    b.setAttribute("aria-pressed", String(pressed));
    b.addEventListener("click", () => onClick(b));
    return b;
  }

  const filterChips = $("chips");
  [null, ...C.tags].forEach((t) => {
    filterChips.append(chip(t ?? "All", t === null, (b) => {
      filter = t;
      filterChips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
      reload();
    }));
  });

  function reload() {
    offset = 0;
    $("grid").replaceChildren();
    load();
  }

  async function load() {
    if (loading) return;
    loading = true;
    $("more").hidden = true;
    $("status").textContent = "Loading photos…";
    $("status").hidden = false;
    try {
      let q = sb.from("photos")
        .select("id,path,author,caption,tags,width,height,created_at")
        .eq("status", "approved")
        .order("created_at", { ascending: false })
        .range(offset, offset + PAGE - 1);
      if (filter) q = q.contains("tags", [filter]);
      const { data, error } = await q;
      if (error) throw error;

      let urls = {};
      if (data.length) {
        const { data: signed, error: e2 } = await sb.storage.from(C.bucket).createSignedUrls(data.map((p) => p.path), 60 * 60 * 6);
        if (e2) throw e2;
        signed.forEach((s) => { if (s.signedUrl) urls[s.path] = s.signedUrl; });
      }
      data.forEach((p) => { if (urls[p.path]) $("grid").append(tile(p, urls[p.path])); });
      offset += data.length;

      if (offset === 0) {
        $("status").textContent = filter ? `No "${filter}" photos yet.` : "No photos yet. Be the first!";
      } else {
        $("status").hidden = true;
      }
      $("more").hidden = data.length < PAGE;
    } catch (err) {
      console.error(err);
      $("status").textContent = "Couldn't load the photos. Try refreshing the page.";
    } finally {
      loading = false;
    }
  }

  function tile(p, url) {
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
    fig.append(img, frame, meta);
    const open = () => view(p, url);
    fig.addEventListener("click", open);
    fig.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    return fig;
  }

  function view(p, url) {
    $("viewer-img").src = url;
    $("viewer-img").alt = p.caption || `Photo by ${p.author}`;
    $("viewer-title").textContent = new Date(p.created_at).toLocaleDateString();
    $("viewer-caption").textContent = p.caption;
    $("viewer-caption").hidden = !p.caption;
    $("viewer-by").textContent = "by " + p.author;
    $("viewer-tags").replaceChildren(...(p.tags || []).map((t) => {
      const s = document.createElement("span"); s.className = "tag"; s.textContent = t; return s;
    }));
    $("viewer").showModal();
  }

  $("more").addEventListener("click", load);
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  document.querySelectorAll("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));

  // ------------------------------------------------------------ upload
  let picked = null; // { blob, type, ext, width, height }
  const chosenTags = new Set();
  const tagBox = $("upload-tags");
  C.tags.forEach((t) => tagBox.append(chip(t, false, (b) => {
    if (chosenTags.has(t)) chosenTags.delete(t); else chosenTags.add(t);
    b.setAttribute("aria-pressed", String(chosenTags.has(t)));
  })));

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
        path, author, caption, tags: [...chosenTags], width: picked.width, height: picked.height,
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
