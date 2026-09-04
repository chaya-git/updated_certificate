# Custom certificate fonts (optional)

Drop real font files here to have them used instead of the built-in
Helvetica fallback:

- `CertificateName-Bold.ttf` — used only for the student's name.
- `CertificateBody-Regular.ttf` — used for every other line of body text
  (labels, the fixed completion sentence, description text, etc.).

Both are loaded and embedded in `loadCertificateFonts()` in `server.js`,
via `pdf-lib`'s `fontkit` integration, **before** anything is measured or
drawn — so there's never a mismatch between the font used to measure text
width (for centering/auto-sizing) and the font actually baked into the
downloaded PDF.

If these files are not present, the app automatically falls back to
`Helvetica-Bold` (name) / `Helvetica` (body) and keeps working exactly as
before — nothing breaks if you don't add fonts.
