// legal.js — About / Terms / Licences copy for the mobile Settings screen.
//
// Ported from the desktop's src/settings.js panes (licenses, about, terms),
// which keep the authoritative text. Self-contained on purpose: importing
// settings.js would drag the desktop shell into the mobile bundle.
import { esc } from "../html.js";

export const APP = { name: "OPEN MUSIC", version: "0.3.0", id: "com.openmusic.trancemusic" };

export const PLATFORM = /android/i.test(navigator.userAgent) ? "Android" : /iphone|ipad|ipod/i.test(navigator.userAgent) ? "iOS" : "Mobile";

/// Direct Rust dependencies (Cargo.lock); the transitive tree lives in the
/// lock file, this is the attribution list an about page is expected to carry.
export const LICENSES = [
  ["tauri", "2.12.0", "MIT OR Apache-2.0"],
  ["serde", "1.0.229", "MIT"],
  ["serde_json", "1.0.151", "MIT OR Apache-2.0"],
  ["tokio", "1.53.1", "MIT"],
  ["axum", "0.8.9", "MIT"],
  ["reqwest", "0.12.28", "MIT OR Apache-2.0"],
  ["url", "2.5.8", "MIT OR Apache-2.0"],
  ["futures", "0.3.34", "MIT OR Apache-2.0"],
  ["des", "0.8.1", "MIT"],
  ["base64", "0.22.1", "MIT OR Apache-2.0"],
  ["tauri-plugin-global-shortcut", "2.4.0", "MIT OR Apache-2.0"],
  ["tauri-plugin-single-instance", "2.5.2", "MIT OR Apache-2.0"],
];

const kv = (k, v) => `
  <div class="flex flex-col gap-0.5 px-3.5 py-2.5">
    <dt class="font-label-mono text-[10px] uppercase tracking-wider text-on-surface-variant">${esc(k)}</dt>
    <dd class="text-sm text-on-surface min-w-0">${esc(v)}</dd>
  </div>`;

const clause = (n, h, body) => `
  <li class="flex gap-3 px-3.5 py-3">
    <span class="w-6 h-6 shrink-0 mt-0.5 rounded-md bg-primary text-on-primary font-label-mono text-[11px] flex items-center justify-center">${esc(n)}</span>
    <span class="min-w-0 flex flex-col gap-1">
      <h3 class="text-sm font-semibold text-on-surface">${esc(h)}</h3>
      <p class="text-[13px] leading-relaxed text-on-surface-variant">${body}</p>
    </span>
  </li>`;

const note = (html) => `<p class="text-xs leading-relaxed text-on-surface-variant border-l-2 border-primary/40 pl-3">${html}</p>`;

export function licensesHTML() {
  return `
    <div class="flex flex-col gap-3">
      <p class="text-[13px] leading-relaxed text-on-surface-variant">${esc(APP.name)} itself is MIT licensed — see <span class="font-label-mono">LICENSE</span> in the repository. The Rust core links the direct dependencies below; every one is MIT or dual MIT&nbsp;/&nbsp;Apache-2.0.</p>
      <div class="rounded-xl border border-surface-container-highest/60 bg-surface-container-lowest overflow-x-auto">
        <table class="w-full font-label-mono text-[11px] border-collapse">
          <thead>
            <tr class="bg-surface-container text-on-surface-variant">
              <th class="text-left font-normal uppercase tracking-wider text-[10px] px-3 py-2">Crate</th>
              <th class="text-left font-normal uppercase tracking-wider text-[10px] px-3 py-2 w-16">Version</th>
              <th class="text-left font-normal uppercase tracking-wider text-[10px] px-3 py-2">Licence</th>
            </tr>
          </thead>
          <tbody>
            ${LICENSES.map(
              ([n, v, l]) => `
            <tr class="border-t border-surface-container-high/70">
              <td class="px-3 py-1.5 text-on-surface">${esc(n)}</td>
              <td class="px-3 py-1.5 text-on-surface-variant">${esc(v)}</td>
              <td class="px-3 py-1.5 text-on-surface-variant">${esc(l)}</td>
            </tr>`,
            ).join("")}
            <tr class="border-t border-surface-container-high/70">
              <td class="px-3 py-1.5 text-on-surface">@tauri-apps/cli</td>
              <td class="px-3 py-1.5 text-on-surface-variant">^2 (dev)</td>
              <td class="px-3 py-1.5 text-on-surface-variant">MIT OR Apache-2.0</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="text-xs leading-relaxed text-on-surface-variant">The complete dependency tree lives in <span class="font-label-mono">app/src-tauri/Cargo.lock</span>. Full licence texts: <span class="font-label-mono">LICENSE</span> for this project, and each upstream repository for its crate. No copyleft licences are linked.</p>
    </div>`;
}

