# Baixa os dados abertos de CNPJ da Receita (compartilhamento oficial SERPRO/Nextcloud), retomando
# arquivos parciais. Não baixa Socios*.zip (dados pessoais). Pode rodar desacoplado do terminal:
#   Start-Process powershell -WindowStyle Hidden -ArgumentList '-File','scripts\download-cnpj.ps1','-Ref','2026-10','-Dest','D:\...\dados-cnpj\2026-10'
param(
  [string]$Ref = "2026-10",
  [string]$Dest = "D:\FD_CONSULTORIA\DESENVOLVIMENTO\dados-cnpj\2026-10",
  [string]$Share = "YggdBLfdninEJX9"
)
New-Item -ItemType Directory -Force $Dest | Out-Null
$log = Join-Path $Dest "download.log"
$files = @("Cnaes", "Municipios") + (0..9 | ForEach-Object { "Empresas$_" }) + (0..9 | ForEach-Object { "Estabelecimentos$_" })
foreach ($f in $files) {
  $out = Join-Path $Dest "$f.zip"
  "$(Get-Date -Format 'HH:mm:ss') baixando $f.zip" | Out-File -Append -Encoding utf8 $log
  & curl.exe -s -S --retry 10 --retry-delay 15 -C - -u "${Share}:" -o $out "https://arquivos.receitafederal.gov.br/public.php/webdav/$Ref/$f.zip" 2>> $log
  "    $((Get-Item $out).Length) bytes" | Out-File -Append -Encoding utf8 $log
}
"$(Get-Date -Format 'HH:mm:ss') CONCLUIDO" | Out-File -Append -Encoding utf8 $log
