// survey.js — First-Time Opening Survey & Personalization Flow
// Flow: 1. Profile Name & Country & Languages -> 2. Favorite Artists -> 3. Theme & Streaming Experience
import { diag, toast } from "./core.js";
import { applyTheme, applySysPrefs, paintGreeting, prefName, prefCountry, prefLangs, prefTheme, prefStreamQuality, savePref, saveLangs, NAME_KEY, COUNTRY_KEY, THEME_KEY, STREAM_QUALITY_KEY } from "./settings.js";
import { loadHome, loadLibrary, LIBRARY_KEY } from "./home.js";

export const SURVEY_DONE_KEY = "tm-survey-done";
export const SURVEY_ARTISTS_KEY = "tm-survey-artists";

// Rich catalog of 28+ diverse artists across Indian, Global Pop, EDM/Trance, Hip-Hop, and Cinematic genres
export const CATALOG_ARTISTS = [
  // Bollywood & Indian Melody / Fusion
  {
    id: "arijit-singh",
    name: "Arijit Singh",
    genre: "Bollywood / Soul",
    tag: "indian",
    image: "https://c.saavncdn.com/artists/Arijit_Singh_002_20240320072044_500x500.jpg",
    followers: "42M Listeners",
  },
  {
    id: "ar-rahman",
    name: "A.R. Rahman",
    genre: "Soundtrack / Fusion",
    tag: "indian",
    image: "https://c.saavncdn.com/artists/A_R_Rahman_004_20231128100551_500x500.jpg",
    followers: "31M Listeners",
  },
  {
    id: "shreya-ghoshal",
    name: "Shreya Ghoshal",
    genre: "Playback / Melody",
    tag: "indian",
    image: "https://c.saavncdn.com/artists/Shreya_Ghoshal_004_20231128100726_500x500.jpg",
    followers: "28M Listeners",
  },
  {
    id: "anirudh-ravichander",
    name: "Anirudh Ravichander",
    genre: "Electronic / High-Energy",
    tag: "indian",
    image: "https://c.saavncdn.com/artists/Anirudh_Ravichander_003_20240404104246_500x500.jpg",
    followers: "25M Listeners",
  },
  {
    id: "sid-sriram",
    name: "Sid Sriram",
    genre: "Soul / Carnatic",
    tag: "indian",
    image: "https://c.saavncdn.com/artists/Sid_Sriram_002_20230714104618_500x500.jpg",
    followers: "19M Listeners",
  },
  {
    id: "diljit-dosanjh",
    name: "Diljit Dosanjh",
    genre: "Punjabi Pop / Urban",
    tag: "indian",
    image: "https://c.saavncdn.com/artists/Diljit_Dosanjh_004_20231024063231_500x500.jpg",
    followers: "22M Listeners",
  },
  {
    id: "prateek-kuhad",
    name: "Prateek Kuhad",
    genre: "Indie / Acoustic",
    tag: "indie",
    image: "https://c.saavncdn.com/artists/Prateek_Kuhad_002_20200812061922_500x500.jpg",
    followers: "6.8M Listeners",
  },
  {
    id: "amit-trivedi",
    name: "Amit Trivedi",
    genre: "Alternative / Experimental",
    tag: "indian",
    image: "https://c.saavncdn.com/artists/Amit_Trivedi_004_20231128100523_500x500.jpg",
    followers: "14M Listeners",
  },

  // Pop & Global Icons
  {
    id: "taylor-swift",
    name: "Taylor Swift",
    genre: "Pop / Songwriter",
    tag: "pop",
    image: "https://c.saavncdn.com/artists/Taylor_Swift_500x500.jpg",
    followers: "86M Listeners",
  },
  {
    id: "the-weeknd",
    name: "The Weeknd",
    genre: "Synthwave / R&B",
    tag: "pop",
    image: "https://c.saavncdn.com/artists/The_Weeknd_500x500.jpg",
    followers: "79M Listeners",
  },
  {
    id: "billie-eilish",
    name: "Billie Eilish",
    genre: "Alt-Pop / Spatial",
    tag: "pop",
    image: "https://c.saavncdn.com/artists/Billie_Eilish_500x500.jpg",
    followers: "65M Listeners",
  },
  {
    id: "coldplay",
    name: "Coldplay",
    genre: "Alternative Rock / Stadium",
    tag: "pop",
    image: "https://c.saavncdn.com/artists/Coldplay_500x500.jpg",
    followers: "68M Listeners",
  },
  {
    id: "dua-lipa",
    name: "Dua Lipa",
    genre: "Dance-Pop / Nu-Disco",
    tag: "pop",
    image: "https://c.saavncdn.com/artists/Dua_Lipa_500x500.jpg",
    followers: "58M Listeners",
  },
  {
    id: "ed-sheeran",
    name: "Ed Sheeran",
    genre: "Acoustic Pop",
    tag: "pop",
    image: "https://c.saavncdn.com/artists/Ed_Sheeran_500x500.jpg",
    followers: "74M Listeners",
  },
  {
    id: "adele",
    name: "Adele",
    genre: "Soul / Power Ballad",
    tag: "pop",
    image: "https://c.saavncdn.com/artists/Adele_500x500.jpg",
    followers: "52M Listeners",
  },
  {
    id: "bts",
    name: "BTS",
    genre: "K-Pop / Global",
    tag: "pop",
    image: "https://c.saavncdn.com/artists/BTS_500x500.jpg",
    followers: "44M Listeners",
  },

  // Hip-Hop & Rap
  {
    id: "drake",
    name: "Drake",
    genre: "Hip-Hop / Global Rap",
    tag: "hiphop",
    image: "https://c.saavncdn.com/artists/Drake_500x500.jpg",
    followers: "71M Listeners",
  },
  {
    id: "kendrick-lamar",
    name: "Kendrick Lamar",
    genre: "Conscious Hip-Hop",
    tag: "hiphop",
    image: "https://c.saavncdn.com/artists/Kendrick_Lamar_500x500.jpg",
    followers: "48M Listeners",
  },
  {
    id: "post-malone",
    name: "Post Malone",
    genre: "Melodic Rap / Pop",
    tag: "hiphop",
    image: "https://c.saavncdn.com/artists/Post_Malone_500x500.jpg",
    followers: "60M Listeners",
  },

  // Electronic, Trance & Audiophile Masters
  {
    id: "armin-van-buuren",
    name: "Armin van Buuren",
    genre: "Trance / Progressive",
    tag: "electronic",
    image: "https://c.saavncdn.com/artists/Armin_van_Buuren_500x500.jpg",
    followers: "12M Listeners",
  },
  {
    id: "martin-garrix",
    name: "Martin Garrix",
    genre: "EDM / Big Room",
    tag: "electronic",
    image: "https://c.saavncdn.com/artists/Martin_Garrix_500x500.jpg",
    followers: "26M Listeners",
  },
  {
    id: "solaris-kaelen",
    name: "Solaris & Kaelen",
    genre: "Atmospheric Trance",
    tag: "electronic",
    image: "https://lh3.googleusercontent.com/aida-public/AB6AXuAkawEFZnNvxtQ6fWByT21JIw63azvt--ataqxMIT3DRQk-D_xDgSZApDUE0v9RhYWkzGkzI7BSdL3-cViP0Z7SbuLq9O98KcBt11fanz6G9FZsachToD_wBEi12vLntk6kj-TNWcepmCgwgyhVDsrZ98Gbgfh5O2jLZUG7xnflIkWdtga-nihxfpN_a31K4hzwkitJgZFyzH7iG3mZWCxwP69peRbGvEetYmIaJNoTIsIjFn38-dJ-Dg",
    followers: "842k Listeners",
  },
  {
    id: "aura-sound",
    name: "Aura Sound",
    genre: "Deep Soundstage / Ambient",
    tag: "electronic",
    image: "https://lh3.googleusercontent.com/aida-public/AB6AXuBEzieNAFTP0rzrxytcXzCE-yWYNypZlRDXBJFMsyn8IOs0j5qvN_QNrBnVv0ynyePcuIjwyfSTaOT3VdH3F2w-CVXdypzbwUPK7-8tR269QlGh2MRiF-dpQ6cCrA26wtlMTjtybyBRoazNsJgkeErFHJPZYWHD-T7dd2qzwQLPpWyjIZrzWyTAdcJw4d7lPSs_kbAQ1woEtLzbyQUvILqPgZ5sP4D9vS5WkcnSyJ4Yt7zWm1YXq0nQfA",
    followers: "615k Listeners",
  },
  {
    id: "daft-punk",
    name: "Daft Punk",
    genre: "French House / Electro",
    tag: "electronic",
    image: "https://c.saavncdn.com/artists/Daft_Punk_500x500.jpg",
    followers: "24M Listeners",
  },

  // Soundtracks & Modern Classical
  {
    id: "hans-zimmer",
    name: "Hans Zimmer",
    genre: "Cinematic Master / Orchestral",
    tag: "indie",
    image: "https://c.saavncdn.com/artists/Hans_Zimmer_500x500.jpg",
    followers: "18M Listeners",
  },
  {
    id: "ludovico-einaudi",
    name: "Ludovico Einaudi",
    genre: "Minimalist Piano / Classical",
    tag: "indie",
    image: "https://c.saavncdn.com/artists/Ludovico_Einaudi_500x500.jpg",
    followers: "11M Listeners",
  },
];

