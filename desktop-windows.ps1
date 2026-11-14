param([Parameter(Mandatory=$true)][string]$CredentialDirectory)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'desktop-windows.cs') -ReferencedAssemblies System.Windows.Forms, System.Drawing
[HandsDesktop]::Initialize($CredentialDirectory)
while ($null -ne ($line = [Console]::ReadLine())) {
    $msg = $null
    try {
        $msg = $line | ConvertFrom-Json
        $a = $msg.args
        [HandsDesktop]::CheckDesktop()
        $result = switch ($msg.name) {
            'desktop_displays' { [HandsDesktop]::Displays() }
            'desktop_windows' { ,([HandsDesktop]::Windows()) }
            'desktop_focus' { [HandsDesktop]::Focus($a.window_id) }
            'desktop_screenshot' {
                $target = if ($a.target) { $a.target } else { 'desktop' }
                $max = if ($a.max_dimension) { $a.max_dimension } else { 1600 }
                [HandsDesktop]::Screenshot($target, $a.window_id, [int]$a.monitor, [int]$a.x, [int]$a.y, [int]$a.width, [int]$a.height, $max)
            }
            'desktop_mouse' {
                $button = if ($a.button) { $a.button } else { 'left' }
                $duration = if ($a.duration_ms) { $a.duration_ms } else { 300 }
                [HandsDesktop]::Mouse($a.window_id, $a.action, $a.x, $a.y, $button, $a.to_x, $a.to_y, $duration, $a.delta, $a.axis)
            }
            'desktop_type' { [HandsDesktop]::TypeText($a.window_id, $a.text) }
            'desktop_key' { [HandsDesktop]::Key($a.window_id, [string[]]$a.keys) }
            default { throw 'Unknown desktop operation' }
        }
        @{ id = $msg.id; result = $result } | ConvertTo-Json -Compress -Depth 12 | ForEach-Object { [Console]::WriteLine($_) }
    } catch {
        @{ id = $msg.id; error = $_.Exception.GetBaseException().Message } | ConvertTo-Json -Compress | ForEach-Object { [Console]::WriteLine($_) }
    }
}
