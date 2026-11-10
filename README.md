# RECORDING In Progress Gallery

A public photo gallery for the [RECORDING In Progress](https://modrinth.com/project/dzl9xQJA) Minecraft camera mod. Players upload their in-game photos, and each one appears after a moderator approves it.

- `index.html` + `app.js`: the gallery and the upload form. Images are shrunk to 1920 px and re-encoded as WebP in the browser before upload.
- `moderate.html` + `moderate.js`: the moderator page (sign in with a Supabase account listed in `public.admins`).
- `supabase/setup.sql`: tables, storage bucket and row-level security rules. Run it once in the Supabase SQL Editor.
- `config.js`: the Supabase URL and **publishable** key. These are public by design; the rules in `setup.sql` decide what visitors can do.

Hosted with GitHub Pages; there's no build step.

## License

MIT. See [LICENSE](LICENSE).
