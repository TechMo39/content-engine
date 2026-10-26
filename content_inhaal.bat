@echo off
REM content_inhaal.bat
REM Vangnet om 08:00 (vóór de eerste post om 10:00): draait de dag-render alleen als die vandaag
REM nog niet liep. Vergelijkt de datum van het marker-logbestand met vandaag, net als de
REM UncleRank-allocator-inhaal. GEEN hibernate: overdag mag hij de laptop niet wegdrukken.

cd /d "C:\Users\Nimo1\Desktop\content-engine"
if not exist "out\logs" mkdir "out\logs"

for /f %%D in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')"') do set VANDAAG=%%D
set LOGDAG=geen
if exist "out\logs\render_dag.txt" for /f %%L in ('powershell -NoProfile -Command "(Get-Item 'out\logs\render_dag.txt').LastWriteTime.ToString('yyyy-MM-dd')"') do set LOGDAG=%%L

echo Vandaag: %VANDAAG%  Laatste render: %LOGDAG% >> "out\logs\render_dag_log.txt"
if "%VANDAAG%"=="%LOGDAG%" (
  echo Dag-render vandaag al gelopen, niets te doen. >> "out\logs\render_dag_log.txt"
) else (
  echo ===== INHAAL %VANDAAG% ===== >> "out\logs\render_dag_log.txt"
  node tools\render_dag.mjs --doen >> "out\logs\render_dag_log.txt" 2>&1
)
