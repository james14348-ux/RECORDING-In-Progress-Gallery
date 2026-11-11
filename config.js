// Public settings for the gallery. The publishable key is meant to be public:
// what visitors can do with it is limited by the database rules in supabase/setup.sql.
window.GALLERY_CONFIG = {
  supabaseUrl: "https://gxrrplcnydtniqqbhdkw.supabase.co",
  supabaseKey: "sb_publishable_alDOLVWJKUgSlIBTfveI_w_2wh4w2u2",
  bucket: "photos",
  // Tag groups, shown in this order. Photos store the tag text, so add new tags freely but don't rename old ones.
  // A photo can have at most 8 tags.
  tagGroups: [
    { name: "Dimension", tags: ["Overworld", "Nether", "End"] },
    { name: "Season", tags: ["Spring", "Summer", "Autumn", "Winter"] },
    { name: "Shot", tags: ["Long exposure", "Fisheye", "Zoom", "Flash", "Selfie", "Shallow focus", "Shaders"] },
    { name: "Mods", tags: ["Trealism", "Getting Up"] },
  ],
  modrinth: "https://modrinth.com/project/dzl9xQJA",
  github: "https://github.com/james14348-ux/RECORDING-In-Progress",
};
