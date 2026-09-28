$ErrorActionPreference = 'Stop'
$root = 'C:\Users\rohit\Music\OPEN MUSIC'
$ref  = Join-Path $root '_ref'
$utf8 = [System.Text.Encoding]::UTF8
$homeHtml = [System.IO.File]::ReadAllText((Join-Path $ref 'home.html'), $utf8)
$search = [System.IO.File]::ReadAllText((Join-Path $ref 'search.html'), $utf8)
$np = [System.IO.File]::ReadAllText((Join-Path $ref 'nowplaying.html'), $utf8)
$nl = [Environment]::NewLine

function Inner-Main([string]$html) {
  $s = $html.IndexOf('<main')
  $s = $html.IndexOf('>', $s) + 1
  $e = $html.LastIndexOf('</main>')
  return $html.Substring($s, $e - $s)
}

# ---------- HEAD (home) ----------
$headStart = $homeHtml.IndexOf('<head>')
$headEnd = $homeHtml.IndexOf('</head>')
$head = $homeHtml.Substring($headStart, $headEnd - $headStart)
$head = $head.Replace('<title>TRANCE MUSIC Audiophile Player</title>', '<title>TRANCE MUSIC</title>')
$head += '<link rel="stylesheet" href="styles.css" />'
$head += '<script type="module" src="/main.js" defer></script>'
$head += '</head>'

# ---------- HEADER (home): trim nav to trio + top search box ----------
$hStart = $homeHtml.IndexOf('<header')
$hEnd = $homeHtml.IndexOf('</header>') + '</header>'.Length
$header = $homeHtml.Substring($hStart, $hEnd - $hStart)
$header = [regex]::Replace($header, '<a[^>]*data-path="(library|downloads|settings)"[^>]*>.*?</a>', '')
$navForm = '</nav><form id="nav-search-form" class="hidden md:flex items-center gap-2 flex-1 max-w-md mx-4 bg-surface-container-lowest rounded-lg px-3 py-1.5 shadow-sm" role="search"><span class="material-symbols-outlined text-on-surface-variant text-[18px]">search</span><input id="nav-search-input" class="w-full bg-transparent text-on-surface font-body-md text-body-md placeholder:text-on-surface-variant focus:outline-none" placeholder="Search songs, artists..." autocomplete="off" /></form>'
$header = $header.Replace('</nav>', $navForm)

# ---------- SEARCH VIEW ----------
$searchInner = Inner-Main $search
$mpStart = $searchInner.IndexOf('<!-- Docked Sticky Mini-Player')
$mpEnd = $searchInner.IndexOf('</script>', $mpStart) + '</script>'.Length
$searchInner = $searchInner.Remove($mpStart, $mpEnd - $mpStart)
$item1 = $searchInner.IndexOf('<!-- Item 1: Active Playing -->')
$secEnd = $searchInner.IndexOf('</section>', $item1)
$searchInner = $searchInner.Remove($item1, $secEnd - $item1).Insert($item1, '<div id="results" class="flex flex-col gap-2"></div></div>')
$searchInner = $searchInner.Replace(
  '<p class="font-body-sm text-body-sm text-on-surface-variant">Showing results matching "Solaris &amp; Kaelen" and correlated studio recordings</p>',
  '<p id="results-sub" class="font-body-sm text-body-sm text-on-surface-variant">Search the catalog - results appear here.</p>')
$searchInner = $searchInner.Replace(
  '<!-- Filter Chips -->',
  '<div id="history" class="flex items-center gap-2 flex-wrap"></div>' + $nl + '<!-- Filter Chips -->')
$searchInner = $searchInner.Replace(
  '<!-- Featured Master Releases Bento Section -->',
  '<div id="error" class="hidden rounded-xl bg-error-container text-on-error-container px-4 py-3 font-body-md text-body-md"></div>' + $nl + '<!-- Featured Master Releases Bento Section -->')
# search controls ids + Play all button
$searchInner = $searchInner.Replace(
  '<button class="bg-primary text-on-primary font-label-md text-label-md px-4 py-2 rounded-lg hover:bg-inverse-surface transition-colors flex items-center gap-1.5 shadow-sm active:translate-y-0.5">',
  '<button id="search-btn" type="button" class="bg-primary text-on-primary font-label-md text-label-md px-4 py-2 rounded-lg hover:bg-inverse-surface transition-colors flex items-center gap-1.5 shadow-sm active:translate-y-0.5">')
$searchInner = $searchInner.Replace(
  '<button class="flex items-center justify-center w-7 h-7 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors" title="Clear search">',
  '<button id="search-clear" type="button" class="flex items-center justify-center w-7 h-7 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors" title="Clear search">')
