#!/usr/bin/env bash
# Rebrand from REON to TRANCE MUSIC
# This script updates all references across the codebase

set -euo pipefail

echo "🎵 Rebranding to TRANCE MUSIC..."

# Function to replace text in files
replace_in_file() {
  local file="$1"
  local old="$2"
  local new="$3"
  
  if [[ -f "$file" ]]; then
    sed -i "s/$old/$new/g" "$file"
    echo "  ✓ Updated $file"
  fi
}

# Update app configuration files
echo "📝 Updating configuration files..."

replace_in_file "app/src-tauri/tauri.conf.json" '"productName": "REON"' '"productName": "TRANCE MUSIC"'
replace_in_file "app/src-tauri/tauri.conf.json" '"identifier": "com.reon.app"' '"identifier": "com.trancemusic.app"'
replace_in_file "app/src-tauri/Cargo.toml" 'name = "reon"' 'name = "trance-music"'
replace_in_file "app/package.json" '"name": "reon"' '"name": "trance-music"'
replace_in_file "package.json" '"name": "reon"' '"name": "trance-music"'

# Update HTML title tags
echo "📄 Updating HTML files..."

replace_in_file "app/src/index.html" '<title>REON</title>' '<title>TRANCE MUSIC</title>'
replace_in_file "app/src/mobile/index.html" '<title>REON</title>' '<title>TRANCE MUSIC</title>'

# Update README and documentation
echo "📚 Updating documentation..."

if [[ -f "README.md" ]]; then
  sed -i 's/REON/TRANCE MUSIC/g' README.md
  sed -i 's/reon/trance-music/g' README.md
  echo "  ✓ Updated README.md"
fi

# Update any remaining references in source files
echo "🔍 Scanning for remaining references..."

# Find and list files that might need manual review
echo ""
echo "Files that may need manual review:"
grep -r "REON\|Reon\|reon" app/src --include="*.js" --include="*.html" --include="*.css" 2>/dev/null | \
  grep -v "node_modules" | \
  cut -d: -f1 | \
  sort -u | \
  while read -r file; do
    echo "  ⚠️  $file"
  done

echo ""
echo "✅ Branding update complete!"
echo ""
echo "Next steps:"
echo "1. Create new logo assets (see docs/branding-guide.md)"
echo "2. Replace app/src/logo.png and app/src/mobile/logo.png"
echo "3. Update app icons in app/src-tauri/icons/"
echo "4. Test the app to ensure all branding looks correct"
echo "5. Commit changes: git add . && git commit -m 'Rebrand to TRANCE MUSIC'"