// Comprehensive countries with flag emojis
export const SURVEY_COUNTRIES = [
  ["", "🌐 Automatic (Recommended)"],
  ["IN", "🇮🇳 India"],
  ["US", "🇺🇸 United States"],
  ["GB", "🇬🇧 United Kingdom"],
  ["CA", "🇨🇦 Canada"],
  ["AU", "🇦🇺 Australia"],
  ["DE", "🇩🇪 Germany"],
  ["FR", "🇫🇷 France"],
  ["JP", "🇯🇵 Japan"],
  ["KR", "🇰🇷 South Korea"],
  ["BR", "🇧🇷 Brazil"],
  ["AE", "🇦🇪 United Arab Emirates"],
  ["SG", "🇸🇬 Singapore"],
  ["NL", "🇳🇱 Netherlands"],
  ["SE", "🇸🇪 Sweden"],
  ["ES", "🇪🇸 Spain"],
  ["IT", "🇮🇹 Italy"],
  ["BD", "🇧🇩 Bangladesh"],
  ["PK", "🇵🇰 Pakistan"],
  ["NP", "🇳🇵 Nepal"],
  ["LK", "🇱🇰 Sri Lanka"],
  ["MY", "🇲🇾 Malaysia"],
  ["ZA", "🇿🇦 South Africa"],
];

