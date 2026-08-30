# mikeboxer.com archive (GoDaddy sunset)

Captured automatically by `.github/workflows/godaddy-mirror.yml` on 2026-08-30.

## What's in here

A full mirror of everything currently served at the public domains:

| Host | Files |
|------|-------|
| `mikeboxer.com` / `www.mikeboxer.com` | Marketing-ops résumé one-pager (`index.html`) + `michael-boxer-headshot.png` |
| `acappella.mikeboxer.com` | A cappella portfolio site — `index.html` (all 11 sub-pages are embedded as `id="..."` sections and swapped client-side, so this one file **is** the whole site), `style.css`, and 8 images under `assets/` |

`MANIFEST.tsv` lists every file with its byte size.

## IMPORTANT: these files are NOT actually coming from GoDaddy anymore

While archiving I checked where the domain resolves, and the live sites have
already moved off GoDaddy:

- **DNS / registrar:** `mikeboxer.com` nameservers are `ns{1cvw,2fgv,3gmt,4clq}.name.com`
  — the domain is registered and its DNS run at **Name.com**, not GoDaddy.
- **Web hosting:** `mikeboxer.com` A records are `185.199.108–111.153` and
  `www` / `acappella` are CNAMEs to `boxoprofundo.github.io` — i.e. the live
  sites are served by **GitHub Pages** (this repo), not GoDaddy.
- **Email:** MX records point to Google Workspace.

So this directory is a snapshot of the **GitHub Pages** content (which already
lives in git history anyway). Cancelling the GoDaddy plan will **not** take
these sites down.

## What is still on GoDaddy — and how to get it

The GoDaddy account (customer #17537351) is still billing a **Web Hosting
Deluxe** plan + **PHP Extended Support Level 1** for `mikeboxer.com` (last
renewed 2026-05-22, ~$243/yr). That is a legacy cPanel/Linux hosting plan that
historically ran the old WordPress site at `acappella.mikeboxer.com`
(confirmed by `wordpress@acappella.mikeboxer.com` auto-update emails,
2014–2017).

Those files sit on the GoDaddy server but are **no longer reachable over the
public domain** (the domain now points at GitHub Pages), so they cannot be
mirrored over HTTP. To retrieve them you must sign in to GoDaddy:

1. **GoDaddy → My Products → Web Hosting → `mikeboxer.com` → Manage → cPanel Admin.**
2. In cPanel, either:
   - **Files → Backup → "Download a Full Account Backup"** (best — captures
     files, databases, email, and settings in one archive), or
   - **Files → File Manager**, select `public_html` (and any other docroots),
     **Compress** to a `.zip`, then **Download**.
3. If there was a WordPress site, also export its database:
   **cPanel → phpMyAdmin →** select the DB **→ Export**.
4. FTP/SFTP is an alternative for the file tree: host `mikeboxer.com` won't
   work now, so use the server's direct hostname shown on the cPanel/hosting
   dashboard (typically `*.prod.*.secureserver.net`) with your hosting FTP
   user.

Once downloaded, those are the real "files stored on GoDaddy." Only then is it
safe to cancel the hosting plan. The domain itself is at Name.com and is
unaffected.