export function aboutHTML() {
  return `
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-3">
        <span class="w-11 h-11 shrink-0 rounded-xl bg-primary flex items-center justify-center">
          <span class="material-symbols-outlined text-[22px] text-on-primary" style="font-variation-settings: &quot;FILL&quot; 1;">graphic_eq</span>
        </span>
        <div class="min-w-0">
          <p class="text-base font-semibold text-on-surface">${esc(APP.name)}</p>
          <p class="font-label-mono text-[11px] text-on-surface-variant mt-0.5">v${esc(APP.version)} &middot; ${esc(APP.id)} &middot; ${esc(PLATFORM)}</p>
        </div>
      </div>
      <p class="text-[13px] leading-relaxed text-on-surface-variant">A music player that streams from JioSaavn through a local range relay, keeps an offline vault on your device, and never lets the webview talk to a third-party CDN directly.</p>
      <dl class="rounded-xl border border-surface-container-highest/60 bg-surface-container-lowest overflow-hidden divide-y divide-surface-container-high/70">
        ${kv("Shell", "Tauri 2, Rust 1.77+")}
        ${kv("Front end", "Vanilla ES modules, no build step, Tailwind")}
        ${kv("Catalog", "JioSaavn first-party, 5 community mirrors as fallback")}
        ${kv("Playback", "Local axum relay on 127.0.0.1, Range forwarded verbatim")}
        ${kv("Lyrics", "LRCLIB, Better Lyrics, then JioSaavn, LRCLIB search")}
        ${kv("Vault", "App data folder · OPEN MUSIC")}
        ${kv("Licence", "MIT")}
      </dl>
      ${note("Pre-release software. Development status is in <span class='font-label-mono'>CHANGELOG.md</span>.")}
    </div>`;
}

export function termsHTML() {
  return `
    <div class="flex flex-col gap-3">
      <p class="text-[13px] leading-relaxed text-on-surface-variant">Last updated 30 September 2026. By using ${esc(APP.name)} you accept these terms.</p>
      <ol class="rounded-xl border border-surface-container-highest/60 bg-surface-container-lowest overflow-hidden divide-y divide-surface-container-high/70 list-none">
        ${clause(1, "Personal, non-commercial use", "You may use OPEN MUSIC for your own personal, non-commercial listening. Reselling access, redistributing the application, or operating a public service built on it requires written permission.")}
        ${clause(2, "No content is bundled", "OPEN MUSIC ships no audio. It is a player: tracks, artwork and lyrics are fetched at request time from third-party services. Rights to that content stay with their owners, and those services' own terms also apply to you.")}
        ${clause(3, "Your downloads are yours", "Anything you save lands in this app's own data folder on your device and is your responsibility to keep, back up and delete. OPEN MUSIC is not liable for lost or damaged files.")}
        ${clause(4, "No warranty", `The software is provided "as is", without warranty of any kind, to the maximum extent the law allows. It is pre-release: expect bugs, data-loss bugs included. ${esc(APP.name)} is an independent project and is not affiliated with, endorsed by, or sponsored by JioSaavn, LRCLIB, or any mirror listed in the source.`)}
        ${clause(5, "Limitation of liability", "To the fullest extent permitted by law, the authors and contributors are not liable for any indirect, incidental or consequential damages arising from use of the software, including lost data, lost profits, or unavailable services.")}
        ${clause(6, "Copyright complaints", "Copyright holders may ask for stored media to be removed. Contact the maintainers through the repository and the relevant item will be deleted from the vault promptly.")}
        ${clause(7, "Changes", "These terms may change as the project matures. The date above and the copy in the repository are authoritative; material changes will be noted in the changelog.")}
      </ol>
      ${note("This summary is provided for convenience and is not legal advice.")}
    </div>`;
}
