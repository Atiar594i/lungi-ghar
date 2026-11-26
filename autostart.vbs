Set WshShell = CreateObject("WScript.Shell")
strDir = "c:\Users\mdkha\Desktop\E-commerce website"
WshShell.CurrentDirectory = strDir

' Check if server is already listening on port 3000
Set objExec = WshShell.Exec("cmd /c netstat -ano | findstr :3000")
strOut = objExec.StdOut.ReadAll()

If InStr(strOut, "LISTENING") = 0 Then
    WshShell.Run "node server.js", 0, False
End If

' Check if cloudflared is already running
Set objExec2 = WshShell.Exec("cmd /c tasklist /FI ""IMAGENAME eq cloudflared.exe""")
strOut2 = objExec2.StdOut.ReadAll()

If InStr(strOut2, "cloudflared.exe") = 0 Then
    WshShell.Run "node start_tunnel.js", 0, False
End If
