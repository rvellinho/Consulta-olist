@echo off
cd /d "%~dp0"
set NODE_OPTIONS=--dns-result-order=ipv4first
echo Iniciando servidor local da Rampa...
start "Rampa - Servidor Local (nao feche)" cmd /k "npx vercel dev"
echo Aguardando o servidor ficar pronto...
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 60;$i++){try{(New-Object Net.Sockets.TcpClient).Connect('localhost',3000); $ok=$true; break}catch{Start-Sleep -Seconds 1}}; if(-not $ok){Write-Host 'O servidor demorou demais para iniciar. Confira a outra janela que abriu.'}"
start "" "http://localhost:3000"
