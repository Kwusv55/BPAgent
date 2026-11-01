' BPAgent launcher: starts the tray host (BPAgent.ps1) without any console window.
' Arguments are passed through, e.g. BPAgent.vbs -Quit
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For Each a In WScript.Arguments
  args = args & " " & a
Next
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\BPAgent.ps1""" & args, 0, False
