#!/bin/bash
# Does Foxwright work with the Firefox this Linux desktop has (Ubuntu's Snap, a Flatpak, or a
# .deb/tarball)? Run it on a real desktop session, as yourself, with nothing else to prepare:
#
#   curl -fsSL https://raw.githubusercontent.com/william-ricchiuti/FoxWright/main/scripts/check-linux-desktop.sh | bash
#
# It installs Node.js if needed (via snap, no sudo prompts beyond that), runs `foxwright setup`,
# opens the Foxwright store page in your Firefox for you to click "Add to Firefox", waits for the
# extension to connect, and prints a report to paste into a GitHub issue. Nothing is uploaded.
set -u
say() { printf '\n== %s\n' "$*"; }
REPORT="$HOME/foxwright-desktop-check.txt"
exec > >(tee "$REPORT") 2>&1

say "System"
. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"
echo "Session: ${XDG_SESSION_TYPE:-?} / ${XDG_CURRENT_DESKTOP:-?}"
FF=$(command -v firefox || true)
echo "firefox on PATH: ${FF:-none}"
[ -n "$FF" ] && { file -L "$FF" | cut -c1-120; }
command -v snap >/dev/null && snap list firefox 2>/dev/null | tail -1
command -v flatpak >/dev/null && flatpak list --app 2>/dev/null | grep -i mozilla
pgrep -a xdg-desktop-portal | head -3 || echo "xdg-desktop-portal: not running"

say "Node.js"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Installing Node.js 22 with snap (asks for your password once)…"
  sudo snap install node --classic --channel=22 || { echo "Could not install Node.js"; exit 1; }
  export PATH="/snap/bin:$PATH"
fi
node --version

say "Foxwright setup"
npx -y foxwright-firefox@latest setup 2>&1 | sed 's/\x1b\[[0-9;]*m//g'

say "Install the extension"
echo "Firefox will open the Foxwright page. Click 'Add to Firefox' and confirm, then come back here."
(firefox https://addons.mozilla.org/firefox/addon/foxwright/ >/dev/null 2>&1 &)
for i in $(seq 1 60); do
  if npx -y foxwright-firefox@latest doctor 2>/dev/null | grep -q "Firefox connected"; then
    echo "Connected after about $((i * 5)) s."
    break
  fi
  sleep 5
done

say "doctor"
npx -y foxwright-firefox@latest doctor 2>&1 | sed 's/\x1b\[[0-9;]*m//g'

say "Helper log (last 30 lines)"
tail -30 "$HOME/.foxwright/helper.log" 2>/dev/null || echo "(no helper log: Firefox never started the helper)"

say "Sandbox / portal messages from the last 10 minutes"
journalctl --user --since "-10 min" --no-pager 2>/dev/null | grep -i -E "portal|native|foxwright|apparmor" | tail -20 || true
journalctl -k --since "-10 min" --no-pager 2>/dev/null | grep -i -E "apparmor=\"DENIED\".*firefox" | tail -10 || true

say "Done. Report saved to $REPORT"
