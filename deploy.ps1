# Copies wii-os to the mini PC over SSH.
#   .\deploy.ps1            copy files only
#   .\deploy.ps1 -Restart   copy, then restart the TV session
#   .\deploy.ps1 -Install   copy, run system/install.sh, then restart the TV session
param(
  [string]$Target = "max@wii-os.local",
  [switch]$Restart,
  [switch]$Install
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# cmd keeps the tar stream binary; a PowerShell 5.1 pipe would mangle it.
cmd /c "tar -cf - bin system wiid ui | ssh $Target ""rm -rf ~/wii-os && mkdir -p ~/wii-os && tar -xmf - -C ~/wii-os && sed -i 's/\r$//' ~/wii-os/bin/* ~/wii-os/system/*.sh ~/wii-os/wiid/*.py && chmod +x ~/wii-os/bin/* ~/wii-os/system/*.sh"""
if ($LASTEXITCODE -ne 0) { throw "copy failed" }
Write-Host "Copied to $Target"

if ($Install) {
  ssh $Target "cd ~/wii-os && sudo ./system/install.sh"
  if ($LASTEXITCODE -ne 0) { throw "install failed" }
}
if ($Restart -or $Install) {
  # Stopping wiid makes cage exit; cage is the login process on tty1, so
  # getty then logs in again. With no session yet (first install), start getty.
  ssh $Target "pkill -f '[w]iid/wiid.py' || sudo systemctl restart getty@tty1"
  Write-Host "TV session restarted"
}