// Language options
export const SURVEY_LANGS = [
  ["all", "All Languages"],
  ["english", "English"],
  ["hindi", "Hindi"],
  ["telugu", "Telugu"],
  ["tamil", "Tamil"],
  ["punjabi", "Punjabi"],
  ["bengali", "Bengali"],
  ["kannada", "Kannada"],
  ["malayalam", "Malayalam"],
  ["marathi", "Marathi"],
  ["gujarati", "Gujarati"],
  ["spanish", "Spanish"],
  ["french", "French"],
  ["korean", "Korean"],
  ["japanese", "Japanese"],
  ["german", "German"],
];

let currentStep = 1;
let selectedName = "";
let selectedCountry = "";
let selectedLangs = [];
let selectedArtists = new Set();
let selectedTheme = "dark";
let selectedQuality = "320kbps";
let artistFilterQuery = "";
let artistGenreTag = "all";

export function getSavedSurveyArtists() {
  try {
    const raw = localStorage.getItem(SURVEY_ARTISTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function isSurveyCompleted() {
  try {
    return localStorage.getItem(SURVEY_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

export function openSurvey() {
  let modal = document.getElementById("tm-survey-dialog");
  if (!modal) {
    modal = document.createElement("dialog");
    modal.id = "tm-survey-dialog";
    modal.className = "tm-survey-dialog backdrop:bg-black/60 backdrop:backdrop-blur-md";
    document.body.appendChild(modal);
  }

  // Pre-load existing selections if any
  selectedName = prefName() || "Listener";
  if (selectedName === "Listener") selectedName = "";
  selectedCountry = prefCountry() || "";
  selectedLangs = prefLangs();
  selectedTheme = prefTheme() || "dark";
  selectedQuality = prefStreamQuality() || "320kbps";

  const prevArtists = getSavedSurveyArtists();
  selectedArtists = new Set(prevArtists.length ? prevArtists : ["arijit-singh", "the-weeknd", "ar-rahman", "armin-van-buuren"]);

  currentStep = 1;
  renderSurveyStep(modal);

  try {
    if (!modal.open) modal.showModal();
  } catch {
    modal.setAttribute("open", "");
  }
}

function renderSurveyStep(modal) {
  modal.innerHTML = `
    <div class="tm-survey-container">
      <!-- Modal Top Bar -->
      <div class="tm-survey-header">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-on-primary">
            <span class="material-symbols-outlined text-[18px]">graphic_eq</span>
          </div>
          <div>
            <h2 class="font-headline-md text-headline-md font-bold text-on-surface">Welcome to OPEN MUSIC</h2>
            <p class="font-body-sm text-body-sm text-secondary">Audiophile Setup &amp; Personalization Flow</p>
          </div>
        </div>
        <button type="button" id="survey-skip-btn" class="text-xs font-label-mono text-secondary hover:text-on-surface px-3 py-1.5 rounded-lg hover:bg-surface-container transition-colors">
          Skip Setup
        </button>
      </div>

      <!-- Stepper Indicator -->
      <div class="tm-survey-stepper">
        <div class="tm-step-item ${currentStep === 1 ? 'is-active' : currentStep > 1 ? 'is-done' : ''}">
          <span class="tm-step-num">${currentStep > 1 ? '✓' : '1'}</span>
          <span class="tm-step-title">Profile &amp; Region</span>
        </div>
        <div class="tm-step-connector ${currentStep > 1 ? 'is-done' : ''}"></div>
        <div class="tm-step-item ${currentStep === 2 ? 'is-active' : currentStep > 2 ? 'is-done' : ''}">
          <span class="tm-step-num">${currentStep > 2 ? '✓' : '2'}</span>
          <span class="tm-step-title">Favorite Artists</span>
        </div>
        <div class="tm-step-connector ${currentStep > 2 ? 'is-done' : ''}"></div>
        <div class="tm-step-item ${currentStep === 3 ? 'is-active' : ''}">
          <span class="tm-step-num">3</span>
          <span class="tm-step-title">Theme &amp; Quality</span>
        </div>
      </div>

      <!-- Step Content Area -->
      <div class="tm-survey-body">
        ${renderCurrentStepHtml()}
      </div>

      <!-- Step Navigation Footer -->
      <div class="tm-survey-footer">
        <div>
          ${currentStep > 1 ? `
            <button type="button" id="survey-prev-btn" class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-label-md text-label-md transition-colors flex items-center gap-1.5">
              <span class="material-symbols-outlined text-[16px]">arrow_back</span>
              <span>Back</span>
            </button>
          ` : `
            <span class="font-label-mono text-[11px] text-secondary">Step 1 of 3</span>
          `}
        </div>
        <div class="flex items-center gap-2">
          ${currentStep < 3 ? `
            <button type="button" id="survey-next-btn" class="px-5 py-2.5 rounded-lg bg-primary text-on-primary font-label-md text-label-md hover:bg-primary-container transition-all flex items-center gap-2 shadow-sm font-semibold">
              <span>Continue to ${currentStep === 1 ? 'Artists' : 'Theme'}</span>
              <span class="material-symbols-outlined text-[16px]">arrow_forward</span>
            </button>
          ` : `
            <button type="button" id="survey-finish-btn" class="px-6 py-2.5 rounded-lg bg-primary text-on-primary font-label-md text-label-md hover:scale-[1.02] transition-all flex items-center gap-2 shadow-md font-semibold">
              <span class="material-symbols-outlined text-[18px]">rocket_launch</span>
              <span>Complete Setup &amp; Start Listening</span>
            </button>
          `}
        </div>
      </div>
    </div>
  `;

  attachStepListeners(modal);
}

function renderCurrentStepHtml() {
  if (currentStep === 1) {
    return `
      <div class="flex flex-col gap-5 py-2">
        <div>
          <h3 class="text-lg font-semibold text-on-surface">Step 1: What should we call you?</h3>
          <p class="text-sm text-secondary mt-0.5">Your display name will appear in contextual greetings and room sessions.</p>
        </div>

        <div class="flex flex-col gap-1.5">
          <label for="survey-name-input" class="text-xs font-mono uppercase tracking-wider text-secondary">Listener Name</label>
          <div class="relative">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[20px]">person</span>
            <input id="survey-name-input" type="text" maxlength="32" value="${escapeHtml(selectedName)}" placeholder="e.g. Alex, Maya, or Studio-1" class="w-full bg-surface-container-low border border-surface-container-highest/80 rounded-xl pl-10 pr-4 py-3 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all" autocomplete="name" />
          </div>
        </div>

        <div class="flex flex-col gap-1.5 pt-2">
          <label for="survey-country-select" class="text-xs font-mono uppercase tracking-wider text-secondary">Your Country / Catalog Region</label>
          <div class="relative">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[20px]">public</span>
            <select id="survey-country-select" class="w-full bg-surface-container-low border border-surface-container-highest/80 rounded-xl pl-10 pr-4 py-3 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all appearance-none cursor-pointer">
              ${SURVEY_COUNTRIES.map(([code, label]) => `
                <option value="${code}" ${code === selectedCountry ? 'selected' : ''}>${label}</option>
              `).join('')}
            </select>
            <span class="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-secondary pointer-events-none text-[20px]">expand_more</span>
          </div>
          <span class="text-[11px] text-secondary">Sets the regional charts and release spotlights to match your location.</span>
        </div>

        <div class="flex flex-col gap-2 pt-2">
          <div class="flex items-center justify-between">
            <label class="text-xs font-mono uppercase tracking-wider text-secondary">Music Languages</label>
            <span class="text-[11px] text-secondary">${selectedLangs.length ? `${selectedLangs.length} picked` : 'All languages'}</span>
          </div>
          <div class="flex flex-wrap gap-2 max-h-36 overflow-y-auto pr-1">
            ${SURVEY_LANGS.map(([slug, label]) => {
              const isSelected = slug === "all" ? !selectedLangs.length : selectedLangs.includes(slug);
              return `
                <button type="button" data-survey-lang="${slug}" class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 border ${
                  isSelected
                    ? 'bg-primary text-on-primary border-primary shadow-xs font-semibold'
                    : 'bg-surface-container-low text-on-surface border-surface-container-highest/60 hover:bg-surface-container'
                }">
                  <span>${label}</span>
                  ${isSelected ? '<span class="material-symbols-outlined text-[14px]">check</span>' : ''}
                </button>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `;
  }

  if (currentStep === 2) {
    const q = artistFilterQuery.toLowerCase().trim();
    const filtered = CATALOG_ARTISTS.filter(a => {
      const matchGenre = artistGenreTag === "all" || a.tag === artistGenreTag;
      const matchSearch = !q || a.name.toLowerCase().includes(q) || a.genre.toLowerCase().includes(q);
      return matchGenre && matchSearch;
    });

    return `
      <div class="flex flex-col gap-4 py-1">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 class="text-lg font-semibold text-on-surface">Step 2: Choose Your Favorite Artists</h3>
            <p class="text-sm text-secondary mt-0.5">Select at least 1-3 artists to seed your daily bitstream and recommendations.</p>
          </div>
          <div class="px-3 py-1 rounded-full bg-surface-container text-xs font-mono text-on-surface shrink-0 self-start sm:self-auto">
            <span class="font-bold text-primary">${selectedArtists.size}</span> selected
          </div>
        </div>

        <!-- Artist Search & Genre Filter Bar -->
        <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          <div class="relative flex-1">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-secondary text-[18px]">search</span>
            <input id="survey-artist-search" type="text" value="${escapeHtml(artistFilterQuery)}" placeholder="Search artists, bands, composers..." class="w-full bg-surface-container-low border border-surface-container-highest/80 rounded-xl pl-9 pr-3 py-2 text-xs text-on-surface focus:outline-none focus:ring-1 focus:ring-primary" />
          </div>
          <div class="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
            ${[
              ["all", "All"],
              ["indian", "Indian"],
              ["pop", "Pop & Global"],
              ["electronic", "Trance & EDM"],
              ["hiphop", "Hip-Hop"],
              ["indie", "Soundtrack / Indie"],
            ].map(([tag, label]) => `
              <button type="button" data-survey-genre="${tag}" class="px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-colors ${
                artistGenreTag === tag ? 'bg-primary text-on-primary font-semibold' : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
              }">${label}</button>
            `).join('')}
          </div>
        </div>

        <!-- Artists Grid: Circular Profile Cards -->
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3.5 max-h-[380px] overflow-y-auto pr-1">
          ${filtered.map(artist => {
            const isChecked = selectedArtists.has(artist.id);
            return `
              <div data-artist-id="${artist.id}" class="tm-survey-artist-card p-3 rounded-xl border transition-all cursor-pointer flex flex-col items-center text-center relative group ${
                isChecked
                  ? 'bg-surface-container border-primary shadow-sm ring-2 ring-primary/20'
                  : 'bg-surface-container-low border-surface-container-highest/60 hover:border-black/30 hover:bg-surface-container'
              }">
                <div class="relative w-20 h-20 rounded-full overflow-hidden bg-surface-container-high mb-2.5 shadow-xs">
                  <img src="${artist.image}" alt="${escapeHtml(artist.name)}" loading="lazy" class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" onerror="this.onerror=null;this.src='https://c.saavncdn.com/artists/Arijit_Singh_002_20240320072044_500x500.jpg';" />
                  ${isChecked ? `
                    <div class="absolute inset-0 bg-black/40 flex items-center justify-center">
                      <span class="material-symbols-outlined text-white text-[24px]" style="font-variation-settings: 'FILL' 1;">check_circle</span>
                    </div>
                  ` : ''}
                </div>
                <h4 class="text-xs font-semibold text-on-surface truncate w-full" dir="auto">${escapeHtml(artist.name)}</h4>
                <p class="text-[10px] text-secondary truncate w-full mt-0.5">${escapeHtml(artist.genre)}</p>
                <span class="text-[9px] font-mono text-on-surface-variant mt-1">${artist.followers}</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  if (currentStep === 3) {
    return `
      <div class="flex flex-col gap-5 py-2">
        <div>
          <h3 class="text-lg font-semibold text-on-surface">Step 3: Customize Theme &amp; Stream Quality</h3>
          <p class="text-sm text-secondary mt-0.5">Tune the visual aesthetic and acoustic bitrate to your audio gear.</p>
        </div>

        <!-- Theme Selection Cards -->
        <div class="flex flex-col gap-2">
          <label class="text-xs font-mono uppercase tracking-wider text-secondary">Interface Aesthetic</label>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <button type="button" data-survey-theme="dark" class="p-3.5 rounded-xl border text-left transition-all flex flex-col justify-between ${
              selectedTheme === 'dark' ? 'border-primary ring-2 ring-primary/20 bg-surface-container shadow-sm' : 'border-surface-container-highest/60 bg-surface-container-low hover:bg-surface-container'
            }">
              <div class="flex items-center justify-between w-full mb-3">
                <span class="w-8 h-8 rounded-lg bg-neutral-900 text-white flex items-center justify-center">
                  <span class="material-symbols-outlined text-[18px]">dark_mode</span>
                </span>
                <span class="material-symbols-outlined text-[18px] ${selectedTheme === 'dark' ? 'text-primary' : 'opacity-0'}">check</span>
              </div>
              <div>
                <span class="text-sm font-semibold text-on-surface block">Dark Obsidian</span>
                <span class="text-xs text-secondary mt-0.5 block">Minimal eye strain, high contrast focus</span>
              </div>
            </button>

            <button type="button" data-survey-theme="light" class="p-3.5 rounded-xl border text-left transition-all flex flex-col justify-between ${
              selectedTheme === 'light' ? 'border-primary ring-2 ring-primary/20 bg-surface-container shadow-sm' : 'border-surface-container-highest/60 bg-surface-container-low hover:bg-surface-container'
            }">
              <div class="flex items-center justify-between w-full mb-3">
                <span class="w-8 h-8 rounded-lg bg-neutral-100 text-neutral-900 border border-neutral-300 flex items-center justify-center">
                  <span class="material-symbols-outlined text-[18px]">light_mode</span>
                </span>
                <span class="material-symbols-outlined text-[18px] ${selectedTheme === 'light' ? 'text-primary' : 'opacity-0'}">check</span>
              </div>
              <div>
                <span class="text-sm font-semibold text-on-surface block">Clean Studio</span>
                <span class="text-xs text-secondary mt-0.5 block">Crisp daylight look, sharp readability</span>
              </div>
            </button>

            <button type="button" data-survey-theme="system" class="p-3.5 rounded-xl border text-left transition-all flex flex-col justify-between ${
              selectedTheme === 'system' ? 'border-primary ring-2 ring-primary/20 bg-surface-container shadow-sm' : 'border-surface-container-highest/60 bg-surface-container-low hover:bg-surface-container'
            }">
              <div class="flex items-center justify-between w-full mb-3">
                <span class="w-8 h-8 rounded-lg bg-surface-container-high text-on-surface flex items-center justify-center">
                  <span class="material-symbols-outlined text-[18px]">desktop_windows</span>
                </span>
                <span class="material-symbols-outlined text-[18px] ${selectedTheme === 'system' ? 'text-primary' : 'opacity-0'}">check</span>
              </div>
              <div>
                <span class="text-sm font-semibold text-on-surface block">System Sync</span>
                <span class="text-xs text-secondary mt-0.5 block">Follows your OS dark/light switch</span>
              </div>
            </button>
          </div>
        </div>

        <!-- Audio Streaming Quality -->
        <div class="flex flex-col gap-2 pt-2">
          <label class="text-xs font-mono uppercase tracking-wider text-secondary">Audio Bitrate &amp; Telemetry</label>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <button type="button" data-survey-quality="320kbps" class="p-3.5 rounded-xl border text-left transition-all flex flex-col justify-between ${
              selectedQuality === '320kbps' ? 'border-primary ring-2 ring-primary/20 bg-surface-container shadow-sm' : 'border-surface-container-highest/60 bg-surface-container-low hover:bg-surface-container'
            }">
              <div class="flex items-center justify-between w-full mb-2">
                <span class="px-2 py-0.5 rounded bg-primary text-on-primary font-mono text-[10px] font-semibold">MAX QUALITY</span>
                <span class="material-symbols-outlined text-[18px] ${selectedQuality === '320kbps' ? 'text-primary' : 'opacity-0'}">check</span>
              </div>
              <div>
                <span class="text-sm font-semibold text-on-surface block">FLAC 320 kbps</span>
                <span class="text-xs text-secondary mt-0.5 block">Bit-perfect master dynamic range</span>
              </div>
            </button>

            <button type="button" data-survey-quality="160kbps" class="p-3.5 rounded-xl border text-left transition-all flex flex-col justify-between ${
              selectedQuality === '160kbps' ? 'border-primary ring-2 ring-primary/20 bg-surface-container shadow-sm' : 'border-surface-container-highest/60 bg-surface-container-low hover:bg-surface-container'
            }">
              <div class="flex items-center justify-between w-full mb-2">
                <span class="px-2 py-0.5 rounded bg-surface-container-high text-on-surface font-mono text-[10px]">BALANCED</span>
                <span class="material-symbols-outlined text-[18px] ${selectedQuality === '160kbps' ? 'text-primary' : 'opacity-0'}">check</span>
              </div>
              <div>
                <span class="text-sm font-semibold text-on-surface block">160 kbps</span>
                <span class="text-xs text-secondary mt-0.5 block">Smooth streaming on any connection</span>
              </div>
            </button>

            <button type="button" data-survey-quality="96kbps" class="p-3.5 rounded-xl border text-left transition-all flex flex-col justify-between ${
              selectedQuality === '96kbps' ? 'border-primary ring-2 ring-primary/20 bg-surface-container shadow-sm' : 'border-surface-container-highest/60 bg-surface-container-low hover:bg-surface-container'
            }">
              <div class="flex items-center justify-between w-full mb-2">
                <span class="px-2 py-0.5 rounded bg-surface-container-high text-on-surface font-mono text-[10px]">SAVER</span>
                <span class="material-symbols-outlined text-[18px] ${selectedQuality === '96kbps' ? 'text-primary' : 'opacity-0'}">check</span>
              </div>
              <div>
                <span class="text-sm font-semibold text-on-surface block">96 kbps</span>
                <span class="text-xs text-secondary mt-0.5 block">Minimal bandwidth consumption</span>
              </div>
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

function attachStepListeners(modal) {
  // Skip button
  document.getElementById("survey-skip-btn")?.addEventListener("click", () => {
    finishSurvey(false);
    modal.close();
  });

  // Next / Prev buttons
  document.getElementById("survey-prev-btn")?.addEventListener("click", () => {
    if (currentStep > 1) {
      currentStep--;
      renderSurveyStep(modal);
    }
  });

  document.getElementById("survey-next-btn")?.addEventListener("click", () => {
    // Validate / collect step 1
    if (currentStep === 1) {
      const nameIn = document.getElementById("survey-name-input");
      if (nameIn) selectedName = nameIn.value.trim() || "Listener";
      const countrySel = document.getElementById("survey-country-select");
      if (countrySel) selectedCountry = countrySel.value;
      currentStep = 2;
      renderSurveyStep(modal);
      return;
    }

    if (currentStep === 2) {
      currentStep = 3;
      renderSurveyStep(modal);
      return;
    }
  });

  document.getElementById("survey-finish-btn")?.addEventListener("click", () => {
    finishSurvey(true);
    modal.close();
  });

  // Step 1: Language toggle buttons
  modal.querySelectorAll("[data-survey-lang]").forEach(btn => {
    btn.addEventListener("click", () => {
      const slug = btn.dataset.surveyLang;
      if (slug === "all") {
        selectedLangs = [];
      } else {
        if (selectedLangs.includes(slug)) {
          selectedLangs = selectedLangs.filter(s => s !== slug);
        } else {
          selectedLangs.push(slug);
        }
      }
      renderSurveyStep(modal);
    });
  });

  // Step 2: Search input & Genre filter
  const searchInput = document.getElementById("survey-artist-search");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      artistFilterQuery = e.target.value;
      renderSurveyStep(modal);
      const inputAfter = document.getElementById("survey-artist-search");
      if (inputAfter) {
        inputAfter.focus();
        inputAfter.setSelectionRange(inputAfter.value.length, inputAfter.value.length);
      }
    });
  }

  modal.querySelectorAll("[data-survey-genre]").forEach(btn => {
    btn.addEventListener("click", () => {
      artistGenreTag = btn.dataset.surveyGenre;
      renderSurveyStep(modal);
    });
  });

  // Step 2: Artist card toggle
  modal.querySelectorAll("[data-artist-id]").forEach(card => {
    card.addEventListener("click", () => {
      const id = card.dataset.artistId;
      if (selectedArtists.has(id)) {
        selectedArtists.delete(id);
      } else {
        selectedArtists.add(id);
      }
      renderSurveyStep(modal);
    });
  });

  // Step 3: Theme cards (live apply!)
  modal.querySelectorAll("[data-survey-theme]").forEach(btn => {
    btn.addEventListener("click", () => {
      selectedTheme = btn.dataset.surveyTheme;
      savePref(THEME_KEY, selectedTheme);
      applyTheme();
      renderSurveyStep(modal);
    });
  });

  // Step 3: Stream quality cards
  modal.querySelectorAll("[data-survey-quality]").forEach(btn => {
    btn.addEventListener("click", () => {
      selectedQuality = btn.dataset.surveyQuality;
      savePref(STREAM_QUALITY_KEY, selectedQuality);
      renderSurveyStep(modal);
    });
  });
}

function finishSurvey(applied = true) {
  try {
    localStorage.setItem(SURVEY_DONE_KEY, "1");
  } catch {}

  if (applied) {
    const finalName = selectedName.trim() || "Listener";
    savePref(NAME_KEY, finalName);
    savePref(COUNTRY_KEY, selectedCountry);
    saveLangs(selectedLangs);
    savePref(THEME_KEY, selectedTheme);
    savePref(STREAM_QUALITY_KEY, selectedQuality);

    // Save selected artists
    const artistArray = Array.from(selectedArtists);
    try {
      localStorage.setItem(SURVEY_ARTISTS_KEY, JSON.stringify(artistArray));
    } catch {}

    // Add selected artists into user's Library
    const lib = loadLibrary();
    const chosenObjects = CATALOG_ARTISTS.filter(a => selectedArtists.has(a.id));
    for (const a of chosenObjects) {
      if (!lib.some(x => x.token === a.id || x.title === a.name)) {
        lib.push({
          id: a.id,
          token: a.id,
          kind: "artist",
          title: a.name,
          subtitle: a.genre,
          image: a.image,
          count: 0,
        });
      }
    }
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib.slice(0, 100)));
    } catch {}

    applySysPrefs();
    paintGreeting();
    loadHome();

    toast(`Welcome, ${finalName}! Your audiophile soundstage is ready.`, "success", 4000);
    diag("survey", true, `Profile set for ${finalName}, ${selectedCountry || 'Global'}, ${artistArray.length} artists`);
  } else {
    paintGreeting();
  }
}

export function initSurvey() {
  if (!isSurveyCompleted()) {
    // Show on first run after initial DOM render
    setTimeout(() => {
      openSurvey();
    }, 600);
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