$searchInner = [regex]::Replace(
  $searchInner,
  '<button class="px-3 py-1\.5 rounded-lg bg-primary text-on-primary font-label-md text-label-md hover:bg-inverse-surface transition-colors flex items-center gap-1\.5">\s*<span class="material-symbols-outlined text-\[16px\]">download_for_offline</span>\s*<span>Batch Download</span>\s*</button>',
  '<button id="play-all" type="button" class="px-3 py-1.5 rounded-lg bg-primary text-on-primary font-label-md text-label-md hover:bg-inverse-surface transition-colors flex items-center gap-1.5"><span class="material-symbols-outlined text-[16px]">play_arrow</span><span>Play all</span></button>')
$searchInner += '<section class="py-6"><details id="diag-wrap" class="rounded-xl bg-surface-container-lowest shadow-sm p-4"><summary class="font-label-md text-label-md text-on-surface cursor-pointer">Diagnostics</summary><ol id="diag" class="mt-2 flex flex-col gap-1"></ol></details></section></div>'

# ---------- NOW PLAYING VIEW ----------
$npInner = Inner-Main $np
$npInner = $npInner.Replace(
  '<span class="text-on-surface font-mono text-[11px] uppercase tracking-wider font-semibold">MASTER LOSSLESS',
  '<span id="np-badge" class="text-on-surface font-mono text-[11px] uppercase tracking-wider font-semibold">RESOLVING')
$npInner = $npInner.Replace(
  '<span class="font-mono text-[11px]">FLAC',
  '<span id="np-format" class="font-mono text-[11px]">320kbps')

# ---------- FOOTER PLAYER BAR (home) + ids ----------
$fStart = $homeHtml.IndexOf('<footer')
$fEnd = $homeHtml.IndexOf('</footer>') + '</footer>'.Length
$footer = $homeHtml.Substring($fStart, $fEnd - $fStart)
$footer = $footer.Replace(
  '<div class="w-14 h-14 rounded-lg bg-surface-container-high flex items-center justify-center shrink-0 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"><span class="material-symbols-outlined text-on-surface-variant text-[28px]">album</span></div>',
  '<div class="w-14 h-14 rounded-lg bg-surface-container-high flex items-center justify-center shrink-0 overflow-hidden shadow-[0_1px_2px_rgba(0,0,0,0.04)]"><img id="bar-cover" class="w-full h-full object-cover hidden" alt="" /><span id="bar-cover-fallback" class="material-symbols-outlined text-on-surface-variant text-[28px]">album</span></div>')
$footer = $footer.Replace(
  '<span class="font-body-md text-body-md font-semibold text-on-surface truncate">Midnight City Lights</span>',
  '<span id="bar-title" class="font-body-md text-body-md font-semibold text-on-surface truncate">TRANCE MUSIC</span>')
$footer = $footer.Replace(
  '<p class="font-body-sm text-body-sm text-on-surface-variant truncate mt-0.5">Solaris &amp; Kaelen</p>',
  '<p id="bar-artist" class="font-body-sm text-body-sm text-on-surface-variant truncate mt-0.5">Search and play a track</p>')
$footer = $footer.Replace(
  '<span class="font-label-mono text-[9px] leading-tight px-1 py-0.5 rounded bg-surface-container-highest text-on-surface-variant font-medium shrink-0">FLAC 24/96</span>',
  '<span id="bar-badge" class="font-label-mono text-[9px] leading-tight px-1 py-0.5 rounded bg-surface-container-highest text-on-surface-variant font-medium shrink-0">IDLE</span>')
$footer = $footer.Replace(
  '<button class="text-on-surface-variant hover:text-on-surface transition-colors p-1" type="button"><span class="material-symbols-outlined text-[18px]">shuffle</span></button>',
  '<button id="bar-shuffle" class="text-on-surface-variant hover:text-on-surface transition-colors p-1" type="button"><span class="material-symbols-outlined text-[18px]">shuffle</span></button>')
$footer = $footer.Replace(
  '<button class="text-on-surface-variant hover:text-on-surface transition-colors p-1" type="button"><span class="material-symbols-outlined text-[20px]">skip_previous</span></button>',
  '<button id="bar-prev" class="text-on-surface-variant hover:text-on-surface transition-colors p-1" type="button"><span class="material-symbols-outlined text-[20px]">skip_previous</span></button>')
$footer = $footer.Replace(
  '<button class="w-9 h-9 rounded-full bg-primary text-on-primary flex items-center justify-center hover:opacity-90 transition-opacity" type="button"><span class="material-symbols-outlined text-[20px]">play_arrow</span></button>',
  '<button id="bar-play" class="w-9 h-9 rounded-full bg-primary text-on-primary flex items-center justify-center hover:opacity-90 transition-opacity" type="button"><span id="bar-play-icon" class="material-symbols-outlined text-[20px]">play_arrow</span></button>')
