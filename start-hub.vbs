Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

driveDir = "c:\Users\msafdari\My Drive\AI-Studio-Hub"
localAppDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\AIStudioHub\app"
localPublicDir = localAppDir & "\public"

On Error Resume Next
If Not fso.FolderExists(localAppDir) Then fso.CreateFolder(localAppDir)
If Not fso.FolderExists(localPublicDir) Then fso.CreateFolder(localPublicDir)

If fso.FileExists(driveDir & "\server.js") Then
  fso.CopyFile driveDir & "\server.js", localAppDir & "\server.js", True
End If
If fso.FileExists(driveDir & "\public\index.html") Then
  fso.CopyFile driveDir & "\public\index.html", localPublicDir & "\index.html", True
End If

targetServer = driveDir & "\server.js"
targetDir = driveDir
If Not fso.FileExists(targetServer) Then
  targetServer = localAppDir & "\server.js"
  targetDir = localAppDir
End If

psCmd = "powershell -NoProfile -WindowStyle Hidden -Command ""if (-not (Get-NetTCPConnection -LocalPort 4747 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -FilePath 'node' -ArgumentList '\""" & targetServer & "\""' -WorkingDirectory '" & targetDir & "' -WindowStyle Hidden }"""
sh.Run psCmd, 0, False
