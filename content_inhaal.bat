@echo off
REM content_inhaal.bat - Vangnet (Taakplanner 08:00, StartWhenAvailable, stil via stil.vbs).
REM Node checkt zelf of er vandaag al geslaagd gerenderd is (--inhaal) en rendert alleen als dat
REM niet zo is. Geen check-logica in de bat (dat doet node). Alles naar out\logs\render_log.txt.
REM GEEN hibernate (draait overdag).
cd /d "C:\Users\Nimo1\Desktop\content-engine"
if not exist "out\logs" mkdir "out\logs"
echo ===== INHAAL-CHECK %DATE% %TIME% =====>> "out\logs\render_log.txt"
node tools\render_dag.mjs --doen --inhaal >> "out\logs\render_log.txt" 2>&1