$footer = $footer.Replace(
  '<button class="text-on-surface-variant hover:text-on-surface transition-colors p-1" type="button"><span class="material-symbols-outlined text-[20px]">skip_next</span></button>',
  '<button id="bar-next" class="text-on-surface-variant hover:text-on-surface transition-colors p-1" type="button"><span class="material-symbols-outlined text-[20px]">skip_next</span></button>')
$footer = $footer.Replace(
  '<button class="text-on-surface-variant hover:text-on-surface transition-colors p-1" type="button"><span class="material-symbols-outlined text-[18px]">repeat</span></button>',
  '<button id="bar-repeat" class="text-on-surface-variant hover:text-on-surface transition-colors p-1" type="button"><span class="material-symbols-outlined text-[18px]">repeat</span></button>')
$footer = $footer.Replace(
  '<span class="font-label-mono text-label-mono text-on-surface-variant">03:42</span>',
  '<span id="bar-time-cur" class="font-label-mono text-label-mono text-on-surface-variant">00:00</span>')
$footer = $footer.Replace(
  '<span class="font-label-mono text-label-mono text-on-surface-variant">06:21</span>',
  '<span id="bar-time-total" class="font-label-mono text-label-mono text-on-surface-variant">00:00</span>')
$footer = $footer.Replace(
  '<div class="relative flex-1 h-1 bg-surface-container-high rounded-full overflow-hidden cursor-pointer group"><div class="absolute left-0 top-0 bottom-0 w-[58%] bg-primary rounded-full group-hover:bg-primary-container transition-all"></div></div>',
  '<div id="bar-progress" class="relative flex-1 h-1 bg-surface-container-high rounded-full overflow-hidden cursor-pointer group"><div id="bar-progress-fill" class="absolute left-0 top-0 bottom-0 w-0 bg-primary rounded-full group-hover:bg-primary-container transition-all"></div></div>')
$footer = $footer.Replace(
  '<div class="relative flex-1 h-1 bg-surface-container-high rounded-full overflow-hidden cursor-pointer"><div class="absolute left-0 top-0 bottom-0 w-3/4 bg-primary rounded-full"></div></div>',
  '<div id="bar-vol-track" class="relative flex-1 h-1 bg-surface-container-high rounded-full overflow-hidden cursor-pointer"><div id="bar-vol-fill" class="absolute left-0 top-0 bottom-0 w-3/4 bg-primary rounded-full"></div></div>')
$footer = $footer.Replace(
  '<button class="text-on-surface-variant hover:text-on-surface transition-colors p-1" type="button"><span class="material-symbols-outlined text-[20px]">queue_music</span></button>',
  '<button id="bar-queue" class="text-on-surface-variant hover:text-on-surface transition-colors p-1" type="button" title="Open queue"><span class="material-symbols-outlined text-[20px]">queue_music</span></button>')
$footer = $footer.Replace(
  '<div class="flex items-center gap-space-md truncate"><span class="">DSP Pipeline: Pass-through</span>',
  '<div id="bar-telemetry" class="flex items-center gap-space-md truncate"><span class="">idle</span>')

# ---------- SEARCH MICRO SCRIPT (keep filter chips + download + ctrl+k) ----------
$scriptMatches = [regex]::Matches($search, '(?s)<script>(.*?)</script>')
$microScript = $scriptMatches[$scriptMatches.Count - 1].Value

# ---------- ASSEMBLE ----------
$homeBody = Inner-Main $homeHtml
$main = '<main class="w-full pt-16 pb-36 min-h-screen bg-surface px-gutter"><div class="flex flex-col w-full max-w-[1440px] mx-auto pb-12 space-y-space-xl">'
$main += '<div data-view="home">' + $homeBody + '</div>'
$main += '<div data-view="search" class="hidden">' + $searchInner + '</div>'
$main += '<div data-view="now-playing" class="hidden">' + $npInner + '</div>'
$main += '</div></main>'
$main += '<audio id="audio" preload="metadata" class="hidden"></audio>'

$doc = '<!DOCTYPE html><html lang="en">' + $head + '<body class="bg-surface font-body-md text-body-md text-on-surface antialiased">'
$doc += $header + $main + $footer + $microScript + '</body></html>'

$out = Join-Path $root 'app\src\index.html'
[System.IO.File]::WriteAllText($out, $doc, [System.Text.UTF8Encoding]::new($false))
'written {0} bytes' -f (Get-Item $out).Length
