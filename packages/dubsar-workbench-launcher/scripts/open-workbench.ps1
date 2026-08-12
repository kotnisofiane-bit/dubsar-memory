[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Show-DubsarError {
  param([Parameter(Mandatory = $true)][string]$Message)

  try {
    Add-Type -AssemblyName PresentationFramework -ErrorAction Stop
    [System.Windows.MessageBox]::Show(
      $Message,
      "DUBSAR Workbench",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Error
    ) | Out-Null
  } catch {
    # Le lanceur .cmd reste le parcours de diagnostic si les dialogues Windows
    # sont eux-mêmes indisponibles sur le poste.
  }
}

function Get-DubsarMessage {
  param([Parameter(Mandatory = $true)][string]$Code)

  switch ($Code) {
    "NODE_NOT_FOUND" { return "Node.js 20 ou plus récent n'est pas installé. Installez Node.js, puis relancez DUBSAR Workbench." }
    "NODE_VERSION_UNSUPPORTED" { return "DUBSAR Workbench nécessite Node.js 20 ou plus récent." }
    "CHROME_NOT_FOUND" { return "Google Chrome n'a pas été trouvé sur ce poste." }
    "PROJECT_REGISTRY_INVALID" { return "La liste locale des projets DUBSAR est endommagée. Utilisez Gérer les projets DUBSAR pour la corriger." }
    "PROJECT_SELECTION_INVALID" { return "Le dossier choisi ne contient pas un projet DUBSAR valide." }
    "POWERSHELL_NOT_FOUND" { return "Le sélecteur de dossier Windows n'est pas disponible." }
    "FOLDER_PICKER_UNAVAILABLE" { return "Le sélecteur de dossier DUBSAR n'est pas disponible." }
    "FOLDER_PICKER_FAILED" { return "Le sélecteur de dossier Windows n'a pas pu démarrer." }
    "FOLDER_PICKER_TIMEOUT" { return "Le choix du dossier a expiré. Relancez DUBSAR Workbench." }
    "CATALOG_REPORT_TOO_LARGE" { return "Le rapport dépasse 2 Mio. Retirez des projets, puis relancez DUBSAR Workbench." }
    default { return "DUBSAR Workbench n'a pas pu être ouvert. Utilisez Ouvrir-DUBSAR-Workbench.cmd pour afficher le diagnostic." }
  }
}

function Assert-DubsarRegularFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$TrustedRoot
  )

  $full = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetFullPath($TrustedRoot).TrimEnd('\')
  if (-not ($full.StartsWith("$root\", [System.StringComparison]::OrdinalIgnoreCase))) {
    throw [System.InvalidOperationException]::new("UNTRUSTED_EXECUTABLE_PATH")
  }
  $current = $full
  while ($true) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw [System.InvalidOperationException]::new("UNTRUSTED_EXECUTABLE_PATH")
    }
    if ($current.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) { break }
    $parent = [System.IO.Directory]::GetParent($current)
    if ($null -eq $parent) {
      throw [System.InvalidOperationException]::new("UNTRUSTED_EXECUTABLE_PATH")
    }
    $current = $parent.FullName.TrimEnd('\')
  }
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
    throw [System.InvalidOperationException]::new("UNTRUSTED_EXECUTABLE_PATH")
  }
  return $full
}

try {
  $workbenchRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")).Path
  $programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
  $nodeCandidate = Join-Path $programFiles "nodejs\node.exe"
  $entryCandidate = Join-Path $workbenchRoot "packages\dubsar-workbench-launcher\bin\dubsar-workbench-open.mjs"
  if (-not (Test-Path -LiteralPath $nodeCandidate -PathType Leaf)) {
    throw [System.InvalidOperationException]::new("NODE_NOT_FOUND")
  }
  if (-not (Test-Path -LiteralPath $entryCandidate -PathType Leaf)) {
    throw [System.InvalidOperationException]::new("WORKBENCH_ENTRY_NOT_FOUND")
  }
  $nodePath = Assert-DubsarRegularFile -Path $nodeCandidate -TrustedRoot $programFiles
  $entryPath = Assert-DubsarRegularFile -Path $entryCandidate -TrustedRoot $workbenchRoot

  $versionText = (& $nodePath --version 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $versionText.StartsWith("v")) {
    throw [System.InvalidOperationException]::new("NODE_NOT_FOUND")
  }
  $major = [int]($versionText.Substring(1).Split(".")[0])
  if ($major -lt 20) {
    throw [System.InvalidOperationException]::new("NODE_VERSION_UNSUPPORTED")
  }

  $output = @(& $nodePath $entryPath --reviews 2>&1 | ForEach-Object { $_.ToString() })
  $childExitCode = $LASTEXITCODE
  if ($childExitCode -eq 0) {
    exit 0
  }

  $combined = $output -join "`n"
  $code = if ($combined -match '"code":"([A-Z0-9_]+)"') { $Matches[1] } else { "WORKBENCH_OPEN_FAILED" }
  if ($code -eq "PROJECT_SELECTION_CANCELLED") {
    exit 0
  }
  Show-DubsarError -Message (Get-DubsarMessage -Code $code)
  exit 1
} catch {
  $code = if ($_.Exception.Message -match '^[A-Z0-9_]+$') { $_.Exception.Message } else { "WORKBENCH_OPEN_FAILED" }
  Show-DubsarError -Message (Get-DubsarMessage -Code $code)
  exit 1
}
