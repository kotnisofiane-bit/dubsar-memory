[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-DubsarRegularFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$TrustedRoot
  )

  $full = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetFullPath($TrustedRoot).TrimEnd('\')
  if (-not ($full.StartsWith("$root\", [System.StringComparison]::OrdinalIgnoreCase))) {
    throw "Chemin de lancement DUBSAR non fiable."
  }
  $current = $full
  while ($true) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Chemin de lancement DUBSAR non fiable."
    }
    if ($current.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) { break }
    $parent = [System.IO.Directory]::GetParent($current)
    if ($null -eq $parent) { throw "Chemin de lancement DUBSAR non fiable." }
    $current = $parent.FullName.TrimEnd('\')
  }
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
    throw "Fichier de lancement DUBSAR introuvable."
  }
  return $full
}

$workbenchRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")).Path
$windowsRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$bootstrapPath = Assert-DubsarRegularFile -Path (Join-Path $PSScriptRoot "open-workbench.ps1") -TrustedRoot $workbenchRoot
$powershellPath = Assert-DubsarRegularFile -Path (Join-Path $windowsRoot "System32\WindowsPowerShell\v1.0\powershell.exe") -TrustedRoot $windowsRoot

if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
  throw "Bootstrap DUBSAR introuvable."
}
if (-not (Test-Path -LiteralPath $powershellPath -PathType Leaf)) {
  throw "Windows PowerShell introuvable."
}

$desktop = [Environment]::GetFolderPath("Desktop")
$programs = [Environment]::GetFolderPath("Programs")
$destinations = @($desktop, $programs) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
$shell = New-Object -ComObject WScript.Shell

foreach ($destination in $destinations) {
  $shortcutPath = Join-Path $destination "DUBSAR Workbench.lnk"
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $powershellPath
  $shortcut.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$bootstrapPath`""
  $shortcut.WorkingDirectory = $workbenchRoot
  $shortcut.Description = "Ouvrir DUBSAR Workbench dans Chrome"
  $shortcut.Save()
  if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
    throw "Le raccourci DUBSAR n'a pas pu être créé dans $destination."
  }
}

Write-Output "Raccourci DUBSAR Workbench installé sur le Bureau et dans le menu Démarrer."
