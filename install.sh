#!/usr/bin/env bash
# needledrop installer — copies (or links) the theme into Spicetify and applies it.
#
#   ./install.sh                 install & apply
#   ./install.sh --link          symlink the theme files instead of copying (for development)
#   ./install.sh --matugen       also wire up wallpaper colors through matugen
#   ./install.sh --no-restart    apply without restarting Spotify (recommended for Flatpak Spotify)
#   ./install.sh --uninstall     switch Spicetify back to the stock look
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="needledrop"
LINK=0
MATUGEN=0
APPLY_FLAGS=()

for arg in "$@"; do
  case "$arg" in
    --link) LINK=1 ;;
    --matugen) MATUGEN=1 ;;
    --no-restart) APPLY_FLAGS+=(-n) ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

say() { printf '\033[1m→\033[0m %s\n' "$*"; }
die() {
  printf '\033[31m✗\033[0m %s\n' "$*" >&2
  exit 1
}

SPICETIFY="$(command -v spicetify || true)"
[[ -z "$SPICETIFY" && -x "$HOME/.spicetify/spicetify" ]] && SPICETIFY="$HOME/.spicetify/spicetify"
[[ -n "$SPICETIFY" ]] || die "spicetify not found — install it first: https://spicetify.app"

USERDATA="$("$SPICETIFY" path userdata 2>/dev/null | tail -n1)"
[[ -d "$USERDATA" ]] || die "could not locate the Spicetify config folder"
THEME_DIR="$USERDATA/Themes/$NAME"

if [[ "${UNINSTALL:-0}" == 1 ]]; then
  say "switching Spicetify back to the stock theme"
  "$SPICETIFY" config current_theme "" color_scheme ""
  "$SPICETIFY" apply "${APPLY_FLAGS[@]}"
  say "done — $THEME_DIR was left in place; delete it if you like"
  exit 0
fi

say "installing into $THEME_DIR"
mkdir -p "$THEME_DIR/assets"
for f in user.css theme.js color.ini; do
  rm -f "$THEME_DIR/$f"
  if [[ "$LINK" == 1 ]]; then
    ln -s "$REPO/theme/$f" "$THEME_DIR/$f"
  else
    cp "$REPO/theme/$f" "$THEME_DIR/$f"
  fi
done

if [[ "$MATUGEN" == 1 ]]; then
  command -v matugen >/dev/null || die "matugen not found — https://github.com/InioX/matugen"
  MATUGEN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/matugen"
  CONFIG="$MATUGEN_DIR/config.toml"
  SPOTIFY_PATH="$("$SPICETIFY" config spotify_path 2>/dev/null | tail -n1)"
  [[ -f "$CONFIG" ]] || die "no matugen config at $CONFIG"
  mkdir -p "$MATUGEN_DIR/templates"
  cp "$REPO/matugen/spotify-needledrop.json" "$MATUGEN_DIR/templates/spotify-needledrop.json"
  if grep -q '^\[templates.spotify-needledrop\]' "$CONFIG"; then
    say "matugen template already registered"
  else
    say "registering the matugen template in $CONFIG"
    cp "$CONFIG" "$CONFIG.bak-needledrop"
    cat >>"$CONFIG" <<EOF

# needledrop (Spicetify): wallpaper colors, read live by the theme — no re-apply needed
[templates.spotify-needledrop]
input_path = '$MATUGEN_DIR/templates/spotify-needledrop.json'
output_path = '$THEME_DIR/assets/nd-wallpaper.json'
post_hook = 'mkdir -p "$SPOTIFY_PATH/Apps/xpui/assets" && cp "$THEME_DIR/assets/nd-wallpaper.json" "$SPOTIFY_PATH/Apps/xpui/assets/"'
EOF
  fi
  say "colors update the next time matugen runs (e.g. when you change wallpaper)"
fi

say "applying with Spicetify"
"$SPICETIFY" config current_theme "$NAME" color_scheme "$NAME" \
  inject_css 1 inject_theme_js 1 replace_colors 1 overwrite_assets 1 >/dev/null
"$SPICETIFY" apply "${APPLY_FLAGS[@]}"
say "done — enjoy the record 🎶"
